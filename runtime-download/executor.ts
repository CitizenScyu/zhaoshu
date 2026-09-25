// T8 接线：T3 任务层执行器 → T7 shell 的 runOnce(signal) → LoopDecision。
//
// 决策映射（任务书）：
//   - 空队列            → NO_TASK（不扣日预算）
//   - 预算耗尽          → BUDGET_EXHAUSTED（领取成功后才 consume；耗尽时把任务安全放回 pending）
//   - 处理完一个任务    → TASK_DONE（done/failed/partial/superseded 都算已消费一次领书额度）
//   - 扣额度前预检拦截  → TASK_DONE（任务已落 failed 终态，**未扣**日预算，立即领下一本）
//   - 书源不可达        → TASK_DONE（任务已退避放回 pending 或封顶落 partial，不计日预算：扣额度前预检
//                          判出的根本没扣，下载中判出的退还本次扣减；两处打同一行结构化日志，只含
//                          原因码/阶段/源 host/下次可重试时刻）
//   - 异常              → 上抛，由 drain.errorBackoffMs 退避
//   - 数据库配额错误    → 上抛 DbQuotaExceededError（短文案），并在执行器内布置长冷却（默认 30 分钟，
//                          env DB_QUOTA_BACKOFF_MS）：冷却期内下一次 runOnce 先睡到期（signal 可中断）
//                          再碰库。drain 的 errorBackoffMs 不分错误类型、且在 shell 仓，故闸门放这层
//
// 单写者/心跳/租约/五阶段发布全部在 T3 的 runWorkerOnce 内，本层只做预算闸门与决策归一。
// drain 的 signal 用于「停机时不再领新任务」：在途任务由 T3 自身预算与心跳有界，drain 等在途收尾。

import {
  runWorkerOnce, settleSourceUnavailable, TaskLeaseLostError,
  type SourceAdapter, type TaskRow, type WorkerOptions, type WorkerStorage,
} from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { BudgetRefundOutcome, BudgetTicket } from './budget-refund';
import { createDbQuotaLatch, DbQuotaExceededError, isDbQuotaError } from '../src/lib/db-quota';

export interface LoopDecisions { NO_TASK: string; BUDGET_EXHAUSTED: string; TASK_DONE: string }

/** 与 zhaoshu-books runtime/service/drain.mjs 的 LoopDecision 字面量一致（由 shell 注入为准）。 */
export const DEFAULT_DECISIONS: LoopDecisions = Object.freeze({
  NO_TASK: 'no-task',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  TASK_DONE: 'task-done',
});

export interface DailyBudgetLike {
  /** shell 实物只回 {date, used}（不含上限），上限由 entry 的 budgetLimit 补上；未知时执行器照跑预检。 */
  read(): Promise<{ used: number; limit?: number }>;
  /** shell 实物还回传扣减所在 UTC 日 date（退还票据用）；缺省按执行器时钟取当日。 */
  consume(): Promise<{ allowed: boolean; date?: string }>;
}

/** 领取成功但预算已耗尽：任务已回退 pending，不是执行器异常，按 BUDGET_EXHAUSTED 决策。 */
export class BudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED';
  constructor() { super('daily book budget exhausted'); this.name = 'BudgetExhaustedError'; }
}

/**
 * 扣额度前预检钩子的结论（claim 之后、consume 之前调用）：
 *   { ok: true }          放行：照常 consume → 下载；
 *   { ok: true, reason }  放行，并记一行日志（预检没得出结论，如超时、未归类错误）；
 *   { ok: false, reason } 拦截：任务落 failed 终态、error = reason，不 consume、不下载，决策 TASK_DONE；
 *   { ok: false, reason: 'source_unavailable', retryable: true, stage }
 *                         书源不可达：与下载腿同一收口（退避放回 pending，封顶落 partial），不 consume、
 *                         不下载，决策 TASK_DONE。
 * reason 只能是固定的小写原因码（[a-z0-9_]），不许带书名、作者、URL；不合规的一律记成 precheck_rejected。
 */
export type PrecheckResult =
  | { ok: true; reason?: string }
  | { ok: false; reason: string; retryable?: false }
  | { ok: false; reason: 'source_unavailable'; retryable: true; stage: string };
export type PrecheckHook = (task: TaskRow, signal?: AbortSignal) => Promise<PrecheckResult>;

/** 预检拦截：任务已落 failed 终态、未扣日预算，按 TASK_DONE 决策（立即领下一本）。 */
export class PrecheckRejectedError extends Error {
  readonly code = 'PRECHECK_REJECTED';
  constructor(readonly reason: string) { super(`precheck rejected: ${reason}`); this.name = 'PrecheckRejectedError'; }
}

/** 预检判书源不可达：任务已退避放回 pending（或封顶落 partial）、未扣日预算，按 TASK_DONE 决策。 */
export class PrecheckDeferredError extends Error {
  readonly code = 'PRECHECK_DEFERRED';
  constructor(readonly stage: string, readonly host: string, readonly retryAt: string | null) {
    super('precheck deferred: source_unavailable');
    this.name = 'PrecheckDeferredError';
  }
}

const REASON_CODE = /^[a-z0-9_]{1,64}$/;
const STAGE_CODE = /^[a-z]{1,16}$/;

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

export interface ExecutorDependencies {
  storage: WorkerStorage & { releaseClaim?: (lease: Parameters<WorkerStorage['heartbeat']>[0]) => Promise<boolean> };
  github: GitHubContents;
  adapters: SourceAdapter[];
  budget: DailyBudgetLike;
  repositoryId: number;
  branch: string;
  /** 领取租约 owner（日志/对账用；不含主机名/凭据）。 */
  owner: string;
  taskTimeoutMs?: number;
  decisions?: LoopDecisions;
  /** 书源不可达时退还本次领取的日预算（幂等/不跨日/不为负由实现保证）；缺省 = 不退还。 */
  refundBudget?: (ticket: BudgetTicket) => Promise<BudgetRefundOutcome>;
  /** 扣额度前预检（契约见 PrecheckResult）。缺省 = 不预检，行为与引入前逐字一致。 */
  precheck?: PrecheckHook;
  /** 只记任务 id、原因码、阶段、源 host 与时刻，不记书名、作者、URL。 */
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /** 数据库配额错误后的冷却时长；缺省 30 分钟（entry 由 env DB_QUOTA_BACKOFF_MS 取）。 */
  quotaBackoffMs?: number;
  /** 配额恢复后补记最近一次发现时刻（cron_health）；缺省不补记。失败只记日志。 */
  recordQuotaSeen?: (seenAtIso: string) => Promise<void>;
  // ---- 测试注入缝 ----
  now?: () => number;
  /** 冷却等待；signal 中止时须尽快 resolve（不 reject）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface DownloadExecutor {
  runOnce(signal?: AbortSignal): Promise<string>;
}

// 冷却等待：到期或 signal 中止即 resolve（停机时不拖住 drain 收尾）。
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function createExecutor(deps: ExecutorDependencies): DownloadExecutor {
  const decisions = deps.decisions ?? DEFAULT_DECISIONS;
  const log = deps.log ?? (() => {});
  const quota = createDbQuotaLatch({ backoffMs: deps.quotaBackoffMs, now: deps.now });
  const sleep = deps.sleep ?? abortableSleep;
  // 结构化日志一行：只含原因码、冷却时长与到期时刻，不含驱动原文（原文带 Neon 响应体）。
  const armQuota = (where: 'run' | 'task') => {
    quota.note();
    log('error', '数据库配额超限，长退避', {
      reason: 'db_quota_exceeded', where, backoffMs: quota.remainingMs(), retryAt: quota.retryAt(),
    });
  };
  const workerOptions = (storage: WorkerStorage): WorkerOptions => ({
    storage,
    github: deps.github,
    adapters: deps.adapters,
    repositoryId: deps.repositoryId,
    branch: deps.branch,
    taskTimeoutMs: deps.taskTimeoutMs,
  });
  // 书源不可达的结构化日志：扣额度前预检与下载腿打同一行，只含原因码/阶段/源 host/下次可重试时刻。
  const logSourceUnavailable = (stage: string, host: string, retryAt: string | null) =>
    log('info', '书源不可达', { reason: 'source_unavailable', stage, host, retryAt });

  // 单轮本体（配额闸在下方对外的 runOnce）。
  const inner: DownloadExecutor = {
    async runOnce(signal) {
      if (signal?.aborted) return decisions.NO_TASK;

      // 扣额度前预检（claim 之后、consume 之前）。放行则返回，由调用方接着 consume；
      // 拦截/书源不可达则落好库后抛 PrecheckRejectedError/PrecheckDeferredError（映射为 TASK_DONE）。
      const precheckBeforeConsume = async (lease: Parameters<WorkerStorage['heartbeat']>[0], precheck: PrecheckHook) => {
        // 额度已满时不预检：consume 必然拒绝、任务退回 pending，照跑预检的话，drain 每 45s
        // 空转一轮，就会对队头那本书多打一轮源站请求。上限未知时照跑：宁可多打请求，
        // 也不静默关掉预检（shell read() 不回上限，entry 未补上时就是这种情况）。
        let task: TaskRow | null = null;
        try {
          const { used, limit } = await deps.budget.read();
          const full = typeof limit === 'number' && Number.isFinite(limit) && used >= limit;
          if (!full) task = await deps.storage.taskRow(lease.id);
        } catch (error) {
          await deps.storage.releaseClaim?.(lease);
          throw error;
        }
        if (task?.status !== 'running') return;
        let result: PrecheckResult;
        try {
          result = await precheck(task, signal);
        } catch {
          result = { ok: true, reason: 'precheck_error' }; // 预检自身出错不拦任务（fail-open）
        }
        if (!result.ok && result.retryable) {
          // 书源不可达：与下载腿同一收口，此时还没扣日预算，无需退还。
          const stage = STAGE_CODE.test(result.stage) ? result.stage : 'unknown';
          let retryAt: string | null;
          try {
            ({ retryAt } = await settleSourceUnavailable(deps.storage, lease, stage));
          } catch (error) {
            if (error instanceof TaskLeaseLostError) {
              log('info', '扣额度前预检收口时租约已失', { taskId: lease.id });
              throw error;
            }
            await deps.storage.releaseClaim?.(lease);
            throw error;
          }
          throw new PrecheckDeferredError(stage, hostOf(task.source_url), retryAt);
        }
        if (!result.ok) {
          const reason = REASON_CODE.test(result.reason) ? result.reason : 'precheck_rejected';
          let written: boolean;
          try {
            written = await deps.storage.finish(lease, { status: 'failed', error: reason });
          } catch (error) {
            await deps.storage.releaseClaim?.(lease);
            throw error;
          }
          log('info', '扣额度前预检拦截，未扣日预算', { taskId: lease.id, reason, written });
          throw new PrecheckRejectedError(reason);
        }
        if (result.reason) {
          const reason = REASON_CODE.test(result.reason) ? result.reason : 'precheck_unverified';
          log('info', '扣额度前预检未得结论，照常下载', { taskId: lease.id, reason });
        }
      };

      // claim 闸门：领取成功才 consume 日预算；耗尽则把该任务放回 pending（不占租约、不扣额度）。
      // 单实例 + 并发=1 下 consume 不存在并发写者，peek 与写入之间无竞争。
      // 每次成功扣减记一张票据（任务 id + 租约 generation），书源不可达时凭票退还。
      let ticket: BudgetTicket | null = null;
      const claim = async (owner: string) => {
        const lease = await deps.storage.claim(owner);
        if (!lease) return null;
        if (deps.precheck) await precheckBeforeConsume(lease, deps.precheck);
        let consumed: { allowed: boolean; date?: string };
        try {
          consumed = await deps.budget.consume();
        } catch (error) {
          await deps.storage.releaseClaim?.(lease);
          throw error;
        }
        if (!consumed.allowed) {
          await deps.storage.releaseClaim?.(lease);
          throw new BudgetExhaustedError();
        }
        ticket = {
          key: `${lease.id}:${lease.leaseGeneration}`,
          date: consumed.date ?? new Date().toISOString().slice(0, 10),
        };
        return lease;
      };
      const storage = new Proxy(deps.storage, {
        get(target, prop, receiver) {
          if (prop === 'claim') return claim;
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });

      let result;
      try {
        result = await runWorkerOnce(workerOptions(storage), deps.owner);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) return decisions.BUDGET_EXHAUSTED;
        if (error instanceof PrecheckRejectedError) return decisions.TASK_DONE;
        if (error instanceof PrecheckDeferredError) {
          logSourceUnavailable(error.stage, error.host, error.retryAt);
          return decisions.TASK_DONE;
        }
        // 预检收口时失租约：行已不归本租约、未扣额度，与下载腿失租约同样按已尝试收口。
        if (error instanceof TaskLeaseLostError) return decisions.TASK_DONE;
        throw error; // drain → ERROR 退避
      }
      if (!result.processed && result.reason === 'queue_empty') return decisions.NO_TASK;
      if (result.processed && result.reason === 'source_unavailable') {
        logSourceUnavailable(result.stage ?? 'unknown', result.sourceHost ?? '', result.retryAt ?? null);
        // 书源不可达不计日预算：退还本次领取时的扣减。退还失败不影响已落库的任务状态，
        // 记一行错误（配额按已扣处理，保守侧）。
        const spent = ticket as BudgetTicket | null;
        if (spent && deps.refundBudget) {
          await deps.refundBudget(spent).catch(() => {
            log('error', '日预算退还失败', { reason: 'source_unavailable' });
          });
        }
      }
      // 任务中途（心跳/发布/finish）撞配额：worker 已把异常吞成 failed + reason 文本；任务行多半仍是
      // running（finish 同样 402），由回收器接管。这里只布置冷却，不再零间隔领下一本。
      if (result.processed && result.terminal === 'failed' && isDbQuotaError(result.reason)) armQuota('task');
      return decisions.TASK_DONE;
    },
  };

  return {
    async runOnce(signal) {
      if (signal?.aborted) return decisions.NO_TASK;
      if (quota.active()) {
        await sleep(quota.remainingMs(), signal);
        if (signal?.aborted) return decisions.NO_TASK;
      }
      let decision: string;
      try {
        decision = await inner.runOnce(signal);
      } catch (error) {
        if (!isDbQuotaError(error)) throw error; // drain → ERROR 退避
        armQuota('run');
        throw new DbQuotaExceededError({ cause: error }); // drain 日志只见短文案
      }
      // 本轮碰库成功且未再撞配额：结束冷却、补记发现时刻（配额期间写不进库，只能此时补）。
      if (!quota.active()) {
        const seenAt = quota.takeUnrecorded();
        if (seenAt) {
          log('info', '数据库配额恢复', { reason: 'db_quota_recovered', lastSeenAt: seenAt });
          await deps.recordQuotaSeen?.(seenAt).catch(() => {
            log('error', '配额发现时刻补记失败', { reason: 'db_quota_record_failed' });
          });
        }
      }
      return decision;
    },
  };
}
