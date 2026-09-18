import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// F02 集成用例：/api/shuyuan POST 的统一写守卫。刷新/打失效/重新启用都属于写操作，
// 必须与 /api/download 同样过「同源固定头 + JSON 类型」；owner 头脚本通道保持兼容。
const { ensureSchema, getSql, refreshShuyuan, getShuyuanStats, disableShuyuanSource, enableShuyuanSource, findSession } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), refreshShuyuan: vi.fn(), getShuyuanStats: vi.fn(),
  disableShuyuanSource: vi.fn(), enableShuyuanSource: vi.fn(), findSession: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
vi.mock('@/lib/shuyuan', () => ({ refreshShuyuan, getShuyuanStats, disableShuyuanSource, enableShuyuanSource }));
vi.mock('@/lib/auth-session', async original => ({
  ...await original<typeof import('@/lib/auth-session')>(),
  findSessionByToken: findSession,
}));

import { POST } from './route';

const SESSION_RECORD = { userId: 7, role: 'member', canFind: true, canRead: true, canDownload: true, authMethod: 'password', membersEnabled: true };
const url = 'http://localhost/api/shuyuan';

type BrowserOptions = { csrf?: string | null; origin?: string | null; contentType?: string };

function browserRequest(body: unknown, options: BrowserOptions = {}) {
  const headers: Record<string, string> = { Cookie: 'nf-dev-session=member' };
  const csrf = options.csrf === undefined ? '1' : options.csrf;
  if (csrf !== null) headers['x-nf-csrf'] = csrf;
  const origin = options.origin === undefined ? 'http://localhost' : options.origin;
  if (origin !== null) headers.Origin = origin;
  headers['Content-Type'] = options.contentType ?? 'application/json';
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

function ownerRequest(body: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner-test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/shuyuan 写守卫（F02）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    ensureSchema.mockResolvedValue(undefined);
    refreshShuyuan.mockResolvedValue({ total: 3 });
    getShuyuanStats.mockResolvedValue({ total: 2 });
    disableShuyuanSource.mockResolvedValue(true);
    enableShuyuanSource.mockResolvedValue(true);
    findSession.mockResolvedValue(SESSION_RECORD);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([
    ['缺 x-nf-csrf 固定头', { csrf: null }, 'CSRF_HEADER_REQUIRED'],
    ['缺 Origin', { origin: null }, 'ORIGIN_REQUIRED'],
    ['Origin: null', { origin: 'null' }, 'ORIGIN_NULL'],
    ['跨源 Origin', { origin: 'https://other.example.invalid' }, 'ORIGIN_MISMATCH'],
    ['同站不同源 Origin', { origin: 'http://localhost:3000' }, 'ORIGIN_MISMATCH'],
  ] as [string, BrowserOptions, string][])('session POST %s → 403 且未写库、未刷新', async (_name, options, code) => {
    const res = await POST(browserRequest({ action: 'disable', url: 'https://unknown.invalid' }, options));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(code);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(disableShuyuanSource).not.toHaveBeenCalled();
    expect(refreshShuyuan).not.toHaveBeenCalled();
  });

  it('session POST Content-Type: text/plain → 415 且未写库、未刷新', async () => {
    const res = await POST(browserRequest({ action: 'disable', url: 'https://unknown.invalid' }, { contentType: 'text/plain' }));
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe('JSON_REQUIRED');
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(disableShuyuanSource).not.toHaveBeenCalled();
  });

  it('session POST 合法（同源 + 固定头 + JSON）→ 200 并写库一次', async () => {
    const res = await POST(browserRequest({ action: 'disable', url: 'https://unknown.invalid' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: true });
    expect(disableShuyuanSource).toHaveBeenCalledWith('https://unknown.invalid', '');
  });

  it('owner 头脚本通道 POST（Bearer、无 Cookie、无 Origin）保持兼容 → 200', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    const res = await POST(ownerRequest({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 3 });
    expect(refreshShuyuan).toHaveBeenCalledOnce();
  });
});
