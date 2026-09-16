// Executes the real feedback transaction SQL on an in-memory PostgreSQL engine.
// No DATABASE_URL, credentials, or external database access is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node scripts/check-feedback-cas.mjs <pglite/dist/index.js>');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const source = await readFile(new URL('../src/lib/feedback-store.ts', import.meta.url), 'utf8');
const transaction = source.split('await sql.transaction([')[1]?.split('], { isolationLevel:')[0];
assert.ok(transaction, 'Read the actual application transaction');
const templates = [...transaction.matchAll(/sql`([\s\S]*?)`/g)].map((match) => match[1]);
assert.equal(templates.length, 6);
const scenarios = [];
async function scenario(name, check) { await check(); scenarios.push(name); }
const feedback = async (bookId = 1) => (await db.query('SELECT * FROM feedback WHERE book_id = $1 ORDER BY id', [bookId])).rows;
const shelf = async () => (await db.query('SELECT * FROM recommendations ORDER BY id')).rows;

function append(bookId, status, note, expectedVersion) {
  const input = { bookId, status, note, expectedVersion };
  return db.transaction(async (tx) => {
    for (const template of templates) {
      const params = [];
      const query = template.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
        assert.ok(Object.hasOwn(input, expression));
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
    CREATE TABLE books (id int PRIMARY KEY);
    CREATE TABLE feedback (id serial PRIMARY KEY, book_id int REFERENCES books(id), user_id int, status text, note text);
    CREATE TABLE recommendations (id serial PRIMARY KEY, book_id int REFERENCES books(id), user_id int, status text CHECK (status <> 'dropped'));
    INSERT INTO books VALUES (1), (2);
    INSERT INTO recommendations (book_id, user_id, status) VALUES (1, 1, 'want'), (1, 2, 'done');
  `);

  await scenario('first feedback creation uses version zero and preserves other users', async () => {
    await append(1, 'want', '原反馈', 0);
    assert.equal((await feedback()).length, 1);
    assert.equal((await shelf())[1].status, 'done');
    await assert.rejects(append(1, 'reading', '', 0), /division by zero/);
    assert.equal((await feedback()).length, 1);
  });

  await scenario('a new status and note append history rather than deleting the previous note', async () => {
    await append(1, 'reading', '新反馈', (await feedback()).at(-1).id);
    assert.deepEqual((await feedback()).map((row) => row.note), ['原反馈', '新反馈']);
    assert.equal((await shelf())[0].status, 'reading');
    assert.equal((await shelf())[1].status, 'done');
  });

  await scenario('two submitted edits from the same version have exactly one winner', async () => {
    const version = (await feedback()).at(-1).id;
    const results = await Promise.allSettled([append(1, 'done', '窗口 A', version), append(1, 'want', '窗口 B', version)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await feedback()).at(-1).note, '窗口 A');
    assert.equal((await feedback()).length, 3);
  });

  await scenario('a status write failure rolls back the appended feedback too', async () => {
    const history = await feedback();
    const statuses = await shelf();
    await assert.rejects(append(1, 'dropped', 'must rollback', history.at(-1).id), /check constraint/);
    assert.deepEqual(await feedback(), history);
    assert.deepEqual(await shelf(), statuses);
  });

  await scenario('a different book can independently create its first note', async () => {
    await append(2, 'want', '另一本书', 0);
    assert.equal((await feedback(2)).at(-1).note, '另一本书');
    assert.equal((await feedback()).length, 3);
  });
  console.log(JSON.stringify({ engine: 'PGlite (in-memory PostgreSQL)', passed: scenarios.length, scenarios }, null, 2));
} finally { await db.close(); }
