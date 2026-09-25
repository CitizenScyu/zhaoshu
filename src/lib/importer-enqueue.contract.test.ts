// T5 兼容性证明:不用 T1 实现文件,只用其冻结契约(列 + 事件键)验证两件事——
//   1. T1 的「同事件重放返回 existing」在导入侧同语义;
//   2. T1 v7 的活动索引/事件索引在本模块语句下不产生 23505 误伤。
// 这里刻意**只写 SQL 文本**,不 import t1-worktree 的任何文件(避免合并冲突)。

import { beforeEach, describe, expect, it } from 'vitest';
import { importLabelWithSystemTask, type ImporterSql } from './importer-enqueue';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';

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
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
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
