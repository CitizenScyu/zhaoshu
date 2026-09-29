import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema } from '@/lib/fixtures/production-schema';

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ getSql: mocks.getSql, ensureSchema: async () => {} }));
vi.mock('@/lib/auth', () => ({ requirePermission: async () => ({ ok: true,
  principal: { userId: 2, role: 'member', canFind: true, canRead: false, canDownload: false },
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
      '2026-01-01'::timestamptz+(n%2)*interval '1 second' FROM generate_series(1,90)n; ANALYZE;`);
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
