import { beforeAll, describe, expect, it } from 'vitest';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { canonicalBookKey } from '@/lib/book-identity';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { feedbackForUserQueries } from '@/lib/user-data';

// 真实 PostgreSQL（WASM）：task-82 路线 B 的语义验证。
//
// 背景：书库的书只在 `labeled_books` 里，`books` 没有行；而 `feedback.book_id` 是
// NOT NULL + FK→books，所以「写反馈」必然 404 BOOK_NOT_FOUND。路线 B 在写反馈的
// 同一事务最前面补一条 books upsert（优先取 labeled_books 拼写），其余 4 条语句不动。
//
// 桩测试只能断言「语句数与参数」，证明不了三件事，而它们正是本路线成立的前提：
//   ① 补出来的 books 行真的被后面那条 INSERT ... SELECT 定位到（生成列键要真的相等）；
//   ② 补行**不新建 recommendations 行**（守住 status<>'new' 的召回排除语义）；
//   ③ 版本守卫失败时补行随事务一起回滚（不留孤儿 books 行）。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

// 标签模板 → ($n, params)；形状与 Neon 的非交互事务一致（先例：user-data.persist.pglite.test.ts）。
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

maybe('真实 PostgreSQL：feedbackForUserQueries 路线 B（写反馈时补 books 行）', () => {
  let pg: PGliteLike;
  let sql: ReturnType<typeof adapt>;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    sql = adapt(pg);
    await pg.exec(`CREATE TABLE users (id int PRIMARY KEY, can_find boolean NOT NULL DEFAULT true)`);
    await pg.query(`INSERT INTO users (id) VALUES (1)`);
    await initializeBusinessSchema(sql as never);
    // 0002 迁移的生成列与唯一索引（business-schema 刻意不建：见该文件 :29-31 的注释）。
    await pg.exec(`
      ALTER TABLE books ADD COLUMN IF NOT EXISTS title_key text GENERATED ALWAYS AS (
        lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\\1')))
      ) STORED`);
    await pg.exec(`
      ALTER TABLE books ADD COLUMN IF NOT EXISTS author_key text GENERATED ALWAYS AS (
        lower(btrim(normalize(author, NFKC)))
      ) STORED`);
    await pg.exec(`CREATE UNIQUE INDEX IF NOT EXISTS books_identity_idx ON books (title_key, author_key)`);
  }, 60_000);

  const statements = (title: string, author: string, status = 'done', note = '看完了', expected = 0) =>
    feedbackForUserQueries(sql as never, 1, { title, author }, status, note, expected) as unknown as { text: string; params: unknown[] }[];

  it('书库独有书（只在 labeled_books）：books 行被补、反馈落库、recommendations 一行不建', async () => {
    // 书库那一行（labeled_books 拼写与客户端传来的书源页拼写不同：全角/大小写）。
    await pg.query(`INSERT INTO labeled_books (title, author, source_url) VALUES ($1, $2, $3)`,
      ['修真聊天群', 'ABC', 'https://example.invalid/book']);
    const statements_ = statements('《修真聊天群》', 'ＡＢＣ');
    expect(statements_).toHaveLength(6);

    const results = await sql.transaction(() => statements_ as never);
    expect(results[4]).toHaveLength(1); // 索引 0 是补行，索引 4 才是 feedback INSERT

    const books = (await pg.query('SELECT title, author, title_key, author_key FROM books')).rows;
    // 优先取 labeled_books 的拼写（title 相同、author 取 'ABC' 而非客户端归一的 'abc'）。
    expect(books).toEqual([{ title: '修真聊天群', author: 'ABC', title_key: '修真聊天群', author_key: 'abc' }]);
    // 生成列键 == 应用侧身份键（两侧同一函数的真库证明）。
    const row = books[0] as { title_key: string; author_key: string };
    expect(`${row.title_key}${String.fromCharCode(0)}${row.author_key}`).toBe(canonicalBookKey('《修真聊天群》', 'ＡＢＣ'));

    const feedbackRows = (await pg.query('SELECT user_id, status, note FROM feedback')).rows;
    expect(feedbackRows).toEqual([{ user_id: 1, status: 'done', note: '看完了' }]);
    // 🔴 route B 不建 recommendations 行：'new' 之外的状态会经 excludedBooksForUserQuery
    // 把书永久移出召回，只有用户真的提交反馈才该触发那条排除。
    expect((await pg.query('SELECT count(*)::int AS n FROM recommendations')).rows).toEqual([{ n: 0 }]);
  });

  it('find 路径：books 已有这本（拼写不同）时补行是 no-op，不新增行也不换 id', async () => {
    const before = (await pg.query('SELECT id, title, author FROM books ORDER BY id')).rows;
    // 已存在的这一行的身份键与上面那本相同，换成客户端原样拼写再来一次；
    // 版本带上第一条反馈的 id（首次创建写的是 version 0）。
    const results = await sql.transaction(() => statements('修真聊天群', 'abc', 'want', '二刷', 1) as never);
    expect(results[4]).toHaveLength(1);
    expect((await pg.query('SELECT id, title, author FROM books ORDER BY id')).rows).toEqual(before);
    expect((await pg.query('SELECT status FROM feedback ORDER BY id DESC LIMIT 1')).rows).toEqual([{ status: 'want' }]);
  });

  it('书库拼写带首尾空格时写入前 btrim，否则后面 4 条 lower(title) 比较会落空（仍 404）', async () => {
    await pg.query(`INSERT INTO labeled_books (title, author, source_url) VALUES ($1, $2, $3)`,
      ['  Spaced 书  ', 'Spaced 作者', 'https://example.invalid/spaced']);
    // 只回落客户端值也能"补出行"，但那样 books 里存的是客户端拼写、而不是书库拼写；
    // 真正会被打红的是把 labeled 原样（带空格）写进去——补行成功、随后定位却 0 行。
    const results = await sql.transaction(() => statements('Spaced 书', 'Spaced 作者', 'done', '空格拼写', 0) as never);
    expect(results[4]).toHaveLength(1);
    expect((await pg.query(`SELECT title, author, title_key FROM books WHERE title_key = 'spaced 书'`)).rows)
      .toEqual([{ title: 'Spaced 书', author: 'Spaced 作者', title_key: 'spaced 书' }]);
  });

  it('版本守卫失败时补行一起回滚，不留孤儿 books 行', async () => {
    const books = (await pg.query('SELECT id, title, author FROM books ORDER BY id')).rows;
    const feedbackRows = (await pg.query('SELECT id FROM feedback ORDER BY id')).rows;
    await expect(sql.transaction(() => statements('全新的一本书', '无名', 'want', 'x', 7) as never))
      .rejects.toThrow(/division by zero/);
    expect((await pg.query('SELECT id, title, author FROM books ORDER BY id')).rows).toEqual(books);
    expect((await pg.query('SELECT id FROM feedback ORDER BY id')).rows).toEqual(feedbackRows);
  });

  it('既有边界（非路线 B 引入）：同身份键、异拼写的历史行也能被键等值定位（B7 修复）', async () => {
    // 直接写一行「未归一的旧拼写」——路线 B 的 upsert 会因身份键相同走 DO NOTHING。
    // 旧实现比 lower(title)（不做书名号归一），《斗破苍穹》会被定位落空 → 0 行反馈；
    // B7 改为 title_key 键等值后同一身份键即可定位，反馈正常落库、books 不新增第二行。
    // 这是键等值较旧实现的**行为改进**（修复而非破坏）：老边界只钉住「不建第二行」，
    // 该不变量继续成立。
    await pg.query(`INSERT INTO books (title, author) VALUES ($1, $2)`, ['《斗破苍穹》', '天蚕土豆']);
    const books = (await pg.query('SELECT id, title FROM books ORDER BY id')).rows;
    const results = await sql.transaction(() => statements('斗破苍穹', '天蚕土豆', 'want', '旧拼写', 0) as never);
    expect(results[4]).toHaveLength(1); // 键等值定位到那行历史行，反馈落库
    expect((await pg.query('SELECT id, title FROM books ORDER BY id')).rows).toEqual(books); // 不新增第二行
  });
});
