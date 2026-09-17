import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, refreshShuyuan, getShuyuanStats, disableShuyuanSource, enableShuyuanSource, session } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), refreshShuyuan: vi.fn(), getShuyuanStats: vi.fn(), disableShuyuanSource: vi.fn(), enableShuyuanSource: vi.fn(), session: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
vi.mock('@/lib/shuyuan', () => ({ refreshShuyuan, getShuyuanStats, disableShuyuanSource, enableShuyuanSource }));
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: session }));
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

  // 启用与禁用同权限、同入参形状，只差一个布尔结果字段名（enabled / disabled）。
  it('重新启用与禁用对称：只调元数据更新，不隐式探测也不触发刷新', async () => {
    enableShuyuanSource.mockResolvedValueOnce(true);
    const res = await POST(new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST', headers: { Authorization: 'Bearer owner-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enable', url: 'https://unknown.invalid' }),
    }));
    expect(await res.json()).toEqual({ enabled: true });
    expect(enableShuyuanSource).toHaveBeenCalledWith('https://unknown.invalid');
    expect(disableShuyuanSource).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });

  it('enable 缺少 url 时 400，不落库', async () => {
    const res = await POST(new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST', headers: { Authorization: 'Bearer owner-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enable' }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing url' });
    expect(enableShuyuanSource).not.toHaveBeenCalled();
  });

  // URL 不在库里返回 200 + enabled:false，而不是 404：404 会把「这个源还在不在合集里」变成可探测信号。
  it('启用不在库里的 URL 返回 enabled:false 而非 404', async () => {
    enableShuyuanSource.mockResolvedValueOnce(false);
    const res = await POST(new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST', headers: { Authorization: 'Bearer owner-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enable', url: 'https://gone.invalid' }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it('GET 的筛选与页码先归一化再交给统计层', async () => {
    const filtered = new NextRequest('http://localhost/api/shuyuan?filter=failed&page=3', {
      headers: { Authorization: 'Bearer owner-test' },
    });
    await GET(filtered);
    expect(getShuyuanStats).toHaveBeenCalledWith(filtered.signal, { filter: 'failed', page: 3 });

    // 非白名单筛选与非数字页码必须在下游被夹住，不能让原始值进到 SQL 谓词里。
    const forged = new NextRequest('http://localhost/api/shuyuan?filter=DROP%20TABLE&page=-4', {
      headers: { Authorization: 'Bearer owner-test' },
    });
    await GET(forged);
    expect(getShuyuanStats).toHaveBeenLastCalledWith(forged.signal, { filter: 'all', page: 1 });
  });

  it('不带 filter 的 GET 保持旧的直调形状，不附加分页元信息', async () => {
    const req = new NextRequest('http://localhost/api/shuyuan', { headers: { Authorization: 'Bearer owner-test' } });
    await GET(req);
    expect(getShuyuanStats).toHaveBeenCalledWith(req.signal);
    expect(getShuyuanStats).toHaveBeenCalledOnce();
  });
});

// 设计 §5.2 第 404/405 行：交互式 GET 与 POST（refresh / disable）都是 download 能力。
describe('书源能力边界（§5.2）', () => {
  const DOWNLOADER = { userId: 2, role: 'member', canFind: true, canRead: true, canDownload: true, authMethod: 'password', membersEnabled: true };
  const READER = { userId: 3, role: 'member', canFind: true, canRead: true, canDownload: false, authMethod: 'password', membersEnabled: true };
  const FIND_ONLY = { userId: 4, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    vi.stubEnv('CRON_SECRET', 'cron-test');
    ensureSchema.mockResolvedValue(undefined);
    refreshShuyuan.mockResolvedValue({ total: 3 });
    getShuyuanStats.mockResolvedValue({ total: 2 });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('未声明网络请求'); }));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  const memberGet = () => GET(new NextRequest('http://localhost/api/shuyuan', { headers: { Cookie: 'nf-dev-session=member' } }));
  const memberPost = (body: unknown) => POST(new NextRequest('http://localhost/api/shuyuan', {
    method: 'POST', headers: { Cookie: 'nf-dev-session=member', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

  it('有 download 能力的成员可以看统计，且不触发刷新', async () => {
    session.mockResolvedValue(DOWNLOADER);
    const res = await memberGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 2 });
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });

  it('有 download 能力的成员可以 refresh、disable 和 enable', async () => {
    session.mockResolvedValue(DOWNLOADER);
    expect((await memberPost({})).status).toBe(200);
    expect(refreshShuyuan).toHaveBeenCalledOnce();
    disableShuyuanSource.mockResolvedValueOnce(true);
    const disabled = await memberPost({ action: 'disable', url: 'https://unknown.invalid' });
    expect(await disabled.json()).toEqual({ disabled: true });
    expect(disableShuyuanSource).toHaveBeenCalledWith('https://unknown.invalid', '');
    enableShuyuanSource.mockResolvedValueOnce(true);
    const enabled = await memberPost({ action: 'enable', url: 'https://unknown.invalid' });
    expect(await enabled.json()).toEqual({ enabled: true });
    expect(enableShuyuanSource).toHaveBeenCalledWith('https://unknown.invalid');
  });

  it.each([READER, FIND_ONLY])('只有 read 或 find 的成员拿到 403，且不触发刷新 %#', async (record) => {
    session.mockResolvedValue(record);
    const get = await memberGet();
    expect(get.status).toBe(403);
    expect(get.headers.get('Cache-Control')).toBe('private, no-store');
    expect(get.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
    expect(refreshShuyuan).not.toHaveBeenCalled();
    expect((await memberPost({})).status).toBe(403);
    expect(refreshShuyuan).not.toHaveBeenCalled();
    // enable 不能被当作比 disable 更弱的操作绕过能力判定。
    expect((await memberPost({ action: 'enable', url: 'https://unknown.invalid' })).status).toBe(403);
    expect(enableShuyuanSource).not.toHaveBeenCalled();
    expect(disableShuyuanSource).not.toHaveBeenCalled();
  });

  it('匿名 POST 在 DDL 与刷新之前拒绝，并带私有缓存头', async () => {
    const res = await POST(new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });

  it('成员 Cookie 不会因为带上 cron 标记就获得刷新权', async () => {
    session.mockResolvedValue(DOWNLOADER);
    const res = await GET(new NextRequest('http://localhost/api/shuyuan', {
      headers: { Cookie: 'nf-dev-session=member', 'x-vercel-cron': '1', 'User-Agent': 'vercel-cron/1.0' },
    }));
    expect(res.status).toBe(200);
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });
});
