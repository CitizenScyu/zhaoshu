import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Query = { text: string; values: unknown[] };

// 只伪造 Neon 传输层：路由→db.ts→user-data.ts 的调用链、批次语句顺序、绑定参数
// 与 22012→FeedbackConflictError 的转译都跑真实实现。版本守卫本身（SQL 里的
// 1/CASE WHEN 除零）**不在这里执行**——mock 只按内存里的 current.id 与守卫的
// 最后一个绑定参数比较后手抛 22012；除零/CASE 语义由 scripts/check-feedback-cas.mjs
// 在 PGlite（内存 PostgreSQL）上验收。
const mocks = vi.hoisted(() => ({
  neon: vi.fn(), ensureSchema: vi.fn(), getProfileForUser: vi.fn(), saveProfileForUser: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/db')>(),
  ensureSchema: mocks.ensureSchema, getProfileForUser: mocks.getProfileForUser,
  saveProfileForUser: mocks.saveProfileForUser,
}));

let current: { id: number; note: string; status: string } | null;
let queries: Query[];
let batch: Query[];
let competingWrite: boolean;
let sql: ((parts: TemplateStringsArray, ...values: unknown[]) => unknown) & { transaction: unknown };

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/feedback', { method: 'POST',
    headers: { Authorization: 'Bearer feedback-cas-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '书', author: '作者', status: 'reading', ...body }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('APP_OWNER_TOKEN', 'feedback-cas-owner');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@database.invalid/test');
  queries = []; batch = [];
  current = { id: 4, note: '已经保存的长反馈', status: 'want' };
  competingWrite = false;
  mocks.ensureSchema.mockResolvedValue(undefined);
  mocks.getProfileForUser.mockResolvedValue({ seeds: [], content: '', updatedAt: 'v1' });
  // 书源 SQL 的返回值：feedback 快照查询读到最后一条反馈，其余查询返回空集。
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?').replace(/\s+/g, ' ').trim();
    const query: Query = { text, values };
    queries.push(query);
    return { ...query, then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(resolve(current ? [{ ...current }] : [])).then(resolve, reject) };
  };
  sql = Object.assign(tag, { transaction: mocks.transaction });
  mocks.neon.mockReturnValue(sql);
  // 真实事务边界只替换执行本身：按新架构的版本守卫（max(id)）模拟 CAS 与追加式历史。
  mocks.transaction.mockImplementation(async (build: (tx: unknown) => Query[]) => {
    batch = build(sql);
    const guard = batch.find((query) => query.text.includes('feedback_version_matches'))!;
    if (competingWrite) { current = { id: 5, note: '另一个页面的新反馈', status: 'done' }; competingWrite = false; }
    if ((current?.id ?? 0) !== guard.values[guard.values.length - 1]) throw Object.assign(new Error('stale'), { code: '22012' });
    const insert = batch.find((query) => query.text.startsWith('INSERT INTO feedback'))!;
    current = { id: (current?.id ?? 0) + 1, status: insert.values[1] as string, note: insert.values[2] as string };
    return [];
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('feedback snapshot and append-only concurrency guard', () => {
  it('returns the latest feedback id, note, and status as a versioned snapshot', async () => {
    const { getFeedbackSnapshotForUser } = await import('@/lib/db');
    expect(await getFeedbackSnapshotForUser(1, '书', '作者')).toEqual({ version: 4, note: '已经保存的长反馈', status: 'want' });
    const query = queries.find((candidate) => candidate.text.includes('FROM feedback f JOIN books b'))!;
    expect(query.text).toContain('f.user_id = ?');
    expect(query.values).toEqual([1, '书', '作者']);
    expect(query.text).toContain('ORDER BY f.id DESC');
    current = null;
    expect(await getFeedbackSnapshotForUser(1, '书', '作者')).toEqual({ version: 0, note: '', status: null });
  });

  it('locks the book, compares the latest version, appends audit history, and changes status in one transaction', async () => {
    const { POST } = await import('./route');
    expect((await POST(request({ note: '更新后的长反馈说明', expectedFeedbackId: 4 }))).status).toBe(200);
    expect(current).toMatchObject({ id: 5, status: 'reading', note: '更新后的长反馈说明' });
    expect(batch.findIndex((query) => query.text.endsWith('FOR UPDATE')))
      .toBeLessThan(batch.findIndex((query) => query.text.includes('feedback_version_matches')));
    // 反馈历史与书架状态都只作用于可信 userId，且历史只追加不覆盖。
    const status = batch.find((query) => query.text.startsWith('UPDATE recommendations'))!;
    expect(status.text).toContain('WHERE user_id = ? AND book_id IN');
    expect(status.values[1]).toBe(1);
    expect(batch.some((query) => /DELETE|UPDATE feedback/.test(query.text))).toBe(false);
  });

  it('maps a lost comparison to an explicit conflict rather than retrying an overwrite', async () => {
    const { recordFeedbackForUser, FeedbackConflictError } = await import('@/lib/db');
    const write = vi.fn().mockRejectedValue(Object.assign(new Error('stale'), { code: '22012' }));
    await expect(recordFeedbackForUser(1, { title: '书', author: '作者' }, 'reading', '', 3, write))
      .rejects.toBeInstanceOf(FeedbackConflictError);
    expect(write).toHaveBeenCalledOnce();
  });

  it('reports a missing books row instead of silently appending nothing', async () => {
    const { recordFeedbackForUser, FeedbackBookNotFoundError } = await import('@/lib/db');
    // 5 条语句：索引 3 的 INSERT ... RETURNING id 命中 0 行 = books 里没有这本书。
    const write = vi.fn().mockResolvedValue([[], [], [{ feedback_version_matches: 1 }], [], []]);
    await expect(recordFeedbackForUser(1, { title: '不在书库', author: '作者' }, 'done', '原因', 0, write))
      .rejects.toBeInstanceOf(FeedbackBookNotFoundError);
    expect(write).toHaveBeenCalledOnce();
  });

  it('accepts the append when the books row was found and one history row was written', async () => {
    const { recordFeedbackForUser } = await import('@/lib/db');
    const write = vi.fn().mockResolvedValue([[], [], [{ feedback_version_matches: 1 }], [{ id: 7 }], []]);
    await expect(recordFeedbackForUser(1, { title: '书', author: '作者' }, 'done', '原因', 0, write))
      .resolves.toBeUndefined();
  });

  it('refuses to read or build feedback writes without an explicit trusted userId', async () => {
    const { getFeedbackSnapshotForUser } = await import('@/lib/db');
    const { feedbackForUserQueries } = await import('@/lib/user-data');
    await expect(getFeedbackSnapshotForUser(0, '书', '作者')).rejects.toThrow('explicit userId is required');
    // 版本守卫与写入同为该批次的一部分：缺少可信 userId 时批次本身无法构造。
    expect(() => feedbackForUserQueries((() => undefined) as never, Number.NaN, { title: '书', author: '作者' }, 'reading', '', 0))
      .toThrow('explicit userId is required');
  });

  it('rejects an old or absent client version before writing', async () => {
    const { POST } = await import('./route');
    for (const body of [{ expectedFeedbackId: 3, note: '' }, { note: '' }]) {
      const res = await POST(request(body));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'FEEDBACK_CONFLICT', current: { version: 4, note: current!.note } });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('inherits the old note for a status-only update', async () => {
    const { POST } = await import('./route');
    const previousNote = current!.note;
    expect((await POST(request({ expectedFeedbackId: 4 }))).status).toBe(200);
    expect(current).toMatchObject({ note: previousNote, status: 'reading' });
  });

  it('requires confirmation to shorten or clear a note', async () => {
    const { POST } = await import('./route');
    const res = await POST(request({ note: '', expectedFeedbackId: 4 }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FEEDBACK_CONFIRM_REQUIRED');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect((await POST(request({ note: '', expectedFeedbackId: 4, confirmNoteReduction: true }))).status).toBe(200);
    expect(current?.note).toBe('');
  });

  it('returns the new online snapshot when another write wins after the initial read', async () => {
    const { POST } = await import('./route');
    competingWrite = true;
    const res = await POST(request({ note: '我的草稿长反馈', expectedFeedbackId: 4, confirmNoteReduction: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'FEEDBACK_CONFLICT', current: { version: 5, note: '另一个页面的新反馈' } });
    expect(current?.note).toBe('另一个页面的新反馈');
  });

  it('protects first creation (version 0) with the same CAS guard', async () => {
    const { POST } = await import('./route');
    current = null; competingWrite = true;
    const res = await POST(request({ note: '新反馈', expectedFeedbackId: 0 }));
    expect(res.status).toBe(409);
    expect(current).toMatchObject({ note: '另一个页面的新反馈' });
  });

  it.each([-1, '4', 0.5, null, false])('rejects malformed feedback versions: %j', async (expectedFeedbackId) => {
    const { POST } = await import('./route');
    expect((await POST(request({ note: '说明', expectedFeedbackId }))).status).toBe(400);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
  });

  it('exposes a private read endpoint for FindTab to start from the latest note', async () => {
    const { GET } = await import('./route');
    const res = await GET(new NextRequest('http://localhost/api/feedback?title=书&author=作者', { headers: { Authorization: 'Bearer feedback-cas-owner' } }));
    expect(await res.json()).toMatchObject({ current: { version: 4, note: current!.note } });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });
});
