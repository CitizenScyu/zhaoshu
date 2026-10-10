// capacity958 无 I/O 清单差额预检器（静态实施草稿）。
//
// 合同（task-capacity958-original.md；957 结论）：
//   - 纯函数、无 I/O：不接数据库、不接真实 GitHub、不实现 ReconciliationSource、不产出激活许可；
//   - 只对**受控核验边界**（coverageVerifier）给出的固定材料做确定性集合/差额预检；
//   - 缺核验器/来源 ⇒ no_authoritative_source；有材料但未获**正面完整**证明 ⇒ incomplete_occupancy；
//     核验结果错绑定目标/快照/规范化清单摘要/logical TXT 口径 ⇒ binding_conflict；
//     形状非法、同路径内容冲突、登记悬空或内容不符 ⇒ inventory_conflict；
//   - 调用者自填 complete 不算证明（本模块无此字段，只认核验端口的 verified）；
//   - DB 登记**不得**冒充全量远端清单：登记行必须在核验过的远端全量中可解释，否则拒绝；
//   - 交给核验端口的是**独立只读副本**（与私有期望快照分离），端口改它不能漂移计算材料；
//   - 输出恒为 inventory_preview（`activationEligible:false`）或 rejected 四态之一；不返回
//     initialized/ready/verified/granted。
//
// capacity959 两项输入域定点修复：
//   F1 拒绝参与摘要文本中的**孤立 UTF-16 高/低代理项**——Node 按 UTF-8 编码会把孤立代理项替换为
//      U+FFFD（EF BF BD），使不同孤立代理项与字面替换字符**编码同码**、摘要碰撞；合法配对（补充平面）
//      保持原文，不做 Unicode 隐式归一化。目标/快照/引用非法 ⇒ binding_conflict；条目非法 ⇒ inventory_conflict。
//   F2 分别定义规范路径与内容标识格式：路径＝精确相对 POSIX 文件键（拒绝对/反斜杠/空段/./..段/尾斜杠/
//      控制符/边缘空白，不修剪、不 resolve、不折叠段、不改大小写）；内容标识＝本片**不透明** ASCII token
//      （字母数字及 . _ : -，至少含一个字母或数字）。此门**只**验证表示，不声明 Git 哈希算法/长度或远端存在性。
//
// 静态草稿：未 import 执行、未测试、未连真实来源。摘要为**静态契约**，非运行证据。

import { createHash } from 'node:crypto';

/** 模块内部固定的 logical TXT 口径标识；核验结果必须绑定**同一**口径。 */
export const LOGICAL_TXT_SCOPE = 'zhaoshu.txt.current.logical.v1';

/** 预检目标（仓 + 分支）。 */
export interface InventoryTarget {
  repositoryId: number;
  branch: string;
}

/** 当前**逻辑书**条目；`canonicalPath` 为精确规范键，`logicalTxtBytes` 为当前逻辑 TXT 字节。 */
export interface InventoryBookEntry {
  canonicalPath: string;
  blobSha: string;
  logicalTxtBytes: bigint;
}

export interface ReconciliationInventoryInput {
  target: InventoryTarget;
  snapshotId: string;
  coverageRef: string;
  remoteBooks: readonly InventoryBookEntry[];
  registeredBooks: readonly InventoryBookEntry[];
}

/** 交给核验端口的**独立只读副本**（与私有期望快照分离；端口改它不影响计算材料）。 */
export interface CoverageMaterial {
  readonly target: InventoryTarget;
  readonly snapshotId: string;
  readonly coverageRef: string;
  /** 规范化（一致重复去重 + 排序）后的远端清单副本。 */
  readonly remoteBooks: readonly InventoryBookEntry[];
  /** 规范化（一致重复去重 + 排序）后的登记清单副本。 */
  readonly registeredBooks: readonly InventoryBookEntry[];
  /** 私有期望快照对规范化材料计算的稳定摘要（固定字段顺序/排序/bigint 十进制）。 */
  readonly coverageDigest: string;
}

/** 核验端口结果（**不透明**：只认这三种形状；其它形状一律按未获证明拒绝）。 */
export type CoverageVerification =
  | {
      status: 'verified';
      target: InventoryTarget;
      snapshotId: string;
      coverageDigest: string;
      logicalTxtScope: string;
    }
  | { status: 'no_authoritative_source' }
  | { status: 'incomplete_occupancy' };

/**
 * 受控装配的无 I/O 核验边界。契约：
 *   - 对**独立只读副本**做来源真实性 + 正面完整覆盖核验，并绑定目标、固定快照、规范化清单摘要与口径；
 *   - 原始 `coverageRef` 或调用者自填“完整”不能替代它；生产核验器未交时调用者应传 null。
 */
export interface CoverageVerifier {
  verify(material: CoverageMaterial): CoverageVerification;
}

export type InventoryPreviewRejection =
  | 'no_authoritative_source'
  | 'incomplete_occupancy'
  | 'binding_conflict'
  | 'inventory_conflict';

export type InventoryPreviewResult =
  | {
      status: 'inventory_preview';
      target: InventoryTarget;
      snapshotId: string;
      logicalTxtBytes: bigint;
      unregisteredPaths: readonly string[];
      overlapPaths: readonly string[];
      activationEligible: false;
    }
  | { status: 'rejected'; reason: InventoryPreviewRejection };

const reject = (reason: InventoryPreviewRejection): InventoryPreviewResult => ({
  status: 'rejected',
  reason,
});

const isPosInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * F1：参与摘要/绑定的文本不允许**孤立 UTF-16 代理项**。
 * Node `hash.update(string)` 按 UTF-8 编码，会把孤立代理项替换为 U+FFFD（EF BF BD）——
 * 不同孤立高/低代理项、以及字面替换字符都折叠为同一字节序列，产生摘要碰撞。
 * 合法配对（补充平面，如 U+1D11E）保持原文，不做归一化。
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (n < 0xdc00 || n > 0xdfff) return true; // 高代理后无配对低代理
      i++; // 合法配对，跳过低代理
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // 无前导高代理的低代理
    }
  }
  return false;
}

/** 非空、无 NUL、无孤立代理项（用于目标/快照/引用等绑定文本）。 */
const isSafeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0') && !hasUnpairedSurrogate(value);

const isAsciiAlnum = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/**
 * F2 规范路径：精确相对 POSIX 文件键。拒绝绝对路径（前导 `/`）、反斜杠、空段、`.`/`..` 段、
 * 尾斜杠、控制字符与边缘空白；**不**修剪、不 resolve、不折叠段、不改大小写；保留合法 Unicode 文件名。
 */
function isCanonicalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\0') || hasUnpairedSurrogate(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false; // 控制字符（含横表/回车/换行）
  }
  if (value.includes('\\')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (/^\s/.test(value) || /\s$/.test(value)) return false; // 边缘空白
  for (const seg of value.split('/')) {
    if (seg.length === 0) return false; // 空段
    if (seg === '.' || seg === '..') return false; // 点段/父段
  }
  return true;
}

/**
 * F2 内容标识：本片**不透明**的 blob 版本标识表示。ASCII token 字符集（字母数字及 `.` `_` `:` `-`），
 * 至少含一个字母或数字，禁空白/控制/非 ASCII。**只**验证表示，不声明 Git 哈希算法/长度或远端存在性。
 */
function isContentId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let hasAlnum = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (isAsciiAlnum(c)) { hasAlnum = true; continue; }
    if (c === 0x2e || c === 0x5f || c === 0x3a || c === 0x2d) continue; // . _ : -
    return false; // 其余（空白/控制/非 ASCII）一律拒绝
  }
  return hasAlnum;
}

function isValidTarget(value: unknown): value is InventoryTarget {
  if (value == null || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return isPosInt(t.repositoryId) && isSafeText(t.branch);
}

function isValidEntry(value: unknown): value is InventoryBookEntry {
  if (value == null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    isCanonicalPath(e.canonicalPath) &&
    isContentId(e.blobSha) &&
    typeof e.logicalTxtBytes === 'bigint' &&
    e.logicalTxtBytes >= 0n
  );
}

/** 规范化：一致重复（同 path、同 blob、同字节）去重；同 path 内容不一致即冲突；输出按 path 升序。 */
function normalize(
  entries: readonly InventoryBookEntry[],
): { ok: true; entries: InventoryBookEntry[] } | { ok: false } {
  const byPath = new Map<string, InventoryBookEntry>();
  for (const e of entries) {
    const prev = byPath.get(e.canonicalPath);
    if (prev === undefined) {
      byPath.set(e.canonicalPath, {
        canonicalPath: e.canonicalPath,
        blobSha: e.blobSha,
        logicalTxtBytes: e.logicalTxtBytes,
      });
      continue;
    }
    if (prev.blobSha !== e.blobSha || prev.logicalTxtBytes !== e.logicalTxtBytes) return { ok: false };
  }
  const out = [...byPath.values()].sort((a, b) =>
    a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0,
  );
  return { ok: true, entries: out };
}

/** 稳定摘要：长度前缀字段消歧（字段顺序、排序、bigint 十进制固定），平台内置 sha256。 */
function coverageDigest(
  target: InventoryTarget,
  snapshotId: string,
  coverageRef: string,
  remote: readonly InventoryBookEntry[],
): string {
  const h = createHash('sha256');
  const field = (s: string): string => `${s.length}:${s}\n`;
  h.update(field('inventory-v1'));
  h.update(field(String(target.repositoryId)));
  h.update(field(target.branch));
  h.update(field(snapshotId));
  h.update(field(coverageRef));
  h.update(field(String(remote.length)));
  for (const e of remote) {
    h.update(field(e.canonicalPath));
    h.update(field(e.blobSha));
    h.update(field(e.logicalTxtBytes.toString(10)));
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * 清单差额预检：对**核验过的固定材料**做确定性集合运算，输出预览或确定拒绝。
 * `activationEligible` 恒为 `false`——本片不授予任何激活/SQL 写入资格。
 */
export function previewReconciliationInventory(
  input: ReconciliationInventoryInput,
  coverageVerifier: CoverageVerifier | null | undefined,
): InventoryPreviewResult {
  // 1. 缺核验器/来源 ⇒ 失败关闭（调用者自填完整不算证明）。
  if (coverageVerifier == null || typeof (coverageVerifier as { verify?: unknown }).verify !== 'function') {
    return reject('no_authoritative_source');
  }
  if (input == null || typeof input !== 'object') return reject('binding_conflict');

  // 2. 目标/快照/引用形状（无法绑定 ⇒ binding_conflict）。
  if (!isValidTarget(input.target) || !isSafeText(input.snapshotId) || !isSafeText(input.coverageRef)) {
    return reject('binding_conflict');
  }
  const target: InventoryTarget = {
    repositoryId: input.target.repositoryId,
    branch: input.target.branch,
  };
  const { snapshotId, coverageRef } = input;

  // 3. 条目形状 + 规范化（形状/内容非法 ⇒ inventory_conflict）。
  if (!Array.isArray(input.remoteBooks) || !Array.isArray(input.registeredBooks)) {
    return reject('inventory_conflict');
  }
  for (const e of [...input.remoteBooks, ...input.registeredBooks]) {
    if (!isValidEntry(e)) return reject('inventory_conflict');
  }
  const remoteNorm = normalize(input.remoteBooks);
  const registeredNorm = normalize(input.registeredBooks);
  if (!remoteNorm.ok || !registeredNorm.ok) return reject('inventory_conflict');
  const remote = remoteNorm.entries;
  const registered = registeredNorm.entries;

  // 4. 私有期望快照摘要（基于私有规范化材料；不随端口副本漂移）。
  const expectedDigest = coverageDigest(target, snapshotId, coverageRef, remote);

  // 5. 交给核验端口的是**独立只读副本**（端口改它不影响上面私有材料或摘要）。
  const replica: CoverageMaterial = Object.freeze({
    target: Object.freeze({ ...target }),
    snapshotId,
    coverageRef,
    remoteBooks: Object.freeze(remote.map((e) => Object.freeze({ ...e }))),
    registeredBooks: Object.freeze(registered.map((e) => Object.freeze({ ...e }))),
    coverageDigest: expectedDigest,
  });

  const raw: unknown = coverageVerifier.verify(replica);

  // 6. 解释核验结果：未获正面完整证明一律拒绝，不引入第五种许可。
  if (raw == null || typeof raw !== 'object') return reject('incomplete_occupancy');
  const verdict = (raw as { status?: unknown }).status;
  if (verdict === 'no_authoritative_source') return reject('no_authoritative_source');
  if (verdict === 'incomplete_occupancy') return reject('incomplete_occupancy');
  if (verdict !== 'verified') return reject('incomplete_occupancy');

  const v = raw as { target?: unknown; snapshotId?: unknown; coverageDigest?: unknown; logicalTxtScope?: unknown };
  const bound =
    isValidTarget(v.target) &&
    v.target.repositoryId === target.repositoryId &&
    v.target.branch === target.branch &&
    v.snapshotId === snapshotId &&
    v.coverageDigest === expectedDigest &&
    v.logicalTxtScope === LOGICAL_TXT_SCOPE;
  if (!bound) return reject('binding_conflict');

  // 7. 登记行必须在核验过的远端全量中可解释且内容一致（否则不静默选版本/退款）。
  const remoteByPath = new Map(remote.map((e) => [e.canonicalPath, e] as const));
  for (const g of registered) {
    const r = remoteByPath.get(g.canonicalPath);
    if (r === undefined || r.blobSha !== g.blobSha || r.logicalTxtBytes !== g.logicalTxtBytes) {
      return reject('inventory_conflict');
    }
  }

  // 8. 确定性集合运算：remote−registered 为未登记集合；重叠不双计；logicalTxtBytes 只求去重后 remote 总和。
  const registeredPaths = new Set(registered.map((e) => e.canonicalPath));
  let logicalTxtBytes = 0n;
  for (const r of remote) logicalTxtBytes += r.logicalTxtBytes;
  const overlapPaths = registered.map((e) => e.canonicalPath);
  const unregisteredPaths = remote
    .filter((e) => !registeredPaths.has(e.canonicalPath))
    .map((e) => e.canonicalPath);

  return {
    status: 'inventory_preview',
    target,
    snapshotId,
    logicalTxtBytes,
    unregisteredPaths,
    overlapPaths,
    activationEligible: false,
  };
}
