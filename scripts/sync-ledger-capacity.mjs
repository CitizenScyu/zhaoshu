// sync-ledger-capacity: 把 GitHub 实测逻辑字节回写进 repository_capacity_ledger.registered_bytes。
//
// 为什么需要（ledgersync41 任务书背景，主会话 2026-10-15 亲验）：
//   仓满切换的判据是 `decideRepositoryForPublication`（runtime-download/repository-rollover.ts:223）
//   的 `registered_bytes + reserved_bytes + logicalBytes <= target_bytes`。但设计上 registered_bytes
//   由「预留→confirm」链（artifact-capacity.ts 的 reserved→registered 转移）维护，而 phoenix 发布路径
//   **不调** reserve/confirm（artifact_capacity_reservations 表全空），`reconcileInitialization` 也无生产
//   调用方 ⇒ 台账永不累计：repo1 的 1.85GB 是 2026-10-13 一次性手写，现役仓 zhaoshu-books-2 自
//   10-13 08:21 初始化后 registered_bytes 恒 0。后果 = books-2 满仓时 decide 仍选 books-2，永不切 books-3。
//   本脚本把 GitHub tree 的实测逻辑字节作为**观测**值回写，使判据重新有数据基础。
//
// 口径（docs/artifact-registry.md:151）：
//   registered_bytes = 观测到的 canonical TXT **逻辑**字节；current_tree_bytes 才含 snapshots。
//   故本脚本对 `<tree-root>/**`（缺省 books/）下的**普通 blob**（mode 100644/100755，与
//   reconcile-tree-snapshot.ts:144 的 regular-blob 同判据）求 `size` 之和，并**排除**路径中任何
//   `.snapshots` 段。符号链接 blob（120000）与 gitlink（160000）不是 TXT 内容，不计。
//
// 树完整性（与 reconcile-tree-snapshot.ts:211 同红线）：递归树返回 `truncated: true` 时**不采信部分和**
//   ——部分和会**低估**容量，比高估更危险（账目以为还有余量、实际已满）。改为按子树逐层下钻补齐
//   （等价于分页枚举）；下钻到底仍截断则该仓失败关闭、不写库、不当空树。
//
// 幂等：重跑重算；算得的值与库中现值相同即 status='unchanged'、不产生写。同值重跑不产生实质变更。
//
// 硬约束：
//   - 默认 dry-run（只报告会做什么）；显式 --apply 才写。
//   - 目标必须显式给出：--database-url-env=<大写变量名>（复用 assertProdDatabaseUrlEnv：不读 .env*、
//     不回退 DATABASE_URL/TEST_DATABASE_URL）与 --github-token-env=<大写变量名>。token/连接串只在脚本
//     内部送往 GitHub/DB，既不进输出也不进错误消息（错误统一过 safeError）。
//   - 仓列表从 DB 读（storage_repositories 全表的 enabled 行），不写死仓名。
//   - 只 UPDATE registered_bytes + updated_at；不改 state / target_bytes / admission_*（不在本任务范围）。
//
// 出口码：0=全部处理完（含 unchanged / dry-run）；1=有仓失败（至少一仓未取到可信值）；2=参数错误。
import { neon } from '@neondatabase/serverless';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProdDatabaseUrlEnv, readDatabaseUrl } from './migrate-auth-prod.mjs';
import { safeError } from './db-migration-lib.mjs';

export const DEFAULT_TREE_ROOT = 'books';
/** 普通 blob 的 git mode：与 reconcile-tree-snapshot.ts:144 的 regular-blob 同判据。 */
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);
/** 下钻层数上限：只在递归树被截断时用，防止异常深目录打爆请求数。 */
const MAX_DRILL_DOWN_DEPTH = 8;

const USAGE = '用法: sync-ledger-capacity.mjs --database-url-env=<变量名> --github-token-env=<变量名> [--tree-root=books] [--dry-run | --apply]';

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseSyncArgs(argv, env = process.env) {
  let dbEnv = null;
  let ghEnv = null;
  let treeRoot = DEFAULT_TREE_ROOT;
  let apply = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg.startsWith('--database-url-env=')) {
      if (dbEnv !== null) throw new Error(`--database-url-env 只能给一次。${USAGE}`);
      dbEnv = arg.slice('--database-url-env='.length);
    } else if (arg.startsWith('--github-token-env=')) {
      if (ghEnv !== null) throw new Error(`--github-token-env 只能给一次。${USAGE}`);
      ghEnv = arg.slice('--github-token-env='.length);
    } else if (arg.startsWith('--tree-root=')) {
      treeRoot = arg.slice('--tree-root='.length);
    } else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`未知参数 ${arg}。${USAGE}`);
  }
  assertProdDatabaseUrlEnv(dbEnv, USAGE);
  if (!ghEnv || !ENV_NAME_RE.test(ghEnv)) {
    throw new Error(`必须用 --github-token-env=<大写变量名> 显式指定 token 来源。${USAGE}`);
  }
  if (apply && dryRun) throw new Error(`--apply 与 --dry-run 不能同时给。${USAGE}`);
  const root = treeRoot.trim().replace(/^\/+|\/+$/g, '');
  if (!root || root.includes('/')) throw new Error(`--tree-root 必须是单层目录名（缺省 ${DEFAULT_TREE_ROOT}）。${USAGE}`);
  return { dbEnv, ghEnv, treeRoot: root, mode: apply ? 'apply' : 'dry-run' };
}

/** 该仓树截断且下钻到底仍补不齐（fail closed，不写部分和）。 */
export class IncompleteTreeError extends Error {
  constructor(detail) {
    super(`INCOMPLETE_TREE:${detail}`);
    this.name = 'IncompleteTreeError';
    this.code = 'INCOMPLETE_TREE';
  }
}

/**
 * 路径是否计入 registered_bytes：在 treeRoot 之下、且不含任何 `.snapshots` 段。
 * 纯函数，便于单测直接喂边界路径。
 */
export function isCountedPath(path, treeRoot = DEFAULT_TREE_ROOT) {
  if (typeof path !== 'string' || !path) return false;
  const segments = path.split('/');
  if (segments[0] !== treeRoot) return false;
  return !segments.slice(1).includes('.snapshots');
}

/**
 * 纯函数：把一棵（或多棵拼接的）树条目折成 registered_bytes 口径的和。
 * 非普通 blob（tree/gitlink/符号链接）与缺 size 的 blob 一律失败关闭——缺 size 时用 0 顶替会
 * 静默低估容量（reconcile-tree-snapshot.ts:16 同口径：不造 0）。
 * prefix：子树列举返回的 path 是**相对该子树**的（`GET /git/trees/<sha>` 的真实语义），下钻时
 * 必须带上祖先前缀，否则子树的 'x/1.txt' 会被误判为不在 books 下而漏计。
 * @param {{path?: unknown, type?: unknown, mode?: unknown, size?: unknown}[]} entries
 * @param {string} [treeRoot]
 * @param {string} [prefix]
 * @returns {{bytes: bigint, fileCount: number}}
 */
export function sumRegisteredLogicalBytes(entries, treeRoot = DEFAULT_TREE_ROOT, prefix = '') {
  if (!Array.isArray(entries)) throw new IncompleteTreeError('tree is not an array');
  let bytes = BigInt(0);
  let fileCount = 0;
  for (const entry of entries) {
    if (entry == null || typeof entry !== 'object') throw new IncompleteTreeError('malformed tree entry');
    if (entry.type !== 'blob') continue;
    if (!REGULAR_BLOB_MODES.has(entry.mode)) continue;
    if (typeof entry.path !== 'string' || !entry.path) throw new IncompleteTreeError('tree entry missing path');
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (!isCountedPath(fullPath, treeRoot)) continue;
    const size = entry.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new IncompleteTreeError(`blob size missing or invalid: ${fullPath}`);
    }
    bytes += BigInt(size);
    fileCount += 1;
  }
  return { bytes, fileCount };
}

/**
 * 已认证的 GitHub 只读请求函数：由调用方完成认证（固定 host、拒跨 host 重定向）。
 * @typedef {(relativeRoute: string) => Promise<{ status: number, json(): Promise<unknown> }>} GitHubJsonRequest
 */

async function getTree(request, repo, treeRef, recursive) {
  const res = await request(`/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(treeRef)}?recursive=${recursive ? 1 : 0}`);
  if (typeof res?.status !== 'number' || !Number.isInteger(res.status) || res.status < 100 || res.status > 599) {
    throw new IncompleteTreeError('malformed response envelope');
  }
  if (res.status < 200 || res.status >= 300) throw new IncompleteTreeError(`GITHUB_TREE_HTTP_${res.status}`);
  const body = await res.json();
  if (body == null || typeof body !== 'object') throw new IncompleteTreeError('malformed tree body');
  if (!Array.isArray(body.tree)) throw new IncompleteTreeError('malformed tree entries');
  return { truncated: body.truncated === true, tree: body.tree };
}

/**
 * 取一棵子树（treeRef）的 counted logical bytes，条目路径相对该子树、由 prefix 补齐成仓内绝对路径。
 * 递归列举未截断即直接求和；截断则按非递归逐层下钻（等价分页），下钻到底仍截断 → IncompleteTreeError。
 */
export async function measureTreeLogicalBytes(request, repo, treeRef, treeRoot, prefix = '', depth = 0) {
  const recursive = await getTree(request, repo, treeRef, true);
  if (!recursive.truncated) return sumRegisteredLogicalBytes(recursive.tree, treeRoot, prefix);
  if (depth >= MAX_DRILL_DOWN_DEPTH) throw new IncompleteTreeError('still truncated after drill-down');
  const shallow = await getTree(request, repo, treeRef, false);
  if (shallow.truncated) throw new IncompleteTreeError('non-recursive tree truncated');
  let bytes = BigInt(0);
  let fileCount = 0;
  for (const entry of shallow.tree) {
    if (entry == null || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) {
      throw new IncompleteTreeError('malformed tree entry');
    }
    const childPrefix = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'tree') {
      if (typeof entry.sha !== 'string' || !entry.sha) throw new IncompleteTreeError('tree entry missing sha');
      const sub = await measureTreeLogicalBytes(request, repo, entry.sha, treeRoot, childPrefix, depth + 1);
      bytes += sub.bytes;
      fileCount += sub.fileCount;
    } else {
      const part = sumRegisteredLogicalBytes([entry], treeRoot, prefix);
      bytes += part.bytes;
      fileCount += part.fileCount;
    }
  }
  return { bytes, fileCount };
}

/**
 * 整仓一棵：先取整仓递归树（路径已是仓内绝对路径）。
 * 截断才下钻（逐子树）；若树里**根本没有 treeRoot 下的任何条目**，返回 missingRoot，让调用方
 * 失败关闭而不是把「目录被搬走了 / 仓空」当成 0 容量写进账本（低估比高估危险）。
 */
export async function measureRepositoryLogicalBytes(request, repo, treeRoot) {
  const whole = await getTree(request, repo, repo.branch, true);
  if (!whole.truncated) {
    const present = whole.tree.some(entry => isCountedPath(`${entry?.path ?? ''}`, treeRoot));
    return { ...sumRegisteredLogicalBytes(whole.tree, treeRoot), missingRoot: !present };
  }
  const shallow = await getTree(request, repo, repo.branch, false);
  if (shallow.truncated) throw new IncompleteTreeError('non-recursive tree truncated');
  let bytes = BigInt(0);
  let fileCount = 0;
  for (const entry of shallow.tree) {
    if (entry == null || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) {
      throw new IncompleteTreeError('malformed tree entry');
    }
    if (entry.type === 'tree') {
      if (typeof entry.sha !== 'string' || !entry.sha) throw new IncompleteTreeError('tree entry missing sha');
      const sub = await measureTreeLogicalBytes(request, repo, entry.sha, treeRoot, entry.path, 1);
      bytes += sub.bytes;
      fileCount += sub.fileCount;
    } else {
      const part = sumRegisteredLogicalBytes([entry], treeRoot, '');
      bytes += part.bytes;
      fileCount += part.fileCount;
    }
  }
  return { bytes, fileCount, missingRoot: fileCount === 0 };
}

/** 台账口径涉及的全部 enabled 仓（仓列表来自 DB，不写死仓名）。 */
export async function listEnabledRepositories(sql) {
  return await sql`
    SELECT id, owner, repo, branch
    FROM storage_repositories
    WHERE enabled
    ORDER BY id ASC`;
}

export async function readRegisteredBytes(sql, repositoryId) {
  const rows = await sql`
    SELECT registered_bytes
    FROM repository_capacity_ledger
    WHERE repository_id = ${repositoryId}`;
  if (!rows.length) return null;
  const raw = rows[0].registered_bytes;
  return typeof raw === 'bigint' ? raw : BigInt(raw);
}

/** 唯一写语句：只碰 registered_bytes 与 updated_at，其余列（state/target/admission）原样保留。 */
export async function updateRegisteredBytes(sql, repositoryId, bytes) {
  const rows = await sql`
    UPDATE repository_capacity_ledger
    SET registered_bytes = ${bytes}::bigint, updated_at = now()
    WHERE repository_id = ${repositoryId}
    RETURNING registered_bytes`;
  return rows;
}

/**
 * 主流程：读仓列表 → 逐仓量字节 → 比对现值 → （apply 且有差异时）UPDATE。
 * request 与 sql 均为注入端口，测试可换合成桩，不触网、不读 .env。
 * @param {{sql: unknown, request: GitHubJsonRequest, mode: 'dry-run'|'apply', treeRoot?: string}} options
 */
export async function runSync(options) {
  const treeRoot = options.treeRoot ?? DEFAULT_TREE_ROOT;
  const repositories = await listEnabledRepositories(options.sql);
  const results = [];
  for (const row of repositories) {
    const id = Number(row.id);
    const repo = { owner: String(row.owner), repo: String(row.repo), branch: String(row.branch) };
    const base = { repositoryId: id, repo: `${repo.owner}/${repo.repo}`, branch: repo.branch };
    let measured;
    try {
      measured = await measureRepositoryLogicalBytes(options.request, repo, treeRoot);
    } catch (error) {
      // 该仓失败关闭：不写库，向上如实报失败（部分和会低估容量，比不写更危险）。
      results.push({ ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const before = await readRegisteredBytes(options.sql, id);
    if (before === null) {
      results.push({ ...base, status: 'no-ledger', fileCount: measured.fileCount,
        note: 'repository_capacity_ledger 无该仓行；本脚本只 UPDATE 不 INSERT（登记请用 register-storage-repository / 初始化对账）' });
      continue;
    }
    if (measured.missingRoot) {
      results.push({ ...base, status: 'no-tree-root', fileCount: 0, previousBytes: before.toString(),
        note: `仓内没有 ${treeRoot}/ 目录；不把缺目录写成 0 容量` });
      continue;
    }
    if (before === measured.bytes) {
      results.push({ ...base, status: 'unchanged', fileCount: measured.fileCount, previousBytes: before.toString(), bytes: measured.bytes.toString() });
      continue;
    }
    if (options.mode === 'dry-run') {
      results.push({ ...base, status: 'dry-run', fileCount: measured.fileCount, previousBytes: before.toString(), bytes: measured.bytes.toString() });
      continue;
    }
    await updateRegisteredBytes(options.sql, id, measured.bytes);
    results.push({ ...base, status: 'applied', fileCount: measured.fileCount, previousBytes: before.toString(), bytes: measured.bytes.toString() });
  }
  const failed = results.filter(r => r.status === 'failed');
  return { mode: options.mode, treeRoot, repositories: results, failedCount: failed.length };
}

/** 认证请求函数：固定 host、固定超时；token 只出现在请求头，不进任何返回值或日志。 */
export function createGitHubTreeRequest(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token) throw new Error('GitHub token 为空');
  return async (relativeRoute) => {
    const res = await fetchImpl(`https://api.github.com${relativeRoute}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zhaoshu-sync-ledger-capacity/1.0',
      },
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, json: () => res.json() };
  };
}

async function main() {
  let config;
  try {
    config = parseSyncArgs(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', phase: 'args', error: safeError(error) }));
    process.exitCode = 2;
    return;
  }
  try {
    const { connectionString, host } = readDatabaseUrl(config.dbEnv);
    const token = process.env[config.ghEnv]?.trim();
    if (!token) throw new Error(`环境变量 ${config.ghEnv} 为空；不会回退到 GITHUB_TOKEN，也不会读取 .env 文件`);
    // 只回显 host 与变量名，不回显连接串/token。
    console.log(JSON.stringify({ phase: 'target', dbEnv: config.dbEnv, host, ghEnv: config.ghEnv, treeRoot: config.treeRoot, mode: config.mode }));
    const report = await runSync({ sql: neon(connectionString), request: createGitHubTreeRequest(token), mode: config.mode, treeRoot: config.treeRoot });
    console.log(JSON.stringify({ phase: 'complete', host, ...report }, null, 2));
    if (report.failedCount > 0) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
