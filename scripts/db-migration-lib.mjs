import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@neondatabase/serverless';
import { SCHEMA_MIGRATION_LOCK_ID, SCHEMA_VERSION } from '../src/lib/schema-version.ts';

export { SCHEMA_VERSION };
export const MIGRATION_LOCK_ID = SCHEMA_MIGRATION_LOCK_ID;
export const TARGET_SCHEMA = 'public';
// 冷建库盘点清单（check-schema 只读比对）。必须覆盖运行时用到的全部业务表，
// 否则冷库重建后会带着「能跑过 db:check 却缺表」的隐性残缺。
// 顺序无关，按表名字母序。
// 注意几个**有意排除**的表（不是遗漏，改这里前先读 business-schema.ts:253 附近）：
//   - registration_invites / 任何 auth-schema 侧的表：auth schema 的表由
//     initializeAuthSchema（src/lib/auth-store.ts）单独建，版本记在
//     auth_schema_migrations 里，不进本（业务 schema）的 EXPECTED_TABLES。
//     business-schema.ts:253 已就同样的排除留了注释，两处保持一致。
export const EXPECTED_TABLES = [
  'auth_rate_limits', 'auth_schema_migrations', 'auth_settings', 'books',
  'download_tasks', 'feedback', 'labeled_books', 'llm_usage', 'profile',
  'profile_seed_audit', 'recommendations', 'schema_migrations', 'sessions',
  'shuyuan_meta', 'shuyuan_sources', 'source_read_catalogs', 'users',
];

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

// 迁移文件是显式有序列表，不扫目录：目录里多一个 .sql 不该在无人察觉时被执行。
// version 由文件名前缀解析，SCHEMA_VERSION 必须等于列表里的最大版本（见 loadMigrations）。
export const MIGRATION_FILES = ['0001_baseline.sql', '0002_identity_key.sql'];
export const migrationPaths = MIGRATION_FILES.map((name) => resolve(migrationsDir, name));

export function parseTarget(argv) {
  if (argv.length !== 1 || argv[0] !== '--target=test') {
    throw new Error('必须且只能指定 --target=test');
  }
  return 'test';
}

export function requireTestDatabaseUrl(env = process.env) {
  const value = env.TEST_DATABASE_URL?.trim();
  if (!value) throw new Error('缺少 TEST_DATABASE_URL；不会回退到 DATABASE_URL，也不会自动加载 .env');
  let url;
  try { url = new URL(value); } catch { throw new Error('TEST_DATABASE_URL 不是有效的连接 URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('TEST_DATABASE_URL 必须是 PostgreSQL URL');
  return value;
}

export function isPooledEndpoint(connectionString) {
  return new URL(connectionString).hostname.includes('-pooler');
}

export function assertIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`非法标识符: ${name}`);
  return `"${name}"`;
}

// 迁移代码不依赖任何会话级状态：目标 schema 只在事务内用 SET LOCAL 指定，
// 这样在连接池端点上也不会因为连接复用而把语句送进别的 schema。
function withinTransaction(client, callback) {
  return (async () => {
    await client.query('BEGIN');
    try {
      const result = await callback();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  })();
}

export async function runInSchema(client, schema, statements) {
  const quoted = assertIdentifier(schema);
  return await withinTransaction(client, async () => {
    await client.query(`SET LOCAL search_path TO ${quoted}`);
    return await statements();
  });
}

const SESSION_PROBE_LOCK_ID = 736241902;

// 迁移依赖两条端点性质：一个事务始终落在同一个后端（SET LOCAL 生效），
// 且 advisory lock 跨连接互斥。这里在真实端点上实测，而不是按主机名推断。
export async function probeEndpoint(connectionString) {
  const first = createClient(connectionString);
  const second = createClient(connectionString);
  let serializedLocks = false;
  let transactionPinned = false;
  try {
    await first.connect();
    await second.connect();
    await first.query('BEGIN');
    await first.query("SET LOCAL statement_timeout = '7000ms'");
    const shown = await first.query('SHOW statement_timeout');
    transactionPinned = shown.rows?.[0]?.statement_timeout === '7s';
    await first.query('SELECT pg_advisory_xact_lock($1)', [SESSION_PROBE_LOCK_ID]);
    await second.query('BEGIN');
    try {
      await second.query("SET LOCAL lock_timeout = '2s'");
      await second.query('SELECT pg_advisory_xact_lock($1)', [SESSION_PROBE_LOCK_ID]);
    } catch (error) {
      serializedLocks = error?.code === '55P03';
    } finally {
      await second.query('ROLLBACK').catch(() => {});
    }
    await first.query('ROLLBACK').catch(() => {});
  } finally {
    await first.end().catch(() => {});
    await second.end().catch(() => {});
  }
  return { serializedLocks, transactionPinned };
}

// 行尾归一：摘要与执行都以 LF 文本为准。
// 依据：生产库已登记的 v1 摘要是 LF 版（codex-done-28.md:71 记录首次 db:migrate
// 输出 checksum 1b47f1ca…，等于 0001 的 git blob 摘要）。Windows checkout 因
// core.autocrlf=true 读到 CRLF，不归一会得到另一枚摘要，db:check/db:migrate 会被
// 「版本 1 摘要不匹配」整批拒绝。归一只影响读取，不改盘上文件、不改已登记的行。
export const normalizeSqlText = (sql) => sql.replaceAll('\r\n', '\n');

export const checksumOf = (sql) => createHash('sha256').update(normalizeSqlText(sql)).digest('hex');

export function parseMigrationVersion(name) {
  const matched = /^(\d+)_/.exec(name);
  if (!matched) throw new Error(`迁移文件名缺少数字版本前缀: ${name}`);
  return Number(matched[1]);
}

// 常量与文件脱节（例如加了 0003 却忘了抬 SCHEMA_VERSION）必须在执行前就炸，
// 不能靠人工记得改两处。纯函数，便于在无数据库的套件里直接断言。
export function assertSchemaVersionHead(versions, schemaVersion = SCHEMA_VERSION) {
  const head = versions.length ? Math.max(...versions) : undefined;
  if (head !== schemaVersion) {
    throw new Error(`迁移列表最大版本 ${head} 与 SCHEMA_VERSION ${schemaVersion} 不一致`);
  }
  return head;
}

// 每个文件是一个版本：version 取自文件名数字前缀，name 是文件名，checksum 是归一后原文的 SHA-256。
// 摘要进 schema_migrations 后即冻结——改已发布文件的一个字节会让已有库拒绝继续。
export async function loadMigrations() {
  const migrations = [];
  for (const path of migrationPaths) {
    const name = basename(path);
    const version = parseMigrationVersion(name);
    const sql = normalizeSqlText(await readFile(path, 'utf8'));
    migrations.push({ version, name, sql, checksum: checksumOf(sql) });
  }
  migrations.sort((a, b) => a.version - b.version);
  if (new Set(migrations.map((item) => item.version)).size !== migrations.length) {
    throw new Error('迁移文件版本号重复');
  }
  assertSchemaVersionHead(migrations.map((item) => item.version));
  return migrations;
}

export function createClient(connectionString) {
  return new Client({ connectionString });
}

export function safeError(error) {
  const fields = ['code', 'detail', 'hint', 'where'];
  const result = { message: String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]') };
  for (const field of fields) if (error?.[field]) result[field] = String(error[field]);
  return result;
}

// 待执行列表整体在一个事务里跑完：中途失败连同已登记的版本一起回滚，不留半成品。
// 逐条按 version 查 schema_migrations：有行则核 name+checksum 后跳过（不重放 DDL），
// 无行才执行 SQL 并 INSERT 记账。生产手工跑过的版本因此能被「只补记账」地接纳。
export async function applyMigration(client, migrations, options = {}) {
  const list = migrations == null
    ? await loadMigrations()
    : (Array.isArray(migrations) ? migrations : [migrations]);
  const quoted = assertIdentifier(options.schema ?? TARGET_SCHEMA);
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL search_path TO ${quoted}`);
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const ordered = [...list].sort((left, right) => left.version - right.version);
    const versions = [];
    let anyApplied = false;
    for (const migration of ordered) {
      const existing = await client.query('SELECT name, checksum FROM schema_migrations WHERE version=$1', [migration.version]);
      const entry = { version: migration.version, name: migration.name, checksum: migration.checksum };
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (row.name !== migration.name || row.checksum.trim() !== migration.checksum) {
          throw new Error(`迁移版本 ${migration.version} 的摘要不匹配，拒绝继续`);
        }
        versions.push({ ...entry, status: 'unchanged' });
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
        [migration.version, migration.name, migration.checksum]);
      versions.push({ ...entry, status: 'applied' });
      anyApplied = true;
    }
    await client.query('COMMIT');
    return { status: anyApplied ? 'applied' : 'unchanged', versions };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const REQUIRED_DOWNLOAD_TASK_COLUMNS = [
  'book_id', 'title', 'author', 'status', 'source_url', 'chapters_total',
  'chapters_done', 'chars_total', 'error', 'created_at', 'updated_at',
];

// 只读盘点。注意不能靠捕获 42P01 兜底——语句在显式事务里失败会中止整个事务(25P02)。
// 因此先查存在性，而且全部按 schema 限定，不依赖 search_path。
export async function inspectSchema(client, schema = TARGET_SCHEMA) {
  assertIdentifier(schema);
  const exists = async (table) =>
    (await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`${schema}.${table}`])).rows[0].present === true;

  const versions = await exists('schema_migrations')
    ? (await client.query(`
        SELECT version, name, checksum, applied_at
        FROM ${assertIdentifier(schema)}.schema_migrations ORDER BY version
      `)).rows
    : [];
  const columns = (await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = $1
    ORDER BY table_name, ordinal_position
  `, [schema])).rows;
  const indexes = (await client.query(`
    SELECT tablename AS table_name, indexname AS index_name, indexdef
    FROM pg_indexes WHERE schemaname = $1
    ORDER BY tablename, indexname
  `, [schema])).rows;
  const constraints = (await client.query(`
    SELECT a.relname AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class a ON a.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = a.relnamespace
    WHERE n.nspname = $1
    ORDER BY a.relname, c.conname
  `, [schema])).rows;

  const presentColumns = new Set(
    columns.filter((column) => column.table_name === 'download_tasks').map((column) => column.column_name));
  const dangerous = await exists('download_tasks')
    && REQUIRED_DOWNLOAD_TASK_COLUMNS.every((name) => presentColumns.has(name))
    ? (await client.query(`
        SELECT id::text AS record_id,
          concat_ws(',', ${REQUIRED_DOWNLOAD_TASK_COLUMNS.map((name) => `CASE WHEN ${name} IS NULL THEN '${name}' END`).join(', ')}) AS missing
        FROM ${assertIdentifier(schema)}.download_tasks
        WHERE ${REQUIRED_DOWNLOAD_TASK_COLUMNS.map((name) => `${name} IS NULL`).join(' OR ')}
        ORDER BY id
      `)).rows
    : [];
  return { schema, versions, columns, indexes, constraints, dangerous, checkedColumns: REQUIRED_DOWNLOAD_TASK_COLUMNS };
}
