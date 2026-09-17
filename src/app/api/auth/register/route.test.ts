import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  ensureAuthSchema: vi.fn(),
  cleanupExpiredAuthRows: vi.fn(),
  hashPassword: vi.fn(),
}));

vi.mock('@/lib/db', async (original) => ({
  ...await original<typeof import('@/lib/db')>(),
  getSql: mocks.getSql,
}));
vi.mock('@/lib/auth-session', async (original) => ({
  ...await original<typeof import('@/lib/auth-session')>(),
  ensureAuthSchema: mocks.ensureAuthSchema,
  cleanupExpiredAuthRows: mocks.cleanupExpiredAuthRows,
}));
// scrypt 参数很贵，这里只关心调用顺序与失败路径；密码边界用真实实现校验。
vi.mock('@/lib/password', async (original) => ({
  ...await original<typeof import('@/lib/password')>(),
  hashPassword: mocks.hashPassword,
}));

import { hashInviteCode } from '@/lib/invite-codes';
import { POST } from './route';

const SECRET = 'register-test-secret-0123456789abcdef';
const GOOD_PASSWORD = 'correct horse battery';

let db: ReturnType<typeof mockSql>;

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-nf-csrf': '1', origin: 'http://localhost', ...headers },
    ...(typeof body === 'string' ? { body } : { body: JSON.stringify(body) }),
  });
}

const GOOD = { username: 'reader_one', password: GOOD_PASSWORD };

// 配置行 + 限速计数由同一个 mock 分发；事务内的注册语句按文本判定。
function mockRegisterDb(row: Record<string, unknown> | null, { limited = false } = {}) {
  db.resolve.mockImplementation((query) => {
    if (query.text.includes('auth_rate_limits')) return [{ attempts: limited ? 99 : 1, retry_after_seconds: 30 }];
    if (query.text.includes('INSERT INTO users') || query.text.includes('SELECT (SELECT members_enabled')) {
      return row ? [row] : [];
    }
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
  vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
  vi.stubEnv('NODE_ENV', 'test');
  db = mockSql();
  mocks.getSql.mockReturnValue(db.sql);
  mocks.ensureAuthSchema.mockResolvedValue(undefined);
  mocks.cleanupExpiredAuthRows.mockResolvedValue(undefined);
  mocks.hashPassword.mockResolvedValue('scrypt$1$hashed');
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/auth/register 前置校验', () => {
  it('账号模式关闭 → 503，不碰数据库', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    expect((await POST(req(GOOD))).status).toBe(503);
    expect(db.queries).toHaveLength(0);
  });

  it('缺 CSRF 固定头 → 403；跨源 Origin → 403', async () => {
    expect((await POST(req(GOOD, { 'x-nf-csrf': '' }))).status).toBe(403);
    expect((await POST(req(GOOD, { origin: 'https://evil.example' }))).status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });

  it('非 JSON 正文 → 415', async () => {
    expect((await POST(req(GOOD, { 'Content-Type': 'text/plain' }))).status).toBe(415);
  });

  it('非法用户名与过短密码 → 400，且不写库', async () => {
    expect((await POST(req({ username: 'ab', password: GOOD_PASSWORD }))).status).toBe(400);
    expect((await POST(req({ username: 'bad name!', password: GOOD_PASSWORD }))).status).toBe(400);
    // owner 是保留名：显式 409，不能掉进通用 503，也不能靠数据库 CHECK 兜底。
    expect((await POST(req({ username: 'OWNER', password: GOOD_PASSWORD }))).status).toBe(409);
    expect((await POST(req({ username: 'reader_one', password: 'short' }))).status).toBe(400);
    expect(db.queries).toHaveLength(0);
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it('限速超限 → 429，且不计算 KDF', async () => {
    mockRegisterDb(null, { limited: true });
    const res = await POST(req(GOOD));
    expect(res.status).toBe(429);
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/register 三态', () => {
  it('closed → 403 REGISTRATION_CLOSED，即使带了邀请码', async () => {
    mockRegisterDb({ members_enabled: true, registration_mode: 'closed', claimed: 0, id: null, username: null, can_find: null, can_read: null, can_download: null });
    const res = await POST(req({ ...GOOD, inviteCode: 'nf-whatever' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REGISTRATION_CLOSED');
  });

  it('成员总闸关闭 → 403 MEMBERS_DISABLED', async () => {
    mockRegisterDb({ members_enabled: false, registration_mode: 'open', claimed: 0, id: null, username: null, can_find: null, can_read: null, can_download: null });
    const res = await POST(req(GOOD));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MEMBERS_DISABLED');
  });

  it('open → 201，插 member、空画像与 session，并下发 Cookie', async () => {
    mockRegisterDb({ members_enabled: true, registration_mode: 'open', claimed: 0, id: 2, username: 'reader_one', can_find: true, can_read: false, can_download: false });
    const res = await POST(req(GOOD));
    expect(res.status).toBe(201);
    const payload = await res.json() as { user: { username: string; role: string; canRead: boolean } };
    // 能力由服务端固定，请求体里带什么都提不了权（这里请求体本来就没有 role 字段）。
    expect(payload.user).toMatchObject({ username: 'reader_one', role: 'member', canRead: false });
    expect(res.headers.get('set-cookie')).toContain('nf-dev-session=');
    const sql = db.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('INSERT INTO users');
    expect(sql).toContain('INSERT INTO profile');
    expect(sql).toContain('INSERT INTO sessions');
    expect(sql).toContain('registration_mode IN (\'open\', \'invite\')');
  });

  it('注册 CTE 的资格判定必须写在发出的 SQL 里（桩测试抓不到真库语义，只能钉住文本）', async () => {
    mockRegisterDb({ members_enabled: true, registration_mode: 'open', claimed: 0, id: 2, username: 'reader_one', can_find: true, can_read: false, can_download: false });
    await POST(req(GOOD));
    const statements = db.queries.map((query) => query.text.replace(/\s+/g, ' '));
    const registration = statements.find((text) => text.includes('registration_invites SET used_at'));
    expect(registration).toBeDefined();

    // 1) 闸门本身：members_enabled 与三态里的两态（closed 一律不允许）写死在 cfg 的子查询里。
    expect(registration).toContain('INSERT INTO users');
    expect(registration).toContain('SELECT members_enabled, registration_mode FROM auth_settings WHERE id = 1 FOR SHARE');
    expect(registration).toContain('WHERE members_enabled AND registration_mode IN (\'open\', \'invite\')');
    // 2) 插入 member 必须挂在 gate 的存在性上；换成 WHERE true 会让关闭状态下也能注册。
    expect(registration).toContain('WHERE EXISTS (SELECT 1 FROM gate)');
    // 3) open 免码、invite 必须有 claim 成功——这个析取是「哪些模式能不带码」的唯一定义。
    expect(registration).toContain("AND ((SELECT registration_mode FROM cfg) = 'open' OR EXISTS (SELECT 1 FROM claim))");
    // 4) 消费只发生在 invite 模式，且必须同时未使用、未作废、未过期。
    expect(registration).toContain("AND (SELECT registration_mode FROM cfg) = 'invite'");
    // 5) 三张表共用同一个 new_user 输出，不能各自独立判资格。
    expect(registration).toContain('INSERT INTO profile (id) SELECT id FROM new_user');
    expect(registration).toContain('FROM new_user');
    // 6) 一个 WHERE true 或裸 true 的旁路都不允许出现在资格判定语句里。
    expect(registration).not.toMatch(/WHERE true(\s|$)/);
    expect(registration).not.toContain('AND true');
  });

  it('invite + 有效码 → 201；消费与 used_by 回填都在同一事务里', async () => {
    mockRegisterDb({ members_enabled: true, registration_mode: 'invite', claimed: 1, id: 3, username: 'reader_one', can_find: true, can_read: false, can_download: false });
    const res = await POST(req({ ...GOOD, inviteCode: 'nf-goodcode' }));
    expect(res.status).toBe(201);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const sql = db.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('UPDATE registration_invites SET used_at = now()');
    expect(sql).toContain('used_at IS NULL AND revoked_at IS NULL');
    expect(sql).toContain('expires_at IS NULL OR expires_at > now()');
    expect(sql).toContain('UPDATE registration_invites SET used_by');
    // 只写摘要：库参数里不能出现邀请码原文。
    expect(db.queries.flatMap((query) => query.values)).not.toContain('nf-goodcode');
    expect(db.queries.flatMap((query) => query.values)).toContain(hashInviteCode('nf-goodcode'));
  });

  it('invite 未消费成功（过期/作废/已用/缺失）→ 403，文案统一不区分原因', async () => {
    mockRegisterDb({ members_enabled: true, registration_mode: 'invite', claimed: 0, id: null, username: null, can_find: null, can_read: null, can_download: null });
    for (const body of [{ ...GOOD }, { ...GOOD, inviteCode: 'nf-expired' }]) {
      const res = await POST(req(body));
      expect(res.status).toBe(403);
      const payload = await res.json() as { code: string; error: string };
      expect(payload.code).toBe('INVITATION_INVALID');
      expect(payload.error).toBe('邀请码无效或已不可用');
    }
  });

  it('用户名冲突（唯一索引）→ 409，不谎报成功也不返回半注册信息', async () => {
    mockRegisterDb(null);
    db.resolve.mockImplementation((query) => {
      if (query.text.includes('auth_rate_limits')) return [{ attempts: 1, retry_after_seconds: 0 }];
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    const res = await POST(req(GOOD));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('USERNAME_TAKEN');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('数据库不可用 → 503，不下发 Cookie', async () => {
    mocks.ensureAuthSchema.mockRejectedValue(new Error('down'));
    const res = await POST(req(GOOD));
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
