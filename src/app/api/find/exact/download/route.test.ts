import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql, type RecordedQuery } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ ensureSchema: vi.fn(), getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: mocks.ensureSchema, getSql: mocks.getSql }));
import { POST } from './route';

let db: ReturnType<typeof mockSql>;
let sql: ReturnType<typeof mockSql>['resolve'];

function request(body: unknown) {
  return new NextRequest('http://localhost/api/find/exact/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer finddl-exact-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// importer 的 UPSERT 主语句：识别「INSERT INTO labeled_books」即返回落库+任务行。
function importOutcome(rows: Record<string, unknown>[]) {
  sql.mockImplementation((query) => {
    if (query.text.includes('INSERT INTO labeled_books')) return rows;
    return [];
  });
}

describe('POST /api/find/exact/download', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'finddl-exact-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    db = mockSql();
    sql = db.resolve;
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getSql.mockReturnValue(db.sql);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before accessing data', async () => {
    const req = request({ title: '诡秘之主' });
    req.headers.delete('Authorization');
    expect((await POST(req)).status).toBe(401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '   ', 42])('rejects a missing title %j without writing', async (title) => {
    const res = await POST(request({ title, author: '爱潜水的乌贼' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing title', code: 'MISSING_TITLE' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([42, { long: true }, 'x'.repeat(201)])('rejects an invalid author %j without writing', async (author) => {
    const res = await POST(request({ title: '诡秘之主', author }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid author', code: 'INVALID_AUTHOR' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('creates the labeled book row and a system task in one statement', async () => {
    importOutcome([{ labeled_book_id: 4242, created_task_count: 1, created_task_id: 9001 }]);
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true, bookId: 4242, taskId: 9001, taskOutcome: 'created',
    });
    const queries = db.queries as RecordedQuery[];
    const insert = queries.find((q) => q.text.includes('INSERT INTO labeled_books'));
    expect(insert).toBeDefined();
    // 一条语句里既有书库 UPSERT 也有 download_tasks 插入（importLabelWithSystemTask 的原子性）。
    expect(insert!.text).toContain('INSERT INTO download_tasks');
    expect(insert!.text).toContain("'system'");
    // 入队种子 URL 是 builtin host 占位，不是用户可控字符串。
    expect(insert!.values).toContain('https://book15.net/');
    // source_revision 标记找书直下批次，幂等键含它。
    expect(insert!.values).toContain('finddl-1113');
  });

  it('missing author falls back to 佚名, not rejected', async () => {
    importOutcome([{ labeled_book_id: 7, created_task_count: 1, created_task_id: 8 }]);
    const res = await POST(request({ title: '无名书' }));
    expect(res.status).toBe(201);
    const insert = (db.queries as RecordedQuery[]).find((q) => q.text.includes('INSERT INTO labeled_books'));
    expect(insert!.values).toContain('佚名');
  });

  it('existing active task returns the same task without a second insert', async () => {
    importOutcome([{ labeled_book_id: 4242, created_task_count: 0, created_task_id: null }]);
    const find = sql.mockImplementation((query) => {
      if (query.text.includes('INSERT INTO labeled_books')) {
        return [{ labeled_book_id: 4242, created_task_count: 0, created_task_id: null }];
      }
      // findSystemTaskByEnqueueKey / findActiveSystemTask 的 SELECT id FROM download_tasks
      if (query.text.includes('FROM download_tasks')) return [{ id: 8800 }];
      return [];
    });
    void find;
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, bookId: 4242, taskOutcome: 'existing', taskId: 8800 });
  });

  it('maps a DB error to 500 without leaking internals', async () => {
    sql.mockRejectedValue(new Error('connection refused'));
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
  });
});
