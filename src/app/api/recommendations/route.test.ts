import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ ensureSchema: vi.fn(), getSql: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/db', () => mocks);
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: mocks.session }));
import { GET } from './route';
let db: ReturnType<typeof mockSql>;

describe('推荐主查询、最新原因和共享阅读定位', () => {
  beforeEach(() => {
    vi.resetAllMocks(); db = mockSql(); mocks.getSql.mockReturnValue(db.sql);
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true'); vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_OWNER_TOKEN', 'recommendations-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.session.mockResolvedValue({ userId: 2, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', ownerCredentialTag: null, membersEnabled: true });
    db.resolve.mockImplementation((query) => [{ id: 20, note: '', status: 'want', reason: 'A-private', created_at: '2026-09-16', read_task_id: query.text.includes('download_tasks') ? 90 : null }]);
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = () => new NextRequest('http://localhost/api/recommendations?userId=3', { headers: { Cookie: 'nf-dev-session=member-a', 'X-User-Id': '3' } });

  it('主表与最新 feedback 子查询使用同一个可信 userId；清空 note 不回退旧原因', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).recommendations[0]).toMatchObject({ note: '', reason: 'A-private', read_task_id: null });
    const query = db.queries[0];
    expect(query.values).toEqual([2, 2]);
    expect(query.text).toContain('f.book_id = r.book_id AND f.user_id = ?');
    expect(query.text).toContain('WHERE r.user_id = ?');
    expect(query.text).toContain('ORDER BY f.created_at DESC, f.id DESC LIMIT 1');
    expect(query.text).not.toMatch(/f\.note\s*(?:<>|!=)/);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });
  it('无 read 权限不查询共享任务，也不做文件可用性探测', async () => {
    const response = await GET(request());
    expect((await response.json()).recommendations[0].read_task_id).toBeNull();
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].text).not.toContain('download_tasks');
    expect(db.queries[0].text).toContain('NULL::integer AS read_task_id');
  });
  it('有 read 权限只关联共享完成文件 ID，不带任务日志、错误或身份', async () => {
    mocks.session.mockResolvedValue({ userId: 3, role: 'member', canFind: true, canRead: true, canDownload: false, authMethod: 'password', membersEnabled: true });
    const response = await GET(request());
    expect((await response.json()).recommendations[0].read_task_id).toBe(90);
    const query = db.queries[0];
    expect(query.values).toEqual([3, 3]);
    expect(query.text).toContain("dt.status = 'done'");
    expect(query.text).toContain('SELECT dt.id');
    expect(query.text).not.toMatch(/dt\.(?:error|user_id|source_url|log)/);
  });
  it('owner 的个人推荐仍只按 userId=1 查询', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    expect((await GET(new NextRequest('http://localhost/api/recommendations', { headers: { 'X-Owner-Token': 'recommendations-owner' } }))).status).toBe(200);
    expect(db.queries[0].values).toEqual([1, 1]);
  });
  it.each([null, { userId: 2, role: 'member', canFind: false, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true }])('拒绝匿名及缺少 find 能力的会话 %#', async (session) => {
    mocks.session.mockResolvedValue(session);
    expect((await GET(request())).status).toBe(session ? 403 : 401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled(); expect(db.queries).toHaveLength(0);
  });
});
