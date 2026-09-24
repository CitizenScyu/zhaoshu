import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimDownloadTask,
  enqueueSystemDownloadTask,
  finishDownloadTask,
  heartbeatDownloadTask,
  retryDownloadTask,
  updateDownloadTaskProgress,
} from './download-task-queue';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createProductionSchemaAtAuthV6, seedV6MemberUser, upgradeToAuthV7 } from './fixtures/production-schema';
import { createPGliteSql } from './fixtures/pglite-sql';
import { reclaimStaleTasks } from './download-task-reclaim';

type Statement = { text: string; params: unknown[] };
type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

function queryTag(pg: PGliteLike) {
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  }) as SqlTag & { transaction: (builder: (tx: (parts: TemplateStringsArray, ...values: unknown[]) => Statement) => Statement[]) => Promise<unknown[]> };
  sql.transaction = async (builder) => {
    const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
      let text = '';
      const params: unknown[] = [];
      parts.forEach((part, index) => {
        text += part;
        if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
      });
      return { text, params };
    };
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
  return sql;
}

// 生产 schema 底座（auth v1–v6 + 业务表 + 0002 身份键）。由 fixtures/production-schema
// 复用生产初始化入口，**不手抄 DDL**：手抄本会漂移，漂移过的 title_key 生成式让《余生》类
// 漏匹配在测试里系统性隐形（2026-09-23 复核），users 单列则让权限位与身份冲突回归不可见。
async function bootstrapV6(pg: PGliteLike): Promise<void> {
  await createProductionSchemaAtAuthV6(createPGliteSql(pg) as never, pg);
  // 生产 users 有 CHECK（owner 固定 id=1、非 owner 必须 hash+role=member）与权限位列。
  // 旧夹具只建 `users (id integer PRIMARY KEY)`，因此权限位可以随便填也不报错。
  await seedV6MemberUser(pg);
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('v7 下载队列：迁移、幂等入队与租约 fencing', () => {
  let pg: PGliteLike;
  let sql: ReturnType<typeof queryTag>;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = queryTag(pg);
    await bootstrapV6(pg);
    await upgradeToAuthV7(sql as never);
    await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url)
       VALUES (2, 10, '旧用户任务', '旧作者', 'done', 'https://example.test/10')`,
    );
  }, 60_000);

  it('把真实 v6 形状升级到 v7，旧用户行不变，身份 CHECK 与 users 外键同时生效', async () => {
    expect((await pg.query('SELECT max(version)::int AS version FROM auth_schema_migrations')).rows[0].version).toBe(7);
    expect((await pg.query(
      'SELECT user_id, requested_by, attempt_count, lease_generation FROM download_tasks WHERE book_id = 10',
    )).rows[0]).toMatchObject({ user_id: 2, requested_by: 'user', attempt_count: 1, lease_generation: 0 });

    await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, requested_by, policy_version, enqueue_key)
       VALUES (NULL, 11, '系统任务', 'system', 'p1', '11:p1:')`,
    );
    await expect(pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, requested_by)
       VALUES (NULL, 12, '坏用户任务', 'user')`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, requested_by)
       VALUES (2, 13, '坏系统任务', 'system')`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, requested_by)
       VALUES (999, 14, '孤儿用户任务', 'user')`,
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('同连接重复系统事件入队只留下一个 pending，活动系统索引覆盖 NULL user_id 陷阱', async () => {
    const [{ id }] = (await pg.query(
      `INSERT INTO labeled_books(title, author, source_url) VALUES ('队列书', '作者', 'https://example.test/book') RETURNING id`,
    )).rows as { id: number }[];
    const artifacts = { hasReadableArtifact: async () => false };
    const [first, second] = await Promise.all([
      enqueueSystemDownloadTask(sql as never, { labeledBookId: id, policyVersion: 'p1', sourceRevision: 'r1' }, artifacts),
      enqueueSystemDownloadTask(sql as never, { labeledBookId: id, policyVersion: 'p1', sourceRevision: 'r1' }, artifacts),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['created', 'existing']);
    expect(first.taskId).toBe(second.taskId);
    expect((await pg.query(
      `SELECT count(*)::int AS n FROM download_tasks
       WHERE requested_by = 'system' AND book_id = $1 AND status = 'pending'`, [id],
    )).rows[0].n).toBe(1);

    await expect(pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, status, requested_by, policy_version, enqueue_key)
       VALUES (NULL, $1, '另一事件同书', 'running', 'system', 'p2', $2)`, [id, `${id}:p2:r2`],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['empty snapshot', '23505'] as const)('同事件赢家中途提交后返回 existing：注入 %s', async race => {
    const [{ id }] = (await pg.query(
      `INSERT INTO labeled_books(title) VALUES ('中途提交合成书') RETURNING id`,
    )).rows as { id: number }[];
    const input = { labeledBookId: id, policyVersion: 'p1', sourceRevision: 'r1' };
    const artifacts = { hasReadableArtifact: async () => false };
    let winnerId: number | null = null;
    let statements = 0;
    const racingSql: SqlTag = async (parts, ...values) => {
      if (++statements === 1) {
        expect(parts.join('?')).toContain('ON CONFLICT');
        expect((await pg.query("SELECT id FROM download_tasks WHERE requested_by='system'")).rows).toEqual([]);
        await pg.exec('BEGIN');
        const winner = await enqueueSystemDownloadTask(sql as never, input, artifacts);
        expect(winner.outcome).toBe('created');
        winnerId = winner.taskId;
        await pg.exec('COMMIT');
        // PGlite is single-session: inject the losing statement's result at the
        // query boundary, after the winner commits. Subsequent SELECT is real SQL.
        if (race === '23505') throw Object.assign(new Error('injected unique conflict'), { code: '23505' });
        return [];
      }
      return sql(parts, ...values);
    };
    const result = await enqueueSystemDownloadTask(racingSql as never, input, artifacts);
    expect(result).toEqual({ outcome: 'existing', taskId: winnerId });
    expect(statements).toBe(2);
    expect((await pg.query("SELECT id FROM download_tasks WHERE requested_by='system'")).rows)
      .toEqual([{ id: winnerId }]);
  });

  it('不存在的书仍报错，不创建任务', async () => {
    await expect(enqueueSystemDownloadTask(sql as never,
      { labeledBookId: 999, policyVersion: 'p1' }, { hasReadableArtifact: async () => false }))
      .rejects.toThrow('labeled book not found');
    expect((await pg.query("SELECT id FROM download_tasks WHERE requested_by='system'")).rows).toEqual([]);
  });

  it('已有可读产物时通过注入接缝跳过，不创建任务', async () => {
    const [{ id }] = (await pg.query(
      `INSERT INTO labeled_books(title, author, source_url) VALUES ('已有产物', '作者', 'https://example.test/a') RETURNING id`,
    )).rows as { id: number }[];
    const result = await enqueueSystemDownloadTask(
      sql as never,
      { labeledBookId: id, policyVersion: 'p1' },
      { hasReadableArtifact: async () => true },
    );
    expect(result).toEqual({ outcome: 'artifact_exists', taskId: null });
    expect((await pg.query('SELECT count(*)::int AS n FROM download_tasks WHERE book_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('旧 generation 无法心跳、推进或完成被新租约接管的 attempt', async () => {
    const [{ id }] = (await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, status, requested_by)
       VALUES (2, 40, 'fencing', 'pending', 'user') RETURNING id`,
    )).rows as { id: number }[];
    const oldLease = await claimDownloadTask(sql as never, 'worker-old');
    expect(oldLease).toMatchObject({ id, leaseGeneration: 1, leaseOwner: 'worker-old', attemptCount: 1 });
    await pg.query(
      `UPDATE download_tasks
       SET status = 'pending', lease_generation = lease_generation + 1, lease_owner = '', attempt_count = attempt_count + 1
       WHERE id = $1`, [id],
    );
    const newLease = await claimDownloadTask(sql as never, 'worker-new');
    expect(newLease).toMatchObject({ id, leaseGeneration: 3, leaseOwner: 'worker-new', attemptCount: 2 });
    expect(await heartbeatDownloadTask(sql as never, oldLease!)).toBe(false);
    expect(await updateDownloadTaskProgress(sql as never, oldLease!, { chaptersDone: 9, chaptersTotal: 9, charsTotal: 999 })).toBe(false);
    expect(await finishDownloadTask(sql as never, oldLease!, { status: 'done' })).toBe(false);
    expect(await finishDownloadTask(sql as never, newLease!, { status: 'done' })).toBe(true);
    expect((await pg.query('SELECT status, lease_generation, attempt_count FROM download_tasks WHERE id = $1', [id])).rows[0])
      .toMatchObject({ status: 'done', lease_generation: 3, attempt_count: 2 });
  });

  it('reclaim 只置 failed、不复活，并撤销旧 generation/owner', async () => {
    const [{ id }] = (await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, status, requested_by, updated_at)
       VALUES (2, 41, 'stale reclaim', 'pending', 'user', now() - interval '2 hours') RETURNING id`,
    )).rows as { id: number }[];
    const lease = await claimDownloadTask(sql as never, 'stale-worker');
    await pg.query("UPDATE download_tasks SET updated_at = now() - interval '2 hours' WHERE id = $1", [id]);
    await reclaimStaleTasks(sql as never);
    expect((await pg.query(
      'SELECT status, lease_generation, lease_owner FROM download_tasks WHERE id = $1', [id],
    )).rows[0]).toMatchObject({ status: 'failed', lease_generation: 2, lease_owner: '' });
    expect(await finishDownloadTask(sql as never, lease!, { status: 'done' })).toBe(false);
  });

  // B2-03：崩溃在发布中途的 system 任务没有人替它点重试，reclaim 必须把它放回队列（有界、退避、fencing）。
  async function staleSystemTask(bookId: number, attemptCount: number) {
    const [{ id }] = (await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, status, requested_by, policy_version, enqueue_key, attempt_count)
       VALUES (NULL, $1, '崩溃中途', 'pending', 'system', 'p1', $2, $3) RETURNING id`,
      [bookId, `${bookId}:p1:`, attemptCount],
    )).rows as { id: number }[];
    const lease = await claimDownloadTask(sql as never, 'crashed-worker');
    expect(lease).toMatchObject({ id, attemptCount });
    await pg.query("UPDATE download_tasks SET updated_at = now() - interval '2 hours' WHERE id = $1", [id]);
    return { id, lease: lease! };
  }

  const taskState = async (id: number) => (await pg.query(
    `SELECT status, attempt_count, lease_generation, lease_owner, error,
            round(extract(epoch FROM (next_attempt_at - now())) / 60)::int AS delay_min
     FROM download_tasks WHERE id = $1`, [id],
  )).rows[0];

  it('B2-03 reclaim：system 任务放回 pending + attempt_count+1 + 15m 退避，旧租约失效，到期前不可领', async () => {
    const { id, lease } = await staleSystemTask(60, 1);
    await reclaimStaleTasks(sql as never);
    expect(await taskState(id)).toMatchObject({
      status: 'pending', attempt_count: 2, lease_generation: 2, lease_owner: '', delay_min: 15,
    });
    expect((await taskState(id)).error).toContain('退避后重新入队');
    // 僵尸 worker 的租约条件写全部失败：不会与重领者并发发布。
    expect(await heartbeatDownloadTask(sql as never, lease)).toBe(false);
    expect(await finishDownloadTask(sql as never, lease, { status: 'failed' })).toBe(false);
    // 退避未到期不可领；到期后由 claim 重领（generation 再递增）。
    expect(await claimDownloadTask(sql as never, 'next-worker')).toBeNull();
    await pg.query("UPDATE download_tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);
    expect(await claimDownloadTask(sql as never, 'next-worker')).toMatchObject({ id, leaseGeneration: 3, attemptCount: 2 });
  });

  it('B2-03 reclaim：退避与 sourceRetryDelayMs 同阶梯（第 3 次 ⇒ 1h，第 8 次 ⇒ 封顶 6h）', async () => {
    const third = await staleSystemTask(61, 3);
    await reclaimStaleTasks(sql as never);
    expect(await taskState(third.id)).toMatchObject({ status: 'pending', attempt_count: 4, delay_min: 60 });
    await pg.query("UPDATE download_tasks SET status = 'done' WHERE id = $1", [third.id]);
    const eighth = await staleSystemTask(62, 8);
    await reclaimStaleTasks(sql as never);
    expect(await taskState(eighth.id)).toMatchObject({ status: 'pending', attempt_count: 9, delay_min: 360 });
  });

  it('B2-03 reclaim：达上限（attempt_count=16）的 system 任务落 failed，不再入队', async () => {
    const { id } = await staleSystemTask(63, 16);
    await reclaimStaleTasks(sql as never);
    expect(await taskState(id)).toMatchObject({
      status: 'failed', attempt_count: 16, lease_generation: 2, lease_owner: '', delay_min: null,
    });
    expect((await taskState(id)).error).not.toContain('重新入队');
  });

  it('重试新建 attempt 行并记录 retry_of，不复活旧终态行', async () => {
    const [{ id }] = (await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, status, requested_by)
       VALUES (2, 45, '新 attempt', 'failed', 'user') RETURNING id`,
    )).rows as { id: number }[];
    const retryId = await retryDownloadTask(sql as never, id);
    expect(retryId).not.toBe(id);
    expect((await pg.query(
      'SELECT id, status, attempt_count, retry_of FROM download_tasks WHERE id IN ($1, $2) ORDER BY id', [id, retryId],
    )).rows).toEqual([
      { id, status: 'failed', attempt_count: 1, retry_of: null },
      { id: retryId, status: 'pending', attempt_count: 2, retry_of: id },
    ]);
  });

  it('模拟 zhaoshu-books 现有 UPDATE 子查询仍能领取 user pending 行', async () => {
    const [{ id }] = (await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, status, requested_by)
       VALUES (2, 50, '旧 worker 用户任务', 'pending', 'user') RETURNING id`,
    )).rows as { id: number }[];
    const rows = await pg.query(
      `UPDATE download_tasks SET status = 'running', updated_at = now()
       WHERE id = (
         SELECT id FROM download_tasks WHERE status = 'pending'
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING id, user_id, requested_by`,
    );
    expect(rows.rows[0]).toMatchObject({ id, user_id: 2, requested_by: 'user' });
  });
});
