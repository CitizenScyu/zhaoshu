// 冷启动版本探测（41-pollddl）：businessSchemaCurrent 两条路径的真库验收。
//
// 参照 runtime-tables-migration.pglite.test.ts 的 viaRuntime 建法：db:migrate 只跑 0003 之前的版本
// （不含运行时四表）+ migrate:auth:prod 补 auth v5-v7，此时业务表尚缺 → 探测应为 false（走整批 DDL）；
// 跑完 initializeBusinessSchema 后探测应为 true（整批 DDL 空转，可跳过）。再逐一移除/复现探测所依赖的
// 表、增量列、以及已退役旧索引，验证每个判据都是「载荷位」——缺任一即翻回 false，不会误判「已最新」。

import { beforeAll, describe, expect, it } from 'vitest';
import {
  businessSchemaCurrent,
  initializeBusinessSchema,
  BUSINESS_SCHEMA_RETIRED_RELATIONS,
} from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { applyMigration, loadMigrations } from '../../scripts/db-migration-lib.mjs';
import { runAuthMigration } from '../../scripts/migrate-auth-prod.mjs';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('businessSchemaCurrent 冷启动探测', () => {
  let pg: PGliteLike;
  let sql: ReturnType<typeof createPGliteSql>;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    const withoutRuntimeTables = (await loadMigrations()).filter((item) => item.version < 3);
    const client = createPGliteClient(pg);
    sql = createPGliteSql(pg);
    await applyMigration(client, withoutRuntimeTables);
    await runAuthMigration(sql, 'apply'); // 补 auth v5-v7；业务表仍未建
  }, 120_000);

  it('缺表路径：初始化前探测为 false（→ 会执行整批 DDL）', async () => {
    expect(await businessSchemaCurrent(sql as never)).toBe(false);
  }, 60_000);

  it('已最新路径：初始化后探测为 true（→ 整批 DDL 空转、可跳过），幂等重入仍 true', async () => {
    await initializeBusinessSchema(sql as never);
    expect(await businessSchemaCurrent(sql as never)).toBe(true);
    await initializeBusinessSchema(sql as never);
    expect(await businessSchemaCurrent(sql as never)).toBe(true);
  }, 60_000);

  it('缺任一增量列即翻回 false（列判据是载荷位）', async () => {
    await pg.query('ALTER TABLE app_settings DROP COLUMN default_model');
    expect(await businessSchemaCurrent(sql as never)).toBe(false);
    await pg.query('ALTER TABLE app_settings ADD COLUMN default_model text');
    expect(await businessSchemaCurrent(sql as never)).toBe(true);
  }, 60_000);

  it('缺任一表/索引即翻回 false（关系判据是载荷位）', async () => {
    await pg.query('DROP INDEX download_tasks_claim_idx');
    expect(await businessSchemaCurrent(sql as never)).toBe(false);
    await pg.query('CREATE INDEX download_tasks_claim_idx ON download_tasks (status, next_attempt_at, created_at, id)');
    expect(await businessSchemaCurrent(sql as never)).toBe(true);
  }, 60_000);

  it('已退役旧索引若仍存在则为 false（探测要求它已被 DROP）', async () => {
    const retired = BUSINESS_SCHEMA_RETIRED_RELATIONS[0];
    await pg.query(`CREATE UNIQUE INDEX ${retired} ON download_tasks (book_id) WHERE status IN ('pending', 'running')`);
    expect(await businessSchemaCurrent(sql as never)).toBe(false);
    await pg.query(`DROP INDEX ${retired}`);
    expect(await businessSchemaCurrent(sql as never)).toBe(true);
  }, 60_000);

  // pollddlrev-41 §1.7：单例种子行也纳入探测。表齐但 id=1 行被删 → 探测 false → 走整批 DDL，
  // 其 INSERT ... ON CONFLICT DO NOTHING 幂等补回该行 → 探测回 true。逐张单例表各验一遍。
  it('表齐但单例行被删 → 探测 false，执行整批 DDL 后行被幂等补回、探测回 true', async () => {
    for (const table of ['shuyuan_meta', 'app_settings']) {
      await pg.query(`DELETE FROM ${table} WHERE id = 1`);
      expect(await businessSchemaCurrent(sql as never), `${table} 缺行应为 false`).toBe(false);
      await initializeBusinessSchema(sql as never); // 模拟 ensureSchema 走 DDL 分支
      const n = (await pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = 1`)).rows[0].n;
      expect(n, `${table} id=1 行应被补回`).toBe(1);
      expect(await businessSchemaCurrent(sql as never), `${table} 补回后应为 true`).toBe(true);
    }
  }, 60_000);
});
