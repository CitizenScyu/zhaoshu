import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, sql } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), sql: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
import { GET } from './route';

function request(page?: string) {
  const url = new URL('http://localhost/api/library');
  if (page !== undefined) url.searchParams.set('page', page);
  return new NextRequest(url, { headers: { Authorization: 'Bearer library-test-owner' } });
}

describe('GET /api/library', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'library-test-owner');
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    sql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join('');
      if (query.includes('SELECT id, title')) return [{
        id: 7, title: '测试书', author: '作者', category: '仙侠', primary_genre: '修仙',
        quality: 8, finish_status: '完结', chars_labeled: 30000, labels: { genre: '成长' }, labeled_at: '2026-09-14',
      }];
      if (query.includes('AS total')) return [{ total: 31 }];
      return [];
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before validating or querying', async () => {
    const req = request('Infinity');
    req.headers.delete('Authorization');
    expect((await GET(req)).status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(getSql).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '1.5', '1.0', 'Infinity', 'NaN', '1e3', '0x10', ' 1', '10001', '9007199254740992'])('rejects page %s before touching the database', async (page) => {
    const res = await GET(request(page));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'page must be an integer from 1 to 10000', code: 'INVALID_PAGE' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([
    { page: undefined, expected: 1, offset: 0 },
    { page: '2', expected: 2, offset: 30 },
    { page: '10000', expected: 10000, offset: 299970 },
  ])('accepts page $page and binds a finite offset', async ({ page, expected, offset }) => {
    const res = await GET(request(page));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page: expected, pageSize: 30, maxPage: 10000, total: 31, books: [{ id: 7, genre: '成长' }] });
    const listQuery = sql.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join('').includes('LIMIT'));
    expect(listQuery?.slice(-2)).toEqual([30, offset]);
  });

  it('returns a controlled initialization failure', async () => {
    ensureSchema.mockRejectedValue(new Error('database unavailable'));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
    expect(sql).not.toHaveBeenCalled();
  });
});
