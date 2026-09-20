// T5 有界历史补账:纯筛选 + 整批一条语句提交。PGlite 真库验证 dry-run 与 --apply 一致。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  backfillEnqueueKey,
  buildBackfillPlan,
  parseBackfillPlanJsonl,
  serializeBackfillPlanJsonl,
  submitBackfillPlan,
} from './backfill-plan';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

function adapter(pg: PGliteLike): SqlTag {
  return async (parts, ...values) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  };
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const POLICY = { policyVersion: 't5-backfill-v1', sourceRevision: '' };

maybe('T5 历史补账:dry-run 与 apply 一致', () => {
  let pg: PGliteLike;
  let sql: SqlTag;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = adapter(pg);
    await pg.exec(`
      CREATE TABLE labeled_books (
        id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT '',
        source_url text NOT NULL DEFAULT ''
      );
      CREATE TABLE download_tasks (
        id serial PRIMARY KEY, user_id integer, book_id integer NOT NULL,
        title text NOT NULL, author text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending',
        source_url text NOT NULL DEFAULT '', requested_by text NOT NULL DEFAULT 'user',
        source_kind text NOT NULL DEFAULT 'builtin', source_id text,
        source_revision text NOT NULL DEFAULT '', policy_version text NOT NULL DEFAULT '',
        enqueue_key text
      );
      CREATE UNIQUE INDEX download_tasks_system_active_book_idx ON download_tasks (book_id)
        WHERE requested_by = 'system' AND status IN ('pending', 'running');
      CREATE UNIQUE INDEX download_tasks_system_event_idx ON download_tasks (enqueue_key)
        WHERE requested_by = 'system' AND enqueue_key IS NOT NULL;
      INSERT INTO labeled_books (title, author) VALUES
        ('新书一', '作者甲'), ('新书二', '作者乙'), ('已有任务', '作者丙'), ('已有用户任务', '作者丁');
      -- 已有系统任务的书(事件键命中)→ 不该进补账清单
      INSERT INTO download_tasks (user_id, book_id, title, status, requested_by, enqueue_key, policy_version)
        VALUES (NULL, 3, '已有任务', 'done', 'system', '3:t5-backfill-v1:', 't5-backfill-v1');
      -- 该书同时还有 user 任务(用户自己的下载请求,不影响补账判断)
      INSERT INTO download_tasks (user_id, book_id, title, status, requested_by)
        VALUES (1, 3, '已有任务', 'done', 'user');
      -- 只有 user 任务的书仍然要补账(user 任务不是系统产物)
      INSERT INTO download_tasks (user_id, book_id, title, status, requested_by)
        VALUES (1, 4, '已有用户任务', 'pending', 'user');
    `);
  }, 60_000);

  it('dry-run 只筛选不写库:只有 user 任务的书仍在清单里,已有系统事件的书被排除', async () => {
    const rows = (await pg.query('SELECT id, title, author, source_url FROM labeled_books ORDER BY id'))
      .rows as { id: number; title: string; author: string; source_url: string }[];
    const skip = (await pg.query(
      `SELECT book_id AS "labeledBookId", 'task' AS reason FROM download_tasks
       WHERE requested_by = 'system'`)).rows as { labeledBookId: number; reason: 'task' }[];
    const plan = buildBackfillPlan(rows, skip, POLICY, 100);
    expect(plan.requested.map((entry) => entry.labeledBookId)).toEqual([1, 2, 4]);
    expect(plan.skipped).toEqual([{ labeledBookId: 3, reason: 'task' }]);

    const before = (await pg.query('SELECT count(*)::int AS n FROM download_tasks')).rows[0].n;
    const jsonl = serializeBackfillPlanJsonl(plan.requested);
    const parsed = parseBackfillPlanJsonl(jsonl);
    expect(parsed).toEqual(plan.requested);
    // dry-run 阶段一条任务都不该多出来。
    expect((await pg.query('SELECT count(*)::int AS n FROM download_tasks')).rows[0].n).toBe(before);
  });

  it('--apply 结果与 dry-run 清单一致:清单里的书都建了任务,已有事件的书不再建', async () => {
    const rows = (await pg.query('SELECT id, title, author, source_url FROM labeled_books ORDER BY id'))
      .rows as { id: number; title: string; author: string; source_url: string }[];
    const plan = buildBackfillPlan(rows, [{ labeledBookId: 3, reason: 'task' }], POLICY, 100);
    const result = await submitBackfillPlan(sql, plan.requested);
    expect(result.submitted).toBe(3);
    expect(result.accepted).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.tasks.map((task) => task.labeledBookId).sort()).toEqual([1, 2, 4]);

    const tasks = (await pg.query(
      `SELECT book_id, requested_by, status, enqueue_key FROM download_tasks
       WHERE requested_by = 'system' ORDER BY book_id`)).rows;
    expect(tasks.map((row) => row.book_id)).toEqual([1, 2, 3, 4]);
    expect(tasks.map((row) => row.enqueue_key)).toEqual([
      '1:t5-backfill-v1:', '2:t5-backfill-v1:', '3:t5-backfill-v1:', '4:t5-backfill-v1:',
    ]);

    // 幂等:同一清单重放,一条都不新增。
    const replay = await submitBackfillPlan(sql, plan.requested);
    expect(replay.inserted).toBe(0);
    expect(replay.accepted).toBe(3);
    expect((await pg.query(
      "SELECT count(*)::int AS n FROM download_tasks WHERE requested_by = 'system'")).rows[0].n).toBe(4);
  });

  it('清单里混入不存在的 labeled_books.id → 该条被拒,不建错任务(批内其余仍提交)', async () => {
    const plan = buildBackfillPlan(
      [{ id: 1, title: '新书一', author: '作者甲' }, { id: 999, title: '伪造书', author: '作者' }],
      [], POLICY, 100,
    );
    const result = await submitBackfillPlan(sql, plan.requested);
    expect(result.submitted).toBe(2);
    expect(result.accepted).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.tasks.map((task) => task.labeledBookId)).toEqual([1]);
    expect((await pg.query('SELECT book_id FROM download_tasks WHERE requested_by = $1 ORDER BY 1', ['system'])).rows)
      .toEqual([{ book_id: 1 }, { book_id: 3 }]);
  });

  it('事件键与 id/policy/revision 不自洽的清单(例如手改伪造)在 SQL 层被排除', async () => {
    const forged = [{
      labeledBookId: 2, title: '新书二', author: '作者乙', sourceUrl: '',
      policyVersion: 't5-backfill-v1', sourceRevision: '', sourceKind: 'builtin', sourceId: null,
      enqueueKey: '1:t5-backfill-v1:',   // 指向别的 id
    }];
    const result = await submitBackfillPlan(sql, forged);
    expect(result.accepted).toBe(0);
    expect(result.inserted).toBe(0);
    // parse 阶段同样会拒绝不自洽的键(文件入口的第二道闸)。
    expect(() => parseBackfillPlanJsonl(JSON.stringify({ ...forged[0], enqueueKey: 'oops' })))
      .toThrow(/enqueue_key/);
  });

  it('有界:limit 截断清单,排序稳定,批与批之间可续跑', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, title: `书${index + 1}` }));
    const first = buildBackfillPlan(rows, [], POLICY, 4);
    expect(first.requested.map((entry) => entry.labeledBookId)).toEqual([1, 2, 3, 4]);
    const second = buildBackfillPlan(rows, first.requested.map((entry) => ({ labeledBookId: entry.labeledBookId, reason: 'task' as const })), POLICY, 4);
    expect(second.requested.map((entry) => entry.labeledBookId)).toEqual([5, 6, 7, 8]);
    expect(backfillEnqueueKey(7, 't5-backfill-v1')).toBe('7:t5-backfill-v1:');
  });

  it('清单生成后同书出现活动系统任务时跳过该书,其余批次照常入队', async () => {
    const rows = (await pg.query('SELECT id, title, author, source_url FROM labeled_books WHERE id IN (1, 2) ORDER BY id'))
      .rows as { id: number; title: string; author: string; source_url: string }[];
    const plan = buildBackfillPlan(rows, [], POLICY, 100);
    await pg.query(
      `INSERT INTO download_tasks (book_id, title, status, requested_by, enqueue_key, policy_version)
       VALUES (1, '新书一', 'pending', 'system', '1:other-v1:r1', 'other-v1')`);
    const result = await submitBackfillPlan(sql, plan.requested);
    expect(result.inserted).toBe(1);
    expect(result.tasks.map((task) => task.labeledBookId)).toEqual([2]);
    expect((await pg.query("SELECT book_id FROM download_tasks WHERE requested_by = 'system' ORDER BY book_id")).rows)
      .toEqual([{ book_id: 1 }, { book_id: 2 }, { book_id: 3 }]);
    const replay = await submitBackfillPlan(sql, plan.requested);
    expect(replay.inserted).toBe(0);
  });
});
