import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@neondatabase/serverless';
import { SCHEMA_MIGRATION_LOCK_ID, SCHEMA_VERSION } from '../src/lib/schema-version.ts';

export { SCHEMA_VERSION };
export const MIGRATION_LOCK_ID = SCHEMA_MIGRATION_LOCK_ID;
export const TARGET_SCHEMA = 'public';
export const EXPECTED_TABLES = [
  'auth_rate_limits', 'auth_schema_migrations', 'auth_settings', 'books',
  'download_tasks', 'feedback', 'labeled_books', 'llm_usage', 'profile',
  'profile_seed_audit', 'recommendations', 'schema_migrations', 'sessions',
  'shuyuan_meta', 'shuyuan_sources', 'source_read_catalogs', 'users',
];

const here = dirname(fileURLToPath(import.meta.url));
export const migrationPath = resolve(here, '..', 'migrations', '0001_baseline.sql');

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

export async function loadMigration() {
  const sql = await readFile(migrationPath, 'utf8');
  return {
    version: SCHEMA_VERSION,
    name: '0001_baseline.sql',
    sql,
    checksum: createHash('sha256').update(sql).digest('hex'),
  };
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

export async function applyMigration(client, migration, options = {}) {
  migration ??= await loadMigration();
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
    const existing = await client.query('SELECT name, checksum FROM schema_migrations WHERE version=$1', [migration.version]);
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.name !== migration.name || row.checksum.trim() !== migration.checksum) {
        throw new Error(`迁移版本 ${migration.version} 的摘要不匹配，拒绝继续`);
      }
      await client.query('COMMIT');
      return { status: 'unchanged', version: migration.version, checksum: migration.checksum };
    }
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
      [migration.version, migration.name, migration.checksum]);
    await client.query('COMMIT');
    return { status: 'applied', version: migration.version, checksum: migration.checksum };
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
