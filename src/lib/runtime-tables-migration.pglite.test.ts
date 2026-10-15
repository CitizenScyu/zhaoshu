// MS-25（dr41）：migrations/0003 建出的四张表必须与运行时 initializeBusinessSchema 建出的同构。
//
// 两条路径各起一个 PGlite 真库：
//   A（迁移路径）：db:migrate 跑完整列表（含 0003）→ 四表由 0003 建；
//   B（运行时路径）：db:migrate 只跑 0003 之前的版本 → 补 auth → initializeBusinessSchema 建四表。
// 逐表比对列（名称、序号、类型、可空、默认值）、约束（名称、类型、定义）与索引（名称、定义）。
// 运行时 DDL 以后给这几张表加列/改默认值而没同步新迁移，这里会红。
//
// 同时钉住 db:check 的缺表判据（变异面）：B 的库在跑 initializeBusinessSchema 之前，四表不存在，
// evaluateSchema 必须报出这四张缺表——也就是「没有 0003 时 db:check 必须失败」。

import { beforeAll, describe, expect, it } from 'vitest';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { applyMigration, ARTIFACT_TABLES, evaluateSchema, EXPECTED_TABLES, inspectSchema, loadMigrations } from '../../scripts/db-migration-lib.mjs';
import { runAuthMigration } from '../../scripts/migrate-auth-prod.mjs';
import { assertAuthSchema } from './auth-store';

const RUNTIME_TABLES = ['app_settings', 'cron_health', 'profile_feedback_queue', 'source_admission'];
// 0005 建的三张 prefetch 生态表：同样走运行时幂等 DDL（business-schema.ts），冷建库由 0005 复刻。
const READER_SYNC_TABLES = ['reader_sync_state'];
const PREFETCH_TABLES = ['download_source_candidates', 'download_host_occupancy', 'download_source_prefetch'];

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

async function shapeOf(pg: PGliteLike, table: string) {
  const columns = (await pg.query(`
    SELECT column_name, ordinal_position, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position`, [table])).rows;
  const constraints = (await pg.query(`
    SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = $1 ORDER BY c.conname`, [table])).rows;
  const indexes = (await pg.query(`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1
    ORDER BY indexname`, [table])).rows;
  const rows = (await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  return { columns, constraints, indexes, rows };
}

maybe('0003 四表与运行时建表同构（逐列比对，真 SQL）', () => {
  let viaMigration: PGliteLike;
  let viaRuntime: PGliteLike;
  let beforeRuntimeVerdict: ReturnType<typeof evaluateSchema>;

  beforeAll(async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((item) => item.name)).toContain('0003_runtime_tables.sql');

    viaMigration = new PGliteCtor!();
    await applyMigration(createPGliteClient(viaMigration), migrations);
    await expect(assertAuthSchema(createPGliteSql(viaMigration) as never)).rejects.toThrow();
    await runAuthMigration(createPGliteSql(viaMigration), 'apply');
    await expect(assertAuthSchema(createPGliteSql(viaMigration) as never)).resolves.toBeUndefined();

    viaRuntime = new PGliteCtor!();
    const withoutRuntimeTables = migrations.filter((item) => item.version < 3);
    const runtimeClient = createPGliteClient(viaRuntime);
    await applyMigration(runtimeClient, withoutRuntimeTables);
    await runAuthMigration(createPGliteSql(viaRuntime), 'apply');
    beforeRuntimeVerdict = evaluateSchema(await inspectSchema(runtimeClient), withoutRuntimeTables);
    await initializeBusinessSchema(createPGliteSql(viaRuntime) as never);
  }, 120_000);

  it('运行期表都在 EXPECTED_TABLES 里（db:check 缺表即退出码 2）', () => {
    expect(EXPECTED_TABLES).toEqual(expect.arrayContaining([...RUNTIME_TABLES, ...PREFETCH_TABLES, ...READER_SYNC_TABLES]));
  });

  it('没有 0003 的冷建库：db:check 判不通过，缺的是运行期表、prefetch 三表与 artifact 三表', () => {
    expect(beforeRuntimeVerdict.authVersionOk).toBe(true);
    expect(beforeRuntimeVerdict.checksumOk).toBe(true);
    // 41-coldbuild：这个库同样没有 artifact schema（没跑 migrate:artifacts:prod），故缺表集合 = 运行期表 + prefetch 三表 + artifact 三表。
    expect([...beforeRuntimeVerdict.missingTables].sort()).toEqual([...RUNTIME_TABLES, ...PREFETCH_TABLES, ...READER_SYNC_TABLES, ...ARTIFACT_TABLES].sort());
    expect(beforeRuntimeVerdict.ok).toBe(false);
  });

  for (const table of [...RUNTIME_TABLES, ...PREFETCH_TABLES, ...READER_SYNC_TABLES]) {
    it(`${table}：列 / 约束 / 索引 / 种子行与运行时一致`, async () => {
      const migrated = await shapeOf(viaMigration, table);
      expect(migrated.columns.length).toBeGreaterThan(0);
      expect(migrated).toEqual(await shapeOf(viaRuntime, table));
    }, 60_000);
  }

  it('迁移建好的库再跑运行时 DDL 是空转：各表形状不变', async () => {
    const before = await Promise.all([...RUNTIME_TABLES, ...PREFETCH_TABLES, ...READER_SYNC_TABLES].map((table) => shapeOf(viaMigration, table)));
    await initializeBusinessSchema(createPGliteSql(viaMigration) as never);
    expect(await Promise.all([...RUNTIME_TABLES, ...PREFETCH_TABLES, ...READER_SYNC_TABLES].map((table) => shapeOf(viaMigration, table)))).toEqual(before);
  }, 60_000);

  it('0004 给旧行补默认代次；直接重跑迁移 SQL 和运行期 DDL 都不重置既有代次', async () => {
    const pg = new PGliteCtor!();
    try {
      const migrations = await loadMigrations();
      await applyMigration(createPGliteClient(pg), migrations.filter(({ version }) => version <= 3));
      await pg.query(`INSERT INTO cron_health (name, last_success_at) VALUES ('admission_lease', now())`);
      const migration = migrations.find(({ version }) => version === 4)!;
      await pg.exec(migration.sql);
      expect((await pg.query(`SELECT lease_generation::text AS generation FROM cron_health`)).rows)
        .toEqual([{ generation: '0' }]);
      await pg.query(`UPDATE cron_health SET lease_generation = 9007199254740993`);
      await pg.exec(migration.sql);
      await runAuthMigration(createPGliteSql(pg), 'apply');
      await initializeBusinessSchema(createPGliteSql(pg) as never);
      expect((await pg.query(`SELECT lease_generation::text AS generation FROM cron_health`)).rows)
        .toEqual([{ generation: '9007199254740993' }]);
    } finally { await pg.close(); }
  }, 60_000);
});
