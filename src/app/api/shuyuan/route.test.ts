import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, refreshShuyuan, getShuyuanStats } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), refreshShuyuan: vi.fn(), getShuyuanStats: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema }));
vi.mock('@/lib/shuyuan', () => ({ refreshShuyuan, getShuyuanStats, disableShuyuanSource: vi.fn() }));
import { GET } from './route';

describe('cron authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('CRON_SECRET', 'cron-test');
    ensureSchema.mockResolvedValue(undefined);
    refreshShuyuan.mockResolvedValue({ total: 3 });
    getShuyuanStats.mockResolvedValue({ total: 2 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([{}, { 'User-Agent': 'vercel-cron/1.0', 'x-vercel-cron-schedule': '0 20 * * *' }] as Record<string, string>[])
    ('accepts the documented Bearer secret without a marker: %j', async (extra) => {
      const res = await GET(new NextRequest('http://localhost/api/shuyuan', { headers: { Authorization: 'Bearer cron-test', ...extra } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ total: 3 });
      expect(refreshShuyuan).toHaveBeenCalledOnce();
      expect(getShuyuanStats).not.toHaveBeenCalled();
    });

  it.each(['', 'Bearer wrong', 'Basic cron-test'])('rejects forged markers with %s', async (authorization) => {
    const res = await GET(new NextRequest('http://localhost/api/shuyuan', { headers: { Authorization: authorization, 'x-vercel-cron': '1', 'User-Agent': 'vercel-cron/1.0' } }));
    expect(res.status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });

  it('fails closed when the cron secret is absent', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(new NextRequest('http://localhost/api/shuyuan', { headers: { Authorization: 'Bearer cron-test', 'x-vercel-cron': '1' } }))).status).toBe(401);
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });

  it('keeps an owner GET read-only even if it includes a cron marker', async () => {
    const res = await GET(new NextRequest('http://localhost/api/shuyuan', { headers: { Authorization: 'Bearer owner-test', 'x-vercel-cron': '1' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 2 });
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });
});
