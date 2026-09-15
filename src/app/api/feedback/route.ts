import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, upsertBook, getProfile, saveProfile } from '@/lib/db';
import { chatRobust, configuredTotalTimeoutMs, LlmError, validateProfileContent } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import { profileUpdateSystem, profileUpdateUser } from '@/lib/prompts';
import type { ShelfStatus } from '@/lib/types';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import { requireApiOwner } from '@/lib/auth';
import { createDeadline, DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS, raceDeadline } from '@/lib/deadline';

export const maxDuration = 295;

const MAX_BODY_BYTES = 8 * 1024;
// 反馈回写画像的模型子预算：在内部预算里预留写回
const MODEL_CEILING_MS = 220_000;

const VALID: ShelfStatus[] = ['want', 'reading', 'done', 'dropped'];

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
  if (!cleanTitle || cleanNote === null ||
      typeof status !== 'string' || !VALID.includes(status as ShelfStatus)) {
    return NextResponse.json({ error: 'missing title, invalid status, or note too long' }, { status: 400 });
  }
  const safeNote = cleanNote;
  const shelfStatus = status as ShelfStatus;
  const deadline = createDeadline(MODEL_ROUTE_INTERNAL_BUDGET_MS);
  const atomicRead = <T>(task: () => Promise<T>): Promise<T> =>
    raceDeadline(deadline.signal, task);
  try {
    await atomicRead(ensureSchema);
    const sql = getSql();
    const bookId = await upsertBook({
      title: cleanTitle,
      author: cleanAuthor,
      meta: {},
    });
    await sql.transaction([
      sql`INSERT INTO feedback (book_id, status, note)
          VALUES (${bookId}, ${shelfStatus}, ${safeNote})`,
      sql`UPDATE recommendations SET status = ${shelfStatus} WHERE book_id = ${bookId}`,
    ]);

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
    const sql = getSql();
    const rows = await sql`
      SELECT f.id, f.status, f.note, f.created_at, b.title, b.author
      FROM feedback f JOIN books b ON b.id = f.book_id
      ORDER BY f.created_at DESC LIMIT 200`;
    return NextResponse.json({ feedback: rows });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}
