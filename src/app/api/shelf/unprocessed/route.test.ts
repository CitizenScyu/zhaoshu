import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

const { ensureSchema, getSql, findSession } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), findSession: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: findSession }));
let db: ReturnType<typeof mockSql>;
let sql: ReturnType<typeof mockSql>['resolve'];
import { DELETE } from './route';

function request() {
  return new NextRequest('http://localhost/api/shelf/unprocessed', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer shelf-test-owner', 'Content-Type': 'application/json' },
  });
}

// 内存里的最小 recommendations 表：把「一本书多行、状态各不同」这个真实形态
// 摆出来，才能验证清理的粒度是「行」而不是「书」也不是「书架当前显示的那条」。
type Row = { id: number; userId: number; bookId: number; query: string; status: string };

function table(rows: Row[]) {
  const books = [{ id: 1, title: '同一本书', author: '同一作者' }, { id: 2, title: '另一本书', author: '另一作者' }];
  const state = [...rows];
  const resolve = (query: { text: string; values: unknown[] }) => {
    if (query.text.includes('DELETE FROM recommendations')) {
      const [userId, status] = query.values as [number, string];
      const hit = state.filter((row) => row.userId === Number(userId) && row.status === status);
      for (const row of hit) state.splice(state.indexOf(row), 1);
      return hit.map((row) => ({ id: row.id }));
    }
    if (query.text.startsWith('SELECT')) return [];
    throw new Error('批量清理不得发起删除以外的写语句：' + query.text);
  };
  return { resolve, state, books };
}

describe('/api/shelf/unprocessed', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'shelf-test-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    db = mockSql(); sql = db.resolve;
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(db.sql);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before accessing data', async () => {
    const req = request();
    req.headers.delete('Authorization');
    expect((await DELETE(req)).status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('只删本人的 status=new 行并回报条数', async () => {
    sql.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const res = await DELETE(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 3 });
    const query = db.queries.find((entry) => entry.text.includes('DELETE FROM recommendations'))!;
    expect(query.text).toBe('DELETE FROM recommendations WHERE user_id = ? AND status = ? RETURNING id');
    expect(query.values).toEqual([1, 'new']);
    // 写语句只有这一条 DELETE；授权围栏另算，但都不碰 books / feedback。
    expect(db.queries.filter((entry) => entry.text.includes('DELETE'))).toHaveLength(1);
    expect(db.queries.some((entry) => /DELETE FROM (books|feedback)/.test(entry.text))).toBe(false);
    expect(db.queries.some((entry) => /(INSERT INTO|UPDATE )/.test(entry.text))).toBe(false);
  });

  it('没有未处理推荐时仍返回 200 与 cleared=0（幂等，不报 404）', async () => {
    const res = await DELETE(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 0 });
  });

  // 这是本任务的核心回归：书架查询是 DISTINCT ON (r.book_id)，一本书只回最新一条。
  // 若批量清理按「书架当前显示的那批 id」删，就会删错或漏删。
  it('同书 old new 行 + new 非 new 行：只删 new 行，用户已表态的行与书本身都不动', async () => {
    const shelf = table([
      { id: 11, userId: 1, bookId: 1, query: '找明清小说', status: 'new' },
      { id: 12, userId: 1, bookId: 1, query: '找古典', status: 'want' },
      { id: 13, userId: 1, bookId: 2, query: '找科幻', status: 'new' },
    ]);
    sql.mockImplementation(shelf.resolve);
    const res = await DELETE(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 2 });
    // 11 与 13 被清掉；12（用户标记的 want）与 books 都还在。
    expect(shelf.state).toEqual([{ id: 12, userId: 1, bookId: 1, query: '找古典', status: 'want' }]);
    expect(shelf.books).toEqual([{ id: 1, title: '同一本书', author: '同一作者' }, { id: 2, title: '另一本书', author: '另一作者' }]);
    expect(db.queries.find((entry) => entry.text.includes('DELETE'))?.values).toEqual([1, 'new']);
  });

  it('同书被多 query 召回、只有最新一条会出现在书架上时，全部 new 行都要被清掉', async () => {
    const shelf = table([
      { id: 21, userId: 1, bookId: 1, query: '找明清小说', status: 'new' },
      { id: 22, userId: 1, bookId: 1, query: '找古典', status: 'new' },
      { id: 23, userId: 1, bookId: 1, query: '找章回体', status: 'new' },
    ]);
    sql.mockImplementation(shelf.resolve);
    // 书架只会显示 id=23 这一条；按显示集合删就会留下 21/22，未处理堆清不干净。
    expect(await (await DELETE(request())).json()).toEqual({ ok: true, cleared: 3 });
    expect(shelf.state).toEqual([]);
  });

  it('member A 清空未处理不影响 member B 的行', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    findSession.mockResolvedValue({ userId: 2, username: 'member', role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', ownerCredentialTag: null, membersEnabled: true });
    const shelf = table([
      { id: 31, userId: 2, bookId: 1, query: 'q', status: 'new' },
      { id: 32, userId: 2, bookId: 2, query: 'q', status: 'want' },
      { id: 33, userId: 3, bookId: 1, query: 'q', status: 'new' },
    ]);
    sql.mockImplementation(shelf.resolve);
    const req = new NextRequest('http://localhost/api/shelf/unprocessed?userId=3', {
      method: 'DELETE',
      headers: { Cookie: 'nf-dev-session=member-a', 'X-User-Id': '3', Origin: 'http://localhost', 'X-NF-CSRF': '1' },
    });
    expect(await (await DELETE(req)).json()).toEqual({ ok: true, cleared: 1 });
    expect(shelf.state).toEqual([
      { id: 32, userId: 2, bookId: 2, query: 'q', status: 'want' },
      { id: 33, userId: 3, bookId: 1, query: 'q', status: 'new' },
    ]);
    // 客户端传的 ?userId=3 不参与定位：写语句只认 principal 的 userId=2。
    expect(db.queries.find((entry) => entry.text.includes('DELETE'))?.values).toEqual([2, 'new']);
  });

  it('无 find 能力的 member 先拒绝，且不碰数据库', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    findSession.mockResolvedValue({ userId: 2, role: 'member', canFind: false, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true });
    const req = new NextRequest('http://localhost/api/shelf/unprocessed', {
      method: 'DELETE', headers: { Cookie: 'nf-dev-session=member-a', Origin: 'http://localhost', 'X-NF-CSRF': '1' },
    });
    expect((await DELETE(req)).status).toBe(403);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('会话身份的跨站写请求被 CSRF 拦下，且不写库', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    findSession.mockResolvedValue({ userId: 2, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true });
    const req = new NextRequest('http://localhost/api/shelf/unprocessed', {
      method: 'DELETE', headers: { Cookie: 'nf-dev-session=member-a', Origin: 'https://evil.example', 'X-NF-CSRF': '1' },
    });
    expect((await DELETE(req)).status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });

  it('返回受控的初始化失败，不泄漏数据库细节', async () => {
    ensureSchema.mockRejectedValue(new Error('private database details'));
    const res = await DELETE(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
    expect(db.queries).toHaveLength(0);
  });
});
