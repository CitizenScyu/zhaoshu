import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, sql, upsertBook } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), sql: vi.fn(), upsertBook: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql, upsertBook }));
import { DELETE, POST } from './route';

function request(method: 'POST' | 'DELETE', body?: unknown, id?: string) {
  const url = new URL('http://localhost/api/shelf');
  if (id !== undefined) url.searchParams.set('id', id);
  return new NextRequest(url, {
    method, headers: { Authorization: 'Bearer shelf-test-owner', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/shelf', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'shelf-test-owner');
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    upsertBook.mockResolvedValue(42);
    sql.mockResolvedValue([]);
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
    expect(upsertBook).not.toHaveBeenCalled();
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
    expect(upsertBook).not.toHaveBeenCalled();
  });

  it.each([7, '7', 2147483647])('adds valid book %s as want without changing its identity', async (labeledBookId) => {
    sql.mockResolvedValueOnce([{ title: ' 测试书 ', author: '' }]);
    const res = await POST(request('POST', { labeledBookId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bookId: 42 });
    expect(sql.mock.calls[0].slice(1)).toEqual([Number(labeledBookId)]);
    expect(upsertBook).toHaveBeenCalledWith({ title: '测试书', author: '佚名', meta: {} });
    expect(sql.mock.calls[2].slice(1)).toEqual([42, '书库添加', 'want']);
  });

  it('keeps not-found and duplicate-shelf outcomes distinct', async () => {
    const missing = await POST(request('POST', { labeledBookId: 7 }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'book not found', code: 'BOOK_NOT_FOUND' });
    sql.mockResolvedValueOnce([{ title: '测试书', author: '作者' }]).mockResolvedValueOnce([{ exists: 1 }]);
    const duplicate = await POST(request('POST', { labeledBookId: 7 }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: '已在书架', code: 'ALREADY_ON_SHELF' });
    expect(sql.mock.calls.some(([strings]) => (strings as TemplateStringsArray).join('').includes('INSERT'))).toBe(false);
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
    expect(sql.mock.calls[0].slice(1)).toEqual([2147483647]);
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
});
