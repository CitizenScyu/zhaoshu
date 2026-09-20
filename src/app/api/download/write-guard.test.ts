import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// F02 集成用例：/api/download 的 POST/DELETE 统一写守卫（能力位 + 同源固定头 + JSON 类型）。
// 身份走真实 auth 链路的两种形态：Cookie session（mock findSessionByToken）与 owner 头脚本通道。
const { ensureSchema, getSql, sql, triggerDownloadWorkflow, findSession } = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  sql: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
  triggerDownloadWorkflow: vi.fn(),
  findSession: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
vi.mock('@/lib/github', () => ({ triggerDownloadWorkflow }));
vi.mock('@/lib/auth-session', async original => ({
  ...await original<typeof import('@/lib/auth-session')>(),
  findSessionByToken: findSession,
}));

import { DELETE, POST } from './route';

const SESSION_RECORD = { userId: 7, role: 'member', canFind: true, canRead: true, canDownload: true, authMethod: 'password', membersEnabled: true };
const book = { id: 7, title: '测试书', author: '作者', source_url: 'https://book15.net/books/details7.html' };
const url = 'http://localhost/api/download';

type BrowserOptions = { csrf?: string | null; origin?: string | null; contentType?: string };

// 浏览器同源写请求：默认带 Cookie 会话、固定头、同源 Origin 与 JSON 类型，逐个选项放开以复现缺陷面。
function browserRequest(method: 'POST' | 'DELETE', body: unknown, options: BrowserOptions = {}) {
  const headers: Record<string, string> = { Cookie: 'nf-dev-session=member' };
  const csrf = options.csrf === undefined ? '1' : options.csrf;
  if (csrf !== null) headers['x-nf-csrf'] = csrf;
  const origin = options.origin === undefined ? 'http://localhost' : options.origin;
  if (origin !== null) headers.Origin = origin;
  headers['Content-Type'] = options.contentType ?? 'application/json';
  return new NextRequest(url, { method, headers, body: JSON.stringify(body) });
}

function ownerRequest(method: 'POST' | 'DELETE', body: unknown) {
  // owner 头脚本通道：显式 Bearer、无 Cookie、无 Origin。
  return new NextRequest(url, {
    method,
    headers: { Authorization: 'Bearer owner-test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/download 写守卫（F02）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    sql.mockResolvedValue([]);
    triggerDownloadWorkflow.mockResolvedValue(undefined);
    findSession.mockResolvedValue(SESSION_RECORD);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([
    ['缺 x-nf-csrf 固定头', { csrf: null }, 'CSRF_HEADER_REQUIRED'],
    ['缺 Origin', { origin: null }, 'ORIGIN_REQUIRED'],
    ['Origin: null', { origin: 'null' }, 'ORIGIN_NULL'],
    ['跨源 Origin', { origin: 'https://other.example.invalid' }, 'ORIGIN_MISMATCH'],
    ['同站不同源 Origin', { origin: 'http://localhost:3000' }, 'ORIGIN_MISMATCH'],
  ] as [string, BrowserOptions, string][])('session POST %s → 403 且未写库、未 dispatch', async (_name, options, code) => {
    const res = await POST(browserRequest('POST', { bookId: book.id }, options));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(code);
    expect(sql).not.toHaveBeenCalled();
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it('session POST Content-Type: text/plain（可跨站的 simple request）→ 415 且未写库、未 dispatch', async () => {
    const res = await POST(browserRequest('POST', { bookId: book.id }, { contentType: 'text/plain' }));
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe('JSON_REQUIRED');
    expect(sql).not.toHaveBeenCalled();
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it('session POST 合法（同源 + 固定头 + JSON）→ 201；旧 dispatch 默认关，建任务不派发', async () => {
    sql.mockResolvedValueOnce([book]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 43 }]);
    const res = await POST(browserRequest('POST', { bookId: book.id }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ taskId: 43 });
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it('owner 头脚本通道 POST（Bearer、无 Cookie、无 Origin）保持兼容 → 201，dispatch 默认关', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    sql.mockResolvedValueOnce([book]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 43 }]);
    const res = await POST(ownerRequest('POST', { bookId: book.id }));
    expect(res.status).toBe(201);
    expect(triggerDownloadWorkflow).not.toHaveBeenCalled();
  });

  it('session DELETE 缺 x-nf-csrf → 403 且未写库', async () => {
    const res = await DELETE(browserRequest('DELETE', { taskId: 42 }, { csrf: null }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CSRF_HEADER_REQUIRED');
    expect(sql).not.toHaveBeenCalled();
  });

  it('owner 头脚本通道 DELETE 保持兼容 → 200', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    sql.mockResolvedValueOnce([{ id: 42 }]);
    const res = await DELETE(ownerRequest('DELETE', { taskId: 42 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
