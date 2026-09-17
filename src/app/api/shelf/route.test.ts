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
import { DELETE, POST } from './route';

function request(method: 'POST' | 'DELETE', body?: unknown, id?: string, status?: string) {
  const url = new URL('http://localhost/api/shelf');
  if (id !== undefined) url.searchParams.set('id', id);
  if (status !== undefined) url.searchParams.set('status', status);
  return new NextRequest(url, {
    method, headers: { Authorization: 'Bearer shelf-test-owner', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/shelf', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'shelf-test-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    db = mockSql(); sql = db.resolve;
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(db.sql);
    sql.mockImplementation((query) => query.text.includes('INSERT INTO recommendations') ? [{ book_id: 42 }] : []);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(['POST', 'DELETE'] as const)('authenticates %s before accessing data', async (method) => {
    const req = request(method, method === 'POST' ? { labeledBookId: 7 } : undefined, '7');
    req.headers.delete('Authorization');
    expect((await (method === 'POST' ? POST : DELETE)(req)).status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([undefined, null, true, [7], {}, '', 0, -1, 1.5, 'Infinity', '1.0', '0x10', 2147483648, '9007199254740992'])('rejects invalid labeledBookId %s without writes', async (labeledBookId) => {
    const res = await POST(request('POST', { labeledBookId }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing valid labeledBookId', code: 'INVALID_ID' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([undefined, '1'])('limits bodies even with content-length %s', async (declaredLength) => {
    const req = request('POST', { labeledBookId: 7, extra: 'x'.repeat(4096) });
    expect(req.headers.has('content-length')).toBe(false);
    if (declaredLength) req.headers.set('content-length', declaredLength);
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'request body too large', code: 'BODY_TOO_LARGE' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([7, '7', 2147483647])('adds valid book %s as want without changing its identity', async (labeledBookId) => {
    sql.mockResolvedValueOnce([{ title: ' 测试书 ', author: '' }]);
    const res = await POST(request('POST', { labeledBookId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bookId: 42 });
    expect(sql.mock.calls[0][0].values).toEqual([Number(labeledBookId)]);
    expect(db.queries.find((query) => query.text.includes('INSERT INTO books'))?.values).toEqual(['测试书', '佚名']);
    expect(db.queries.find((query) => query.text.includes('INSERT INTO recommendations'))?.values).toEqual([1, '书库添加', 'want', '测试书', '佚名', 1]);
  });

  it('keeps not-found and duplicate-shelf outcomes distinct', async () => {
    const missing = await POST(request('POST', { labeledBookId: 7 }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'book not found', code: 'BOOK_NOT_FOUND' });
    sql.mockResolvedValueOnce([{ title: '测试书', author: '作者' }]).mockResolvedValueOnce([{ exists: 1 }]);
    const duplicate = await POST(request('POST', { labeledBookId: 7 }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: '已在书架', code: 'ALREADY_ON_SHELF' });
    expect(db.queries.some((query) => query.text.includes('INSERT'))).toBe(false);
  });

  it.each([undefined, '', '0', '1.5', 'Infinity', '2147483648', '9007199254740992'])('rejects DELETE id %s without writes', async (id) => {
    const res = await DELETE(request('DELETE', undefined, id));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing valid id', code: 'INVALID_ID' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it('deletes a valid recommendation and reports an absent one', async () => {
    sql.mockResolvedValueOnce([{ id: 2147483647 }]);
    const deleted = await DELETE(request('DELETE', undefined, '2147483647'));
    expect(deleted.status).toBe(200);
    expect(sql.mock.calls[0][0].values).toEqual([2147483647, 1]);
    const missing = await DELETE(request('DELETE', undefined, '7'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'recommendation not found', code: 'RECOMMENDATION_NOT_FOUND' });
  });

  it.each(['POST', 'DELETE'] as const)('returns a controlled initialization failure for %s', async (method) => {
    ensureSchema.mockRejectedValue(new Error('private database details'));
    const res = await (method === 'POST' ? POST : DELETE)(request(method, method === 'POST' ? { labeledBookId: 7 } : undefined, '7'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
    expect(sql).not.toHaveBeenCalled();
  });
  function memberRequest(method: 'POST' | 'DELETE', userId: number, body?: unknown, id?: string, status?: string) {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    findSession.mockImplementation(async (_sql, token) => ({ userId: token === 'member-a' ? 2 : 3,
      username: 'member', role: 'member', canFind: true, canRead: false, canDownload: false,
      authMethod: 'password', ownerCredentialTag: null, membersEnabled: true }));
    const req = request(method, body, id, status); req.headers.delete('Authorization');
    req.headers.set('Cookie', `nf-dev-session=${userId === 2 ? 'member-a' : 'member-b'}`);
    req.headers.set('Origin', 'http://localhost'); req.headers.set('X-NF-CSRF', '1');
    return new NextRequest(req);
  }
  it('同书 A/B 可各自加书架，重复判断和最终 INSERT 都按本人', async () => {
    const onShelf = new Set<number>();
    sql.mockImplementation((query) => {
      if (query.text.includes('FROM labeled_books')) return [{ title: '同一本书', author: '同一作者' }];
      if (query.text.includes('SELECT 1 FROM recommendations r JOIN books')) return onShelf.has(Number(query.values[0])) ? [{ exists: 1 }] : [];
      if (query.text.includes('INSERT INTO recommendations')) { onShelf.add(Number(query.values[0])); return [{ book_id: 42 }]; }
      return [];
    });
    expect((await POST(memberRequest('POST', 2, { labeledBookId: 7, userId: 3 }))).status).toBe(200);
    expect((await POST(memberRequest('POST', 3, { labeledBookId: 7, userId: 2 }))).status).toBe(200);
    expect((await POST(memberRequest('POST', 2, { labeledBookId: 7 }))).status).toBe(409);
    expect([...onShelf]).toEqual([2, 3]);
    for (const query of db.queries.filter((query) => query.text.includes('INSERT INTO recommendations'))) {
      expect(query.text).toContain('r.book_id = b.id AND r.user_id = ?');
      expect(query.text).toContain('ON CONFLICT (user_id, book_id, query)');
      expect(query.values[0]).toBe(query.values.at(-1));
    }
  });
  it('伪造他人的推荐 ID 与不存在的 ID 都是 404，且不改变任何状态', async () => {
    const owners = new Map([[7, 3], [8, 2]]);
    sql.mockImplementation((query) => {
      if (!query.text.includes('DELETE FROM recommendations')) return [];
      const [id, userId] = query.values.map(Number);
      if (owners.get(id) !== userId) return [];
      owners.delete(id); return [{ id }];
    });
    const foreign = await DELETE(memberRequest('DELETE', 2, undefined, '7'));
    const missing = await DELETE(memberRequest('DELETE', 2, undefined, '999'));
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(await foreign.json()).toEqual(await missing.json());
    expect([...owners]).toEqual([[7, 3], [8, 2]]);
    expect((await DELETE(memberRequest('DELETE', 2, undefined, '8'))).status).toBe(200);
    expect([...owners]).toEqual([[7, 3]]);
    for (const query of db.queries.filter((q) => q.text.includes('DELETE FROM recommendations'))) {
      expect(query.text).toContain('WHERE id = ? AND user_id = ?'); expect(query.values[1]).toBe(2);
    }
  });
  it.each(['POST', 'DELETE'] as const)('%s 对无 find 能力的 member 先拒绝', async (method) => {
    const req = memberRequest(method, 2, method === 'POST' ? { labeledBookId: 7 } : undefined, '7');
    findSession.mockResolvedValue({ userId: 2, role: 'member', canFind: false, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true });
    expect((await (method === 'POST' ? POST : DELETE)(req)).status).toBe(403);
    expect(ensureSchema).not.toHaveBeenCalled(); expect(db.queries).toHaveLength(0);
  });

  // 批量清理未处理：DELETE ?status=new。
  it('清空未处理只删本人的 status=new 行并回报条数', async () => {
    sql.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const res = await DELETE(request('DELETE', undefined, undefined, 'new'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 3 });
    const query = db.queries.find((entry) => entry.text.includes('DELETE FROM recommendations'))!;
    expect(query.text).toContain('WHERE user_id = ? AND status = ?');
    expect(query.text).not.toContain('WHERE id = ?');
    expect(query.values).toEqual([1, 'new']);
  });

  it('没有未处理推荐时仍返回 200 与 cleared=0（幂等，不报 404）', async () => {
    const res = await DELETE(request('DELETE', undefined, undefined, 'new'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 0 });
  });

  it.each([['want'], [''], ['new '], ['NEW']])('status=%s 不构成批量清理，按缺少 id 拒绝且不写库', async (status) => {
    const res = await DELETE(request('DELETE', undefined, undefined, status));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing valid id', code: 'INVALID_ID' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('id 一旦出现就绝不回落成批量清理：非法 id 400，合法 id 仍只删那一条', async () => {
    const forged = await DELETE(request('DELETE', undefined, 'abc', 'new'));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: 'missing valid id', code: 'INVALID_ID' });
    expect(db.queries.filter((entry) => entry.text.includes('DELETE'))).toHaveLength(0);

    sql.mockResolvedValueOnce([{ id: 7 }]);
    expect((await DELETE(request('DELETE', undefined, '7', 'new'))).status).toBe(200);
    const query = db.queries.find((entry) => entry.text.includes('DELETE FROM recommendations'))!;
    expect(query.text).toContain('WHERE id = ? AND user_id = ?');
    expect(query.values).toEqual([7, 1]);
  });

  it('member A 清空未处理不影响 member B 的行', async () => {
    const rows = [
      { id: 1, userId: 2, status: 'new' },
      { id: 2, userId: 2, status: 'want' },
      { id: 3, userId: 3, status: 'new' },
    ];
    sql.mockImplementation((query) => {
      if (!query.text.includes('DELETE FROM recommendations')) return [];
      const [userId, status] = query.values as [number, string];
      const removed = rows.filter((entry) => entry.userId === Number(userId) && entry.status === status);
      for (const entry of removed) rows.splice(rows.indexOf(entry), 1);
      return removed;
    });
    const res = await DELETE(memberRequest('DELETE', 2, undefined, undefined, 'new'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 1 });
    expect(rows).toEqual([{ id: 2, userId: 2, status: 'want' }, { id: 3, userId: 3, status: 'new' }]);
    expect(db.queries.find((entry) => entry.text.includes('DELETE FROM recommendations'))?.values).toEqual([2, 'new']);
  });

  it('批量清理同样对匿名的 owner 口令缺失先拒绝', async () => {
    const req = request('DELETE', undefined, undefined, 'new');
    req.headers.delete('Authorization');
    expect((await DELETE(req)).status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('批量清理对无 find 能力的 member 先拒绝', async () => {
    const req = memberRequest('DELETE', 2, undefined, undefined, 'new');
    findSession.mockResolvedValue({ userId: 2, role: 'member', canFind: false, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true });
    expect((await DELETE(req)).status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });

});
