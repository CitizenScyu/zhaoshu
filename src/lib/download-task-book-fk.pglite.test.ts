// 41-bookidfk：download_tasks.book_id → labeled_books(id) 外键（artifact schema v2）。
//
// 事故（t8fk-41-report.md）：临时库有 296 条 book_id=1..296 的系统任务（把记录序号当成
// labeled_books.id 的一次性旁路入队）。download_tasks.book_id 没有外键，这批孤儿静默入队，
// 直到 worker 抓全章后在 reserveArtifactPath 写 book_artifacts 才撞外键、只留一行原始 PG 报错。
// 本文件钉住三件事（PGlite 真库）：
//   1. v2 之后旁路插入孤儿任务在入队时就被数据库拒绝（23503），删被引用的书同样拒绝（NO ACTION）；
//   2. 迁移对存量孤儿安全：有孤儿就整批拒绝、打印计数，不删行、不半途留下 FK 或记账；dry-run 零写入；
//   3. worker 写 book_artifacts 撞外键时给出可读错误码 LABELED_BOOK_MISSING。
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_SCHEMA_VERSION, initializeArtifactSchema } from './artifact-schema';
import { ArtifactRegistryError, reserveArtifactPath } from './artifact-registry';
import { enqueueSystemDownloadTask, retryDownloadTask } from './download-task-queue';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';
import { runArtifactMigration } from '../../scripts/migrate-artifacts-prod.mjs';

type Sql = Parameters<typeof initializeArtifactSchema>[0];

// 惰性语句：与 Neon 的 transaction 批处理一致（build 时不执行，批内在同一事务里按序执行）。
// 共享夹具 createPGliteSql 的标签是立即执行的，迁移 RAISE 的路径需要真实的整批回滚语义。
function lazySql(pg: PGlite): Sql {
  const tag = (parts: TemplateStringsArray, ...params: unknown[]) => {
    const text = parts.reduce((sql, part, i) => sql + (i ? `$${i}` : '') + part, '');
    return { text, params, then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      pg.query(text, params).then(result => result.rows).then(resolve, reject) };
  };
  return Object.assign(tag, { transaction: async (build: (tx: typeof tag) => ReturnType<typeof tag>[]) => {
    const statements = build(tag);
    return pg.transaction(async tx => {
      const rows = [];
      for (const statement of statements) rows.push((await tx.query(statement.text, statement.params)).rows);
      return rows;
    });
  } }) as unknown as Sql;
}

const opened: PGlite[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(pg => pg.close())); });

/** 生产形状（auth v7 + 业务 schema + 0002），artifact schema 还没跑。 */
async function productionWithoutArtifacts(): Promise<PGlite> {
  const pg = new PGlite();
  opened.push(pg);
  await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
  await pg.exec(`INSERT INTO labeled_books(id,title,author) VALUES (297,'正身甲','作者甲'),(298,'正身乙','作者乙')`);
  return pg;
}

/** 生产当前形态：artifact 只到 v1（没有 book_id 外键、记账没有 v2）。 */
async function productionAtArtifactV1(): Promise<PGlite> {
  const pg = await productionWithoutArtifacts();
  await initializeArtifactSchema(lazySql(pg));
  await pg.exec(`ALTER TABLE download_tasks DROP CONSTRAINT IF EXISTS download_tasks_book_fk;
    DELETE FROM artifact_schema_migrations WHERE version > 1`);
  return pg;
}

const insertSystemTask = (pg: PGlite, bookId: number, key: string) => pg.query(
  `INSERT INTO download_tasks(book_id,title,author,requested_by,enqueue_key,policy_version)
   VALUES ($1,'旁路','某',$2,$3,'t5-backfill-v1') RETURNING id`, [bookId, 'system', key]);

const orphanCount = async (pg: PGlite) => ((await pg.query(`SELECT count(*)::int AS n FROM download_tasks t
  WHERE NOT EXISTS (SELECT 1 FROM labeled_books lb WHERE lb.id = t.book_id)`)).rows[0] as { n: number }).n;
const bookFk = async (pg: PGlite) => (await pg.query(`SELECT confdeltype, pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conrelid = 'download_tasks'::regclass AND conname = 'download_tasks_book_fk'`)).rows as { confdeltype: string; def: string }[];
const artifactVersions = async (pg: PGlite) =>
  (await pg.query('SELECT version FROM artifact_schema_migrations ORDER BY version')).rows.map(row => Number((row as { version: number }).version));

describe('download_tasks.book_id 外键（artifact schema v2）', () => {
  it('冷建：跑完 artifact 迁移后记账到 v2，外键 NO ACTION 指向 labeled_books(id)', async () => {
    const pg = await productionWithoutArtifacts();
    await initializeArtifactSchema(lazySql(pg));
    await initializeArtifactSchema(lazySql(pg));
    expect(ARTIFACT_SCHEMA_VERSION).toBe(2);
    expect(await artifactVersions(pg)).toEqual([1, 2]);
    // confdeltype 'a' = NO ACTION：与 book_artifacts_labeled_book_id_fkey 一致；仓内无删 labeled_books 的路径。
    expect(await bookFk(pg)).toEqual([{ confdeltype: 'a', def: 'FOREIGN KEY (book_id) REFERENCES labeled_books(id)' }]);
  }, 60_000);

  it('反例：旁路插入 book_id 不在 labeled_books 的任务（t8fk 批 A 的形态）在入队时就被拒绝', async () => {
    const pg = await productionWithoutArtifacts();
    await initializeArtifactSchema(lazySql(pg));
    await expect(insertSystemTask(pg, 1, '1:t5-backfill-v1:')).rejects.toMatchObject({ code: '23503', constraint: 'download_tasks_book_fk' });
    await expect(insertSystemTask(pg, 297, '297:t5-backfill-v1:')).resolves.toBeTruthy();
    // 被任务引用的书不能被删掉（NO ACTION），任务历史不会被级联抹掉。
    await expect(pg.query('DELETE FROM labeled_books WHERE id = 297')).rejects.toMatchObject({ code: '23503' });
  }, 60_000);

  it('入队函数：受版本管理的系统入队路径照旧，重试行沿用已校验的 book_id', async () => {
    const pg = await productionWithoutArtifacts();
    await initializeArtifactSchema(lazySql(pg));
    const sql = createPGliteSql(pg) as never;
    const noArtifact = { hasReadableArtifact: async () => false };
    await expect(enqueueSystemDownloadTask(sql, { labeledBookId: 1, policyVersion: 'p' }, noArtifact)).rejects.toThrow('labeled book not found');
    const created = await enqueueSystemDownloadTask(sql, { labeledBookId: 298, policyVersion: 'p' }, noArtifact);
    expect(created.outcome).toBe('created');
    await pg.query(`UPDATE download_tasks SET status = 'failed' WHERE id = $1`, [created.taskId]);
    const retry = await retryDownloadTask(sql, created.taskId!);
    expect((await pg.query('SELECT book_id FROM download_tasks WHERE id = $1', [retry])).rows).toEqual([{ book_id: 298 }]);
  }, 60_000);

  it('存量孤儿：initializeArtifactSchema 整批拒绝并报计数，不删行、不留外键、不记 v2', async () => {
    const pg = await productionAtArtifactV1();
    await insertSystemTask(pg, 1, '1:t5-backfill-v1:');
    await insertSystemTask(pg, 2, '2:t5-backfill-v1:');
    await insertSystemTask(pg, 297, '297:t5-backfill-v1:');
    await expect(initializeArtifactSchema(lazySql(pg))).rejects.toThrow(/download_tasks has 2 rows whose book_id is not in labeled_books/);
    expect(await orphanCount(pg)).toBe(2);
    expect((await pg.query('SELECT count(*)::int AS n FROM download_tasks')).rows).toEqual([{ n: 3 }]);
    expect(await bookFk(pg)).toEqual([]);
    expect(await artifactVersions(pg)).toEqual([1]);
    // 主会话清完孤儿后重跑即通过。
    await pg.exec('DELETE FROM download_tasks t WHERE NOT EXISTS (SELECT 1 FROM labeled_books lb WHERE lb.id = t.book_id)');
    await initializeArtifactSchema(lazySql(pg));
    expect(await artifactVersions(pg)).toEqual([1, 2]);
    expect(await bookFk(pg)).toHaveLength(1);
  }, 60_000);

  it('v2 已记账但外键被回滚掉：重跑按同一判据补外键（有孤儿同样拒绝）', async () => {
    const pg = await productionWithoutArtifacts();
    await initializeArtifactSchema(lazySql(pg));
    await pg.exec('ALTER TABLE download_tasks DROP CONSTRAINT download_tasks_book_fk');
    await insertSystemTask(pg, 5, '5:t5-backfill-v1:');
    await expect(initializeArtifactSchema(lazySql(pg))).rejects.toThrow(/download_tasks has 1 rows/);
    await pg.exec('DELETE FROM download_tasks WHERE book_id = 5');
    await initializeArtifactSchema(lazySql(pg));
    expect(await bookFk(pg)).toHaveLength(1);
    expect(await artifactVersions(pg)).toEqual([1, 2]);
  }, 60_000);
});

describe('migrate:artifacts:prod 对存量孤儿的预检', () => {
  it('dry-run：报告孤儿计数与拒绝原因，零写入', async () => {
    const pg = await productionAtArtifactV1();
    await insertSystemTask(pg, 1, '1:t5-backfill-v1:');
    await insertSystemTask(pg, 296, '296:t5-backfill-v1:');
    const report = await runArtifactMigration(createPGliteSql(pg), 'dry-run');
    expect(report.status).toBe('dry-run');
    expect(report.plan.status).toBe('refused');
    expect(report.plan.pending.map((item: { version: number }) => item.version)).toEqual([2]);
    expect(report.bookIdIntegrity).toEqual({ fkPresent: false, orphanTasks: 2, orphanBookIdMin: 1, orphanBookIdMax: 296 });
    expect(report.plan.refusals?.join('\n')).toMatch(/2 条 download_tasks 的 book_id 不在 labeled_books/);
    expect(await bookFk(pg)).toEqual([]);
    expect(await artifactVersions(pg)).toEqual([1]);
    expect(await orphanCount(pg)).toBe(2);
  }, 60_000);

  it('apply：有孤儿直接 refused、不调用迁移、不删行；清掉后 applied 到 v2', async () => {
    const pg = await productionAtArtifactV1();
    await insertSystemTask(pg, 7, '7:t5-backfill-v1:');
    const sql = createPGliteSql(pg);
    const refused = await runArtifactMigration(sql, 'apply');
    expect(refused.status).toBe('refused');
    expect(refused.after).toBeNull();
    expect(await orphanCount(pg)).toBe(1);
    expect(await artifactVersions(pg)).toEqual([1]);
    await pg.exec('DELETE FROM download_tasks WHERE book_id = 7');
    const applied = await runArtifactMigration(sql, 'apply');
    expect(applied.status).toBe('applied');
    expect(applied.after?.versions).toEqual([1, 2]);
    expect(applied.bookIdIntegrity).toEqual({ fkPresent: false, orphanTasks: 0, orphanBookIdMin: null, orphanBookIdMax: null });
    expect((await runArtifactMigration(sql, 'dry-run')).bookIdIntegrity.fkPresent).toBe(true);
  }, 60_000);
});

describe('worker 写 book_artifacts 撞外键时给可读错误码', () => {
  it('reserveArtifactPath：labeled_book_id 不存在 → ArtifactRegistryError(LABELED_BOOK_MISSING)，不再是原始 PG 报错', async () => {
    const pg = await productionWithoutArtifacts();
    await initializeArtifactSchema(lazySql(pg));
    await pg.exec(`INSERT INTO storage_repositories(id,owner,repo,branch,enabled) VALUES (1,'fixture','private-a','main',true)`);
    const attempt = reserveArtifactPath(lazySql(pg), {
      labeledBookId: 292, identityKey: 'identity-292', repositoryId: 1, branch: 'main', canonicalPath: 'books/捞尸人.txt',
    });
    await expect(attempt).rejects.toBeInstanceOf(ArtifactRegistryError);
    await expect(attempt).rejects.toMatchObject({ code: 'LABELED_BOOK_MISSING' });
    await expect(attempt).rejects.toThrow(/^LABELED_BOOK_MISSING: labeled_books id=292 不存在/);
  }, 60_000);
});
