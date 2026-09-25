import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@neondatabase/serverless';
import { SCHEMA_MIGRATION_LOCK_ID, SCHEMA_VERSION } from '../src/lib/schema-version.ts';
import { AUTH_SCHEMA_VERSION } from '../src/lib/auth-store.ts';
import { ARTIFACT_SCHEMA_VERSION } from '../src/lib/artifact-schema.ts';

export { SCHEMA_VERSION };
export const MIGRATION_LOCK_ID = SCHEMA_MIGRATION_LOCK_ID;
export const TARGET_SCHEMA = 'public';
// 冷建库盘点清单（check-schema 只读比对）。必须覆盖运行时用到的全部业务表，
// 否则冷库重建后会带着「能跑过 db:check 却缺表」的隐性残缺。
// 顺序无关，按表名字母序。
// 注意**有意排除**的表（不是遗漏）：
//   - registration_invites / 任何 auth-schema 侧 v5 之后的表：由 initializeAuthSchema
//     （src/lib/auth-store.ts）单独建，版本记在 auth_schema_migrations 里，不进本（业务 schema）
//     的 EXPECTED_TABLES。0001 只把 auth 记账到 v4，冷建库须再跑 migrate:auth:prod 补 v5-v7；
//     auth 侧是否到位由 evaluateSchema 的 authVersionOk 判（库版本 ≥ AUTH_SCHEMA_VERSION）。
// app_settings / cron_health / profile_feedback_queue / source_admission 由 0003 建（MS-25）；
// 此前它们只有运行时 DDL、不在本清单里，冷建库缺这四张表 db:check 也照样通过。
// artifact_schema_migrations / storage_repositories / book_artifacts 由 initializeArtifactSchema
// （src/lib/artifact-schema.ts，自有 version 1）单独建——同 auth 侧的道理：它是显式迁移、不进
// 0001–0003，冷建库须再跑 migrate:artifacts:prod。此前它们不在本清单里，冷建库缺这两张业务表
// `db:check:prod` 仍 rc=0（tempdb41 §缺陷 D1 实测：T8 worker 启动即 relation does not exist）。
export const EXPECTED_TABLES = [
  'app_settings', 'artifact_schema_migrations', 'auth_rate_limits', 'auth_schema_migrations', 'auth_settings',
  'book_artifacts', 'books', 'cron_health', 'download_tasks', 'feedback', 'labeled_books', 'llm_usage', 'profile',
  'profile_feedback_queue', 'profile_seed_audit', 'recommendations', 'schema_migrations', 'sessions',
  'shuyuan_meta', 'shuyuan_sources', 'source_admission', 'source_read_catalogs', 'storage_repositories', 'users',
];

// 由自己的显式迁移（不是 0001–0003）建、但同属「冷建库必须补齐、缺了 db:check:prod 就该非 0」的表。
// artifact 侧与 auth 侧同理：迁移本体在 src/lib/artifact-schema.ts（自有记账表 version 1），
// 目标必须由 `migrate:artifacts:prod --database-url-env=...` 补齐；db:baseline 的契约只对 0001–0003 的
// 20 张表成立，故核对「EXPECTED_TABLES 与 0001–0003 契约的表集合」的测试要减掉这份清单。
export const ARTIFACT_TABLES = ['artifact_schema_migrations', 'book_artifacts', 'storage_repositories'];


const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

// 迁移文件是显式有序列表，不扫目录：目录里多一个 .sql 不该在无人察觉时被执行。
// version 由文件名前缀解析，SCHEMA_VERSION 必须等于列表里的最大版本（见 loadMigrations）。
export const MIGRATION_FILES = ['0001_baseline.sql', '0002_identity_key.sql', '0003_runtime_tables.sql'];

// 已发布（已登记进某个库的 schema_migrations）的迁移摘要，冻结在这里由测试钉住。
// v1 = 隔离库首次 db:migrate 登记的值（见下方 normalizeSqlText 注释）；生产从未跑过 runner、没有
// schema_migrations，由 db:baseline:prod 按同一份字节登记。3c7a20f 曾改了 0001 的一行
// 记账，摘要随之变成另一枚，已登记的库再跑 db:check / db:migrate 就会被「摘要不匹配」拒绝——
// 改已发布文件只能新增版本，不能回头改字节。新增迁移发布后把它的摘要追加进来。
export const PUBLISHED_CHECKSUMS = {
  1: '1b47f1ca7dbe16fc01fa50ff71fa4893af186b5de21aedb88529cf390c5a5db2',
  2: '839ae90fb54ae667a0c326c79afd4a584c96b015a6e3edbb428f236b7afaf24f',
};
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
// 依据：已登记的 v1 摘要是 LF 版（codex-done-28.md:71 记录隔离库首次 db:migrate
// 输出 checksum 1b47f1ca…，等于 0001 的 git blob 摘要；那是隔离库，不是生产）。Windows checkout 因
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

// 记账表的唯一建表语句：runner 与 baseline 登记（db-baseline.mjs）共用，两条路径建出的表形状一致。
export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`;

// 待执行列表整体在一个事务里跑完：中途失败连同已登记的版本一起回滚，不留半成品。
// 逐条按 version 查 schema_migrations：有行则核 name+checksum 后跳过（不重放 DDL），
// 无行才执行 SQL 并 INSERT 记账。已登记库上手工跑过的后续版本因此能被「只补记账」地接纳；
// 连 v1 都没登记的已有库（生产）不走这里，走 db-baseline.mjs。
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
    await client.query(SCHEMA_MIGRATIONS_DDL);
    const ordered = [...list].sort((left, right) => left.version - right.version);
    // strict（生产入口用）：拿到锁之后按整张记账表复核一遍，库里有代码不认识的版本、更高的版本
    // 或乱序缺口都拒绝。默认不开：旧代码对库里多出的高版本保持宽容，是回滚路径依赖的行为。
    if (options.strict) {
      const recorded = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
      const plan = planMigrations(recorded.rows, ordered);
      if (plan.errors.length) {
        throw new Error(`迁移记账与代码不一致，拒绝继续：${plan.errors.map((item) => item.message).join('；')}`);
      }
    }
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
  const authVersion = await exists('auth_schema_migrations')
    ? (await client.query(`SELECT max(version)::int AS version FROM ${assertIdentifier(schema)}.auth_schema_migrations`)).rows[0].version
    : null;
  const artifactVersion = await exists('artifact_schema_migrations')
    ? (await client.query(`SELECT max(version)::int AS version FROM ${assertIdentifier(schema)}.artifact_schema_migrations`)).rows[0].version
    : null;
  return { schema, versions, authVersion, artifactVersion, columns, indexes, constraints, dangerous,
    checkedColumns: REQUIRED_DOWNLOAD_TASK_COLUMNS };
}

// db:check 的判定（纯函数，便于在真库测试里直接断言）。四条都要成立才算通过：
// 1. EXPECTED_TABLES 一张不缺（含 artifact 两表与它的记账表）；2. 迁移列表里每个版本都已登记且 name+摘要一致；
// 3. auth 记账 ≥ AUTH_SCHEMA_VERSION——否则运行时 assertAuthSchema 会 503，检查却说「通过」；
// 4. artifact 记账 ≥ ARTIFACT_SCHEMA_VERSION——否则 T8 worker 启动即 `relation ... does not exist`
//    （tempdb41 §缺陷 D1 实测），检查同样不该说「通过」。
export function evaluateSchema(report, migrations) {
  const present = new Set(report.columns.map((item) => item.table_name));
  const missingTables = EXPECTED_TABLES.filter((table) => !present.has(table));
  const recorded = new Map(report.versions.map((row) => [row.version, row]));
  const expectedMigrations = migrations.map((migration) => {
    const row = recorded.get(migration.version);
    return { version: migration.version, name: migration.name, checksum: migration.checksum,
      recordedName: row?.name ?? null, recordedChecksum: row?.checksum?.trim() ?? null,
      checksumOk: Boolean(row) && row.name === migration.name && row.checksum.trim() === migration.checksum };
  });
  const checksumOk = expectedMigrations.every((item) => item.checksumOk);
  const authVersionOk = (report.authVersion ?? 0) >= AUTH_SCHEMA_VERSION;
  const artifactVersionOk = (report.artifactVersion ?? 0) >= ARTIFACT_SCHEMA_VERSION;
  const ok = checksumOk && authVersionOk && artifactVersionOk && !missingTables.length && !report.dangerous.length;
  return { ok, missingTables, expectedMigrations, checksumOk,
    authVersion: report.authVersion ?? null, expectedAuthVersion: AUTH_SCHEMA_VERSION, authVersionOk,
    artifactVersion: report.artifactVersion ?? null, expectedArtifactVersion: ARTIFACT_SCHEMA_VERSION, artifactVersionOk };
}

// 严格记账比对（纯函数）：生产入口的 dry-run 计划与 apply 锁内复核共用。
// 与 evaluateSchema 不同，这里还看「库里有、代码里没有」的版本：
//   checksum-mismatch  已登记版本的 name 或摘要与文件不符（已发布文件被改过，或连错了库）；
//   newer-than-code    库里登记了高于代码最新版本的迁移（版本倒退：旧代码对新库）；
//   unknown-version    库里登记了代码列表里没有、但不高于最新版本的迁移；
//   out-of-order       某版本未登记，而库里已有更高版本——补执行会乱序，拒绝。
// 「v1 已登记、v2 只手工跑过 DDL 未登记」的形态不属于乱序（待执行的 v2 高于已登记的最高版本 v1）。
export function planMigrations(recordedRows, migrations) {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const known = new Map(ordered.map((migration) => [migration.version, migration]));
  const head = ordered.length ? ordered[ordered.length - 1].version : 0;
  const recorded = new Map(recordedRows.map((row) => [Number(row.version), row]));
  const maxRecorded = recorded.size ? Math.max(...recorded.keys()) : 0;
  const errors = [];
  for (const [version, row] of [...recorded].sort((left, right) => left[0] - right[0])) {
    const migration = known.get(version);
    if (!migration) {
      errors.push(version > head
        ? { version, kind: 'newer-than-code', message: `库已登记版本 ${version}，高于代码的最新版本 ${head}（库新代码旧）` }
        : { version, kind: 'unknown-version', message: `库已登记版本 ${version}（${row.name}）不在代码的迁移列表里` });
    } else if (row.name !== migration.name || String(row.checksum).trim() !== migration.checksum) {
      errors.push({ version, kind: 'checksum-mismatch', message: `迁移版本 ${version} 的名称或摘要与库内登记不一致` });
    }
  }
  const unchanged = [];
  const pending = [];
  for (const { version, name, checksum } of ordered) {
    if (recorded.has(version)) { unchanged.push({ version, name, checksum }); continue; }
    pending.push({ version, name, checksum });
    if (version < maxRecorded) {
      errors.push({ version, kind: 'out-of-order', message: `版本 ${version} 未登记，但库里已有更高的版本 ${maxRecorded}` });
    }
  }
  const status = errors.length ? 'refused' : (pending.length ? 'pending' : 'up-to-date');
  return { status, head, unchanged, pending, errors };
}

// 0003 四张表的列契约（N2）：[列名, data_type, is_nullable, column_default]，取自 information_schema 的原样渲染。
// `ADD COLUMN IF NOT EXISTS` 只看列名：生产某列若存在但类型/可空/默认值不同，0003 空转、db:check 也不会发现，
// 要到运行期 INSERT 才炸。生产入口在迁移前用这份契约只读比对，不一致即拒绝。
// db-prod.test.ts 用迁移路径与运行时路径各建一个真库钉住它，改 0003 / business-schema.ts 而没同步这里会红。
export const EXPECTED_RUNTIME_COLUMNS = {
  app_settings: [
    ['id', 'integer', 'NO', '1'],
    ['llm_model', 'text', 'YES', null],
    ['updated_at', 'timestamp with time zone', 'NO', 'now()'],
    ['llm_reasoning', 'text', 'YES', null],
    ['label_model', 'text', 'YES', null],
    ['label_model_updated_at', 'timestamp with time zone', 'YES', null],
    ['default_model', 'text', 'YES', null],
    ['default_model_reasoning', 'text', 'YES', null],
    ['default_model_updated_at', 'timestamp with time zone', 'YES', null],
  ],
  cron_health: [
    ['name', 'text', 'NO', null],
    ['last_success_at', 'timestamp with time zone', 'NO', 'now()'],
  ],
  profile_feedback_queue: [
    ['user_id', 'integer', 'NO', null],
    ['pending_feedback_id', 'integer', 'YES', null],
    ['absorbed_feedback_id', 'integer', 'NO', '0'],
    ['status', 'text', 'NO', "'unchanged'::text"],
    ['attempts', 'integer', 'NO', '0'],
    ['last_error', 'text', 'NO', "''::text"],
    ['updated_at', 'timestamp with time zone', 'NO', 'now()'],
    ['lease_token', 'text', 'NO', "''::text"],
    ['lease_expires_at', 'timestamp with time zone', 'YES', null],
    ['fail_count', 'integer', 'NO', '0'],
    ['next_eligible_at', 'timestamp with time zone', 'YES', null],
  ],
  source_admission: [
    ['id', 'integer', 'NO', "nextval('source_admission_id_seq'::regclass)"],
    ['source_url', 'text', 'NO', null],
    ['tier', 'text', 'NO', null],
    ['compile_ok', 'boolean', 'NO', null],
    ['core_field_mask', 'jsonb', 'NO', null],
    ['search_ok', 'boolean', 'YES', null],
    ['search_verdict', 'text', 'NO', "''::text"],
    ['search_checked_at', 'timestamp with time zone', 'YES', null],
    ['rules_hash', 'text', 'NO', null],
    ['engine_semantics_version', 'integer', 'NO', '0'],
    ['host', 'text', 'NO', null],
    ['error', 'text', 'NO', "''::text"],
    ['compile_diagnostics', 'jsonb', 'NO', "'[]'::jsonb"],
  ],
};

// 按列名比对（不比物理列序：老实例的列由 ADD COLUMN 追加，列序本来就可能不同）。
// 表不存在不算问题（0003 会建）；表在而列缺、或类型/可空/默认值不同都算问题——0003 对已有表
// 不会补 CREATE TABLE 里的列，也不会改已有列。多出来的列只报告，不拒绝。
export function checkRuntimeColumns(columns) {
  const problems = [];
  const extra = [];
  const absentTables = [];
  for (const [table, expectedColumns] of Object.entries(EXPECTED_RUNTIME_COLUMNS)) {
    const actual = new Map(columns.filter((column) => column.table_name === table).map((column) => [column.column_name, column]));
    if (!actual.size) { absentTables.push(table); continue; }
    for (const [column, data_type, is_nullable, column_default] of expectedColumns) {
      const expected = { data_type, is_nullable, column_default };
      const found = actual.get(column);
      if (!found) { problems.push({ table, column, kind: 'missing', expected, actual: null }); continue; }
      const got = { data_type: found.data_type, is_nullable: found.is_nullable, column_default: found.column_default ?? null };
      if (got.data_type !== data_type || got.is_nullable !== is_nullable || got.column_default !== column_default) {
        problems.push({ table, column, kind: 'mismatch', expected, actual: got });
      }
    }
    const declared = new Set(expectedColumns.map(([column]) => column));
    for (const column of actual.keys()) if (!declared.has(column)) extra.push({ table, column });
  }
  return { ok: !problems.length, problems, extra, absentTables };
}
