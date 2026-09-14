import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

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
  });

  it('fails closed when owner authentication is unconfigured', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    expect((await GET(new NextRequest('http://localhost/api/owner'))).status).toBe(503);
  });
});
