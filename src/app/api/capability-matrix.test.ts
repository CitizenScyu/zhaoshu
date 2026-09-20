import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

// 设计 §8.2「能力矩阵」：owner / find-only / find+read / find+read+download 逐一直接
// 调用 §5.2 的每个方法。这里只判定鉴权层的授受关系，业务结果由各路由自身用例覆盖。
const mocks = vi.hoisted(() => ({ ensureSchema: vi.fn(), getSql: vi.fn(), session: vi.fn() }));

vi.mock('@/lib/db', async (original) => ({
  ...await original<typeof import('@/lib/db')>(),
  ensureSchema: mocks.ensureSchema,
  getSql: mocks.getSql,
}));
vi.mock('@/lib/auth-session', async (original) => ({
  ...await original<typeof import('@/lib/auth-session')>(),
  findSessionByToken: mocks.session,
}));
vi.mock('@/lib/github', () => ({ triggerDownloadWorkflow: vi.fn() }));
vi.mock('@/lib/shuyuan', () => ({
  refreshShuyuan: vi.fn().mockResolvedValue({ total: 0 }),
  getShuyuanStats: vi.fn().mockResolvedValue({ total: 0 }),
  disableShuyuanSource: vi.fn().mockResolvedValue(true),
  enableShuyuanSource: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/reader-server', async (original) => ({
  ...await original<typeof import('@/lib/reader-server')>(),
  getReadableTask: vi.fn().mockResolvedValue({ id: 1, title: '书', author: '作者', status: 'done' }),
  readBookIndex: vi.fn().mockResolvedValue({ chapters: [] }),
  readBookPart: vi.fn().mockResolvedValue({ text: '' }),
  readerAvailability: vi.fn().mockResolvedValue({ available: true }),
}));
vi.mock('@/lib/source-reader', async (original) => ({
  ...await original<typeof import('@/lib/source-reader')>(),
  resolveSourceBook: vi.fn().mockResolvedValue({ chapters: [] }),
  saveSourceCatalog: vi.fn().mockResolvedValue(undefined),
  sourceReaderIndex: vi.fn().mockResolvedValue({ chapters: [] }),
  readSourceChapter: vi.fn().mockResolvedValue({ text: '' }),
}));

import { GET as downloadStatsGet } from '@/app/api/admin/download-stats/route';
import { GET as libraryGet } from '@/app/api/library/route';
import { GET as ownerGet } from '@/app/api/owner/route';
import { GET as profileGet, PUT as profilePut, POST as profilePost } from '@/app/api/profile/route';
import { POST as findPost } from '@/app/api/find/route';
import { GET as recommendationsGet } from '@/app/api/recommendations/route';
import { POST as shelfPost, DELETE as shelfDelete } from '@/app/api/shelf/route';
import { DELETE as shelfUnprocessedDelete } from '@/app/api/shelf/unprocessed/route';
import { GET as feedbackGet, POST as feedbackPost } from '@/app/api/feedback/route';
import { GET as statsGet } from '@/app/api/stats/route';
import { GET as exportGet } from '@/app/api/export/route';
import { GET as readGet } from '@/app/api/read/[id]/[resource]/route';
import { GET as sourceReadGet } from '@/app/api/read/source/[resource]/route';
import { GET as downloadGet, POST as downloadPost, DELETE as downloadDelete } from '@/app/api/download/route';
import { GET as downloadFileGet } from '@/app/api/download/[id]/file/route';
import { GET as shuyuanGet, POST as shuyuanPost } from '@/app/api/shuyuan/route';

type Capability = 'find' | 'read' | 'download' | 'owner-only';
type IdentityName = 'anonymous' | 'findOnly' | 'reader' | 'downloader' | 'owner';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const CAPABILITIES: Record<IdentityName, Capability[]> = {
  anonymous: [],
  findOnly: ['find'],
  reader: ['find', 'read'],
  downloader: ['find', 'read', 'download'],
  owner: ['find', 'read', 'download', 'owner-only'],
};

const MEMBER: Record<'findOnly' | 'reader' | 'downloader', Record<string, unknown>> = {
  findOnly: { userId: 2, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true },
  reader: { userId: 3, role: 'member', canFind: true, canRead: true, canDownload: false, authMethod: 'password', membersEnabled: true },
  downloader: { userId: 4, role: 'member', canFind: true, canRead: true, canDownload: true, authMethod: 'password', membersEnabled: true },
};

// §5.2 接口表的每一行受保护方法。path 用具体的动态参数，params 同步给出。
// memberDenial：owner-only 路由对已认证成员的拒绝码。/api/owner 只验显式口令头，
// Cookie 会话连认证形态都不匹配 → 401；admin 读接口走 requireOwner（接受会话身份，
// 成员是「已认证但非 owner」）→ 403。不标则沿用 owner-only 默认 401。
const ROUTES: { name: string; path: string; method: string; handler: Handler; params?: Record<string, string>; requires: Capability; memberDenial?: 401 | 403 }[] = [
  { name: 'GET /api/profile', path: '/api/profile', method: 'GET', handler: profileGet as Handler, requires: 'find' },
  { name: 'PUT /api/profile', path: '/api/profile', method: 'PUT', handler: profilePut as Handler, requires: 'find' },
  { name: 'POST /api/profile', path: '/api/profile', method: 'POST', handler: profilePost as Handler, requires: 'find' },
  { name: 'POST /api/find', path: '/api/find', method: 'POST', handler: findPost as Handler, requires: 'find' },
  { name: 'GET /api/recommendations', path: '/api/recommendations', method: 'GET', handler: recommendationsGet as Handler, requires: 'find' },
  { name: 'POST /api/shelf', path: '/api/shelf', method: 'POST', handler: shelfPost as Handler, requires: 'find' },
  { name: 'DELETE /api/shelf', path: '/api/shelf', method: 'DELETE', handler: shelfDelete as Handler, requires: 'find' },
  // task-65 新增：书架未处理堆的批量清理。不在设计 §5.2 原表内，但同样由
  // withFindAccess 保护，因此一并纳入矩阵，避免它在鉴权上成为未验证的旁路。
  { name: 'DELETE /api/shelf/unprocessed', path: '/api/shelf/unprocessed', method: 'DELETE', handler: shelfUnprocessedDelete as Handler, requires: 'find' },
  { name: 'GET /api/feedback', path: '/api/feedback', method: 'GET', handler: feedbackGet as Handler, requires: 'find' },
  { name: 'POST /api/feedback', path: '/api/feedback', method: 'POST', handler: feedbackPost as Handler, requires: 'find' },
  { name: 'GET /api/library', path: '/api/library', method: 'GET', handler: libraryGet as Handler, requires: 'find' },
  { name: 'GET /api/stats', path: '/api/stats', method: 'GET', handler: statsGet as Handler, requires: 'find' },
  { name: 'GET /api/export', path: '/api/export', method: 'GET', handler: exportGet as Handler, requires: 'find' },
  { name: 'GET /api/read/[id]/[resource]', path: '/api/read/1/index', method: 'GET', handler: readGet as Handler, params: { id: '1', resource: 'index' }, requires: 'read' },
  { name: 'GET /api/read/source/[resource]', path: '/api/read/source/index?title=书&author=作者', method: 'GET', handler: sourceReadGet as Handler, params: { resource: 'index' }, requires: 'read' },
  { name: 'GET /api/download', path: '/api/download', method: 'GET', handler: downloadGet as Handler, requires: 'download' },
  { name: 'POST /api/download', path: '/api/download', method: 'POST', handler: downloadPost as Handler, requires: 'download' },
  { name: 'DELETE /api/download', path: '/api/download', method: 'DELETE', handler: downloadDelete as Handler, requires: 'download' },
  { name: 'GET /api/download/[id]/file', path: '/api/download/1/file', method: 'GET', handler: downloadFileGet as Handler, params: { id: '1' }, requires: 'download' },
  { name: 'GET /api/shuyuan', path: '/api/shuyuan', method: 'GET', handler: shuyuanGet as Handler, requires: 'download' },
  { name: 'POST /api/shuyuan', path: '/api/shuyuan', method: 'POST', handler: shuyuanPost as Handler, requires: 'download' },
  { name: 'GET /api/admin/download-stats', path: '/api/admin/download-stats', method: 'GET', handler: downloadStatsGet as Handler, requires: 'owner-only', memberDenial: 403 },
  { name: 'GET /api/owner', path: '/api/owner', method: 'GET', handler: ownerGet as Handler, requires: 'owner-only' },
];

let db: ReturnType<typeof mockSql>;

function call(route: (typeof ROUTES)[number], identity: IdentityName) {
  vi.stubEnv('AUTH_ACCOUNTS_ENABLED', identity === 'owner' ? 'false' : 'true');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (identity === 'owner') headers['X-Owner-Token'] = 'matrix-owner-token';
  else if (identity !== 'anonymous') headers.Cookie = 'nf-dev-session=member';
  // 浏览器写请求必须带固定头与严格同源头（§2.4）；否则拿到的是 CSRF 403 而不是能力判定。
  if (!['GET', 'HEAD'].includes(route.method) && identity !== 'anonymous') {
    headers['x-nf-csrf'] = '1';
    headers.Origin = 'http://localhost';
  }
  const req = new NextRequest('http://localhost' + route.path, {
    method: route.method,
    headers,
    ...(['GET', 'HEAD'].includes(route.method) ? {} : { body: '{}' }),
  });
  return route.handler(req, { params: Promise.resolve(route.params ?? {}) });
}

function isAllowed(requires: Capability, identity: IdentityName): boolean {
  return CAPABILITIES[identity].includes(requires);
}

describe('§5.2 能力矩阵：逐一直接调用受保护方法', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db = mockSql();
    mocks.getSql.mockReturnValue(db.sql);
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.session.mockResolvedValue(null);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_OWNER_TOKEN', 'matrix-owner-token');
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('ZHAOSHU_BOOKS_REPO', 'test-owner/test-books');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('未声明网络请求'); }));
    // 被 mock 掉的下游会让业务层打日志；这些用例只判定鉴权授受关系。
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  for (const route of ROUTES) {
    for (const identity of ['anonymous', 'findOnly', 'reader', 'downloader', 'owner'] as IdentityName[]) {
      const allowed = isAllowed(route.requires, identity);
      // owner-only 方法对成员也只是一次失败的旧口令验证：401，不是 403；
      // 但 requireOwner 守卫的 admin 路由接受会话身份、按角色判 403（admin-console 同款）。
      // 匿名身份始终先死于 401（无凭据，不进入角色判定）。
      const denial = identity === 'anonymous' ? 401
        : route.requires === 'owner-only' ? route.memberDenial ?? 401
        : 403;
      const expected = allowed ? '不被鉴权层拒绝' : String(denial);
      it(`${route.name} × ${identity} → ${expected}`, async () => {
        if (identity !== 'anonymous' && identity !== 'owner') {
          mocks.session.mockResolvedValue(MEMBER[identity]);
        }
        const res = await call(route, identity);
        if (allowed) {
          expect(res.status).not.toBe(401);
          expect(res.status).not.toBe(403);
        } else {
          expect(res.status).toBe(denial);
        }
      });
    }
  }

  it('覆盖 §5.2 表里全部受保护方法', () => {
    expect(ROUTES.map((route) => route.name)).toEqual([
      'GET /api/profile', 'PUT /api/profile', 'POST /api/profile', 'POST /api/find',
      'GET /api/recommendations', 'POST /api/shelf', 'DELETE /api/shelf',
      'DELETE /api/shelf/unprocessed',
      'GET /api/feedback', 'POST /api/feedback', 'GET /api/library', 'GET /api/stats', 'GET /api/export',
      'GET /api/read/[id]/[resource]', 'GET /api/read/source/[resource]',
      'GET /api/download', 'POST /api/download', 'DELETE /api/download', 'GET /api/download/[id]/file',
      'GET /api/shuyuan', 'POST /api/shuyuan',
      // T6 新增：管理员只读的下载漏斗聚合（requireOwner，非 §5.2 原表，同 §5.2 方式纳入）。
      'GET /api/admin/download-stats',
      'GET /api/owner',
    ]);
  });
});
