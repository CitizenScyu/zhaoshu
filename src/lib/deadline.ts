// 请求级预算（deadline）：从 handler 入口建立，给读库、模型重试、写回、序列化
// 分配同一份剩余预算，任何步骤都不能重新获得整份预算。
//
// 划分依据（约束 G）：
// - 模型路由（find 各 step / profile / feedback，maxDuration=295）用低于平台上限的内部预算；
// - 60 秒路由（下载文件）不得套用 280 秒预算——它自己有独立的 55s GitHub 预算；
// - 预留给"写回"一段固定时间：模型重试只能吃 总预算-reserve，不会把最后时刻花光。
//
// 取消语义：deadline.signal 只在预算耗尽时触发；HTTP 请求取消走调用方的 req.signal，
// 由调用点用 AbortSignal.any 与 deadline.signal 组合后按调用传递，不挂到共享客户端上。

export const MODEL_ROUTE_INTERNAL_BUDGET_MS = 285_000; // 295s 路由，内部预算低于平台上限（与 llm 既有 285s 模型上限一致）
export const WRITE_BACK_RESERVE_MS = 12_000; // 为写回预留的时间，模型重试不能吃光

export class DeadlineExceededError extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  constructor(budgetMs: number) {
    super(`请求预算 ${Math.ceil(budgetMs / 1000)}s 已耗尽。`);
    this.name = 'DeadlineExceededError';
  }
}

export class RequestDeadline {
  readonly budgetMs: number;
  readonly startedAt = Date.now();
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(budgetMs: number) {
    this.budgetMs = budgetMs;
    this.timer = setTimeout(() => {
      this.controller.abort(new DeadlineExceededError(this.budgetMs));
    }, budgetMs);
    // 请求结束时未显式 dispose 也不该阻止进程退出。
    this.timer.unref?.();
  }

  /** 预算耗尽时触发；理由为 DeadlineExceededError。 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get remainingMs(): number {
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }

  get expired(): boolean {
    return this.signal.aborted || this.remainingMs <= 0;
  }

  /** 预算耗尽即抛 DeadlineExceededError（用于写回前的硬性门槛）。 */
  assert(): void {
    if (this.expired) throw new DeadlineExceededError(this.budgetMs);
  }

  /**
   * 给模型重试分配的子预算：在剩余预算里先扣掉留给写回的时间，再封顶 ceilingMs。
   * 前置读库耗时越多，返回越小——绝不重获整份预算。
   */
  modelBudgetMs(ceilingMs: number): number {
    return Math.max(0, Math.min(this.remainingMs - WRITE_BACK_RESERVE_MS, ceilingMs));
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

export function createDeadline(budgetMs: number): RequestDeadline {
  return new RequestDeadline(budgetMs);
}

/**
 * 把一次可能慢的操作用 deadline.signal 约束：预算耗尽即拒绝并停止等待，但仍
 * 让底层执行自行进行——HTTP abort / 预算到期都不能被认定为数据库执行已取消。
 */
export async function raceDeadline<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  const reason: unknown = signal.reason;
  if (signal.aborted) throw toDeadlineError(reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toDeadlineError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(task).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function toDeadlineError(reason: unknown): unknown {
  return reason instanceof DeadlineExceededError ? reason : new DeadlineExceededError(0);
}