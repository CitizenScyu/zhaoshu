import { beforeAll, describe, expect, it } from 'vitest';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema } from '@/lib/fixtures/production-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { persistRecommendationsForUserQueries } from '@/lib/user-data';

// 真实 PostgreSQL（WASM）：批量持久化（P2-4）的语义验证。
//
// 桩测试只断言「语句数=2、参数里是归一值」，无法证明两条 jsonb_to_recordset 语句
// 在真库上真的：① 按身份键 upsert books 且合并 meta；② recommendations 侧
// 经生成列键回查到刚 upsert 的行（包括同一批内的新行）；③ 冲突时 DO UPDATE
// 的语义与旧的逐条写法一致。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

// 标签模板 → ($n, params)；形状与 Neon 的非交互事务一致（先例：register/route.pglite.test.ts）。
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

maybe('真实 PostgreSQL：persistRecommendationsForUserQueries 批量写', () => {
  let pg: PGliteLike;
  let sql: ReturnType<typeof adapt>;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    sql = adapt(pg);
    // 建最小 schema：users(1) + business 表 + 身份键（0002 迁移的生成列与唯一索引）。
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
  }, 60_000);

  const items = [
    {
      title: '《修真聊天群》', author: 'ＡＢＣ', category: '仙侠', wordCount: '100万字',
      matchScore: 88, hitLikes: ['设定'], risks: '', reason: '值得读',
      douban: { doubanId: '123', rating: 8, ratingCount: 4567 },
    },
    {
      title: '凡人修仙传', author: '忘语', category: '仙侠', wordCount: '700万字',
      matchScore: 80, hitLikes: [], risks: '长', reason: '经典',
    },
  ];

  it('一批 2 本只发 2 条语句；两本书与两条推荐都落库', async () => {
    const statements = persistRecommendationsForUserQueries(sql as never, 1, '找书', items as never) as unknown as { text: string; params: unknown[] }[];
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toContain('INSERT INTO books');
    expect(statements[1].text).toContain('INSERT INTO recommendations');
    await sql.transaction(() => statements as never);

    const books = (await pg.query('SELECT title, author, douban_id, douban_rating, meta FROM books ORDER BY id')).rows;
    // F09：展示列存原始拼写（身份键由生成列归一，此处不选键列）。
    expect(books).toEqual([
      { title: '《修真聊天群》', author: 'ＡＢＣ', douban_id: '123', douban_rating: 8, meta: { category: '仙侠', wordCount: '100万字' } },
      { title: '凡人修仙传', author: '忘语', douban_id: null, douban_rating: null, meta: { category: '仙侠', wordCount: '700万字' } },
    ]);
    const recs = (await pg.query(
      'SELECT user_id, query, match_score, hit_likes, risks, reason, status FROM recommendations ORDER BY book_id',
    )).rows;
    expect(recs).toEqual([
      { user_id: 1, query: '找书', match_score: 88, hit_likes: ['设定'], risks: '', reason: '值得读', status: 'new' },
      { user_id: 1, query: '找书', match_score: 80, hit_likes: [], risks: '长', reason: '经典', status: 'new' },
    ]);
  });

  it('同批重跑走 DO UPDATE：行数不膨胀，评分与理由被更新，旧 meta 键保留（合并而非覆盖）', async () => {
    const rerun = items.map((item, i) => i === 0 ? { ...item, matchScore: 99, reason: '更新后的理由' } : item);
    await sql.transaction(() => persistRecommendationsForUserQueries(sql as never, 1, '找书', rerun as never) as never);

    const counts = (await pg.query(
      'SELECT (SELECT count(*) FROM books)::int AS books, (SELECT count(*) FROM recommendations)::int AS recs',
    )).rows;
    expect(counts).toEqual([{ books: 2, recs: 2 }]);
    const updated = (await pg.query(
      `SELECT r.match_score, r.reason, b.meta FROM recommendations r JOIN books b ON b.id = r.book_id
       WHERE b.title_key = '修真聊天群'`,
    )).rows;
    expect(updated).toEqual([{ match_score: 99, reason: '更新后的理由', meta: { category: '仙侠', wordCount: '100万字' } }]);
  });

  it('已存在的 books 行（douban 数据为空）被同批 upsert 补全且不换行', async () => {
    // 先手工插入一本与批次身份相同但 douban 全空的旧书（模拟历史行）。
    await pg.query(`INSERT INTO books (title, author, meta) VALUES ($1, $2, '{"legacy": true}'::jsonb)`, ['斗破苍穹', '天蚕土豆']);
    const batch = [{ ...items[0], title: '斗破苍穹', author: '天蚕土豆' }];
    await sql.transaction(() => persistRecommendationsForUserQueries(sql as never, 1, '再找一次', batch as never) as never);

    const rows = (await pg.query(`SELECT id, douban_id, meta FROM books WHERE title_key = '斗破苍穹'`)).rows;
    expect(rows).toHaveLength(1); // 不新增行
    expect(rows[0].douban_id).toBe('123'); // COALESCE 补全
    // meta 合并：旧键保留，新键并入（books.meta || EXCLUDED.meta）。
    expect(rows[0].meta).toMatchObject({ legacy: true, category: '仙侠', wordCount: '100万字' });
  });
});
