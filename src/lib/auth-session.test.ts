import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  initializeAuthSchema: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getSql: mocks.getSql }));
vi.mock('@/lib/auth-store', () => ({
  AUTH_SCHEMA_VERSION: 2,
  initializeAuthSchema: mocks.initializeAuthSchema,
}));

import {
  DEFAULT_SESSION_TTL_SECONDS,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  MAX_SESSIONS_PER_USER,
  PRODUCTION_SESSION_COOKIE_NAME,
  REMEMBER_SESSION_TTL_SECONDS,
  cleanupExpiredAuthRows,
  clearedSessionCookieOptions,
  createSession,
  findSessionByToken,
  generateSessionToken,
  getAuthSecuritySecret,
  getSessionCookieName,
  getSessionTokenFromRequest,
  hashSessionToken,
  ownerCredentialTag,
  revokeSession,
  sessionCookieOptions,
} from './auth-session';

type Recorded = { text: string; values: unknown[] };

function fakeSql() {
  const calls: Recorded[] = [];
  const queued: unknown[][] = [];
  const txBatches: { results: unknown[][] }[] = [];
  const makeTag = (sink: { results: unknown[][] }) =>
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ''), '');
      calls.push({ text, values });
      return sink.results.length > 0 ? sink.results.shift() : [];
    };
  const top = { results: queued };
  const sql = Object.assign(makeTag(top), {
    transaction: async (builder: (tx: never) => unknown[]) => {
      const batch = txBatches.length > 0 ? txBatches.shift()! : { results: [] as unknown[][] };
      return await Promise.all(builder(makeTag(batch) as never));
    },
  });
  return { sql, calls, queued, txBatches };
}

describe('session tokens and cookie contract', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('generates 32-byte random tokens and stores only their SHA-256 digest', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toBe(token);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('uses the __Host- production cookie name and a separate development name', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getSessionCookieName()).toBe(PRODUCTION_SESSION_COOKIE_NAME);
    expect(PRODUCTION_SESSION_COOKIE_NAME).toBe('__Host-nf-session');
    vi.stubEnv('NODE_ENV', 'test');
    expect(getSessionCookieName()).toBe(DEVELOPMENT_SESSION_COOKIE_NAME);
    expect(DEVELOPMENT_SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(false);
  });

  it('sets HttpOnly, Secure, SameSite=Lax, Path=/ and never a Domain', () => {
    const options = sessionCookieOptions(false);
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect('domain' in options && options.domain !== undefined).toBe(false);
    expect('maxAge' in options).toBe(false);

    const remembered = sessionCookieOptions(true);
    expect(remembered.maxAge).toBe(REMEMBER_SESSION_TTL_SECONDS);
    expect(REMEMBER_SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(DEFAULT_SESSION_TTL_SECONDS).toBe(12 * 60 * 60);

    expect(clearedSessionCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  });

  it('reads only the active session cookie from a request', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const req = new NextRequest('http://localhost/api/auth/session', {
      headers: { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=abc; other=x` },
    });
    expect(getSessionTokenFromRequest(req)).toBe('abc');
    expect(getSessionTokenFromRequest(new NextRequest('http://localhost/api/auth/session'))).toBeNull();
  });
});

describe('auth security secret and owner credential tag', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rejects missing or too-short secrets', () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', '');
    expect(getAuthSecuritySecret()).toBeNull();
    vi.stubEnv('AUTH_SECURITY_SECRET', 'short');
    expect(getAuthSecuritySecret()).toBeNull();
    vi.stubEnv('AUTH_SECURITY_SECRET', 'a'.repeat(31));
    expect(getAuthSecuritySecret()).toBeNull();
    vi.stubEnv('AUTH_SECURITY_SECRET', 'a'.repeat(32));
    expect(getAuthSecuritySecret()).toBe('a'.repeat(32));
  });

  it('tags owner sessions per secret and token generation', () => {
    const secret = 's'.repeat(32);
    const tag = ownerCredentialTag(secret, 'owner-token');
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerCredentialTag(secret, 'owner-token')).toBe(tag);
    expect(ownerCredentialTag(secret, 'rotated-token')).not.toBe(tag);
    expect(ownerCredentialTag('t'.repeat(32), 'owner-token')).not.toBe(tag);
  });
});

describe('session store operations', () => {
  it('creates a session under a per-user lock and enforces the 5-session cap', async () => {
    const fake = fakeSql();
    fake.txBatches.push({ results: [[], [{ expires_at: '2026-09-15 12:00:00+00' }], []] });
    const created = await createSession(fake.sql as never, {
      userId: 7,
      authMethod: 'password',
      ownerCredentialTag: null,
      remember: false,
    });
    const text = fake.calls.map((call) => call.text).join('\n');
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.expiresAt).toBe('2026-09-15 12:00:00+00');
    expect(text).toContain('pg_advisory_xact_lock(18521403');
    expect(text).toContain('INSERT INTO sessions');
    expect(text).toContain('* interval');
    expect(text).toContain('OFFSET');
    // 新会话本身永不被裁剪。
    expect(text).toContain('token_hash <>');
    const insert = fake.calls.find((call) => call.text.includes('INSERT INTO sessions'))!;
    expect(insert.values).toContain(DEFAULT_SESSION_TTL_SECONDS);
    const capDelete = fake.calls.find((call) => call.text.includes('DELETE FROM sessions'))!;
    expect(capDelete.values).toContain(MAX_SESSIONS_PER_USER);
    expect(insert.values).toContain(hashSessionToken(created.token));
    expect(insert.values).toContain(7);
    expect(insert.values).toContain('password');
  });

  it('extends to the 7-day remember lifetime', async () => {
    const fake = fakeSql();
    fake.txBatches.push({ results: [[], [{ expires_at: 'later' }], []] });
    await createSession(fake.sql as never, { userId: 2, authMethod: 'owner_token', ownerCredentialTag: 'f'.repeat(64), remember: true });
    const insert = fake.calls.find((call) => call.text.includes('INSERT INTO sessions'))!;
    expect(insert.values).toContain(REMEMBER_SESSION_TTL_SECONDS);
    expect(insert.values).toContain('f'.repeat(64));
    expect(insert.values).toContain('owner_token');
  });

  it('fails loudly when the session insert does not return an expiry', async () => {
    const fake = fakeSql();
    fake.txBatches.push({ results: [[], [], []] });
    await expect(createSession(fake.sql as never, { userId: 3, authMethod: 'password', remember: false }))
      .rejects.toThrow('no expiry');
  });

  it('reads session, user, and gate settings in a single joined query', async () => {
    const fake = fakeSql();
    fake.queued.push([{
      user_id: 4, username: 'reader', role: 'member', can_find: true, can_read: true,
      can_download: false, auth_method: 'password', owner_credential_tag: null, members_enabled: true,
    }]);
    const record = await findSessionByToken(fake.sql as never, 'token-value');
    const query = fake.calls[0];
    expect(query.text).toContain('JOIN users u ON u.id = s.user_id');
    expect(query.text).toContain('CROSS JOIN auth_settings m');
    expect(query.text).toContain('s.expires_at > now()');
    expect(query.text).toContain('u.disabled_at IS NULL');
    expect(query.values[0]).toBe(hashSessionToken('token-value'));
    expect(record).toEqual({
      userId: 4, username: 'reader', role: 'member', canFind: true, canRead: true,
      canDownload: false, authMethod: 'password', ownerCredentialTag: null, membersEnabled: true,
    });
  });

  it('returns null for unknown or expired sessions', async () => {
    const fake = fakeSql();
    fake.queued.push([]);
    expect(await findSessionByToken(fake.sql as never, 'missing')).toBeNull();
  });

  it('revokes by digest and reports whether a row was deleted', async () => {
    const fake = fakeSql();
    fake.queued.push([{ token_hash: hashSessionToken('token-value') }]);
    expect(await revokeSession(fake.sql as never, 'token-value')).toBe(true);
    expect(fake.calls[0].text).toContain('DELETE FROM sessions');
    expect(fake.calls[0].values[0]).toBe(hashSessionToken('token-value'));

    fake.queued.push([]);
    expect(await revokeSession(fake.sql as never, 'token-value')).toBe(false);
  });

  it('cleans up expired rows with bounded deletes', async () => {
    const fake = fakeSql();
    await cleanupExpiredAuthRows(fake.sql as never);
    const text = fake.calls.map((call) => call.text).join('\n');
    expect(text).toContain('DELETE FROM sessions');
    expect(text).toContain('DELETE FROM auth_rate_limits');
    expect((text.match(/LIMIT 100/g) ?? []).length).toBe(2);
  });
});

describe('lazy auth schema initialization', () => {
  beforeEach(() => {
    // authSchemaPromise 是模块级状态；每个用例重载模块，避免跨用例缓存泄漏。
    vi.resetModules();
    mocks.initializeAuthSchema.mockReset();
    mocks.getSql.mockReset();
    mocks.initializeAuthSchema.mockResolvedValue(undefined);
    mocks.getSql.mockReturnValue({});
  });

  it('shares one initialization promise across concurrent callers', async () => {
    const { ensureAuthSchema: fresh } = await import('./auth-session');
    await Promise.all([fresh(), fresh(), fresh()]);
    expect(mocks.initializeAuthSchema).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed initialization instead of caching the failure', async () => {
    mocks.initializeAuthSchema.mockRejectedValueOnce(new Error('db down'));
    const { ensureAuthSchema: fresh } = await import('./auth-session');
    await expect(fresh()).rejects.toThrow('db down');
    await fresh();
    expect(mocks.initializeAuthSchema).toHaveBeenCalledTimes(2);
  });
});
