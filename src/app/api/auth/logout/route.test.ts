import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  ensureAuthSchema: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getSql: mocks.getSql }));
vi.mock('@/lib/auth-session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-session')>(),
  ensureAuthSchema: mocks.ensureAuthSchema,
  revokeSession: mocks.revokeSession,
}));

import { POST } from './route';

function logoutRequest(headers: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = { 'x-nf-csrf': '1', origin: 'http://localhost' };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return new NextRequest('http://localhost/api/auth/logout', { method: 'POST', headers: merged });
}

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    mocks.getSql.mockReturnValue({});
    mocks.ensureAuthSchema.mockResolvedValue(undefined);
    mocks.revokeSession.mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses to serve account features while accounts are disabled', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    const res = await POST(logoutRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'ACCOUNTS_DISABLED' });
  });

  it('rejects writes without the CSRF header or a same-origin Origin', async () => {
    expect((await POST(logoutRequest({ 'x-nf-csrf': undefined }))).status).toBe(403);
    expect((await POST(logoutRequest({ origin: 'https://evil.example' }))).status).toBe(403);
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it('is idempotent without a cookie and never touches the database', async () => {
    const res = await POST(logoutRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie().join('; ')).toContain('nf-dev-session=');
    expect(res.headers.getSetCookie().join('; ')).toContain('Max-Age=0');
  });

  it('revokes the server-side row and clears the cookie', async () => {
    const res = await POST(logoutRequest({ cookie: 'nf-dev-session=session-token' }));
    expect(res.status).toBe(200);
    expect(mocks.revokeSession).toHaveBeenCalledWith(expect.anything(), 'session-token');
    const setCookie = res.headers.getSetCookie().join('; ');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
  });

  it('stays idempotent when the cookie points at an already-revoked session', async () => {
    mocks.revokeSession.mockResolvedValue(false);
    const res = await POST(logoutRequest({ cookie: 'nf-dev-session=session-token' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reports an incomplete logout and keeps the cookie when the database fails', async () => {
    mocks.revokeSession.mockRejectedValue(new Error('db down'));
    const res = await POST(logoutRequest({ cookie: 'nf-dev-session=session-token' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'LOGOUT_INCOMPLETE' });
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('reports an incomplete logout when schema initialization fails', async () => {
    mocks.ensureAuthSchema.mockRejectedValue(new Error('db down'));
    const res = await POST(logoutRequest({ cookie: 'nf-dev-session=session-token' }));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});
