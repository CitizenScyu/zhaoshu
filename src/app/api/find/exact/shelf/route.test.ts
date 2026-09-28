import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql, type RecordedQuery } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ ensureSchema: vi.fn(), getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: mocks.ensureSchema, getSql: mocks.getSql }));
import { POST } from './route';

let db: ReturnType<typeof mockSql>;
let sql: ReturnType<typeof mockSql>['resolve'];

function request(body: unknown) {
  return new NextRequest('http://localhost/api/find/exact/shelf', {
    method: 'POST',
    headers: { Authorization: 'Bearer shelf-exact-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/find/exact/shelf', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'shelf-exact-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    db = mockSql();
    sql = db.resolve;
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getSql.mockReturnValue(db.sql);
    sql.mockImplementation((query) => (query.text.includes('INSERT INTO recommendations') ? [{ book_id: 42 }] : []));
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

  // author 输入边界（authval42）：非字符串或超长不再静默改成佚名（会错挂身份键、
  // books 落错行），而是 400 零查询零写入。200 字符仍是合法上限。
  it.each([
    ['非字符串数字', 42],
    ['201 字符串', 'a'.repeat(201)],
  ])('rejects invalid author (%s) with zero queries and zero writes', async (_label, author) => {
    const res = await POST(request({ title: '诡秘之主', author }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid author', code: 'INVALID_AUTHOR' });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('accepts an author of exactly 200 characters', async () => {
    const res = await POST(request({ title: '诡秘之主', author: 'a'.repeat(200) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bookId: 42 });
  });

  it.each([undefined, null, '', '   '])('falls back to 佚名 for a missing author %j', async (author) => {
    const res = await POST(request({ title: '诡秘之主', author }));
    expect(res.status).toBe(200);
    const insertBook = db.queries.find((query: RecordedQuery) => query.text.includes('INSERT INTO books'));
    // F09：展示列存原始拼写；空/缺失作者按既有口径走佚名兜底。
    expect(insertBook?.values).toContain('佚名');
  });

  // 豆瓣候选没有 labeled_books 行（这正是不能复用 /api/shelf 的原因），
  // 所以这里断言走的是通用 (title, author) 写入路径，且身份归一在 user-data 里做。
  it('adds a douban-found book to the shelf through the shared identity path', async () => {
    const res = await POST(request({ title: '《诡秘之主》', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bookId: 42 });

    const insertBook = db.queries.find((query: RecordedQuery) => query.text.includes('INSERT INTO books'));
    // F09：展示列存原始拼写；归一值只出现在 recommendations 的比较参数里。
    expect(insertBook?.values).toContain('《诡秘之主》');
    const insertRec = db.queries.find((query: RecordedQuery) => query.text.includes('INSERT INTO recommendations'));
    expect(insertRec?.values).toContain('诡秘之主');
    expect(insertBook?.text).toContain('ON CONFLICT (title_key, author_key)');
  });

  it('reports ALREADY_ON_SHELF instead of writing twice', async () => {
    sql.mockImplementation((query) => (query.text.includes('SELECT 1 FROM recommendations') ? [{ '?column?': 1 }] : []));
    const res = await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: '已在书架', code: 'ALREADY_ON_SHELF' });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
