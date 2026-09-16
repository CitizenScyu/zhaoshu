/// <reference types="vite/client" />
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import ts from 'typescript';

const mocks = vi.hoisted(() => ({ ensureSchema: vi.fn(), getSql: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/db', async (original) => ({ ...await original<typeof import('@/lib/db')>(), ensureSchema: mocks.ensureSchema, getSql: mocks.getSql }));

// 显式枚举 HTTP 导出；新增路由或方法必须同时声明权限，不能悄悄变成匿名入口。
// auth-entry 仅表示认证流程可接收匿名请求，其 CSRF/凭据/限速由各自用例验证。
const policies: Record<string, Record<string, 'find' | 'read' | 'download' | 'owner' | 'legacy-owner' | 'auth-entry'>> = {
  'admin/llm': { GET: 'owner', PATCH: 'owner' },
  'auth/login': { POST: 'auth-entry' }, 'auth/logout': { POST: 'auth-entry' },
  'auth/owner': { POST: 'auth-entry' }, 'auth/session': { GET: 'auth-entry' },
  download: { GET: 'download', POST: 'download', DELETE: 'download' },
  'download/[id]/file': { GET: 'download' }, export: { GET: 'find' },
  feedback: { GET: 'find', POST: 'find' }, find: { POST: 'find' },
  library: { GET: 'find' }, owner: { GET: 'legacy-owner' },
  profile: { GET: 'find', PUT: 'find', POST: 'find' },
  'read/[id]/[resource]': { GET: 'read' }, 'read/source/[resource]': { GET: 'read' },
  recommendations: { GET: 'find' },
  shelf: { POST: 'find', DELETE: 'find' }, shuyuan: { GET: 'download', POST: 'download' },
  stats: { GET: 'find' },
};
const loaders = import.meta.glob('../app/api/**/route.ts');
const sourceLoaders = import.meta.glob('../app/api/**/route.ts', { query: '?raw', import: 'default' });
const methodNames = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

describe('API 权限清单', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false'); vi.stubEnv('APP_OWNER_TOKEN', 'route-manifest-owner');
    mocks.getSql.mockImplementation(() => { throw new Error('anonymous request accessed database'); });
    mocks.ensureSchema.mockRejectedValue(new Error('anonymous request initialized schema'));
    mocks.fetch.mockRejectedValue(new Error('anonymous request made an external call'));
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it('所有路由及 HTTP 导出都在清单内', async () => {
    const discovered: Record<string, string[]> = {};
    for (const [file, load] of Object.entries(sourceLoaders)) {
      const route = file.replace('../app/api/', '').replace('/route.ts', '');
      const source = ts.createSourceFile(file, await load() as string, ts.ScriptTarget.Latest, true);
      const names: string[] = [];
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
          expect(statement.exportClause && ts.isNamedExports(statement.exportClause)).toBeTruthy();
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) names.push(...statement.exportClause.elements.map((item) => item.name.text));
        }
        if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
        if (ts.isVariableStatement(statement)) {
          for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name)) names.push(item.name.text);
        }
      }
      discovered[route] = names.filter((name) => methodNames.has(name)).sort();
    }
    expect(discovered).toEqual(Object.fromEntries(Object.entries(policies).map(([route, methods]) => [route, Object.keys(methods).sort()])));
  });
  for (const [route, methods] of Object.entries(policies)) {
    for (const [method, policy] of Object.entries(methods)) {
      if (policy === 'auth-entry') continue;
      it(`${method} /api/${route} (${policy}) 在业务读写和外部副作用前拒绝匿名`, async () => {
        const routeModule = await loaders[`../app/api/${route}/route.ts`]() as Record<string, (req: NextRequest, ctx: unknown) => Promise<Response>>;
        const req = new NextRequest(`http://localhost/api/${route}`, {
          method, headers: { 'Content-Type': 'application/json' },
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: '{}' }),
        });
        const response = await routeModule[method](req, { params: Promise.resolve({ id: '1', resource: 'manifest' }) });
        expect(response.status).toBe(401);
        expect(mocks.getSql).not.toHaveBeenCalled(); expect(mocks.ensureSchema).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
        if (policy === 'find' || policy === 'read' || policy === 'download') {
          expect(response.headers.get('Cache-Control')).toBe('private, no-store');
          expect(response.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
        }
      });
    }
  }
});
