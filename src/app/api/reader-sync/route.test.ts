import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';
import { READER_SYNC_MAX_ENTRIES, type ReaderSyncEntry } from '@/lib/reader-sync';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  getReaderSyncForUser: vi.fn(),
  saveReaderSyncForUser: vi.fn(),
  session: vi.fn(),
}));
vi.mock('@/lib/db', () => mocks);
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: mocks.session }));
import { GET, PUT } from './route';

const progressEntry: ReaderSyncEntry = {
  kind: 'progress', key: 'novel-finder-reading-progress-u2-17',
  payload: { schema: 1, version: 'v1', chapterIndex: 4, partIndex: 0, ratio: 0.2, updatedAt: 1_700_000_000_000 },
  updatedAt: 1_700_000_000_000,
};
const write = (body: unknown, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest('http://localhost/api/reader-sync', {
  method: 'PUT',
  headers: { Cookie: 'nf-dev-session=member-a', 'Content-Type': 'application/json', 'x-nf-csrf': '1', Origin: 'http://localhost' },
  body: JSON.stringify(body),
  ...init,
});

describe('阅读进度/设置云端同步 API', () => {
  let db: ReturnType<typeof mockSql>;

  beforeEach(() => {
    vi.resetAllMocks();
    db = mockSql();
    mocks.getSql.mockReturnValue(db.sql);
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.session.mockResolvedValue({ userId: 2, role: 'member', canFind: true, canRead: true, canDownload: false, authMethod: 'password', ownerCredentialTag: null, membersEnabled: true });
    mocks.getReaderSyncForUser.mockResolvedValue([progressEntry]);
    mocks.saveReaderSyncForUser.mockResolvedValue([progressEntry]);
  });
  afterEach(() => vi.unstubAllEnvs());

  const get = () => new NextRequest('http://localhost/api/reader-sync', { headers: { Cookie: 'nf-dev-session=member-a' } });

  it('GET 返回本人全量条目，且出口不带 userId / 角色等身份字段', async () => {
    const response = await GET(get());
    expect(response.status).toBe(200);
    expect(mocks.getReaderSyncForUser).toHaveBeenCalledWith(2);
    const body = await response.json();
    expect(body).toEqual({ entries: [progressEntry] });
    expect(JSON.stringify(body)).not.toMatch(/userId|"role"|"updated_at"/);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it.each([null, { userId: 2, role: 'member', canFind: false, canRead: true, canDownload: false, authMethod: 'password', ownerCredentialTag: null, membersEnabled: true }])(
    '未登录 %# 与缺少 find 能力一律拒，且不碰数据库', async (session) => {
      mocks.session.mockResolvedValue(session);
      expect((await GET(get())).status).toBe(session ? 403 : 401);
      const denied = await PUT(write({ entries: [progressEntry] }));
      expect(denied.status).toBe(session ? 403 : 401);
      expect(mocks.ensureSchema).not.toHaveBeenCalled();
      expect(mocks.getReaderSyncForUser).not.toHaveBeenCalled();
      expect(mocks.saveReaderSyncForUser).not.toHaveBeenCalled();
      expect(db.queries).toHaveLength(0);
    });

  it('PUT 按归一后的条目写入，并把服务端回读的真值作为响应（不是乐观的 ok）', async () => {
    const serverTruth = { ...progressEntry, updatedAt: 1_700_000_999_999 };
    mocks.saveReaderSyncForUser.mockResolvedValue([serverTruth]);
    const response = await PUT(write({ entries: [progressEntry] }));
    expect(response.status).toBe(200);
    expect(mocks.saveReaderSyncForUser.mock.calls[0][0]).toBe(2);
    expect(mocks.saveReaderSyncForUser.mock.calls[0][1]).toEqual([progressEntry]);
    expect(await response.json()).toEqual({ entries: [serverTruth] });
  });

  it.each([
    ['空数组', { entries: [] }],
    ['缺 entries', { progress: {} }],
    ['条目形状非法', { entries: [{ kind: 'progress', key: '任意键', payload: {}, updatedAt: 1 }] }],
    ['键不属于任何已知形态', { entries: [{ kind: 'progress', key: 'novel-finder-reading-progress', payload: {}, updatedAt: 1 }] }],
    ['updatedAt 非整数', { entries: [{ ...progressEntry, updatedAt: 1.5 }] }],
    ['payload 不是对象', { entries: [{ ...progressEntry, payload: 'settings' }] }],
  ])('非法请求体 %s 返回 400 且不写库', async (_name, body) => {
    const response = await PUT(write(body));
    expect(response.status).toBe(400);
    expect(mocks.saveReaderSyncForUser).not.toHaveBeenCalled();
  });

  it('条数超限的请求先被 32KB 正文上限挡下（413），同样不写库', async () => {
    const response = await PUT(write({ entries: Array.from({ length: READER_SYNC_MAX_ENTRIES + 1 }, () => progressEntry) }));
    expect(response.status).toBe(413);
    expect(mocks.saveReaderSyncForUser).not.toHaveBeenCalled();
  });

  it('缺 CSRF 固定头或非 JSON 的 PUT 一律拒绝（同源写保护）', async () => {
    expect((await PUT(write({ entries: [progressEntry] }, { headers: { Cookie: 'nf-dev-session=member-a', 'Content-Type': 'application/json', Origin: 'http://localhost' } }))).status).toBe(403);
    expect((await PUT(write({ entries: [progressEntry] }, { headers: { Cookie: 'nf-dev-session=member-a', 'Content-Type': 'text/plain', 'x-nf-csrf': '1', Origin: 'http://localhost' } }))).status).toBe(415);
    expect(mocks.saveReaderSyncForUser).not.toHaveBeenCalled();
  });
});
