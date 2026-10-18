// reporollover937 首片 + 939 四项定点整改：新 artifact 正文逻辑容量与「下一已注册仓」的**纯决策**。
//
// 范围：只做确定性决策，不接真实发布、不采集容量、不创建仓、不做迁移或原子预留、无任何副作用
// （不读环境/时钟/网络/DB）。调用方把已对账的容量证据与外部准入依据作为输入喂进来；本函数只做
// 结构/绑定/期限校验与投影比较，不声称纯函数能认证上游真实性。
//
// 与既有接口的边界（只读 935 所列六文件）：
// - 不复用 resolveRepositoryId 的单目标反查，也不重写 download-publisher；
// - 未来真实接线须在 reserveArtifactPath 之前、且在构造本次 GitHubContents 与确定 repositoryId/branch
//   之前消费本决策（不能只换 DB id 而继续用旧仓闭包）。本片不实现接线。
//
// 量纲：全部字节量为非负 bigint，target>0。容量门槛（repothresh44，用户 2026-10-19 裁定）用
// **GitHub 压缩 pack 字节**：githubSizeBytes + 1 <= targetCompressedBytes（默认 2GiB=2147483648，
// 十进制 1000000000 的旧 targetBytes 只作观测，不再参与判定）。理由：GitHub 的容量限制与
// clone/push 性能都按压缩 pack 算，而书仓 TXT 压缩≈逻辑 40%（books-2 实测逻辑 1,000,307,484 B
// 对压缩 397,520,896 B），按逻辑字节切仓会在远未触到真实限制时就开新仓（仓数量约 5 倍膨胀）。
// +1 = 「本次发布至少占 1 字节」，故正好装满（githubSizeBytes == target）的仓不合格。
// githubSizeBytes 由 sync-ledger-capacity 每小时从 GitHub API 回写台账，**滞后且偏小**（gc/统计
// 延迟），偏差方向是晚切不早切；对 5GB 硬限的 2.5 倍余量足以吸收一小时的增长。
// registeredLogicalBytes/reservedLogicalBytes 与压缩 size 量纲不同（逻辑 vs 压缩），不做混合投影；
// 它们仍随证据一起校验（R2 绑定/版本/期限），并继续供预留层记账（logicalBytesToReserve）。
//
// blobSha 口径（R4）：本接口 blobSha 指 git blob sha40，非内容 sha256——
//   依据 src/lib/artifact-bytes.ts:30 gitBlobSha = SHA-1(`blob <byteLen>\0` + UTF-8 bytes) 的 40 位小写 hex；
//   download-publisher.ts:145 再导出、:490/:504 发布侧算整本 blob_sha；
//   artifact-schema.ts:58 `book_artifacts.blob_sha CHECK (blob_sha ~ '^[a-f0-9]{40}$')`。
//   故请求与既有绑定的 blobSha 均须匹配 ^[a-f0-9]{40}$；截断/非法不 reuse、不产可写计划。

export interface RepositoryTuple {
  id: number;
  owner: string;
  repo: string;
  branch: string;
}

export type AdmissionStatus = 'granted' | 'denied' | 'unknown';

/**
 * 与某仓绑定的外部写入准入依据（R2：必须携带仓绑定，并与候选核对）。
 * 未知/拒绝/缺失/过期/错绑一律不能产出可写计划。
 */
export interface ExternalAdmission {
  status: AdmissionStatus;
  /** 证据版本/纪元；缺失视为未知。 */
  version: string | null;
  /** ISO-8601 到期时刻；null/不可解析视为未知。 */
  validUntil: string | null;
  /** 本证据所绑定的仓；须与候选元组一致（缺失/错仓不产可写计划）。 */
  target: RepositoryTuple;
}

/** 与某仓绑定的已对账逻辑账快照（R2：必须携带仓绑定，并与候选核对）。 */
export interface RepositoryAccounting {
  registeredLogicalBytes: bigint;
  reservedLogicalBytes: bigint;
  /** 快照版本；缺失视为未知。 */
  version: string | null;
  validUntil: string | null;
  /** 本快照所绑定的仓；须与候选元组一致（缺失/错仓不产可写计划）。 */
  target: RepositoryTuple;
}

export interface RepositoryCandidate extends RepositoryTuple {
  enabled: boolean;
  isPrivate: boolean;
  readOnly: boolean;
  sealed: boolean;
  /** 旧**逻辑**字节口径目标（十进制 1e9）。repothresh44 起只作观测，不参与容量判定。 */
  targetBytes: bigint;
  /** 容量门槛目标：GitHub 压缩 pack 字节（台账 target_compressed_bytes，默认 2GiB）。 */
  targetCompressedBytes: bigint;
  /** 最近一次观测到的 GitHub 压缩 pack 字节（台账 github_size_bytes；滞后且偏小，见文件头）。 */
  githubSizeBytes: bigint;
  accounting: RepositoryAccounting;
  externalAdmission: ExternalAdmission;
}

/** 可信、已 published 的既有绑定证据（用于同内容重入 reuse 判定）。R3：须带 labeledBookId。 */
export interface ExistingBinding {
  /** R3：绑定所属的 labeled_books id；须与本请求 labeledBookId 一致。 */
  labeledBookId: number;
  identityKey: string;
  /** git blob sha40（R4）。 */
  blobSha: string;
  canonicalPath: string;
  logicalBytes: bigint;
  published: boolean;
  target: RepositoryTuple;
}

export interface RepositoryRolloverRequest {
  labeledBookId: number;
  /** 内容身份（如 artifactIdentityKey 的完整 hash），不得为截断值或仅书名。 */
  identityKey: string;
  /** 完整内容 git blob sha40（R4）。 */
  blobSha: string;
  canonicalPath: string;
  logicalBytes: bigint;
  currentRepositoryId: number;
  /** 有序已注册候选（优先序即数组顺序）。 */
  candidates: readonly RepositoryCandidate[];
  existingBinding?: ExistingBinding;
  /** 显式时钟；不读真实时间。 */
  now: Date;
}

export type RepositoryRolloverBlockedReason =
  | 'NO_ELIGIBLE_REPOSITORY'
  | 'CAPACITY_UNKNOWN'
  | 'EXISTING_BINDING_REQUIRES_RECONCILIATION';

/** stay/switch 只是「需要预留」的计划，不授予直接 PUT 权限。 */
export interface RepositoryStayPlan {
  kind: 'stay';
  target: RepositoryTuple;
  snapshotVersion: string;
  logicalBytesToReserve: bigint;
  requiresReservation: true;
}

export interface RepositorySwitchPlan {
  kind: 'switch';
  target: RepositoryTuple;
  snapshotVersion: string;
  logicalBytesToReserve: bigint;
  requiresReservation: true;
}

/** 同内容已发布绑定：零增量、不变仓、不再次发布。 */
export interface RepositoryReusePlan {
  kind: 'reuse';
  target: RepositoryTuple;
  logicalBytesToReserve: bigint;
  requiresReservation: false;
}

export interface RepositoryBlockedPlan {
  kind: 'blocked';
  reason: RepositoryRolloverBlockedReason;
}

export type RepositoryRolloverPlan =
  | RepositoryStayPlan
  | RepositorySwitchPlan
  | RepositoryReusePlan
  | RepositoryBlockedPlan;

export type RepositoryRolloverInputErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_BYTE_QUANTITY'
  | 'INVALID_TARGET_BYTES'
  | 'INVALID_IDENTITY'
  | 'INVALID_BLOB_SHA'
  | 'AMBIGUOUS_CANDIDATE_IDENTITY';

export class RepositoryRolloverInputError extends Error {
  constructor(readonly code: RepositoryRolloverInputErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RepositoryRolloverInputError';
  }
}

/** git blob sha40：40 位小写 hex（见文件头 R4 依据）。 */
const BLOB_SHA = /^[a-f0-9]{40}$/;

const tupleOf = (t: RepositoryTuple): RepositoryTuple =>
  ({ id: t.id, owner: t.owner, repo: t.repo, branch: t.branch });

/** 证据绑定与候选元组是否一致：id 相等且 owner/repo 忽略大小写、branch 精确。 */
const tupleMatches = (binding: RepositoryTuple, candidate: RepositoryTuple): boolean =>
  binding.id === candidate.id
  && binding.owner.toLowerCase() === candidate.owner.toLowerCase()
  && binding.repo.toLowerCase() === candidate.repo.toLowerCase()
  && binding.branch === candidate.branch;

const requireNonNegativeBigint = (value: unknown, name: string): bigint => {
  if (typeof value !== 'bigint' || value < BigInt(0)) throw new RepositoryRolloverInputError('INVALID_BYTE_QUANTITY', name);
  return value;
};

const requirePositiveBigint = (value: unknown, name: string): bigint => {
  if (typeof value !== 'bigint' || value <= BigInt(0)) throw new RepositoryRolloverInputError('INVALID_TARGET_BYTES', name);
  return value;
};

const requirePositiveInt = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RepositoryRolloverInputError('INVALID_INPUT', name);
  }
  return value;
};

const requireNonEmpty = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new RepositoryRolloverInputError('INVALID_IDENTITY', name);
  return value;
};

/** R4：完整 git blob sha40 格式校验（截断/非法即拒，不把任意字符串等同完整内容 hash）。 */
const requireBlobSha = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !BLOB_SHA.test(value)) throw new RepositoryRolloverInputError('INVALID_BLOB_SHA', name);
  return value;
};

/** R1：显式 boolean 校验——缺失/非 boolean 拒绝，不得被当 false 仍放行。 */
const requireBoolean = (value: unknown, name: string): boolean => {
  if (typeof value !== 'boolean') throw new RepositoryRolloverInputError('INVALID_INPUT', name);
  return value;
};

/** 证据在 now 时刻是否有效：版本存在且到期时刻可解析且未过期。未知一律 false（不得按有效处理）。 */
const evidenceValid = (version: string | null, validUntil: string | null, nowMs: number): boolean => {
  if (typeof version !== 'string' || version === '') return false;
  if (typeof validUntil !== 'string' || validUntil === '') return false;
  const at = Date.parse(validUntil);
  return Number.isFinite(at) && at >= nowMs;
};

type CandidateEvaluation = 'eligible' | 'ineligible' | 'unknown';

function evaluateCandidate(
  candidate: RepositoryCandidate,
  nowMs: number,
): CandidateEvaluation {
  // R1：只按显式 boolean 判可写组合（上游已 requireBoolean，此处读到的必是 boolean）。
  if (!candidate.enabled || !candidate.isPrivate || candidate.readOnly || candidate.sealed) return 'ineligible';
  // R2：账目/准入各须携带与候选一致的仓绑定；缺失或错仓一律不产可写计划。
  if (!tupleMatches(candidate.accounting.target, candidate)) return 'unknown';
  if (!tupleMatches(candidate.externalAdmission.target, candidate)) return 'unknown';
  if (!evidenceValid(candidate.accounting.version, candidate.accounting.validUntil, nowMs)) return 'unknown';
  const admission = candidate.externalAdmission;
  if (admission.status !== 'granted'
    || !evidenceValid(admission.version, admission.validUntil, nowMs)) return 'unknown';
  // 容量门槛（repothresh44）：GitHub 压缩 pack 字节。+1 = 本次发布至少占 1 字节，
  // 故「正好装满」的仓不合格。逻辑字节 registered/reserved 与压缩 size 量纲不同，不混合投影
  // （混合会高估压缩增长 ⇒ 提前切仓 ⇒ 正是本改动要消灭的仓数量膨胀）。
  return candidate.githubSizeBytes + BigInt(1) <= candidate.targetCompressedBytes ? 'eligible' : 'ineligible';
}

/** 候选重复或冲突身份不得产生歧义计划：同 id 重复、或同 owner/repo/branch 出现多个不同 id 即拒绝。 */
function assertUnambiguousCandidates(candidates: readonly RepositoryCandidate[]): void {
  const byId = new Set<number>();
  const byName = new Map<string, number>();
  for (const candidate of candidates) {
    if (byId.has(candidate.id)) {
      throw new RepositoryRolloverInputError('AMBIGUOUS_CANDIDATE_IDENTITY', 'duplicate id');
    }
    byId.add(candidate.id);
    const key = `${candidate.owner.toLowerCase()}/${candidate.repo.toLowerCase()}/${candidate.branch}`;
    const seen = byName.get(key);
    if (seen !== undefined && seen !== candidate.id) {
      throw new RepositoryRolloverInputError('AMBIGUOUS_CANDIDATE_IDENTITY', 'conflicting id for identity');
    }
    byName.set(key, candidate.id);
  }
}

/**
 * 纯决策：给定已对账容量证据与外部准入依据，决定 stay / switch / reuse / blocked。
 * 不读环境、不调用真实时钟/网络、无副作用、不修改入参。
 */
export function planRepositoryRollover(request: RepositoryRolloverRequest): RepositoryRolloverPlan {
  if (!(request.now instanceof Date) || Number.isNaN(request.now.getTime())) {
    throw new RepositoryRolloverInputError('INVALID_INPUT', 'now');
  }
  const nowMs = request.now.getTime();
  requirePositiveInt(request.labeledBookId, 'labeledBookId');
  requirePositiveInt(request.currentRepositoryId, 'currentRepositoryId');
  requireNonEmpty(request.identityKey, 'identityKey');
  requireBlobSha(request.blobSha, 'blobSha'); // R4
  requireNonEmpty(request.canonicalPath, 'canonicalPath');
  const logicalBytes = requireNonNegativeBigint(request.logicalBytes, 'logicalBytes');
  assertUnambiguousCandidates(request.candidates);
  for (const candidate of request.candidates) {
    requirePositiveInt(candidate.id, 'candidate.id');
    requirePositiveBigint(candidate.targetBytes, 'candidate.targetBytes');
    requirePositiveBigint(candidate.targetCompressedBytes, 'candidate.targetCompressedBytes');
    requireNonNegativeBigint(candidate.githubSizeBytes, 'candidate.githubSizeBytes');
    // R1：四个状态必须显式 boolean（缺失/非 boolean 拒绝）。
    requireBoolean(candidate.enabled, 'candidate.enabled');
    requireBoolean(candidate.isPrivate, 'candidate.isPrivate');
    requireBoolean(candidate.readOnly, 'candidate.readOnly');
    requireBoolean(candidate.sealed, 'candidate.sealed');
    requireNonNegativeBigint(candidate.accounting.registeredLogicalBytes, 'accounting.registeredLogicalBytes');
    requireNonNegativeBigint(candidate.accounting.reservedLogicalBytes, 'accounting.reservedLogicalBytes');
  }

  // 既有绑定：只有可信已发布、labeledBookId 一致且身份/blobSha/路径/bytes 完全一致才 reuse；
  // 否则要求 reconciliation，不改绑他仓。
  if (request.existingBinding) {
    const binding = request.existingBinding;
    requireNonNegativeBigint(binding.logicalBytes, 'existingBinding.logicalBytes');
    // R3：labeledBookId 必须与本请求一致（单改请求书 id 不得 reuse）。
    // R4：绑定 blobSha 须为合法 git blob sha40（截断/非法不 reuse）。
    const exact = binding.published
      && binding.labeledBookId === request.labeledBookId
      && binding.identityKey === request.identityKey
      && BLOB_SHA.test(binding.blobSha) && binding.blobSha === request.blobSha
      && binding.canonicalPath === request.canonicalPath
      && binding.logicalBytes === logicalBytes;
    if (exact) {
      return { kind: 'reuse', target: tupleOf(binding.target), logicalBytesToReserve: BigInt(0), requiresReservation: false };
    }
    return { kind: 'blocked', reason: 'EXISTING_BINDING_REQUIRES_RECONCILIATION' };
  }

  const current = request.candidates.find(candidate => candidate.id === request.currentRepositoryId);
  if (current && evaluateCandidate(current, nowMs) === 'eligible') {
    return {
      kind: 'stay',
      target: tupleOf(current),
      snapshotVersion: current.accounting.version as string,
      logicalBytesToReserve: logicalBytes,
      requiresReservation: true,
    };
  }

  for (const candidate of request.candidates) {
    if (candidate === current) continue;
    if (evaluateCandidate(candidate, nowMs) === 'eligible') {
      return {
        kind: 'switch',
        target: tupleOf(candidate),
        snapshotVersion: candidate.accounting.version as string,
        logicalBytesToReserve: logicalBytes,
        requiresReservation: true,
      };
    }
  }

  const anyUnknown = request.candidates.some(
    candidate => evaluateCandidate(candidate, nowMs) === 'unknown');
  return { kind: 'blocked', reason: anyUnknown ? 'CAPACITY_UNKNOWN' : 'NO_ELIGIBLE_REPOSITORY' };
}
