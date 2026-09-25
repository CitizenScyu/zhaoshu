// storage_repositories 仓位登记的生产入口（41-coldbuild，tempdb41 §缺陷 D1 的第三项）。
//
// 为什么需要：artifact schema 建好只给了两张空表。T8 worker 启动时用
// `runtime-download/repository.ts resolveRepositoryId` 按 (owner, repo, branch) 反查一条
// **可写**（enabled ∧ is_private ∧ ¬read_only ∧ sealed_at IS NULL）的 storage_repositories 行：
// 没有这一行就抛 'no writable storage_repositories row for GITHUB_REPOSITORY/branch'。
// 冷建库上这一步此前只有「手敲 INSERT」（tempdb41 现场就是手敲 id=1），没有仓内入口。
//
// 本脚本登记一行，键从既有配置读出，不写死仓库名、不涉及任何密钥：
//   owner/repo  取自 --repo=owner/repo，缺省回落到环境变量 ZHAOSHU_BOOKS_REPO，再缺省用
//               src/lib/github.ts 的同一缺省 'CitizenScyu/zhaoshu-books'（代码里的现役值）。
//   branch      取自 --branch=…，缺省回落到 DOWNLOAD_TARGET_BRANCH，再缺省 'main'
//               （与 runtime-download/entry.ts:71 的解析链一致）。
// 幂等：按 registry 自己的唯一身份索引（lower(owner), lower(repo)）查。
//   - 已有满足可写判据的行 → 什么都不写（unwritable 的既有行只报告，不擅自改，避免把
//     人工封存 sealed / read_only 的行悄悄解封）。
//   - 没有任何同身份行 → INSERT 一行启用中的私库可写仓位。
// 默认 dry-run（只读报告会做什么）；显式 --apply 才写。
//
// 目标必须显式给出：--database-url-env=<变量名>（脚本不读 .env*，不回退 DATABASE_URL /
// TEST_DATABASE_URL）。输出只含 host 与仓位键的形状（owner/repo 不是秘密），不含连接串。
import { neon } from '@neondatabase/serverless';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProdDatabaseUrlEnv, readDatabaseUrl } from './migrate-auth-prod.mjs';
import { safeError } from './db-migration-lib.mjs';

// 与 src/lib/github.ts:3 同一缺省；只作为「配置里没给」时的现役值，不是唯一真相。
export const DEFAULT_REPO = 'CitizenScyu/zhaoshu-books';
export const DEFAULT_BRANCH = 'main';

const USAGE = '用法: register-storage-repository.mjs --database-url-env=<变量名> [--repo=owner/repo] [--branch=<name>] [--dry-run | --apply]';

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseRegisterArgs(argv, env = process.env) {
  let envName = null;
  let repo = null;
  let branch = null;
  let apply = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg.startsWith('--database-url-env=')) {
      if (envName !== null) throw new Error(`--database-url-env 只能给一次。${USAGE}`);
      envName = arg.slice('--database-url-env='.length);
    } else if (arg.startsWith('--repo=')) repo = arg.slice('--repo='.length);
    else if (arg.startsWith('--branch=')) branch = arg.slice('--branch='.length);
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`未知参数 ${arg}。${USAGE}`);
  }
  assertProdDatabaseUrlEnv(envName, USAGE);
  if (apply && dryRun) throw new Error(`--apply 与 --dry-run 不能同时给。${USAGE}`);
  const full = (repo ?? env.ZHAOSHU_BOOKS_REPO ?? DEFAULT_REPO).trim();
  const [owner, name, extra] = full.split('/');
  if (!owner || !name || extra !== undefined) throw new Error(`仓库键必须是 owner/repo 形态（来自 --repo 或 ZHAOSHU_BOOKS_REPO）；缺省 ${DEFAULT_REPO}。${USAGE}`);
  const branchName = (branch ?? env.DOWNLOAD_TARGET_BRANCH ?? DEFAULT_BRANCH).trim();
  if (!branchName) throw new Error(`分支名不能为空（--branch 或 DOWNLOAD_TARGET_BRANCH）。${USAGE}`);
  return { envName, mode: apply ? 'apply' : 'dry-run', owner, repo: name, branch: branchName };
}

// 只读盘点同身份（lower(owner), lower(repo)）的既有行。查询键就是 registry 的唯一索引
// storage_repositories_identity_idx（存储库名大小写不敏感 ⇒ 一个 repo 身份只能有一行，与分支无关），
// 因此不按 branch 过滤：分支不符也要能看见并如实报告，而不是误判「无行」再去 INSERT（会撞唯一索引）。
// 可写判据与 runtime-download/repository.ts:11-16 的 resolveRepositoryId 同一条：
// enabled ∧ is_private ∧ ¬read_only ∧ sealed_at IS NULL ∧ branch 相符。
export async function inspectRegistration(sql, key) {
  const rows = await sql`
    SELECT id, owner, repo, branch, enabled, is_private, read_only, sealed_at
    FROM storage_repositories
    WHERE lower(owner) = lower(${key.owner}) AND lower(repo) = lower(${key.repo})
    LIMIT 1`;
  const row = rows[0];
  if (!row) return { present: false };
  const flagsOk = row.enabled && row.is_private && !row.read_only && row.sealed_at === null;
  const branchOk = row.branch === key.branch;
  return { present: true, writable: flagsOk && branchOk, branchOk,
    existing: { id: Number(row.id), owner: row.owner, repo: row.repo, branch: row.branch,
      enabled: row.enabled, private: row.is_private, readOnly: row.read_only, sealed: row.sealed_at !== null } };
}

// 纯函数：决定对这次目标做什么。已有可写行 → noop；已有但不可写 / 分支不符 → refused（不擅自解封）；
// 无行 → insert。
export function planRegistration(state, key) {
  if (state.present && state.writable) {
    return { status: 'noop', reason: `已存在可写仓位 id=${state.existing.id}（branch=${state.existing.branch}），无需登记`, existing: state.existing };
  }
  if (state.present && !state.branchOk) {
    return { status: 'refused', reason: `已存在同身份仓位 id=${state.existing.id} 但 branch=${state.existing.branch} ≠ 目标 ${key.branch}；仓库身份唯一（storage_repositories_identity_idx 只看 owner/repo），不能再插一行，请人工核对后处理`, existing: state.existing };
  }
  if (state.present) {
    return { status: 'refused', reason: `已存在同身份仓位 id=${state.existing.id} 但不满足可写判据（enabled=${state.existing.enabled}, private=${state.existing.private}, readOnly=${state.existing.readOnly}, sealed=${state.existing.sealed}）；不擅自改动人工状态，请人工核对后处理`, existing: state.existing };
  }
  return { status: 'insert', planned: { table: 'storage_repositories', owner: key.owner, repo: key.repo, branch: key.branch,
    enabled: true, is_private: true, read_only: false } };
}

export async function runRegistration(sql, key, mode) {
  const plan = planRegistration(await inspectRegistration(sql, key), key);
  const base = { mode, repo: `${key.owner}/${key.repo}`, branch: key.branch, ...plan };
  if (mode === 'dry-run' || plan.status !== 'insert') return { ...base, status: plan.status === 'insert' ? 'dry-run' : plan.status };
  const [{ id }] = await sql`
    INSERT INTO storage_repositories (owner, repo, branch, enabled, is_private, read_only)
    VALUES (${key.owner}, ${key.repo}, ${key.branch}, true, true, false)
    RETURNING id`;
  return { ...base, status: 'applied', id: Number(id) };
}

async function main() {
  try {
    const { envName, mode, owner, repo, branch } = parseRegisterArgs(process.argv.slice(2));
    const { connectionString, host } = readDatabaseUrl(envName);
    console.log(JSON.stringify({ phase: 'target', envName, host, mode }));
    const report = await runRegistration(neon(connectionString), { owner, repo, branch }, mode);
    console.log(JSON.stringify({ phase: 'complete', host, ...report }, null, 2));
    // refused 是「人工核对」类结果，与 db-prod 的 refused 同口径给退出码 2（未写库）。
    if (report.status === 'refused') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
