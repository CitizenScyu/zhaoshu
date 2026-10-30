// T3：下载执行器任务层（单写者循环：领取 → 心跳 → adapter 抓取 → 五阶段发布 → DB 终态）。
//
// 从 zhaoshu-books/worker.mjs 提取，按设计 §B.2/§B.3/§B.4/§D-T3 改造：
// - 租约：claimDownloadTask（T1 v7 lease_generation fencing）；所有任务状态写
//   （心跳/进度/终态）都带 generation+owner 条件，失租约 → LeaseLostError → 停止，不复活。
// - 单写者：同一任务只有一个 running 租约；发布器每阶段写前 guard.check()。
// - 发布对账：五阶段 = 快照/manifest/规范/指针（download-publisher）+ DB 登记（本模块）。
//   partial/failed 候选零发布（只返回未晋升候选时也零规范/指针写入）。
// - adapter 接缝：SourceAdapter 抽象——book15 builtin 与引擎源两条腿（引擎腿调
//   scripts/engine-download.mjs 的 downloadBook，进程内 adapter 形态，参数数组调用）。
// - 运行不做 DDL：schema 由专用迁移负责；本模块只 DML。
//
// 测试注入 PGlite + mock GitHubContents + mock transport，不真实联网、不连生产。

import { createHash } from 'node:crypto';
import type { DownloadTaskLease } from './download-task-queue';
import {
  HOST_WAIT_DELAY_MS, HOST_WAIT_MAX_FREE_CLAIMS, PUBLICATION_RETRY_MAX_ATTEMPTS, SOURCE_RETRY_MAX_ATTEMPTS,
  sourceRetryDelayMs, type SourceRetryClass,
} from './download-task-policy';
import {
  gitBlobSha, isRetryablePublicationError, LeaseLostError, publishBookVersion, PublicationStageError, snapshotPaths,
  type GitHubContents, type PublishOutcome,
} from './download-publisher';
import { artifactIdentityKey } from './artifact-registry';
import type { TxtChapter } from './txt-chapters';
// capacity986：发布期切仓决策（985 已交付模块，纯决策 + 端口注入，无 DB/网络副作用）。
import { decideRepositoryForPublication, type RolloverEvidencePort } from '../../runtime-download/repository-rollover-wiring';
import type { RepositoryTuple } from '../../runtime-download/repository-rollover';

export { LeaseLostError };

export const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;
export const WORKER_TASK_TIMEOUT_MS = 330 * 60_000;
export const PROGRESS_EVERY = 50;

export interface TaskRow {
  id: number;
  book_id: number;
  title: string;
  author: string;
  status: string;
  source_url: string;
  source_kind: string;
  source_id: string | null;
  requested_by: 'user' | 'system';
  /** rotate1030：第几次尝试（DEFAULT 1，defer +1）。只给选源窗口轮转用；旧调用方/桩可不带。 */
  attempt_count?: number;
}

export type AdapterOutcome =
  | {
      kind: 'complete'; txt: string; chaptersTotal: number; chaptersDone: number; charsTotal: number;
      /** 引擎章节边界（txt 的 UTF-8 字节偏移，首尾相接铺满全书）；给了发布器就不再按标题二次解析。 */
      chapterRanges?: TxtChapter[];
    }
  // stage：source_unavailable 时判定所在阶段（resolve/search/detail/toc），只作日志用的固定枚举。
  | { kind: 'incomplete'; reason: string; chaptersTotal: number; chaptersDone: number; charsTotal: number; stage?: string; retryCause?: 'host_occupied' | 'host_occupancy_unavailable' | 'host_breaker' | 'recheck_unavailable' }
  | { kind: 'failure'; code: string; /** 脱敏诊断类别（Error 构造器名，如 TypeError；diag1030 起可带 /固定码 与 @阶段）——download_failed 兜底时定位速败结构用。 */ detail?: string };

export interface SourceAdapterContext {
  /** 任务层提供的租约信号：adapter 中断后应立即停止抓取。 */
  signal: AbortSignal;
  /** 进度回调：转写为租约条件的心跳/进度 SQL。抛错立即中断。 */
  progress(update: { chaptersDone: number; chaptersTotal: number; charsTotal: number }): Promise<void>;
  /** 仅记录反馈错误原引用；任务层提供无 I/O 的回调。 */
  onFeedbackFailure?(error: unknown): void;
}

export interface SourceAdapter {
  /** 稳定源标识（任务 source_kind/source_id 之外的运行形态区分），仅用于日志与对账。 */
  readonly kind: 'builtin' | 'engine';
  download(task: TaskRow, context: SourceAdapterContext): Promise<AdapterOutcome>;
}

export type ArtifactRegistrationResult = 'registered' | 'already' | 'lost' | 'mismatch';

export interface WorkerStorage {
  /** 领取一个 pending 任务（含 v7 租约递增）。返回 null 表示队列空。 */
  claim(owner: string): Promise<DownloadTaskLease | null>;
  /** 读取被领取任务的完整行。 */
  taskRow(id: number): Promise<TaskRow | null>;
  /** 心跳（租约条件）；false = 失租约。 */
  heartbeat(lease: DownloadTaskLease): Promise<boolean>;
  /** 进度（租约条件）；false = 失租约。 */
  progress(lease: DownloadTaskLease, update: { chaptersDone: number; chaptersTotal: number; charsTotal: number }): Promise<boolean>;
  /** 终态（租约条件）；false = 失租约。 */
  finish(lease: DownloadTaskLease, result: { status: 'done' | 'failed' | 'partial' | 'superseded_by_incomplete'; error?: string }): Promise<boolean>;
  /** 非终态放回 pending 并退避（租约条件）；返回下次可领取时刻（ISO UTC），null = 失租约。countAttempt=false 不计 attempt（hostwait1031）。 */
  defer(lease: DownloadTaskLease, input: { delayMs: number; error?: string; countAttempt?: boolean }): Promise<string | null>;
  /** 原样放回 pending（租约条件，不动 attempt_count/next_attempt_at）；false = 失租约。可选：缺省时停机放回不生效。 */
  releaseClaim?(lease: DownloadTaskLease): Promise<boolean>;
  /** T2 发布对账的 DB 前置：写前登记路径声明。 */
  reserveArtifactPath(input: { labeledBookId: number; identityKey: string; repositoryId: number; branch: string; canonicalPath: string }): Promise<number>;
  /** 查同书既有 artifact 落位（identity_key 唯一）：换源重下时发布决策回旧行的仓。 */
  findArtifactBinding(input: { identityKey: string; labeledBookId: number }): Promise<{ repositoryId: number; branch: string; canonicalPath: string } | null>;
  /** DB 阶段收口：登记已发布产物并把任务指向 artifact_id。 */
  registerArtifact(lease: DownloadTaskLease, input: {
    artifactId: number; version: string; blobSha: string; bytes: number;
    chaptersTotal: number; chaptersDone: number; charsTotal: number; sourceRevision: string;
    snapshotPath: string;
  }): Promise<ArtifactRegistrationResult>;
}

/** PG 严格 text 禁 \x00 与孤立代理对（zhaoshu-books cleanPgText 同形）。 */
export function cleanPgText(value: string): string {
  return String(value ?? '')
    .replace(/\x00/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '\u{fffd}')
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\u{fffd}');
}

export class TaskLeaseLostError extends Error {
  readonly code = 'TASK_LEASE_LOST';
  constructor() {
    super('download task lease lost; worker stops without terminal write');
    this.name = 'TaskLeaseLostError';
  }
}

/** 泛化为「失权停止」：发布器 LeaseLostError 与任务层 TaskLeaseLostError 共用这一个判据。 */
export function isLeaseLostError(error: unknown): boolean {
  return error instanceof LeaseLostError || error instanceof TaskLeaseLostError;
}

/** 任务预算耗尽的归一判据：worker 侧定时器与引擎侧定时器共用 `budget_exhausted` 字面量。 */
export function isBudgetExhausted(error: unknown): boolean {
  return error instanceof Error && error.message === 'budget_exhausted';
}

function hostGateCauseOf(error: unknown): 'host_occupied' | 'host_occupancy_unavailable' | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'HOST_OCCUPIED') return 'host_occupied';
  if (code === 'HOST_OCCUPANCY_UNAVAILABLE') return 'host_occupancy_unavailable';
  return undefined;
}

/**
 * 写终态前的 abort 守卫。
 * `taskTimer` 以 `budget_exhausted` abort 合成 signal 后，adapter 已把结果归一为 incomplete；
 * 若此处无条件 `throwIfAborted()`，partial 写入被跳过、外层 catch 落 failed，与预算归一目标矛盾。
 * 预算耗尽仍持有租约，按 adapter 已分类结果收口；失权（心跳 abort 的 TaskLeaseLostError）必须抛、不得写终态。
 */
function throwIfAbortedUnlessBudget(signal: AbortSignal): void {
  if (!isBudgetExhausted(signal.reason)) signal.throwIfAborted();
}

/**
 * 心跳定时器（zhaoshu-books task-heartbeat 的 v7 化形态）：
 * 每 60s 一次租约条件心跳；连续失败置 signal，抓取/发布链路立即停。
 */
export function startLeaseHeartbeat(storage: WorkerStorage, lease: DownloadTaskLease, intervalMs = WORKER_HEARTBEAT_INTERVAL_MS) {
  const controller = new AbortController();
  let stopped = false;
  let pending: Promise<void> | null = null;
  const pulse = async () => {
    if (controller.signal.aborted) return;
    if (stopped) return;
    if (pending) return pending;
    pending = (async () => {
      const alive = await storage.heartbeat(lease);
      if (!alive) throw new TaskLeaseLostError();
    })().catch(error => {
      if (error instanceof TaskLeaseLostError) controller.abort(error);
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void pulse().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    check: pulse,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending?.catch(() => {});
    },
  };
}

export interface WorkerOptions {
  storage: WorkerStorage;
  github: GitHubContents;
  adapters: SourceAdapter[];
  /** 任务总预算（默认 330 分钟）。 */
  taskTimeoutMs?: number;
  /** 供发布对账的 DB 侧目标仓（T2 registry）。 */
  repositoryId: number;
  branch: string;
  /**
   * capacity986 切仓决策消费缝：缺省（undefined）= 不决策，发布行为与引入前逐字一致。
   * 注入后在 reserveArtifactPath 之前调用 decideRepositoryForPublication：
   * stay 沿用装配期闭包/repositoryId/branch 原引用（零行为变化）；switch 用 target 整体换闭包
   * （rebuildGitHubContents 重建 GitHubContents + target.id/target.branch，非只换 DB id）；
   * blocked / 证据端口故障按既有失败路径上抛，不静默降级回旧仓。
   * 装配期常量只读：本字段与 options.github/repositoryId/branch 在任务执行中永不被改写。
   */
  rollover?: PublicationRolloverSeam;
  /**
   * shutrel1030 停机放回缝：缺省 = 不注入 = 与引入前逐字一致（停机只停领新任务，在途下载跑到
   * systemd TimeoutStopSec 被 SIGKILL，租约要等回收器 30min+ 后才 +1 退避重排）。
   * 注入后只并进下载腿的 signal：停机时抓取立即中止（检查点已落盘），未拿到整本则 releaseClaim
   * 原样放回 pending、不写终态（中止产出的 interrupted 不能落 partial）；已拿到整本照常发布。
   * 发布阶段和终态守卫仍只看任务 signal，停机不打断发布。
   */
  shutdownSignal?: AbortSignal;
  /**
   * hostwait1031：true 时 adapter 回 source_unavailable + retryCause host_occupied（候选 host 全被别的任务
   * 占着）按排队放回：不计 attempt、间隔 HOST_WAIT_DELAY_MS，不计数领取达 HOST_WAIT_MAX_FREE_CLAIMS 后回到
   * 计数路径。缺省关 = 与引入前逐字一致。releaseClaim（停机/日预算满）同样只涨 lease_generation，也占这份
   * 额度——只会更早回到旧行为，不会放宽上界。
   * breakeryield1031：retryCause host_breaker（本机限速器对该 host 熔断中，见 engine-download breakerYield）
   * 同走此路——熔断 30min 自动恢复，间隔 HOST_WAIT_DELAY_MS（=30min）正好错开。
   */
  hostWait?: boolean;
}

/** 切仓决策注入缝：端口（候选仓证据 + 显式时钟）与闭包重建工厂均由调用方（entry/测试）注入。 */
export interface PublicationRolloverSeam {
  port: RolloverEvidencePort;
  /** 装配期当前仓元组（entry 的 storage 目标 + resolveRepositoryId 结果）。 */
  current: RepositoryTuple;
  /** switch 时按新仓元组重建发布闭包（生产 = createGitHubContents；凭据留在调用方，不进本模块）。 */
  rebuildGitHubContents(target: RepositoryTuple): GitHubContents;
}

export interface WorkerResult {
  /** 领取并处理了一个任务（true）还是队列空/失租约停止（false）。 */
  processed: boolean;
  terminal?: 'done' | 'failed' | 'partial' | 'superseded_by_incomplete';
  reason?: string;
  /** source_unavailable 专用（供执行器打结构化日志）：判定阶段、源 host；retryAt 另用于 publication_retry：下次可重试时刻（null = 已封顶转终态）。 */
  stage?: string;
  sourceHost?: string;
  retryAt?: string | null;
  /** hostwait1031：本次放回是 host 排队（不计 attempt）。 */
  hostWait?: true;
  feedback?: {
    code: 'LIMITER_FEEDBACK_UNAVAILABLE';
    origin: 'limiter-feedback';
    persistenceOutcome: 'unknown';
    budgetExhausted: boolean;
    settlement: 'acknowledged' | 'lost' | 'unknown';
  };
}

const workerFeedbackErrors = new WeakMap<WorkerResult, unknown>();

/** 原异常仅供受控内存诊断，调用方不得将返回值写入日志或持久化。 */
export function getWorkerFeedbackError(result: WorkerResult): unknown {
  return workerFeedbackErrors.get(result);
}

function isFeedbackFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; origin?: unknown };
  return value.code === 'LIMITER_FEEDBACK_UNAVAILABLE' && value.origin === 'limiter-feedback';
}

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

/**
 * 书源不可达（source_unavailable）的统一收口：下载腿（runDownloadTask）与执行器扣额度前预检共用。
 * 未达上限 ⇒ 租约条件放回 pending，按 attempt_count 退避；达上限 ⇒ partial 终态；失租约 ⇒ TaskLeaseLostError。
 * 返回下次可重试时刻（ISO UTC），null = 已封顶转终态。
 *
 * retryClass 选退避曲线（nocand42）：no_candidates = 全池实探后这本书一个候选都没有，扫描的恢复
 * 周期以天计，走 1h/2h/4h 长曲线；transient（默认）= 源/网络正忙、池读不到、预算尽，快速重试才捞得回。
 * 上限 SOURCE_RETRY_MAX_ATTEMPTS 两条曲线共用，退避总量依旧有界。
 */
export async function settleSourceUnavailable(
  storage: Pick<WorkerStorage, 'defer' | 'finish'>,
  lease: DownloadTaskLease,
  stage: string,
  retryClass: SourceRetryClass = 'transient',
): Promise<{ retryAt: string | null }> {
  const code: 'no_candidates' | 'source_unavailable' = retryClass === 'no_candidates' ? 'no_candidates' : 'source_unavailable';
  if (lease.attemptCount < SOURCE_RETRY_MAX_ATTEMPTS) {
    const retryAt = await storage.defer(lease, {
      delayMs: sourceRetryDelayMs(lease.attemptCount, retryClass),
      error: `源不可用（${stage} 阶段，第 ${lease.attemptCount} 次）：${code}，自动退避重试`,
    });
    if (!retryAt) throw new TaskLeaseLostError();
    return { retryAt };
  }
  const written = await storage.finish(lease, {
    status: 'partial',
    error: `源不可用（${stage} 阶段，已连续 ${lease.attemptCount} 次，停止自动重试）：${code}`,
  });
  if (!written) throw new TaskLeaseLostError();
  return { retryAt: null };
}

/**
 * B2-03:发布可重试失败(isRetryablePublicationError)的统一收口,与 settleSourceUnavailable 同一机制:
 * 未达上限 ⇒ 租约条件放回 pending,按 attempt_count 退避,claim 到期重领后整条链路重跑
 * (快照卷内容寻址幂等重写、规范卷按 sha 跳过已就位卷、最后补写 index.json ⇒ 半新半旧自愈);
 * 达上限 ⇒ failed 终态;失租约 ⇒ TaskLeaseLostError(行已归接管者,不写)。
 */
export async function settlePublicationFailure(
  storage: Pick<WorkerStorage, 'defer' | 'finish'>,
  lease: DownloadTaskLease,
  error: PublicationStageError,
): Promise<{ retryAt: string | null }> {
  const cause = `${error.stage}:${error.detail}`;
  if (lease.attemptCount < PUBLICATION_RETRY_MAX_ATTEMPTS) {
    const retryAt = await storage.defer(lease, {
      delayMs: sourceRetryDelayMs(lease.attemptCount),
      error: cleanPgText(`发布失败（${cause}，第 ${lease.attemptCount} 次）：自动退避重试`),
    });
    if (!retryAt) throw new TaskLeaseLostError();
    return { retryAt };
  }
  const written = await storage.finish(lease, {
    status: 'failed',
    error: cleanPgText(`发布失败（${cause}，已连续 ${lease.attemptCount} 次，停止自动重试）`),
  });
  if (!written) throw new TaskLeaseLostError();
  return { retryAt: null };
}

function selectAdapter(adapters: SourceAdapter[], task: TaskRow): SourceAdapter {
  // 引擎腿按任务 source_kind 显式选择；builtin 兜底两条腿都存在时的默认。
  const wanted = task.source_kind === 'engine' ? 'engine' : 'builtin';
  return adapters.find(adapter => adapter.kind === wanted) ?? adapters[0];
}

/** 单任务执行：领取（已由调用方完成）→ adapter → 五阶段发布 → DB 终态。 */
export async function runDownloadTask(
  options: WorkerOptions,
  lease: DownloadTaskLease,
): Promise<WorkerResult> {
  const { storage, github, repositoryId, branch } = options;
  const task = await storage.taskRow(lease.id);
  if (!task) throw new Error('claimed task row missing');
  if (task.status !== 'running') {
    // 领取语句与行读取之间被回收/终态化：停止，不写任何状态。
    return { processed: false, reason: 'task_not_running_after_claim' };
  }

  const heartbeat = startLeaseHeartbeat(storage, lease);
  const taskDeadline = new AbortController();
  // 预算耗尽的 reason 用引擎已知码 `budget_exhausted`（不是带空格的描述串）：下载器 knownError
  // 会把它归入 incomplete（检查点可续传），而不是当源站失败写 failed 终态。
  const taskTimer = setTimeout(() => taskDeadline.abort(new Error('budget_exhausted')), options.taskTimeoutMs ?? WORKER_TASK_TIMEOUT_MS);
  const signal = AbortSignal.any([heartbeat.signal, taskDeadline.signal]);
  // shutrel1030：停机信号只并进下载腿（见 WorkerOptions.shutdownSignal）；storage 无 releaseClaim 时不接。
  const shutdown = storage.releaseClaim ? options.shutdownSignal : undefined;
  const legSignal = shutdown ? AbortSignal.any([signal, shutdown]) : signal;
  let inLeg = true;
  // 放回失败（库不可达）不落终态：行仍是本租约的 running，留给回收器，与改前停机同结局。
  const releaseOnShutdown = async (): Promise<WorkerResult> => {
    await heartbeat.stop();
    const released = await storage.releaseClaim!(lease).catch(() => null);
    return { processed: false, reason: released ? 'shutdown_released' : released === false ? 'lease_lost' : 'shutdown_release_failed' };
  };
  let sawProgress = 0;
  let leaseLostObserved = false;
  let feedbackError: unknown;
  let feedbackSettlementStarted = false;
  let feedbackSettlement: Promise<WorkerResult> | undefined;
  const recordFeedbackFailure = (error: unknown) => {
    if (!feedbackSettlementStarted && feedbackError === undefined && isFeedbackFailure(error)) feedbackError = error;
  };
  const settleFeedback = (error?: unknown): Promise<WorkerResult> => {
    if (feedbackSettlement) return feedbackSettlement;
    feedbackSettlementStarted = true;
    const originalFeedback = feedbackError;
    feedbackSettlement = (async () => {
      await heartbeat.stop();
      const resultFor = (settlement: NonNullable<WorkerResult['feedback']>['settlement']): WorkerResult => {
        const result: WorkerResult = {
          processed: settlement !== 'lost',
          reason: settlement === 'lost' ? 'lease_lost' : 'limiter_feedback_unavailable',
          ...(settlement === 'acknowledged' ? { terminal: 'failed' as const } : {}),
          feedback: {
            code: 'LIMITER_FEEDBACK_UNAVAILABLE', origin: 'limiter-feedback', persistenceOutcome: 'unknown',
            budgetExhausted: isBudgetExhausted(error) || isBudgetExhausted(signal.reason) || isBudgetExhausted(taskDeadline.signal.reason),
            settlement,
          },
        };
        workerFeedbackErrors.set(result, originalFeedback);
        return result;
      };
      if (leaseLostObserved || isLeaseLostError(error) || isLeaseLostError(signal.reason) || isLeaseLostError(heartbeat.signal.reason)) {
        return resultFor('lost');
      }
      let written: boolean;
      try {
        written = await storage.finish(lease, { status: 'failed', error: 'limiter_feedback_unavailable' });
      } catch {
        return resultFor('unknown');
      }
      return resultFor(written ? 'acknowledged' : 'lost');
    })();
    return feedbackSettlement;
  };

  try {
    await heartbeat.check();
    const adapter = selectAdapter(options.adapters, task);
    const outcome = await adapter.download(task, {
      signal: legSignal,
      onFeedbackFailure: recordFeedbackFailure,
      async progress(update) {
        // adapter 进度即心跳数据通道：写失败（失租约）立即中断抓取。
        sawProgress = update.chaptersDone;
        const alive = await storage.progress(lease, update);
        if (!alive) {
          leaseLostObserved = true;
          throw new TaskLeaseLostError();
        }
      },
    });
    if (feedbackError !== undefined) return await settleFeedback();
    inLeg = false;
    if (shutdown?.aborted && !signal.aborted && outcome.kind !== 'complete') return await releaseOnShutdown();

    if (outcome.kind === 'incomplete') {
      // partial 零发布：任何 GitHub PUT 都没发生，DB 只写终态。
      await heartbeat.stop();
      throwIfAbortedUnlessBudget(signal);
      if (outcome.reason === 'source_unavailable' || outcome.reason === 'no_candidates') {
        // 书源不可达不是终态：放回 pending，按 attempt_count 退避后由 claim 自动重领（零发布）；
        // 连续 SOURCE_RETRY_MAX_ATTEMPTS 次仍不可达才落 partial 终态。
        // no_candidates = 全池实探后这本书一个候选都没有（nocand42）：走 1h/2h/4h 长曲线，
        // 30 分钟重扫一轮对免费站的收录变化毫无意义，纯空烧出网。
        const stage = outcome.stage ?? 'unknown';
        const sourceHost = hostOf(task.source_url);
        const retryClass: SourceRetryClass = outcome.reason === 'no_candidates' ? 'no_candidates' : 'transient';
        if (options.hostWait && outcome.reason === 'source_unavailable'
          && (outcome.retryCause === 'host_occupied' || outcome.retryCause === 'host_breaker')
          && lease.leaseGeneration - lease.attemptCount < HOST_WAIT_MAX_FREE_CLAIMS) {
          const retryAt = await storage.defer(lease, {
            delayMs: HOST_WAIT_DELAY_MS,
            countAttempt: false,
            error: `源 host 正忙（${stage} 阶段，第 ${lease.attemptCount} 次，不计次）：${outcome.retryCause}，排队重试`,
          });
          if (!retryAt) throw new TaskLeaseLostError();
          return { processed: true, reason: outcome.reason, stage, sourceHost, retryAt, hostWait: true };
        }
        const { retryAt } = await settleSourceUnavailable(storage, lease, stage, retryClass);
        return retryAt
          ? { processed: true, reason: outcome.reason, stage, sourceHost, retryAt }
          : { processed: true, terminal: 'partial', reason: outcome.reason, stage, sourceHost, retryAt: null };
      }
      const detail = `缺章 ${outcome.chaptersDone}/${outcome.chaptersTotal}：${outcome.reason}`;
      const written = await storage.finish(lease, {
        status: 'partial',
        error: cleanPgText(detail.slice(0, 4000)),
      });
      if (!written) throw new TaskLeaseLostError();
      return { processed: true, terminal: 'partial', reason: outcome.reason };
    }
    if (outcome.kind === 'failure') {
      await heartbeat.stop();
      throwIfAbortedUnlessBudget(signal);
      const written = await storage.finish(lease, { status: 'failed', error: outcome.code.slice(0, 4000) });
      if (!written) throw new TaskLeaseLostError();
      return { processed: true, terminal: 'failed', reason: outcome.code };
    }

    // complete → 五阶段发布。DB 前置：T2 reserveArtifactPath（identity_key 唯一，
    // 同身份重复发布取回同一 artifact id）。
    const { canonicalPath, dir } = snapshotPaths(task.title, task.author);
    const identityKey = artifactIdentityKey(task.title, task.author);
    // capacity986 切仓决策消费点：在 reserveArtifactPath 之前、且在把 github/repositoryId/branch
    // 交给本次发布之前。决策输入与发布器同源：identityKey 全量 hash、git blob sha40（与
    // publishBookVersion 内部 gitBlobSha 同口径）、logicalBytes = 整本 UTF-8 字节（十进制）。
    // existingBinding（reuse 语义）在本调用栈无可信已发布证据，按模块合同省略；同书既有
    // artifact 落位改走 existingArtifactBinding 重定向（见下方）。
    // 局部变量承接本次发布目标：装配期常量（options.github/repositoryId/branch 与 rollover.current）
    // 只读，一次 switch 不污染后续任务（后续任务仍从装配期常量重新决策）。
    let publishGithub = github;
    let publishRepositoryId = repositoryId;
    let publishBranch = branch;
    if (options.rollover) {
      // 既有 artifact 落位优先（covgap41 §4.8 阻断修复）：identity_key 唯一约束已把同书落位
      // 钉在旧行（切仓前的仓）；缺省 current 会在切仓后让成功下载撞 identity 冲突终态 failed。
      // 命中旧行时由 wiring 把决策 current 重定向到旧行的仓（同仓幂等更新）。
      const existingBinding = await storage.findArtifactBinding({
        identityKey, labeledBookId: task.book_id,
      });
      const plan = await decideRepositoryForPublication(options.rollover.port, {
        current: options.rollover.current,
        labeledBookId: task.book_id,
        identityKey,
        blobSha: gitBlobSha(outcome.txt),
        canonicalPath,
        logicalBytes: BigInt(Buffer.byteLength(outcome.txt, 'utf8')),
        ...(existingBinding ? { existingArtifactBinding: existingBinding } : {}),
      });
      if (plan.needsClosureRebuild) {
        // switch 或既有 artifact 重定向：换整闭包（重建 GitHubContents + repositoryId/branch），
        // 非只换 DB id。
        publishGithub = options.rollover.rebuildGitHubContents(plan.target);
        publishRepositoryId = plan.target.id;
        publishBranch = plan.target.branch;
      }
      // 正常 stay：闭包与元组维持装配期原引用，零重建零行为变化。
    }
    const artifactId = await storage.reserveArtifactPath({
      labeledBookId: task.book_id,
      identityKey,
      repositoryId: publishRepositoryId, branch: publishBranch, canonicalPath,
    });

    await heartbeat.check();
    let release: PublishOutcome;
    try {
      release = await publishBookVersion(publishGithub, {
        check: async () => {
          const alive = await storage.heartbeat(lease);
          if (!alive) throw new LeaseLostError();
        },
      }, {
        taskId: task.id,
        title: task.title,
        author: task.author,
        txt: outcome.txt,
        chaptersDone: outcome.chaptersDone,
        chaptersTotal: outcome.chaptersTotal,
        charsTotal: outcome.charsTotal,
        chapterRanges: outcome.chapterRanges,
      });
    } catch (error) {
      if (isRetryablePublicationError(error)) {
        // B2-03:GitHub 写入失败(含规范阶段中途失败)放回 pending 退避重跑,不落 failed 终态。
        await heartbeat.stop();
        throwIfAbortedUnlessBudget(signal);
        const { retryAt } = await settlePublicationFailure(storage, lease, error);
        return retryAt
          ? { processed: true, reason: 'publication_retry', retryAt }
          : { processed: true, terminal: 'failed', reason: error.message, retryAt: null };
      }
      if (error instanceof LeaseLostError || error instanceof PublicationStageError) throw error;
      throw new Error(`publication_failed:${(error as { code?: string })?.code ?? 'unknown'}`);
    }

    if (!release.promoted) {
      await heartbeat.stop();
      throwIfAbortedUnlessBudget(signal);
      const written = await storage.finish(lease, {
        status: 'superseded_by_incomplete',
        error: cleanPgText([
          `更差版本不晋升：新版 ${outcome.chaptersDone} 章 / ${outcome.charsTotal} 字，`
          + `已发布版 ${release.oldManifest?.chapters ?? '?'} 章 / ${release.oldManifest?.chars ?? '?'} 字`,
          `候选快照留档 ${dir}/${release.version}.json，人工确认后可手动晋升`,
        ].join('\n').slice(0, 4000)),
      });
      if (!written) throw new TaskLeaseLostError();
      return { processed: true, terminal: 'superseded_by_incomplete' };
    }

    // 第五阶段（DB）：登记已发布产物并指向任务行；失败按可对账恢复的 failed 收口，
    // 快照/manifest 已落库，修复器凭完整 hash 与目标路径补登记，不重复下载。
    await heartbeat.stop();
    throwIfAbortedUnlessBudget(signal);
    const registered = await storage.registerArtifact(lease, {
      artifactId, version: release.version, blobSha: release.blobSha, bytes: release.bytes,
      chaptersTotal: outcome.chaptersTotal, chaptersDone: outcome.chaptersDone,
      charsTotal: outcome.charsTotal, sourceRevision: '', snapshotPath: release.snapshotPath,
    });
    if (registered === 'lost') throw new TaskLeaseLostError();
    if (registered === 'mismatch') throw new Error('ARTIFACT_REGISTRATION_MISMATCH');
    if (registered !== 'registered' && registered !== 'already') throw new Error('ARTIFACT_REGISTRATION_INVALID_RESULT');
    const written = await storage.finish(lease, { status: 'done', error: '' });
    if (!written) throw new TaskLeaseLostError();
    return { processed: true, terminal: 'done' };
  } catch (error) {
    // 最终拒绝可能是含清理错误的 G，优先于先前回调记录的 F；收口开始后不再改引用。
    if (!feedbackSettlementStarted && isFeedbackFailure(error)) feedbackError = error;
    if (feedbackError !== undefined) return await settleFeedback(error);
    if (inLeg && shutdown?.aborted && !signal.aborted && !isLeaseLostError(error)) return await releaseOnShutdown();
    await heartbeat.stop();
    if (isLeaseLostError(error) || signal.reason instanceof TaskLeaseLostError || signal.reason instanceof LeaseLostError) {
      // 失租约：不写终态（行已不属于本租约），让接管者/回收器决定后续。
      return { processed: false, reason: 'lease_lost' };
    }
    // 其余异常：failed（租约条件写；失败不影响单写者——本租约仍持有）。
    await storage.finish(lease, {
      status: 'failed',
      error: cleanPgText((error instanceof Error ? error.message : String(error)).slice(0, 4000)),
    }).catch(() => undefined);
    return { processed: true, terminal: 'failed', reason: (error as Error).message };
  } finally {
    clearTimeout(taskTimer);
    await heartbeat.stop();
    void sawProgress;
  }
}

/** 一次 worker 运行：领取一个任务并处理（设计 §B.4：进程内有界 drain loop 的单步）。 */
export async function runWorkerOnce(options: WorkerOptions, owner: string): Promise<WorkerResult> {
  const lease = await options.storage.claim(owner);
  if (!lease) return { processed: false, reason: 'queue_empty' };
  return runDownloadTask(options, lease);
}

// ---- book15 builtin 腿（进程内 adapter；真实部署放运行包，见 §C）----

/**
 * engine-download CLI 以 adapter 形态接入的公共接缝：调用方注入 downloadBook 实现与
 * resolveSource（参数数组形态由调用方组装，不在本模块拼 shell 字符串）。
 * book15 builtin 与引擎源两条腿由同一 downloadBook 承担（其内部按 builtin 分支）。
 */
export interface EngineDownloadLike {
  (m: unknown, args: Record<string, unknown>, resolveSource: (m: unknown, url: string, signal: AbortSignal) => Promise<unknown>,
    transport?: unknown, hooks?: { signal?: AbortSignal; onProgress?: (update: { chaptersDone: number; chaptersTotal: number; charsTotal: number }) => Promise<void> }): Promise<{
      code: number;
      manifest: {
        status: string;
        errors: string[];
        chapters_total?: number;
        chapters_done?: number;
        chars?: number;
        failure_stage?: string;
        failure_name?: string;
        failure_phase?: string;
        failure_code?: string;
        retry_cause?: string;
        artifact?: { file: string; sha256: string; bytes: number };
        chapters?: EngineChapterRecord[];
      };
    }>;
}

export interface EngineAdapterOptions {
  downloadBook: EngineDownloadLike;
  modules: unknown;
  resolveSource: (m: unknown, url: string, signal: AbortSignal) => Promise<unknown>;
  transport?: unknown;
  /** 读结果目录拼接 TXT 的方式：默认 require manifest.artifact 由 downloadBook 已写 book.txt。 */
  readBookText: (manifest: { artifact: { file: string } }, options: { out: string }) => Promise<string>;
  outRoot: string;
  /** resumeseed1031：开跑前整理本任务 out 目录（跨实例续传种子/清残留锁）；尽力而为，抛错不影响下载。 */
  prepareOut?: (out: string) => void;
  /** 引擎腿固定参数（与 CLI 契约一致的有界值）。 */
  maxChapters?: number;
  rateMs?: number;
  timeoutMs?: number;
  budgetMs?: number;
  sourceKind?: 'builtin' | 'engine';
}

/** 引擎清单里单章的记录（engine-download.mjs 每章写 title/chars/sha256/status，这里只取这四个字段）。 */
export interface EngineChapterRecord {
  title?: unknown;
  chars?: unknown;
  sha256?: unknown;
  status?: unknown;
}

/**
 * 按引擎拼整本的真实方式还原每章在 txt 里的字节边界：engine-download.mjs 把整本拼成逐章
 * `${title}\n\n${正文}\n\n` 的顺序串接（book.txt 即此串）。逐章核对——标题逐字相符、正文码点数
 * 等于记录的 chars（`[...text].length` 口径）、正文 sha256 等于记录值、段尾是 `\n\n`，全部走完
 * 恰好到 txt 结尾；任一不符返回 null（调用方不给边界，发布器退回解析，不猜）。
 * 章名去掉首尾空白：阅读端按「首行 trim 后等于章名」去掉重复的标题行（ReaderClient）。
 */
export function engineChapterRanges(txt: string, chapters: readonly EngineChapterRecord[] | undefined): TxtChapter[] | null {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const ranges: TxtChapter[] = [];
  let at = 0; // UTF-16 下标
  let byte = 0; // UTF-8 字节偏移
  for (const [index, chapter] of chapters.entries()) {
    const record: EngineChapterRecord = chapter ?? {};
    const { title, chars, sha256 } = record;
    if (record.status !== 'done' || typeof title !== 'string' || typeof sha256 !== 'string'
      || typeof chars !== 'number' || !Number.isSafeInteger(chars) || chars < 0) return null;
    const head = `${title}\n\n`;
    if (!txt.startsWith(head, at)) return null;
    const bodyStart = at + head.length;
    let bodyEnd = bodyStart;
    // 按码点走 chars 步（代理对算一个），与引擎 [...text].length 同口径。
    for (let step = 0; step < chars; step++) {
      if (bodyEnd >= txt.length) return null;
      bodyEnd += txt.codePointAt(bodyEnd)! > 0xffff ? 2 : 1;
    }
    if (!txt.startsWith('\n\n', bodyEnd)) return null;
    const body = txt.slice(bodyStart, bodyEnd);
    if (createHash('sha256').update(body).digest('hex') !== sha256) return null;
    const size = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(body, 'utf8') + 2;
    ranges.push({ index, title: title.trim(), startByte: byte, endByte: byte + size });
    byte += size;
    at = bodyEnd + 2;
  }
  return at === txt.length ? ranges : null;
}

/** engine-download → SourceAdapter 的桥：code=0 完整；其余按 manifest.errors 分类。 */
export function createEngineAdapter(options: EngineAdapterOptions): SourceAdapter {
  const kind = options.sourceKind ?? 'engine';
  return {
    kind,
    async download(task, context) {
      const out = `${options.outRoot}/${createHash('sha256').update(`${task.source_url}|${task.title}|${task.author}`).digest('hex').slice(0, 24)}`;
      try { options.prepareOut?.(out); } catch { /* 种子失败照常从头抓 */ }
      let result;
      try {
        result = await options.downloadBook(options.modules, {
          source: task.source_url,
          title: task.title,
          author: task.author,
          out,
          'max-chapters': options.maxChapters ?? 20000,
          'rate-ms': options.rateMs ?? 800,
          'timeout-ms': options.timeoutMs ?? 30000,
          'budget-ms': options.budgetMs ?? 19800000,
        }, options.resolveSource, options.transport, {
          signal: context.signal,
          onProgress: update => context.progress(update),
        });
      } catch (error) {
        const feedbackFailure = isFeedbackFailure(error);
        if (feedbackFailure) context.onFeedbackFailure?.(error);
        // 心跳失权由 startLeaseHeartbeat 以 TaskLeaseLostError 实例 abort（见 :117），
        // 判据收窄到「reason 是失权错误」——task signal 上的普通 abort（预算耗尽）不算失权。
        if (isLeaseLostError(error) || isLeaseLostError(context.signal.reason)) throw new TaskLeaseLostError();
        if (feedbackFailure) throw error;
        // 任务预算耗尽（worker 侧定时器）不是源站失败：按可续传的 incomplete 收口，
        // 与引擎自身 budget 定时器的 budget_exhausted 分类一致（检查点保留，下次续传）。
        if (isBudgetExhausted(error) || isBudgetExhausted(context.signal.reason)) {
          return { kind: 'incomplete', reason: 'budget_exhausted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
        }
        const retryCause = hostGateCauseOf(error);
        if (retryCause) {
          if (context.signal.aborted) {
            return { kind: 'incomplete', reason: 'interrupted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
          }
          return {
            kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
            stage: 'request', retryCause,
          };
        }
        const message = (error as Error)?.message;
        if (typeof message === 'string' && /^[a-z0-9_]+$/.test(message)) return { kind: 'failure', code: message };
        // diag1031：downloadBook 自身抛出（未进 manifest）时同样只带构造器名[/固定码]，如 Error/EEXIST，原文不进日志。
        const name = (error as Error)?.name;
        const code = (error as { code?: unknown })?.code;
        const detail = typeof name === 'string' && /^[A-Za-z]{1,32}$/.test(name)
          ? name + (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? `/${code}` : '')
          : undefined;
        return detail ? { kind: 'failure', code: 'adapter_runtime_error', detail } : { kind: 'failure', code: 'adapter_runtime_error' };
      }
      const manifest = result.manifest;
      const chaptersTotal = manifest.chapters_total ?? 0;
      const chaptersDone = manifest.chapters_done ?? 0;
      const charsTotal = manifest.chars ?? 0;
      if (result.code === 0 && manifest.status === 'done' && manifest.artifact) {
        // 读回整本：book.txt 由 engine-download 在完整校验通过后原子写入。
        const txt = await options.readBookText({ artifact: manifest.artifact }, { out });
        // 章节边界取引擎拼接时的真实偏移：发布器若按标题二次解析，源站标题不规整（「13.第13章」
        // 「完本感言」）就会并章/拆章，清单 chapter_index 与 chapters 对不上，读端判清单无效（生产 502）。
        // 还原不出或章数对不上就不给，发布器退回解析（行为同旧）。
        const chapterRanges = engineChapterRanges(txt, manifest.chapters);
        return {
          kind: 'complete', txt, chaptersTotal, chaptersDone, charsTotal,
          ...(chapterRanges && chapterRanges.length === chaptersDone ? { chapterRanges } : {}),
        };
      }
      const reason = manifest.errors[0] ?? 'incomplete';
      // downloadBook 正常返回但外部租约信号已触发：抓取是被任务层中止的，属失权停止，
      // 不是源站问题——交回任务层按 lease_lost 收口（无终态写入）。
      if (context.signal.aborted && isLeaseLostError(context.signal.reason)) throw new TaskLeaseLostError();
      // 任务预算耗尽按「谁触发的」归一：外部 abort reason 透传到章循环后不再匹配引擎 knownError，
      // errors[0] 会退化成兜底 download_failed；此时真实语义是可续传的预算耗尽。
      // code=2 是 P2-5 的退出码契约（源不可用=没尝试成抓取，与普通运行失败不同档）：单列分类，
      // 按可重试的 incomplete 收口（零发布、候选保留），不与代码缺陷混同在 failed 桶。
      const classified = isBudgetExhausted(context.signal.reason) ? 'budget_exhausted'
        : result.code === 2 ? 'source_unavailable' : reason;
      if (classified === 'source_unavailable') {
        // 阶段只收固定小写枚举，防止任何上游文本借此进入日志/错误列。
        const stage = /^[a-z]+$/.test(manifest.failure_stage ?? '') ? manifest.failure_stage : 'unknown';
        // breakeryield1031：熔断让出带 retryCause，回退层不标候选失败、任务层按 host 忙排队。
        // recheckyield1031：收尾目录复核抖动同样不标候选失败，但任务层照常计次退避（不在 hostWait 名单）。
        const retryCause = manifest.retry_cause === 'host_breaker' || manifest.retry_cause === 'recheck_unavailable' ? manifest.retry_cause : undefined;
        return { kind: 'incomplete', reason: classified, chaptersTotal, chaptersDone, charsTotal, stage,
          ...(retryCause ? { retryCause } : {}) };
      }
      if (classified === 'missing_chapters' || classified === 'toc_changed' || classified === 'budget_exhausted' || classified === 'interrupted' || classified === 'operation_timeout') {
        return { kind: 'incomplete', reason: classified, chaptersTotal, chaptersDone, charsTotal };
      }
      // dlfail42：download_failed 兜底（脱敏吞掉真实错误类别）时透传 Error 构造器名——不含上游文本，
      // 配合阶段足以定位速败结构；白名单错误无 detail（reason 本身即类别）。
      const failureName = /^[A-Za-z]{1,32}$/.test(manifest.failure_name ?? '') ? manifest.failure_name : undefined;
      // diag1030：detail = 构造器名[/固定码][@阶段]，各段独立白名单，不合格的段省略（老 manifest 只有构造器名）。
      const failureCode = /^[A-Z][A-Z0-9_]{1,39}$/.test(manifest.failure_code ?? '') ? `/${manifest.failure_code}` : '';
      const failurePhase = /^[a-z]{1,16}$/.test(manifest.failure_phase ?? '') ? `@${manifest.failure_phase}` : '';
      return failureName ? { kind: 'failure', code: classified, detail: failureName + failureCode + failurePhase } : { kind: 'failure', code: classified };
    },
  };
}
