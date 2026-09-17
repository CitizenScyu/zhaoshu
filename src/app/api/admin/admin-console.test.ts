import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(), findSessionByToken: vi.fn(), peekAuthRateLimit: vi.fn(), bumpAuthRateLimit: vi.fn(),
}));

vi.mock('@/lib/db', async (original) => ({
  ...await original<typeof import('@/lib/db')>(),
  getSql: mocks.getSql,
}));
vi.mock('@/lib/auth-session', async (original) => ({
  ...await original<typeof import('@/lib/auth-session')>(),
  findSessionByToken: mocks.findSessionByToken,
}));
// 账号模式下 owner 头要过限速查询：闸门打开的用例必须把这一层钉住，否则 503 会被误当成业务失败。
vi.mock('@/lib/auth-rate-limit', async (original) => ({
  ...await original<typeof import('@/lib/auth-rate-limit')>(),
  peekAuthRateLimit: mocks.peekAuthRateLimit,
  bumpAuthRateLimit: mocks.bumpAuthRateLimit,
}));

import { GET as registrationGet, PATCH as registrationPatch } from './registration/route';
import { GET as invitesGet, POST as invitesPost } from './invites/route';
import { POST as inviteRevoke } from './invites/[id]/revoke/route';
import { GET as usersGet } from './users/route';
import { PATCH as userPatch } from './users/[id]/route';
import { GET as labelGet, PATCH as labelPatch } from './label-model/route';

const OWNER_TOKEN = 'admin-console-owner-token';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

let db: ReturnType<typeof mockSql>;

// 只带显式 owner 头通道：没有 Origin，因此不触发浏览器的 CSRF 分支（脚本语义）。
function owner(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function call(handler: Handler, req: NextRequest, params: Record<string, string> = {}) {
  return handler(req, { params: Promise.resolve(params) });
}

const WRITES: { name: string; path: string; handler: Handler; params?: Record<string, string> }[] = [
  { name: 'PATCH /api/admin/registration', path: '/api/admin/registration', handler: registrationPatch as Handler },
  { name: 'POST /api/admin/invites', path: '/api/admin/invites', handler: invitesPost as Handler },
  { name: 'POST /api/admin/invites/[id]/revoke', path: '/api/admin/invites/7/revoke', handler: inviteRevoke as Handler, params: { id: '7' } },
  { name: 'PATCH /api/admin/users/[id]', path: '/api/admin/users/2', handler: userPatch as Handler, params: { id: '2' } },
  { name: 'PATCH /api/admin/label-model', path: '/api/admin/label-model', handler: labelPatch as Handler },
];

const READS: { name: string; path: string; handler: Handler }[] = [
  { name: 'GET /api/admin/registration', path: '/api/admin/registration', handler: registrationGet as Handler },
  { name: 'GET /api/admin/invites', path: '/api/admin/invites', handler: invitesGet as Handler },
  { name: 'GET /api/admin/users', path: '/api/admin/users', handler: usersGet as Handler },
  { name: 'GET /api/admin/label-model', path: '/api/admin/label-model', handler: labelGet as Handler },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_OWNER_TOKEN', OWNER_TOKEN);
  vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
  mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 0, retryAfterSeconds: 0 });
  mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 1, retryAfterSeconds: 900 });
  db = mockSql();
  mocks.getSql.mockReturnValue(db.sql);
});

afterEach(() => { vi.unstubAllEnvs(); });

// 闸门打开时 owner 头走限速 + 代际标签那条路，缺 AUTH_SECURITY_SECRET 会直接 503。
function enableAccounts(): void {
  vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
  vi.stubEnv('AUTH_SECURITY_SECRET', 'a'.repeat(48));
}

describe('管理 API 鉴权', () => {
  it.each(READS)('$name 匿名 → 401，且在业务读库前拒绝', async (route) => {
    const res = await call(route.handler, owner('GET', route.path, undefined, { Authorization: '' }));
    expect(res.status).toBe(401);
    expect(db.queries).toHaveLength(0);
  });

  it.each(WRITES)('$name 匿名 → 401，不碰数据库', async (route) => {
    const req = owner('POST', route.path, {}, { Authorization: '' });
    const res = await call(route.handler, req, route.params);
    expect(res.status).toBe(401);
    expect(db.queries).toHaveLength(0);
  });

  it.each(WRITES)('$name 成员会话 → 403（owner 专用）', async (route) => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    mocks.findSessionByToken.mockResolvedValue({
      userId: 7, username: 'member', role: 'member',
      canFind: true, canRead: true, canDownload: true,
      authMethod: 'password', ownerCredentialTag: null, membersEnabled: true,
    });
    const req = new NextRequest(`http://localhost${route.path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'nf-dev-session=member' }, body: '{}',
    });
    const res = await call(route.handler, req, route.params);
    expect(res.status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });

  it.each(WRITES)('$name 带 Origin 但缺 CSRF 固定头 → 403，不写库', async (route) => {
    const req = owner('POST', route.path, {}, { Origin: 'http://localhost' });
    const res = await call(route.handler, req, route.params);
    expect(res.status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });

  it.each(WRITES)('$name 跨源 Origin → 403', async (route) => {
    const req = owner('POST', route.path, {}, { Origin: 'https://evil.example', 'x-nf-csrf': '1' });
    const res = await call(route.handler, req, route.params);
    expect(res.status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });
});

describe('注册开关管理', () => {
  it('owner 读到当前设置', async () => {
    db.resolve.mockResolvedValue([{ members_enabled: true, registration_mode: 'invite', updated_at: '2026-06-01T00:00:00.000Z' }]);
    const res = await call(registrationGet as Handler, owner('GET', '/api/admin/registration'));
    expect(res.status).toBe(200);
    // 既有三个字段原样保留（向后兼容），只多一个只读的 accountsEnabled。
    expect(await res.json()).toEqual({
      membersEnabled: true, registrationMode: 'invite', updatedAt: '2026-06-01T00:00:00.000Z', accountsEnabled: false,
    });
  });

  it('accountsEnabled 跟随部署闸门，且读得到设置时不受库值影响', async () => {
    enableAccounts();
    db.resolve.mockResolvedValue([{ members_enabled: false, registration_mode: 'open', updated_at: null }]);
    const res = await call(registrationGet as Handler, owner('GET', '/api/admin/registration'));
    expect(await res.json()).toMatchObject({ membersEnabled: false, registrationMode: 'open', accountsEnabled: true });
  });

  it('库读不到时仍是 503，且响应体不含闸门状态', async () => {
    db.resolve.mockRejectedValue(new Error('db down'));
    const res = await call(registrationGet as Handler, owner('GET', '/api/admin/registration'));
    expect(res.status).toBe(503);
    const payload = await res.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ code: 'SETTINGS_UNAVAILABLE' });
    expect(payload).not.toHaveProperty('accountsEnabled');
  });

  it('PATCH 响应与 GET 同形（含 accountsEnabled），否则保存后闸门提示会消失', async () => {
    enableAccounts();
    db.resolve
      .mockResolvedValueOnce([{ members_enabled: false, registration_mode: 'invite', updated_at: null }])
      .mockResolvedValue([{ updated_at: '2026-06-01T00:00:00.000Z' }]);
    const res = await call(registrationPatch as Handler, owner('PATCH', '/api/admin/registration', { membersEnabled: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      membersEnabled: true, registrationMode: 'invite', updatedAt: '2026-06-01T00:00:00.000Z', accountsEnabled: true,
    });
  });

  it('非法模式 → 400，不写库', async () => {
    const res = await call(registrationPatch as Handler, owner('PATCH', '/api/admin/registration', { registrationMode: 'public' }));
    expect(res.status).toBe(400);
    expect(db.queries).toHaveLength(0);
  });

  it('部分更新只改提交的字段，另一项保持库里的值', async () => {
    db.resolve
      .mockResolvedValueOnce([{ members_enabled: false, registration_mode: 'invite', updated_at: null }])
      .mockResolvedValue([{ updated_at: '2026-06-01T00:00:00.000Z' }]);
    const res = await call(registrationPatch as Handler, owner('PATCH', '/api/admin/registration', { membersEnabled: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ membersEnabled: true, registrationMode: 'invite' });
    const write = db.queries.find((query) => query.text.includes('ON CONFLICT (id) DO UPDATE'));
    expect(write?.values).toEqual([true, 'invite']);
  });
});

describe('邀请码管理', () => {
  it('列表只返回摘要与状态，不含原文摘要列', async () => {
    db.resolve.mockResolvedValue([{
      id: 3, code_hint: 'AB12', created_at: '2026-06-01T00:00:00.000Z', expires_at: null,
      used_at: null, revoked_at: null, used_by_username: null,
    }]);
    const res = await call(invitesGet as Handler, owner('GET', '/api/admin/invites'));
    expect(res.status).toBe(200);
    const payload = await res.json() as { invites: { status: string; codeHint: string }[] };
    expect(payload.invites[0]).toMatchObject({ status: 'active', codeHint: 'AB12' });
    expect(JSON.stringify(payload)).not.toContain('code_hash');
  });

  it('批量超过上限 → 400，不写库', async () => {
    const res = await call(invitesPost as Handler, owner('POST', '/api/admin/invites', { count: 11 }));
    expect(res.status).toBe(400);
    expect(db.queries).toHaveLength(0);
  });

  it('生成返回一次性原文，且写入的只有摘要', async () => {
    db.resolve.mockImplementation((query) => (query.text.includes('INSERT INTO registration_invites')
      ? (query.values.find((value): value is string[] => Array.isArray(value)) ?? []).map((hash) => ({ code_hash: hash, expires_at: null }))
      : []));
    const res = await call(invitesPost as Handler, owner('POST', '/api/admin/invites', { count: 2, ttlDays: null }));
    expect(res.status).toBe(201);
    const payload = await res.json() as { invites: { code: string; codeHint: string }[] };
    expect(payload.invites).toHaveLength(2);
    const insert = db.queries.find((query) => query.text.includes('INSERT INTO registration_invites'));
    // 落库参数里只有 sha256 摘要，没有任何一条等于返回给 owner 的原文。
    const stored = insert?.values.flat().filter((value): value is string => typeof value === 'string') ?? [];
    for (const invite of payload.invites) {
      expect(stored).not.toContain(invite.code);
      expect(stored).toContain(invite.codeHint);
    }
  });

  it('作废：未使用 → 200，已使用 → 409，不存在 → 404', async () => {
    db.resolve.mockResolvedValueOnce([{ id: 7 }]);
    expect((await call(inviteRevoke as Handler, owner('POST', '/api/admin/invites/7/revoke'), { id: '7' })).status).toBe(200);

    db.resolve.mockReset();
    db.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([{ used_at: '2026-06-01T00:00:00Z', revoked_at: null }]);
    const used = await call(inviteRevoke as Handler, owner('POST', '/api/admin/invites/8/revoke'), { id: '8' });
    expect(used.status).toBe(409);

    db.resolve.mockReset();
    db.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect((await call(inviteRevoke as Handler, owner('POST', '/api/admin/invites/9/revoke'), { id: '9' })).status).toBe(404);
  });
});

describe('用户管理', () => {
  it('列表不查询密码哈希或会话 token', async () => {
    db.resolve.mockResolvedValue([]);
    const res = await call(usersGet as Handler, owner('GET', '/api/admin/users'));
    expect(res.status).toBe(200);
    const sql = db.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('FROM users');
    expect(sql).not.toContain('password_hash');
    expect(sql).not.toContain('token_hash');
  });

  it('拒绝修改 owner 行（id=1）', async () => {
    const res = await call(userPatch as Handler, owner('PATCH', '/api/admin/users/1', { canFind: false }), { id: '1' });
    expect(res.status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });

  it('权限组合不满足依赖关系 → 400，不写库', async () => {
    db.resolve.mockResolvedValue([{ can_find: false, can_read: false, can_download: false }]);
    const res = await call(userPatch as Handler, owner('PATCH', '/api/admin/users/2', { canRead: true }), { id: '2' });
    expect(res.status).toBe(400);
    expect(db.queries.some((query) => query.text.includes('UPDATE users'))).toBe(false);
  });

  it('禁用与撤销会话在同一事务里', async () => {
    db.resolve
      .mockResolvedValueOnce([{ can_find: true, can_read: true, can_download: false }])
      .mockResolvedValueOnce([{
        id: 2, username: 'member', can_find: true, can_read: true, can_download: false,
        disabled_at: '2026-06-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      }])
      .mockResolvedValueOnce([]);
    const res = await call(userPatch as Handler, owner('PATCH', '/api/admin/users/2', { disabled: true }), { id: '2' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: 2, disabled: true } });
    // 同一事务里的两条语句：改权限/禁用 + 撤销该用户全部会话。
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const statements = db.queries.map((query) => query.text);
    expect(statements.some((text) => text.includes('UPDATE users') && text.includes('disabled_at = CASE WHEN'))).toBe(true);
    expect(statements.some((text) => text.includes('DELETE FROM sessions'))).toBe(true);
  });

  it('用户不存在 → 404', async () => {
    db.resolve.mockResolvedValue([]);
    const res = await call(userPatch as Handler, owner('PATCH', '/api/admin/users/9', { canFind: false }), { id: '9' });
    expect(res.status).toBe(404);
  });
});

describe('打标模型', () => {
  it('读不到覆盖值时报告未设置', async () => {
    db.resolve.mockResolvedValue([]);
    const res = await call(labelGet as Handler, owner('GET', '/api/admin/label-model'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: null, updatedAt: null });
  });

  it('非法模型名 → 400；合法 → 200；null → 清除', async () => {
    expect((await call(labelPatch as Handler, owner('PATCH', '/api/admin/label-model', { model: '坏 名字' }))).status).toBe(400);

    db.resolve.mockResolvedValue([{ label_model_updated_at: '2026-06-01T00:00:00.000Z' }]);
    const ok = await call(labelPatch as Handler, owner('PATCH', '/api/admin/label-model', { model: 'vendor/model-1' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ model: 'vendor/model-1', updatedAt: '2026-06-01T00:00:00.000Z' });

    const cleared = await call(labelPatch as Handler, owner('PATCH', '/api/admin/label-model', { model: null }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ model: null, updatedAt: null });
    expect(db.queries.some((query) => query.text.includes('label_model = NULL'))).toBe(true);
  });
});
