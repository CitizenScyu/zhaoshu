import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { initializeBusinessSchema } from '@/lib/business-schema';
import {
  addShelfForUserQueries, deleteShelfForUserQuery, exactLibraryBooksForUserQuery,
  feedbackForUserQueries, persistRecommendationsForUserQueries, recommendationsForUserQuery,
  shelfStatsForUserQuery,
} from '@/lib/user-data';

// 真实 PostgreSQL（WASM）：书架/推荐/库存查询的行级语义回归。
//
// 迁自 docs/audit-20260919/data-repro.test.ts 的 R01–R06（深审残留 A，2026-09-20）。这些用例
// 断言的是 deleteShelf 按书清推荐、分页首页含最新第 301 本、书架统计跨查询去重、重加已读书保
// 读后状态、精确库存查命中仅 labeled_books 的书、嵌套书名写后读回——全是**真库结果**，而路由/
// 桩测试只钉语句形状与绑定顺序（getSql 被 mock），钉不住这些行为。原文件走独立 vitest.config.mts、
// 不在 CI 路径（主 vitest.config.ts 只 include src/**、scripts/**），故落到 src/** 的 pglite 文件
// 里长期回归。R07（parseReadingProgress 追加章保位）为纯函数、已由 reader-preferences.test.ts
// 覆盖，未随迁；R08–R18 均由各 route/lib 测试钉住，随原 docs 目录一并删除（对照见提交说明）。

type Statement = { text: string; params: unknown[] };
let pg: PGliteLike;

function tag(parts: TemplateStringsArray, ...values: unknown[]): Statement {
  const result: Statement = { text: '', params: [] };
  parts.forEach((part, index) => {
    result.text += part;
    if (index >= values.length) return;
    const value = values[index];
    if (value && typeof value === 'object' && 'text' in value && 'params' in value) {
      const child = value as Statement;
      const offset = result.params.length;
      result.text += child.text.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + offset}`);
      result.params.push(...child.params);
    } else {
      result.params.push(value);
      result.text += `$${result.params.length}`;
    }
  });
  return result;
}
async function run(statement: unknown) {
  const { text, params } = statement as Statement;
  return (await pg.query(text, params)).rows as Record<string, unknown>[];
}
async function batch(statements: unknown[]) {
  await pg.exec('BEGIN');
  try {
    const result = [];
    for (const statement of statements) result.push(await run(statement));
    await pg.exec('COMMIT');
    return result;
  } catch (error) { await pg.exec('ROLLBACK'); throw error; }
}
const sql = Object.assign(tag, {
  transaction: (builder: (sql: typeof tag) => unknown[]) => batch(builder(tag)),
});
const queryTag = sql as never;
const item = (title: string) => ({ title, author: '审查作者', category: '', wordCount: '', matchScore: 80, hitLikes: [], risks: '', reason: '', why: '' });

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：书架/推荐/库存行级语义（深审残留 A R01–R06）', () => {
  beforeAll(async () => {
    pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users SELECT generate_series(1, 10)');
    await initializeBusinessSchema(sql as never);
    await pg.exec(`ALTER TABLE books ADD COLUMN title_key text GENERATED ALWAYS AS
      (lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\\1')))) STORED;
      ALTER TABLE books ADD COLUMN author_key text GENERATED ALWAYS AS (lower(btrim(normalize(author, NFKC)))) STORED;
      CREATE UNIQUE INDEX books_identity_idx ON books(title_key, author_key);
      ALTER TABLE labeled_books ADD COLUMN title_key text GENERATED ALWAYS AS
      (lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\\1')))) STORED;
      ALTER TABLE labeled_books ADD COLUMN author_key text GENERATED ALWAYS AS (lower(btrim(normalize(author, NFKC)))) STORED;
      CREATE UNIQUE INDEX labeled_books_identity_idx ON labeled_books(title_key, author_key)`);
  }, 60_000);
  afterAll(() => pg.close());

  it('R01: removing one shelf card removes every recommendation of that book, keeping other users and feedback (F05)', async () => {
    await batch(persistRecommendationsForUserQueries(queryTag, 1, '需求A', [item('审查删除')]) as unknown[]);
    await batch(persistRecommendationsForUserQueries(queryTag, 1, '需求B', [item('审查删除')]) as unknown[]);
    await batch(persistRecommendationsForUserQueries(queryTag, 2, '需求C', [item('审查删除')]) as unknown[]);
    await batch(feedbackForUserQueries(queryTag, 1, item('审查删除'), 'done', '保留原因', 0) as unknown[]);
    const before = await run(recommendationsForUserQuery(queryTag, 1, false));
    expect(before).toHaveLength(1);
    // 按书移除：该用户该书的全部推荐行
    await run(deleteShelfForUserQuery(queryTag, 1, before[0].book_id as number));
    expect(await run(recommendationsForUserQuery(queryTag, 1, false))).toEqual([]);
    // 跨用户：他人书架不受影响
    expect(await run(recommendationsForUserQuery(queryTag, 2, false))).toHaveLength(1);
    // 反馈保留：读后状态不属书架归属
    const feedback = await pg.query('SELECT status, note FROM feedback WHERE user_id = 1');
    expect(feedback.rows).toEqual([{ status: 'done', note: '保留原因' }]);
  });

  it('R02: the 301st book, being newest, appears on the first page; paging and search reach the rest (F06)', async () => {
    await pg.exec(`INSERT INTO books(title, author) SELECT '容量审查' || n, '审查作者' FROM generate_series(1,301) n;
      INSERT INTO recommendations(user_id, book_id, query, created_at)
      SELECT 8, id, '容量审查', '2026-01-01'::timestamptz + id * interval '1 second'
      FROM books WHERE title LIKE '容量审查%'`);
    const page1 = await run(recommendationsForUserQuery(queryTag, 8, false, { limit: 300, offset: 0 }));
    expect(page1).toHaveLength(300);
    expect(page1[0].title).toBe('容量审查301');
    const page2 = await run(recommendationsForUserQuery(queryTag, 8, false, { limit: 300, offset: 300 }));
    expect(page2.map((row) => row.title)).toEqual(['容量审查1']);
    // 无重复无遗漏
    expect(new Set([...page1, ...page2].map((row) => row.title)).size).toBe(301);
    const searched = await run(recommendationsForUserQuery(queryTag, 8, false, { q: '容量审查301' }));
    expect(searched.map((row) => row.title)).toEqual(['容量审查301']);
  });

  it('R03: one book in two recommendation queries counts once in shelf statistics (F07)', async () => {
    await batch(persistRecommendationsForUserQueries(queryTag, 3, '需求A', [item('统计审查')]) as unknown[]);
    await batch(persistRecommendationsForUserQueries(queryTag, 3, '需求B', [item('统计审查')]) as unknown[]);
    expect(await run(recommendationsForUserQuery(queryTag, 3, false))).toHaveLength(1);
    expect(await run(shelfStatsForUserQuery(queryTag, 3))).toEqual([{ name: 'new', count: 1 }]);
  });

  it('R04: re-adding a completed book keeps its reading status (F08)', async () => {
    await batch(feedbackForUserQueries(queryTag, 4, item('状态审查'), 'done', '已读完', 0) as unknown[]);
    await batch(addShelfForUserQueries(queryTag, 4, '状态审查', '审查作者') as unknown[]);
    let rows = await run(recommendationsForUserQuery(queryTag, 4, false));
    expect(rows[0]).toMatchObject({ status: 'done', note: '已读完' });
    // 移除后重新加入同样保持读后状态（feedback 未被删）
    await run(deleteShelfForUserQuery(queryTag, 4, rows[0].book_id as number));
    await batch(addShelfForUserQueries(queryTag, 4, '状态审查', '审查作者') as unknown[]);
    rows = await run(recommendationsForUserQuery(queryTag, 4, false));
    expect(rows[0]).toMatchObject({ status: 'done', note: '已读完' });
    // 无反馈的新书正常写 want
    await batch(addShelfForUserQueries(queryTag, 4, '状态审查新书', '审查作者') as unknown[]);
    const added = await run(recommendationsForUserQuery(queryTag, 4, false));
    expect(added.find((row) => row.title === '状态审查新书')?.status).toBe('want');
  });

  it('R05: exact local search finds a labeled_books-only book and does not promise text (F10)', async () => {
    await pg.exec("INSERT INTO labeled_books(title,author,source_url) VALUES ('书库独有审查','审查作者','https://example.invalid/book')");
    const hits = await run(exactLibraryBooksForUserQuery(queryTag, 5, '书库独有审查', '审查作者'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ metadata_source: 'labeled_books', author_match: true, has_txt: false, has_online_source: true });
  });

  it('R06: nested book brackets are persisted and can be read back; no silent loss (F09)', async () => {
    const written = await batch(persistRecommendationsForUserQueries(queryTag, 6, '嵌套身份审查', [item('《《嵌套审查》》')]) as unknown[]);
    expect(written[1]).toHaveLength(1); // RETURNING：实际写入行数与期望一致
    const rows = await run(recommendationsForUserQuery(queryTag, 6, false));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('《《嵌套审查》》'); // 展示名保留原始拼写
    const stored = await pg.query("SELECT title, title_key FROM books WHERE title_key = '《嵌套审查》'");
    expect(stored.rows).toEqual([{ title: '《《嵌套审查》》', title_key: '《嵌套审查》' }]);
    // 写后能查回：精确搜索走同一身份键
    const hits = await run(exactLibraryBooksForUserQuery(queryTag, 6, '《《嵌套审查》》', '审查作者'));
    expect(hits.map((row) => row.title)).toContain('《《嵌套审查》》');
  });
});
