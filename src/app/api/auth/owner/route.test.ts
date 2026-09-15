import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  ensureAuthSchema: vi.fn(),
  createSession: vi.fn(),
  revokeSession: vi.fn(),
  cleanupExpiredAuthRows: vi.fn(),
  bumpAuthRateLimit: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getSql: mocks.getSql }));
vi.mock('@/lib/auth-session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-session')>(),
  ensureAuthSchema: mocks.ensureAuthSchema,
  createSession: mocks.createSession,
  revokeSession: mocks.revokeSession,
  cleanupExpiredAuthRows: mocks.cleanupExpiredAuthRows,
}));
vi.mock('@/lib/auth-rate-limit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-rate-limit')>(),
  bumpAuthRateLimit: mocks.bumpAuthRateLimit,
}));
vi.mock('@/lib/password', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/password')>(),
  hashPassword: mocks.hashPassword,
  verifyPassword: mocks.verifyPassword,
}));

import { POST } from './route';
import { ownerCredentialTag } from '@/lib/auth-session';

const SECRET = 'a'.repeat(48);

function exchangeRequest(body: unknown, headers: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = {
    'content-type': 'application/json',
    'x-nf-csrf': '1',
    origin: 'http://localhost',
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return new NextRequest('http://localhost/api/auth/owner', {
    method: 'POST',
    headers: merged,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = { token: 'owner-test' };

describe('POST /api/auth/owner (cookie exchange)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
    vi.stubEnv('NODE_ENV', 'test');
    mocks.getSql.mockReturnValue({});
    mocks.ensureAuthSchema.mockResolvedValue(undefined);
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 1, retryAfterSeconds: 0 });
    mocks.createSession.mockResolvedValue({ token: 'new-session-token', expiresAt: '2026-09-15 12:00:00+00' });
    mocks.revokeSession.mockResolvedValue(true);
    mocks.cleanupExpiredAuthRows.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses to serve account features while accounts are disabled', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    const res = await POST(exchangeRequest(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'ACCOUNTS_DISABLED' });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it.each([
    ['missing CSRF header', { 'x-nf-csrf': undefined }],
    ['cross-site Origin', { origin: 'https://evil.example' }],
  ])('rejects the write when %s', async (_label, headers) => {
    const res = await POST(exchangeRequest(validBody, headers));
    expect(res.status).toBe(403);
    expect(mocks.bumpAuthRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['non-JSON body', exchangeRequest(validBody, { 'content-type': 'text/plain' }), 415],
    ['oversized body', exchangeRequest({ token: 'x'.repeat(5000) }), 413],
    ['malformed JSON', exchangeRequest('{"token":'), 400],
    ['missing token', exchangeRequest({ remember: true }), 400],
    ['non-string token', exchangeRequest({ token: 42 }), 400],
    ['non-boolean remember', exchangeRequest({ token: 'owner-test', remember: 'yes' }), 400],
  ])('rejects %s', async (_label, request, expected) => {
    const res = await POST(request as never);
    expect(res.status).toBe(expected);
  });

  it('keeps the unconfigured-owner contract', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    const res = await POST(exchangeRequest(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'OWNER_NOT_CONFIGURED' });
  });

  it('requires the auth security secret for exchanges', async () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', 'short');
    const res = await POST(exchangeRequest(validBody));
    expect(res.status).toBe(503);
  });

  it('cools down even correct tokens once the budget is spent', async () => {
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 101, retryAfterSeconds: 240 });
    const res = await POST(exchangeRequest(validBody));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('240');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('rejects a wrong token without setting any cookie', async () => {
    const res = await POST(exchangeRequest({ token: 'wrong' }));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('exchanges the correct token for an owner cookie with a credential tag', async () => {
    const res = await POST(exchangeRequest({ ...validBody, remember: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      user: {
        id: 1, username: 'owner', role: 'owner',
        canFind: true, canRead: true, canDownload: true, authMethod: 'session',
      },
    });
    expect(mocks.createSession).toHaveBeenCalledWith(expect.anything(), {
      userId: 1,
      authMethod: 'owner_token',
      ownerCredentialTag: ownerCredentialTag(SECRET, 'owner-test'),
      remember: true,
    });
    const setCookie = res.headers.getSetCookie().join('; ');
    expect(setCookie).toContain('nf-dev-session=new-session-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=604800');
    // 不保存口令明文，也绝不把 APP_OWNER_TOKEN 转存为普通密码。
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('owner-test');
  });

  it('revokes the previous cookie session on a successful switch', async () => {
    const res = await POST(exchangeRequest(validBody, { cookie: 'nf-dev-session=old-token' }));
    expect(res.status).toBe(200);
    expect(mocks.revokeSession).toHaveBeenCalledWith(expect.anything(), 'old-token');
    expect(mocks.createSession).toHaveBeenCalled();
  });

  it('keeps the old state when revoking the previous session fails', async () => {
    mocks.revokeSession.mockRejectedValue(new Error('db down'));
    const res = await POST(exchangeRequest(validBody, { cookie: 'nf-dev-session=old-token' }));
    expect(res.status).toBe(503);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('fails closed when session creation or the rate limit store fails', async () => {
    mocks.createSession.mockRejectedValue(new Error('db down'));
    expect((await POST(exchangeRequest(validBody))).status).toBe(503);

    vi.clearAllMocks();
    mocks.bumpAuthRateLimit.mockRejectedValue(new Error('db down'));
    expect((await POST(exchangeRequest(validBody))).status).toBe(503);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
