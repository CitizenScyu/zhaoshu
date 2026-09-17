import { beforeAll, describe, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';

// 真实 PostgreSQL（WASM）：LIKE 转义修复（P2-2）的语义验证。
//
// 为什么桩测试不够：桩只断言「绑定值是转义后的字符串」，无法证明 PG 端
// `LIKE '%100\%%' ESCAPE '\'` 真的只匹配字面含 `100%` 的行、不匹配 `100x`。
// 修前 `%100%%` 里的第二个 % 是通配符，会命中一切含 `100` 前缀的行——
// 这正是审计抓到的误匹配（用户输入 %/_ 变通配符）。

type Row = { title: string; n: number };

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：书库搜索 LIKE 转义', () => {
  let pg: PGliteLike;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await pg.exec(`
      CREATE TABLE labeled_books (
        id serial PRIMARY KEY,
        title text NOT NULL,
        author text NOT NULL DEFAULT '',
        category text NOT NULL DEFAULT '',
        finish_status text NOT NULL DEFAULT '',
        chars_labeled bigint NOT NULL DEFAULT 0,
        labels jsonb NOT NULL DEFAULT '{}',
        labeled_at timestamptz NOT NULL DEFAULT now(),
        primary_genre text NOT NULL DEFAULT '',
        quality float8
      )`);
    // 一组刻意设计的行：字面含 % 的、含 _ 的、以及会被未转义通配符误命中的。
    await pg.exec(`
      INSERT INTO labeled_books (title, author, labels) VALUES
        ('折扣100%的书', '作者甲', '{"genre": "都市"}'),
        ('打9.5折的书', '作者甲', '{"genre": "都市"}'),
        ('折扣100x的书', '作者乙', '{"genre": "仙侠"}'),
        ('副本_指南', '作者乙', '{"genre": "工具"}'),
        ('副本A指南', '作者乙', '{"genre": "工具"}')`);
  }, 60_000);

  const count = async (pattern: string, escaped: boolean): Promise<Row[]> =>
    (await pg.query(
      `SELECT title, count(*)::int AS n FROM labeled_books
       WHERE lower(title) LIKE $1 ${escaped ? "ESCAPE '\\'" : ''} GROUP BY title ORDER BY title`,
      [pattern],
    )).rows as Row[];

  it('修前（未转义）：% 是通配符，搜 "100%" 误命中 "100x"', async () => {
    // 这正是修前的行为：`%100%%` 的第二个 % 匹配任意串。
    const rows = await count('%100%%', false);
    expect(rows.map((r) => r.title)).toEqual(['折扣100%的书', '折扣100x的书']);
  });

  it('修后（转义 + ESCAPE）：搜 "100%" 只命中字面含 100% 的行', async () => {
    const rows = await count('%100\\%%', true);
    expect(rows.map((r) => r.title)).toEqual(['折扣100%的书']);
  });

  it('修前（未转义）：_ 匹配任意单字符，"副本_指南" 误命中 "副本A指南"', async () => {
    const rows = await count('%副本_指南%', false);
    expect(rows.map((r) => r.title).sort()).toEqual(['副本A指南', '副本_指南']);
  });

  it('修后（转义）：_ 是字面下划线，只命中 "副本_指南"', async () => {
    const rows = await count('%副本\\_指南%', true);
    expect(rows.map((r) => r.title)).toEqual(['副本_指南']);
  });

  it('修后：反斜杠本身也被转义，字面含反斜杠的输入不再吞后续字符', async () => {
    // 参数里传两个字符：反斜杠 + 反斜杠（LIKE 模式：\\ 是被转义的字面 \）。
    // 存储侧也用参数化插入，确保列值就是 C:\书名。
    await pg.query(`INSERT INTO labeled_books (title, author, labels) VALUES ($1, '作者丙', '{}')`, ['C:\\书名']);
    const rows = await count('%c:\\\\书名%', true);
    expect(rows.map((r) => r.title)).toEqual(['C:\\书名']);
  });

  it('不含通配符的普通搜索两版行为一致（回归）', async () => {
    expect((await count('%都市%', false)).length).toBe(0); // labels 不在 title 里
    const both = await count('%指南%', true);
    expect(both.map((r) => r.title).sort()).toEqual(['副本A指南', '副本_指南']);
  });
});
