import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, recordFeedbackForUser, getFeedbackSnapshotForUser, getProfileForUser, saveProfileForUser, FeedbackBookNotFoundError, FeedbackConflictError } from '@/lib/db';
import { chatRobust, configuredTotalTimeoutMs, validateProfileContent } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import { profileUpdateSystem, profileUpdateUser } from '@/lib/prompts';
import type { FeedbackStatus, ShelfStatus } from '@/lib/types';
import { boundedString, readJsonBody } from '@/lib/http';
import { withFindAccess } from '@/lib/personal-request';
import { DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS } from '@/lib/deadline';
import { feedbackNeedsConfirmation } from '@/lib/feedback';

export const maxDuration = 295;

const MAX_BODY_BYTES = 8 * 1024;
// 反馈回写画像的模型子预算：在内部预算里预留写回。
// 可用额 = 285s 内部预算 − 12s 写回 reserve = 273s；ceiling 取 260s 留 13s 余量。
// 上游是推理模型，思考链会把单步拉到 190s 上下，旧的 220s 会稳定截断。
const MODEL_CEILING_MS = 260_000;

const VALID: FeedbackStatus[] = ['want', 'reading', 'done', 'dropped'];

export async function POST(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const { title, author, status } = body ?? {};
    const cleanTitle = boundedString(title, 200) ?? '';
    const cleanAuthor = boundedString(author, 200) || '佚名';
    const cleanNote = boundedString(body?.note ?? '', 1_000);
    if (!cleanTitle || cleanNote === null ||
        typeof status !== 'string' || !VALID.includes(status as FeedbackStatus)) {
      return NextResponse.json({ error: 'missing title, invalid status, or note too long' }, { status: 400 });
    }
    // Missing version means a create-only expectation, never an unconditional overwrite.
    const expectedVersion = body?.expectedFeedbackId === undefined ? 0 : body.expectedFeedbackId;
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
      return NextResponse.json({ error: '无效的反馈版本', code: 'FEEDBACK_VERSION_REQUIRED' }, { status: 400 });
    }
    const shelfStatus = status as ShelfStatus;
    const { userId } = access.principal;
    await access.run(ensureSchema);
    const current = await access.run(() => getFeedbackSnapshotForUser(userId, cleanTitle, cleanAuthor));
    if (current.version !== expectedVersion) {
      return NextResponse.json({ error: '反馈已在其他页面更新，你的草稿已保留，请比较后再保存。', code: 'FEEDBACK_CONFLICT', current }, { status: 409 });
    }
    // Omitting note expresses a status-only change; it never clears the latest note.
    const safeNote = body && Object.hasOwn(body, 'note') ? cleanNote : current.note;
    if (feedbackNeedsConfirmation(current.note, safeNote) && body?.confirmNoteReduction !== true) {
      return NextResponse.json({ error: '反馈原因将减少，请确认后保存。', code: 'FEEDBACK_CONFIRM_REQUIRED', current }, { status: 409 });
    }
    try {
      await access.commit((write) => recordFeedbackForUser(userId,
        { title: cleanTitle, author: cleanAuthor }, shelfStatus, safeNote, expectedVersion, write));
    } catch (e) {
      if (e instanceof FeedbackConflictError) {
        const latest = await access.run(() => getFeedbackSnapshotForUser(userId, cleanTitle, cleanAuthor)).catch(() => null);
        return NextResponse.json({ error: '反馈保存期间有新改动，草稿已保留，请比较后再保存。', code: 'FEEDBACK_CONFLICT', current: latest }, { status: 409 });
      }
      if (e instanceof FeedbackBookNotFoundError) {
        return NextResponse.json({ error: '这本书不在书库中，未能保存反馈。', code: 'BOOK_NOT_FOUND' }, { status: 404 });
      }
      throw e;
    }

    // 有信息量的反馈 → 回写画像（失败不阻断；预算耗尽同样不阻断反馈保存）
    let profileUpdated = false;
    let updatedAt: string | null = null;
    if ((shelfStatus === 'done' || shelfStatus === 'dropped') && safeNote && !access.deadline.expired) {
      let stage = 'read-profile';
      try {
        const profile = await access.run(() => getProfileForUser(userId));
        if (profile.content) {
          const budgetMs = Math.min(access.deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
          if (budgetMs <= 0) throw new DeadlineExceededError(MODEL_ROUTE_INTERNAL_BUDGET_MS);
          stage = 'model';
          const { content: updated } = await access.run(() => chatRobust(
            profileUpdateSystem(), profileUpdateUser(profile.content, JSON.stringify({
              title: cleanTitle, author: cleanAuthor, status: shelfStatus, note: safeNote,
            })),
            { temperature: 0.3, signal: access.signal, onUsage: recordUsageAfterResponse('feedback'), totalTimeoutMs: budgetMs },
          ));
          stage = 'validate';
          const content = validateProfileContent(updated);
          stage = 'save';
          updatedAt = await access.commit((write) => saveProfileForUser(userId, profile.seeds, content, profile.updatedAt, write));
          // 种子原样回传，所以"内容变了"就是这次回写真的改动了画像；
          // CAS 命中只说明没有并发写入，不等于画像变了（模型可能原样返回）。
          profileUpdated = updatedAt !== null && content !== profile.content;
        }
      } catch (error) {
        // 已保存的反馈保留；授权改变、冲突、模型或预算错误都不再写画像。
        // 不静默：否则"回写失败"与"模型判定无需修改"在用户侧完全无法区分。
        // 只记阶段与错误类别，不落模型/数据库原文。
        console.error('反馈回写画像失败，反馈本身已保存', {
          stage,
          name: error instanceof Error ? error.name : typeof error,
          code: (error as { code?: unknown } | null)?.code ?? null,
        });
      }
    }
    return NextResponse.json({ ok: true, profileUpdated, ...(updatedAt ? { updatedAt } : {}) });
  });
}

export async function GET(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    await access.run(ensureSchema);
    if (req.nextUrl.searchParams.has('title')) {
      const title = boundedString(req.nextUrl.searchParams.get('title'), 200) ?? '';
      const author = boundedString(req.nextUrl.searchParams.get('author') ?? '', 200) || '佚名';
      if (!title) return NextResponse.json({ error: '无效的书名或作者' }, { status: 400 });
      const current = await access.run(() => getFeedbackSnapshotForUser(access.principal.userId, title, author));
      return NextResponse.json({ current }, {
        headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization, X-Owner-Token' },
      });
    }
    const sql = getSql();
    const rows = await access.run(async () => sql`
      SELECT f.id, f.status, f.note, f.created_at, b.title, b.author
      FROM feedback f JOIN books b ON b.id = f.book_id
      WHERE f.user_id = ${access.principal.userId}
      ORDER BY f.id DESC LIMIT 200`);
    return NextResponse.json({ feedback: rows });
  });
}
