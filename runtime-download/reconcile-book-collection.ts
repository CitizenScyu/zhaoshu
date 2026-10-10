// capacity974 固定材料单本采集组合（静态实施草稿，**只写不跑**）。
//
// 合同（capacity973-report.md 22–75 行 / task-capacity974-original.md）：
//   - 唯一组合接口 collectFixedBookManifestCandidate(input:{target,canonicalPath},
//     ports:{tree:GitTreePort,blob:GitHubManifestBlobReader})。组合**只编排**真实 962/970/967
//     三模块：真实 captureTreeSnapshot 固定一次 branch/tree、真实 GitHubManifestBlobReader 按固定 SHA
//     读一次清单 blob、真实 parseFixedBookManifestCandidate 再次核字节 hash 与结构；不复制树/base64/
//     清单解析算法，不注入替代 parser。
//   - 12 步固定顺序：await 前核输入并取私有原语 → 核端口方法 → 固定方法引用/receiver 的转发器采集一次树
//     → 核树结果外形/目标 → 复制为本次独占 snapshot → 私有 entries 内逐字定位 canonical 普通 blob →
//     构造本次独占 binding → 按固定 SHA 读一次 blob → 核 blob 外形/绑定 → 私有复制字节（≤4MiB）→ 调
//     真实 parser 恰一次 → 无后续 await。
//   - 拒绝统一外形 {status:'rejected',domain,reason}，domain ∈ tree/manifest/composition；只带域与固定
//     reason，不附原对象/路径/地址/异常 Message。端口主动抛出/拒绝**不**进结果联合：一律原引用向上抛出，
//     无 catch 包装、无重试（含真实 B 的 GITHUB_BLOB_* 错误）。
//   - 成功原样交付 P 的单本声明候选（scope/完整 binding/三类 SHA/声明字节/卷/未归类条目/四 false）。
//
// 静态草稿：未 import 执行、未测试、未连真实来源。真实 GitHub 装配仍未交；不接生产入口。

import { MAX_MANIFEST_BYTES } from '../src/lib/volume-manifest';
import {
  captureTreeSnapshot,
  type GitTreePort,
  type SnapshotEntry,
  type TreeSnapshotRejection,
  type TreeTarget,
} from './reconcile-tree-snapshot';
import {
  parseFixedBookManifestCandidate,
  type BookManifestBinding,
  type BookManifestRejection,
  type FixedBookManifestResult,
  type TreeSnapshotMaterial,
} from './reconcile-book-manifest';
import type { GitHubManifestBlobReader } from './reconcile-manifest-blob-github';

/** Git 对象 ID：40 位小写十六进制（与 962/967/970 契约一致）。 */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/** 组合层本地固定拒绝码；**不**附原始对象、路径、地址或异常 Message。 */
export type CompositionRejection =
  | 'invalid_input'
  | 'missing_port'
  | 'tree_result_invalid'
  | 'tree_target_mismatch'
  | 'canonical_binding_conflict'
  | 'blob_result_invalid'
  | 'blob_binding_conflict';

/** 三域统一拒绝外形（domain 区分既有同名 reason）。 */
export type CollectedBookManifestRejection =
  | { status: 'rejected'; domain: 'tree'; reason: TreeSnapshotRejection }
  | { status: 'rejected'; domain: 'manifest'; reason: BookManifestRejection }
  | { status: 'rejected'; domain: 'composition'; reason: CompositionRejection };

/** 成功分支直接沿 P 的 fixed_book_manifest_candidate（scope/完整 binding/三类 SHA/声明字节/卷/四 false）。 */
export type CollectedBookManifestSuccess = Extract<
  FixedBookManifestResult,
  { status: 'fixed_book_manifest_candidate' }
>;

export type CollectedBookManifestResult =
  | CollectedBookManifestSuccess
  | CollectedBookManifestRejection;

const composition = (reason: CompositionRejection): CollectedBookManifestRejection =>
  ({ status: 'rejected', domain: 'composition', reason });

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object';

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
  isStr(value) && value.length > 0 && !value.includes('\0') && !hasUnpairedSurrogate(value);

const isPosInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isGitObjectId = (value: unknown): value is string =>
  isStr(value) && GIT_OBJECT_ID.test(value);

/** 目标形状：正安全整数 ID 及非空合法文本（与 962 目标入口一致）。 */
function validTarget(t: unknown): t is TreeTarget {
  return isObj(t)
    && isPosInt((t as TreeTarget).repositoryId)
    && isSafeText((t as TreeTarget).owner)
    && isSafeText((t as TreeTarget).repo)
    && isSafeText((t as TreeTarget).branch);
}

function cloneTarget(t: TreeTarget): TreeTarget {
  return { repositoryId: t.repositoryId, owner: t.owner, repo: t.repo, branch: t.branch };
}

function sameTarget(a: TreeTarget, b: TreeTarget): boolean {
  return a.repositoryId === b.repositoryId && a.owner === b.owner && a.repo === b.repo && a.branch === b.branch;
}

/** 精确相对 POSIX 路径（不修剪/不 resolve/不折叠段/不改大小写；保留合法 Unicode）。 */
function isExactRelativePath(value: unknown): value is string {
  if (!isStr(value) || value.length === 0) return false;
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

/**
 * 步骤 1 本地路径门：canonicalPath 须是 `books/<非空单段>/index.json`。
 * 这是组合层**输入形状**门（P 的同一谓词未导出）；P 在步骤 11 会再次校验，非替代其算法。
 */
function isManifestCanonicalPath(value: unknown): value is string {
  if (!isExactRelativePath(value)) return false;
  const segs = value.split('/');
  return segs.length === 3 && segs[0] === 'books' && segs[2] === 'index.json';
}

/** 私有复制快照条目：逐原语取新对象，size 缺省仍缺省。 */
function cloneSnapshotEntry(entry: SnapshotEntry): SnapshotEntry {
  const out: SnapshotEntry = {
    path: entry.path, mode: entry.mode, type: entry.type, kind: entry.kind, sha: entry.sha,
  };
  if (entry.size !== undefined) out.size = entry.size;
  return out;
}

/**
 * 组合固定材料单本采集。只编排真实 962/970/967；成功交付单本声明候选，失败按三域统一拒绝。
 * 端口主动抛出/拒绝**原引用**向上抛出（不 catch、不重试）。
 */
export async function collectFixedBookManifestCandidate(
  input: { target: TreeTarget; canonicalPath: string },
  ports: { tree: GitTreePort; blob: GitHubManifestBlobReader },
): Promise<CollectedBookManifestResult> {
  // 步骤 1：第一个 await 前核输入普通形状并取私有原语 target / canonicalPath（零端口调用）。
  if (!isObj(input)) return composition('invalid_input');
  const rawTarget = (input as { target?: unknown }).target;
  const rawPath = (input as { canonicalPath?: unknown }).canonicalPath;
  if (!validTarget(rawTarget) || !isManifestCanonicalPath(rawPath)) {
    return composition('invalid_input');
  }
  const target = cloneTarget(rawTarget); // 私有期望原语，不与端口/输入共享对象
  const canonicalPath = rawPath;         // 已收窄为原语字符串；不 trim/decode/normalize

  // 步骤 2：前置核 tree 两方法及 blob.readManifestBlob 为函数，缺任一 → missing_port（零端口调用）。
  if (!isObj(ports)) return composition('missing_port');
  const treePort = (ports as { tree?: unknown }).tree;
  const blobPort = (ports as { blob?: unknown }).blob;
  if (!isObj(treePort) || !isObj(blobPort)) return composition('missing_port');
  const tree = treePort as GitTreePort;
  const blob = blobPort as GitHubManifestBlobReader;
  // 固定原函数引用及其 receiver：后续外部替换 ports 字段/方法不影响本次执行目标。
  const getCommitFn = tree.getCommit;
  const getTreeFn = tree.getTree;
  const readBlobFn = blob.readManifestBlob;
  if (typeof getCommitFn !== 'function' || typeof getTreeFn !== 'function'
    || typeof readBlobFn !== 'function') {
    return composition('missing_port');
  }

  // 步骤 3：转发器固定原函数/receiver，并为端口制作独立 target 副本（getTree 另给独立 {recursive:true}）。
  const forwarder: GitTreePort = {
    getCommit: (t: TreeTarget) => getCommitFn.call(tree, cloneTarget(t)),
    getTree: (t: TreeTarget, treeSha: string, _options: { recursive: true }) =>
      getTreeFn.call(tree, cloneTarget(t), treeSha, { recursive: true }),
  };

  // 用真实 captureTreeSnapshot 调用一次，传入与内部期望分离的 target 副本。
  const treeResult = await captureTreeSnapshot({ target: cloneTarget(target) }, forwarder);

  // 步骤 4：S 拒绝 → 立即以 domain=tree 保留原 reason（零 blob）。
  if (treeResult.status === 'rejected') {
    return { status: 'rejected', domain: 'tree', reason: treeResult.reason };
  }
  // S 成功：同步核外形（意外形状 → tree_result_invalid）与目标（不等 → tree_target_mismatch）。
  if (!validTarget(treeResult.target) || !isGitObjectId(treeResult.commitSha)
    || !isGitObjectId(treeResult.treeSha) || !Array.isArray(treeResult.entries)) {
    return composition('tree_result_invalid');
  }
  if (!sameTarget(treeResult.target, target)) {
    return composition('tree_target_mismatch');
  }

  // 步骤 5：把树结果复制为本次独占 snapshot（新 target、新 entries 数组、每条新对象；保持 S 规范顺序）。
  const snapshot: TreeSnapshotMaterial = {
    target: cloneTarget(treeResult.target),
    commitSha: treeResult.commitSha,
    treeSha: treeResult.treeSha,
    entries: treeResult.entries.map((e) => cloneSnapshotEntry(e)),
  };

  // 步骤 6：仅在私有 entries 中逐字定位 canonicalPath，须恰一条且为普通 blob（否则 canonical_binding_conflict，停于 blob 前）。
  const matched = snapshot.entries.filter((e) => e.path === canonicalPath);
  if (matched.length !== 1) return composition('canonical_binding_conflict');
  const canonicalEntry = matched[0];
  if (canonicalEntry.kind !== 'regular-blob' || canonicalEntry.type !== 'blob'
    || (canonicalEntry.mode !== '100644' && canonicalEntry.mode !== '100755')
    || !isGitObjectId(canonicalEntry.sha)) {
    return composition('canonical_binding_conflict');
  }
  const expectedManifestSha = canonicalEntry.sha;

  // 步骤 7：从私有条目固定 expectedManifestSha，构造本次独占 binding（binding 与 snapshot 的 target 各为新对象）。
  const binding: BookManifestBinding = {
    target: cloneTarget(snapshot.target),
    commitSha: snapshot.commitSha,
    treeSha: snapshot.treeSha,
    canonicalPath,
    manifestGitBlobSha: expectedManifestSha,
  };

  // 步骤 8：调用已固定的 blob.readManifestBlob 一次，仅传独立 target 副本及 expectedManifestSha 原语。
  const blobRaw: unknown = await readBlobFn.call(blob, cloneTarget(binding.target), expectedManifestSha);

  // 步骤 9：核 blob 外形（不符 → blob_result_invalid）；再核绑定（不等 → blob_binding_conflict）。
  if (!isObj(blobRaw) || blobRaw.status !== 'fixed_manifest_blob_bytes'
    || !validTarget(blobRaw.target)
    || !isGitObjectId(blobRaw.manifestGitBlobSha)
    || !(blobRaw.bytes instanceof Uint8Array)) {
    return composition('blob_result_invalid');
  }
  if (!sameTarget(blobRaw.target, target) || blobRaw.manifestGitBlobSha !== expectedManifestSha) {
    return composition('blob_binding_conflict');
  }

  // 步骤 10：复制前核 byteLength ≤ 4MiB（越界 → blob_result_invalid，表示端口违反材料合同）；再取私有字节副本。
  const returnedBytes = blobRaw.bytes;
  if (returnedBytes.byteLength > MAX_MANIFEST_BYTES) return composition('blob_result_invalid');
  const manifestBytes = new Uint8Array(returnedBytes); // 私有副本；不用 Buffer.slice 共享底层

  // 步骤 11：同步调用真实 parseFixedBookManifestCandidate 恰一次；拒绝映射 domain=manifest，成功原样交付。
  const parsed = parseFixedBookManifestCandidate({ binding, snapshot, manifestBytes });
  if (parsed.status === 'rejected') {
    return { status: 'rejected', domain: 'manifest', reason: parsed.reason };
  }
  return parsed;

  // 步骤 12：无后续 await/重试/补查/升级；端口与模块异常均原引用向上抛出（本函数无 catch）。
}
