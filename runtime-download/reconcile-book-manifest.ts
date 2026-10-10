// 固定单本清单候选解析：把既有固定 Git 树材料与 schema=2 分卷 canonical 清单的**原始字节**
// 对账为单本候选。纯同步、无 I/O；不实现仓级 inventory、读端完整回退或可信总容量。
//
// 输出仅为**声明级**候选：只证明原始清单字节与所给固定 tree 的指定路径对象绑定、声明结构成立、
// 快照卷引用对象 ID 匹配。不证明卷内容/全书内容 hash、可信总容量、并发屏障或激活。
//
// 边界约定（见 capacity967 合同）：
//   - canonicalPath 必须显式指定且与 tree 路径**逐字**匹配；不 decode/encode/normalize 找替代路径。
//   - 原始字节只复制一次，hash 与解析都在**同一副本**上；绝不重序列化 JSON 后再 hash。
//   - 每卷只按 snapshot_path 找普通 blob 并比较完整声明 SHA；不以 canonical 卷回退救缺失快照。
//   - 未引用 tree 条目只作**未归类**保留，不表示孤儿/免费/可删，也不升级仓级完整性。

import { gitBlobSha } from '../src/lib/artifact-bytes';
import { MAX_MANIFEST_BYTES, parseVolumeManifest } from '../src/lib/volume-manifest';
import type { SnapshotEntry, TreeEntryKind, TreeTarget } from './reconcile-tree-snapshot';

/** Git 对象 ID：40 位小写十六进制。 */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

export interface BookManifestBinding {
  target: TreeTarget;
  commitSha: string;
  treeSha: string;
  /** 必须显式给出并逐字匹配 tree 路径。 */
  canonicalPath: string;
  /** 期望的 canonical 清单**原始字节** git blob sha40。 */
  manifestGitBlobSha: string;
}

/** 既有固定树材料（962 输出子集）。 */
export interface TreeSnapshotMaterial {
  target: TreeTarget;
  commitSha: string;
  treeSha: string;
  entries: readonly SnapshotEntry[];
}

export type BookManifestRejection =
  | 'no_authoritative_source'
  | 'invalid_tree'
  | 'canonical_binding_conflict'
  | 'manifest_size_limit'
  | 'manifest_hash_mismatch'
  | 'manifest_unreadable'
  | 'volume_missing_in_tree';

export interface MatchedVolume {
  /** manifest 声明的 canonical 卷路径（vol-NNN.txt）。 */
  canonicalPath: string;
  /** manifest 声明的快照卷路径（内容寻址）。 */
  snapshotPath: string;
  declaredBlobSha: string;
  declaredBytes: number;
  firstByte: number;
  lastByte: number;
  /** 匹配到的快照 tree 条目。 */
  snapshot: {
    path: string;
    mode: string;
    type: string;
    kind: TreeEntryKind;
    sha: string;
    size?: number;
  };
}

export interface UnclassifiedEntry {
  path: string;
  type: string;
  kind: TreeEntryKind;
  sha: string;
  size?: number;
}

export type FixedBookManifestResult =
  | {
      status: 'fixed_book_manifest_candidate';
      scope: 'single_book';
      binding: BookManifestBinding;
      manifestVersion: string;
      manifestGitBlobSha: string;
      declaredFullTextBlobSha: string;
      declaredLogicalTxtBytes: number;
      volumes: readonly MatchedVolume[];
      referenceMatch: 'fixed_tree_object_ids_only';
      observedUnclassifiedEntries: readonly UnclassifiedEntry[];
      volumeContentVerified: false;
      logicalInventoryVerified: false;
      activationEligible: false;
      repositoryInventoryComplete: false;
    }
  | { status: 'rejected'; reason: BookManifestRejection };

const reject = (reason: BookManifestRejection): FixedBookManifestResult => ({ status: 'rejected', reason });

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
  typeof value === 'string' && value.length > 0 && !value.includes('\0') && !hasUnpairedSurrogate(value);

const isGitObjectId = (value: unknown): value is string =>
  typeof value === 'string' && GIT_OBJECT_ID.test(value);

const isPosInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** 由 mode/type 求分类（与 962 契约一致）；非法组合返回 null。 */
function classifyKind(mode: string, type: string): TreeEntryKind | null {
  if (mode === '100644' || mode === '100755') return type === 'blob' ? 'regular-blob' : null;
  if (mode === '120000') return type === 'blob' ? 'symlink' : null;
  if (mode === '040000') return type === 'tree' ? 'tree' : null;
  if (mode === '160000') return type === 'commit' ? 'gitlink' : null;
  return null;
}

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

/** canonical 清单路径：恰好 `books/<非空单段>/index.json`。 */
function isManifestCanonicalPath(value: unknown): value is string {
  if (!isCanonicalPath(value)) return false;
  const segs = value.split('/');
  return segs.length === 3 && segs[0] === 'books' && segs[2] === 'index.json';
}

function validTarget(t: unknown): t is TreeTarget {
  return isObj(t)
    && isPosInt((t as TreeTarget).repositoryId)
    && isSafeText((t as TreeTarget).owner)
    && isSafeText((t as TreeTarget).repo)
    && isSafeText((t as TreeTarget).branch);
}

function sameTarget(a: TreeTarget, b: TreeTarget): boolean {
  return a.repositoryId === b.repositoryId && a.owner === b.owner && a.repo === b.repo && a.branch === b.branch;
}

function cloneTarget(t: TreeTarget): TreeTarget {
  return { repositoryId: t.repositoryId, owner: t.owner, repo: t.repo, branch: t.branch };
}

/** 运行时形状防御：固定树条目须路径/对象 ID/mode-type-kind 一致；size 如有须非负安全整数。 */
function isTreeEntry(raw: unknown): raw is SnapshotEntry {
  if (!isObj(raw)) return false;
  if (!isCanonicalPath(raw.path) || !isGitObjectId(raw.sha)) return false;
  if (!isStr(raw.mode) || !isStr(raw.type)) return false;
  // mode/type 求出的分类必须与声明 kind 一致；非法组合或矛盾分类在形状阶段拒绝。
  const kind = classifyKind(raw.mode, raw.type);
  if (kind === null || raw.kind !== kind) return false;
  if ('size' in raw && raw.size !== undefined) {
    if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0) return false;
  }
  return true;
}

function cloneEntry(entry: SnapshotEntry): SnapshotEntry {
  const out: SnapshotEntry = {
    path: entry.path, mode: entry.mode, type: entry.type, kind: entry.kind, sha: entry.sha,
  };
  if (entry.size !== undefined) out.size = entry.size;
  return out;
}

/**
 * 解析固定单本 canonical 清单候选。纯同步、无 I/O。
 * 拒绝顺序（967）：缺材料 → 固定树形状/路径冲突 → 身份/路径/对象 ID 冲突 → 字节超界 →
 * 原字节 hash 不等 → 解析失败 → 快照卷缺失。拒绝不返回可用候选。
 */
export function parseFixedBookManifestCandidate(input: {
  binding: BookManifestBinding;
  snapshot: TreeSnapshotMaterial;
  manifestBytes: Uint8Array;
}): FixedBookManifestResult {
  // 1. 缺材料。
  if (!isObj(input)) return reject('no_authoritative_source');
  const binding = (input as { binding?: unknown }).binding;
  const snapshot = (input as { snapshot?: unknown }).snapshot;
  const manifestBytes = (input as { manifestBytes?: unknown }).manifestBytes;
  if (!isObj(binding) || !isObj(snapshot)) return reject('no_authoritative_source');
  if (!(manifestBytes instanceof Uint8Array)) return reject('no_authoritative_source');
  // 提取 target 局部，直接以 validTarget 收窄；同一已收窄局部用于 sameTarget/cloneTarget。
  const bindingTarget = (binding as { target?: unknown }).target;
  const snapshotTarget = (snapshot as { target?: unknown }).target;
  if (!validTarget(bindingTarget) || !validTarget(snapshotTarget)) return reject('no_authoritative_source');
  if (!isStr((binding as { commitSha?: unknown }).commitSha)
    || !isStr((binding as { treeSha?: unknown }).treeSha)
    || !isStr((binding as { canonicalPath?: unknown }).canonicalPath)
    || !isStr((binding as { manifestGitBlobSha?: unknown }).manifestGitBlobSha)) {
    return reject('no_authoritative_source');
  }
  if (!isStr((snapshot as { commitSha?: unknown }).commitSha)
    || !isStr((snapshot as { treeSha?: unknown }).treeSha)) {
    return reject('no_authoritative_source');
  }
  // 零字节 = 缺材料（非空超界才走 size_limit）。
  if (manifestBytes.length === 0) return reject('no_authoritative_source');

  // 2. 固定树必要形状 / 路径冲突。
  const entriesIn = (snapshot as { entries?: unknown }).entries;
  if (!Array.isArray(entriesIn)) return reject('invalid_tree');
  const entries: SnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const raw of entriesIn) {
    if (!isTreeEntry(raw)) return reject('invalid_tree');
    if (seen.has(raw.path)) return reject('invalid_tree'); // 同路径重复 = 路径冲突
    seen.add(raw.path);
    entries.push(cloneEntry(raw));
  }

  // 3. 身份 / canonical 路径 / 期望对象 ID。
  if (!sameTarget(bindingTarget, snapshotTarget)
    || binding.commitSha !== snapshot.commitSha
    || binding.treeSha !== snapshot.treeSha) {
    return reject('canonical_binding_conflict');
  }
  if (!isGitObjectId(binding.commitSha) || !isGitObjectId(binding.treeSha)
    || !isGitObjectId(binding.manifestGitBlobSha)) {
    return reject('canonical_binding_conflict');
  }
  if (!isManifestCanonicalPath(binding.canonicalPath)) return reject('canonical_binding_conflict');
  const canonicalEntry = entries.find((e) => e.path === binding.canonicalPath);
  if (!canonicalEntry
    || canonicalEntry.kind !== 'regular-blob'
    || canonicalEntry.sha !== binding.manifestGitBlobSha) {
    return reject('canonical_binding_conflict');
  }

  // 4. 原始字节超界；副本无条件只取一次（new Uint8Array 复制底层），hash 与解析都在其上。
  const bytes = new Uint8Array(manifestBytes);
  if (bytes.length > MAX_MANIFEST_BYTES) return reject('manifest_size_limit');
  if (gitBlobSha(bytes) !== binding.manifestGitBlobSha) return reject('manifest_hash_mismatch');

  // 5. 解析（复用既有解析器，不另写 schema/偏移）。
  const manifest = parseVolumeManifest(bytes);
  if (!manifest) return reject('manifest_unreadable');

  // 6. 每卷按 snapshot_path 精确找普通 blob 并比较完整声明 SHA（不以 canonical 卷回退）。
  const byPath = new Map<string, SnapshotEntry>();
  for (const e of entries) byPath.set(e.path, e);
  const consumed = new Set<string>([binding.canonicalPath]);
  const volumes: MatchedVolume[] = [];
  for (const volume of manifest.volumes) {
    const snap = byPath.get(volume.snapshot_path);
    if (!snap || snap.kind !== 'regular-blob' || snap.sha !== volume.blob_sha) {
      return reject('volume_missing_in_tree');
    }
    consumed.add(volume.snapshot_path);
    volumes.push({
      canonicalPath: volume.path,
      snapshotPath: volume.snapshot_path,
      declaredBlobSha: volume.blob_sha,
      declaredBytes: volume.bytes,
      firstByte: volume.first_byte,
      lastByte: volume.last_byte,
      snapshot: {
        path: snap.path, mode: snap.mode, type: snap.type, kind: snap.kind, sha: snap.sha,
        ...(snap.size === undefined ? {} : { size: snap.size }),
      },
    });
  }

  // 7. 未归类条目：未被本次 canonical 清单与所需快照引用消费的全部 tree 条目（确定顺序、新副本）。
  const observedUnclassifiedEntries: UnclassifiedEntry[] = entries
    .filter((e) => !consumed.has(e.path))
    .map((e) => ({
      path: e.path, type: e.type, kind: e.kind, sha: e.sha,
      ...(e.size === undefined ? {} : { size: e.size }),
    }));

  return {
    status: 'fixed_book_manifest_candidate',
    scope: 'single_book',
    binding: {
      target: cloneTarget(bindingTarget),
      commitSha: binding.commitSha,
      treeSha: binding.treeSha,
      canonicalPath: binding.canonicalPath,
      manifestGitBlobSha: binding.manifestGitBlobSha,
    },
    manifestVersion: manifest.version,
    manifestGitBlobSha: binding.manifestGitBlobSha,
    declaredFullTextBlobSha: manifest.blob_sha,
    declaredLogicalTxtBytes: manifest.bytes,
    volumes,
    referenceMatch: 'fixed_tree_object_ids_only',
    observedUnclassifiedEntries,
    volumeContentVerified: false,
    logicalInventoryVerified: false,
    activationEligible: false,
    repositoryInventoryComplete: false,
  };
}
