// capacity964/965 GitHub 只读树端口适配（**只写代码，不调用网络**）。
//
// 合同（task-capacity964-original.md + accept965-and-fix-original.md）：
//   - 工厂创建 `GitTreePort`（供 962 `captureTreeSnapshot`），注入**已认证的只读 JSON 请求函数**与**固定目标绑定**。
//     工厂**不接收/不读取** token/env，**不构造认证头**，**不复用未知中转**；**不提供默认 fetch**，不改 entry。
//   - 请求函数合同：入参**仅**为相对官方 GitHub REST 路由（`/repos/...`）；可信生产装配**尚未交**。
//     生产注入**须**固定 `api.github.com` 且**拒绝重定向外送认证**；本片**不**声称已证明调用者认证安全。
//   - 适配器仅生成两个 GET：/repos/{owner}/{repo}/commits/{branch}（branch **整体**编码）→ 读响应 `sha` 及
//     `commit.tree.sha`；/repos/{owner}/{repo}/git/trees/{treeSha}?recursive=1 → 读 `{sha,truncated,tree}` 供既有算法。
//   - owner/repo **各编码为单路径段**（拒绝空/斜杠/NUL/孤立代理项/点段），branch **整体**编码（**允许**内部斜杠），
//     均不允许调用者传绝对 URL / 替换 host；treeSha 严格 40 小写 hex；recursive 必须 true。
//   - 固定目标与每次调用 target 的 repositoryId/owner/repo/branch **逐原语相等**，错绑在请求前拒绝；
//     **不**把本地 repositoryId 当 GitHub 远端 ID（仅用于绑定比较，不进路由）。
//   - getCommit/getTree 各**只发一次**请求；无重试/分页/contents 回退；不在适配器额外解析 branch。
//   - 响应信封：status 须**有限整数**且 100..599；非法值固定 MALFORMED（**不进** HTTP 错误字段）；合法非 2xx
//     仅携合法状态、**不读**响应正文；2xx 调用 `json()` 前核其为函数，缺失/非函数固定 MALFORMED。
//   - 畸形响应缺 `sha`/`commit.tree.sha` **不生成可用快照**（本地固定码 Error）；错误**不输出**响应原文/URL/header；
//     request/json 自身抛错**原引用透传**（不 catch、不记录日志）。
//   - `truncated` **保留真实值**，缺字段**不补 false**；树条目保留 mode/type/sha/path/size 语义，**不过滤**链接/gitlink/目录，
//     **不用空数组掩盖非法**。条目语义验证由既有算法完成，适配器**不把畸形响应修成合法**。
//
// 静态草稿：未 import 执行、未测试、未连网络；真实采集与生产装配未交。

import type { CommitResolution, GitTreePort, RawTreeEntry, TreeListing, TreeTarget } from './reconcile-tree-snapshot';

/** Git SHA-1 对象 ID：40 位小写十六进制（与 962 契约一致）。 */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/** 适配器本地固定错误码；**不**夹带响应原文/URL/header。 */
export type GitHubTreeErrorCode =
  | 'GITHUB_TREE_INVALID_TARGET'   // 工厂目标/编码非法（含点段、孤立代理项）
  | 'GITHUB_TREE_INVALID_REQUEST'  // treeSha/recursive 等请求参数非法
  | 'GITHUB_TREE_TARGET_MISMATCH'  // 调用 target 与固定绑定不符（请求前拒绝）
  | 'GITHUB_TREE_HTTP'             // 合法非 2xx（仅状态码，不含响应体）
  | 'GITHUB_TREE_MALFORMED';       // 响应信封/必需形状非法，不补数据

export class GitHubTreeError extends Error {
  readonly code: GitHubTreeErrorCode;
  readonly status?: number;
  constructor(code: GitHubTreeErrorCode, status?: number) {
    super(status === undefined ? code : `${code}_${status}`);
    this.name = 'GitHubTreeError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** 注入的已认证只读 JSON 请求函数：入参为**相对 REST 路由**，返回最小响应信封形状。 */
export interface GitHubJsonResponse {
  status: number;
  json(): Promise<unknown>;
}
export type GitHubJsonRequest = (relativeRoute: string) => Promise<GitHubJsonResponse>;

/**
 * 工厂参数：`request` 已由调用方完成认证（固定 host、拒跨 host 重定向）；`target` 为**固定绑定**。
 * 本片**不**校验/提供认证实现——生产装配仍未交。
 */
export interface GitHubTreePortOptions {
  request: GitHubJsonRequest;
  target: TreeTarget;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object';

/** 返回孤立 UTF-16 代理项（UTF-8 编码会同码折叠，见 capacity959 F1）；不改写输入文本。 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (n < 0xdc00 || n > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * 目标文本基础合法性：非空、无 NUL、无孤立代理项。非法**在编码前**抛固定 `INVALID_TARGET`
 * （**不**依赖 `encodeURIComponent` 抛出的本地 `URIError`）——不改写 Unicode 文本。
 */
function assertRouteText(value: string): void {
  if (value.length === 0 || value.includes('\0') || hasUnpairedSurrogate(value)) {
    throw new GitHubTreeError('GITHUB_TREE_INVALID_TARGET');
  }
}

/** owner/repo **单路径段**：拒绝原始斜杠与点段（**不**用百分号转义掩盖点段），再做一次编码。 */
function encodePathSegment(value: string): string {
  assertRouteText(value);
  if (value.includes('/')) throw new GitHubTreeError('GITHUB_TREE_INVALID_TARGET'); // 含斜杠 → 会产生额外路径段
  if (value === '.' || value === '..') throw new GitHubTreeError('GITHUB_TREE_INVALID_TARGET'); // 点段会折叠层级
  return encodeURIComponent(value);
}

/**
 * branch **整体**编码为单个 ref 参数：内部斜杠 → `%2F`（**不分段、不改绑定**，一次 `encodeURIComponent`）。
 * 整个 branch 恰为 `.`/`..` 则请求前拒绝（末端点段会折叠）。
 */
function encodeBranch(value: string): string {
  assertRouteText(value);
  if (value === '.' || value === '..') throw new GitHubTreeError('GITHUB_TREE_INVALID_TARGET');
  return encodeURIComponent(value);
}

/** 防御：我们自建的路由必须是相对的（绝不含 scheme 或 protocol-relative 命首）。 */
function assertRelativeRoute(route: string): string {
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('://')) {
    throw new GitHubTreeError('GITHUB_TREE_INVALID_REQUEST');
  }
  return route;
}

/**
 * 创建 GitHub 只读树端口适配。工厂保存**私有目标原语**（不与外部共享可变对象）。
 * 生产注入须自行保证 host 固定与重定向安全；本片不声称已证明。
 */
export function createGitHubTreePort(options: GitHubTreePortOptions): GitTreePort {
  if (!isObj(options) || typeof options.request !== 'function' || !isObj(options.target)) {
    throw new GitHubTreeError('GITHUB_TREE_INVALID_TARGET');
  }
  const request = options.request;
  // 私有目标原语副本（只取原语，不持有外部可变对象）。
  const fixed: TreeTarget = {
    repositoryId: options.target.repositoryId,
    owner: options.target.owner,
    repo: options.target.repo,
    branch: options.target.branch,
  };
  if (!Number.isSafeInteger(fixed.repositoryId) || fixed.repositoryId <= 0
    || !isStr(fixed.owner) || !isStr(fixed.repo) || !isStr(fixed.branch)) {
    throw new GitHubTreeError('GITHUB_TREE_INVALID_TARGET');
  }
  const ownerSeg = encodePathSegment(fixed.owner);   // 单段：拒斜杠/点段/孤立代理项
  const repoSeg = encodePathSegment(fixed.repo);
  const branchSeg = encodeBranch(fixed.branch);      // 整体编码：允内部斜杠
  const prefix = `/repos/${ownerSeg}/${repoSeg}`;

  // 每次调用 target 必须与固定绑定逐原语相等（错绑在请求前拒绝）。
  function assertBound(target: TreeTarget): void {
    if (!isObj(target)
      || target.repositoryId !== fixed.repositoryId
      || target.owner !== fixed.owner
      || target.repo !== fixed.repo
      || target.branch !== fixed.branch) {
      throw new GitHubTreeError('GITHUB_TREE_TARGET_MISMATCH');
    }
  }

  async function getJson(route: string): Promise<unknown> {
    const res = await request(assertRelativeRoute(route)); // request 抛错原引用透传
    if (!isObj(res)) throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
    // 信封 status：须有限整数且在合法 HTTP 范围 100..599；非法值固定 MALFORMED（**不进** HTTP 字段）。
    const status = (res as { status?: unknown }).status;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
    }
    // 合法非 2xx：仅携合法状态码，**不读**响应正文。
    if (status < 200 || status >= 300) throw new GitHubTreeError('GITHUB_TREE_HTTP', status);
    // 2xx：调用 json 前先核其为函数（缺失/非函数固定 MALFORMED，不产生本地 TypeError）。
    const json = (res as { json?: unknown }).json;
    if (typeof json !== 'function') throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
    return (res as GitHubJsonResponse).json(); // json() 自身抛错仍原引用透传
  }

  return {
    async getCommit(target: TreeTarget): Promise<CommitResolution> {
      assertBound(target);
      const body = await getJson(`${prefix}/commits/${branchSeg}`);
      // 真实 REST：顶层 `sha` 为 commit；`commit.tree.sha` 为树。缺任一形状 → 不生成可用快照。
      const sha = isObj(body) ? body.sha : undefined;
      const tree = isObj(body) && isObj(body.commit) ? (body.commit as Record<string, unknown>).tree : undefined;
      const treeSha = isObj(tree) ? tree.sha : undefined;
      if (!isStr(sha) || !isStr(treeSha)) throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
      return { commitSha: sha, treeSha };
    },

    async getTree(target: TreeTarget, treeSha: string, opts: { recursive: true }): Promise<TreeListing> {
      assertBound(target);
      if (!isStr(treeSha) || !GIT_OBJECT_ID.test(treeSha) || !isObj(opts) || opts.recursive !== true) {
        throw new GitHubTreeError('GITHUB_TREE_INVALID_REQUEST');
      }
      const body = await getJson(`${prefix}/git/trees/${treeSha}?recursive=1`);
      if (!isObj(body)) throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
      const sha = body.sha;
      const tree = body.tree;
      if (!isStr(sha)) throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
      if (!Array.isArray(tree)) throw new GitHubTreeError('GITHUB_TREE_MALFORMED'); // 不用空数组掩盖非法
      // 逐条保留 mode/type/sha/path/size 语义（不过滤链接/gitlink/目录，不修形状）。
      const entries: RawTreeEntry[] = tree.map((raw) => {
        if (!isObj(raw) || !isStr(raw.path) || !isStr(raw.mode) || !isStr(raw.type) || !isStr(raw.sha)) {
          throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
        }
        const out: RawTreeEntry = { path: raw.path, mode: raw.mode, type: raw.type, sha: raw.sha };
        if ('size' in raw && raw.size !== undefined) {
          if (typeof raw.size !== 'number') throw new GitHubTreeError('GITHUB_TREE_MALFORMED');
          out.size = raw.size;
        }
        return out;
      });
      // truncated 保留真实值：true→true、false→false；缺省**不补 false**（传非 boolean，由算法按 !==false 失败关闭）。
      const truncated = body.truncated;
      return { sha, truncated: truncated as boolean, tree: entries };
    },
  };
}
