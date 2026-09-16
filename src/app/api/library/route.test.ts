import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ ensureSchema: vi.fn(), getSql: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/db', () => mocks);
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: mocks.session }));
import { GET } from './route';

let db: ReturnType<typeof mockSql>;

const FIND_ONLY = { userId: 2, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true };
const READER = { userId: 3, role: 'member', canFind: true, canRead: true, canDownload: false, authMethod: 'password', membersEnabled: true };

function memberRequest() {
  // 成员路径只在账号模式启用时走 Cookie 会话。
  vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
  return new NextRequest('http://localhost/api/library', { headers: { Cookie: 'nf-dev-session=member-a' } });
}
function ownerRequest(page?: string) {
  const url = new URL('http://localhost/api/library');
  if (page !== undefined) url.searchParams.set('page', page);
  return new NextRequest(url, { headers: { Authorization: 'Bearer library-test-owner' } });
}
function listQuery() {
  return db.queries.find((query) => query.text.includes('FROM labeled_books'));
}

describe('GET /api/library', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db = mockSql();
    mocks.getSql.mockReturnValue(db.sql);
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_OWNER_TOKEN', 'library-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.session.mockResolvedValue(FIND_ONLY);
    db.resolve.mockImplementation((query) => {
      if (query.text.includes('SELECT id, title')) return [{
        id: 7, title: '测试书', author: '作者', category: '仙侠', primary_genre: '修仙',
        quality: 8, finish_status: '完结', chars_labeled: 30000, labels: { genre: '成长' }, labeled_at: '2026-09-14',
      }];
      if (query.text.includes('AS total')) return [{ total: 31 }];
      return [];
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before validating or querying', async () => {
    const req = ownerRequest('Infinity');
    req.headers.delete('Authorization');
    expect((await GET(req)).status).toBe(401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it('rejects a member without find capability', async () => {
    mocks.session.mockResolvedValue({ ...FIND_ONLY, canFind: false });
    const res = await GET(memberRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', code: 'FORBIDDEN' });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('find-only 会话仍能读共享书库元数据，但拿不到完成文件定位', async () => {
    const res = await GET(memberRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).books[0]).toMatchObject({ id: 7, readTaskId: null });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });

  it('无 read 权限不查询共享任务定位，直接取 NULL', async () => {
    await GET(memberRequest());
    expect(listQuery()?.text).toContain('NULL::integer AS read_task_id');
    expect(listQuery()?.text).not.toContain('download_tasks');
  });

  it('有 read 权限才返回共享完成文件定位', async () => {
    mocks.session.mockResolvedValue(READER);
    db.resolve.mockImplementation((query) => {
      if (query.text.includes('SELECT id, title')) return [{
        id: 7, title: '测试书', author: '作者', category: '仙侠', primary_genre: '修仙',
        quality: 8, finish_status: '完结', chars_labeled: 30000, labels: { genre: '成长' },
        labeled_at: '2026-09-14', read_task_id: 90,
      }];
      if (query.text.includes('AS total')) return [{ total: 31 }];
      return [];
    });
    const res = await GET(memberRequest());
    expect((await res.json()).books[0].readTaskId).toBe(90);
    expect(listQuery()?.text).toContain('download_tasks');
    expect(listQuery()?.text).toContain("dt.status = 'done'");
  });

  it.each(['', '0', '-1', '1.5', '1.0', 'Infinity', 'NaN', '1e3', '0x10', ' 1', '10001', '9007199254740992'])('rejects page %s before touching the database', async (page) => {
    const res = await GET(ownerRequest(page));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'page must be an integer from 1 to 10000', code: 'INVALID_PAGE' });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it.each([
    { page: undefined, expected: 1, offset: 0 },
    { page: '2', expected: 2, offset: 30 },
    { page: '10000', expected: 10000, offset: 299970 },
  ])('accepts page $page and binds a finite offset', async ({ page, expected, offset }) => {
    const res = await GET(ownerRequest(page));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page: expected, pageSize: 30, maxPage: 10000, total: 31, books: [{ id: 7, genre: '成长' }] });
    expect(listQuery()?.values.slice(-2)).toEqual([30, offset]);
  });

  it('returns a controlled initialization failure', async () => {
    mocks.ensureSchema.mockRejectedValue(new Error('database unavailable'));
    const res = await GET(ownerRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
    expect(db.queries).toHaveLength(0);
  });
});
