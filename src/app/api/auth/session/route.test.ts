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
import { NextResponse } from 'next/server';
import { ownerCredentialTag, sessionCookieOptions, type SessionRecord } from '@/lib/auth-session';

const SECRET = 'a'.repeat(48);

function memberRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    userId: 4, username: 'reader', role: 'member', canFind: true, canRead: true,
    canDownload: false, authMethod: 'password', ownerCredentialTag: null,
    membersEnabled: true, ...overrides,
  };
}

function ownerRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    userId: 1, username: 'owner', role: 'owner', canFind: true, canRead: true,
    canDownload: true, authMethod: 'owner_token',
    ownerCredentialTag: ownerCredentialTag(SECRET, 'owner-test'),
    membersEnabled: false, ...overrides,
  };
}

function sessionRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/auth/session', { headers });
}

// Set-Cookie 属性名（小写）集合，去掉值与时效相关项，用来和登录设置时比对。
function cookieAttributeShape(setCookie: string) {
  const [pair, ...attributes] = setCookie.split(';').map((part) => part.trim());
  const shape = attributes
    .map((attribute) => {
      const [key, value] = attribute.split('=');
      const name = key.toLowerCase();
      return name === 'samesite' ? `samesite=${value.toLowerCase()}` : name;
    })
    .filter((name) => name !== 'max-age' && name !== 'expires')
    .sort();
  return { name: pair.split('=')[0], shape };
}

function expectExpiredSessionCookie(res: Response, name: string) {
  const cookies = res.headers.getSetCookie();
  expect(cookies).toHaveLength(1);
  const [cleared] = cookies;
  expect(cleared.startsWith(`${name}=;`)).toBe(true);
  expect(cleared).toMatch(/;\s*Max-Age=0(;|$)/i);
  expect(cleared).not.toMatch(/domain=/i);
  // 过期时的属性必须与登录设置时完全一致，否则浏览器视为另一个 Cookie、清不掉。
  const issued = NextResponse.json({});
  issued.cookies.set(name, 'fresh-token', sessionCookieOptions(false));
  expect(cookieAttributeShape(cleared)).toEqual(cookieAttributeShape(issued.headers.getSetCookie()[0]));
}

describe('GET /api/auth/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
    vi.stubEnv('NODE_ENV', 'test');
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 0, retryAfterSeconds: 0 });
    mocks.bumpAuthRateLimit.mockResolvedValue({ attempts: 1, retryAfterSeconds: 900 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('answers {user:null} in legacy mode without touching the database', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=anything' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, accountsEnabled: false });
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('answers {user:null} for anonymous requests in account mode', async () => {
    const res = await GET(sessionRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, accountsEnabled: true });
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('returns the minimal member profile for a valid cookie', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord());
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=member-token' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      accountsEnabled: true,
      user: {
        id: 4, username: 'reader', role: 'member',
        canFind: true, canRead: true, canDownload: false, authMethod: 'session',
      },
    });
    expect(mocks.findSessionByToken).toHaveBeenCalledTimes(1);
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
    // 正文绝不含 token 或摘要。
    expect(JSON.stringify(body)).not.toContain('member-token');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('returns the owner profile for a valid owner cookie', async () => {
    mocks.findSessionByToken.mockResolvedValue(ownerRecord());
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=owner-token-value' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: 1, role: 'owner' } });
  });

  it('invalidates owner cookies from a rotated credential generation', async () => {
    mocks.findSessionByToken.mockResolvedValue(ownerRecord({
      ownerCredentialTag: ownerCredentialTag(SECRET, 'rotated-token'),
    }));
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=owner-token-value' }));
    expect(res.status).toBe(401);
    expectExpiredSessionCookie(res, 'nf-dev-session');
  });

  it('reports gated members as forbidden without clearing the still-valid cookie', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord({ membersEnabled: false }));
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=member-token' }));
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('reports unknown or expired cookies as 401 and expires only the session cookie', async () => {
    mocks.findSessionByToken.mockResolvedValue(null);
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=unknown; nf-csrf=keep-me' }));
    expect(res.status).toBe(401);
    // 状态码与正文不变：前端靠 401 判定账号模式。
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'UNAUTHORIZED' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expectExpiredSessionCookie(res, 'nf-dev-session');
  });

  it('expires the __Host- production cookie with its prefix-compatible attributes', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mocks.findSessionByToken.mockResolvedValue(null);
    const res = await GET(sessionRequest({ cookie: '__Host-nf-session=stale' }));
    expect(res.status).toBe(401);
    expect(mocks.findSessionByToken).toHaveBeenCalledWith(undefined, 'stale');
    expectExpiredSessionCookie(res, '__Host-nf-session');
  });

  it('fails closed with 503 when the session database is unavailable', async () => {
    mocks.findSessionByToken.mockRejectedValue(new Error('db down'));
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=member-token' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'AUTH_DB_UNAVAILABLE' });
    // 库故障不能证明 Cookie 失效，不清。
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('maps a correct owner header to the owner profile', async () => {
    const res = await GET(sessionRequest({ Authorization: 'Bearer owner-test' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: 1, role: 'owner', authMethod: 'owner-header' } });
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
  });

  it('rejects an explicitly wrong header even with a valid cookie', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord());
    const res = await GET(sessionRequest({
      Authorization: 'Bearer wrong',
      cookie: 'nf-dev-session=member-token',
    }));
    expect(res.status).toBe(401);
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
    // 401 是头错误，Cookie 未经检验，不清。
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('cools down owner header probing', async () => {
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 100, retryAfterSeconds: 77 });
    const res = await GET(sessionRequest({ Authorization: 'Bearer owner-test' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('77');
  });
});
