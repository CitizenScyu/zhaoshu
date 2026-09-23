import { beforeAll, describe, expect, it } from 'vitest';
import { createProductionSchema } from '@/lib/fixtures/production-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { feedbackForUserQueries } from '@/lib/user-data';

// MS-14（rev42）：labeled_books 的身份定位必须走权威键 title_key/author_key，
// 而不是旧式 lower(btrim(title))。权威键比旧式多剥一层外层《》
// （migrations/0002_identity_key.sql 的 regexp_replace），旧式比较对「《余生》」与「余生」
// 这种书名号差异会漏匹配。
//
// 本文件钉住两处改动的真实 SQL 语义（PGlite = 真 PostgreSQL）：
//   ① source-reader.ts hintsFor 的 labeled_books 查询：title_key 等值；
//   ② user-data.ts feedbackForUserQueries 的 labeled_books 查找：title_key + author_key。
// 两处都查 labeled_books（该表有生成列）。user-data.ts:68 / :683 查的是 download_tasks
// （该表无生成列），不在本次范围，这里不碰。
//
// 🔴 建表走 src/lib/fixtures/production-schema.ts 的 createProductionSchema——它原样执行
// 生产的 0002 迁移，**不手抄**生成列表达式。手抄一份会再造出 2026-09-23 那次漂移
// （测试少剥《》一层、漏匹配类回归在测试里系统性隐形）。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

function adapt(pg: PGliteLike) {
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return { text, params };
  }) as SqlTag;
  const transaction = async (builder: (tag: SqlTag) => { text: string; params: unknown[] }[]) => {
    const statements = builder(tag);
    await pg.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push((await pg.query(statement.text, statement.params)).rows);
      await pg.exec('COMMIT');
      return results;
    } catch (error) {
      await pg.exec('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  return Object.assign(tag, { transaction }) as unknown as SqlTag & { transaction: typeof transaction };
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('MS-14：labeled_books 身份定位走权威键（剥《》）', () => {
  let pg: PGliteLike;
  let sql: ReturnType<typeof adapt>;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    sql = adapt(pg);
    // 生产 schema 同源：auth + business + 0002 身份键迁移，原样执行、不手抄。
    await createProductionSchema(sql as never, (statement) => pg.exec(statement));
    // createProductionSchema 已建好 id=1 的 owner 行（auth-store 的身份 CHECK 固定该行）；
    // 本套件只需要一个存在用户，直接复用，不再插。
  }, 60_000);

  // source-reader.ts hintsFor 的查询，逐字对齐实现（改实现而不同步这里，本用例必须红）。
  const hints = (titleKey: string) => pg.query(
    `SELECT title, author, source_url FROM labeled_books WHERE title_key = $1 LIMIT 6`, [titleKey]);

  it('hintsFor：《余生》入库、按「余生」查，命中（旧式 lower(btrim) 会漏）', async () => {
    await pg.query(`INSERT INTO labeled_books (title, author, source_url) VALUES ($1, $2, $3)`,
      ['《余生》', '作者甲', 'https://example.invalid/yusheng']);
    // 查询侧用权威归一（normalizeBookTitle('余生') === '余生'）。
    const rows = (await hints('余生')).rows;
    expect(rows).toEqual([{ title: '《余生》', author: '作者甲', source_url: 'https://example.invalid/yusheng' }]);
  });

  it('hintsFor：反向——入库「余生」、按《余生》的权威键查，同样命中', async () => {
    const rows = (await hints('余生')).rows; // normalizeBookTitle('《余生》') 也是 '余生'
    expect(rows.map((row) => (row as { title: string }).title)).toContain('《余生》');
  });

  it('feedbackForUserQueries：labeled 存《余生》，客户端传「余生」时优先取书库拼写', async () => {
    const statements = feedbackForUserQueries(
      sql as never, 1, { title: '余生', author: '作者甲' }, 'done', '看完', 0,
    ) as unknown as { text: string; params: unknown[] }[];
    // 查找必须走权威键，而不是旧式 lower(btrim(...))。
    expect(statements[0].text).toContain('title_key');
    expect(statements[0].text).not.toContain('lower(btrim(title))');
    const results = await sql.transaction(() => statements as never);
    expect(results[4]).toHaveLength(1); // 反馈落库：证明 labeled 行被权威键定位到
    // 优先取 labeled_books 的原拼写（带书名号），而不是回落客户端归一值。
    expect((await pg.query(`SELECT title, author FROM books WHERE title_key = '余生'`)).rows)
      .toEqual([{ title: '《余生》', author: '作者甲' }]);
  });
});
