// 41-coldbuild：artifact schema 生产入口（migrate:artifacts:prod）的参数闸门与 dry-run / apply 语义（PGlite 真库）。
import { describe, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from '../src/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import { applyMigration, ARTIFACT_TABLES, loadMigrations } from './db-migration-lib.mjs';
import { parseArtifactMigrationArgs, planArtifactMigration, readArtifactVersions, runArtifactMigration } from './migrate-artifacts-prod.mjs';
import { runAuthMigration } from './migrate-auth-prod.mjs';

describe('参数闸门：目标与确认都必须显式给出', () => {
  it.each([
    [[], /--database-url-env/],
    [['--dry-run'], /--database-url-env/],
    [['--database-url-env=', '--dry-run'], /--database-url-env/],
    [['--database-url-env=prod_url', '--dry-run'], /大写变量名/],
    [['--database-url-env=PROD_URL'], /必须且只能给一个/],
    [['--database-url-env=PROD_URL', '--dry-run', '--yes-i-mean-production'], /必须且只能给一个/],
    [['--database-url-env=PROD_URL', '--yes'], /未知参数/],
    [['--database-url-env=A', '--database-url-env=B', '--dry-run'], /只能给一次/],
    // 生产入口不得复用应用 / 测试库的连接变量（与 db-prod.mjs 同一条闸门）。
    [['--database-url-env=DATABASE_URL', '--dry-run'], /不能是 DATABASE_URL/],
    [['--database-url-env=TEST_DATABASE_URL', '--dry-run'], /不能是 TEST_DATABASE_URL/],
  ])('%j 被拒绝', (argv, message) => {
    expect(() => parseArtifactMigrationArgs(argv)).toThrow(message);
  });

  it('合法组合', () => {
    expect(parseArtifactMigrationArgs(['--database-url-env=PROD_URL', '--dry-run'])).toEqual({ envName: 'PROD_URL', mode: 'dry-run' });
    expect(parseArtifactMigrationArgs(['--yes-i-mean-production', '--database-url-env=PROD_URL'])).toEqual({ envName: 'PROD_URL', mode: 'apply' });
  });
});

describe('planArtifactMigration', () => {
  it('按缺哪个版本算待执行步骤（与 initializeArtifactSchema 逐版本判断同口径）', () => {
    expect(planArtifactMigration({ tablePresent: false, versions: [], max: null }).pending.map((item) => item.version)).toEqual([1, 2]);
    // 生产当前形态（只到 v1）：待执行的只有 v2（book_id 外键，41-bookidfk）。
    expect(planArtifactMigration({ tablePresent: true, versions: [1], max: 1 }).pending.map((item) => item.version)).toEqual([2]);
    expect(planArtifactMigration({ tablePresent: true, versions: [1, 2], max: 2 })).toEqual({ status: 'up-to-date', pending: [] });
    expect(planArtifactMigration({ tablePresent: true, versions: [1, 2, 3], max: 3 }).status).toBe('newer-than-code');
  });

  it('外键缺失且有孤儿任务时整份计划 refused（附计数与 book_id 范围）；外键已在则不看孤儿计数', () => {
    const v1 = { tablePresent: true, versions: [1], max: 1 };
    const refused = planArtifactMigration(v1, { fkPresent: false, orphanTasks: 296, orphanBookIdMin: 1, orphanBookIdMax: 296 });
    expect(refused.status).toBe('refused');
    expect(refused.refusals?.[0]).toMatch(/296 条 download_tasks 的 book_id 不在 labeled_books（book_id 范围 1\.\.296）/);
    expect(planArtifactMigration(v1, { fkPresent: false, orphanTasks: 0 }).status).toBe('pending');
    expect(planArtifactMigration(v1, { fkPresent: true, orphanTasks: 3 }).status).toBe('pending');
  });
});

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('runArtifactMigration（PGlite 真库）', () => {
  // 冷建库在跑 artifact 迁移之前的状态：0001–0003 + auth v5–v7 已有，artifact 三表都还没有。
  async function coldBuiltWithoutArtifacts(): Promise<PGliteLike> {
    const pg = new PGliteCtor!();
    await applyMigration(createPGliteClient(pg), await loadMigrations());
    await runAuthMigration(createPGliteSql(pg), 'apply');
    return pg;
  }
  const versionsOf = async (pg: PGliteLike) =>
    (await pg.query('SELECT version FROM artifact_schema_migrations ORDER BY version')).rows.map((row) => row.version);
  const tablePresent = async (pg: PGliteLike, table: string) =>
    (await pg.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [table])).rows[0].present;

  it('dry-run 只读：报告将建 artifact schema v1+v2，库一张表都没建', async () => {
    const pg = await coldBuiltWithoutArtifacts();
    const sql = createPGliteSql(pg);
    const report = await runArtifactMigration(sql, 'dry-run');
    expect(report.status).toBe('dry-run');
    expect(report.before).toEqual({ tablePresent: false, versions: [], max: null });
    expect(report.plan.pending.map((item: { version: number }) => item.version)).toEqual([1, 2]);
    expect(report.bookIdIntegrity).toEqual({ fkPresent: false, orphanTasks: 0, orphanBookIdMin: null, orphanBookIdMax: null });
    for (const table of ARTIFACT_TABLES) expect(await tablePresent(pg, table), table).toBe(false);
  }, 60_000);

  it('apply 幂等：首次 applied 到 v2，再跑 unchanged；三张表齐全', async () => {
    const pg = await coldBuiltWithoutArtifacts();
    const sql = createPGliteSql(pg);
    const first = await runArtifactMigration(sql, 'apply');
    expect(first.status).toBe('applied');
    expect(first.after?.max).toBe(2);
    for (const table of ARTIFACT_TABLES) expect(await tablePresent(pg, table), table).toBe(true);
    const second = await runArtifactMigration(sql, 'apply');
    expect(second.status).toBe('unchanged');
    expect(await versionsOf(pg)).toEqual([1, 2]);
  }, 60_000);

  it('库版本高于代码：dry-run 报 newer-than-code，apply 拒绝执行', async () => {
    const pg = await coldBuiltWithoutArtifacts();
    const sql = createPGliteSql(pg);
    await runArtifactMigration(sql, 'apply');
    await pg.query('INSERT INTO artifact_schema_migrations(version) VALUES (3)');
    expect((await runArtifactMigration(sql, 'dry-run')).plan.status).toBe('newer-than-code');
    await expect(runArtifactMigration(sql, 'apply')).rejects.toThrow(/高于代码支持/);
  }, 60_000);

  it('迁移本体就是 initializeArtifactSchema：记账表存在时它按自己的版本判断（readArtifactVersions 与之一致）', async () => {
    const pg = await coldBuiltWithoutArtifacts();
    const sql = createPGliteSql(pg);
    await runArtifactMigration(sql, 'apply');
    expect(await readArtifactVersions(sql)).toEqual({ tablePresent: true, versions: [1, 2], max: 2 });
  }, 60_000);
});
