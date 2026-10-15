// capacity985：repository-rollover 决策的发布路径接线（首次真实消费点）。
//
// 边界（rollover 模块头注释冻结，本模块遵守）：
// - 决策在 reserveArtifactPath 之前、且在构造本次 GitHubContents 与确定 repositoryId/branch
//   之前被消费（不能只换 DB id 而继续用旧仓闭包）。
// - 端口注入：容量对账与外部准入证据获取函数由调用方注入，本模块不直连 DB/网络/环境/时钟。
// - 只做选择：stay/switch 返回「本次发布应使用的仓元组 + 闭包工厂入参」，创建/迁移/预留仍归
//   发布器既有逻辑（reserveArtifactPath / reserveCapacityAndPath）。
// - blocked / reuse / 决策异常一律上抛或原样透传，不静默降级回旧仓。
//
// 数据流：当前仓元组（entry 装配时的 storage 目标）+ 本次 logicalBytes → 端口取候选仓证据
// （注册表 + 容量账 + 外部准入，全部按仓绑定）→ planRepositoryRollover 纯决策 →
// { kind: 'stay' } 沿用原闭包原元组；{ kind: 'switch' } 换整闭包（新 GitHubContents 工厂入参
// owner/repo/branch + 新 repositoryId/branch），调用方据 needsClosureRebuild 重建，不是改 id。

import {
  planRepositoryRollover,
  type ExistingBinding,
  type RepositoryCandidate,
  type RepositoryTuple,
} from './repository-rollover';

/** 候选仓证据端口：调用方用既有 repository 注册查询 + 容量对账 + 外部准入实现。 */
export interface RolloverEvidencePort {
  /** 有序候选（优先序即数组顺序）：来自 storage_repositories 既有注册查询。 */
  listCandidates(): Promise<readonly RepositoryCandidate[]>;
  /** 显式时钟；不读真实时间（与纯决策同一红线）。 */
  now(): Date;
}

export interface RolloverWiringInput {
  /** 当前仓元组（本次任务开始前的发布目标）。 */
  current: RepositoryTuple;
  labeledBookId: number;
  /** 完整内容身份（artifactIdentityKey 全量 hash），不截断。 */
  identityKey: string;
  /** 完整内容 git blob sha40。 */
  blobSha: string;
  canonicalPath: string;
  /** 本次新 artifact 的逻辑字节数（十进制，非 1GiB 倍数换算）。 */
  logicalBytes: bigint;
  /** 既有绑定（可信、已 published）；缺失时省略，交给决策判定。 */
  existingBinding?: ExistingBinding;
  /**
   * 同书既有 artifact 落位（identity_key 唯一约束下的旧行）：命中且行 canonicalPath 与本次
   * 一致时，把决策 current 重定向到旧行的仓——reserveArtifactPath 的 ON CONFLICT 只在四字段
   * 与旧行一致时放行幂等更新，缺省 current（切仓后的装配仓）会撞 identity 冲突。旧仓不可写
   * （sealed/read_only/disabled/不在候选）时不重定向，维持缺省 current 走既有决策与失败路径。
   */
  existingArtifactBinding?: { repositoryId: number; branch: string; canonicalPath: string };
}

export interface RolloverStayOutcome {
  kind: 'stay';
  /** 决策仓元组：正常沿用输入 current 原引用；既有 artifact 绑定重定向时为旧行的仓。 */
  target: RepositoryTuple;
  /** 决策所依据的账目快照版本（供预留层核对，stale 即拒）。 */
  snapshotVersion: string;
  logicalBytesToReserve: bigint;
  /** true 仅当 current 被既有 artifact 绑定重定向（≠装配闭包，须重建 GitHubContents）。 */
  needsClosureRebuild: boolean;
}

export interface RolloverSwitchOutcome {
  kind: 'switch';
  /** 新仓元组：后续 reserve/publish 必须整体重建 GitHubContents 与 repositoryId/branch。 */
  target: RepositoryTuple;
  snapshotVersion: string;
  logicalBytesToReserve: bigint;
  needsClosureRebuild: true;
}

export type RolloverWiringOutcome = RolloverStayOutcome | RolloverSwitchOutcome;

/** blocked / reuse / 决策输入错误统一以错误上抛：不静默降级回旧仓（既有失败路径不放宽）。 */
export class RolloverWiringBlockedError extends Error {
  readonly code = 'ROLLOVER_WIRING_BLOCKED';
  constructor(
    readonly reason: 'NO_ELIGIBLE_REPOSITORY' | 'CAPACITY_UNKNOWN' | 'EXISTING_BINDING_REQUIRES_RECONCILIATION' | 'REUSE_NOT_SUPPORTED_HERE',
    detail?: string,
  ) {
    super(detail ? `ROLLOVER_WIRING_BLOCKED:${reason}:${detail}` : `ROLLOVER_WIRING_BLOCKED:${reason}`);
    this.name = 'RolloverWiringBlockedError';
  }
}

export class RolloverWiringEvidenceError extends Error {
  readonly code = 'ROLLOVER_WIRING_EVIDENCE_UNAVAILABLE';
  constructor(detail?: string) {
    super(detail ? `ROLLOVER_WIRING_EVIDENCE_UNAVAILABLE:${detail}` : 'ROLLOVER_WIRING_EVIDENCE_UNAVAILABLE');
    this.name = 'RolloverWiringEvidenceError';
  }
}

/** 仓同一性：与纯决策 tupleMatches 同判据——id 相等、owner/repo 忽略大小写、branch 精确。 */
const sameRepository = (a: RepositoryTuple, b: RepositoryTuple): boolean =>
  a.id === b.id
    && a.owner.toLowerCase() === b.owner.toLowerCase()
    && a.repo.toLowerCase() === b.repo.toLowerCase()
    && a.branch === b.branch;

/**
 * 发布路径消费点（在 reserveArtifactPath 之前调用）：
 * 调 planRepositoryRollover 得 stay/switch 计划。switch 时返回新仓元组并置
 * needsClosureRebuild=true —— 调用方必须用 target.owner/repo/branch 重建 GitHubContents、
 * 用 target.id/target.branch 作 repositoryId/branch，换整闭包而非只换 DB id。
 * reuse（同内容已发布、零增量）在发布路径属于「不应走到这里」的对账态：发布前已有
 * reserveArtifactPath 的同身份幂等；故显式转 blocked 上抛，不静默跳过发布。
 */
export async function decideRepositoryForPublication(
  port: RolloverEvidencePort,
  input: RolloverWiringInput,
): Promise<RolloverWiringOutcome> {
  let candidates: readonly RepositoryCandidate[];
  let now: Date;
  try {
    [candidates, now] = [await port.listCandidates(), port.now()];
  } catch (error) {
    // 证据端口故障 = 容量未知：维持既有失败路径（上抛），不退化为「照旧写旧仓」。
    throw new RolloverWiringEvidenceError((error as Error)?.message?.slice(0, 120));
  }
  // 既有 artifact 落位优先（清污换源重下）：identity_key 唯一约束已把这本书的落位钉在旧行，
  // 同仓落位 = reserveArtifactPath 幂等更新；canonicalPath 不一致属对账异常，不重定向。
  let decisionCurrent = input.current;
  let redirected = false;
  if (input.existingArtifactBinding) {
    const binding = input.existingArtifactBinding;
    const match = binding.canonicalPath === input.canonicalPath
      ? candidates.find(candidate => candidate.id === binding.repositoryId
        && candidate.branch === binding.branch
        && candidate.enabled && !candidate.readOnly && !candidate.sealed)
      : undefined;
    if (match) {
      decisionCurrent = { id: match.id, owner: match.owner, repo: match.repo, branch: match.branch };
      redirected = true;
    }
  }
  let plan;
  try {
    plan = planRepositoryRollover({
      labeledBookId: input.labeledBookId,
      identityKey: input.identityKey,
      blobSha: input.blobSha,
      canonicalPath: input.canonicalPath,
      logicalBytes: input.logicalBytes,
      currentRepositoryId: decisionCurrent.id,
      candidates,
      existingBinding: input.existingBinding,
      now,
    });
  } catch (error) {
    // 纯决策输入错误（含端口返回的坏证据）：同一失败路径，不降级。
    const code = (error as { code?: string })?.code ?? 'INVALID_INPUT';
    throw new RolloverWiringBlockedError('CAPACITY_UNKNOWN', code);
  }
  if (plan.kind === 'stay') {
    // 同一性按 tupleMatches 判据核对（注册表大小写可以不同）；stay 回传**决策 current 原引用**，
    // 不把候选的大小写变体带出去重建闭包——正常路径闭包引用不变，调用方零重建；
    // 既有 artifact 绑定重定向时 target ≠ 装配闭包，置 needsClosureRebuild=true 交调用方重建。
    if (!sameRepository(plan.target, decisionCurrent)) {
      throw new RolloverWiringBlockedError('CAPACITY_UNKNOWN', 'stay target drifted from current');
    }
    return {
      kind: 'stay', target: decisionCurrent, snapshotVersion: plan.snapshotVersion,
      logicalBytesToReserve: plan.logicalBytesToReserve, needsClosureRebuild: redirected,
    };
  }
  if (plan.kind === 'switch') {
    // 换整闭包：新仓元组必然不同于当前（纯决策保证 current 不 eligible 才 switch）。
    if (sameRepository(plan.target, input.current)) {
      throw new RolloverWiringBlockedError('CAPACITY_UNKNOWN', 'switch target equals current');
    }
    return {
      kind: 'switch', target: plan.target, snapshotVersion: plan.snapshotVersion,
      logicalBytesToReserve: plan.logicalBytesToReserve, needsClosureRebuild: true,
    };
  }
  if (plan.kind === 'reuse') {
    throw new RolloverWiringBlockedError('REUSE_NOT_SUPPORTED_HERE');
  }
  throw new RolloverWiringBlockedError(plan.reason);
}
