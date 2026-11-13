import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { mockSql, type RecordedQuery } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  require: vi.fn(),
  revalidate: vi.fn(),
  rateBump: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema: mocks.ensureSchema, getSql: mocks.getSql }));
vi.mock('@/lib/auth', async (original) => {
  const actual = await original<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requirePermission: mocks.require,
    revalidatePermission: mocks.revalidate,
  };
});
vi.mock('@/lib/auth-rate-limit', async (original) => {
  const actual = await original<typeof import('@/lib/auth-rate-limit')>();
  return { ...actual, bumpAuthRateLimit: mocks.rateBump };
});
import { POST } from './route';

let db: ReturnType<typeof mockSql>;
let sql: ReturnType<typeof mockSql>['resolve'];

const OWNER = { userId: 1, role: 'owner', canFind: true, canRead: true, canDownload: true, authMethod: 'owner-header' };

function request(body: unknown) {
  return new NextRequest('http://localhost/api/find/exact/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer finddl-exact-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 主 CTE 的返回形态按 SELECT 列名路由到不同断言。
function importOutcome(rows: Record<string, unknown>[]) {
  sql.mockImplementation((query) => {
    if (query.text.includes('INSERT INTO labeled_books')) return rows;
    return [];
  });
}

// 授权围栏 = 事务里的 DO 块（set_config 行也含 nf.write_authorization 字样，用
// current_setting 区分，只有围栏块读它）。
function fenceIndexes(queries: RecordedQuery[]): number[] {
  return queries
    .map((q, i) => (q.text.includes("current_setting('nf.write_authorization')") ? i : -1))
    .filter((i) => i >= 0);
}

describe('POST /api/find/exact/download', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'finddl-exact-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    vi.stubEnv('AUTH_SECURITY_SECRET', 's'.repeat(40));
    db = mockSql();
    sql = db.resolve;
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getSql.mockReturnValue(db.sql);
    mocks.require.mockResolvedValue({ ok: true, principal: OWNER });
    mocks.revalidate.mockResolvedValue({ ok: true, principal: OWNER });
    mocks.rateBump.mockResolvedValue({ attempts: 1, retryAfterSeconds: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before accessing data', async () => {
    mocks.require.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) });
    const res = await POST(request({ title: '诡秘之主' }));
    expect(res.status).toBe(401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects a principal without canDownload before any DB access', async () => {
    mocks.require.mockResolvedValue({ ok: true, principal: { ...OWNER, canDownload: false } });
    const res = await POST(request({ title: '诡秘之主' }));
    expect(res.status).toBe(403);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.rateBump).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '   ', 42])('rejects a missing title %j without writing', async (title) => {
    const res = await POST(request({ title, author: '爱潜水的乌贼' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing title', code: 'MISSING_TITLE' });
    expect(mocks.rateBump).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([42, { long: true }, 'x'.repeat(201)])('rejects an invalid author %j without writing', async (author) => {
    const res = await POST(request({ title: '诡秘之主', author }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid author', code: 'INVALID_AUTHOR' });
    expect(mocks.rateBump).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rate-limits over-quota requests with 429 + Retry-After, without writing', async () => {
    mocks.rateBump.mockResolvedValue({ attempts: 11, retryAfterSeconds: 1800 });
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 1800 });
    expect(res.headers.get('Retry-After')).toBe('1800');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('creates the labeled book row and a system task inside the authorization fence', async () => {
    importOutcome([{ labeled_book_id: 4242, created_task_id: 9001, existing_task_id: null, artifact_book_id: null }]);
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, bookId: 4242, taskId: 9001, taskOutcome: 'created' });
    const queries = db.queries as RecordedQuery[];
    // 授权围栏在写语句前后各一次（blocker 1 回归断言）：主 CTE 必须被夹在中间。
    const fences = fenceIndexes(queries);
    expect(fences.length).toBeGreaterThanOrEqual(2);
    const insert = queries.find((q) => q.text.includes('INSERT INTO labeled_books'));
    expect(insert).toBeDefined();
    expect(fences[0]).toBeLessThan(queries.indexOf(insert!));
    expect(fences[fences.length - 1]).toBeGreaterThan(queries.indexOf(insert!));
    // 围栏按本次写事务的能力位验 download：set_config 传入的授权 JSON 里 permission
    // 必须是 'download'（fence 的 CASE 文本按它分支），不能只是 fence 文本碰巧含词。
    const config = queries.find((q) => q.text.includes('set_config') && q.values.some((v) => typeof v === 'string' && v.includes('"permission":"download"')));
    expect(config).toBeDefined();
    // 一条语句里既有书库 UPSERT 也有 download_tasks 插入（原子性）。
    expect(insert!.text).toContain('INSERT INTO download_tasks');
    expect(insert!.text).toContain("'system'");
    // 已有书的行不做字段覆盖（blocker 2 回归断言）：DO UPDATE SET 只允许 no-op，
    // 打标字段绝不能来自 EXCLUDED。
    expect(insert!.text).not.toContain('EXCLUDED.labels');
    expect(insert!.text).not.toContain('EXCLUDED.finish_status');
    expect(insert!.text).not.toContain('EXCLUDED.source_url');
    // source_revision 标记找书直下批次；enqueue_key 传 NULL（失败终态后可重试）。
    expect(insert!.values).toContain('finddl-1113');
    expect(insert!.values).toContain(null);
  });

  it('existing active task resolves to existing, no second insert', async () => {
    importOutcome([{ labeled_book_id: 4242, created_task_id: null, existing_task_id: 8800, artifact_book_id: null }]);
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, bookId: 4242, taskOutcome: 'existing', taskId: 8800 });
  });

  it('already-published artifact resolves to artifact_exists', async () => {
    importOutcome([{ labeled_book_id: 555, created_task_id: null, existing_task_id: null, artifact_book_id: 555 }]);
    const res = await POST(request({ title: '已出版书', author: '某人' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, bookId: 555, taskOutcome: 'artifact_exists', taskId: null });
  });

  it('missing author falls back to 佚名, not rejected', async () => {
    importOutcome([{ labeled_book_id: 7, created_task_id: 8, existing_task_id: null, artifact_book_id: null }]);
    const res = await POST(request({ title: '无名书' }));
    expect(res.status).toBe(201);
    const insert = (db.queries as RecordedQuery[]).find((q) => q.text.includes('INSERT INTO labeled_books'));
    expect(insert!.values).toContain('佚名');
  });

  it('unresolvable outcome maps to 500 without leaking internals', async () => {
    importOutcome([{ labeled_book_id: 4242, created_task_id: null, existing_task_id: null, artifact_book_id: null }]);
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
  });

  it('maps a DB error to 500 without leaking internals', async () => {
    sql.mockRejectedValue(new Error('connection refused'));
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
  });
});
