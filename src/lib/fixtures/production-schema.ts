// 测试夹具的生产 schema **唯一来源**。
//
// 为什么要有这个文件：以前三处 fixture 各自手抄生产 DDL（users / labeled_books /
// download_tasks 的建表语句与 title_key 生成式），手抄的那份会漂移。2026-09-23 复核时
// 查出 title_key 少了 0002 迁移里剥《》那一层 regexp_replace —— 于是《余生》与「余生」
// 在测试里匹配不上、在生产里匹配得上，**漏匹配类回归在测试里系统性隐形**。
//
// 这里改为直接调用生产的初始化入口（auth-store / business-schema / artifact-schema）并
// 原样执行 0002 身份键迁移：测试的建表路径与生产同源。生产改了 DDL，测试自动跟上，
// 不存在第二份可漂的抄本。
//
// 🔴 本文件**不含任何手写的生产业务建表语句**（没有 CREATE TABLE users / labeled_books，
// 没有 GENERATED ALWAYS AS）。这是刻意的：一旦这里出现建表语句，就又造了一份会漂的副本。
// 反向闸门见 src/lib/fixture-schema-sync.test.ts —— 它把「回退成手抄」挡成红灯。
//
// 只读迁移文件内容，**绝不改迁移文件本身**。

import { readFileSync } from 'node:fs';
import { initializeAuthSchema, authSchemaV7Statement } from '../auth-store';
import { initializeBusinessSchema } from '../business-schema';
import { initializeArtifactSchema } from '../artifact-schema';

type ProductionSql = Parameters<typeof initializeAuthSchema>[0];
type Exec = (statement: string) => Promise<unknown>;

/** 0002 身份键迁移的盘上位置。夹具读它，不改它。 */
export const IDENTITY_KEY_MIGRATION = new URL('../../../migrations/0002_identity_key.sql', import.meta.url);

/** 原样读回迁移文本；不解析、不改写，避免再产生一份语义副本。 */
export function identityKeyMigrationSql(): string {
  return readFileSync(IDENTITY_KEY_MIGRATION, 'utf8');
}

/**
 * 生产 schema 底座：auth v1–v7（真实 users 列 + 权限位 CHECK + owner 身份 CHECK +
 * registration_invites / users_created_via_invite_fk + v7 下载任务列与租约 fencing）
 * + 业务 schema（labeled_books / books / download_tasks…）+ 0002 身份键生成列与唯一索引。
 *
 * `exec` 由调用方提供（测试里就是 `statement => pg.exec(statement)`）：0002 是整段 SQL
 * 文本，PGlite 的 exec 能吃多语句，而 Neon HTTP 的标签查询不能。
 */
export async function createProductionSchema(sql: ProductionSql, exec: Exec): Promise<void> {
  await initializeAuthSchema(sql);
  await initializeBusinessSchema(sql);
  // 0002 是显式迁移（文件头写明刻意不进 ensureSchema）。身份键正是测试要验证的真语义，
  // 所以按生产的执行顺序原样跑它：建新列/新索引 → 删旧索引。
  await exec(identityKeyMigrationSql());
}

/** auth v6 → v7：下载任务列、身份 CHECK、租约 fencing、系统活动/事件索引。 */
export async function upgradeToAuthV7(sql: ProductionSql): Promise<void> {
  await sql.transaction((tx) => [authSchemaV7Statement(tx as never)]);
}

/** artifact 注册表（storage_repositories / book_artifacts）与 v1 幂等修复；v2 起含 download_tasks.book_id → labeled_books(id) 外键（41-bookidfk）。 */
export async function createArtifactSchema(sql: ProductionSql): Promise<void> {
  await initializeArtifactSchema(sql);
}

// authSchemaV7Statement 的**全部**副作用（列 + 约束 + 索引）。把生产 schema 降级成 v6
// 形状时按这份清单回落；清单由 fixture-schema-sync.test.ts 的隔离闸门核对，漏一项即红灯。
// 这里列的是 v7 相对于 v5/v6 新增的东西，**不是**业务建表语句。
const V7_COLUMNS = [
  'requested_by', 'source_kind', 'source_id', 'source_revision', 'policy_version',
  'enqueue_key', 'attempt_count', 'retry_of', 'next_attempt_at',
  'lease_generation', 'lease_owner', 'artifact_id',
];
const V7_CONSTRAINTS = [
  'download_tasks_requested_by_check', 'download_tasks_request_identity_check',
  'download_tasks_attempt_count_check', 'download_tasks_lease_generation_check',
  'download_tasks_retry_of_fk',
];
const V7_INDEXES = [
  'download_tasks_system_active_book_idx', 'download_tasks_system_event_idx',
  'download_tasks_claim_idx',
];

/**
 * 生产 schema，但 download_tasks 停在 **auth v6 形状**（没有 v7 的列/约束/索引）。
 *
 * 用途：测的就是「v6 → v7」这次升级本身。若直接给 v7 世界，被测行为消失、断言恒真
 * （迁移就算不再加列也照样绿）—— 那比 fixture 漂移更糟。
 *
 * 实现方式：先跑完整生产 schema，再把 v7 那一层**回落**掉。降级只动 download_tasks，
 * users / labeled_books / books / registration_invites 全部保持生产真实结构 —— 也就是
 * 本夹具对「权限位与身份冲突回归不可见」这个缺陷的修复点。
 */
export async function createProductionSchemaAtAuthV6(sql: ProductionSql, pg: { exec(sql: string): Promise<unknown> }): Promise<void> {
  await createProductionSchema(sql, statement => pg.exec(statement));
  const dropColumns = V7_COLUMNS.map(name => `ALTER TABLE download_tasks DROP COLUMN IF EXISTS ${name}`).join(';\n');
  const dropConstraints = V7_CONSTRAINTS.map(name => `ALTER TABLE download_tasks DROP CONSTRAINT IF EXISTS ${name}`).join(';\n');
  const dropIndexes = V7_INDEXES.map(name => `DROP INDEX IF EXISTS ${name}`).join(';\n');
  await pg.exec(`${dropConstraints};\n${dropIndexes};\n${dropColumns}`);
  // 把 v7 的记账行抹掉，让 authSchemaV7Statement 重新执行一次。
  await pg.exec(`DELETE FROM auth_schema_migrations WHERE version = 7`);
}

/**
 * v6 世界的标准用户种子：生产 owner（id=1 由 initializeAuthSchema 写入）+ 一个 member（id=2）。
 *
 * 两个 v6 夹具（下载队列测试与 T6 下载 API 测试）都需要同一个 member 行来承接
 * download_tasks.user_id 外键。收敛到本函数，避免两份 INSERT 漂移——权限位写错会被
 * 生产 users CHECK 拒绝，手抄时却没人拦。member 权限位刻意只给 can_find：生产 CHECK
 * （NOT can_read OR can_find / NOT can_download OR (can_find AND can_read)）必须成立。
 */
export async function seedV6MemberUser(pg: { query(text: string, params?: unknown[]): Promise<unknown> }): Promise<void> {
  await pg.query(`
    INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
    VALUES (2, 'member2', 'hash', 'member', true, false, false)
    ON CONFLICT (id) DO NOTHING
  `);
}

export async function seedProductionMembers(
  pg: { query(text: string, params?: unknown[]): Promise<unknown> }, count: number,
): Promise<void> {
  await pg.query(`
    INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
    SELECT id, 'member' || id, 'hash', 'member', true, false, false
    FROM generate_series(2, $1::int) AS id
  `, [count]);
}

/** 一张表的结构指纹：列（名/类型/可空/默认）、索引、约束。用于 fixture 与生产的结构齐性断言。 */
export async function tableFingerprint(
  pg: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  table: string,
): Promise<string> {
  const columns = (await pg.query(
    `SELECT column_name, data_type, is_nullable, COALESCE(column_default, '') AS column_default
     FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [table],
  )).rows;
  const indexes = (await pg.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`, [table],
  )).rows;
  const constraints = (await pg.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE conrelid = ('public.' || $1)::regclass ORDER BY conname`, [table],
  )).rows;
  return JSON.stringify({
    columns: columns.map(c => [c.column_name, c.data_type, c.is_nullable, c.column_default]),
    indexes: indexes.map(i => [i.indexname, i.indexdef]),
    constraints: constraints.map(c => [c.conname, c.definition]),
  });
}

/** 认证版本记账表的版本集合。处在 v6 的夹具世界必须只到 v6。 */
export async function authVersions(
  pg: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
): Promise<number[]> {
  return (await pg.query('SELECT version FROM auth_schema_migrations ORDER BY version'))
    .rows.map(row => Number(row.version));
}
