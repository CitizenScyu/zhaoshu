// 灾备重建链路的端到端真库验收（41-COLD-SCHEMA，dr41 改为全链路）。
//
// 冷建库的正式顺序是 `db:migrate`（0001→0003）→ `migrate:auth:prod`（initializeAuthSchema 补 auth v5-v7）
// → 运行时 ensureSchema（assertAuthSchema + initializeBusinessSchema）。本文件用 PGlite 真执行这条链，
// 每一步都走仓内真代码（迁移 runner、db:check 判定、生产 auth 迁移入口），不 mock 任何 SQL。
//
// 此前的版本只测到「0001 执行后 assertAuthSchema 放行」就停了：3c7a20f 把 0001 记账改到 v7，闸门
// 确实放行，但 v5-v7 的 DDL 从未执行，下一步 initializeBusinessSchema 就报
// `column "user_id" does not exist`——冷建库照样全站不可用，测试却是绿的。所以这里必须一路测到
// 业务 schema 初始化成功为止。
//
// 不变量：
// 1. 已发布迁移的摘要冻结（PUBLISHED_CHECKSUMS）——改已发布文件的字节会让生产 db:check/db:migrate 拒绝。
// 2. 只跑 db:migrate 时 db:check 判不通过（auth 只记到 v4），且原因只有 authVersionOk。
// 3. 跑完 migrate:auth:prod 后 db:check 通过，ensureSchema 的两步都成功。
// 4. 闸门单向：库版本 8 放行，降到 6 抛 AuthSchemaRequiredError。

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertAuthSchema, AuthSchemaRequiredError } from '@/lib/auth-store';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { applyMigration, checksumOf, evaluateSchema, inspectSchema, loadMigrations, PUBLISHED_CHECKSUMS } from '../../scripts/db-migration-lib.mjs';
import { runAuthMigration } from '../../scripts/migrate-auth-prod.mjs';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

it('已发布迁移的摘要与冻结值一致（改已发布文件的字节会让生产拒绝迁移）', async () => {
  const migrations = await loadMigrations();
  for (const [version, checksum] of Object.entries(PUBLISHED_CHECKSUMS)) {
    expect(migrations.find((item) => item.version === Number(version))?.checksum, `v${version}`).toBe(checksum);
  }
}, 60_000);

it('CRLF 检出不改变已发布摘要（Windows core.autocrlf=true 的工作区）', async () => {
  const migrations = await loadMigrations();
  for (const [version, checksum] of Object.entries(PUBLISHED_CHECKSUMS)) {
    const lf = migrations.find((item) => item.version === Number(version))!.sql;
    expect(checksumOf(lf.replaceAll('\n', '\r\n')), `v${version}`).toBe(checksum);
  }
  // 盘上字节也钉成 LF：不经 normalizeSqlText 直接读文件的工具（psql -f 等）拿到的是同一份字节。
  expect(await readFile(new URL('../../.gitattributes', import.meta.url), 'utf8')).toMatch(/^\/migrations\/\*\.sql\s+text\s+eol=lf\s*$/m);
}, 60_000);

maybe('冷建库灾备链路（db:migrate → migrate:auth:prod → ensureSchema，全真 SQL）', () => {
  let pg: PGliteLike;
  let client: ReturnType<typeof createPGliteClient>;
  let sql: ReturnType<typeof createPGliteSql>;
  let migrations: Awaited<ReturnType<typeof loadMigrations>>;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    client = createPGliteClient(pg);
    sql = createPGliteSql(pg);
    migrations = await loadMigrations();
  }, 60_000);

  it('db:migrate 后全部版本已记账、业务表齐全，但 auth 只到 v4 → db:check 不通过', async () => {
    const applied = await applyMigration(client, migrations);
    expect(applied.versions.map((item) => item.status)).toEqual(migrations.map(() => 'applied'));
    const verdict = evaluateSchema(await inspectSchema(client), migrations);
    expect(verdict.missingTables).toEqual([]);
    expect(verdict.checksumOk).toBe(true);
    expect(verdict.authVersion).toBe(4);
    expect(verdict.authVersionOk).toBe(false);
    expect(verdict.ok).toBe(false);
    await expect(assertAuthSchema(sql as never)).rejects.toBeInstanceOf(AuthSchemaRequiredError);
  }, 60_000);

  it('migrate:auth:prod 补齐 v5-v7 后 db:check 通过', async () => {
    const report = await runAuthMigration(sql, 'apply');
    expect(report.plan.pending.map((item: { version: number }) => item.version)).toEqual([5, 6, 7]);
    expect(report.status).toBe('applied');
    expect(report.after?.max).toBe(7);
    expect(evaluateSchema(await inspectSchema(client), migrations).ok).toBe(true);
  }, 60_000);

  it('ensureSchema 两步都成功（assertAuthSchema 放行 + initializeBusinessSchema 不报缺列）', async () => {
    await expect(assertAuthSchema(sql as never)).resolves.toBeUndefined();
    await expect(initializeBusinessSchema(sql as never)).resolves.toBeUndefined();
    const columns = (await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'download_tasks'`)).rows.map((row) => row.column_name);
    expect(columns).toEqual(expect.arrayContaining(['user_id', 'requested_by', 'lease_generation']));
    expect((await pg.query(`SELECT to_regclass('registration_invites') IS NOT NULL AS present`)).rows).toEqual([{ present: true }]);
    // 业务初始化之后重跑迁移与 db:check：全部 unchanged 且仍通过（生产形态的重入）。
    const again = await applyMigration(client, migrations);
    expect(again.status).toBe('unchanged');
    expect(evaluateSchema(await inspectSchema(client), migrations).ok).toBe(true);
  }, 60_000);

  it('把库版本推到 8 后 assertAuthSchema 仍放行（库新代码旧不 503）', async () => {
    await pg.query('INSERT INTO auth_schema_migrations(version) VALUES (8)');
    await expect(assertAuthSchema(sql as never)).resolves.toBeUndefined();
  }, 60_000);

  it('把库版本降到 6 后 assertAuthSchema 抛 AuthSchemaRequiredError', async () => {
    await pg.query('DELETE FROM auth_schema_migrations WHERE version > 6');
    await expect(assertAuthSchema(sql as never)).rejects.toBeInstanceOf(AuthSchemaRequiredError);
  }, 60_000);
});
