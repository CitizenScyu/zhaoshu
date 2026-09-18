// Executes the real feedback transaction SQL on an in-memory PostgreSQL engine.
// No DATABASE_URL, credentials, or external database access is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node scripts/check-feedback-cas.mjs <pglite/dist/index.js>');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
// SQL 现在由 user-data.ts 的批次构造器生成，由 db.ts 的 recordFeedbackForUser 注入
// 事务写入器；这里直接抽出同一批语句，在 PGlite 上验证数据语义。
const source = await readFile(new URL('../src/lib/user-data.ts', import.meta.url), 'utf8');
const body = source.split('export function feedbackForUserQueries')[1]?.split('\nexport function')[0];
assert.ok(body, 'Read the actual application feedback SQL');
const templates = [...body.matchAll(/sql`([\s\S]*?)`/g)].map((match) => match[1]);
assert.equal(templates.length, 6, 'route B 补 books 行 + lock book, resolve book, compare version, append history, change status');
const scenarios = [];
async function scenario(name, check) { await check(); scenarios.push(name); }
const feedback = async (userId = 1) => (await db.query('SELECT * FROM feedback WHERE user_id = $1 ORDER BY id', [userId])).rows;
const shelf = async (userId = 1) => (await db.query('SELECT * FROM recommendations WHERE user_id = $1 ORDER BY id', [userId])).rows;

function append(userId, title, author, status, note, expectedVersion = 0) {
  const input = { userId, 'book.title': title, 'book.author': author, status, note, expectedVersion };
  return db.transaction(async (tx) => {
    const results = [];
    for (const template of templates) {
      const params = [];
      const query = template.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
        assert.ok(Object.hasOwn(input, expression), 'Unexpected SQL parameter: ' + expression);
        params.push(input[expression]);
        return '$' + params.length;
      });
      // Kept in order so callers can inspect the same indices db.ts reads
      // (results[4] is the feedback INSERT ... RETURNING id; index 0 is the
      // route B books upsert).
      results.push((await tx.query(query, params)).rows);
    }
    return results;
  });
}

try {
  // A deliberately narrow fixture schema; the CHECK below injects a failure
  // after the history INSERT to verify the real transaction rollback.
  //
  // books 带上身份键生成列 + 唯一索引，labeled_books 单独一张表：route B（task-82）
  // 的 upsert 要 `ON CONFLICT (title_key, author_key)`，也要能查 labeled_books。
  // 生成列表达式与 migrations/0002_identity_key.sql 逐字一致。
  await db.exec(`
    CREATE TABLE books (
      id serial PRIMARY KEY,
      title text NOT NULL,
      author text NOT NULL,
      meta jsonb NOT NULL DEFAULT '{}',
      title_key text GENERATED ALWAYS AS (
        lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\\1')))
      ) STORED,
      author_key text GENERATED ALWAYS AS (lower(btrim(normalize(author, NFKC)))) STORED
    );
    CREATE UNIQUE INDEX books_identity_idx ON books (title_key, author_key);
    CREATE TABLE labeled_books (id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT '');
    CREATE TABLE feedback (id serial PRIMARY KEY, book_id int REFERENCES books(id), user_id int, status text, note text);
    CREATE TABLE recommendations (id serial PRIMARY KEY, book_id int REFERENCES books(id), user_id int, status text CHECK (status <> 'dropped'));
    INSERT INTO books (title, author) VALUES ('书一', '作者一'), ('书二', '作者二');
    INSERT INTO recommendations (book_id, user_id, status) VALUES (1, 1, 'want'), (1, 2, 'done');
  `);

  await scenario('first feedback creation uses version zero and preserves other users', async () => {
    const created = await append(1, '书一', '作者一', 'want', '原反馈', 0);
    assert.equal(created[4].length, 1, 'the happy path must expose the inserted feedback id at index 4');
    assert.equal((await feedback()).length, 1);
    assert.equal((await shelf(2))[0].status, 'done');
    await assert.rejects(append(1, '书一', '作者一', 'reading', '', 0), /division by zero/);
    assert.equal((await feedback()).length, 1);
  });

  await scenario('a new status and note append history rather than deleting the previous note', async () => {
    await append(1, '书一', '作者一', 'reading', '新反馈', (await feedback()).at(-1).id);
    assert.deepEqual((await feedback()).map((row) => row.note), ['原反馈', '新反馈']);
    assert.equal((await shelf(1))[0].status, 'reading');
    assert.equal((await shelf(2))[0].status, 'done');
  });

  await scenario('two submitted edits from the same version have exactly one winner', async () => {
    const version = (await feedback()).at(-1).id;
    const results = await Promise.allSettled([
      append(1, '书一', '作者一', 'done', '窗口 A', version),
      append(1, '书一', '作者一', 'want', '窗口 B', version),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await feedback()).at(-1).note, '窗口 A');
    assert.equal((await feedback()).length, 3);
  });

  await scenario('a status write failure rolls back the appended feedback too', async () => {
    const history = await feedback();
    const statuses = await shelf(1);
    await assert.rejects(append(1, '书一', '作者一', 'dropped', 'must rollback', history.at(-1).id), /check constraint/);
    assert.deepEqual(await feedback(), history);
    assert.deepEqual(await shelf(1), statuses);
  });

  await scenario('a different book can independently create its first note', async () => {
    await append(1, '书二', '作者二', 'want', '另一本书', 0);
    assert.equal((await feedback()).at(-1).note, '另一本书');
    assert.equal((await feedback()).length, 4);
  });

  await scenario('another user keeps its own feedback history for the same book', async () => {
    await append(2, '书一', '作者一', 'reading', 'B 的反馈', 0);
    assert.equal((await feedback(2)).at(-1).note, 'B 的反馈');
    assert.deepEqual((await feedback(1)).map((row) => row.note), ['原反馈', '新反馈', '窗口 A', '另一本书']);
  });

  await scenario('route B：books 没有的书，写反馈时先补一行 books（回落客户端归一值），反馈照常落库', async () => {
    const history = await feedback();
    const shelves = [...(await shelf(1)), ...(await shelf(2))];
    const results = await append(1, '不在库里的书', '无名', 'want', '幽灵反馈', 0);
    // 索引 0 是 route B 的补行 upsert；索引 4 才是 db.ts 读的 feedback INSERT。
    assert.equal(results.length, 6);
    assert.equal(results[4].length, 1, 'the feedback INSERT must land on the row route B just created');
    assert.deepEqual((await db.query(`SELECT title, author, title_key FROM books WHERE title_key = '不在库里的书'`)).rows,
      [{ title: '不在库里的书', author: '无名', title_key: '不在库里的书' }]);
    assert.equal((await feedback()).length, history.length + 1, 'the feedback row must be appended');
    assert.deepEqual([...(await shelf(1)), ...(await shelf(2))], shelves,
      'route B must not create or touch any recommendation row（守住 status<>new 的召回排除语义）');
  });

  await scenario('route B：书库独有书优先取 labeled_books 的拼写，且写入前 btrim（否则后续定位仍会落空）', async () => {
    await db.query(`INSERT INTO labeled_books (title, author) VALUES ('ABC书', '爱潜水的乌贼'), ('  空格书  ', '无名氏')`);
    // 客户端传的是书源页拼写（已归一：小写）。labeled 行拼写不同 => 必须优先取后者。
    assert.equal((await append(1, 'abc书', '爱潜水的乌贼', 'done', '书库独有 A', 0))[4].length, 1);
    assert.deepEqual((await db.query(`SELECT title, author FROM books WHERE title_key = 'abc书'`)).rows,
      [{ title: 'ABC书', author: '爱潜水的乌贼' }]);
    // labeled 拼写带首尾空格：写进 books 的必须已 btrim，否则本批后续的
    // lower(title) = lower(book.title) 比较会落空、feedback INSERT 插 0 行（仍 404）。
    assert.equal((await append(1, '空格书', '无名氏', 'done', '书库独有 B', 0))[4].length, 1);
    assert.deepEqual((await db.query(`SELECT title, title_key FROM books WHERE title_key = '空格书'`)).rows,
      [{ title: '空格书', title_key: '空格书' }]);
  });

  await scenario('漏写的书 + 过期版本：版本守卫仍先炸，且 route B 补出来的 books 行一并回滚', async () => {
    const history = await feedback();
    const shelves = [...(await shelf(1)), ...(await shelf(2))];
    const booksBefore = (await db.query('SELECT id, title, author FROM books ORDER BY id')).rows;
    await assert.rejects(append(1, '另一本不在库里的书', '无名', 'want', '幽灵反馈', 7), /division by zero/);
    assert.deepEqual(await feedback(), history);
    assert.deepEqual([...(await shelf(1)), ...(await shelf(2))], shelves);
    assert.deepEqual((await db.query('SELECT id, title, author FROM books ORDER BY id')).rows, booksBefore,
      'route B 的补行与反馈写在同一个事务里，必须一起回滚');
  });
  console.log(JSON.stringify({ engine: 'PGlite (in-memory PostgreSQL)', passed: scenarios.length, scenarios }, null, 2));
} finally { await db.close(); }
