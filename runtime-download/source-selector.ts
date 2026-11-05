import { errorKindOf, identityMatches } from '../scripts/engine-download.mjs';
import { normalizeBookTitle } from '../src/lib/book-identity';
import { authorBridgeAccepts, authorBridgeCandidates, authorSearchKey } from '../src/lib/source-author-bridge';
import { isHostSuspect, isPaywallHost } from '../src/lib/source-host-health';
import { sourceAbortable } from '../src/lib/source-fetch';
import { searchKeysOf } from '../src/lib/search-key';
import { pageContext, type Transport } from './identity-precheck';
import type { ScanMissMemo } from './scan-miss-memo';

type Identity = { title?: string; author?: string };
type SearchHit = { title?: string; author?: string; bookUrl: string; book?: unknown; vars?: unknown };

export type SourceSelectionTask = { id: number; title: string; author: string };
export interface PoolSource { url: string; name: string; searchUrl: unknown; rules?: unknown }

interface Modules {
  compile: { compileSource(source: unknown): unknown; strictTocUnsupported?(compiled: unknown): boolean };
  supported: { BUILTIN_SOURCE_HOSTS: readonly string[] };
  api: {
    engineSearchBook(engine: unknown, title: string, ctx: unknown): Promise<SearchHit[]>;
    engineFetchDetail(engine: unknown, bookUrl: string, ctx: unknown, book?: unknown, vars?: unknown): Promise<Identity>;
  };
}

export interface SourceSelectorOptions {
  modules: unknown;
  transport: unknown;
  loadPool: (signal: AbortSignal) => Promise<PoolSource[]>;
  isSuspect?: (host: string) => boolean;
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  timeoutMs?: number;
  /**
   * yield1030：host 扫描优先分（越大越先扫，缺席 = 0）。缺省 = 池序原样（逐字同改前）。
   * zeroyield1102：负分（零产出 host）排在缺席之后的池尾，仍在轮转尾段里，只降序不剔除。
   * 只做稳定重排：不增减可扫源、不动 scanLimit/预算/过滤口径——同样的扫描额度先给历史上真出过书的 host。
   * 提供方自行吞错回空表（重排是优化不是门，读不到就退回池序，不得因此少扫或 fail-closed）。
   */
  hostPriority?: (signal: AbortSignal) => Promise<ReadonlyMap<string, number>>;
  /**
   * toctgate1030：出池跳过 strict 目录必拒的源（compile.strictTocUnsupported：ruleToc 字段编译被 skip，编译期可知）。
   * 这类源选中后下载腿必抛 unsupported_toc_rule（或在详情处先以别的错挂掉），白占候选位与出网；生产 m.qidian
   * 24h 35 次 download_failed 即此形态（isVip/isVolume 被 skip）。缺省关 = 逐字同改前。编译抛错的源不在此判（留给原路径）。
   */
  skipStrictToc?: boolean;
  /**
   * variantdup1105：同 url 的锚变体里功能规则逐字相同（只差站名/分组/排序/响应时间/注释等元数据）的只留池序第一条。
   * 生产只读（2026-11-05 源池产物 753 源）：72 条与前面某条同 url 且功能规则全同，选源每轮拿同一套规则对同一 host
   * 重复探测（≈1 成扫源额度与 host QPS）。留下的那条与被去掉的出网行为相同，去重不丢命中；规则有任何一处不同
   * （含嵌套键序）都照旧分别扫。缺省关 = 逐字同改前。
   */
  dedupeVariants?: boolean;
  /**
   * zeroskip1105：hostPriority 记负分（零产出，见 zeroYieldHosts）的源直接出池，不探测、不占 scanLimit。只降序不够：
   * 轮转把池尾整段转到窗口前部，零产出站照样被选中。生产只读（2026-11-05 近 3 天）：zzxsa 326、17k 系 165、xxsy 62、
   * ixdzs 36、xs8 20 次候选失败、0 本 done。零产出判据 30 天滚动，失败老化后自动回池重试。缺省关 = 逐字同改前。
   */
  skipZeroYield?: boolean;
  /**
   * scanmiss1101：确认无书记忆（见 scan-miss-memo.ts）。缺省 = 无记忆（逐字同改前）。命中的源不出网、不扣
   * scanBudget，但照旧占 scanLimit 名额（轮转窗口划分不变，记忆只省请求、不扩扫描面）。
   */
  missMemo?: ScanMissMemo;
  /**
   * scanpar1104：同时探测的源数上限（缺省/≤1 = 逐源串行，逐字同改前）。动机（2026-11-04 生产只读）：串行扫一轮
   * 160 源约 5 分钟（≈1.9s/源，基本是等跨 host 的网络往返），吃掉约三成 worker 时间。>1 时只并发不同 host 的源
   * （同 host 等前一个提交后再扫；per-host QPS 仍由共享限速器管），命中按池序提交，picked 与串行同为池序前
   * targetHits 个 host；早停时窗口内多出的探测照实计入 scanned/scanBudget（每个实际出网的源计一次，口径不变）。
   */
  scanConcurrency?: number;
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
  /**
   * rotate1030：扫描窗口轮转序号（缺省/0 = 池序原样，逐字同改前）。第 k 轮把优先段（hostPriority>0）之后的
   * 可扫源整体左移 k×窗口（窗口 = scanLimit − 优先段可扫数），只改顺序、不增减可扫源、不动 scanLimit/预算。
   * 动机：池序按 probe/tier/checked_at 排，尾段结构性固定，scanLimit≈160 而可扫源 ~600，同一本书 16 次重试
   * 扫的是同一个前 160——全池扫描实测命中源排在 160 之后的书（tuishujun 502/574 等）永远找不回。
   */
  rotate?: number;
}

/**
 * 选源结果：picked = 命中的源 URL（按池序），scanned = 本轮实际出网探测的源数。
 * scanned 是区分「全池 0 候选」与「瞬时不可达」的唯一依据（nocand42）：scanned>0 且 picked 为空
 * 说明这本书整池没人挂，免费站收录以天计 ⇒ 长退避；scanned===0 是 busy 全占/池不可读/预算尽 ⇒ 快退避。
 * 扫描 0 个源时也如实返回 0，不粉饰。remembered = 按确认无书记忆跳过的源数（scanmiss1101；无记忆时缺席），
 * scanned + remembered > 0 同样说明这本书整池没人挂（记忆里的源是 TTL 内实探过的）。
 * unprobed1105：被本机门挡下、没向源站问过的源（isUnprobed）不计 scanned、不占 scanLimit/scanBudget。
 */
export interface SourceSelection {
  picked: string[];
  scanned: number;
  remembered?: number;
}

export type SourceSelector =
  (request: SourceSelectionRequest, signal: AbortSignal) => Promise<SourceSelection>;

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

const isOccupancyUnavailable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as { code?: unknown }).code === 'HOST_OCCUPANCY_UNAVAILABLE';

// unprobed1105：本机门拒绝——host 未登记共享限速（HOST_LOCK_MISSING）、被别的 worker 占用（HOST_OCCUPIED）、
// 限速器熔断/日限（CircuitOpenError/DailyRequestBudgetError）——根本没向源站问这本书，不是「这个源没书」。照旧计入
// scanned 会让整池被门挡住也被 nocand42 当成「整池实探零候选」长退避（2026-11-05 phoenix：255 个池 host 未登记，
// 每轮约 80 个源这样被算成已扫）。
const UNPROBED_CODES = new Set(['HOST_LOCK_MISSING', 'HOST_OCCUPIED']);
const UNPROBED_NAMES = new Set(['CircuitOpenError', 'DailyRequestBudgetError']);
const isUnprobed = (error: unknown): boolean => {
  const e = error as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null | undefined;
  return UNPROBED_CODES.has(e?.code as string) || UNPROBED_CODES.has(e?.cause?.code as string)
    || UNPROBED_NAMES.has(e?.name as string);
};

export function createSourceSelector(options: SourceSelectorOptions): SourceSelector {
  const modules = options.modules as Modules;
  const transport = options.transport as Transport;
  const isSuspect = options.isSuspect ?? isHostSuspect;
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 30_000;
  const builtinHosts = new Set(modules.supported.BUILTIN_SOURCE_HOSTS);
  // toctgate1030：按 url 记忆判定（规则对象同一或 JSON 相同才复用），免得每轮选源把全池重编一遍（编译缓存只 64 条）。
  // tocmemo1104：source.url 已剥 #frag，锚变体（规则各不相同）共用同一 url；原来每 url 只记一条，变体轮流互相
  // 顶掉，生产实测 659 源/轮里 441 个每轮必重编（w14 15 分钟 4409 次未命中，全部是同 url 异规则）。改为每 url
  // 记一小组（按规则对象 / JSON 命中），超过上限丢最旧的一条，规则变更后的旧条目随之淘汰。
  const TOC_MEMO_PER_URL = 32;
  const tocMemo = new Map<string, Array<{ rules: unknown; json: string; doomed: boolean }>>();
  const strictTocDoomed = (source: PoolSource): boolean => {
    const unsupported = modules.compile.strictTocUnsupported;
    if (!unsupported) return false;
    const entries = tocMemo.get(source.url) ?? [];
    if (typeof source.rules === 'object' && source.rules !== null) {
      const same = entries.find(entry => entry.rules === source.rules);
      if (same) return same.doomed;
    }
    const json = JSON.stringify(source.rules ?? null) + '\0' + JSON.stringify(source.searchUrl ?? null);
    const hit = entries.find(entry => entry.json === json);
    if (hit) { hit.rules = source.rules; return hit.doomed; }
    let doomed = false;
    try { doomed = unsupported(modules.compile.compileSource(source)); } catch { doomed = false; }
    entries.push({ rules: source.rules, json, doomed });
    if (entries.length > TOC_MEMO_PER_URL) entries.shift();
    tocMemo.set(source.url, entries);
    return doomed;
  };
  // variantdup1105：功能指纹 = 剔除元数据键、bookSourceUrl 去锚后的规则 JSON，按规则对象记忆（池行在读缓存 TTL 内是同一对象）。
  const VARIANT_META_KEYS = new Set(['bookSourceGroup', 'bookSourceName', 'bookSourceComment', 'customOrder', 'respondTime', 'lastUpdateTime', 'weight']);
  const fingerprints = new WeakMap<object, string | null>();
  const functionalKey = (source: PoolSource): string | null => {
    const rules = source.rules;
    if (typeof rules !== 'object' || rules === null) return null;
    let fingerprint = fingerprints.get(rules);
    if (fingerprint === undefined) {
      try {
        fingerprint = JSON.stringify(Object.entries(rules as Record<string, unknown>)
          .filter(([key]) => !VARIANT_META_KEYS.has(key))
          .map(([key, value]): [string, unknown] => [key, key === 'bookSourceUrl' && typeof value === 'string' ? value.split('#')[0] : value])
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      } catch {
        fingerprint = null;
      }
      fingerprints.set(rules, fingerprint);
    }
    return fingerprint === null ? null : `${source.url}\0${JSON.stringify(source.searchUrl ?? null)}\0${fingerprint}`;
  };
  const dedupeVariants = (pool: PoolSource[]): PoolSource[] => {
    const seen = new Set<string>();
    return pool.filter(source => {
      const key = functionalKey(source);
      if (key === null) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

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
      if (identityMatches(await modules.api.engineFetchDetail(engine, hit.bookUrl, context, hit.book, hit.vars), hit, task)) return true;
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
    const detail = await modules.api.engineFetchDetail(engine, authorHits[0].bookUrl, context, authorHits[0].book, authorHits[0].vars);
    return authorBridgeAccepts(authorHits, detail, task);
  };

  return async (request, signal) => {
    signal.throwIfAborted();
    if (request.scanBudget && request.scanBudget.remaining <= 0) return { picked: [], scanned: 0 };
    const startedAt = Date.now();
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
      let deduped = 0;
      if (options.dedupeVariants) {
        const before = pool.length;
        pool = dedupeVariants(pool);
        deduped = before - pool.length;
      }
      if (options.skipStrictToc) pool = pool.filter(source => !strictTocDoomed(source));
      let lead = 0;
      let zeroYieldSkipped = 0;
      if (options.hostPriority) {
        let priority: ReadonlyMap<string, number> = new Map();
        try {
          priority = await sourceAbortable(options.hostPriority(overall), overall);
        } catch {
          signal.throwIfAborted();
        }
        if (priority.size) {
          const rank = (s: PoolSource) => priority.get(hostOf(s.url)) ?? 0;
          if (options.skipZeroYield) {
            const before = pool.length;
            pool = pool.filter(source => rank(source) >= 0);
            zeroYieldSkipped = before - pool.length;
          }
          pool = pool.map((source, index) => ({ source, index, p: rank(source) }))
            .sort((a, b) => b.p - a.p || a.index - b.index)
            .map(entry => entry.source);
          lead = pool.filter(source => rank(source) > 0).length;
        }
      }
      const excludedHosts = new Set(request.excludedHosts);
      const excludedSources = new Set(request.excludedSources);
      const scannable = (source: PoolSource): boolean => {
        const host = hostOf(source.url);
        return /^https:\/\//i.test(source.url) && Boolean(host) && !builtinHosts.has(host) && !isSuspect(host) && !isPaywallHost(host)
          && !excludedHosts.has(host) && !excludedSources.has(source.url);
      };
      const rotate = Math.floor(request.rotate ?? 0);
      if (rotate > 0) {
        // 偏移按「可扫源」计（跳过的不耗 scanLimit，按原始下标算会让窗口越转越重叠）。
        const tail = pool.slice(lead);
        const tailScannable = tail.filter(scannable).length;
        const window = Math.max(1, request.scanLimit - pool.slice(0, lead).filter(scannable).length);
        if (tailScannable > window) {
          const skip = (rotate * window) % tailScannable;
          let cut = 0;
          for (let seen = 0; cut < tail.length; cut += 1) {
            if (!scannable(tail[cut])) continue;
            if (seen === skip) break;
            seen += 1;
          }
          pool = [...pool.slice(0, lead), ...tail.slice(cut), ...tail.slice(0, cut)];
        }
      }
      const picked: string[] = [];
      const pickedHosts: string[] = [];
      // 不做扫描内同 host 去重（2026-10-14 scanrev41 异厂复核推翻当日一手版）：同 host 变体承载
      // 不同内容是真实形态（noveltri zh-cn/zh-tw，7cd9222），扫描内去重会让排在无书变体之后的
      // 同 host 变体永久死区——扫描无书不进 excludedSources（markFailure 只记下载过的源），轮轮
      // 如此。槽位饥饿已由 MAX_FALLBACK_SCAN_SOURCES≈全池解决；已命中 host 的去重（pickedHosts）保留。
      let scanned = 0;
      const memo = options.missMemo;
      const missed = memo ? memo.load(task) : undefined;
      const misses: string[] = [];
      let remembered = 0;
      // scanerr1105：探测异常（超时/HTTP/规则）被吞后与「无书」同记 scanned，0 候选里分不出真无书与探不到。
      // 只计数与固定分类（errorKindOf：异常名/HTTP 状态/常量码，不含原文与 URL），不改任何判定。
      let errors = 0;
      let unprobed = 0;
      const errorKinds = new Map<string, number>();
      // errhost1105：实探异常按「分类@host」计（只 host 名，同 hosts 字段口径），定位哪些站长期解码/HTTP 失败。
      const errorHosts = new Map<string, number>();
      const noteError = (error: unknown, host: string): void => {
        errors += 1;
        const kind = errorKindOf(error);
        errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
        // unprobed1105：门拒绝退还名额（errors/errorKinds 照记）。
        if (isUnprobed(error)) {
          unprobed += 1;
          scanned -= 1;
          if (request.scanBudget) request.scanBudget.remaining += 1;
        } else {
          const key = `${kind}@${host}`;
          errorHosts.set(key, (errorHosts.get(key) ?? 0) + 1);
        }
      };
      const concurrency = Math.max(1, Math.floor(options.scanConcurrency ?? 1));
      if (concurrency > 1) {
        // 窗口按池序排：队头未完成时后面完成的先缓存，提交始终从队头起（命中顺序 = 池序）。
        // late = 完成时整体已中止：与串行同口径，中止后的命中不收、未命中不记忆。
        type Probe = { url: string; host: string; outcome?: { hit: boolean; late: boolean } | { error: unknown } };
        const window: Probe[] = [];
        const stop = new AbortController();
        const probeSignal = AbortSignal.any([overall, stop.signal]);
        let wake = () => {};
        let cursor = 0;
        const pendingHits = () => window.filter(p => p.outcome && 'hit' in p.outcome && p.outcome.hit && !p.outcome.late).length;
        try {
          for (;;) {
            signal.throwIfAborted();
            while (window[0]?.outcome) {
              const probe = window.shift()!;
              const outcome = probe.outcome!;
              if ('error' in outcome) {
                signal.throwIfAborted();
                if (isOccupancyUnavailable(outcome.error)) throw outcome.error;
                if (!overall.aborted) noteError(outcome.error, probe.host);
              } else if (outcome.hit) {
                if (!outcome.late && picked.length < request.targetHits && !pickedHosts.includes(probe.host)) {
                  picked.push(probe.url);
                  pickedHosts.push(probe.host);
                }
              } else if (memo && !outcome.late) misses.push(probe.url);
            }
            while (cursor < pool.length && window.filter(p => !p.outcome).length < concurrency
              && picked.length + pendingHits() < request.targetHits && scanned + remembered < request.scanLimit
              && !overall.aborted && !(request.scanBudget && request.scanBudget.remaining <= 0)) {
              const source = pool[cursor];
              const host = hostOf(source.url);
              if (!scannable(source) || pickedHosts.includes(host)) { cursor += 1; continue; }
              if (window.some(p => p.host === host)) break;
              cursor += 1;
              if (missed?.(source.url)) { remembered += 1; continue; }
              scanned += 1;
              if (request.scanBudget) request.scanBudget.remaining -= 1;
              const probe: Probe = { url: source.url, host };
              window.push(probe);
              void sourceAbortable(sourceHasBook(source, task, probeSignal), probeSignal).then(
                hit => { probe.outcome = { hit, late: overall.aborted }; },
                error => { probe.outcome = { error }; },
              ).finally(() => wake());
            }
            if (!window.length) break;
            await new Promise<void>(resolve => { wake = resolve; });
          }
        } finally {
          stop.abort();
        }
      } else for (const source of pool) {
        signal.throwIfAborted();
        if (picked.length >= request.targetHits || scanned + remembered >= request.scanLimit || overall.aborted
          || (request.scanBudget && request.scanBudget.remaining <= 0)) break;
        const host = hostOf(source.url);
        if (!scannable(source) || pickedHosts.includes(host)) continue;
        if (missed?.(source.url)) { remembered += 1; continue; }
        scanned += 1;
        if (request.scanBudget) request.scanBudget.remaining -= 1;
        try {
          if (await sourceAbortable(sourceHasBook(source, task, overall), overall)) {
            signal.throwIfAborted();
            if (overall.aborted) break;
            picked.push(source.url);
            pickedHosts.push(host);
          } else if (memo && !overall.aborted) misses.push(source.url);
        } catch (error) {
          signal.throwIfAborted();
          if (isOccupancyUnavailable(error)) throw error;
          if (overall.aborted) break;
          noteError(error, host);
        }
      }
      memo?.record(task, misses);
      log('info', '选源完成', {
        taskId: task.id, scanned, candidates: picked.length, hosts: pickedHosts,
        ...(memo ? { remembered } : {}), ...(options.dedupeVariants ? { deduped } : {}),
        ...(options.skipZeroYield ? { zeroYieldSkipped } : {}),
        errors, ...(errors ? { errorKinds: Object.fromEntries([...errorKinds].sort((a, b) => b[1] - a[1]).slice(0, 6)) } : {}),
        ...(unprobed ? { unprobed } : {}),
        ...(errorHosts.size ? { errorHosts: Object.fromEntries([...errorHosts].sort((a, b) => b[1] - a[1]).slice(0, 16)) } : {}),
        ms: Date.now() - startedAt, ...(budget.signal.aborted ? { budgetHit: true } : {}),
      });
      return memo ? { picked, scanned, remembered } : { picked, scanned };
    } finally {
      clearTimeout(timer);
    }
  };
}
