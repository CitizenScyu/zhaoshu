// 已有库「只补记账」（baseline adopt，41-BASELINE）：`db:baseline:prod` 的核对与登记本体。
//
// 生产库从没跑过迁移 runner：表由运行期 DDL（business-schema.ts / db.ts）与 auth 迁移（auth-store.ts）
// 逐步建成，0002 手工执行过，库里根本没有 schema_migrations（prodmig41 实测，2026-09-24）。对这种库跑
// `db:migrate:prod --apply` 会把 0001_baseline.sql 整份在在线表上重跑（ALTER COLUMN / UPDATE / SET NOT NULL
// 全表扫描），而不是「只补一行记账」。本模块不执行任何迁移 DDL，改为：
//   1. 只读核对 0001–0003 的最终效果在库里都已成立——
//      结构：BASELINE_SHAPE（由 0001–0003 真跑出的库逐项导出、测试钉住）里每张表的每一列（类型 / 非空 /
//            默认值 / identity / 生成式）、每条约束（名称 + 类型 + 定义）、每个索引（名称 + 定义）；
//      缺席：0001/0002 删掉的东西（旧全局唯一键、旧表达式索引）必须不在（BASELINE_ABSENT）；
//      数据：0001/0003 的 INSERT / UPDATE 想达成的行状态（BASELINE_DATA_CHECKS）；
//      前提：没有 schema_migrations 表（有就交给 db:migrate:prod）、auth 记账 ≥ AUTH_SCHEMA_VERSION、
//            迁移文件摘要等于 BASELINE_CHECKSUMS（契约只对这三份字节成立）。
//   2. 全部成立才在 --apply 时于一个事务内拿迁移锁、锁内再核一遍、建 schema_migrations 并登记 v1–v3；
//      任何一条不成立就拒绝（未写库），绝不部分登记。
// 库里比契约多出的列 / 约束 / 索引（运行期与 auth v5–v7 后加的）只报告，不拒绝：0001–0003 不删它们。
import { AUTH_SCHEMA_VERSION } from '../src/lib/auth-store.ts';
import { BASELINE_SHAPE } from './db-baseline-contract.mjs';
import { assertIdentifier, inspectSchema, MIGRATION_LOCK_ID, SCHEMA_MIGRATIONS_DDL, TARGET_SCHEMA } from './db-migration-lib.mjs';

// baseline 只替 v1–v3 作证；之后新增的迁移由 db:migrate:prod 正常执行。
export const BASELINE_VERSIONS = [1, 2, 3];
export const BASELINE_CHECKSUMS = {
  1: '1b47f1ca7dbe16fc01fa50ff71fa4893af186b5de21aedb88529cf390c5a5db2',
  2: '839ae90fb54ae667a0c326c79afd4a584c96b015a6e3edbb428f236b7afaf24f',
  3: '81957051de3fdd7bdc84e4b8d98084980e05bad591c38efed001eac5f51ccdf6',
};

// BASELINE_SHAPE 每张表出自哪段 SQL（报告与人工复核用；测试钉住键集合与契约一致）。
export const BASELINE_TABLE_SOURCES = {
  users: '0001:4-31',
  auth_schema_migrations: '0001:33-35',
  auth_settings: '0001:36-41',
  sessions: '0001:42-53',
  auth_rate_limits: '0001:54-59',
  profile: '0001:61-78',
  books: '0001:80-85 + 0002:26-32,43,46',
  recommendations: '0001:87-111',
  feedback: '0001:113-129',
  shuyuan_sources: '0001:131-135',
  shuyuan_meta: '0001:136-139',
  labeled_books: '0001:140-150 + 0002:34-40,44,47',
  download_tasks: '0001:152-177',
  source_read_catalogs: '0001:179-182',
  profile_seed_audit: '0001:183-189',
  llm_usage: '0001:190-208',
  app_settings: '0003:21-32',
  source_admission: '0003:34-51',
  profile_feedback_queue: '0003:53-66',
  cron_health: '0003:68-71',
};

// 被 0001/0002 删掉、必须不在库里的对象。契约对「多出来的东西」只报告，所以删除类效果要单独核。
export const BASELINE_ABSENT = [
  { id: 'recommendations-global-unique-constraint', source: '0001:103-105',
    describe: 'recommendations 上不得有 UNIQUE (book_id, query) 约束（旧全局唯一键）',
    violations: (shape) => shape.constraints.filter((row) => row.table_name === 'recommendations' && row.contype === 'u'
      && row.definition === 'UNIQUE (book_id, query)').map((row) => row.conname) },
  { id: 'recommendations-global-unique-index', source: '0001:106-108',
    describe: 'recommendations 上不得有 (book_id, query) 唯一索引（含 recommendations_book_query_idx）',
    violations: (shape) => shape.indexes.filter((row) => row.table_name === 'recommendations'
      && /^CREATE UNIQUE INDEX \S+ ON \S+ USING btree \(book_id, query\)$/.test(row.indexdef)).map((row) => row.index_name) },
  { id: 'books-title-author-idx', source: '0002:46',
    describe: 'books_title_author_idx（旧表达式唯一索引）不得存在',
    violations: (shape) => shape.indexes.filter((row) => row.index_name === 'books_title_author_idx').map((row) => row.index_name) },
  { id: 'labeled-books-title-author-idx', source: '0002:47',
    describe: 'labeled_books_title_author_idx（旧表达式唯一索引）不得存在',
    violations: (shape) => shape.indexes.filter((row) => row.index_name === 'labeled_books_title_author_idx').map((row) => row.index_name) },
];

const DOWNLOAD_TASK_REQUIRED = ['book_id', 'title', 'author', 'status', 'source_url', 'chapters_total',
  'chapters_done', 'chars_total', 'error', 'created_at', 'updated_at'];

// 0001/0003 的数据类效果。每条返回一行 { ok, detail }；needs 里的表列不在时判「无法核对」，不发查询
// （显式事务里查不存在的列会让整个事务 25P02）。s 是已校验、带引号的 schema 名。
export const BASELINE_DATA_CHECKS = [
  { id: 'owner-row', source: '0001:23-31', describe: 'users.id=1 是固定 owner 身份',
    needs: { users: ['id', 'username', 'role', 'password_hash', 'disabled_at', 'can_find', 'can_read', 'can_download'] },
    sql: (s) => `SELECT EXISTS (SELECT 1 FROM ${s}.users WHERE id=1 AND username='owner' AND role='owner'
      AND password_hash IS NULL AND disabled_at IS NULL AND can_find AND can_read AND can_download) AS ok, NULL::text AS detail` },
  { id: 'auth-settings-row', source: '0001:41', describe: 'auth_settings 有 id=1 行',
    needs: { auth_settings: ['id'] },
    sql: (s) => `SELECT EXISTS (SELECT 1 FROM ${s}.auth_settings WHERE id=1) AS ok, NULL::text AS detail` },
  { id: 'profile-ownership', source: '0001:67-72', describe: '存在 id<>1 的画像时 auth 记账须已含 ≥3（归属已迁移）',
    needs: { profile: ['id'], auth_schema_migrations: ['version'] },
    sql: (s) => `SELECT NOT (EXISTS (SELECT 1 FROM ${s}.profile WHERE id <> 1)
      AND NOT EXISTS (SELECT 1 FROM ${s}.auth_schema_migrations WHERE version >= 3)) AS ok,
      (SELECT string_agg(id::text, ',' ORDER BY id) FROM (SELECT id FROM ${s}.profile WHERE id <> 1 ORDER BY id LIMIT 20) t) AS detail` },
  { id: 'profile-owner-row', source: '0001:78', describe: 'profile 有 id=1 行',
    needs: { profile: ['id'] },
    sql: (s) => `SELECT EXISTS (SELECT 1 FROM ${s}.profile WHERE id=1) AS ok, NULL::text AS detail` },
  { id: 'recommendations-user-id', source: '0001:94-95', describe: 'recommendations.user_id 无 NULL',
    needs: { recommendations: ['id', 'user_id'] },
    sql: (s) => `SELECT bad IS NULL AS ok, bad AS detail FROM (SELECT string_agg(id::text, ',' ORDER BY id) AS bad
      FROM (SELECT id FROM ${s}.recommendations WHERE user_id IS NULL ORDER BY id LIMIT 20) t) q` },
  { id: 'feedback-user-id', source: '0001:119-120', describe: 'feedback.user_id 无 NULL',
    needs: { feedback: ['id', 'user_id'] },
    sql: (s) => `SELECT bad IS NULL AS ok, bad AS detail FROM (SELECT string_agg(id::text, ',' ORDER BY id) AS bad
      FROM (SELECT id FROM ${s}.feedback WHERE user_id IS NULL ORDER BY id LIMIT 20) t) q` },
  { id: 'shuyuan-meta-row', source: '0001:139', describe: 'shuyuan_meta 有 id=1 行',
    needs: { shuyuan_meta: ['id'] },
    sql: (s) => `SELECT EXISTS (SELECT 1 FROM ${s}.shuyuan_meta WHERE id=1) AS ok, NULL::text AS detail` },
  { id: 'download-tasks-required', source: '0001:159-167', describe: 'download_tasks 必填列无 NULL',
    needs: { download_tasks: ['id', ...DOWNLOAD_TASK_REQUIRED] },
    sql: (s) => `SELECT bad IS NULL AS ok, bad AS detail FROM (SELECT string_agg(id::text, ',' ORDER BY id) AS bad
      FROM (SELECT id FROM ${s}.download_tasks WHERE ${DOWNLOAD_TASK_REQUIRED.map((name) => `${name} IS NULL`).join(' OR ')}
      ORDER BY id LIMIT 20) t) q` },
  { id: 'auth-ledger-1-4', source: '0001:210', describe: 'auth_schema_migrations 含版本 1、2、3、4',
    needs: { auth_schema_migrations: ['version'] },
    sql: (s) => `SELECT count(*) = 4 AS ok, string_agg(version::text, ',' ORDER BY version) AS detail
      FROM ${s}.auth_schema_migrations WHERE version IN (1, 2, 3, 4)` },
  { id: 'app-settings-row', source: '0003:26', describe: 'app_settings 有 id=1 行',
    needs: { app_settings: ['id'] },
    sql: (s) => `SELECT EXISTS (SELECT 1 FROM ${s}.app_settings WHERE id=1) AS ok, NULL::text AS detail` },
];

// 结构快照：只读 pg_catalog。按名称排序，列序不计（老库的列由 ADD COLUMN 追加，物理列序本来就不同）。
// 约束只取 p/u/f/c/x：PostgreSQL 18 起 NOT NULL 也会以 contype='n' 出现，非空性已由列的 not_null 表达。
/** @returns {Promise<{ columns: Record<string, any>[], constraints: Record<string, any>[], indexes: Record<string, any>[] }>} */
export async function inspectShape(client, schema = TARGET_SCHEMA) {
  assertIdentifier(schema);
  const columns = (await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS not_null,
      CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS column_default,
      NULLIF(a.attidentity, '') AS identity,
      CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attname
  `, [schema])).rows;
  const constraints = (await client.query(`
    SELECT a.relname AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class a ON a.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = a.relnamespace
    WHERE n.nspname = $1 AND c.contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY a.relname, c.conname
  `, [schema])).rows;
  const indexes = (await client.query(`
    SELECT tablename AS table_name, indexname AS index_name, indexdef
    FROM pg_indexes WHERE schemaname = $1
    ORDER BY tablename, indexname
  `, [schema])).rows;
  return { columns, constraints, indexes };
}

// 快照 → 契约形状（生成 BASELINE_SHAPE 与比对共用同一种投影）。
export function shapeToContract(shape, tables) {
  const contract = {};
  for (const table of [...tables].sort()) {
    contract[table] = {
      columns: shape.columns.filter((row) => row.table_name === table)
        .map((row) => [row.column_name, row.type, row.not_null, row.column_default ?? null, row.identity ?? null, row.generated ?? null]),
      constraints: shape.constraints.filter((row) => row.table_name === table)
        .map((row) => [row.conname, row.contype, row.definition]),
      indexes: shape.indexes.filter((row) => row.table_name === table).map((row) => [row.index_name, row.indexdef]),
    };
  }
  return contract;
}

const COLUMN_FIELDS = ['type', 'not_null', 'column_default', 'identity', 'generated'];

// 纯函数：库的结构快照对照契约。problems 任一条即拒绝；extra 只报告。
export function compareShape(shape, contract = BASELINE_SHAPE) {
  const problems = [];
  const extra = [];
  const actual = shapeToContract(shape, Object.keys(contract));
  for (const [table, expected] of Object.entries(contract)) {
    const got = actual[table];
    if (!got.columns.length) { problems.push({ kind: 'missing-table', table }); continue; }
    const gotColumns = new Map(got.columns.map((row) => [row[0], row]));
    for (const row of expected.columns) {
      const found = gotColumns.get(row[0]);
      if (!found) { problems.push({ kind: 'missing-column', table, column: row[0] }); continue; }
      const diff = {};
      COLUMN_FIELDS.forEach((field, index) => {
        if (found[index + 1] !== row[index + 1]) diff[field] = { expected: row[index + 1], actual: found[index + 1] };
      });
      if (Object.keys(diff).length) problems.push({ kind: 'column-mismatch', table, column: row[0], diff });
    }
    const expectedColumns = new Set(expected.columns.map((row) => row[0]));
    for (const row of got.columns) if (!expectedColumns.has(row[0])) extra.push({ kind: 'column', table, name: row[0] });

    const gotConstraints = new Map(got.constraints.map((row) => [row[0], row]));
    for (const [name, contype, definition] of expected.constraints) {
      const found = gotConstraints.get(name);
      if (!found) {
        const sameDefinition = got.constraints.find((row) => row[1] === contype && row[2] === definition);
        problems.push(sameDefinition
          ? { kind: 'constraint-renamed', table, name, actualName: sameDefinition[0], definition }
          : { kind: 'missing-constraint', table, name, contype, definition });
      } else if (found[1] !== contype || found[2] !== definition) {
        problems.push({ kind: 'constraint-mismatch', table, name, expected: [contype, definition], actual: [found[1], found[2]] });
      }
    }
    const expectedConstraints = new Set(expected.constraints.map((row) => row[0]));
    for (const row of got.constraints) if (!expectedConstraints.has(row[0])) extra.push({ kind: 'constraint', table, name: row[0] });

    const gotIndexes = new Map(got.indexes.map((row) => [row[0], row[1]]));
    for (const [name, indexdef] of expected.indexes) {
      const found = gotIndexes.get(name);
      if (found === undefined) problems.push({ kind: 'missing-index', table, name, indexdef });
      else if (found !== indexdef) problems.push({ kind: 'index-mismatch', table, name, expected: indexdef, actual: found });
    }
    const expectedIndexes = new Set(expected.indexes.map((row) => row[0]));
    for (const [name] of got.indexes) if (!expectedIndexes.has(name)) extra.push({ kind: 'index', table, name });
  }
  return { problems, extra };
}

async function runDataChecks(client, schema, shape) {
  const quoted = assertIdentifier(schema);
  const present = new Set(shape.columns.map((row) => `${row.table_name}.${row.column_name}`));
  const results = [];
  for (const check of BASELINE_DATA_CHECKS) {
    const missing = Object.entries(check.needs).flatMap(([table, columns]) =>
      columns.filter((column) => !present.has(`${table}.${column}`)).map((column) => `${table}.${column}`));
    if (missing.length) { results.push({ id: check.id, ok: false, verifiable: false, detail: `缺列 ${missing.join(', ')}` }); continue; }
    const row = (await client.query(check.sql(quoted))).rows[0];
    results.push({ id: check.id, ok: row.ok === true, verifiable: true, detail: row.detail ?? null });
  }
  return results;
}

// 纯函数：汇总全部核对结果。refusals 是给人看的一行一条；ok 只在零 refusal 时为 true。
export function evaluateBaseline({ report, shape, data, migrations }) {
  const refusals = [];
  const ledgerPresent = shape.columns.some((row) => row.table_name === 'schema_migrations');
  if (ledgerPresent) {
    refusals.push(`库里已有 schema_migrations（登记了 ${report.versions.length} 个版本）：已登记的库交给 db:migrate:prod，baseline 只处理从未登记的库`);
  }
  for (const version of BASELINE_VERSIONS) {
    const migration = migrations.find((item) => item.version === version);
    if (!migration || migration.checksum !== BASELINE_CHECKSUMS[version]) {
      refusals.push(`迁移文件 v${version} 的摘要与 baseline 契约登记的 ${BASELINE_CHECKSUMS[version].slice(0, 12)}… 不一致：契约只对那份字节成立`);
    }
  }
  const authVersion = report.authVersion ?? null;
  if ((authVersion ?? 0) < AUTH_SCHEMA_VERSION) {
    refusals.push(`auth 记账版本 ${authVersion ?? '无'} 低于 ${AUTH_SCHEMA_VERSION}：先跑 migrate:auth:prod，再做 baseline`);
  }
  const { problems, extra } = compareShape(shape);
  for (const problem of problems) refusals.push(`结构不符（${BASELINE_TABLE_SOURCES[problem.table] ?? '?'}）：${JSON.stringify(problem)}`);
  const absent = BASELINE_ABSENT.map((item) => ({ id: item.id, source: item.source, violations: item.violations(shape) }));
  for (const item of absent) {
    if (item.violations.length) refusals.push(`应已删除的对象仍在（${item.source}）：${item.id} → ${item.violations.join(', ')}`);
  }
  for (const result of data) {
    if (result.ok) continue;
    const check = BASELINE_DATA_CHECKS.find((item) => item.id === result.id);
    const detail = !result.verifiable ? `；无法核对：${result.detail}` : (result.detail ? `；样本 id / 值 ${result.detail}` : '');
    refusals.push(`数据不符（${check.source}）：${check.describe}${detail}`);
  }
  const contractTables = Object.values(BASELINE_SHAPE);
  return {
    ok: !refusals.length, refusals, problems, extra, authVersion,
    checked: {
      tables: contractTables.length,
      columns: contractTables.reduce((sum, table) => sum + table.columns.length, 0),
      constraints: contractTables.reduce((sum, table) => sum + table.constraints.length, 0),
      indexes: contractTables.reduce((sum, table) => sum + table.indexes.length, 0),
      absent: absent.length, data: data.length,
    },
    absent, data,
  };
}

// 核对本体：调用方负责事务（dry-run 用 READ ONLY，apply 在迁移锁内）。
export async function verifyBaseline(client, migrations, schema = TARGET_SCHEMA) {
  const report = await inspectSchema(client, schema);
  const shape = await inspectShape(client, schema);
  const data = await runDataChecks(client, schema, shape);
  return evaluateBaseline({ report, shape, data, migrations });
}

export function baselineLedgerWrites(migrations) {
  return BASELINE_VERSIONS.map((version) => {
    const { name, checksum } = migrations.find((item) => item.version === version);
    return { table: 'schema_migrations', version, name, checksum };
  });
}

// 登记：一个事务、拿与 applyMigration 同一把迁移锁、锁内重新核对一遍（堵住「dry-run 之后库被改」的窗口），
// 核对不过就回滚并返回 refused；通过才建记账表、登记 v1–v3。不执行任何迁移文件里的 SQL。
export async function applyBaseline(client, migrations, schema = TARGET_SCHEMA) {
  const quoted = assertIdentifier(schema);
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL search_path TO ${quoted}`);
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    const verdict = await verifyBaseline(client, migrations, schema);
    if (!verdict.ok) {
      await client.query('ROLLBACK');
      return { status: 'refused', verdict };
    }
    await client.query(SCHEMA_MIGRATIONS_DDL);
    const writes = baselineLedgerWrites(migrations);
    for (const { version, name, checksum } of writes) {
      await client.query(`INSERT INTO ${quoted}.schema_migrations(version, name, checksum) VALUES ($1, $2, $3)`, [version, name, checksum]);
    }
    await client.query('COMMIT');
    return { status: 'applied', verdict, versions: writes.map(({ version, name, checksum }) => ({ version, name, checksum, status: 'recorded' })) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
