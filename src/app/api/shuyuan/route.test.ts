import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, refreshShuyuan, getShuyuanStats, disableShuyuanSource } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), refreshShuyuan: vi.fn(), getShuyuanStats: vi.fn(), disableShuyuanSource: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema }));
vi.mock('@/lib/shuyuan', () => ({ refreshShuyuan, getShuyuanStats, disableShuyuanSource }));
import { GET, POST } from './route';

describe('cron authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('CRON_SECRET', 'cron-test');
    ensureSchema.mockResolvedValue(undefined);
    refreshShuyuan.mockResolvedValue({ total: 3 });
    getShuyuanStats.mockResolvedValue({ total: 2 });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('未声明网络请求'); }));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

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

  it('GET 返回未知、禁用、失败与待核验状态，查询本身不触发探测', async () => {
    const payload = {
      total: 2, enabled: 1, disabled: 1, active: 0, unprobed: 1, pending: 1, reachable: 0, failed: 0,
      collections: [], refreshedAt: null, sourcesLimit: 100,
      sources: [
        { url: 'https://unknown.invalid', name: '未知源', disabled: true, availability: 'unprobed', lastError: '历史失败', checkedAt: null, probeError: null },
        { url: 'https://changed.invalid', name: '规则已变', disabled: false, availability: 'pending', lastError: '规则失效', checkedAt: null, probeError: null },
      ],
    };
    getShuyuanStats.mockResolvedValueOnce(payload);
    const req = new NextRequest('http://localhost/api/shuyuan', { headers: { Authorization: 'Bearer owner-test' } });
    const res = await GET(req);
    expect(await res.json()).toEqual(payload);
    expect(getShuyuanStats).toHaveBeenCalledWith(req.signal);
    expect(refreshShuyuan).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('手动刷新向共享预算传递请求取消信号', async () => {
    const req = new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST', headers: { Authorization: 'Bearer owner-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    });
    expect((await POST(req)).status).toBe(200);
    expect(refreshShuyuan).toHaveBeenCalledWith(req.signal);
  });

  it('cron 服务身份只允许既有 GET 刷新，不能用 POST 修改禁用状态', async () => {
    const res = await POST(new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST', headers: { Authorization: 'Bearer cron-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disable', url: 'https://unknown.invalid' }),
    }));
    expect(res.status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(disableShuyuanSource).not.toHaveBeenCalled();
  });

  it('禁用未知 URL 仅调用元数据更新，不隐式探测该 URL', async () => {
    disableShuyuanSource.mockResolvedValueOnce(true);
    const res = await POST(new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST', headers: { Authorization: 'Bearer owner-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disable', url: 'https://unknown.invalid' }),
    }));
    expect(await res.json()).toEqual({ disabled: true });
    expect(disableShuyuanSource).toHaveBeenCalledWith('https://unknown.invalid', '');
    expect(fetch).not.toHaveBeenCalled();
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });
});
