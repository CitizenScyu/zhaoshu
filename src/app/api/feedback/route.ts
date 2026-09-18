import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, recordFeedbackForUser, getFeedbackSnapshotForUser, FeedbackBookNotFoundError, FeedbackConflictError } from '@/lib/db';
import type { FeedbackStatus, ShelfStatus } from '@/lib/types';
import { boundedString, readJsonBody } from '@/lib/http';
import { withFindAccess } from '@/lib/personal-request';
import { MODEL_ROUTE_INTERNAL_BUDGET_MS } from '@/lib/deadline';
import { feedbackNeedsConfirmation, feedbackQueuesProfileAbsorption } from '@/lib/feedback';

export const maxDuration = 295;

const MAX_BODY_BYTES = 8 * 1024;

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
    // 写路径只做两件事：快速持久化反馈 + 在同一事务登记「该用户有待吸收反馈」（F15）。
    // 模型吸收不在这个请求里同步执行——用户不为数分钟的模型调用等待；吸收由
    // /api/profile/absorb（显式/机会触发）按用户合并执行，失败保留 pending 可重放。
    // 既有 CAS 语义、409/404/确认口径全部不变；queued=false 时不登记事件，响应如实报 unchanged。
    const queued = feedbackQueuesProfileAbsorption(shelfStatus, safeNote, current.status, current.note);
    try {
      await access.commit((write) => recordFeedbackForUser(userId,
        { title: cleanTitle, author: cleanAuthor }, shelfStatus, safeNote, expectedVersion, write, queued));
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

    // profileUpdated 语义不变（本次响应是否真的改写了画像）；吸收已异步化，故恒为 false。
    // profileStatus/pending/retryable 是新增的可观测字段：
    //   pending    反馈已保存、画像待更新（可调用 /api/profile/absorb 重放）
    //   unchanged  这次反馈对画像没有信息量，无需更新
    return NextResponse.json({
      ok: true,
      profileUpdated: false,
      profileStatus: queued ? 'pending' : 'unchanged',
      pending: queued,
      retryable: queued,
    });
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
