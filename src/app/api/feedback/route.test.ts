import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { composeFeedbackNote, MAX_FEEDBACK_NOTE_LENGTH } from '@/lib/feedback';

// F15：反馈写路径只做「快速持久化 + 登记待吸收事件」。模型吸收已从本路由移出
// （见 /api/profile/absorb 与 src/lib/profile-absorption.ts），所以这里断言的核心是：
//   ① 反馈照常落库、既有 409/404/400 口径不变；
//   ② 响应在既有 { ok, profileUpdated } 之上扩展出 profileStatus/pending/retryable，
//      "已排队待更新"与"无需修改"可区分；
//   ③ 写路径绝不触发模型调用（用户不为数分钟模型调用同步等待）。
const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  getFeedbackSnapshotForUser: vi.fn(),
  chatRobust: vi.fn(),
  writeResults: [] as unknown[],
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'), values,
  })),
  transaction: vi.fn(),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/db')>(),
  recordFeedbackForUser: async (
    userId: number, book: { title: string; author: string }, status: string, note: string,
    expectedVersion: number, _write: unknown, queued: boolean,
  ) => {
    const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    await actual.recordFeedbackForUser(userId, book, status, note, expectedVersion, async (batch) => {
      await mocks.transaction(batch(mocks.sql as never));
      return mocks.writeResults as Record<string, unknown>[][];
    }, queued);
  },
  ensureSchema: mocks.ensureSchema,
  getSql: mocks.getSql,
  getFeedbackSnapshotForUser: mocks.getFeedbackSnapshotForUser,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: mocks.chatRobust,
}));

import { POST, GET } from './route';

function request(status: string, note: string, extra: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/feedback', {
    method: 'POST',
    headers: { Authorization: 'Bearer feedback-test-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '测试书', author: '作者', status, note, ...extra }),
  });
}

// 与 db.ts 的批次形状一致：索引 0 route B 补 books、索引 4 是 feedback INSERT、
// 索引 6（最后）是 F15 的待吸收事件登记。
function batchResults(insert: unknown[]) {
  return [[], [{ id: 1 }], [{ id: 1 }], [{ feedback_version_matches: 1 }], insert, [], []];
}

describe('POST /api/feedback write-path contract (F15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'feedback-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getSql.mockReturnValue(Object.assign(mocks.sql, { transaction: mocks.transaction }));
    mocks.transaction.mockResolvedValue([]);
    mocks.writeResults = batchResults([{ id: 7 }]);
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 0, status: null, note: '' });
    mocks.chatRobust.mockResolvedValue('不该被调用');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('queues an informative feedback for later absorption instead of calling the model inline', async () => {
    const note = composeFeedbackNote({ reasons: ['节奏慢', '感情线问题'], text: '后期剧情重复' });

    const res = await POST(request('dropped', note));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, profileUpdated: false, profileStatus: 'pending', pending: true, retryable: true,
    });
    const insert = mocks.sql.mock.results.find((result) => result.value.text.includes('INSERT INTO feedback'));
    expect(insert?.value.values).toEqual([1, 'dropped', note, '测试书', '作者']);
    // 写路径绝不调用模型：吸收是独立的长模型调用（/api/profile/absorb）。
    expect(mocks.chatRobust).not.toHaveBeenCalled();
    // 同一事务里登记了待吸收事件，且 queued=true。
    const enqueue = mocks.sql.mock.results.find((result) => result.value.text.includes('INSERT INTO profile_feedback_queue'));
    expect(enqueue).toBeTruthy();
    expect(enqueue?.value.values).toContain(true);
  });

  it('reports unchanged (not pending) when the feedback carries no profile signal', async () => {
    const res = await POST(request('reading', ''));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, profileUpdated: false, profileStatus: 'unchanged', pending: false, retryable: false,
    });
    const enqueue = mocks.sql.mock.results.find((result) => result.value.text.includes('INSERT INTO profile_feedback_queue'));
    expect(enqueue?.value.values).toContain(false);
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  it('queues absorption when an earlier informative feedback is withdrawn', async () => {
    // 之前是 done + 原因，现在改成 reading + 空原因 = 撤回，必须吸收以移除旧偏好。
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 4, status: 'done', note: '讨厌机械降神' });

    const res = await POST(request('reading', '', { expectedFeedbackId: 4, confirmNoteReduction: true }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profileStatus: 'pending', pending: true });
    const enqueue = mocks.sql.mock.results.find((result) => result.value.text.includes('INSERT INTO profile_feedback_queue'));
    expect(enqueue?.value.values).toContain(true);
  });

  it('fails explicitly with BOOK_NOT_FOUND instead of reporting a save that wrote nothing', async () => {
    mocks.writeResults = batchResults([]);

    const res = await POST(request('dropped', '题材不合'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '这本书不在书库中，未能保存反馈。', code: 'BOOK_NOT_FOUND' });
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  it('still returns the queued state when the INSERT really appended a row', async () => {
    mocks.writeResults = batchResults([{ id: 9 }]);

    const res = await POST(request('dropped', '题材不合'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, profileUpdated: false, profileStatus: 'pending', pending: true, retryable: true,
    });
  });

  it('keeps 409 FEEDBACK_CONFLICT and never writes when the expected version is stale', async () => {
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 4, status: 'want', note: '旧原因' });

    const res = await POST(request('dropped', '新原因', { expectedFeedbackId: 3 }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'FEEDBACK_CONFLICT', current: { version: 4 } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('still requires confirmation to shorten a note', async () => {
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 4, status: 'done', note: '很长很长的原因' });

    const res = await POST(request('done', '', { expectedFeedbackId: 4 }));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FEEDBACK_CONFIRM_REQUIRED');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed input before writing', async () => {
    expect((await POST(request('bad', '原因'))).status).toBe(400);
    expect((await POST(request('done', '字'.repeat(MAX_FEEDBACK_NOTE_LENGTH + 1)))).status).toBe(400);
    expect((await POST(request('done', '原因', { expectedFeedbackId: -1 }))).status).toBe(400);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('exposes a private read endpoint for FindTab to start from the latest note', async () => {
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 4, status: 'want', note: '已经保存的长反馈' });
    const res = await GET(new NextRequest('http://localhost/api/feedback?title=书&author=作者', {
      headers: { Authorization: 'Bearer feedback-test-owner' },
    }));
    expect(await res.json()).toMatchObject({ current: { version: 4, note: '已经保存的长反馈' } });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });
});
