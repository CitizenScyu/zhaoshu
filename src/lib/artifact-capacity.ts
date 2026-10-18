// capacity946：945 内核的 F1 隔离选项补正（F2–F6 已在 945 收口）。
//
// 一个自洽最小协议（见 reporeserve942-fix-original-report.md §6，冻结 SHA 383d980b…，943/944/945/946 已收口）：
//   - **有序非交互批（显式 READ COMMITTED）**：每个接口一次 `sql.transaction(builder, { isolationLevel: 'ReadCommitted' })`，
//     **首句**只取请求键事务锁（`pg_advisory_xact_lock`），**其余语句在锁后取得新语句快照**——
//     等待同 requestKey 的并发提交后能看到其新行（闭合 945 F1；隔离级别**必填**，不依赖端口默认，
//     默认 REPEATABLE READ 的端口即无法保证新语句快照，故显式传入，闭合 946 F1 残余）。
//   - 固定锁顺序（全局冻结）：请求键 → 当前任务租约 → 仓账行(ledger) → 预留/路径；
//     confirm/release 也**先取仓账锁再锁定/修改预留**（闭合 945 F2 的等待环）。
//   - 容量以 ledger 单行条件 UPDATE 的**当前计数**为最终门（READ COMMITTED 重取当前行重评谓词）；
//     三侧（账/预留/路径）成对成功，任何部分写由末尾 proof 除零令整批回滚。
//   - 同 requestKey 重入对**所有状态**统一校验不可变绑定与归属，再按终态精确返回（闭合 945 F3）。
//   - confirm 在**任何 await 前**冻结内部不可变 requestKey/lease/证据快照，端口与 SQL 用同一份值（闭合 945 F4）。
//   - 准入元组**由绑定构造**并对 ledger 结构与实际注册仓核对，null/缺失/错仓/错分支拒绝（闭合 945 F5）。
//   - 全部参数化，不把内容插值进 SQL 文本。
//
// 注意：本片只封装内核；真实 PUT 接线（executor/entry）与调用者接线是另一片，
// 不得据本片声称真实 PUT 已受保护。**端口必须提供 transaction 有序批且接受必填隔离选项**；缺端口即失败关闭
// （抛 TRANSACTION_PORT_UNAVAILABLE），不退回单语句策略（945 F1）。端口须以 READ COMMITTED 履约，
// 不能履约应拒绝（合同要求，本内核不能静态强制任意注入实现）——
// 事务语义（端口是否真按语句重取快照）属**运行待验证**，见报告。

import { validateArtifactPath } from './artifact-locator';

// ---------------------------------------------------------------------------
// 数据库端口（显式事务批契约）
// ---------------------------------------------------------------------------

/** 批内单条语句句柄（opaque，交回驱动执行）。 */
export type CapacityStatement = unknown;

/** 事务标签：在批内构造语句（neon 兼容形状）。 */
export interface CapacityTx {
  (strings: TemplateStringsArray, ...params: unknown[]): CapacityStatement;
}

/**
 * 事务隔离级别字面量。**必须**与端口实现的实际命名一致；本内核要求 READ COMMITTED。
 * （946 F1：默认隔离在部分驱动为 REPEATABLE READ，会令「等待锁后的次句」看不到并发提交，
 * 令 already_reserved 判定失效；故不得依赖默认，必须显式传入。）
 */
export type CapacityIsolationLevel = 'ReadCommitted';

/** 批事务选项：隔离级别**必填**。 */
export interface CapacityTransactionOptions {
  isolationLevel: CapacityIsolationLevel;
}

/** 五接口统一传入的必需选项：显式 READ COMMITTED，不依赖端口默认。 */
export const CAPACITY_REQUIRED_ISOLATION: CapacityTransactionOptions = { isolationLevel: 'ReadCommitted' };

/**
 * 内核**要求**的最小数据库端口：必须提供有序非交互批 `transaction(build, options)`，
 * 且 `options.isolationLevel` 为**必填参数**。`build` 以事务标签构造语句数组，按序在同一事务内执行
 * （首句锁、后续新快照）；端口**须**以 READ COMMITTED 履约，不能履约则**拒绝**，不得忽略所需隔离或静默降级。
 * 现有 neon 客户端 `sql`（`ReturnType<typeof neon>`）形状即满足；若注入对象缺 `transaction`，
 * 内核在运行期失败关闭，**不静默退回单语句**。真实适配器是否履约属运行待验证（见报告）。
 */
export interface CapacitySql {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown>;
  transaction(
    build: (tx: CapacityTx) => CapacityStatement[],
    options: CapacityTransactionOptions,
  ): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 与当前源码租约字段对齐（download-task-queue.ts DownloadTaskLease），不猜 DB 列。 */
export interface CapacityLease {
  /** download_tasks.id */
  taskId: number;
  /** download_tasks.lease_owner（形如 service-<PID>） */
  owner: string;
  /** download_tasks.lease_generation */
  generation: number;
}

/** 从真实 DownloadTaskLease 形状派生（字段名对齐，避免调用点手写映射）。 */
export function capacityLeaseFrom(
  lease: { id: number; leaseOwner: string; leaseGeneration: number },
): CapacityLease {
  return { taskId: lease.id, owner: lease.leaseOwner, generation: lease.leaseGeneration };
}

/** 不可变绑定：创建后不得改；重入只校验、不重绑。 */
export interface CapacityBinding {
  requestKey: string;
  labeledBookId: number;
  identityKey: string;
  /** git blob sha40（artifact-bytes.gitBlobSha 产出） */
  blobSha: string;
  repositoryId: number;
  branch: string;
  canonicalPath: string;
  logicalBytes: bigint;
}

export interface ReserveCapacityInput {
  binding: CapacityBinding;
  lease: CapacityLease;
  /** 受控对账入口给出的可信基线 epoch，必须与账行当前 baseline_epoch 相等。 */
  accountingEpoch: string;
  /** 外部写入准入版本，必须与账行 admission_version 相等且未过期、准入目标与绑定/实际仓一致。 */
  admissionVersion: string;
}

export type ReserveCapacityResult =
  | { status: 'reserved'; reservationId: number }
  | { status: 'already_reserved'; reservationId: number }
  | { status: 'already_committed' }
  | { status: 'already_released' }
  | { status: 'reconciliation_required' }
  | { status: 'binding_conflict' }
  | { status: 'stale_plan' }
  | { status: 'insufficient_capacity' }
  | { status: 'no_trusted_accounting' }
  | { status: 'repository_not_writable' }
  | { status: 'lost_lease' };

export type BeginPublicationResult =
  | { status: 'publishing' }
  | { status: 'reconciliation_required' }
  | { status: 'lost_lease' }
  | { status: 'not_found' };

/** 受控完成证据：必须绑定同一不可变目标元组。 */
export interface CompletionEvidence {
  repositoryId: number;
  branch: string;
  canonicalPath: string;
  blobSha: string;
  logicalBytes: bigint;
  /** 可选：发布完成后的 artifact 行 id。 */
  artifactId?: number;
}

/**
 * 完成证据端口：由受控发布/对账方实现。**不由内核提供 default / 永远成功 fake**。
 * 证据来源未确认时 confirmPublication 只能返回 reconciliation_required。
 * 内核在调用前冻结不可变快照，端口收到的是该快照（非调用者可变对象）。
 */
export interface CompletionEvidencePort {
  confirm(evidence: CompletionEvidence): Promise<boolean>;
}

export interface ConfirmPublicationInput {
  requestKey: string;
  lease: CapacityLease;
  publicationProof: CompletionEvidence;
  evidence: CompletionEvidencePort;
}

export type ConfirmPublicationResult =
  | { status: 'committed' }
  | { status: 'already_committed' }
  | { status: 'reconciliation_required' }
  | { status: 'lost_lease' }
  | { status: 'not_found' };

export type ReleaseUnusedResult =
  | { status: 'released' }
  | { status: 'already_released' }
  | { status: 'already_committed' }
  | { status: 'reconciliation_required' }
  | { status: 'lost_lease' }
  | { status: 'not_found' };

export type AdoptReservationResult =
  | { status: 'adopted' }
  | { status: 'reconciliation_required' }
  | { status: 'lost_lease' }
  | { status: 'not_found' };

/** 活动排他冲突/输入非法/端口缺失等由抛错表达（整批已回滚或未开始，零写）。 */
export class ArtifactCapacityError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CAPACITY_INPUT'
      | 'ACTIVE_IDENTITY_CONFLICT'
      | 'ACTIVE_PATH_CONFLICT'
      | 'ARTIFACT_PATH_COLLISION'
      | 'LABELED_BOOK_MISSING'
      | 'CAPACITY_INVALID_RESULT'
      | 'TRANSACTION_PORT_UNAVAILABLE',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ArtifactCapacityError';
  }
}

// ---------------------------------------------------------------------------
// 端口与输入校验（系统边界）
// ---------------------------------------------------------------------------

const SHA40 = /^[a-f0-9]{40}$/;
const isPosInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** 端口必须提供 transaction 有序批；缺失即失败关闭（945 F1）。 */
function requireBatchPort(sql: CapacitySql): void {
  if (typeof (sql as { transaction?: unknown } | null | undefined)?.transaction !== 'function') {
    throw new ArtifactCapacityError(
      'TRANSACTION_PORT_UNAVAILABLE',
      'ordered transaction batch port required; refusing single-statement fallback',
    );
  }
}

function validateRequestKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT');
  }
}

function validateBinding(binding: CapacityBinding): void {
  if (typeof binding.requestKey !== 'string' || !binding.requestKey || binding.requestKey.includes('\0')
    || !isPosInt(binding.labeledBookId) || !isPosInt(binding.repositoryId)
    || typeof binding.identityKey !== 'string' || !binding.identityKey || binding.identityKey.includes('\0')
    || typeof binding.blobSha !== 'string' || !SHA40.test(binding.blobSha)
    || typeof binding.branch !== 'string' || !binding.branch || binding.branch.includes('\0')
    || typeof binding.canonicalPath !== 'string' || !binding.canonicalPath
    || typeof binding.logicalBytes !== 'bigint' || binding.logicalBytes <= BigInt(0)) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT');
  }
  // 与 reserveArtifactPath 同口径的路径合法性（拒绝遍历/控制字符）；映射回内核错误码口径。
  try {
    validateArtifactPath(binding.canonicalPath);
  } catch {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT');
  }
}

function validateLease(lease: CapacityLease): void {
  if (!isPosInt(lease.taskId) || typeof lease.owner !== 'string' || !lease.owner || lease.owner.includes('\0')
    || !Number.isSafeInteger(lease.generation) || lease.generation < 0) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT');
  }
}

/** 冻结可变输入为内部不可变值：任何 await 前调用，后续端口与 SQL 只用该值（945 F4）。 */
function freezeLease(lease: CapacityLease): CapacityLease {
  return { taskId: lease.taskId, owner: lease.owner, generation: lease.generation };
}

function freezeEvidence(evidence: CompletionEvidence): CompletionEvidence {
  const frozen: CompletionEvidence = {
    repositoryId: evidence.repositoryId,
    branch: evidence.branch,
    canonicalPath: evidence.canonicalPath,
    blobSha: evidence.blobSha,
    logicalBytes: evidence.logicalBytes,
  };
  if (evidence.artifactId != null) frozen.artifactId = evidence.artifactId;
  return frozen;
}

// ---------------------------------------------------------------------------
// 结果读取（行数/字段严格校验，异常即抛，绝不静默）
// ---------------------------------------------------------------------------

const equalsCount = (value: unknown, count: number): boolean => value === count || value === String(count);

function readVerdict<Result extends { status: string }>(
  rows: unknown, allowed: ReadonlySet<string>, mapper: (status: string, row: Record<string, unknown>) => Result,
): Result {
  const list = rows as Record<string, unknown>[];
  const row = list?.[0];
  const status = row?.status;
  // 只认单行、已知状态、atomic_ok=1；status 为 NULL 的行本应已由 SQL 除零回滚，出现在这里即批语义异常。
  if (!Array.isArray(list) || list.length !== 1 || !row || typeof status !== 'string'
    || !allowed.has(status) || !equalsCount(row.atomic_ok, 1)) {
    throw new ArtifactCapacityError('CAPACITY_INVALID_RESULT');
  }
  return mapper(status, row);
}

/** 从批结果中取**第二句**（首句为请求锁）的行数组。 */
function batchRows(results: unknown): Record<string, unknown>[] {
  const list = results as unknown[] | undefined;
  const body = list?.[1];
  if (!Array.isArray(body)) throw new ArtifactCapacityError('CAPACITY_INVALID_RESULT', 'ordered batch body missing');
  return body as Record<string, unknown>[];
}

/** 把 PG 约束错误映射为内核错误（批已回滚，零写）。 */
function mapPgError(error: unknown): never {
  if (error instanceof ArtifactCapacityError) throw error;
  const code = (error as { code?: unknown })?.code;
  const constraint = (error as { constraint?: unknown })?.constraint;
  if (code === '23505' && constraint === 'artifact_capacity_identity_active_idx') {
    throw new ArtifactCapacityError('ACTIVE_IDENTITY_CONFLICT');
  }
  if (code === '23505' && constraint === 'artifact_capacity_path_active_idx') {
    throw new ArtifactCapacityError('ACTIVE_PATH_CONFLICT');
  }
  if (code === '23505' && constraint === 'book_artifacts_path_key') {
    throw new ArtifactCapacityError('ARTIFACT_PATH_COLLISION');
  }
  if (code === '23503') throw new ArtifactCapacityError('LABELED_BOOK_MISSING');
  if (code === '23514') throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT');
  throw error;
}

// ---------------------------------------------------------------------------
// 1. reserveCapacityAndPath
// ---------------------------------------------------------------------------

/**
 * 有序批：首句请求键锁；次句（新快照）租约 → 仓账 → 仓行 → 现有预留 → 条件 UPDATE 门 → 预留 → 路径 → proof。
 * 同一锁定请求键等待并发提交后，次句可看到其新预留行（already_* 正确），容量门在该 UPDATE 节点重评当前计数。
 */
export async function reserveCapacityAndPath(
  sql: CapacitySql,
  input: ReserveCapacityInput,
): Promise<ReserveCapacityResult> {
  requireBatchPort(sql);
  const binding = input.binding;
  const lease = freezeLease(input.lease);
  const accountingEpoch = input.accountingEpoch;
  const admissionVersion = input.admissionVersion;
  validateBinding(binding);
  validateLease(lease);
  if (typeof accountingEpoch !== 'string' || !accountingEpoch
    || typeof admissionVersion !== 'string' || !admissionVersion) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT');
  }
  const requestKey = binding.requestKey;
  const logicalBytes = binding.logicalBytes.toString();
  try {
    const results = await sql.transaction(tx => [
      tx`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}::text, 0::bigint))`,
      tx`
      WITH lease_guard AS MATERIALIZED (
        SELECT t.id AS task_id
        FROM download_tasks t
        WHERE t.id = ${lease.taskId} AND t.status = 'running'
          AND t.lease_owner = ${lease.owner} AND t.lease_generation = ${lease.generation}
        FOR UPDATE
      ), ledger_guard AS MATERIALIZED (
        SELECT l.repository_id, l.state,
          (l.baseline_epoch = ${accountingEpoch}) AS epoch_match,
          (l.state = 'ready' AND l.admission_status = 'granted'
             AND l.admission_version IS NOT DISTINCT FROM ${admissionVersion}
             AND l.admission_valid_until IS NOT NULL AND l.admission_valid_until > now()
             AND l.admission_target IS NOT NULL
             AND jsonb_typeof(l.admission_target) = 'object'
             AND l.admission_target = jsonb_build_object(
                   'repositoryId', ${binding.repositoryId}::int, 'branch', ${binding.branch}::text)
          ) AS admission_ok
        FROM repository_capacity_ledger l, lease_guard g
        WHERE l.repository_id = ${binding.repositoryId}
        FOR UPDATE
      ), repo_guard AS MATERIALIZED (
        SELECT r.id
        FROM storage_repositories r, ledger_guard l
        WHERE r.id = ${binding.repositoryId} AND r.branch = ${binding.branch}
          AND r.enabled AND r.is_private AND NOT r.read_only AND r.sealed_at IS NULL
        FOR UPDATE
      ), existing AS MATERIALIZED (
        SELECT r.reservation_id, r.state,
          (r.labeled_book_id = ${binding.labeledBookId} AND r.identity_key = ${binding.identityKey}
             AND r.blob_sha = ${binding.blobSha} AND r.repository_id = ${binding.repositoryId}
             AND r.branch = ${binding.branch} AND r.canonical_path = ${binding.canonicalPath}
             AND r.logical_bytes = ${logicalBytes}::bigint) AS binding_match,
          (r.task_id = ${lease.taskId} AND r.owner = ${lease.owner} AND r.generation = ${lease.generation}) AS owner_match
        FROM artifact_capacity_reservations r, lease_guard g
        WHERE r.request_key = ${requestKey}
      ), capacity_gate AS (
        -- 容量门槛（repothresh44）：GitHub 压缩 pack 字节，与 runtime-download/repository-rollover.ts
        -- 的 evaluateCandidate 逐字同判据（githubSize + 1 <= targetCompressed）。两层必须同口径，
        -- 否则 decide 判 stay 而本门判 insufficient_capacity，发布被直接阻断。逻辑字节
        -- registered/reserved 与压缩 size 量纲不同，只作观测与记账，不再参与判定。
        UPDATE repository_capacity_ledger l
           SET reserved_bytes = l.reserved_bytes + ${logicalBytes}::bigint, updated_at = now()
         FROM ledger_guard g, repo_guard p
        WHERE l.repository_id = g.repository_id
          AND g.epoch_match AND g.admission_ok AND g.state = 'ready'
          AND l.github_size_bytes + 1 <= l.target_compressed_bytes
          AND NOT EXISTS (SELECT 1 FROM existing)
        RETURNING l.repository_id
      ), reservation_ins AS (
        INSERT INTO artifact_capacity_reservations
          (request_key, labeled_book_id, identity_key, blob_sha, repository_id, branch, canonical_path,
           logical_bytes, state, owner, generation, task_id)
        SELECT ${requestKey}, ${binding.labeledBookId}, ${binding.identityKey}, ${binding.blobSha},
               ${binding.repositoryId}, ${binding.branch}, ${binding.canonicalPath},
               ${logicalBytes}::bigint, 'reserved', ${lease.owner}, ${lease.generation}, ${lease.taskId}
        FROM capacity_gate
        RETURNING reservation_id
      ), path_ins AS (
        INSERT INTO book_artifacts (labeled_book_id, identity_key, repository_id, branch, canonical_path)
        SELECT ${binding.labeledBookId}, ${binding.identityKey}, r.id, ${binding.branch}, ${binding.canonicalPath}
        FROM storage_repositories r
        WHERE r.id = ${binding.repositoryId} AND r.branch = ${binding.branch}
          AND r.enabled AND r.is_private AND NOT r.read_only AND r.sealed_at IS NULL
          AND EXISTS (SELECT 1 FROM reservation_ins)
        ON CONFLICT (identity_key) DO UPDATE SET identity_key = EXCLUDED.identity_key
        WHERE book_artifacts.labeled_book_id = EXCLUDED.labeled_book_id
          AND book_artifacts.repository_id = EXCLUDED.repository_id
          AND book_artifacts.branch = EXCLUDED.branch
          AND book_artifacts.canonical_path = EXCLUDED.canonical_path
        RETURNING id
      ), proof AS (
        SELECT
          (SELECT count(*)::int FROM lease_guard)     AS lease_ok,
          (SELECT count(*)::int FROM ledger_guard)    AS ledger_ok,
          (SELECT count(*)::int FROM repo_guard)      AS repo_ok,
          (SELECT count(*)::int FROM existing)        AS existing_ok,
          (SELECT state FROM existing)                AS existing_state,
          (SELECT binding_match FROM existing)        AS existing_binding_match,
          (SELECT owner_match FROM existing)          AS existing_owner_match,
          (SELECT reservation_id FROM existing)       AS existing_reservation_id,
          (SELECT epoch_match FROM ledger_guard)      AS epoch_match,
          (SELECT admission_ok FROM ledger_guard)     AS admission_ok,
          (SELECT state FROM ledger_guard)            AS ledger_state,
          (SELECT count(*)::int FROM capacity_gate)   AS gate_ok,
          (SELECT count(*)::int FROM reservation_ins) AS res_ok,
          (SELECT count(*)::int FROM path_ins)        AS path_ok,
          (SELECT reservation_id FROM reservation_ins) AS reservation_id
      ), verdict AS (
        SELECT proof.*, CASE
          WHEN lease_ok = 0 THEN 'lost_lease'
          WHEN ledger_ok = 0 THEN 'no_trusted_accounting'
          -- 945 F3：任何状态返回前，先统一校验不可变绑定与归属。
          WHEN existing_ok = 1 AND NOT existing_binding_match THEN 'binding_conflict'
          WHEN existing_ok = 1 AND NOT existing_owner_match THEN 'lost_lease'
          WHEN existing_ok = 1 AND existing_state = 'reserved' THEN 'already_reserved'
          WHEN existing_ok = 1 AND existing_state = 'uncertain' THEN 'reconciliation_required'
          WHEN existing_ok = 1 AND existing_state = 'committed' THEN 'already_committed'
          WHEN existing_ok = 1 AND existing_state = 'released' THEN 'already_released'
          WHEN existing_ok = 1 THEN 'binding_conflict'
          WHEN repo_ok = 0 THEN 'repository_not_writable'
          WHEN NOT epoch_match THEN 'stale_plan'
          WHEN ledger_state <> 'ready' THEN 'no_trusted_accounting'
          WHEN NOT admission_ok THEN 'no_trusted_accounting'
          WHEN gate_ok = 0 THEN 'insufficient_capacity'
          WHEN gate_ok = 1 AND res_ok = 1 AND path_ok = 1 THEN 'reserved'
          ELSE NULL END AS status
        FROM proof
      )
      SELECT verdict.*, 1 / CASE WHEN status IS NULL THEN 0 ELSE 1 END AS atomic_ok FROM verdict
      `,
    ], CAPACITY_REQUIRED_ISOLATION);

    const rows = batchRows(results);
    const allowed = new Set<ReserveCapacityResult['status']>([
      'reserved', 'already_reserved', 'already_committed', 'already_released', 'reconciliation_required',
      'binding_conflict', 'stale_plan', 'insufficient_capacity', 'no_trusted_accounting',
      'repository_not_writable', 'lost_lease',
    ]);
    const row = rows[0];
    const status = row?.status;
    if (rows.length !== 1 || !row || typeof status !== 'string'
      || !allowed.has(status as ReserveCapacityResult['status']) || !equalsCount(row.atomic_ok, 1)) {
      throw new ArtifactCapacityError('CAPACITY_INVALID_RESULT');
    }
    const idOf = (value: unknown): number => {
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0) throw new ArtifactCapacityError('CAPACITY_INVALID_RESULT');
      return id;
    };
    if (status === 'reserved') return { status: 'reserved', reservationId: idOf(row.reservation_id) };
    if (status === 'already_reserved') return { status: 'already_reserved', reservationId: idOf(row.existing_reservation_id) };
    if (status === 'insufficient_capacity' && !(equalsCount(row.gate_ok, 0))) {
      // 防御：insufficient_capacity 必须在容量门上零写。
      throw new ArtifactCapacityError('CAPACITY_INVALID_RESULT');
    }
    return { status: status as ReserveCapacityResult['status'] } as ReserveCapacityResult;
  } catch (error) {
    return mapPgError(error);
  }
}

// ---------------------------------------------------------------------------
// 2. beginPublication
// ---------------------------------------------------------------------------

/** reserved → uncertain：首个 PUT 前持久化；成功才授予一次发布尝试。重复/接管不确定不发许可、不退款。 */
export async function beginPublication(
  sql: CapacitySql,
  input: { requestKey: string; lease: CapacityLease },
): Promise<BeginPublicationResult> {
  requireBatchPort(sql);
  const lease = freezeLease(input.lease);
  const requestKey = input.requestKey;
  validateLease(lease);
  validateRequestKey(requestKey);
  try {
    const results = await sql.transaction(tx => [
      tx`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}::text, 0::bigint))`,
      tx`
      WITH lease_guard AS MATERIALIZED (
        SELECT t.id FROM download_tasks t
        WHERE t.id = ${lease.taskId} AND t.status = 'running'
          AND t.lease_owner = ${lease.owner} AND t.lease_generation = ${lease.generation}
        FOR UPDATE
      ), cur AS MATERIALIZED (
        SELECT r.state,
          (r.owner = ${lease.owner} AND r.generation = ${lease.generation}
             AND r.task_id = ${lease.taskId}) AS owner_match
        FROM artifact_capacity_reservations r, lease_guard
        WHERE r.request_key = ${requestKey}
        FOR UPDATE
      ), upd AS (
        UPDATE artifact_capacity_reservations r SET state = 'uncertain', begun_at = now()
        FROM cur c
        WHERE r.request_key = ${requestKey} AND r.state = 'reserved'
          AND r.owner = ${lease.owner} AND r.generation = ${lease.generation}
          AND r.task_id = ${lease.taskId} AND c.owner_match
        RETURNING r.reservation_id
      ), proof AS (
        SELECT (SELECT count(*)::int FROM lease_guard) AS lease_ok,
               (SELECT count(*)::int FROM cur) AS cur_ok,
               (SELECT state FROM cur) AS state,
               (SELECT owner_match FROM cur) AS owner_match,
               (SELECT count(*)::int FROM upd) AS upd_ok
      ), verdict AS (
        SELECT proof.*, CASE
          WHEN lease_ok = 0 THEN 'lost_lease'
          WHEN cur_ok = 0 THEN 'not_found'
          WHEN state = 'uncertain' THEN 'reconciliation_required'
          WHEN state IN ('committed','released') THEN 'not_found'
          WHEN state = 'reserved' AND owner_match AND upd_ok = 1 THEN 'publishing'
          WHEN state = 'reserved' AND NOT owner_match THEN 'lost_lease'
          ELSE NULL END AS status
        FROM proof
      )
      SELECT verdict.*, 1 / CASE WHEN status IS NULL THEN 0 ELSE 1 END AS atomic_ok FROM verdict
      `,
    ], CAPACITY_REQUIRED_ISOLATION);
    return readVerdict<BeginPublicationResult>(
      batchRows(results),
      new Set(['publishing', 'reconciliation_required', 'lost_lease', 'not_found']),
      status => ({ status } as BeginPublicationResult),
    );
  } catch (error) {
    return mapPgError(error);
  }
}

// ---------------------------------------------------------------------------
// 3. confirmPublication
// ---------------------------------------------------------------------------

/** uncertain → committed：仅受控完整完成证据 + 有效租约；一次转账，重复返回 already_committed。 */
export async function confirmPublication(
  sql: CapacitySql,
  input: ConfirmPublicationInput,
): Promise<ConfirmPublicationResult> {
  requireBatchPort(sql);
  // 945 F4：任何 await 之前，把可变的 requestKey/lease/证据字段冻结为**内部不可变原语**；
  // 端口只收到独立副本，SQL 只用这些原语——端口或调用者在 await 期间改写均不影响 SQL 匹配。
  const requestKey = input.requestKey;
  const lease = freezeLease(input.lease);
  const evidencePort = input.evidence;
  validateLease(lease);
  validateRequestKey(requestKey);
  const proof = input.publicationProof;
  if (!proof || !isPosInt(proof.repositoryId) || typeof proof.branch !== 'string' || !proof.branch
    || typeof proof.canonicalPath !== 'string' || !proof.canonicalPath
    || typeof proof.blobSha !== 'string' || !SHA40.test(proof.blobSha)
    || typeof proof.logicalBytes !== 'bigint' || proof.logicalBytes <= BigInt(0)
    || !evidencePort || typeof evidencePort.confirm !== 'function') {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT');
  }
  const proofRepositoryId = proof.repositoryId;
  const proofBranch = proof.branch;
  const proofCanonicalPath = proof.canonicalPath;
  const proofBlobSha = proof.blobSha;
  const logicalBytes = proof.logicalBytes.toString();
  const artifactId = proof.artifactId != null && isPosInt(proof.artifactId) ? proof.artifactId : null;
  // 端口先判定（收到独立冻结副本，非调用者对象）；未确认则不可能进入 committed。
  const confirmed = await evidencePort.confirm(freezeEvidence({
    repositoryId: proofRepositoryId, branch: proofBranch, canonicalPath: proofCanonicalPath,
    blobSha: proofBlobSha, logicalBytes: proof.logicalBytes, artifactId: proof.artifactId,
  }));
  const evidenceConfirmed = confirmed === true;
  try {
    const results = await sql.transaction(tx => [
      tx`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}::text, 0::bigint))`,
      tx`
      WITH lease_guard AS MATERIALIZED (
        SELECT t.id FROM download_tasks t
        WHERE t.id = ${lease.taskId} AND t.status = 'running'
          AND t.lease_owner = ${lease.owner} AND t.lease_generation = ${lease.generation}
        FOR UPDATE
      ), ledger_lock AS MATERIALIZED (
        -- 945 F2：先取仓账锁（由预留定位仓，不作最终校验），再锁定/修改预留。
        SELECT l.repository_id
        FROM repository_capacity_ledger l, lease_guard g
        WHERE l.repository_id = (
          SELECT r.repository_id FROM artifact_capacity_reservations r WHERE r.request_key = ${requestKey})
        FOR UPDATE
      ), cur AS MATERIALIZED (
        SELECT r.state, r.repository_id, r.logical_bytes,
          (r.owner = ${lease.owner} AND r.generation = ${lease.generation}
             AND r.task_id = ${lease.taskId}) AS owner_match,
          (r.repository_id = ${proofRepositoryId} AND r.branch = ${proofBranch}
             AND r.canonical_path = ${proofCanonicalPath} AND r.blob_sha = ${proofBlobSha}
             AND r.logical_bytes = ${logicalBytes}::bigint) AS proof_match
        FROM artifact_capacity_reservations r, ledger_lock
        WHERE r.request_key = ${requestKey}
        FOR UPDATE
      ), upd AS (
        UPDATE artifact_capacity_reservations r
           SET state = 'committed', artifact_id = ${artifactId}, resolved_at = now()
        FROM cur c
        WHERE r.request_key = ${requestKey} AND r.state = 'uncertain'
          AND c.owner_match AND c.proof_match AND ${evidenceConfirmed}::boolean
        RETURNING r.repository_id, r.logical_bytes
      ), ledger AS (
        UPDATE repository_capacity_ledger l
           SET reserved_bytes = l.reserved_bytes - u.logical_bytes,
               registered_bytes = l.registered_bytes + u.logical_bytes,
               updated_at = now()
        FROM upd u WHERE l.repository_id = u.repository_id
        RETURNING l.repository_id
      ), proof AS (
        SELECT (SELECT count(*)::int FROM lease_guard) AS lease_ok,
               (SELECT count(*)::int FROM cur) AS cur_ok,
               (SELECT state FROM cur) AS state,
               (SELECT owner_match FROM cur) AS owner_match,
               (SELECT proof_match FROM cur) AS proof_match,
               (SELECT count(*)::int FROM upd) AS upd_ok,
               (SELECT count(*)::int FROM ledger) AS ledger_ok
      ), verdict AS (
        SELECT proof.*, CASE
          WHEN lease_ok = 0 THEN 'lost_lease'
          WHEN cur_ok = 0 THEN 'not_found'
          WHEN state = 'committed' THEN 'already_committed'
          WHEN state IN ('released') THEN 'not_found'
          WHEN state = 'reserved' THEN 'not_found'
          WHEN state = 'uncertain' AND NOT owner_match THEN 'lost_lease'
          WHEN state = 'uncertain' AND NOT proof_match THEN 'reconciliation_required'
          WHEN state = 'uncertain' AND NOT ${evidenceConfirmed}::boolean THEN 'reconciliation_required'
          WHEN state = 'uncertain' AND upd_ok = 1 AND ledger_ok = 1 THEN 'committed'
          ELSE NULL END AS status
        FROM proof
      )
      SELECT verdict.*, 1 / CASE WHEN status IS NULL THEN 0 ELSE 1 END AS atomic_ok FROM verdict
      `,
    ], CAPACITY_REQUIRED_ISOLATION);
    return readVerdict<ConfirmPublicationResult>(
      batchRows(results),
      new Set(['committed', 'already_committed', 'reconciliation_required', 'lost_lease', 'not_found']),
      status => ({ status } as ConfirmPublicationResult),
    );
  } catch (error) {
    return mapPgError(error);
  }
}

// ---------------------------------------------------------------------------
// 4. releaseUnused
// ---------------------------------------------------------------------------

/** 仅 reserved 且从未过 begin 门 → released，一次减额；uncertain 一律不退款。 */
export async function releaseUnused(
  sql: CapacitySql,
  input: { requestKey: string; lease: CapacityLease },
): Promise<ReleaseUnusedResult> {
  requireBatchPort(sql);
  const lease = freezeLease(input.lease);
  const requestKey = input.requestKey;
  validateLease(lease);
  validateRequestKey(requestKey);
  try {
    const results = await sql.transaction(tx => [
      tx`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}::text, 0::bigint))`,
      tx`
      WITH lease_guard AS MATERIALIZED (
        SELECT t.id FROM download_tasks t
        WHERE t.id = ${lease.taskId} AND t.status = 'running'
          AND t.lease_owner = ${lease.owner} AND t.lease_generation = ${lease.generation}
        FOR UPDATE
      ), ledger_lock AS MATERIALIZED (
        -- 945 F2：先取仓账锁，再锁定/修改预留。
        SELECT l.repository_id
        FROM repository_capacity_ledger l, lease_guard g
        WHERE l.repository_id = (
          SELECT r.repository_id FROM artifact_capacity_reservations r WHERE r.request_key = ${requestKey})
        FOR UPDATE
      ), cur AS MATERIALIZED (
        SELECT r.state, r.begun_at,
          (r.owner = ${lease.owner} AND r.generation = ${lease.generation}
             AND r.task_id = ${lease.taskId}) AS owner_match
        FROM artifact_capacity_reservations r, ledger_lock
        WHERE r.request_key = ${requestKey}
        FOR UPDATE
      ), upd AS (
        UPDATE artifact_capacity_reservations r SET state = 'released', resolved_at = now()
        FROM cur c
        WHERE r.request_key = ${requestKey} AND r.state = 'reserved' AND r.begun_at IS NULL
          AND r.owner = ${lease.owner} AND r.generation = ${lease.generation}
          AND r.task_id = ${lease.taskId} AND c.owner_match
        RETURNING r.repository_id, r.logical_bytes
      ), ledger AS (
        UPDATE repository_capacity_ledger l
           SET reserved_bytes = l.reserved_bytes - u.logical_bytes, updated_at = now()
        FROM upd u WHERE l.repository_id = u.repository_id
        RETURNING l.repository_id
      ), proof AS (
        SELECT (SELECT count(*)::int FROM lease_guard) AS lease_ok,
               (SELECT count(*)::int FROM cur) AS cur_ok,
               (SELECT state FROM cur) AS state,
               (SELECT owner_match FROM cur) AS owner_match,
               (SELECT count(*)::int FROM upd) AS upd_ok,
               (SELECT count(*)::int FROM ledger) AS ledger_ok
      ), verdict AS (
        SELECT proof.*, CASE
          WHEN lease_ok = 0 THEN 'lost_lease'
          WHEN cur_ok = 0 THEN 'not_found'
          WHEN state = 'released' THEN 'already_released'
          WHEN state = 'committed' THEN 'already_committed'
          WHEN state = 'uncertain' THEN 'reconciliation_required'
          WHEN state = 'reserved' AND NOT owner_match THEN 'lost_lease'
          WHEN state = 'reserved' AND upd_ok = 1 AND ledger_ok = 1 THEN 'released'
          ELSE NULL END AS status
        FROM proof
      )
      SELECT verdict.*, 1 / CASE WHEN status IS NULL THEN 0 ELSE 1 END AS atomic_ok FROM verdict
      `,
    ], CAPACITY_REQUIRED_ISOLATION);
    return readVerdict<ReleaseUnusedResult>(
      batchRows(results),
      new Set(['released', 'already_released', 'already_committed', 'reconciliation_required', 'lost_lease', 'not_found']),
      status => ({ status } as ReleaseUnusedResult),
    );
  } catch (error) {
    return mapPgError(error);
  }
}

// ---------------------------------------------------------------------------
// 5. adoptReservation
// ---------------------------------------------------------------------------

/**
 * 仅同 taskId 的**新有效 generation** 的显式 CAS；要求新 generation 严格大于被锁定的旧值并比较旧归属，
 * 只换归属，保留绑定/状态/占用；跨任务不隐式重绑；完全相同归属为幂等 adopted。
 */
export async function adoptReservation(
  sql: CapacitySql,
  input: { requestKey: string; newLease: CapacityLease },
): Promise<AdoptReservationResult> {
  requireBatchPort(sql);
  const lease = freezeLease(input.newLease);
  const requestKey = input.requestKey;
  validateLease(lease);
  validateRequestKey(requestKey);
  try {
    const results = await sql.transaction(tx => [
      tx`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}::text, 0::bigint))`,
      tx`
      WITH lease_guard AS MATERIALIZED (
        SELECT t.id FROM download_tasks t
        WHERE t.id = ${lease.taskId} AND t.status = 'running'
          AND t.lease_owner = ${lease.owner} AND t.lease_generation = ${lease.generation}
        FOR UPDATE
      ), cur AS MATERIALIZED (
        SELECT r.state, r.task_id, r.owner, r.generation,
          (r.task_id = ${lease.taskId}) AS same_task,
          (r.owner = ${lease.owner} AND r.generation = ${lease.generation}
             AND r.task_id = ${lease.taskId}) AS already_new,
          (${lease.generation}::bigint > r.generation) AS newer
        FROM artifact_capacity_reservations r, lease_guard
        WHERE r.request_key = ${requestKey}
        FOR UPDATE
      ), upd AS (
        UPDATE artifact_capacity_reservations r
           SET owner = ${lease.owner}, generation = ${lease.generation}
        FROM cur c
        WHERE r.request_key = ${requestKey} AND c.same_task
          AND r.state IN ('reserved','uncertain')
          AND r.task_id = c.task_id AND r.owner = c.owner AND r.generation = c.generation
          AND ${lease.generation}::bigint > c.generation
        RETURNING r.reservation_id
      ), proof AS (
        SELECT (SELECT count(*)::int FROM lease_guard) AS lease_ok,
               (SELECT count(*)::int FROM cur) AS cur_ok,
               (SELECT state FROM cur) AS state,
               (SELECT same_task FROM cur) AS same_task,
               (SELECT already_new FROM cur) AS already_new,
               (SELECT newer FROM cur) AS newer,
               (SELECT count(*)::int FROM upd) AS upd_ok
      ), verdict AS (
        SELECT proof.*, CASE
          WHEN lease_ok = 0 THEN 'lost_lease'
          WHEN cur_ok = 0 THEN 'not_found'
          WHEN NOT same_task THEN 'reconciliation_required'
          WHEN state IN ('committed','released') THEN 'not_found'
          WHEN already_new THEN 'adopted'
          WHEN newer AND upd_ok = 1 THEN 'adopted'
          WHEN NOT newer THEN 'lost_lease'
          ELSE NULL END AS status
        FROM proof
      )
      SELECT verdict.*, 1 / CASE WHEN status IS NULL THEN 0 ELSE 1 END AS atomic_ok FROM verdict
      `,
    ], CAPACITY_REQUIRED_ISOLATION);
    return readVerdict<AdoptReservationResult>(
      batchRows(results),
      new Set(['adopted', 'reconciliation_required', 'lost_lease', 'not_found']),
      status => ({ status } as AdoptReservationResult),
    );
  } catch (error) {
    return mapPgError(error);
  }
}
