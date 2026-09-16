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
import { ownerCredentialTag, type SessionRecord } from '@/lib/auth-session';

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
  });

  it('answers {user:null} for anonymous requests in account mode', async () => {
    const res = await GET(sessionRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, accountsEnabled: true });
    expect(mocks.findSessionByToken).not.toHaveBeenCalled();
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
  });

  it('reports gated members as forbidden', async () => {
    mocks.findSessionByToken.mockResolvedValue(memberRecord({ membersEnabled: false }));
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=member-token' }));
    expect(res.status).toBe(403);
  });

  it('reports unknown or expired cookies as 401', async () => {
    mocks.findSessionByToken.mockResolvedValue(null);
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=unknown' }));
    expect(res.status).toBe(401);
  });

  it('fails closed with 503 when the session database is unavailable', async () => {
    mocks.findSessionByToken.mockRejectedValue(new Error('db down'));
    const res = await GET(sessionRequest({ cookie: 'nf-dev-session=member-token' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'AUTH_DB_UNAVAILABLE' });
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
  });

  it('cools down owner header probing', async () => {
    mocks.peekAuthRateLimit.mockResolvedValue({ attempts: 100, retryAfterSeconds: 77 });
    const res = await GET(sessionRequest({ Authorization: 'Bearer owner-test' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('77');
  });
});
