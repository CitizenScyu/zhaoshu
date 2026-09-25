// artifact schema（storage_repositories / book_artifacts / download_tasks.artifact_id FK）的生产入口。
//
// 为什么需要：`scripts/migrate-artifacts.mjs` 只吃 `TEST_DATABASE_URL`（隔离库演练工具），
// docs/auth-deployment.md 又禁止「把生产连接冒充 TEST_DATABASE_URL」——于是冷建库 / 生产补 artifact
// schema 在仓内没有合规入口。tempdb41 冷建演练（tempdb-41-report.md §缺陷 D1）里只能把临时库连接串
// 塞进 TEST_DATABASE_URL 跑，违背该约定；T8 worker 也因此启动即 `relation "storage_repositories" does not exist`。
// 本脚本就是那个入口，与 migrate-auth-prod.mjs 同一套约束。
//
// 迁移本体完全复用 `initializeArtifactSchema`（src/lib/artifact-schema.ts），不复制任何 DDL：
// 它按自有记账表 artifact_schema_migrations 的逐版本记账判断是否已执行，因此幂等、可重复执行。
//
// v2（41-bookidfk）给 download_tasks.book_id 加指向 labeled_books(id) 的外键。存量孤儿行（book_id 不在
// labeled_books）会让加外键失败，所以 dry-run 与 apply 都先只读计数：>0 时 plan.status=refused、打印计数与
// book_id 范围，apply 不调用迁移、不写库，退出码 2。本脚本**从不删数据**：清孤儿由运维按
// docs/artifact-registry.md 的预检 SQL 人工执行。迁移本体里还有同一条判据（锁内再数一次），防 dry-run 之后又进孤儿。
//
// 目标必须显式给出，没有默认值或回退：
//   --database-url-env=<变量名>  从哪个环境变量读连接串（脚本不读 .env*，也不回退 DATABASE_URL / TEST_DATABASE_URL）
//   --dry-run                    只读：报告当前记账版本与将执行的步骤，不写库
//   --yes-i-mean-production      真执行（与 --dry-run 二选一，缺了就拒绝）
// 输出只含目标 host、版本信息与孤儿计数，不含连接串或凭据。
// 退出码：0 完成；2 预检拒绝（未写库）；1 参数、连接或执行错误。
import { neon } from '@neondatabase/serverless';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACT_SCHEMA_VERSION, initializeArtifactSchema } from '../src/lib/artifact-schema.ts';
import { assertProdDatabaseUrlEnv, readDatabaseUrl } from './migrate-auth-prod.mjs';
import { safeError } from './db-migration-lib.mjs';

const USAGE = '用法: migrate-artifacts-prod.mjs --database-url-env=<变量名> (--dry-run | --yes-i-mean-production)';

// 该版本在 initializeArtifactSchema 里做什么（dry-run 报告用；DDL 本身只在 artifact-schema.ts）。
export const ARTIFACT_VERSION_STEPS = {
  1: 'storage_repositories / book_artifacts 两表、download_tasks.artifact_id 列与 artifact FK（+ 幂等修复）',
  2: 'download_tasks.book_id → labeled_books(id) 外键 download_tasks_book_fk（NO ACTION；存量孤儿 >0 时拒绝，不删数据）',
};

export const BOOK_FK_NAME = 'download_tasks_book_fk';

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
  assertProdDatabaseUrlEnv(envName, USAGE);
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

// v2 外键的只读预检：外键在不在、有多少任务行的 book_id 不在 labeled_books（只报计数与 book_id 范围）。
// 冷建库在 artifact 迁移前 download_tasks / labeled_books 由 0001 建好，两表缺任一时视同无孤儿。
export async function readBookIdIntegrity(sql) {
  const [{ tasks, books }] = await sql`SELECT to_regclass('download_tasks') IS NOT NULL AS tasks,
    to_regclass('labeled_books') IS NOT NULL AS books`;
  if (!tasks || !books) return { fkPresent: false, orphanTasks: 0, orphanBookIdMin: null, orphanBookIdMax: null };
  const [{ fk }] = await sql`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
    AND conname = ${BOOK_FK_NAME}) AS fk`;
  const [row] = await sql`SELECT count(*)::int AS n, min(t.book_id)::int AS lo, max(t.book_id)::int AS hi
    FROM download_tasks t WHERE NOT EXISTS (SELECT 1 FROM labeled_books lb WHERE lb.id = t.book_id)`;
  return { fkPresent: Boolean(fk), orphanTasks: Number(row.n), orphanBookIdMin: row.lo ?? null, orphanBookIdMax: row.hi ?? null };
}

// initializeArtifactSchema 按「该版本有没有记账行」判断，而不是按 max；这里用同一口径算待执行步骤。
// integrity 缺省视同无孤儿（纯函数用例只看版本）；外键缺失且有孤儿时整份计划 refused。
/**
 * @param {{ tablePresent: boolean, versions: number[], max: number | null }} state
 * @param {{ fkPresent: boolean, orphanTasks: number, orphanBookIdMin?: number | null, orphanBookIdMax?: number | null }} [integrity]
 */
export function planArtifactMigration(state, integrity = { fkPresent: true, orphanTasks: 0 }) {
  if (state.max !== null && state.max > ARTIFACT_SCHEMA_VERSION) {
    return { status: 'newer-than-code', pending: [],
      note: `库 artifact 版本 ${state.max} 高于代码支持的 ${ARTIFACT_SCHEMA_VERSION}；迁移器会 RAISE，拒绝执行` };
  }
  const recorded = new Set(state.versions);
  const pending = [];
  for (let version = 1; version <= ARTIFACT_SCHEMA_VERSION; version += 1) {
    if (!recorded.has(version)) pending.push({ version, step: ARTIFACT_VERSION_STEPS[version] });
  }
  if (!integrity.fkPresent && integrity.orphanTasks > 0) {
    return { status: 'refused', pending, refusals: [
      `${integrity.orphanTasks} 条 download_tasks 的 book_id 不在 labeled_books（book_id 范围 `
      + `${integrity.orphanBookIdMin}..${integrity.orphanBookIdMax}），加 ${BOOK_FK_NAME} 会失败；`
      + '本迁移不删数据：先按 docs/artifact-registry.md「Pre-rollout check」核对并清理孤儿任务，再重跑',
    ] };
  }
  return { status: pending.length ? 'pending' : 'up-to-date', pending };
}

export async function runArtifactMigration(sql, mode) {
  const before = await readArtifactVersions(sql);
  const bookIdIntegrity = await readBookIdIntegrity(sql);
  const plan = planArtifactMigration(before, bookIdIntegrity);
  const report = { mode, targetVersion: ARTIFACT_SCHEMA_VERSION, before, bookIdIntegrity, plan };
  if (mode === 'dry-run') return { ...report, status: 'dry-run', after: null };
  if (plan.status === 'newer-than-code') throw new Error(plan.note);
  if (plan.status === 'refused') return { ...report, status: 'refused', after: null };
  await initializeArtifactSchema(sql);
  const after = await readArtifactVersions(sql);
  return { ...report, status: plan.pending.length ? 'applied' : 'unchanged', after };
}

/** 报告 → 退出码：预检拒绝（dry-run 也算，便于脚本化判定）为 2，其余 0。 */
export function artifactMigrationExitCode(report) {
  return report.status === 'refused' || report.plan.status === 'refused' ? 2 : 0;
}

async function main() {
  try {
    const { envName, mode } = parseArtifactMigrationArgs(process.argv.slice(2));
    const { connectionString, host } = readDatabaseUrl(envName);
    console.log(JSON.stringify({ phase: 'target', envName, host, mode }));
    const report = await runArtifactMigration(neon(connectionString), mode);
    console.log(JSON.stringify({ phase: 'complete', host, ...report }, null, 2));
    process.exitCode = artifactMigrationExitCode(report);
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
