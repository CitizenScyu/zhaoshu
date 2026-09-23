// T8 接线：T3 任务层执行器 → T7 shell 的 runOnce(signal) → LoopDecision。
//
// 决策映射（任务书）：
//   - 空队列            → NO_TASK（不扣日预算）
//   - 预算耗尽          → BUDGET_EXHAUSTED（领取成功后才 consume；耗尽时把任务安全放回 pending）
//   - 处理完一个任务    → TASK_DONE（done/failed/partial/superseded 都算已消费一次领书额度）
//   - 书源不可达        → TASK_DONE（任务已退避放回 pending 或封顶落 partial；本次日预算退还，
//                          并打一行只含原因码/阶段/源 host/下次可重试时刻的结构化日志）
//   - 异常              → 上抛，由 drain.errorBackoffMs 退避
//
// 单写者/心跳/租约/五阶段发布全部在 T3 的 runWorkerOnce 内，本层只做预算闸门与决策归一。
// drain 的 signal 用于「停机时不再领新任务」：在途任务由 T3 自身预算与心跳有界，drain 等在途收尾。

import {
  runWorkerOnce, type SourceAdapter, type WorkerOptions, type WorkerStorage,
} from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { BudgetRefundOutcome, BudgetTicket } from './budget-refund';

export interface LoopDecisions { NO_TASK: string; BUDGET_EXHAUSTED: string; TASK_DONE: string }

/** 与 zhaoshu-books runtime/service/drain.mjs 的 LoopDecision 字面量一致（由 shell 注入为准）。 */
export const DEFAULT_DECISIONS: LoopDecisions = Object.freeze({
  NO_TASK: 'no-task',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  TASK_DONE: 'task-done',
});

export interface DailyBudgetLike {
  read(): Promise<{ used: number; limit: number }>;
  /** shell 实物还回传扣减所在 UTC 日 date（退还票据用）；缺省按执行器时钟取当日。 */
  consume(): Promise<{ allowed: boolean; date?: string }>;
}

/** 领取成功但预算已耗尽：任务已回退 pending，不是执行器异常，按 BUDGET_EXHAUSTED 决策。 */
export class BudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED';
  constructor() { super('daily book budget exhausted'); this.name = 'BudgetExhaustedError'; }
}

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
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface DownloadExecutor {
  runOnce(signal?: AbortSignal): Promise<string>;
}

export function createExecutor(deps: ExecutorDependencies): DownloadExecutor {
  const decisions = deps.decisions ?? DEFAULT_DECISIONS;
  const log = deps.log ?? (() => {});
  const workerOptions = (storage: WorkerStorage): WorkerOptions => ({
    storage,
    github: deps.github,
    adapters: deps.adapters,
    repositoryId: deps.repositoryId,
    branch: deps.branch,
    taskTimeoutMs: deps.taskTimeoutMs,
  });

  return {
    async runOnce(signal) {
      if (signal?.aborted) return decisions.NO_TASK;

      // claim 闸门：领取成功才 consume 日预算；耗尽则把该任务放回 pending（不占租约、不扣额度）。
      // 单实例 + 并发=1 下 consume 不存在并发写者，peek 与写入之间无竞争。
      // 每次成功扣减记一张票据（任务 id + 租约 generation），书源不可达时凭票退还。
      let ticket: BudgetTicket | null = null;
      const claim = async (owner: string) => {
        const lease = await deps.storage.claim(owner);
        if (!lease) return null;
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
        throw error; // drain → ERROR 退避
      }
      if (!result.processed && result.reason === 'queue_empty') return decisions.NO_TASK;
      if (result.processed && result.reason === 'source_unavailable') {
        // 只打原因码/阶段/源 host/下次可重试时刻：不含书名、作者、URL 与任何凭据。
        log('info', '书源不可达', {
          reason: 'source_unavailable',
          stage: result.stage ?? 'unknown',
          host: result.sourceHost ?? '',
          retryAt: result.retryAt ?? null,
        });
        // 书源不可达不计日预算：退还本次领取时的扣减。退还失败不影响已落库的任务状态，
        // 记一行错误（配额按已扣处理，保守侧）。
        const spent = ticket as BudgetTicket | null;
        if (spent && deps.refundBudget) {
          await deps.refundBudget(spent).catch(() => {
            log('error', '日预算退还失败', { reason: 'source_unavailable' });
          });
        }
      }
      return decisions.TASK_DONE;
    },
  };
}
