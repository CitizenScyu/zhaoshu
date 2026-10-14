import { identityMatches } from '../scripts/engine-download.mjs';
import { normalizeBookTitle } from '../src/lib/book-identity';
import { isHostSuspect } from '../src/lib/source-host-health';
import { sourceAbortable } from '../src/lib/source-fetch';
import { pageContext, type Transport } from './identity-precheck';

type Identity = { title?: string; author?: string };
type SearchHit = { title?: string; author?: string; bookUrl: string };

export type SourceSelectionTask = { id: number; title: string; author: string };
export interface PoolSource { url: string; name: string; searchUrl: unknown; rules?: unknown }

interface Modules {
  compile: { compileSource(source: unknown): unknown };
  supported: { BUILTIN_SOURCE_HOSTS: readonly string[] };
  api: {
    engineSearchBook(engine: unknown, title: string, ctx: unknown): Promise<SearchHit[]>;
    engineFetchDetail(engine: unknown, bookUrl: string, ctx: unknown): Promise<Identity>;
  };
}

export interface SourceSelectorOptions {
  modules: unknown;
  transport: unknown;
  loadPool: (signal: AbortSignal) => Promise<PoolSource[]>;
  isSuspect?: (host: string) => boolean;
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  timeoutMs?: number;
}

export interface SourceSelectionRequest {
  task: SourceSelectionTask;
  excludedHosts: string[];
  excludedSources: string[];
  targetHits: number;
  scanLimit: number;
  budgetMs: number;
  /** 同次下载的预检/补扫共用余额；每个实际扫描源在出网前扣一次，异常也不退回。 */
  scanBudget?: { remaining: number };
}

export type SourceSelector =
  (request: SourceSelectionRequest, signal: AbortSignal) => Promise<string[]>;

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

const isOccupancyUnavailable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as { code?: unknown }).code === 'HOST_OCCUPANCY_UNAVAILABLE';

export function createSourceSelector(options: SourceSelectorOptions): SourceSelector {
  const modules = options.modules as Modules;
  const transport = options.transport as Transport;
  const isSuspect = options.isSuspect ?? isHostSuspect;
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 30_000;
  const builtinHosts = new Set(modules.supported.BUILTIN_SOURCE_HOSTS);

  const sourceHasBook = async (source: PoolSource, task: SourceSelectionTask, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const engine = {
      url: source.url, name: source.name, searchUrl: source.searchUrl,
      compiled: modules.compile.compileSource(source),
    };
    signal.throwIfAborted();
    const context = pageContext(transport, signal, timeoutMs);
    const title = normalizeBookTitle(task.title);
    const hits = (await modules.api.engineSearchBook(engine, task.title, context)).filter(hit =>
      typeof hit.title === 'string' && normalizeBookTitle(hit.title) === title
      && (!hit.author?.trim() || identityMatches(hit, hit, task)));
    for (const hit of hits.slice(0, 2)) {
      signal.throwIfAborted();
      if (identityMatches(await modules.api.engineFetchDetail(engine, hit.bookUrl, context), hit, task)) return true;
    }
    return false;
  };

  return async (request, signal) => {
    signal.throwIfAborted();
    if (request.scanBudget && request.scanBudget.remaining <= 0) return [];
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error('select_budget_exhausted')), request.budgetMs);
    const overall = AbortSignal.any([signal, budget.signal]);
    const task = request.task;
    try {
      let pool: PoolSource[];
      try {
        pool = await sourceAbortable(options.loadPool(overall), overall);
      } catch (error) {
        signal.throwIfAborted();
        if (isOccupancyUnavailable(error)) throw error;
        if (overall.aborted) return [];
        log('info', '选源：源池不可用', { taskId: task.id, reason: 'engine_source_pool_unavailable' });
        return [];
      }
      signal.throwIfAborted();
      const excludedHosts = new Set(request.excludedHosts);
      const excludedSources = new Set(request.excludedSources);
      const picked: string[] = [];
      const pickedHosts: string[] = [];
      // 不做扫描内同 host 去重（2026-10-14 scanrev41 异厂复核推翻当日一手版）：同 host 变体承载
      // 不同内容是真实形态（noveltri zh-cn/zh-tw，7cd9222），扫描内去重会让排在无书变体之后的
      // 同 host 变体永久死区——扫描无书不进 excludedSources（markFailure 只记下载过的源），轮轮
      // 如此。槽位饥饿已由 MAX_FALLBACK_SCAN_SOURCES≈全池解决；已命中 host 的去重（pickedHosts）保留。
      let scanned = 0;
      for (const source of pool) {
        signal.throwIfAborted();
        if (picked.length >= request.targetHits || scanned >= request.scanLimit || overall.aborted
          || (request.scanBudget && request.scanBudget.remaining <= 0)) break;
        const host = hostOf(source.url);
        if (!/^https:\/\//i.test(source.url) || !host || builtinHosts.has(host) || isSuspect(host)
          || excludedHosts.has(host) || excludedSources.has(source.url) || pickedHosts.includes(host)) continue;
        scanned += 1;
        if (request.scanBudget) request.scanBudget.remaining -= 1;
        try {
          if (await sourceAbortable(sourceHasBook(source, task, overall), overall)) {
            signal.throwIfAborted();
            if (overall.aborted) break;
            picked.push(source.url);
            pickedHosts.push(host);
          }
        } catch (error) {
          signal.throwIfAborted();
          if (isOccupancyUnavailable(error)) throw error;
          if (overall.aborted) break;
        }
      }
      log('info', '选源完成', { taskId: task.id, scanned, candidates: picked.length, hosts: pickedHosts });
      return picked;
    } finally {
      clearTimeout(timer);
    }
  };
}
