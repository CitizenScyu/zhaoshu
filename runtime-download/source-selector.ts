import { identityMatches } from '../scripts/engine-download.mjs';
import { normalizeBookTitle } from '../src/lib/book-identity';
import { authorBridgeAccepts, authorBridgeCandidates, authorSearchKey } from '../src/lib/source-author-bridge';
import { isHostSuspect, isPaywallHost } from '../src/lib/source-host-health';
import { sourceAbortable } from '../src/lib/source-fetch';
import { searchKeysOf } from '../src/lib/search-key';
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

/**
 * 选源结果：picked = 命中的源 URL（按池序），scanned = 本轮实际出网探测的源数。
 * scanned 是区分「全池 0 候选」与「瞬时不可达」的唯一依据（nocand42）：scanned>0 且 picked 为空
 * 说明这本书整池没人挂，免费站收录以天计 ⇒ 长退避；scanned===0 是 busy 全占/池不可读/预算尽 ⇒ 快退避。
 * 扫描 0 个源时也如实返回 0，不粉饰。
 */
export interface SourceSelection {
  picked: string[];
  scanned: number;
}

export type SourceSelector =
  (request: SourceSelectionRequest, signal: AbortSignal) => Promise<SourceSelection>;

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

  // authbridge42：书名轮收 0 后的作者名回退轮。QQ 系书在镜像站按通行书名收录（队列名「少年羽皇」vs
  // 站名「帝临鸿蒙」），书名搜索天然失配，是生产 0 候选率 96.6% 的结构性根因；qqmirror42 出网实测
  // 作者名搜索 5/6 命中，作者名是可靠桥接键。这一轮不按书名过滤（过滤等于把回退作废），候选按
  // bookUrl 去重后过 B′ 门（作者门 + 唯一性）；scanned 语义不变——它记的是探测的源数，不是出网请求数。
  const sourceHasBook = async (source: PoolSource, task: SourceSelectionTask, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const engine = {
      url: source.url, name: source.name, searchUrl: source.searchUrl,
      compiled: modules.compile.compileSource(source),
    };
    signal.throwIfAborted();
    const context = pageContext(transport, signal, timeoutMs);
    // dlsearch-1026：搜索词用清洗后的值（版本注记/国籍/角色词清洗见 src/lib/search-key.ts）。
    // 书名直等过滤同时认「清洗键」与「任务原书名」两个归一键：任务带注记（精灵宝钻（精装插图本））
    // 而源站按通行书名（精灵宝钻）收录时，只认原书名会把真书滤成 0 候选——搜到也匹配不上。
    // 后续身份比对（identityMatches → sourceBookMatches）仍吃任务原值，判等口径不变。
    const keys = searchKeysOf(task);
    const titleKeys = new Set([normalizeBookTitle(keys.title), normalizeBookTitle(task.title)]);
    const hits = (await modules.api.engineSearchBook(engine, keys.title, context)).filter(hit =>
      typeof hit.title === 'string' && titleKeys.has(normalizeBookTitle(hit.title))
      && (!hit.author?.trim() || identityMatches(hit, hit, task)));
    for (const hit of hits.slice(0, 2)) {
      signal.throwIfAborted();
      if (identityMatches(await modules.api.engineFetchDetail(engine, hit.bookUrl, context), hit, task)) return true;
    }
    if (hits.length) return false;
    if (!authorSearchKey(task.title, task.author)) return false;
    // 搜索本身不 catch：宿主占用门失效（HOST_OCCUPANCY_UNAVAILABLE）必须照旧上抛 fail-closed，
    // 被这里吞掉会变成「这个源没书」而继续扫全池。
    const authorHits = authorBridgeCandidates(await modules.api.engineSearchBook(engine, keys.author, context));
    // B′ 门要求候选唯一 ⇒ 至多核 1 条详情。候选 >1（同作者多本）直接判这个源没书：
    // 没有书名证据时认哪一本都是猜，错配一本比 0 命中坏得多。
    if (authorHits.length !== 1) return false;
    signal.throwIfAborted();
    const detail = await modules.api.engineFetchDetail(engine, authorHits[0].bookUrl, context);
    return authorBridgeAccepts(authorHits, detail, task);
  };

  return async (request, signal) => {
    signal.throwIfAborted();
    if (request.scanBudget && request.scanBudget.remaining <= 0) return { picked: [], scanned: 0 };
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
        if (overall.aborted) return { picked: [], scanned: 0 };
        log('info', '选源：源池不可用', { taskId: task.id, reason: 'engine_source_pool_unavailable' });
        return { picked: [], scanned: 0 };
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
        if (!/^https:\/\//i.test(source.url) || !host || builtinHosts.has(host) || isSuspect(host) || isPaywallHost(host)
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
      return { picked, scanned };
    } finally {
      clearTimeout(timer);
    }
  };
}
