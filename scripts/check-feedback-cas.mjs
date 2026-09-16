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
assert.equal(templates.length, 5, 'lock book, resolve book, compare version, append history, change status');
const scenarios = [];
async function scenario(name, check) { await check(); scenarios.push(name); }
const feedback = async (userId = 1) => (await db.query('SELECT * FROM feedback WHERE user_id = $1 ORDER BY id', [userId])).rows;
const shelf = async (userId = 1) => (await db.query('SELECT * FROM recommendations WHERE user_id = $1 ORDER BY id', [userId])).rows;

function append(userId, title, author, status, note, expectedVersion = 0) {
  const input = { userId, 'book.title': title, 'book.author': author, status, note, expectedVersion };
  return db.transaction(async (tx) => {
    for (const template of templates) {
      const params = [];
      const query = template.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
        assert.ok(Object.hasOwn(input, expression), 'Unexpected SQL parameter: ' + expression);
        params.push(input[expression]);
        return '$' + params.length;
      });
      await tx.query(query, params);
    }
  });
}

try {
  // A deliberately narrow fixture schema; the CHECK below injects a failure
  // after the history INSERT to verify the real transaction rollback.
  await db.exec(`
    CREATE TABLE books (id int PRIMARY KEY, title text NOT NULL, author text NOT NULL);
    CREATE TABLE feedback (id serial PRIMARY KEY, book_id int REFERENCES books(id), user_id int, status text, note text);
    CREATE TABLE recommendations (id serial PRIMARY KEY, book_id int REFERENCES books(id), user_id int, status text CHECK (status <> 'dropped'));
    INSERT INTO books VALUES (1, '书一', '作者一'), (2, '书二', '作者二');
    INSERT INTO recommendations (book_id, user_id, status) VALUES (1, 1, 'want'), (1, 2, 'done');
  `);

  await scenario('first feedback creation uses version zero and preserves other users', async () => {
    await append(1, '书一', '作者一', 'want', '原反馈', 0);
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
  console.log(JSON.stringify({ engine: 'PGlite (in-memory PostgreSQL)', passed: scenarios.length, scenarios }, null, 2));
} finally { await db.close(); }
