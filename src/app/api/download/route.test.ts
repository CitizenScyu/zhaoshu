import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, sql, triggerDownloadWorkflow } = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  sql: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
  triggerDownloadWorkflow: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
vi.mock('@/lib/github', () => ({ triggerDownloadWorkflow }));

import { DELETE, GET, POST } from './route';

function request(method: 'GET' | 'POST' | 'DELETE', body?: unknown, suffix = '') {
  return new NextRequest(`http://localhost/api/download${suffix}`, {
    method,
    headers: { Authorization: 'Bearer download-test-owner', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function queryText(index: number) {
  return sql.mock.calls[index][0].join('?').replace(/\s+/g, ' ').trim();
}

// 离线锁定数据库查询的保护条件；不在 mock 中重写 PostgreSQL 的时间/状态判断。
function expectSafeReclaim(index: number) {
  const query = queryText(index);
  expect(query).toMatch(/^UPDATE download_tasks SET status = 'failed',/);
  expect(query).toContain("error = CONCAT(COALESCE(error, ''), ?)");
  expect(query).toContain('updated_at = now()');
  expect(query).toMatch(/WHERE status = 'running' AND updated_at < now\(\) - \(\? \* interval '1 millisecond'\)$/);
  expect(sql.mock.calls[index].slice(1)).toEqual(['\nworker 中断自动回收', 30 * 60_000]);
}

const book = { id: 7, title: '测试书', author: '作者', source_url: 'https://book15.net/books/details7.html' };
const recoveredTask = {
  id: 42,
  book_id: book.id,
  title: book.title,
  author: book.author,
  status: 'failed',
  chapters_total: 100,
  chapters_done: 12,
  chars_total: 12000,
  error: '此前的提示\nworker 中断自动回收',
  created_at: '2026-09-14T00:00:00Z',
  updated_at: '2026-09-14T01:00:00Z',
};

describe('/api/download recovery and cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'download-test-owner');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    sql.mockResolvedValue([]);
    triggerDownloadWorkflow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    { method: 'GET' as const, handler: GET, body: undefined },
    { method: 'POST' as const, handler: POST, body: { bookId: book.id } },
    { method: 'DELETE' as const, handler: DELETE, body: { taskId: recoveredTask.id } },
  ])('requires owner authentication before $method accesses tasks', async ({ method, handler, body }) => {
    const req = request(method, body);
    req.headers.delete('Authorization');

    expect((await handler(req)).status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(getSql).not.toHaveBeenCalled();
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it.each(['', '?id=42'])('keeps GET %s read-only and scopes it to the authenticated user', async (suffix) => {
    sql.mockResolvedValueOnce([recoveredTask]);

    const res = await GET(request('GET', undefined, suffix));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(suffix ? data.task : data.tasks[0]).toMatchObject({
      id: recoveredTask.id,
      bookId: book.id,
      status: 'failed',
      error: recoveredTask.error,
      chaptersDone: recoveredTask.chapters_done,
    });
    expect(sql).toHaveBeenCalledOnce();
    expect(queryText(0)).toMatch(/^SELECT .* FROM download_tasks /);
    expect(queryText(0)).toContain('user_id = ?');
    expect(sql.mock.calls[0].slice(1)).toEqual(suffix ? [recoveredTask.id, 1] : [1, 20]);
  });

  it('rejects invalid task IDs before any recovery write', async () => {
    expect((await GET(request('GET', undefined, '?id=0'))).status).toBe(400);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it('F16：GET 保持只读并派生 leaseExpired；活跃心跳不被标记过期', async () => {
    const staleRunning = { ...recoveredTask, status: 'running', updated_at: new Date(Date.now() - 31 * 60_000).toISOString() };
    sql.mockResolvedValueOnce([staleRunning]);
    const res = await GET(request('GET', undefined, `?id=${staleRunning.id}`));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.task).toMatchObject({ status: 'running', leaseExpired: true });
    // 只读：GET 不做回收写，回收由 POST 与 cron 路径承担。
    expect(sql).toHaveBeenCalledOnce();
    expect(queryText(0)).toMatch(/^SELECT /);
    expect(queryText(0)).not.toContain('UPDATE download_tasks');

    const freshRunning = { ...recoveredTask, status: 'running', updated_at: new Date(Date.now() - 60_000).toISOString() };
    sql.mockResolvedValueOnce([freshRunning]);
    const freshRes = await GET(request('GET', undefined, `?id=${freshRunning.id}`));
    expect((await freshRes.json()).task).toMatchObject({ status: 'running', leaseExpired: false });
  });

  it.each(['failed', 'partial', 'done', 'pending'])('F16/F03：%s 状态永不带 leaseExpired', async (status) => {
    sql.mockResolvedValueOnce([{ ...recoveredTask, status }]);
    const res = await GET(request('GET', undefined, `?id=${recoveredTask.id}`));
    expect((await res.json()).task).toMatchObject({ status, leaseExpired: false });
  });

  it('F17：GET ?bookId 返回本人在这本书上的最新任务', async () => {
    sql.mockResolvedValueOnce([{ ...recoveredTask, status: 'partial' }]);
    const res = await GET(request('GET', undefined, '?bookId=7'));
    expect(res.status).toBe(200);
    expect((await res.json()).task).toMatchObject({ id: recoveredTask.id, bookId: 7, status: 'partial' });
    expect(queryText(0)).toContain('book_id = ?');
    expect(queryText(0)).toContain('user_id = ?');
    expect(sql.mock.calls[0].slice(1)).toEqual([7, 1]);
  });

  it('F17：GET ?bookId 无本人任务时返回 null task（不猜测他人任务）', async () => {
    sql.mockResolvedValueOnce([]);
    const res = await GET(request('GET', undefined, '?bookId=7'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task: null });
  });

  it.each(['0', '-1', '1.5', 'Infinity', '1e3'])('F17：拒绝非法 bookId %s', async (bookId) => {
    const res = await GET(request('GET', undefined, `?bookId=${encodeURIComponent(bookId)}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid bookId', code: 'INVALID_ID' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('F18 边界：GET 单条仍强制本人 user_id，他人的完成任务返回 404', async () => {
    // 共享阅读走 library 的 sharedReadTaskId；/api/download 的归属约束不得放宽。
    sql.mockResolvedValueOnce([]);
    const res = await GET(request('GET', undefined, '?id=999'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'task not found', code: 'TASK_NOT_FOUND' });
    expect(queryText(0)).toContain('user_id = ?');
  });

  it('reports recovery errors instead of returning stale task data', async () => {
    sql.mockRejectedValueOnce(new Error('database unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(request('GET'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'db error', code: 'DB_ERROR' });
    expect(sql).toHaveBeenCalledOnce();
  });

  it('recovers before POST deduplication and only lets pending/running block a new task', async () => {
    sql.mockResolvedValueOnce([book])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 43 }]);

    const res = await POST(request('POST', { bookId: book.id }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ taskId: 43 });
    expectSafeReclaim(1);
    // F03：活动锁只看 pending/running——partial（残缺终态）不阻塞重下补齐
    expect(queryText(2)).toMatch(/WHERE user_id = \? AND book_id = \? AND status IN \('pending', 'running'\) ORDER BY created_at DESC LIMIT 1$/);
    expect(queryText(2)).not.toContain('partial');
    expect(queryText(3)).toMatch(/^INSERT INTO download_tasks /);
    expect(sql.mock.calls[3].slice(1)).toEqual([1, book.id, book.title, book.author, book.source_url]);
    expect(triggerDownloadWorkflow).toHaveBeenCalledOnce();
  });

  it('still refuses to enqueue a duplicate active task and returns its taskId and status', async () => {
    sql.mockResolvedValueOnce([book])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 42, status: 'running' }]);

    const res = await POST(request('POST', { bookId: book.id }));

    expect(res.status).toBe(409);
    // F17：冲突响应必须带上同一用户已有任务的 taskId + 状态，前端据此接续轮询。
    expect(await res.json()).toEqual({
      error: '已有进行中的任务',
      code: 'TASK_CONFLICT',
      taskId: 42,
      status: 'running',
    });
    expectSafeReclaim(1);
    expect(sql).toHaveBeenCalledTimes(3);
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it('F17：23505 竞争路径补读本人活动任务，两个并发请求最终指向同一 taskId', async () => {
    sql.mockResolvedValueOnce([book])
      .mockResolvedValueOnce([])   // 回收
      .mockResolvedValueOnce([])   // 竞争前的活动查询：对手尚未提交可见
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' })) // INSERT 撞唯一索引
      .mockResolvedValueOnce([{ id: 55, status: 'pending' }]); // 补读本人活动任务
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(request('POST', { bookId: book.id }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: '已有进行中的任务',
      code: 'TASK_CONFLICT',
      taskId: 55,
      status: 'pending',
    });
    expect(sql).toHaveBeenCalledTimes(5);
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it('F03：同一本书只有 partial（残缺）任务时可重新入队补齐', async () => {
    // 活动锁只匹配 pending/running，已有的 partial 行不在去重结果里，因此建任务成功。
    sql.mockResolvedValueOnce([book])
      .mockResolvedValueOnce([])   // 回收
      .mockResolvedValueOnce([])   // 活动任务查询：partial 不返回
      .mockResolvedValueOnce([{ id: 44 }]);

    const res = await POST(request('POST', { bookId: book.id }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ taskId: 44 });
    expect(queryText(2)).not.toContain('partial');
    expect(triggerDownloadWorkflow).toHaveBeenCalledOnce();
  });

  it.each([
    'http://book15.net/a', 'https://book15.net.evil.invalid/a', 'https://unknown.invalid/a',
    'https://sub.book15.net/a', 'https://user@book15.net/a', 'https://@book15.net/a',
    'https://book15.net:444/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'not a URL',
  ])('拒绝书库中的非法来源 %s，不入队或 dispatch', async (source_url) => {
    sql.mockResolvedValueOnce([{ ...book, source_url }]);
    const res = await POST(request('POST', { bookId: book.id, sourceUrl: book.source_url }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
    expect(sql).toHaveBeenCalledOnce();
    expect(queryText(0)).toContain('FROM labeled_books');
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('保留缺来源的错误契约', async () => {
    sql.mockResolvedValueOnce([{ ...book, source_url: '' }]);
    const res = await POST(request('POST', { bookId: book.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'MISSING_SOURCE_URL' });
    expect(sql).toHaveBeenCalledOnce();
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it('规范化书库 HTTPS 地址入队，忽略客户端自报地址', async () => {
    sql.mockResolvedValueOnce([{ ...book, source_url: 'https://BOOK15.NET:443/books/details7.html#chapters' }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 43 }]);
    expect((await POST(request('POST', { bookId: book.id, sourceUrl: 'https://127.0.0.1/private' }))).status).toBe(201);
    expect(sql.mock.calls[3].slice(1)).toEqual([1, book.id, book.title, book.author, book.source_url]);
    expect(triggerDownloadWorkflow).toHaveBeenCalledOnce();
  });

  it('enqueues a www.book15.net source, mirroring the reading-side allowlist', async () => {
    // www 是同站备用 host（阅读侧与 worker 侧 policy 已同步放行），书库存量 www 来源照常入队。
    const wwwUrl = 'https://www.book15.net/books/details7.html';
    sql.mockResolvedValueOnce([{ ...book, source_url: wwwUrl }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 43 }]);
    expect((await POST(request('POST', { bookId: book.id }))).status).toBe(201);
    expect(sql.mock.calls[3].slice(1)).toEqual([1, book.id, book.title, book.author, wwwUrl]);
    expect(triggerDownloadWorkflow).toHaveBeenCalledOnce();
  });

  it('does not enqueue or dispatch when recovery fails during POST', async () => {
    sql.mockResolvedValueOnce([book]).mockRejectedValueOnce(new Error('database unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await POST(request('POST', { bookId: book.id }))).status).toBe(500);
    expect(sql).toHaveBeenCalledTimes(2);
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it.each(['pending', 'failed', 'partial'])('physically removes an owned %s row', async () => {
    sql.mockResolvedValueOnce([{ id: recoveredTask.id }]);

    const res = await DELETE(request('DELETE', { taskId: recoveredTask.id }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sql).toHaveBeenCalledOnce();
    expect(queryText(0)).toMatch(/^DELETE FROM download_tasks WHERE id = \? AND user_id = \? AND status IN \('pending', 'failed', 'partial'\) RETURNING id$/);
    expect(sql.mock.calls[0].slice(1)).toEqual([recoveredTask.id, 1]);
  });

  it.each(['running', 'done'])('protects an owned %s row and leaves its state untouched', async (status) => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status }]);
    const res = await DELETE(request('DELETE', { taskId: recoveredTask.id }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: '只能取消排队中的任务或清理未完成任务', code: 'TASK_CONFLICT' });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(queryText(0)).toMatch(/^DELETE FROM download_tasks /);
    expect(queryText(1)).toMatch(/^SELECT status FROM download_tasks /);
  });

  it('returns 404 without changing a foreign task', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await DELETE(request('DELETE', { taskId: recoveredTask.id }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(queryText(0)).toContain('user_id = ?');
    expect(queryText(1)).toContain('user_id = ?');
  });

  it.each(['', '1.5', 'Infinity', '1e2', '2147483648', '9007199254740992'])('rejects GET id %s before recovery writes', async (id) => {
    const res = await GET(request('GET', undefined, `?id=${encodeURIComponent(id)}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid id', code: 'INVALID_ID' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([null, true, [7], 1.5, 'Infinity', '1.0', 2147483648, '9007199254740992'])('rejects POST/DELETE IDs %s before writes or dispatch', async (id) => {
    const post = await POST(request('POST', { bookId: id }));
    const remove = await DELETE(request('DELETE', { taskId: id }));
    expect(post.status).toBe(400);
    expect(remove.status).toBe(400);
    expect(await post.json()).toEqual({ error: 'missing bookId', code: 'INVALID_ID' });
    expect(await remove.json()).toEqual({ error: 'missing taskId', code: 'INVALID_ID' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it.each(['POST', 'DELETE'] as const)('rejects oversized %s bodies without content-length', async (method) => {
    const req = request(method, { bookId: 7, taskId: 42, extra: 'x'.repeat(4096) });
    expect(req.headers.has('content-length')).toBe(false);
    const res = await (method === 'POST' ? POST : DELETE)(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'request body too large', code: 'BODY_TOO_LARGE' });
    expect(sql).not.toHaveBeenCalled();
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });
});
