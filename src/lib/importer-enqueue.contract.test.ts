// T5 兼容性证明:不用 T1 实现文件,只用其冻结契约(列 + 事件键)验证两件事——
//   1. T1 的「同事件重放返回 existing」在导入侧同语义;
//   2. T1 v7 的活动索引/事件索引在本模块语句下不产生 23505 误伤。
// 这里刻意**只写 SQL 文本**,不 import t1-worktree 的任何文件(避免合并冲突)。

import { beforeEach, describe, expect, it } from 'vitest';
import { importLabelWithSystemTask, type ImporterSql } from './importer-enqueue';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';

function adapter(pg: PGliteLike): ImporterSql {
  return (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  }) as ImporterSql;
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const RECORD = {
  title: '契约书', author: '契约作者', category: '', finishStatus: '', sourceSite: '',
  sourceUrl: 'https://book15.net/books/details1.html', charsLabeled: 1000,
  labels: { title_guess: '契约书' }, primaryGenre: '', subTags: [], quality: null,
};

maybe('T5 × T1 契约兼容(不 import T1 文件)', () => {
  let pg: PGliteLike;
  let sql: ImporterSql;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = adapter(pg);
    await pg.exec(`
      CREATE TABLE users (id integer PRIMARY KEY);
      INSERT INTO users(id) VALUES (1);
      CREATE TABLE download_tasks (
        id serial PRIMARY KEY, book_id integer NOT NULL, title text NOT NULL,
        author text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending',
        source_url text NOT NULL DEFAULT '', chapters_total integer NOT NULL DEFAULT 0,
        chapters_done integer NOT NULL DEFAULT 0, chars_total integer NOT NULL DEFAULT 0,
        error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        user_id integer CONSTRAINT download_tasks_user_fk REFERENCES users(id),
        requested_by text NOT NULL DEFAULT 'user', source_kind text NOT NULL DEFAULT 'builtin',
        source_id text, source_revision text NOT NULL DEFAULT '',
        policy_version text NOT NULL DEFAULT '', enqueue_key text,
        attempt_count integer NOT NULL DEFAULT 1, retry_of integer,
        next_attempt_at timestamptz, lease_generation integer NOT NULL DEFAULT 0,
        lease_owner text NOT NULL DEFAULT '',
        CONSTRAINT download_tasks_identity_check CHECK (
          (requested_by = 'user' AND user_id IS NOT NULL)
          OR (requested_by = 'system' AND user_id IS NULL))
      );
      CREATE UNIQUE INDEX download_tasks_user_active_book_idx ON download_tasks (user_id, book_id)
        WHERE status IN ('pending', 'running');
      CREATE UNIQUE INDEX download_tasks_system_active_book_idx ON download_tasks (book_id)
        WHERE requested_by = 'system' AND status IN ('pending', 'running');
      CREATE UNIQUE INDEX download_tasks_system_event_idx ON download_tasks (enqueue_key)
        WHERE requested_by = 'system' AND enqueue_key IS NOT NULL;
      CREATE TABLE labeled_books (
        id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT '',
        category text NOT NULL DEFAULT '', finish_status text NOT NULL DEFAULT '',
        source_site text NOT NULL DEFAULT '', source_url text NOT NULL DEFAULT '',
        chars_labeled integer NOT NULL DEFAULT 0, labels jsonb NOT NULL DEFAULT '{}',
        labeled_at timestamptz NOT NULL DEFAULT now(),
        primary_genre text NOT NULL DEFAULT '', sub_tags jsonb NOT NULL DEFAULT '[]',
        quality float8
      );
      ALTER TABLE labeled_books ADD COLUMN title_key text GENERATED ALWAYS AS (
        lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\\1')))) STORED;
      ALTER TABLE labeled_books ADD COLUMN author_key text GENERATED ALWAYS AS (
        lower(btrim(normalize(author, NFKC)))) STORED;
      CREATE UNIQUE INDEX labeled_books_identity_idx ON labeled_books (title_key, author_key);
    `);
  }, 60_000);

  it('T1 事件键格式与列契约:导出的键与 T1 systemTaskEnqueueKey 同形', async () => {
    const outcome = await importLabelWithSystemTask(sql, {
      record: RECORD, marker: 'ready', task: { policyVersion: 'p1', sourceRevision: 'r1' },
    });
    const [task] = (await pg.query('SELECT * FROM download_tasks')).rows;
    const [label] = (await pg.query('SELECT id FROM labeled_books')).rows;
    expect(task.enqueue_key).toBe(`${label.id}:p1:r1`);
    expect(task).toMatchObject({
      requested_by: 'system', user_id: null, book_id: label.id, status: 'pending',
      policy_version: 'p1', source_revision: 'r1', source_kind: 'builtin',
      source_id: null, attempt_count: 1, lease_generation: 0, lease_owner: '',
    });
    expect(task.title).toBe('契约书');
    expect(outcome.taskId).toBe(task.id);
  });

  it('user 活动索引 / system 活动索引 / 事件索引三个唯一约束同时存在也不误伤', async () => {
    // 同一本书:先有 user 的 pending(用户手动下载),再走导入入队 system。
    const first = await importLabelWithSystemTask(sql, {
      record: RECORD, marker: 'ready', task: { policyVersion: 'p1', sourceRevision: 'r1' },
    });
    await pg.query(
      `INSERT INTO download_tasks (user_id, book_id, title, status, requested_by)
       VALUES (1, $1, '契约书', 'pending', 'user')`, [first.labeledBookId]);
    // 重放导入:事件键命中 → existing,不撞三个索引里的任何一个。
    const replay = await importLabelWithSystemTask(sql, {
      record: RECORD, marker: 'ready', task: { policyVersion: 'p1', sourceRevision: 'r1' },
    });
    expect(replay.taskOutcome).toBe('existing');
    expect((await pg.query('SELECT count(*)::int AS n FROM download_tasks')).rows[0].n).toBe(2);
  });
});
