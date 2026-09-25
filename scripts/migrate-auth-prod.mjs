// 生产（或任何显式指定的）库的 auth schema 迁移入口（MS-24）。
//
// migrate:auth 只吃 TEST_DATABASE_URL，是隔离库演练工具；docs/auth-deployment.md 又明文禁止
// 「把生产连接冒充 TEST_DATABASE_URL」——于是生产升版本 / 冷建库补 v5-v7 在仓内没有合规入口。
// 本脚本就是那个入口，迁移本体完全复用 initializeAuthSchema（不复制任何 DDL），因此与
// migrate:auth 同样幂等：已记账的版本逐个跳过，重复执行不改任何东西。
//
// 目标必须显式给出，没有任何默认值或回退：
//   --database-url-env=<变量名>  从哪个环境变量读连接串（脚本不读 .env*，也不回退 DATABASE_URL）
//   --dry-run                    只读：报告当前记账版本与将执行的版本步骤，不写库
//   --yes-i-mean-production      真执行（与 --dry-run 二选一，缺了就拒绝）
// 输出只含目标 host 与版本信息，不输出连接串或凭据。
import { neon } from '@neondatabase/serverless';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTH_SCHEMA_VERSION, assertAuthSchema, initializeAuthSchema } from '../src/lib/auth-store.ts';
import { safeError } from './db-migration-lib.mjs';

// 每个版本在 initializeAuthSchema 里做什么（dry-run 报告用；DDL 本身只在 auth-store.ts）。
export const AUTH_VERSION_STEPS = {
  1: 'users / auth_settings / sessions / auth_rate_limits 基础表与固定 owner',
  2: '同批基础表记账（与 v1 同一段 DDL）',
  3: 'profile / recommendations / feedback 归属 owner：user_id 列、用户外键、用户范围索引',
  4: '移除 recommendations 的全局唯一键，保留 (user_id, book_id, query)',
  5: 'download_tasks 归属：user_id 列、用户外键、活动任务唯一索引',
  6: 'registration_invites 表与 users.created_via_invite_id 外键',
  7: 'download_tasks 系统任务列、约束与索引（requested_by / lease_generation 等）',
};

const USAGE = '用法: migrate-auth-prod.mjs --database-url-env=<变量名> (--dry-run | --yes-i-mean-production)';

export function parseAuthMigrationArgs(argv) {
  let envName = null;
  let dryRun = false;
  let confirmed = false;
  for (const arg of argv) {
    if (arg.startsWith('--database-url-env=')) {
      if (envName !== null) throw new Error(`--database-url-env 只能给一次。${USAGE}`);
      envName = arg.slice('--database-url-env='.length);
    } else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--yes-i-mean-production') confirmed = true;
    else throw new Error(`未知参数 ${arg}。${USAGE}`);
  }
  assertProdDatabaseUrlEnv(envName, USAGE);
  if (dryRun === confirmed) throw new Error(`--dry-run 与 --yes-i-mean-production 必须且只能给一个。${USAGE}`);
  return { envName, mode: dryRun ? 'dry-run' : 'apply' };
}

// 应用与隔离库各自的连接变量。生产入口只读运维专用变量，免得 shell 里残留的应用 / 测试连接被误当目标。
const RESERVED_ENV_NAMES = new Set(['DATABASE_URL', 'TEST_DATABASE_URL']);

// 所有 `--database-url-env` 生产入口（本文件、db-prod、migrate-artifacts-prod、register-storage-repository）
// 共用的目标变量名闸门（41-bookidfk）：以前各抄一份，本入口漏了拒收 DATABASE_URL / TEST_DATABASE_URL。
/** @param {string | null} envName @param {string} usage */
export function assertProdDatabaseUrlEnv(envName, usage = '') {
  const suffix = usage ? `。${usage}` : '';
  if (!envName || !/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new Error(`必须用 --database-url-env=<大写变量名> 显式指定目标${suffix}`);
  if (RESERVED_ENV_NAMES.has(envName)) {
    throw new Error(`--database-url-env 不能是 ${envName}：生产入口只读专用变量（例如 PROD_DATABASE_URL），不复用应用或测试库的连接变量`);
  }
}

// 只校验形状并取出 host 供人核对；连接串本身不出本函数的返回值以外的任何地方。
/** @param {string} envName @param {Record<string, string | undefined>} [env] */
export function readDatabaseUrl(envName, env = process.env) {
  assertProdDatabaseUrlEnv(envName);
  const value = env[envName]?.trim();
  if (!value) throw new Error(`环境变量 ${envName} 为空；不会回退到 DATABASE_URL，也不会读取 .env 文件`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`环境变量 ${envName} 不是有效的连接 URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`环境变量 ${envName} 必须是 PostgreSQL URL`);
  return { connectionString: value, host: url.hostname };
}

export async function readAuthVersions(sql) {
  const [{ present }] = await sql`SELECT to_regclass('auth_schema_migrations') IS NOT NULL AS present`;
  if (!present) return { tablePresent: false, versions: [], max: null };
  const rows = await sql`SELECT version FROM auth_schema_migrations ORDER BY version`;
  const versions = rows.map((row) => Number(row.version));
  return { tablePresent: true, versions, max: versions.length ? Math.max(...versions) : null };
}

// initializeAuthSchema 按「该版本有没有记账行」逐块判断，而不是按 max；这里用同一口径算待执行步骤。
export function planAuthMigration(state) {
  if (state.max !== null && state.max > AUTH_SCHEMA_VERSION) {
    return { status: 'newer-than-code', pending: [],
      note: `库 auth 版本 ${state.max} 高于代码支持的 ${AUTH_SCHEMA_VERSION}；迁移器会 RAISE，拒绝执行` };
  }
  const recorded = new Set(state.versions);
  const pending = [];
  for (let version = 1; version <= AUTH_SCHEMA_VERSION; version += 1) {
    if (!recorded.has(version)) pending.push({ version, step: AUTH_VERSION_STEPS[version] });
  }
  return { status: pending.length ? 'pending' : 'up-to-date', pending };
}

export async function runAuthMigration(sql, mode) {
  const before = await readAuthVersions(sql);
  const plan = planAuthMigration(before);
  const report = { mode, targetVersion: AUTH_SCHEMA_VERSION, before, plan };
  if (mode === 'dry-run') return { ...report, status: 'dry-run', after: null };
  if (plan.status === 'newer-than-code') throw new Error(plan.note);
  await initializeAuthSchema(sql);
  await assertAuthSchema(sql);
  const after = await readAuthVersions(sql);
  return { ...report, status: plan.pending.length ? 'applied' : 'unchanged', after };
}

async function main() {
  try {
    const { envName, mode } = parseAuthMigrationArgs(process.argv.slice(2));
    const { connectionString, host } = readDatabaseUrl(envName);
    console.log(JSON.stringify({ phase: 'target', envName, host, mode }));
    const report = await runAuthMigration(neon(connectionString), mode);
    console.log(JSON.stringify({ phase: 'complete', host, ...report }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
