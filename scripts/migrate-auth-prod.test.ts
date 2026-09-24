// MS-24（dr41）：生产 auth 迁移入口的参数闸门与 dry-run / apply 语义（PGlite 真库）。
import { describe, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from '../src/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import { applyMigration, loadMigrations } from './db-migration-lib.mjs';
import { parseAuthMigrationArgs, planAuthMigration, readDatabaseUrl, runAuthMigration } from './migrate-auth-prod.mjs';

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
  ])('%j 被拒绝', (argv, message) => {
    expect(() => parseAuthMigrationArgs(argv)).toThrow(message);
  });

  it('合法组合', () => {
    expect(parseAuthMigrationArgs(['--database-url-env=PROD_URL', '--dry-run'])).toEqual({ envName: 'PROD_URL', mode: 'dry-run' });
    expect(parseAuthMigrationArgs(['--yes-i-mean-production', '--database-url-env=PROD_URL'])).toEqual({ envName: 'PROD_URL', mode: 'apply' });
  });
});

describe('连接串读取：只读指定变量，不回退、不外泄', () => {
  const fake = 'postgresql://u:not-a-secret@ep-fake-123.example.test/db';
  it('指定变量为空时不回退 DATABASE_URL', () => {
    expect(() => readDatabaseUrl('PROD_URL', { DATABASE_URL: fake })).toThrow(/不会回退到 DATABASE_URL/);
  });
  it('非 PostgreSQL URL 被拒绝，错误信息不含原值', () => {
    expect(() => readDatabaseUrl('PROD_URL', { PROD_URL: 'mysql://u:p@h/db' })).toThrow(/必须是 PostgreSQL URL/);
    let message = '';
    try { readDatabaseUrl('PROD_URL', { PROD_URL: 'not-a-url-secret' }); } catch (error) { message = String(error); }
    expect(message).toMatch(/不是有效的连接 URL/);
    expect(message).not.toContain('not-a-url-secret');
  });
  it('只把 host 交给输出', () => {
    expect(readDatabaseUrl('PROD_URL', { PROD_URL: ` ${fake} ` })).toEqual({ connectionString: fake, host: 'ep-fake-123.example.test' });
  });
});

describe('planAuthMigration', () => {
  it('按缺哪个版本算待执行步骤（与 initializeAuthSchema 逐版本判断同口径）', () => {
    expect(planAuthMigration({ tablePresent: true, versions: [1, 2, 3, 4], max: 4 }).pending.map((item) => item.version)).toEqual([5, 6, 7]);
    expect(planAuthMigration({ tablePresent: false, versions: [], max: null }).pending).toHaveLength(7);
    expect(planAuthMigration({ tablePresent: true, versions: [1, 2, 3, 4, 5, 6, 7], max: 7 })).toEqual({ status: 'up-to-date', pending: [] });
    expect(planAuthMigration({ tablePresent: true, versions: [1, 2, 3, 4, 5, 6, 7, 8], max: 8 }).status).toBe('newer-than-code');
  });
});

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('runAuthMigration（PGlite 真库）', () => {
  async function coldBuilt(): Promise<PGliteLike> {
    const pg = new PGliteCtor!();
    await applyMigration(createPGliteClient(pg), await loadMigrations());
    return pg;
  }
  const versionsOf = async (pg: PGliteLike) =>
    (await pg.query('SELECT version FROM auth_schema_migrations ORDER BY version')).rows.map((row) => row.version);

  it('dry-run 只读：报告当前版本与待执行步骤，库不变', async () => {
    const pg = await coldBuilt();
    const report = await runAuthMigration(createPGliteSql(pg), 'dry-run');
    expect(report.status).toBe('dry-run');
    expect(report.before).toEqual({ tablePresent: true, versions: [1, 2, 3, 4], max: 4 });
    expect(report.plan.pending.map((item: { version: number }) => item.version)).toEqual([5, 6, 7]);
    expect(await versionsOf(pg)).toEqual([1, 2, 3, 4]);
    expect((await pg.query(`SELECT to_regclass('registration_invites') IS NOT NULL AS present`)).rows).toEqual([{ present: false }]);
  }, 60_000);

  it('空库 dry-run：没有版本表，七个版本全部待执行', async () => {
    const report = await runAuthMigration(createPGliteSql(new PGliteCtor!()), 'dry-run');
    expect(report.before.tablePresent).toBe(false);
    expect(report.plan.pending).toHaveLength(7);
  }, 60_000);

  it('apply 幂等：首次 applied 到 v7，再跑 unchanged', async () => {
    const pg = await coldBuilt();
    const sql = createPGliteSql(pg);
    const first = await runAuthMigration(sql, 'apply');
    expect(first.status).toBe('applied');
    expect(first.after?.max).toBe(7);
    const second = await runAuthMigration(sql, 'apply');
    expect(second.status).toBe('unchanged');
    expect(await versionsOf(pg)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  }, 60_000);

  it('库版本高于代码：dry-run 报 newer-than-code，apply 拒绝执行', async () => {
    const pg = await coldBuilt();
    const sql = createPGliteSql(pg);
    await runAuthMigration(sql, 'apply');
    await pg.query('INSERT INTO auth_schema_migrations(version) VALUES (8)');
    expect((await runAuthMigration(sql, 'dry-run')).plan.status).toBe('newer-than-code');
    await expect(runAuthMigration(sql, 'apply')).rejects.toThrow(/高于代码支持/);
  }, 60_000);
});
