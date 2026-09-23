import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  findSessionByToken: vi.fn(),
  peekAuthRateLimit: vi.fn(),
  bumpAuthRateLimit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getSql: mocks.getSql }));
vi.mock('@/lib/auth-session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-session')>(),
  findSessionByToken: mocks.findSessionByToken,
}));
vi.mock('@/lib/auth-rate-limit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-rate-limit')>(),
  peekAuthRateLimit: mocks.peekAuthRateLimit,
  bumpAuthRateLimit: mocks.bumpAuthRateLimit,
}));

import { GET } from './route';
import { OWNER_FAIL_GLOBAL_RATE_LIMIT, OWNER_FAIL_SOURCE_RATE_LIMIT } from '@/lib/auth-rate-limit';

const SECRET = 'a'.repeat(48);

describe('GET /api/owner', () => {
  beforeEach(() => vi.stubEnv('APP_OWNER_TOKEN', 'owner-test'));
  afterEach(() => vi.unstubAllEnvs());

  it.each(['', 'wrong'])('rejects invalid draft %s', async (token) => {
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(res.status).toBe(401);
  });

  it('validates a token without depending on database configuration', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it.each(['', 'false'])('keeps the A01 owner draft contract in deployment mode %s', async (enabled) => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', enabled);
    vi.stubEnv('AUTH_SECURITY_SECRET', '');
    vi.stubEnv('DATABASE_URL', '');
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it('fails closed in account mode when the auth security secret is unconfigured', async () => {
    // A02 起 AUTH_ACCOUNTS_ENABLED=true 的草稿验证进入共享失败预算，需要安全 secret；
    // 缺 secret 时失败关闭，但不触碰数据库。旧模式（上面两档）不受影响。
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('AUTH_SECURITY_SECRET', '');
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'AUTH_SECURITY_SECRET_REQUIRED' });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it('does not turn a rejected draft into a replacement credential', async () => {
    const rejected = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer wrong' },
    }));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('set-cookie')).toBeNull();

    const current = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(current.status).toBe(200);
  });

  it('fails closed when owner authentication is unconfigured', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    expect((await GET(new NextRequest('http://localhost/api/owner'))).status).toBe(503);
  });
});

describe('GET /api/owner in account mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
    mocks.getSql.mockReturnValue({});
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 0, retryAfterSeconds: 0 });
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 1, retryAfterSeconds: 900 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('validates a correct draft under the shared failure budget', async () => {
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.peekAuthRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.bumpAuthRateLimit).not.toHaveBeenCalled();
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });

  it('records a wrong draft into the source bucket only (MS-27: global bucket is touched only when a single source exhausts its own budget)', async () => {
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer wrong' },
    }));
    expect(res.status).toBe(401);
    // 单来源桶未达上限时只 bump 单来源桶，全局桶不动——单一来源无法独力打满
    // 全局桶锁死全站 owner 认证。
    expect(mocks.bumpAuthRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.bumpAuthRateLimit.mock.calls[0][1].scope).toBe(OWNER_FAIL_SOURCE_RATE_LIMIT.scope);
  });

  it('counts one global bump only when the source budget is exhausted, so many sources still trip the global lock (distributed brute force)', async () => {
    // 单来源上限 10：把第 10 次 bump 的返回值推到上限，那一次才向全局桶贡献 1 次。
    const limit = OWNER_FAIL_SOURCE_RATE_LIMIT.limit;
    mocks.bumpAuthRateLimit.mockResolvedValueOnce({ attempts: 1, retryAfterSeconds: 900 });
    for (let i = 2; i <= limit; i++) {
      mocks.bumpAuthRateLimit.mockResolvedValueOnce({ attempts: i, retryAfterSeconds: 900 });
    }
    for (let request = 0; request < limit; request++) {
      const res = await GET(new NextRequest('http://localhost/api/owner', {
        headers: { Authorization: 'Bearer wrong' },
      }));
      expect(res.status).toBe(401);
    }
    const sourceBumps = mocks.bumpAuthRateLimit.mock.calls.filter(
      (call) => call[1].scope === OWNER_FAIL_SOURCE_RATE_LIMIT.scope,
    );
    const globalBumps = mocks.bumpAuthRateLimit.mock.calls.filter(
      (call) => call[1].scope === OWNER_FAIL_GLOBAL_RATE_LIMIT.scope,
    );
    expect(sourceBumps).toHaveLength(limit);
    // 只有达到上限的那一次向全局桶贡献 1 次——单来源狂发无法把全局桶从 0 打到 100。
    expect(globalBumps).toHaveLength(1);
  });

  it('cools down even a correct draft once the threshold is reached', async () => {
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 10, retryAfterSeconds: 480 });
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('480');
    expect(mocks.bumpAuthRateLimit).not.toHaveBeenCalled();
  });

  it('fails closed when the rate limit store is unavailable', async () => {
    mocks.peekAuthRateLimit.mockRejectedValue(new Error('db down'));
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'AUTH_RATE_LIMIT_UNAVAILABLE' });
  });

  it('never validates a draft via an existing session cookie', async () => {
    // 有效 Cookie + 错误草稿：仍按显式口令拒绝。
    const wrongDraft = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer wrong', cookie: 'nf-dev-session=some-session' },
    }));
    expect(wrongDraft.status).toBe(401);
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();

    // 有效 Cookie、无草稿：不能借 Cookie 通过草稿验证。
    const noDraft = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { cookie: 'nf-dev-session=some-session' },
    }));
    expect(noDraft.status).toBe(401);
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
  });

  it('keeps the unconfigured-owner contract in account mode', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(503);
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it('requires the auth security secret to enter the shared budget', async () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', 'short');
    const res = await GET(new NextRequest('http://localhost/api/owner', {
      headers: { Authorization: 'Bearer owner-test' },
    }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'AUTH_SECURITY_SECRET_REQUIRED' });
  });
});
