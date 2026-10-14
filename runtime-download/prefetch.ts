// B 线「提前预取下一批待下载书源」调度器核心：依赖注入 store/selector，claimNext 的
// 原子性（advisory lock / 独立预取租约）由接线方在 PG 侧实现。本模块不触碰
// download_tasks 的 status/lease/attempt/budget——PrefetchStore 不暴露这些入口。
// 日志只记 taskId/bookId/命中数/host/原因码，不记书名、作者、URL。

export const PREFETCH_TARGET_HITS = 2;
export const PREFETCH_SCAN_LIMIT = 200;
export const PREFETCH_BOOK_BUDGET_MS = 300_000;
export const PREFETCH_MAX_TASKS_PER_ROUND = 100;
export const PREFETCH_MAX_IDLE_POLLS = 3;
export const PREFETCH_MAX_CONSECUTIVE_FAILURES = 5;
export const PREFETCH_FAILURE_BACKOFF_MS = 60_000;
export const PREFETCH_IDLE_POLL_MS = 30_000;

export interface PrefetchTask {
  id: number;
  bookId: number;
  title: string;
  author: string;
  /** 领取时的可用候选快照：预取只补缺额，finish 不覆盖领取后下载侧写入。 */
  sourceUrls?: string[];
}

export interface PrefetchSelectRequest {
  task: PrefetchTask;
  /** 正在下载的 host：不扫描、不入选（调度器还会对结果防御性二次裁剪）。 */
  excludedHosts: string[];
  targetHits: number;
  scanLimit: number;
  budgetMs: number;
}

/**
 * 真实实现必须在 signal 中止后停止出网：调度器的预算/中止 race 只停止「等待」，
 * 取消不了底层请求——不守约的 selector 在超时释放租约后仍可能在共享限速器上继续发请求。
 */
export type PrefetchSelector =
  (request: PrefetchSelectRequest, signal: AbortSignal) => Promise<string[]>;

export interface PrefetchStore {
  /** 当前 running 任务占用的源 host 集合。 */
  busyHosts(signal: AbortSignal): Promise<string[]>;
  /** 原子抢一个「仅 pending 且不足两个有效 host」的预扫资格（跨进程同本互斥）。null = 无可预扫任务。 */
  claimNext(signal: AbortSignal): Promise<PrefetchTask | null>;
  /** 持久化 plan（此后该书免重扫）。false = 预取资格已丢失。 */
  finish(task: PrefetchTask, plan: { sourceUrls: string[] }): Promise<boolean>;
  /** 归还预取资格（失败/中止/退出）；retryDelayMs 供实现退避，不计任务 attempt_count。 */
  release(task: PrefetchTask, input: { reason: string; retryDelayMs?: number }): Promise<boolean>;
}

export interface PrefetchSchedulerOptions {
  store: PrefetchStore;
  selector: PrefetchSelector;
  signal: AbortSignal;
  targetHits?: number;
  scanLimit?: number;
  budgetMs?: number;
  maxTasksPerRound?: number;
  maxIdlePolls?: number;
  maxConsecutiveFailures?: number;
  failureBackoffMs?: number;
  idlePollMs?: number;
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export type PrefetchSchedulerStop = 'completed' | 'idle_bound' | 'failure_bound' | 'aborted';

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

/**
 * 有效已知 host 的口径必须与 store.claimNext 的领取门槛一致：仅 HTTPS、host 非空、按 hostname
 * 去重（URL 解析出的 hostname 已小写）。非 HTTPS/非法旧候选不占缺额名额——否则旧的 http 候选会把
 * 两个 HTTPS host 的缺额算成 0，调度器永远裁掉新 host，补不满两个有效 host。
 */
const knownHttpsHosts = (urls: readonly string[] | undefined): Set<string> => {
  const hosts = new Set<string>();
  for (const url of urls ?? []) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname) hosts.add(parsed.hostname);
    } catch { /* 非法旧候选不计入有效 host。 */ }
  }
  return hosts;
};

const sleepInterruptible = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { signal.removeEventListener('abort', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * 单调度者循环（进程内并发=1）：领一本 → 预扫 → 落 plan → 领下一本。跨进程多实例安全由
 * store.claimNext 的原子性保证。所有退出路径都归还预取资格，不让任何书卡在持有态。
 */
export async function runPrefetchScheduler(options: PrefetchSchedulerOptions): Promise<PrefetchSchedulerStop> {
  const { store, selector, signal } = options;
  const log = options.log ?? (() => {});
  const targetHits = options.targetHits ?? PREFETCH_TARGET_HITS;
  const scanLimit = options.scanLimit ?? PREFETCH_SCAN_LIMIT;
  const budgetMs = options.budgetMs ?? PREFETCH_BOOK_BUDGET_MS;
  const maxTasksPerRound = options.maxTasksPerRound ?? PREFETCH_MAX_TASKS_PER_ROUND;
  const maxIdlePolls = options.maxIdlePolls ?? PREFETCH_MAX_IDLE_POLLS;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? PREFETCH_MAX_CONSECUTIVE_FAILURES;
  const failureBackoffMs = options.failureBackoffMs ?? PREFETCH_FAILURE_BACKOFF_MS;
  const idlePollMs = options.idlePollMs ?? PREFETCH_IDLE_POLL_MS;

  let done = 0;
  let idlePolls = 0;
  let consecutiveFailures = 0;
  let held: PrefetchTask | null = null;

  // 守约 selector 自己按 budgetMs 到点停止请求并返回预算前已验证结果；调度器这边的失联
  // watchdog 晚 1s 纯收尾余量，只兜到点仍不返回的不守约底层，不是新增请求预算。
  const WATCHDOG_GRACE_MS = 1_000;

  const scanOne = async (task: PrefetchTask, busyHosts: string[]): Promise<
    { picked: string[] } | { failure: 'scan_failed' | 'scan_budget_exhausted' }
  > => {
    const controller = new AbortController();
    const scanSignal = AbortSignal.any([signal, controller.signal]);
    // timer/监听清理只放 finally：外层 await 无论从哪条腿 settle，finally 必经。
    let cleanup = () => {};
    try {
      const picked = await new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          controller.abort(new Error('prefetch_budget_exhausted'));
          reject(new Error('prefetch_budget_exhausted'));
        }, budgetMs + WATCHDOG_GRACE_MS);
        const onAbort = () => {
          controller.abort(signal.reason);
          reject(signal.reason instanceof Error ? signal.reason : new Error('prefetch_aborted'));
        };
        cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        // selector 调用放进 .then：同步抛错也走 reject，不会越过 try/finally（否则 timer 泄漏）。
        Promise.resolve().then(() => selector(
          { task, excludedHosts: busyHosts, targetHits, scanLimit, budgetMs }, scanSignal))
          .then(resolve, reject);
      });
      return { picked };
    } catch (error) {
      if (!signal.aborted
        && (error as { code?: unknown } | null | undefined)?.code === 'HOST_OCCUPANCY_UNAVAILABLE') {
        throw error;
      }
      if (error instanceof Error && error.message === 'prefetch_budget_exhausted') {
        return { failure: 'scan_budget_exhausted' };
      }
      return { failure: 'scan_failed' };
    } finally {
      cleanup();
      // 已停止等待：给守约的 selector 补一个停止信号（race 本身取消不了任何底层请求）。
      controller.abort();
    }
  };

  try {
    while (!signal.aborted) {
      const busyHosts = await store.busyHosts(signal);
      if (signal.aborted) return 'aborted';
      const claim = await store.claimNext(signal);
      held = claim;
      if (signal.aborted) {
        if (claim) await store.release(claim, { reason: 'aborted' });
        held = null;
        return 'aborted';
      }
      const task = claim;
      if (!task) {
        idlePolls += 1;
        if (idlePolls >= maxIdlePolls) {
          log('info', '预取调度器停止', { reason: 'idle_bound', idlePolls });
          return 'idle_bound';
        }
        await sleepInterruptible(idlePollMs, signal);
        continue;
      }
      held = task;
      idlePolls = 0;

      const scanned = await scanOne(task, busyHosts);
      if (signal.aborted) {
        await store.release(task, { reason: 'aborted' });
        held = null;
        return 'aborted';
      }

      if ('failure' in scanned) {
        consecutiveFailures += 1;
        log('error', '预取预扫失败', { taskId: task.id, bookId: task.bookId, reason: scanned.failure, consecutiveFailures });
        await store.release(task, { reason: scanned.failure, retryDelayMs: failureBackoffMs });
        held = null;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          log('info', '预取调度器停止', { reason: 'failure_bound', consecutiveFailures });
          return 'failure_bound';
        }
        await sleepInterruptible(failureBackoffMs, signal);
        continue;
      }

      const knownHosts = knownHttpsHosts(task.sourceUrls);
      const seen = new Set([...busyHosts, ...knownHosts]);
      const missingHits = Math.max(0, targetHits - knownHosts.size);
      const trimmed: string[] = [];
      for (const url of scanned.picked) {
        if (trimmed.length >= missingHits) break;
        const host = hostOf(url);
        if (!/^https:\/\//i.test(url) || !host || seen.has(host)) continue;
        seen.add(host);
        trimmed.push(url);
      }

      if (!trimmed.length) {
        // 空结果不是有效 plan：finish 会让 claimNext 永久跳过这本书（再也不会被扫到）。
        // 重扫间隔交给 store 的 retryDelayMs；连败上界兜住全空队列的自旋，不计成功。
        consecutiveFailures += 1;
        log('info', '预取未命中', { taskId: task.id, bookId: task.bookId, reason: 'no_sources', consecutiveFailures });
        await store.release(task, { reason: 'no_sources', retryDelayMs: failureBackoffMs });
        held = null;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          log('info', '预取调度器停止', { reason: 'failure_bound', consecutiveFailures });
          return 'failure_bound';
        }
        continue;
      }

      const ok = await store.finish(task, { sourceUrls: trimmed });
      if (!ok) await store.release(task, { reason: 'prefetch_lease_lost' });
      held = null;
      consecutiveFailures = 0;
      if (!ok) {
        log('info', '预取资格已丢失', { taskId: task.id, reason: 'prefetch_lease_lost' });
      } else {
        log('info', '预取完成', { taskId: task.id, bookId: task.bookId, picked: trimmed.length, hosts: trimmed.map(hostOf) });
      }
      done += 1;
      if (done >= maxTasksPerRound) {
        log('info', '预取调度器停止', { reason: 'completed', done });
        return 'completed';
      }
    }
    return 'aborted';
  } finally {
    if (held) {
      // store 抛错等未预期路径也不把预取资格卡在持有态；归还失败继续上抛，不能静默丢失 token。
      await store.release(held, { reason: 'scheduler_exit' });
    }
  }
}
