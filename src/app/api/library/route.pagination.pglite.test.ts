import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema, seedProductionMembers } from '@/lib/fixtures/production-schema';

const mocks = vi.hoisted(() => ({ getSql: vi.fn(), canRead: false }));
vi.mock('@/lib/db', () => ({ getSql: mocks.getSql, ensureSchema: async () => {} }));
vi.mock('@/lib/auth', () => ({ requirePermission: async () => ({ ok: true,
  principal: { userId: 2, role: 'member', canFind: true, canRead: mocks.canRead, canDownload: mocks.canRead },
}) }));
import { GET } from './route';

type Statement = { text: string; params: unknown[] };
function tag(parts: TemplateStringsArray, ...values: unknown[]): Statement {
  const out: Statement = { text: '', params: [] };
  parts.forEach((part, index) => {
    out.text += part;
    if (index >= values.length) return;
    const value = values[index];
    if (value && typeof value === 'object' && 'text' in value && 'params' in value) {
      const child = value as Statement, offset = out.params.length;
      out.text += child.text.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + offset}`);
      out.params.push(...child.params);
    } else { out.params.push(value); out.text += `$${out.params.length}`; }
  });
  return out;
}
let pg: PGliteLike;
beforeAll(async () => {
  const PGlite = await loadPGlite();
  if (!PGlite) throw new Error('PGlite required');
  pg = new PGlite();
  await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
  mocks.getSql.mockReturnValue({ transaction: async (build: (sql: typeof tag) => Statement[], options: unknown) => {
    expect(options).toEqual({ readOnly: true });
    const statements = build(tag); expect(statements).toHaveLength(4);
    await pg.exec('BEGIN READ ONLY');
    try {
      const result = [];
      for (const statement of statements) result.push((await pg.query(statement.text, statement.params)).rows);
      await pg.exec('COMMIT'); return result;
    } catch (error) { await pg.exec('ROLLBACK'); throw error; }
  } });
  await pg.exec(`INSERT INTO labeled_books(title,author,quality,labeled_at)
    SELECT 'synthetic group '||(n%2), 'synthetic author '||n, (n%2),
      '2026-01-01'::timestamptz+(n%2)*interval '1 second' FROM generate_series(1,90)n;
    -- usable1104：书库只列有 done 任务的书；每本先给一条系统 done（id 100+n）。
    INSERT INTO download_tasks(id,book_id,title,author,status,requested_by)
      SELECT 100+n, n, 't', 'a', 'done', 'system' FROM generate_series(1,90)n;
    ANALYZE;`);
}, 60_000);
afterAll(() => pg?.close());

it.each(['quality', 'recent', 'oldest', 'title'])('keeps %s primary order and unique descending IDs within ties across three pages', async sort => {
  const ids: number[] = [];
  for (const page of [1, 2, 3]) {
    const response = await GET(new NextRequest(`http://synthetic.local/api/library?sort=${sort}&page=${page}`));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.total).toBe(90); expect(data.books).toHaveLength(30);
    ids.push(...data.books.map((book: { id: number }) => book.id));
  }
  const firstGroup = sort === 'quality' || sort === 'recent' ? 1 : 0;
  const descending = Array.from({ length: 90 }, (_, index) => 90 - index);
  const expected = [...descending.filter(id => id % 2 === firstGroup), ...descending.filter(id => id % 2 !== firstGroup)];
  expect(ids).toEqual(expected);
  expect(new Set(ids).size).toBe(90);
});

// libpage1103：列表改成「内层先取本页 id、外层再算子查询」后，两条相关子查询必须仍按外层
// 每本书各自关联，且在非首页上也成立。
it('computes shared-read and my-download task ids per book on a later page', async () => {
  await seedProductionMembers(pg, 3);
  await pg.exec(`
    INSERT INTO download_tasks(id,user_id,book_id,title,author,status,requested_by,created_at)
      SELECT 1000+n, 3, n, 't', 'a', 'done', 'user', '2026-01-01' FROM generate_series(1,90)n WHERE n%3=0;
    INSERT INTO download_tasks(id,user_id,book_id,title,author,status,requested_by,created_at)
      SELECT 2000+n, 2, n, 't', 'a', 'failed', 'user', '2026-01-02' FROM generate_series(1,90)n WHERE n%5=0;
    INSERT INTO download_tasks(id,user_id,book_id,title,author,status,requested_by,created_at)
      SELECT 3000+n, 2, n, 't', 'a', 'pending', 'user', '2026-01-03' FROM generate_series(1,90)n WHERE n%10=0;`);
  mocks.canRead = true;
  try {
    const response = await GET(new NextRequest('http://synthetic.local/api/library?sort=oldest&page=2'));
    const books: { id: number; sharedReadTaskId: number | null; myDownloadTaskId: number | null }[] = (await response.json()).books;
    expect(books).toHaveLength(30);
    for (const book of books) {
      expect(book.sharedReadTaskId).toBe(book.id % 3 === 0 ? 1000 + book.id : 100 + book.id);
      expect(book.myDownloadTaskId).toBe(book.id % 10 === 0 ? 3000 + book.id : book.id % 5 === 0 ? 2000 + book.id : null);
    }
  } finally {
    mocks.canRead = false;
  }
});
