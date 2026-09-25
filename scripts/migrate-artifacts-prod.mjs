// artifact schema（storage_repositories / book_artifacts / download_tasks.artifact_id FK）的生产入口。
//
// 为什么需要：`scripts/migrate-artifacts.mjs` 只吃 `TEST_DATABASE_URL`（隔离库演练工具），
// docs/auth-deployment.md 又禁止「把生产连接冒充 TEST_DATABASE_URL」——于是冷建库 / 生产补 artifact
// schema 在仓内没有合规入口。tempdb41 冷建演练（tempdb-41-report.md §缺陷 D1）里只能把临时库连接串
// 塞进 TEST_DATABASE_URL 跑，违背该约定；T8 worker 也因此启动即 `relation "storage_repositories" does not exist`。
// 本脚本就是那个入口，与 migrate-auth-prod.mjs 同一套约束。
//
// 迁移本体完全复用 `initializeArtifactSchema`（src/lib/artifact-schema.ts），不复制任何 DDL：
// 它按自有记账表 artifact_schema_migrations 的 version=1 判断是否已执行，因此幂等、可重复执行。
//
// 目标必须显式给出，没有默认值或回退：
//   --database-url-env=<变量名>  从哪个环境变量读连接串（脚本不读 .env*，也不回退 DATABASE_URL / TEST_DATABASE_URL）
//   --dry-run                    只读：报告当前记账版本与将执行的步骤，不写库
//   --yes-i-mean-production      真执行（与 --dry-run 二选一，缺了就拒绝）
// 输出只含目标 host 与版本信息，不含连接串或凭据。
import { neon } from '@neondatabase/serverless';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACT_SCHEMA_VERSION, initializeArtifactSchema } from '../src/lib/artifact-schema.ts';
import { readDatabaseUrl } from './migrate-auth-prod.mjs';
import { safeError } from './db-migration-lib.mjs';

const USAGE = '用法: migrate-artifacts-prod.mjs --database-url-env=<变量名> (--dry-run | --yes-i-mean-production)';

// 该版本在 initializeArtifactSchema 里做什么（dry-run 报告用；DDL 本身只在 artifact-schema.ts）。
export const ARTIFACT_VERSION_STEPS = {
  1: 'storage_repositories / book_artifacts 两表、download_tasks.artifact_id 列与 artifact FK（+ 幂等修复）',
};

export function parseArtifactMigrationArgs(argv) {
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
  if (!envName || !/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new Error(`必须用 --database-url-env=<大写变量名> 显式指定目标。${USAGE}`);
  if (['DATABASE_URL', 'TEST_DATABASE_URL'].includes(envName)) {
    throw new Error(`--database-url-env 不能是 ${envName}：生产入口只读专用变量（例如 PROD_DATABASE_URL），不复用应用或测试库的连接变量`);
  }
  if (dryRun === confirmed) throw new Error(`--dry-run 与 --yes-i-mean-production 必须且只能给一个。${USAGE}`);
  return { envName, mode: dryRun ? 'dry-run' : 'apply' };
}

export async function readArtifactVersions(sql) {
  const [{ present }] = await sql`SELECT to_regclass('artifact_schema_migrations') IS NOT NULL AS present`;
  if (!present) return { tablePresent: false, versions: [], max: null };
  const rows = await sql`SELECT version FROM artifact_schema_migrations ORDER BY version`;
  const versions = rows.map((row) => Number(row.version));
  return { tablePresent: true, versions, max: versions.length ? Math.max(...versions) : null };
}

// initializeArtifactSchema 按「该版本有没有记账行」判断，而不是按 max；这里用同一口径算待执行步骤。
export function planArtifactMigration(state) {
  if (state.max !== null && state.max > ARTIFACT_SCHEMA_VERSION) {
    return { status: 'newer-than-code', pending: [],
      note: `库 artifact 版本 ${state.max} 高于代码支持的 ${ARTIFACT_SCHEMA_VERSION}；迁移器会 RAISE，拒绝执行` };
  }
  const recorded = new Set(state.versions);
  const pending = [];
  for (let version = 1; version <= ARTIFACT_SCHEMA_VERSION; version += 1) {
    if (!recorded.has(version)) pending.push({ version, step: ARTIFACT_VERSION_STEPS[version] });
  }
  return { status: pending.length ? 'pending' : 'up-to-date', pending };
}

export async function runArtifactMigration(sql, mode) {
  const before = await readArtifactVersions(sql);
  const plan = planArtifactMigration(before);
  const report = { mode, targetVersion: ARTIFACT_SCHEMA_VERSION, before, plan };
  if (mode === 'dry-run') return { ...report, status: 'dry-run', after: null };
  if (plan.status === 'newer-than-code') throw new Error(plan.note);
  await initializeArtifactSchema(sql);
  const after = await readArtifactVersions(sql);
  return { ...report, status: plan.pending.length ? 'applied' : 'unchanged', after };
}

async function main() {
  try {
    const { envName, mode } = parseArtifactMigrationArgs(process.argv.slice(2));
    const { connectionString, host } = readDatabaseUrl(envName);
    console.log(JSON.stringify({ phase: 'target', envName, host, mode }));
    const report = await runArtifactMigration(neon(connectionString), mode);
    console.log(JSON.stringify({ phase: 'complete', host, ...report }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
