// 业务 schema 的生产 / 灾备入口（41-DBPROD，N1）：`db:check:prod` 与 `db:migrate:prod`。
//
// db:check / db:migrate 只吃 --target=test + TEST_DATABASE_URL，是隔离库演练工具；docs/auth-deployment.md
// 又禁止「把生产连接冒充 TEST_DATABASE_URL」——于是业务迁移在生产与冷建库上没有合规入口。本脚本就是
// 那个入口，与 migrate-auth-prod.mjs 同一套约束。迁移本体完全复用 db-migration-lib.mjs 的
// loadMigrations / applyMigration（不复制任何 SQL），只在前后加只读核对：
//   check    只读：逐版本核摘要、缺表、auth 记账版本、严格记账比对（未知/更高/乱序版本）、四张运行期表的列类型（N2）
//   migrate  默认 dry-run：只读列出将执行的迁移与将写入的记账行；显式 --apply 才写。
//            前置核对不过（摘要不匹配、库版本高于代码、未知版本、乱序、列类型漂移）一律拒绝，退出码 2。
//            apply 在迁移事务的锁内再按整张记账表复核一次（applyMigration strict），之后只读复核。
//            没有 schema_migrations 却已有业务表的库（从未登记的已有库，如生产）也拒绝：那要走 baseline。
//   baseline 默认 dry-run：只读核对 0001–0003 的效果在库里都已成立（db-baseline.mjs），不执行任何迁移 DDL；
//            显式 --apply 才在迁移锁内复核并建 schema_migrations、登记 v1–v3。只接受从未登记的库。
//
// 目标必须显式给出：--database-url-env=<变量名>，脚本不读 .env*，不回退 DATABASE_URL / TEST_DATABASE_URL，
// 也不接受这两个名字本身。输出只含 host、版本、摘要与列形状，不含连接串；异常经 safeError 脱敏。
// 退出码：0 通过 / 已完成；2 核对不通过或拒绝执行（未写库）；1 参数、连接或执行错误。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyMigration, checkRuntimeColumns, createClient, evaluateSchema, EXPECTED_RUNTIME_COLUMNS, EXPECTED_TABLES, inspectSchema,
  loadMigrations, planMigrations, probeEndpoint, safeError, SCHEMA_VERSION, TARGET_SCHEMA,
} from './db-migration-lib.mjs';
import { applyBaseline, baselineLedgerWrites, verifyBaseline } from './db-baseline.mjs';
import { readDatabaseUrl } from './migrate-auth-prod.mjs';

const USAGE = '用法: db-prod.mjs check --database-url-env=<变量名> | db-prod.mjs <migrate|baseline> --database-url-env=<变量名> [--apply]（migrate / baseline 默认 dry-run）';
const WRITE_COMMANDS = new Set(['migrate', 'baseline']);
// 应用与隔离库各自的连接变量。生产入口只读运维专用变量，免得 shell 里残留的应用 / 测试连接被误当目标。
const RESERVED_ENV_NAMES = new Set(['DATABASE_URL', 'TEST_DATABASE_URL']);

export function parseProdArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check' && !WRITE_COMMANDS.has(command)) throw new Error(`第一个参数必须是 check、migrate 或 baseline。${USAGE}`);
  let envName = null;
  let apply = false;
  let dryRun = false;
  for (const arg of rest) {
    if (arg.startsWith('--database-url-env=')) {
      if (envName !== null) throw new Error(`--database-url-env 只能给一次。${USAGE}`);
      envName = arg.slice('--database-url-env='.length);
    } else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`未知参数 ${arg}。${USAGE}`);
  }
  if (!envName || !/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new Error(`必须用 --database-url-env=<大写变量名> 显式指定目标。${USAGE}`);
  if (RESERVED_ENV_NAMES.has(envName)) {
    throw new Error(`--database-url-env 不能是 ${envName}：生产入口只读专用变量（例如 PROD_DATABASE_URL），不复用应用或测试库的连接变量`);
  }
  if (command === 'check') {
    if (apply || dryRun) throw new Error(`check 只读，不接受 --apply / --dry-run。${USAGE}`);
    return { command, envName, mode: 'read-only' };
  }
  if (apply && dryRun) throw new Error(`--apply 与 --dry-run 不能同时给。${USAGE}`);
  return { command, envName, mode: apply ? 'apply' : 'dry-run' };
}

// 只读盘点：整段在 READ ONLY 事务里，数据库层面保证零写入。
export async function inspectReadOnly(client, migrations) {
  await client.query('BEGIN READ ONLY');
  let report;
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    report = await inspectSchema(client, TARGET_SCHEMA);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
  return {
    report,
    verdict: evaluateSchema(report, migrations),
    ledger: planMigrations(report.versions, migrations),
    runtimeColumns: checkRuntimeColumns(report.columns),
  };
}

const runtimeColumnRows = (columns) => columns.filter((column) => column.table_name in EXPECTED_RUNTIME_COLUMNS);

// 将写入的记账行：每个待执行版本一行 schema_migrations；迁移 SQL 自带的 auth 记账（0001 写 1–4）一并列出。
export function plannedLedgerWrites(pending, migrations) {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const writes = [];
  for (const { version, name, checksum } of pending) {
    writes.push({ table: 'schema_migrations', version, name, checksum });
    const sql = byVersion.get(version)?.sql ?? '';
    for (const matched of sql.matchAll(/INSERT INTO auth_schema_migrations\s*\(version\)\s*VALUES\s*([^;]+?)\s*ON CONFLICT/gi)) {
      writes.push({ table: 'auth_schema_migrations', byVersion: version, values: matched[1].replace(/\s+/g, ''), onConflict: 'DO NOTHING' });
    }
  }
  return writes;
}

function describeColumnProblem(problem) {
  const actual = problem.actual ? JSON.stringify(problem.actual) : '缺列';
  return `${problem.table}.${problem.column} 与 0003 声明不一致：期望 ${JSON.stringify(problem.expected)}，实际 ${actual}`;
}

/** @returns {Promise<Record<string, any>>} */
export async function runProdCheck(client, migrations) {
  const { report, verdict, ledger, runtimeColumns } = await inspectReadOnly(client, migrations);
  const ok = verdict.ok && !ledger.errors.length && runtimeColumns.ok;
  return {
    command: 'check', status: ok ? 'ok' : 'not-ok', ok, schema: TARGET_SCHEMA, expectedVersion: SCHEMA_VERSION,
    versions: report.versions, expectedMigrations: verdict.expectedMigrations, checksumOk: verdict.checksumOk,
    ledger: { status: ledger.status, pending: ledger.pending, errors: ledger.errors },
    authVersion: verdict.authVersion, expectedAuthVersion: verdict.expectedAuthVersion, authVersionOk: verdict.authVersionOk,
    missingTables: verdict.missingTables, dangerous: report.dangerous,
    runtimeColumns: { ...runtimeColumns, rows: runtimeColumnRows(report.columns) },
  };
}

// 从未登记的已有库：没有 schema_migrations，却已有迁移要建的表。对它 --apply 会把 0001 整份在在线表上重跑
// （ALTER COLUMN / UPDATE / SET NOT NULL），而不是只补记账——生产正是这个形态（prodmig41，2026-09-24）。
// 冷建库只能是空库；已有库先用 db:baseline:prod 核对并登记。
export function unadoptedRefusal(report) {
  const present = new Set(report.columns.map((column) => column.table_name));
  if (present.has('schema_migrations')) return [];
  const existing = EXPECTED_TABLES.filter((table) => present.has(table));
  if (!existing.length) return [];
  return [`库里没有 schema_migrations，却已有 ${existing.length} 张迁移管理的表（${existing.slice(0, 5).join(', ')}${existing.length > 5 ? ' …' : ''}）：`
    + '这是从未登记的已有库，不能让 migrate 重跑 0001；先用 db:baseline:prod 核对并登记。冷建库须从空库开始'];
}

/** @returns {Promise<Record<string, any>>} 形状随 status 变化（refused / dry-run / up-to-date / unchanged / applied） */
export async function runProdMigrate(client, migrations, mode) {
  const before = await inspectReadOnly(client, migrations);
  const base = {
    command: 'migrate', mode, targetVersion: SCHEMA_VERSION,
    ledger: { status: before.ledger.status, unchanged: before.ledger.unchanged, pending: before.ledger.pending, errors: before.ledger.errors },
    runtimeColumns: { ok: before.runtimeColumns.ok, problems: before.runtimeColumns.problems, extra: before.runtimeColumns.extra,
      absentTables: before.runtimeColumns.absentTables },
  };
  const refusals = [
    ...before.ledger.errors.map((item) => item.message),
    ...before.runtimeColumns.problems.map(describeColumnProblem),
    ...unadoptedRefusal(before.report),
  ];
  if (refusals.length) return { ...base, status: 'refused', refusals };
  if (mode === 'dry-run') {
    return { ...base, status: before.ledger.pending.length ? 'dry-run' : 'up-to-date',
      ledgerWrites: plannedLedgerWrites(before.ledger.pending, migrations) };
  }
  if (!before.ledger.pending.length) return { ...base, status: 'unchanged', after: null };
  const applied = await applyMigration(client, migrations, { strict: true });
  const after = await inspectReadOnly(client, migrations);
  return {
    ...base, status: applied.status, versions: applied.versions,
    after: {
      ok: after.verdict.ok && !after.ledger.errors.length && after.runtimeColumns.ok,
      checksumOk: after.verdict.checksumOk, missingTables: after.verdict.missingTables,
      authVersion: after.verdict.authVersion, authVersionOk: after.verdict.authVersionOk, runtimeColumnsOk: after.runtimeColumns.ok,
    },
    // 冷建库：0001 只把 auth 记账到 4，这里 authVersionOk=false 是预期，下一步 migrate:auth:prod 补 5–7。
    next: after.verdict.authVersionOk ? null : '运行 npm run migrate:auth:prod（同一 --database-url-env）补 auth 记账，再跑 db:check:prod',
  };
}

// baseline 的只读核对：与 check 同样整段在 READ ONLY 事务里。
async function verifyBaselineReadOnly(client, migrations) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    return await verifyBaseline(client, migrations);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

function describeBaseline(verdict) {
  return { authVersion: verdict.authVersion, checked: verdict.checked, problems: verdict.problems, extra: verdict.extra,
    absent: verdict.absent, data: verdict.data };
}

/** @returns {Promise<Record<string, any>>} 形状随 status 变化（refused / dry-run / applied） */
export async function runProdBaseline(client, migrations, mode) {
  const before = await verifyBaselineReadOnly(client, migrations);
  const base = { command: 'baseline', mode, ...describeBaseline(before) };
  if (!before.ok) return { ...base, status: 'refused', refusals: before.refusals };
  if (mode === 'dry-run') return { ...base, status: 'dry-run', ledgerWrites: baselineLedgerWrites(migrations) };
  // 锁内再核一遍：dry-run 之后到拿锁之间库被改了，就在这里回滚并拒绝。
  const applied = await applyBaseline(client, migrations);
  if (applied.status === 'refused') {
    return { ...base, ...describeBaseline(applied.verdict), status: 'refused', refusals: applied.verdict.refusals };
  }
  const after = await runProdCheck(client, migrations);
  return { ...base, status: 'applied', versions: applied.versions,
    after: { ok: after.ok, checksumOk: after.checksumOk, ledger: after.ledger, authVersionOk: after.authVersionOk,
      missingTables: after.missingTables, runtimeColumnsOk: after.runtimeColumns.ok } };
}

export function exitCodeOf(result) {
  if (result.command === 'check') return result.ok ? 0 : 2;
  return result.status === 'refused' ? 2 : 0;
}

async function openClient(connectionString) {
  const client = createClient(connectionString);
  await client.connect();
  return client;
}

// 依赖可注入：测试用 PGlite 客户端与假连接串走完整 main，断言输出里没有连接串。
/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, open?: (connectionString: string) => Promise<any>,
 *   probe?: (connectionString: string) => Promise<{ serializedLocks: boolean, transactionPinned: boolean }>,
 *   log?: (line: string) => void, logError?: (line: string) => void, migrations?: any[] }} [options]
 * @returns {Promise<number>} 退出码
 */
export async function main({
  argv = process.argv.slice(2), env = process.env, open = openClient, probe = probeEndpoint,
  log = console.log, logError = console.error, migrations,
} = {}) {
  let client;
  try {
    const { command, envName, mode } = parseProdArgs(argv);
    const { connectionString, host } = readDatabaseUrl(envName, env);
    log(JSON.stringify({ phase: 'target', command, envName, host, mode }));
    if (mode === 'apply') {
      // 与 db:migrate 同样：执行前实测事务固定与 advisory lock 互斥，任一不成立就拒绝。
      const endpoint = await probe(connectionString);
      if (!endpoint.serializedLocks || !endpoint.transactionPinned) {
        throw new Error(`连接端点不满足迁移所需的事务语义（serializedLocks=${endpoint.serializedLocks}, transactionPinned=${endpoint.transactionPinned}）`);
      }
    }
    const list = migrations ?? await loadMigrations();
    client = await open(connectionString);
    const run = { check: () => runProdCheck(client, list), migrate: () => runProdMigrate(client, list, mode),
      baseline: () => runProdBaseline(client, list, mode) };
    const result = await run[command]();
    log(JSON.stringify({ phase: 'complete', host, ...result }, null, 2));
    return exitCodeOf(result);
  } catch (error) {
    logError(JSON.stringify({ status: 'failed', error: safeError(error) }));
    return 1;
  } finally {
    if (client?.end) await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
