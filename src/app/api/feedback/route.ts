import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, upsertBook, getProfile, saveProfile } from '@/lib/db';
import { chatRobust, configuredTotalTimeoutMs, LlmError, validateProfileContent } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import { profileUpdateSystem, profileUpdateUser } from '@/lib/prompts';
import type { FeedbackStatus } from '@/lib/types';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import { requireApiOwner } from '@/lib/auth';
import { createDeadline, DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS, raceDeadline } from '@/lib/deadline';
import { feedbackNeedsConfirmation } from '@/lib/feedback';
import { appendFeedback, FeedbackConflictError, getFeedbackSnapshot } from '@/lib/feedback-store';
import { hasInvalidDatabaseCharacters } from '@/lib/sanitize';

export const maxDuration = 295;

const MAX_BODY_BYTES = 8 * 1024;
// 反馈回写画像的模型子预算：在内部预算里预留写回
const MODEL_CEILING_MS = 220_000;

const VALID: FeedbackStatus[] = ['want', 'reading', 'done', 'dropped'];

export async function POST(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const { title, author, status, note } = body ?? {};
  const cleanTitle = boundedString(title, 200) ?? '';
  const cleanAuthor = boundedString(author, 200) || '佚名';
  const cleanNote = boundedString(note ?? '', 1_000);
  if (!cleanTitle || cleanNote === null || (author !== undefined && author !== null && boundedString(author, 200) === null) ||
      [cleanTitle, cleanAuthor, cleanNote].some(hasInvalidDatabaseCharacters) ||
      typeof status !== 'string' || !VALID.includes(status as FeedbackStatus)) {
    return NextResponse.json({ error: 'missing title, invalid status, or note too long' }, { status: 400 });
  }
  // Missing version means a create-only expectation, never an unconditional overwrite.
  const expectedVersion = body?.expectedFeedbackId === undefined ? 0 : body.expectedFeedbackId;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
    return NextResponse.json({ error: '无效的反馈版本', code: 'FEEDBACK_VERSION_REQUIRED' }, { status: 400 });
  }
  const shelfStatus = status as FeedbackStatus;
  const deadline = createDeadline(MODEL_ROUTE_INTERNAL_BUDGET_MS);
  const atomicRead = <T>(task: () => Promise<T>): Promise<T> =>
    raceDeadline(deadline.signal, task);
  try {
    await atomicRead(ensureSchema);
    const current = await atomicRead(() => getFeedbackSnapshot(cleanTitle, cleanAuthor));
    if (current.version !== expectedVersion) {
      return NextResponse.json({ error: '反馈已在其他页面更新，你的草稿已保留，请比较后再保存。', code: 'FEEDBACK_CONFLICT', current }, { status: 409 });
    }
    // Omitting note expresses a status-only change; it never clears the latest note.
    const safeNote = body && Object.hasOwn(body, 'note') ? cleanNote : current.note;
    if (feedbackNeedsConfirmation(current.note, safeNote) && body?.confirmNoteReduction !== true) {
      return NextResponse.json({ error: '反馈原因将减少，请确认后保存。', code: 'FEEDBACK_CONFIRM_REQUIRED', current }, { status: 409 });
    }
    const bookId = await upsertBook({
      title: cleanTitle,
      author: cleanAuthor,
      meta: {},
    });
    deadline.assert();
    await appendFeedback(bookId, shelfStatus, safeNote, expectedVersion as number, AbortSignal.any([req.signal, deadline.signal]));

    // 有信息量的反馈 → 回写画像（失败不阻断；预算耗尽同样不阻断反馈保存）
    let profileUpdated = false;
    let updatedAt: string | null = null;
    if ((shelfStatus === 'done' || shelfStatus === 'dropped') && safeNote && !deadline.expired) {
      try {
        const profile = await atomicRead(getProfile);
        if (profile.content) {
          const budgetMs = Math.min(deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
          if (budgetMs <= 0) throw new DeadlineExceededError(MODEL_ROUTE_INTERNAL_BUDGET_MS);
          const { content: updated } = await chatRobust(
            profileUpdateSystem(),
            profileUpdateUser(profile.content, JSON.stringify({
              title: cleanTitle,
              author: cleanAuthor,
              status: shelfStatus,
              note: safeNote,
            })),
            { temperature: 0.3, signal: req.signal, onUsage: recordUsageAfterResponse('feedback'), totalTimeoutMs: budgetMs },
          );
          if (req.signal.aborted) throw new LlmError('模型调用已取消。', false);
          const content = validateProfileContent(updated);
          deadline.assert();
          updatedAt = await saveProfile(profile.seeds, content, profile.updatedAt);
          profileUpdated = updatedAt !== null;
        }
      } catch (e) {
        if (!(e instanceof DeadlineExceededError)) console.error('profile update failed:', e);
      }
    }
    return NextResponse.json({ ok: true, profileUpdated, ...(updatedAt ? { updatedAt } : {}) });
  } catch (e) {
    if (e instanceof FeedbackConflictError) {
      const current = await getFeedbackSnapshot(cleanTitle, cleanAuthor).catch(() => null);
      return NextResponse.json({ error: '反馈保存期间有新改动，草稿已保留，请比较后再保存。', code: 'FEEDBACK_CONFLICT', current }, { status: 409 });
    }
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  } finally {
    deadline.dispose();
  }
}

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  try {
    await ensureSchema();
    if (req.nextUrl.searchParams.has('title')) {
      const title = boundedString(req.nextUrl.searchParams.get('title'), 200) ?? '';
      const author = boundedString(req.nextUrl.searchParams.get('author') ?? '', 200) || '佚名';
      if (!title || [title, author].some(hasInvalidDatabaseCharacters)) return NextResponse.json({ error: '无效的书名或作者' }, { status: 400 });
      return NextResponse.json({ current: await getFeedbackSnapshot(title, author) }, {
        headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization, X-Owner-Token' },
      });
    }
    const sql = getSql();
    const rows = await sql`
      SELECT f.id, f.status, f.note, f.created_at, b.title, b.author
      FROM feedback f JOIN books b ON b.id = f.book_id
      WHERE f.user_id = 1 ORDER BY f.id DESC LIMIT 200`;
    return NextResponse.json({ feedback: rows });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}
