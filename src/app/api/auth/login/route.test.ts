import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  // 模板入参只用于类型标注，调用与取值都走 mock.calls / mockResolvedValue。
  sql: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    void parts;
    void values;
    return [];
  }),
  ensureAuthSchema: vi.fn(),
  createSession: vi.fn(),
  revokeSession: vi.fn(),
  cleanupExpiredAuthRows: vi.fn(),
  bumpAuthRateLimit: vi.fn(),
  verifyPassword: vi.fn(),
  runDummyKdf: vi.fn(),
  hashPassword: vi.fn(),
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
  verifyPassword: mocks.verifyPassword,
  runDummyKdf: mocks.runDummyKdf,
  hashPassword: mocks.hashPassword,
}));

import { POST } from './route';

const SECRET = 'a'.repeat(48);

function loginRequest(body: unknown, headers: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = {
    'content-type': 'application/json',
    'x-nf-csrf': '1',
    origin: 'http://localhost',
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: merged,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const memberRow = {
  id: 4,
  username: 'reader',
  role: 'member',
  password_hash: 'scrypt$1$131072$8$1$AAAA$AAAA',
  disabled_at: null,
  can_find: true,
  can_read: true,
  can_download: false,
};

const validBody = { username: 'reader', password: 'a-valid-passphrase-123' };

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
    vi.stubEnv('NODE_ENV', 'test');
    mocks.getSql.mockReturnValue(mocks.sql);
    mocks.ensureAuthSchema.mockResolvedValue(undefined);
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 1, retryAfterSeconds: 0 });
    mocks.sql.mockResolvedValue([]);
    mocks.verifyPassword.mockResolvedValue(false);
    mocks.runDummyKdf.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue({ token: 'session-token', expiresAt: '2026-09-15 12:00:00+00' });
    mocks.cleanupExpiredAuthRows.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses to serve account features while accounts are disabled', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'ACCOUNTS_DISABLED' });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it.each([
    ['missing CSRF header', { 'x-nf-csrf': undefined }],
    ['missing Origin', { origin: undefined }],
    ['null Origin', { origin: 'null' }],
    ['cross-site Origin', { origin: 'https://evil.example' }],
  ])('rejects the write when %s', async (_label, headers) => {
    const res = await POST(loginRequest(validBody, headers));
    expect(res.status).toBe(403);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('accepts only JSON bodies', async () => {
    const res = await POST(loginRequest(validBody, { 'content-type': 'application/x-www-form-urlencoded' }));
    expect(res.status).toBe(415);
  });

  it('caps the request body at 4 KiB', async () => {
    const res = await POST(loginRequest({ username: 'reader', password: 'x'.repeat(5000) }));
    expect(res.status).toBe(413);
    expect(mocks.bumpAuthRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{"username":'],
    ['non-string password', { username: 'reader', password: 42 }],
    ['non-boolean remember', { username: 'reader', password: 'x'.repeat(20), remember: 'yes' }],
  ])('rejects %s', async (_label, body) => {
    const res = await POST(loginRequest(body));
    expect(res.status).toBe(400);
  });

  it.each(['AB', '1reader', 'a b', '书迷', 'x'])('rejects malformed username %s', async (username) => {
    const res = await POST(loginRequest({ username, password: 'a-valid-passphrase-123' }));
    expect(res.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('rejects out-of-bounds passwords before any KDF', async () => {
    const res = await POST(loginRequest({ username: 'reader', password: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
    expect(mocks.bumpAuthRateLimit).not.toHaveBeenCalled();
    expect(mocks.runDummyKdf).not.toHaveBeenCalled();
  });

  it('normalizes the username before lookup and key derivation', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockResolvedValue(true);
    const res = await POST(loginRequest({ username: '  Reader ', password: 'a-valid-passphrase-123' }));
    expect(res.status).toBe(200);
    expect(mocks.sql.mock.calls[0][1]).toBe('reader');
  });

  it('rejects logins when the auth security secret is unconfigured', async () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', 'short');
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(503);
  });

  it('rate limits before running any KDF', async () => {
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 21, retryAfterSeconds: 321 });
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('321');
    expect(mocks.runDummyKdf).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('consumes all three buckets before verification', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockResolvedValue(true);
    await POST(loginRequest(validBody));
    expect(mocks.bumpAuthRateLimit).toHaveBeenCalledTimes(3);
    expect(mocks.bumpAuthRateLimit.mock.invocationCallOrder[0]).toBeLessThan(mocks.verifyPassword.mock.invocationCallOrder[0]);
  });

  it('fails closed when the rate limit store is unavailable', async () => {
    mocks.bumpAuthRateLimit.mockRejectedValue(new Error('db down'));
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(503);
    expect(mocks.runDummyKdf).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown user', []],
    ['disabled user', [{ ...memberRow, disabled_at: '2026-09-01 00:00:00+00' }]],
    ['owner row without a password hash', [{ ...memberRow, id: 1, username: 'owner', role: 'owner', password_hash: null }]],
  ])('answers %s with a dummy KDF and the generic error', async (_label, rows) => {
    mocks.sql.mockResolvedValue(rows);
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid username or password', code: 'INVALID_CREDENTIALS' });
    expect(mocks.runDummyKdf).toHaveBeenCalledTimes(1);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('does not leak user existence through differing error bodies', async () => {
    mocks.sql.mockResolvedValue([]);
    const unknown = await POST(loginRequest(validBody));
    mocks.sql.mockResolvedValue([memberRow]);
    const wrongPassword = await POST(loginRequest({ ...validBody, password: 'wrong-passphrase-456' }));
    expect(unknown.status).toBe(wrongPassword.status);
    expect(await unknown.json()).toEqual(await wrongPassword.json());
  });

  it('does not touch existing sessions when the password is wrong', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    const res = await POST(loginRequest({ ...validBody, password: 'wrong-passphrase-456' }, {
      cookie: 'nf-dev-session=existing-token',
    }));
    expect(res.status).toBe(401);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it('logs a member in and sets a correctly scoped session cookie', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockResolvedValue(true);
    const res = await POST(loginRequest({ ...validBody, remember: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      user: {
        id: 4, username: 'reader', role: 'member',
        canFind: true, canRead: true, canDownload: false, authMethod: 'session',
      },
    });
    expect(mocks.createSession).toHaveBeenCalledWith(expect.anything(), {
      userId: 4, authMethod: 'password', remember: true,
    });
    const setCookie = res.headers.getSetCookie().join('; ');
    expect(setCookie).toContain('nf-dev-session=session-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).not.toContain('Domain=');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
    // 响应正文绝不含 session token。
    expect(JSON.stringify(body)).not.toContain('session-token');
  });

  it('omits Max-Age when remember is not requested', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockResolvedValue(true);
    const res = await POST(loginRequest(validBody));
    expect(res.headers.getSetCookie().join('; ')).not.toContain('Max-Age');
  });

  it('never stores the shared owner token as a password hash', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockResolvedValue(true);
    await POST(loginRequest(validBody));
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when schema initialization fails', async () => {
    mocks.ensureAuthSchema.mockRejectedValue(new Error('db down'));
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('fails closed with 503 when the user lookup fails', async () => {
    mocks.sql.mockRejectedValue(new Error('db down'));
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('fails closed with 503 when session creation fails', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.createSession.mockRejectedValue(new Error('db down'));
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('fails closed when the KDF itself errors', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockRejectedValue(new Error('scrypt failure'));
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(503);
  });

  it('tolerates best-effort cleanup failures after a successful login', async () => {
    mocks.sql.mockResolvedValue([memberRow]);
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.cleanupExpiredAuthRows.mockRejectedValue(new Error('cleanup failed'));
    const res = await POST(loginRequest(validBody));
    expect(res.status).toBe(200);
  });
});
