import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema } from '@/lib/fixtures/production-schema';

// facet1102：生产书库分类条出现无名「（1）」——category 为空串时只 NULLIF primary_genre 会聚出 ''，
// 且该筛选值与「全部」同为 ''（两枚 chip 同时高亮、点了无效）。聚合与筛选须同一归一式，「其他」能筛到它们。
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
  mocks.getSql.mockReturnValue({ transaction: async (build: (sql: typeof tag) => Statement[]) => {
    const result = [];
    for (const statement of build(tag)) result.push((await pg.query(statement.text, statement.params)).rows);
    return result;
  } });
  await pg.exec(`INSERT INTO labeled_books(title,author,category,primary_genre) VALUES
    ('合成甲','作者1','', ''), ('合成乙','作者2','', ''), ('合成丙','作者3','其他', ''),
    ('合成丁','作者4','', '仙侠'), ('合成戊','作者5','玄幻', '')`);
}, 60_000);
afterAll(() => pg?.close());

const get = async (query = '') => (await GET(new NextRequest(`http://synthetic.local/api/library${query}`))).json();

it('分类聚合不出空名：空串 category 归入「其他」', async () => {
  const { facets } = await get();
  expect(facets.categories[0]).toEqual({ name: '其他', count: 3 });
  expect(facets.categories.slice(1).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)))
    .toEqual([{ name: '仙侠', count: 1 }, { name: '玄幻', count: 1 }].sort((a, b) => a.name.localeCompare(b.name)));
});

it('「其他」筛选与聚合计数一致，含空串 category 的行', async () => {
  const data = await get('?category=%E5%85%B6%E4%BB%96');
  expect(data.total).toBe(3);
  expect(data.books.map((book: { title: string }) => book.title).sort()).toEqual(['合成丙', '合成乙', '合成甲'].sort());
  expect((await get('?category=%E7%8E%84%E5%B9%BB')).total).toBe(1);
});
