import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ownerRequest } from './fixtures/auth';

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

import { requireOwner, requirePermission, resolvePrincipal, verifyOwnerHeader } from './auth';
import { DEVELOPMENT_SESSION_COOKIE_NAME, ownerCredentialTag, type SessionRecord } from './auth-session';
import { OWNER_FAIL_GLOBAL_RATE_LIMIT, OWNER_FAIL_SOURCE_RATE_LIMIT } from './auth-rate-limit';

const SECRET = 'a'.repeat(48);

function memberRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    userId: 4,
    username: 'reader',
    role: 'member',
    canFind: true,
    canRead: true,
    canDownload: false,
    authMethod: 'password',
    ownerCredentialTag: null,
    membersEnabled: true,
    ...overrides,
  };
}

function ownerRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    userId: 1,
    username: 'owner',
    role: 'owner',
    canFind: true,
    canRead: true,
    canDownload: true,
    authMethod: 'owner_token',
    ownerCredentialTag: ownerCredentialTag(SECRET, 'owner-test'),
    membersEnabled: false,
    ...overrides,
  };
}

function sessionRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/profile', { headers });
}

describe('owner-header principal adapter', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [{ Authorization: 'Bearer owner-test' }],
    [{ 'x-owner-token': 'owner-test' }],
  ])('maps a valid owner header to the fixed owner principal', async (headers) => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const result = await resolvePrincipal(ownerRequest(headers));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal).toMatchObject({ userId: 1, role: 'owner', authMethod: 'owner-header' });
  });

  it.each([
    {} as Record<string, string>,
    { Authorization: 'Basic owner-test' },
    { Authorization: 'Bearer wrong' },
    { 'x-owner-token': 'wrong' },
    { Authorization: 'Bearer owner-test', 'x-owner-token': 'owner-test' },
  ])('rejects missing, malformed, wrong, or conflicting credentials', async (headers) => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const result = await resolvePrincipal(ownerRequest(headers));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('reports unavailable owner configuration explicitly', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    const result = await resolvePrincipal(ownerRequest({ Authorization: 'Bearer value' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it('allows the owner through the new permission and owner guards', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const request = ownerRequest({ Authorization: 'Bearer owner-test' });
    const permission = await requirePermission(request, 'download');
    const owner = await requireOwner(request);
    expect(permission.ok).toBe(true);
    expect(owner.ok).toBe(true);
  });

  it('does not introduce a member or session fallback in the legacy deployment mode', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const result = await requirePermission(
      ownerRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=not-implemented` }),
      'find',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
    expect(mocks.getSql).not.toHaveBeenCalled();
  });
});

describe('account-mode session principals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
    vi.stubEnv('NODE_ENV', 'test');
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 0, retryAfterSeconds: 0 });
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 1, retryAfterSeconds: 900 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('resolves a valid member cookie into its real permissions', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord());
    const result = await requirePermission(
      sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=member-token` }),
      'read',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal).toMatchObject({ userId: 4, role: 'member', authMethod: 'session', canRead: true });
    expect(mocks.findSessionByToken).toHaveBeenCalledTimes(1);
    expect(mocks.findSessionByToken.mock.calls[0][1]).toBe('member-token');
  });

  it('rejects members entirely while the members gate is closed', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord({ membersEnabled: false }));
    for (const permission of ['find', 'read', 'download'] as const) {
      const result = await requirePermission(
        sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=member-token` }),
        permission,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }
  });

  it('rejects unknown, expired, disabled, or deleted sessions', async () => {
    mocks.findSessionByToken.mockResolvedValue(null);
    const result = await resolvePrincipal(
      sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=unknown` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('keeps an owner cookie valid only for the current credential generation', async () => {
    mocks.findSessionByToken.mockResolvedValue(ownerRecord());
    const valid = await resolvePrincipal(
      sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=owner-token-value` }),
    );
    expect(valid.ok).toBe(true);

    mocks.findSessionByToken.mockResolvedValue(ownerRecord({ ownerCredentialTag: ownerCredentialTag(SECRET, 'rotated') }));
    const rotated = await resolvePrincipal(
      sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=owner-token-value` }),
    );
    expect(rotated.ok).toBe(false);
    if (!rotated.ok) expect(rotated.response.status).toBe(401);
  });

  it('invalidates owner cookies when the owner token or secret is unconfigured', async () => {
    mocks.findSessionByToken.mockResolvedValue(ownerRecord());
    vi.stubEnv('APP_OWNER_TOKEN', '');
    const noToken = await resolvePrincipal(
      sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=owner-token-value` }),
    );
    expect(noToken.ok).toBe(false);
    if (!noToken.ok) expect(noToken.response.status).toBe(401);

    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('AUTH_SECURITY_SECRET', 'too-short');
    const noSecret = await resolvePrincipal(
      sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=owner-token-value` }),
    );
    expect(noSecret.ok).toBe(false);
    if (!noSecret.ok) expect(noSecret.response.status).toBe(401);
  });

  it('never falls back to the cookie identity when an explicit header is wrong', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord());
    const result = await resolvePrincipal(sessionRequest({
      Authorization: 'Bearer wrong',
      Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=member-token`,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the session database is unavailable', async () => {
    mocks.findSessionByToken.mockRejectedValue(new Error('db down'));
    const result = await resolvePrincipal(
      sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=member-token` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.json()).toMatchObject({ code: 'AUTH_DB_UNAVAILABLE' });
    }
  });

  it('queries the database only once per request across multiple guards', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord());
    const req = sessionRequest({ Cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=member-token` });
    await requirePermission(req, 'find');
    await requirePermission(req, 'read');
    await requireOwner(req);
    expect(mocks.findSessionByToken).toHaveBeenCalledTimes(1);
  });

  it('denies requests without any cookie', async () => {
    const result = await resolvePrincipal(sessionRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
  });
});

describe('account-mode owner-header failure budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('verifies a correct owner header under the threshold without counting it', async () => {
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 0, retryAfterSeconds: 0 });
    const result = await verifyOwnerHeader(ownerRequest({ Authorization: 'Bearer owner-test' }));
    expect(result.ok).toBe(true);
    expect(mocks.peekAuthRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.bumpAuthRateLimit).not.toHaveBeenCalled();
  });

  it('cools down even correct tokens once the failure threshold is reached', async () => {
    mocks.peekAuthRateLimit.mockResolvedValueOnce({ attempts: OWNER_FAIL_SOURCE_RATE_LIMIT.limit, retryAfterSeconds: 300 })
      .mockResolvedValueOnce({ attempts: 0, retryAfterSeconds: 0 });
    const result = await verifyOwnerHeader(ownerRequest({ Authorization: 'Bearer owner-test' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get('Retry-After')).toBe('300');
    }
  });

  it('records a wrong owner header into the source bucket, and into the global bucket only when the source budget is exhausted', async () => {
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 0, retryAfterSeconds: 0 });
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 1, retryAfterSeconds: 900 });
    const result = await verifyOwnerHeader(ownerRequest({ Authorization: 'Bearer wrong' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    // 单来源桶未达上限时只 bump 单来源桶，全局桶不动——单个来源无法独力打满全局桶。
    expect(mocks.bumpAuthRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.bumpAuthRateLimit.mock.calls[0][1].scope).toBe(OWNER_FAIL_SOURCE_RATE_LIMIT.scope);
  });

  it('counts one global bump when the source budget is exhausted, not one per request', async () => {
    const limit = OWNER_FAIL_SOURCE_RATE_LIMIT.limit;
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 0, retryAfterSeconds: 0 });
    // 每次 bump 让单来源桶计数 +1，第 limit 次正好把单来源桶推到上限。
    for (let i = 1; i <= limit; i++) {
      mocks.bumpAuthRateLimit.mockResolvedValueOnce({ attempts: i, retryAfterSeconds: 900 });
    }

    for (let request = 0; request < limit; request++) {
      const result = await verifyOwnerHeader(ownerRequest({ Authorization: 'Bearer wrong' }));
      expect(result.ok).toBe(false);
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

  it('fails closed when the rate limit store is unavailable', async () => {
    mocks.peekAuthRateLimit.mockRejectedValue(new Error('db down'));
    const result = await verifyOwnerHeader(ownerRequest({ Authorization: 'Bearer owner-test' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.json()).toMatchObject({ code: 'AUTH_RATE_LIMIT_UNAVAILABLE' });
    }
  });

  it('requires a valid auth security secret in account mode', async () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', 'short');
    const result = await verifyOwnerHeader(ownerRequest({ Authorization: 'Bearer owner-test' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.json()).toMatchObject({ code: 'AUTH_SECURITY_SECRET_REQUIRED' });
    }
  });
});
