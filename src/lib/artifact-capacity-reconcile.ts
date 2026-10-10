// capacity952 受控首次对账入口（静态实施）＋ capacity953 六项定点修复。
//
// 合同（accept951-final-and-952-delta.md；覆盖旧稿“先 seed 再 22012 映射”）：
//   A. 正常业务拒绝不先 seed：有序事务中先判状态/门，**所有正常拒绝对 ledger 零 DML**、直接返回领域结果；
//      只有全部首次激活门成立才**条件 INSERT ready**（账不存在）或**条件 UPDATE uninitialized→ready**。
//   B. proof（末句除零）只处理**本不该发生**的部分写入/结果一致性错误：整批回滚、异常原样抛出；
//      正常拒绝不触发 SQL 异常，不从 SQLSTATE 22012 推断业务拒绝，无补查询、无重试。
//   C. 受信来源合同**分离**“原始身份验证”与“当前激活许可”：原始证明引用绑定不可变规范元组
//      （受控端口产稳定指纹）；当前许可缺失/过期/屏障失败只作**首次激活**否决输入，
//      **不拦已 ready 相同身份**的零写重试。
//
// 953 六项定点修复：
//   F1 首次激活准入期限：合法有限时间解析 + 在取得锁后用**真实时钟**（clock_timestamp，非事务起点 now）
//      核有效期；过期/非法＝首次 admission_invalid 零 DML，不提前拒绝 ready 同身份。
//   F2 旧 uninitialized：锁读实际 target/既有目标绑定并核对本次规范元组，不符固定 binding_conflict，不放宽。
//   F3 实际锁依赖：账锁阶段(existing FOR UPDATE)→stage→repo_lock(以 stage 为驱动行来源、FOR UPDATE OF r)→仓锁完成→
//      活动/时钟；“账不存在”保留一行阶段输出。
//      954 A：gate 行来源含仓锁完成结果，空活动计数不能省掉仓锁阶段。
//      954 lockedge：repo_lock 以 stage 为真实行来源（SELECT 消费 s.ledger_exists），强制账锁先于仓锁、非可裁剪空侧。
//   F4 状态优先级：ready 同/异原始身份先于仓可写/准入/屏障/活动门；当前许可目标错绑转首次激活拒绝输入。
//   F5 私有期望快照：目标/原始引用原语留在不外泄闭包，交给端口的是独立且运行时冻结的副本；核对与 SQL 用原请求快照。
//   F6 proof 独立不变量：initialized 必须对应合法首次分支恰一次 INSERT 或 UPDATE；拒绝/幂等写零行；
//      其它组合触发事务异常回滚并原样传播（不靠 status 非空即 atomic_ok=1，不靠提交后 JS 检查替代）。
//
// 本片只定义注入边界并用合成桩写草稿；**不提供假生产端口/屏障**，不接真实来源、不迁移、不接真实发布。
// 不改 kernel（artifact-capacity.ts）、adapter（artifact-capacity-sql.ts）、schema（artifact-capacity-schema.ts）。
// 事务语义（READ COMMITTED 语句快照、advisory 锁阻塞性、clock_timestamp 在锁后取值）属**运行待验证**；本文件未运行。

import {
  ArtifactCapacityError,
  CAPACITY_REQUIRED_ISOLATION,
  type CapacitySql,
} from './artifact-capacity';

// ---------------------------------------------------------------------------
// 受信边界类型（原始身份 与 当前激活许可 **类型上分开**）
// ---------------------------------------------------------------------------

/** 对账目标（仓 + 分支）。调用者只能给目标与原始引用，不能自填已验证结果。 */
export interface ReconcileTarget {
  repositoryId: number;
  branch: string;
}

/** 原始受信证明引用：**不透明引用**，本身不自证可信；由受控端口据此取回并验证原始完整元组。 */
export interface RawSourceReference {
  /** 原始对账版本引用（原始身份组成部分，非“任意非空 epoch”）。 */
  reconciliationVersion: string;
  /** 原始占用快照/证明引用。 */
  occupancyProofRef: string;
  /** 外部屏障引用（屏障义务见下）。 */
  barrierRef: string;
  /** 外部准入引用。 */
  admissionRef: string;
}

/** 单条原始活动预留（原始快照口径；仅首次激活分支消费）。 */
export interface OriginalActiveReservation {
  requestKey: string;
  state: 'reserved' | 'uncertain';
  logicalBytes: bigint;
}

/**
 * 已验证的**原始不可变身份**（规范元组）。**只**由受控端口产出；
 * `fingerprint` 为端口对上述规范冻结字段计算的**稳定无歧义**摘要（kernel 只作身份比较，不重算算法）。
 */
export interface VerifiedOriginalIdentity {
  repositoryId: number;
  branch: string;
  /** logical TXT 口径标识（原始清单口径）。 */
  logicalTxtScope: string;
  targetBytes: bigint;
  /** 覆盖范围内逐书 committed 逻辑字节和（原始快照；每书只计一次由端口保证）。 */
  registeredBytes: bigint;
  /** 原始活动预留（原始快照）。 */
  activeReservations: readonly OriginalActiveReservation[];
  /** 原始对账版本（参与身份指纹）。 */
  reconciliationVersion: string;
  /** 原始占用快照/证明摘要（参与身份指纹）。 */
  occupancyProofDigest: string;
  /** 原始准入绑定（参与身份指纹）。 */
  admissionBinding: { version: string; target: ReconcileTarget };
  /** 屏障引用（参与身份指纹的绑定对象）。 */
  barrierRef: string;
  /** 端口对规范原始元组计算的稳定指纹；**改变任一原始字段即异身份**。 */
  fingerprint: string;
}

/** 原始身份验证结果（端口）。**无效即所有状态都拒绝**（先于任何 ledger 状态判断）。 */
export type OriginalVerification =
  | { status: 'verified'; original: VerifiedOriginalIdentity }
  | { status: 'no_authoritative_source' }
  | { status: 'incomplete_occupancy' };

/**
 * 当前激活许可（端口提供）。可为**明确拒绝**；仅作**首次激活**输入，绝不拦 ready 同身份幂等。
 * `granted` 时携带当前有效准入（绑定目标）。
 */
export type CurrentActivation =
  | { status: 'granted'; admission: { version: string; validUntil: string; target: ReconcileTarget } }
  | { status: 'admission_invalid' }
  | { status: 'quiescence_unproven' };

/**
 * 受控装配端口（**不由内核提供 fake**）。契约：
 *   - 在**外部屏障之内**完成原始元组验证（快照）；
 *   - 把 `work` 围在屏障窗口内执行，**屏障在原始快照之前建立、保持到 `work` 完成**（覆盖 SQL 事务提交窗口）；
 *   - 向 `work` 提供“原始身份验证结果”与“当前激活许可/拒绝”（两者类型分开）；
 *   - **不是**把一个 `barrierVersion` 字符串当锁；屏障由受信来源给出保证。
 * 端口缺失/形状非法 ⇒ kernel 失败关闭（抛错），不退回自填验证。
 */
export interface ReconciliationSource {
  reconcile<T>(
    input: { target: ReconcileTarget; raw: RawSourceReference },
    work: (original: OriginalVerification, activation: CurrentActivation) => Promise<T>,
  ): Promise<T>;
}

export interface ReconcileInput {
  target: ReconcileTarget;
  raw: RawSourceReference;
}

/** 领域返回态（白名单）。`no_authoritative_source`/`incomplete_occupancy` 由端口在 SQL 前判定返回。 */
export type ReconcileResult =
  | { status: 'initialized' }
  | { status: 'already_initialized' }
  | { status: 'binding_conflict' }
  | { status: 'active_reservations_present' }
  | { status: 'admission_invalid' }
  | { status: 'quiescence_unproven' }
  | { status: 'no_authoritative_source' }
  | { status: 'incomplete_occupancy' }
  | { status: 'repository_not_writable' };

/** SQL 侧可能返回的状态（不含端口 SQL 前判定项）。 */
const SQL_STATUSES: ReadonlySet<string> = new Set([
  'initialized', 'already_initialized', 'binding_conflict', 'active_reservations_present',
  'admission_invalid', 'quiescence_unproven', 'repository_not_writable',
]);

// ---------------------------------------------------------------------------
// 输入校验 / 私有期望快照（跨 await 前固定原语；不外泄、运行时冻结）
// ---------------------------------------------------------------------------

const isPosInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isNonNegBig = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n;
const nonEmptyStr = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');

/** 端口必须提供有序事务批；缺失即失败关闭（不退回单语句）。 */
function requireBatchPort(sql: CapacitySql): void {
  if (typeof (sql as { transaction?: unknown } | null | undefined)?.transaction !== 'function') {
    throw new ArtifactCapacityError(
      'TRANSACTION_PORT_UNAVAILABLE',
      'ordered transaction batch port required; refusing single-statement fallback',
    );
  }
}

function requireSource(source: ReconciliationSource | null | undefined): asserts source is ReconciliationSource {
  if (source == null || typeof source.reconcile !== 'function') {
    throw new ArtifactCapacityError(
      'TRANSACTION_PORT_UNAVAILABLE',
      'controlled reconciliation source required; refusing caller-supplied verification',
    );
  }
}

function validateTarget(target: ReconcileTarget): void {
  if (!isPosInt(target.repositoryId) || !nonEmptyStr(target.branch)) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT', 'invalid reconciliation target');
  }
}

function validateRaw(raw: RawSourceReference): void {
  if (!nonEmptyStr(raw.reconciliationVersion) || !nonEmptyStr(raw.occupancyProofRef)
    || !nonEmptyStr(raw.barrierRef) || !nonEmptyStr(raw.admissionRef)) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT', 'invalid raw source reference');
  }
}

/** 原语复制：**不是**“冻结”，仅取原语值；调用处另以 Object.freeze 真正冻结（F5）。 */
function cloneTarget(target: ReconcileTarget): ReconcileTarget {
  return { repositoryId: target.repositoryId, branch: target.branch };
}

function cloneRaw(raw: RawSourceReference): RawSourceReference {
  return {
    reconciliationVersion: raw.reconciliationVersion,
    occupancyProofRef: raw.occupancyProofRef,
    barrierRef: raw.barrierRef,
    admissionRef: raw.admissionRef,
  };
}

function freezeOriginal(original: VerifiedOriginalIdentity): VerifiedOriginalIdentity {
  return {
    repositoryId: original.repositoryId,
    branch: original.branch,
    logicalTxtScope: original.logicalTxtScope,
    targetBytes: original.targetBytes,
    registeredBytes: original.registeredBytes,
    activeReservations: original.activeReservations.map(r => ({
      requestKey: r.requestKey, state: r.state, logicalBytes: r.logicalBytes,
    })),
    reconciliationVersion: original.reconciliationVersion,
    occupancyProofDigest: original.occupancyProofDigest,
    admissionBinding: {
      version: original.admissionBinding.version,
      target: {
        repositoryId: original.admissionBinding.target.repositoryId,
        branch: original.admissionBinding.target.branch,
      },
    },
    barrierRef: original.barrierRef,
    fingerprint: original.fingerprint,
  };
}

/** 端口返回的“已验证”元组必须自洽；形状非法即失败关闭（抛错，零写）。 */
function validateOriginal(original: VerifiedOriginalIdentity): void {
  if (!isPosInt(original.repositoryId) || !nonEmptyStr(original.branch)
    || !nonEmptyStr(original.logicalTxtScope)
    || !(typeof original.targetBytes === 'bigint' && original.targetBytes > 0n)
    || !isNonNegBig(original.registeredBytes)
    || !nonEmptyStr(original.reconciliationVersion) || !nonEmptyStr(original.occupancyProofDigest)
    || !nonEmptyStr(original.barrierRef) || !nonEmptyStr(original.fingerprint)
    || !nonEmptyStr(original.admissionBinding.version)
    || !isPosInt(original.admissionBinding.target.repositoryId)
    || !nonEmptyStr(original.admissionBinding.target.branch)) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT', 'malformed verified original identity');
  }
  for (const r of original.activeReservations) {
    if (!nonEmptyStr(r.requestKey) || (r.state !== 'reserved' && r.state !== 'uncertain')
      || !(typeof r.logicalBytes === 'bigint' && r.logicalBytes > 0n)) {
      throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT', 'malformed original active reservation');
    }
  }
}

const sameTarget = (a: ReconcileTarget, b: ReconcileTarget): boolean =>
  a.repositoryId === b.repositoryId && a.branch === b.branch;

/** 当前激活许可规范化：**解析为有限合法时间**；未知形状/非法时间失败关闭（F1）。 */
function normalizeActivation(activation: CurrentActivation | null | undefined): CurrentActivation {
  if (activation == null || typeof activation !== 'object') return { status: 'quiescence_unproven' };
  const status = (activation as { status?: unknown }).status;
  if (status === 'admission_invalid' || status === 'quiescence_unproven') return { status };
  if (status === 'granted') {
    const admission = (activation as { admission?: unknown }).admission as
      { version?: unknown; validUntil?: unknown; target?: unknown } | undefined;
    const target = admission?.target as { repositoryId?: unknown; branch?: unknown } | undefined;
    if (!admission || !nonEmptyStr(admission.version) || !nonEmptyStr(admission.validUntil)
      || !Number.isFinite(Date.parse(admission.validUntil))
      || !target || !isPosInt(target.repositoryId) || !nonEmptyStr(target.branch)) {
      return { status: 'admission_invalid' };
    }
    return {
      status: 'granted',
      admission: {
        version: admission.version,
        validUntil: admission.validUntil,
        target: { repositoryId: target.repositoryId, branch: target.branch },
      },
    };
  }
  return { status: 'quiescence_unproven' };
}

// ---------------------------------------------------------------------------
// 结果读取（严格：单行、已知状态、atomic_ok=1；否则抛，绝不静默）
// ---------------------------------------------------------------------------

const equalsCount = (value: unknown, count: number): boolean => value === count || value === String(count);

function batchBody(results: unknown): Record<string, unknown>[] {
  const list = results as unknown[] | undefined;
  const body = list?.[1];
  if (!Array.isArray(body)) {
    throw new ArtifactCapacityError('CAPACITY_INVALID_RESULT', 'ordered batch body missing');
  }
  return body as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// 有序事务批：init 请求锁 → 账锁 → 仓元数据锁 → 活动 → 门/条件写 → proof 不变量
// ---------------------------------------------------------------------------

async function runReconcileTransaction(
  sql: CapacitySql,
  target: ReconcileTarget,
  original: VerifiedOriginalIdentity,
  activation: CurrentActivation,
): Promise<ReconcileResult> {
  const repoId = target.repositoryId;
  const branch = target.branch;
  const fingerprint = original.fingerprint;
  const targetBytes = original.targetBytes.toString();
  const registeredBytes = original.registeredBytes.toString();
  const inputActiveEmpty = original.activeReservations.length === 0;

  const activationGranted = activation.status === 'granted';
  const activationTargetOk = activationGranted && sameTarget(activation.admission.target, target);
  const admissionVersion = activationGranted ? activation.admission.version : null;
  const admissionValidUntil = activationGranted ? activation.admission.validUntil : null;
  const activationReject = activation.status === 'quiescence_unproven' ? 'quiescence_unproven' : 'admission_invalid';

  const results = await sql.transaction(tx => [
    // 首句：同仓固定 init 请求锁（repositoryId 派生），串行同仓初始化；不控制遗留 PUT（由外部屏障保证）。
    tx`SELECT pg_advisory_xact_lock(hashtextextended('capacity-init:' || ${repoId}::text, 0::bigint))`,
    // 次句：锁后新快照。CTE 依赖链强制“账锁 → 仓元数据锁 → 活动”实际取锁顺序；
    // 严格基于语句内既有 ledger 行锁（FOR UPDATE）；长/短备注不是锁序证明。
    tx`
    WITH existing AS MATERIALIZED (
      SELECT l.repository_id, l.state, l.target_bytes, l.admission_target,
             (l.baseline_epoch = ${fingerprint}) AS identity_match
      FROM repository_capacity_ledger l
      WHERE l.repository_id = ${repoId}
      FOR UPDATE
    ), stage AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM existing)         AS ledger_exists,
             (SELECT state FROM existing)            AS existing_state,
             (SELECT target_bytes FROM existing)     AS old_target_bytes,
             (SELECT admission_target FROM existing) AS old_admission_target,
             (SELECT identity_match FROM existing)   AS identity_match
    ), repo_lock AS MATERIALIZED (
      -- 954 lockedge：以 stage 为**驱动行来源**（SELECT 携带 s.ledger_exists），强制先完成账阶段
      -- （existing 的 FOR UPDATE）再对 storage_repositories 取 FOR UPDATE；stage 列被实际消费，非可裁剪空侧 cross join。
      SELECT s.ledger_exists AS ledger_exists, r.id AS repo_id
      FROM stage s
      JOIN storage_repositories r
        ON r.id = ${repoId} AND r.branch = ${branch}
       AND r.enabled AND r.is_private AND NOT r.read_only AND r.sealed_at IS NULL
      FOR UPDATE OF r
    ), gate AS MATERIALIZED (
      -- 954 A/lockedge：left join 保住“仓缺失仍一行”；gate 行来源同时引用 stage 与 repo_lock → 必待仓锁完成，
      -- 之后才在投影中取 clock_timestamp() 与活动统计（二者在 FROM 之后求值，不提前计算）。
      SELECT s.ledger_exists, s.existing_state, s.identity_match,
             s.old_target_bytes, s.old_admission_target,
             (rl.repo_id IS NOT NULL)      AS repo_ok,
             ${inputActiveEmpty}::boolean  AS input_active_empty,
             (SELECT count(*)::int FROM artifact_capacity_reservations r
               WHERE r.repository_id = ${repoId} AND r.branch = ${branch}
                 AND r.state IN ('reserved','uncertain')) AS db_active_n,
             ${activationGranted}::boolean  AS activation_granted,
             ${activationTargetOk}::boolean AS activation_target_ok,
             -- 954 B：两次插值各自显式定型 timestamptz；空值亦可被 SQL 解析。期限以锁后 clock_timestamp() 求值。
             (${admissionValidUntil}::timestamptz IS NOT NULL
                AND ${admissionValidUntil}::timestamptz > clock_timestamp()) AS admission_time_ok,
             ${activationReject}::text     AS activation_reject
      FROM stage s LEFT JOIN repo_lock rl ON true
    ), ledger_update AS MATERIALIZED (
      UPDATE repository_capacity_ledger l
         SET state = 'ready',
             target_bytes = ${targetBytes}::bigint,
             registered_bytes = ${registeredBytes}::bigint,
             reserved_bytes = 0,
             baseline_epoch = ${fingerprint},
             admission_status = 'granted',
             admission_version = ${admissionVersion},
             admission_valid_until = ${admissionValidUntil}::timestamptz,
             admission_target = jsonb_build_object('repositoryId', ${repoId}::int, 'branch', ${branch}::text),
             updated_at = now()
       FROM gate g
      WHERE l.repository_id = ${repoId}
        AND g.ledger_exists AND g.existing_state = 'uninitialized' AND g.identity_match
        AND g.old_target_bytes = ${targetBytes}::bigint
        AND (g.old_admission_target IS NULL
             OR g.old_admission_target = jsonb_build_object('repositoryId', ${repoId}::int, 'branch', ${branch}::text))
        AND g.repo_ok
        AND g.input_active_empty AND g.db_active_n = 0
        AND g.activation_granted AND g.activation_target_ok AND g.admission_time_ok
      RETURNING l.repository_id
    ), ledger_insert AS MATERIALIZED (
      INSERT INTO repository_capacity_ledger
        (repository_id, state, target_bytes, registered_bytes, reserved_bytes, baseline_epoch,
         admission_status, admission_version, admission_valid_until, admission_target, updated_at)
      SELECT ${repoId}, 'ready', ${targetBytes}::bigint, ${registeredBytes}::bigint, 0, ${fingerprint},
             'granted', ${admissionVersion}, ${admissionValidUntil}::timestamptz,
             jsonb_build_object('repositoryId', ${repoId}::int, 'branch', ${branch}::text), now()
      FROM gate g
      WHERE NOT g.ledger_exists AND g.repo_ok
        AND g.input_active_empty AND g.db_active_n = 0
        AND g.activation_granted AND g.activation_target_ok AND g.admission_time_ok
      RETURNING repository_id
    ), proof AS MATERIALIZED (
      SELECT
        (SELECT repo_ok FROM gate)                 AS repo_ok,
        (SELECT ledger_exists FROM gate)           AS ledger_exists,
        (SELECT existing_state FROM gate)          AS existing_state,
        (SELECT identity_match FROM gate)          AS identity_match,
        (SELECT old_target_bytes FROM gate)        AS old_target_bytes,
        (SELECT old_admission_target FROM gate)    AS old_admission_target,
        (SELECT input_active_empty FROM gate)      AS input_active_empty,
        (SELECT db_active_n FROM gate)             AS db_active_n,
        (SELECT activation_granted FROM gate)      AS activation_granted,
        (SELECT activation_target_ok FROM gate)    AS activation_target_ok,
        (SELECT admission_time_ok FROM gate)       AS admission_time_ok,
        (SELECT activation_reject FROM gate)       AS activation_reject,
        (SELECT count(*)::int FROM ledger_update)  AS update_ok,
        (SELECT count(*)::int FROM ledger_insert)  AS insert_ok
    ), verdict AS MATERIALIZED (
      SELECT proof.*, (update_ok + insert_ok) AS writes_ok, CASE
        -- 首次激活（账不存在）：活动 → 当前准入/屏障 → 仓可写 → 条件写。
        WHEN NOT ledger_exists THEN
          CASE WHEN NOT input_active_empty OR db_active_n > 0 THEN 'active_reservations_present'
               WHEN NOT (activation_granted AND activation_target_ok AND admission_time_ok) THEN
                    (CASE WHEN activation_granted THEN 'admission_invalid' ELSE activation_reject END)
               WHEN NOT repo_ok THEN 'repository_not_writable'
               WHEN (update_ok + insert_ok) = 1 THEN 'initialized'
               ELSE NULL END
        -- F4：ready 分支只比不可变原始身份，先于仓可写/准入/屏障/活动，零写、不续准入。
        WHEN existing_state = 'ready' AND identity_match THEN 'already_initialized'
        WHEN existing_state = 'ready' THEN 'binding_conflict'
        -- F2：uninitialized 须核旧 target/既有目标绑定；不符即 binding_conflict，不放宽。
        WHEN existing_state = 'uninitialized' AND identity_match
             AND old_target_bytes = ${targetBytes}::bigint
             AND (old_admission_target IS NULL
                  OR old_admission_target = jsonb_build_object('repositoryId', ${repoId}::int, 'branch', ${branch}::text)) THEN
          CASE WHEN NOT input_active_empty OR db_active_n > 0 THEN 'active_reservations_present'
               WHEN NOT (activation_granted AND activation_target_ok AND admission_time_ok) THEN
                    (CASE WHEN activation_granted THEN 'admission_invalid' ELSE activation_reject END)
               WHEN NOT repo_ok THEN 'repository_not_writable'
               WHEN (update_ok + insert_ok) = 1 THEN 'initialized'
               ELSE NULL END
        WHEN existing_state = 'uninitialized' THEN 'binding_conflict'
        ELSE NULL END AS status
      FROM proof
    ), final AS MATERIALIZED (
      -- F6：SQL 内独立不变量。initialized 必须恰一次合法分支写；其余状态写零行；未知 status 回滚。
      SELECT verdict.*, CASE
        WHEN status IS NULL THEN false
        WHEN status = 'initialized' THEN
          (CASE WHEN ledger_exists THEN (update_ok = 1 AND insert_ok = 0)
                ELSE (insert_ok = 1 AND update_ok = 0) END)
        ELSE (update_ok = 0 AND insert_ok = 0)
        END AS write_invariant_ok
      FROM verdict
    )
    SELECT final.*, 1 / CASE WHEN write_invariant_ok THEN 1 ELSE 0 END AS atomic_ok FROM final
    `,
  ], CAPACITY_REQUIRED_ISOLATION);

  const rows = batchBody(results);
  const row = rows[0];
  const status = row?.status;
  if (rows.length !== 1 || !row || typeof status !== 'string'
    || !SQL_STATUSES.has(status) || !equalsCount(row.atomic_ok, 1)) {
    throw new ArtifactCapacityError('CAPACITY_INVALID_RESULT');
  }
  return { status } as ReconcileResult;
}

// ---------------------------------------------------------------------------
// 入口：受控端口消费 + 私有期望快照 + 原始身份/目标核验 + 进入屏障事务
// ---------------------------------------------------------------------------

/**
 * 首次激活 / ready 幂等入口。**不自填验证**：值只来自受控 `source`。
 * 私有请求快照（requestTarget/requestRaw）留在本闭包，交给端口的是**独立且运行时冻结**的副本（F5）；
 * 核对与 SQL 只消费私有快照。原始身份无效或与目标/原始引用不符 ⇒ 拒绝，不进入 SQL（零写）。
 * 当前许可可明确拒绝，只作首次激活输入（F4）；端口缺失/输入非法 ⇒ 抛错。SQL 异常**原样抛出**，不映射、不重试。
 */
export async function reconcileInitialization(
  sql: CapacitySql,
  source: ReconciliationSource | null | undefined,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  requireBatchPort(sql);
  requireSource(source);
  if (input == null || input.target == null || input.raw == null) {
    throw new ArtifactCapacityError('INVALID_CAPACITY_INPUT', 'missing reconciliation input');
  }
  // 私有期望快照：只在本闭包内，永不外泄给端口。
  const requestTarget = Object.freeze(cloneTarget(input.target));
  const requestRaw = Object.freeze(cloneRaw(input.raw));
  validateTarget(requestTarget);
  validateRaw(requestRaw);

  // 交给端口的是**独立**副本并运行时冻结：端口持有的可变对象无法改变 SQL 身份/金额或核对基线。
  const portInput = Object.freeze({
    target: Object.freeze(cloneTarget(requestTarget)),
    raw: Object.freeze(cloneRaw(requestRaw)),
  });

  return source.reconcile(portInput, async (originalVerdict, activation) => {
    if (originalVerdict == null || originalVerdict.status === 'no_authoritative_source') {
      return { status: 'no_authoritative_source' } satisfies ReconcileResult;
    }
    if (originalVerdict.status === 'incomplete_occupancy') {
      return { status: 'incomplete_occupancy' } satisfies ReconcileResult;
    }
    if (originalVerdict.status !== 'verified') {
      return { status: 'no_authoritative_source' } satisfies ReconcileResult;
    }
    const original = freezeOriginal(originalVerdict.original);
    validateOriginal(original);
    // 目标绑定：原始身份须绑定**私有请求快照**的目标与引用（不接受端口对共享对象的漂移）。
    if (!sameTarget({ repositoryId: original.repositoryId, branch: original.branch }, requestTarget)
      || original.reconciliationVersion !== requestRaw.reconciliationVersion
      || original.barrierRef !== requestRaw.barrierRef) {
      return { status: 'binding_conflict' } satisfies ReconcileResult;
    }
    const act = normalizeActivation(activation);
    // 当前许可目标错绑/非法：不再入口直接拒绝，转交 SQL 作**首次激活**拒绝输入（F4）。
    return runReconcileTransaction(sql, requestTarget, original, act);
  });
}
