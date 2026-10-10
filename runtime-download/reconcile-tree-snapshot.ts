// capacity962 固定 Git 树快照采集器（静态实施草稿）。
//
// 合同（task-capacity962-original.md）：
//   - 以**注入只读端口**获取固定 Git 树：getCommit(target)→{commitSha,treeSha}；
//     getTree(target, treeSha, {recursive:true})→{sha,truncated,tree:[{path,mode,type,sha,size?}]}。
//     可 Promise 异步；**不提供**真实 HTTP/token/env 适配、不执行请求、不接 entry；端口无默认实现，
//     缺失即 no_authoritative_source。
//   - 只读算法：先解析 branch **一次**到 commit/tree，之后**只**按固定 treeSha 取递归树，不再按可变 branch 读内容。
//   - Git 对象 ID 采用**明确 40 位小写十六进制**契约（本模块是 Git SHA-1 API 材料，**不同于**959 不透明
//     内容标识）；其它格式失败关闭，不推断算法迁移。
//   - 正面完整性：truncated 必须**显式 false** 且 tree 为数组；缺字段/true/未知/畸形/目标或树错绑定均拒绝；
//     本次不做分页/截断回退，**截断直接** incomplete_tree，不当空树。
//   - 条目路径按精确相对 POSIX、合法 Unicode 标量串校验，不隐式修剪/归一化；非法或重复**冲突**路径拒绝；
//     一致重复允许确定去重，按路径排序。mode/type 配对：普通 blob(100644/100755)、符号链接 blob(120000)、
//     tree(040000)、gitlink commit(160000) **分别保留分类**，不把链接/gitlink 当普通 TXT。blob size 如有须
//     非负安全整数；缺 size 保留**未知**，不造 0，不用该大小宣称 TXT 逻辑总量。对子模块/链接不递归跨仓或跟随。
//   - 输出仅 tree_snapshot 候选：冻结 target、commitSha、treeSha、规范条目、activationEligible:false、
//     logicalInventoryVerified:false。**不**产出 coverageVerifier verified / CurrentActivation granted / ready。
//     本快照是**固定 Git 树枚举材料**，非当前规范 TXT 逻辑书清单，不证明 blob 内容/manifest 完整性/无在途写。
//   - 对外错误固定四类 no_authoritative_source/incomplete_tree/binding_conflict/invalid_tree；端口异常**原样抛出**，
//     不自动重试，不夹带真实地址或响应原文。
//
// 静态草稿：未 import 执行、未测试、未连真实来源。真实 GitHub 适配仍未交，**不**能称已完成生产采集。

/** Git SHA-1 对象 ID 契约：40 位小写十六进制。 */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/** 目标：仓 + 分支（owner/repo/branch 为绑定文本）。 */
export interface TreeTarget {
  repositoryId: number;
  owner: string;
  repo: string;
  branch: string;
}

/** 端口 getCommit 结果。 */
export interface CommitResolution {
  commitSha: string;
  treeSha: string;
}

/** 端口 getTree 的原始条目（递归）。 */
export interface RawTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

/** 端口 getTree 结果。 */
export interface TreeListing {
  sha: string;
  truncated: boolean;
  tree: RawTreeEntry[];
}

/**
 * 注入只读端口：**无默认实现**；缺端口失败关闭。
 * getTree 固定以 `{recursive:true}` 取整棵树；实现方仍未交真实适配。
 */
export interface GitTreePort {
  getCommit(target: TreeTarget): Promise<CommitResolution>;
  getTree(target: TreeTarget, treeSha: string, options: { recursive: true }): Promise<TreeListing>;
}

/** 条目分类（由 mode/type 确定；链接/gitlink 与普通 TXT blob 分开）。 */
export type TreeEntryKind = 'regular-blob' | 'symlink' | 'tree' | 'gitlink';

/** 规范快照条目（已排序、已去重）。 */
export interface SnapshotEntry {
  path: string;
  mode: string;
  type: string;
  kind: TreeEntryKind;
  sha: string;
  /** blob 大小；缺省保持 `undefined`（未知），**不**造 0。 */
  size?: number;
}

export type TreeSnapshotRejection =
  | 'no_authoritative_source'
  | 'incomplete_tree'
  | 'binding_conflict'
  | 'invalid_tree';

export type TreeSnapshotResult =
  | {
      status: 'tree_snapshot';
      target: TreeTarget;
      commitSha: string;
      treeSha: string;
      entries: readonly SnapshotEntry[];
      activationEligible: false;
      logicalInventoryVerified: false;
    }
  | { status: 'rejected'; reason: TreeSnapshotRejection };

const reject = (reason: TreeSnapshotRejection): TreeSnapshotResult => ({ status: 'rejected', reason });

const isPosInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** 拒绝孤立 UTF-16 代理项（UTF-8 编码会同码折叠，见 capacity959 F1）。 */
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

const isSafeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0') && !hasUnpairedSurrogate(value);

const isGitObjectId = (value: unknown): value is string =>
  typeof value === 'string' && GIT_OBJECT_ID.test(value);

/** 精确相对 POSIX 路径（不修剪/不 resolve/不折叠段/不改大小写；保留合法 Unicode）。 */
function isCanonicalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\0') || hasUnpairedSurrogate(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  if (value.includes('\\')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (/^\s/.test(value) || /\s$/.test(value)) return false;
  for (const seg of value.split('/')) {
    if (seg.length === 0 || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** mode/type 配对 → 分类；不合法返回 null。 */
function classify(mode: string, type: string): TreeEntryKind | null {
  if (mode === '100644' || mode === '100755') return type === 'blob' ? 'regular-blob' : null;
  if (mode === '120000') return type === 'blob' ? 'symlink' : null;
  if (mode === '040000') return type === 'tree' ? 'tree' : null;
  if (mode === '160000') return type === 'commit' ? 'gitlink' : null;
  return null;
}

function cloneTarget(t: TreeTarget): TreeTarget {
  return { repositoryId: t.repositoryId, owner: t.owner, repo: t.repo, branch: t.branch };
}

const validTarget = (t: unknown): t is TreeTarget =>
  t != null && typeof t === 'object'
  && isPosInt((t as TreeTarget).repositoryId)
  && isSafeText((t as TreeTarget).owner)
  && isSafeText((t as TreeTarget).repo)
  && isSafeText((t as TreeTarget).branch);

/** 校验并规范化端口条目；形状/分类/size 非法 → null。 */
function normalizeEntry(raw: unknown): SnapshotEntry | null {
  if (raw == null || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!isCanonicalPath(e.path) || !isGitObjectId(e.sha)) return null;
  if (typeof e.mode !== 'string' || typeof e.type !== 'string') return null;
  const kind = classify(e.mode, e.type);
  if (kind === null) return null;
  const out: SnapshotEntry = { path: e.path, mode: e.mode, type: e.type, kind, sha: e.sha };
  if ('size' in e && e.size !== undefined) {
    if (typeof e.size !== 'number' || !Number.isSafeInteger(e.size) || e.size < 0) return null;
    out.size = e.size; // 有则保留；缺则保持 undefined（未知），不造 0
  }
  return out;
}

/**
 * 采集固定 Git 树快照。只读、无 I/O；缺端口 → no_authoritative_source；
 * 端口异常**原样抛出**、不重试。`activationEligible`/`logicalInventoryVerified` 恒为 `false`。
 */
export async function captureTreeSnapshot(
  input: { target: TreeTarget },
  port: GitTreePort | null | undefined,
): Promise<TreeSnapshotResult> {
  // 1. 缺端口/适配失败关闭。
  if (port == null || typeof (port as { getCommit?: unknown }).getCommit !== 'function'
    || typeof (port as { getTree?: unknown }).getTree !== 'function') {
    return reject('no_authoritative_source');
  }
  // 2. 目标形状（非法 → binding_conflict）。
  if (input == null || typeof input !== 'object' || !validTarget(input.target)) {
    return reject('binding_conflict');
  }
  // 私有期望快照（不和端口共享对象）；另给端口独立冻结副本。
  const target = Object.freeze(cloneTarget(input.target));
  const portTarget = Object.freeze(cloneTarget(target));

  // 3. branch **只解析一次**。端口异常原样抛出（不 try/catch、不重试）。
  const commit = await port.getCommit(portTarget);
  if (commit == null || typeof commit !== 'object'
    || !isGitObjectId(commit.commitSha) || !isGitObjectId(commit.treeSha)) {
    return reject('invalid_tree');
  }
  const { commitSha, treeSha } = commit;

  // 4. 只按固定 treeSha 取递归树（不按可变 branch）。响应 sha 必须等于期望 treeSha。
  const listing = await port.getTree(portTarget, treeSha, { recursive: true });
  if (listing == null || typeof listing !== 'object') return reject('invalid_tree');
  // truncated 必须**显式 false**；缺字段/true/未知 → 截断（不完整），不当空树。
  if (listing.truncated !== false) return reject('incomplete_tree');
  if (listing.sha !== treeSha) return reject('binding_conflict'); // 树错绑定
  if (!Array.isArray(listing.tree)) return reject('invalid_tree');

  // 5. 规范化 + 一致去重 + 冲突拒绝。
  const byPath = new Map<string, SnapshotEntry>();
  for (const raw of listing.tree) {
    const entry = normalizeEntry(raw);
    if (entry === null) return reject('invalid_tree');
    const prev = byPath.get(entry.path);
    if (prev === undefined) { byPath.set(entry.path, entry); continue; }
    const same = prev.mode === entry.mode && prev.type === entry.type && prev.sha === entry.sha && prev.size === entry.size;
    if (!same) return reject('invalid_tree'); // 同路径冲突
  }
  const entries = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return {
    status: 'tree_snapshot',
    target,
    commitSha,
    treeSha,
    entries,
    activationEligible: false,
    logicalInventoryVerified: false,
  };
}
