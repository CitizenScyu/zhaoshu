// B 线预取独立入口：把共享的 PrefetchStore / SourceSelector / host 占用门装配成可运行的
// 调度器实例（生产入口与测试 DI 同一条装配路径）。只装配不执行：不写 download_tasks、不领
// 下载 lease/attempt/dailyBudget（createPrefetchStore 天然不暴露这些入口），也不需要 GitHub 键。
//
// 生产真值仅 DATABASE_URL（requiredEnv 只报键名，不读配置文件；值只进 neon，不打印）。
// 限速器必须由调用方注入并与下载腿共享同一实例：缺 limiter 固定码拒绝，本模块不自建
// SourceRateLimiter——预取没有独立限速能力，没有共享 limiter 就没有出网资格。
// run 每轮 maxTasksPerRound=1、maxIdlePolls=1（service drain 每本书可接管一次）；signal
// 全程由 run(signal) 传入，不新建永不取消的常驻 signal。

import { neon } from '@neondatabase/serverless';
import {
  PREFETCH_BOOK_BUDGET_MS, PREFETCH_SCAN_LIMIT, PREFETCH_TARGET_HITS, runPrefetchScheduler,
  type PrefetchSchedulerStop, type PrefetchSelectRequest, type PrefetchSelector, type PrefetchStore,
} from './prefetch';
import { createPrefetchStore, type PrefetchSql } from './prefetch-store';
import { createSourceSelector, type SourceSelector } from './source-selector';
import { createHostOccupancy } from './host-occupancy';
import { createHostPriority, skipStrictTocEnabled } from './host-priority';
import {
  assembleEngineModules, createSourceTransport, loadEnginePool,
  type EngineModules, type RateLimiterLike, type SourceTransport,
} from './engine';
import { WORKER_TASK_TIMEOUT_MS } from '../src/lib/download-worker';
import { sourceAbortable } from '../src/lib/source-fetch';

export type PrefetchLog = (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;

export const PREFETCH_STORE_LEASE_MS = 600_000;
export const PREFETCH_STORE_BUDGET_MS = 300_000;
export const PREFETCH_SCAN_TTL_MS = 360_000;

export interface SourcePrefetchOptions {
  /** 与下载腿共享的运行时限速器（同一实例）；必填，缺省固定码拒绝。 */
  rateLimiter: RateLimiterLike;
  log: PrefetchLog;
  env?: NodeJS.ProcessEnv;
  sql?: PrefetchSql;
  modules?: EngineModules;
  transport?: SourceTransport;
  loadPool?: (signal: AbortSignal) => Promise<Array<{ url: string; name: string; searchUrl: unknown }>>;
  store?: PrefetchStore;
  /** 基础选源器（如测试注入）；失败候选排除包装仍由本入口统一加，不可绕过。 */
  selector?: SourceSelector;
}

export interface SourcePrefetch {
  run(signal: AbortSignal): Promise<PrefetchSchedulerStop>;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing environment key: ${key}`); // 只报键名
  return value;
}

/**
 * 真实 selector 的失败候选排除包装：每次先 signal.throwIfAborted，再按 bookId 参数化查询
 * download_source_candidates 中 failure<>'' 的 source_url，作为 excludedSources 精确排除
 * （不连坐整 host；busy host 仍由调度器的 excludedHosts 快照负责）。查询失败不盲扫：
 * 原样抛给调度器按 scan_failed 归还退避；SQL/error 真值不进日志，只记固定原因码。
 */
function wrapSelectorWithFailedSources(
  base: SourceSelector, sql: PrefetchSql, log: PrefetchLog,
): PrefetchSelector {
  return async (request: PrefetchSelectRequest, signal) => {
    signal.throwIfAborted();
    const deadline = performance.now() + request.budgetMs;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error('prefetch_budget_exhausted')), request.budgetMs);
    const overall = AbortSignal.any([signal, budget.signal]);
    try {
      let rows: { source_url: string }[];
      try {
        const results = await sourceAbortable(sql.transaction(tx => [tx`
          SELECT source_url FROM download_source_candidates
          WHERE book_id = ${request.task.bookId} AND failure <> ''
        `], { readOnly: true, fetchOptions: { signal: overall } }), overall) as unknown as { source_url: string }[][];
        rows = results[0] ?? [];
      } catch (error) {
        signal.throwIfAborted();
        if (budget.signal.aborted) return [];
        log('error', '预取：已失败候选查询失败', {
          taskId: request.task.id, bookId: request.task.bookId, reason: 'failed_candidates_query_failed',
        });
        throw error;
      }
      signal.throwIfAborted();
      const remainingMs = Math.max(0, deadline - performance.now());
      if (!remainingMs || budget.signal.aborted) return [];
      clearTimeout(timer);
      const knownHosts = new Set<string>();
      for (const url of request.task.sourceUrls ?? []) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol === 'https:') knownHosts.add(parsed.hostname);
        } catch { /* 非法旧候选不计入有效 host。 */ }
      }
      const missingHits = Math.max(0, request.targetHits - knownHosts.size);
      if (!missingHits) return [];
      // 共用 selector 返回 {picked, scanned}（nocand42 加的实探计数）；预取调度器只认源列表，
      // 零候选的退避判据是下载线的事，这里丢弃 scanned。
      const { picked } = await base({
        task: { id: request.task.id, title: request.task.title, author: request.task.author },
        excludedHosts: [...new Set([...request.excludedHosts, ...knownHosts])],
        excludedSources: rows.map(row => row.source_url).filter(url => typeof url === 'string' && url.length > 0),
        targetHits: missingHits,
        scanLimit: request.scanLimit,
        budgetMs: remainingMs,
      }, signal);
      return picked;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createSourcePrefetch(options: SourcePrefetchOptions): SourcePrefetch {
  // fail-closed：没有共享 limiter 就没有出网资格（固定码），不能为了能跑而自建限速器。
  if (!options.rateLimiter) throw new Error('PREFETCH_RATE_LIMITER_REQUIRED');
  const log = options.log;
  const env = options.env ?? process.env;
  const sql = options.sql ?? neon(requiredEnv(env, 'DATABASE_URL'));
  const store = options.store ?? createPrefetchStore(sql, {
    leaseMs: PREFETCH_STORE_LEASE_MS,
    budgetMs: PREFETCH_STORE_BUDGET_MS,
  });

  // 注入 selector 时不建默认链：DI 运行不需要 modules/transport/occupancy。
  const baseSelector = options.selector ?? (() => {
    const modules = options.modules ?? assembleEngineModules();
    // 预取只挂 wrapTransport（runDownload 属下载腿）；下载 TTL 与任务超时同源，scan 独立短 TTL。
    const occupancy = createHostOccupancy(sql, {
      downloadTtlMs: WORKER_TASK_TIMEOUT_MS + 600_000,
      scanTtlMs: PREFETCH_SCAN_TTL_MS,
    });
    // 注入 transport 也必须过占用门（不绕过）：先建传输层再统一 wrapTransport。
    const transport = occupancy.wrapTransport(options.transport ?? createSourceTransport(options.rateLimiter));
    return createSourceSelector({
      modules,
      transport,
      loadPool: options.loadPool ?? (signal => loadEnginePool(modules, signal)),
      log,
      hostPriority: createHostPriority(sql, env),
      skipStrictToc: skipStrictTocEnabled(env),
    });
  })();

  return {
    run(signal) {
      return runPrefetchScheduler({
        store,
        selector: wrapSelectorWithFailedSources(baseSelector, sql, log),
        signal,
        targetHits: PREFETCH_TARGET_HITS,
        scanLimit: PREFETCH_SCAN_LIMIT,
        budgetMs: PREFETCH_BOOK_BUDGET_MS,
        maxTasksPerRound: 1,
        maxIdlePolls: 1,
        log,
      });
    },
  };
}
