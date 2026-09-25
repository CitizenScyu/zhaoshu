// T8 builtin 任务的引擎源池回退（41-T8FB）：book15 不可达时，按任务 (书名, 作者) 在引擎源池里找同一本书下载。
//
// 背景：phoenix 出网连不上 book15 的 HTTPS，builtin 任务只会逐条退避重排、永远 pending；labeler 侧早已在
// book15 熔断后改从引擎源池取正文。这里给下载器补同一条路：
// - 判据：只用 identityMatches（scripts/engine-download.mjs，预检与 downloadBook 共用的同一个函数）。
//   选源 = 引擎搜索 + 详情，详情页书名作者都对得上才入选；搜索列表上作者对不上的候选连详情都不看。
//   真正下载仍由 downloadBook 在该引擎源上再按同一判据选候选，对不上抛 identity_mismatch_or_no_candidate。
// - 候选按池序（getEngineSources：探测可达优先）依次核对，最多 MAX_FALLBACK_SOURCES 个源入选，逐个下载，
//   首个完整即收；单源失败（身份不符/缺章/超时/不可达）换下一个，全部失败回到 book15 的 source_unavailable
//   语义（退避放回 pending，不落 failed）。
// - host 级退避：book15 是否「已知不可达」看 source-host-health 的 isHostSuspect（fetch 层按 host 记连续
//   传输层硬失败，≥2 次且 10 分钟窗内）。窗内直接跳过 book15、不再每本白等 6.4s 连接超时；窗过期后下一本
//   照常先试 book15（半开），恢复即回到原路径。引擎源也按同一记忆跳过 suspect host。
// - 不改任务行的 source_url/source_kind（book15 绑定保留，恢复后行为不漂移）；实际用了哪个源只进日志（host）
//   和运行目录里 downloadBook 自己的 manifest.json（source 字段）。
//
// 预检接缝（wrapPrecheck）：book15 不可达时在扣额度前就把引擎源选好，选不到 ⇒ 仍按 source_unavailable 退避
// （不扣日额度）；选到 ⇒ 放行，选源结果放进单槽缓存交给下载腿（并发=1，同一时刻只有一本在跑）。
// 预检关闭（DOWNLOAD_IDENTITY_PRECHECK=0）时由下载腿自己选源。

import { identityMatches } from '../scripts/engine-download.mjs';
import { normalizeBookTitle } from '../src/lib/book-identity';
import { isHostSuspect } from '../src/lib/source-host-health';
import { sourceAbortable } from '../src/lib/source-fetch';
import {
  isLeaseLostError, TaskLeaseLostError,
  type AdapterOutcome, type SourceAdapter, type TaskRow,
} from '../src/lib/download-worker';
import { pageContext, type Transport } from './identity-precheck';
import type { PrecheckHook, PrecheckResult } from './executor';

/** 最多入选（并依次尝试下载）的引擎源数。 */
export const MAX_FALLBACK_SOURCES = 3;
/** 每个源最多看几个搜索候选的详情页（列表书名对得上、作者不冲突的才看）。 */
export const MAX_FALLBACK_DETAILS_PER_SOURCE = 2;
/** 选源墙钟上限：与身份预检同量级，远小于 30 分钟租约回收阈值（预检期间不发心跳）。 */
export const FALLBACK_SELECT_BUDGET_MS = 120_000;

type Identity = { title?: string; author?: string };
type SearchHit = { title?: string; author?: string; bookUrl: string };
interface PoolSource { url: string; name: string; searchUrl: unknown; rules?: unknown }
interface Modules {
  compile: { compileSource(source: unknown): unknown };
  supported: { BUILTIN_SOURCE_HOSTS: readonly string[] };
  api: {
    engineSearchBook(engine: unknown, title: string, ctx: unknown): Promise<SearchHit[]>;
    engineFetchDetail(engine: unknown, bookUrl: string, ctx: unknown): Promise<Identity>;
  };
}

export interface BuiltinFallbackOptions {
  modules: unknown;
  transport: unknown;
  /** 引擎源池（生产 = engine.ts loadEnginePool）。抛错视为池不可用：本轮不回退。 */
  loadPool: (signal: AbortSignal) => Promise<PoolSource[]>;
  /** host 是否处于已知不可达窗口；缺省 = source-host-health.isHostSuspect。 */
  isSuspect?: (host: string) => boolean;
  /** 只记任务 id、源 host、原因码，不记书名、作者、URL。 */
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  timeoutMs?: number;
  budgetMs?: number;
  maxSources?: number;
}

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

const isBuiltinTask = (task: TaskRow) => task.source_kind !== 'engine'; // 与 selectAdapter 同口径

const isSourceUnavailable = (outcome: AdapterOutcome) =>
  outcome.kind === 'incomplete' && outcome.reason === 'source_unavailable';

/** 回退源全部失败时回给任务层的结论：同 book15 不可达（退避放回 pending）。 */
const unavailable = (stage: string): AdapterOutcome =>
  ({ kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage });

export function createBuiltinFallback(options: BuiltinFallbackOptions) {
  const m = options.modules as Modules;
  const transport = options.transport as Transport;
  const isSuspect = options.isSuspect ?? ((host: string) => isHostSuspect(host));
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxSources = options.maxSources ?? MAX_FALLBACK_SOURCES;
  const builtinHosts = new Set(m.supported.BUILTIN_SOURCE_HOSTS);
  const builtinSuspect = (task: TaskRow) => isSuspect(hostOf(task.source_url));

  // 预检选好的源交给下载腿：单槽（并发=1），按任务 id 认领，领一次即清。
  let planned: { taskId: number; sources: string[] } | null = null;

  /** 该引擎源上是否有同一本书（详情页 identityMatches）。 */
  const sourceHasBook = async (source: PoolSource, task: TaskRow, signal: AbortSignal): Promise<boolean> => {
    const engine = { url: source.url, name: source.name, searchUrl: source.searchUrl, compiled: m.compile.compileSource(source) };
    const ctx = pageContext(transport, signal, timeoutMs);
    const want = normalizeBookTitle(task.title);
    const hits = (await m.api.engineSearchBook(engine, task.title, ctx)).filter(hit =>
      typeof hit.title === 'string' && normalizeBookTitle(hit.title) === want
      // 列表上带了作者且对不上：不是这本（与详情判据同一函数），省掉详情请求。
      && (!hit.author?.trim() || identityMatches(hit, task)));
    for (const hit of hits.slice(0, MAX_FALLBACK_DETAILS_PER_SOURCE)) {
      if (identityMatches(await m.api.engineFetchDetail(engine, hit.bookUrl, ctx), task)) return true;
    }
    return false;
  };

  /** 按池序选出至多 maxSources 个有这本书的引擎源（返回源 URL）。单源失败跳过；池不可用返回空。 */
  const selectSources = async (task: TaskRow, signal: AbortSignal): Promise<string[]> => {
    let pool: PoolSource[];
    try {
      pool = await options.loadPool(signal);
    } catch {
      log('info', '引擎回退：源池不可用', { taskId: task.id, reason: 'engine_source_pool_unavailable' });
      return [];
    }
    const picked: string[] = [];
    for (const source of pool) {
      if (picked.length >= maxSources || signal.aborted) break;
      const host = hostOf(source.url);
      if (!/^https:\/\//i.test(source.url) || !host || builtinHosts.has(host) || isSuspect(host)) continue;
      if (picked.some(url => hostOf(url) === host)) continue;
      try {
        if (await sourceAbortable(sourceHasBook(source, task, signal), signal)) picked.push(source.url);
      } catch {
        // 单源搜索/详情失败：跳过这个源（fetch 层已按 host 记健康），不影响其余源。
      }
    }
    log('info', '引擎回退选源', { taskId: task.id, candidates: picked.length, hosts: picked.map(hostOf) });
    return picked;
  };

  const selectWithin = (task: TaskRow, signal?: AbortSignal) => {
    const deadline = AbortSignal.timeout(options.budgetMs ?? FALLBACK_SELECT_BUDGET_MS);
    return selectSources(task, signal ? AbortSignal.any([signal, deadline]) : deadline);
  };

  return {
    /**
     * 包身份预检：builtin 任务先按原预检判 book15（已知不可达则跳过）；判出 source_unavailable 时改为选引擎源，
     * 选到放行（reason=builtin_engine_fallback），选不到原样按 source_unavailable 退避。其余结论原样返回。
     */
    wrapPrecheck(inner: PrecheckHook): PrecheckHook {
      return async (task, signal): Promise<PrecheckResult> => {
        planned = null;
        if (!isBuiltinTask(task)) return inner(task, signal);
        let stage = 'search';
        if (!builtinSuspect(task)) {
          const result = await inner(task, signal);
          if (result.ok || !result.retryable) return result;
          stage = result.stage;
        }
        const sources = await selectWithin(task, signal);
        if (!sources.length) return { ok: false, reason: 'source_unavailable', retryable: true, stage };
        planned = { taskId: task.id, sources };
        return { ok: true, reason: 'builtin_engine_fallback' };
      };
    },

    /**
     * 包 builtin 下载腿：book15 可达时行为不变；book15 判 source_unavailable（或已知不可达、或预检已选好源）
     * 时按选出的引擎源依次用 engine 腿下载（任务行不改，只把本次调用的 source_url 换成引擎源）。
     */
    wrapAdapter(builtin: SourceAdapter, engine: SourceAdapter): SourceAdapter {
      return {
        kind: 'builtin',
        async download(task, context) {
          let sources = planned?.taskId === task.id ? planned.sources : null;
          planned = null;
          let primary: AdapterOutcome | null = null;
          if (!sources) {
            if (!builtinSuspect(task)) {
              primary = await builtin.download(task, context);
              if (!isSourceUnavailable(primary)) return primary;
            }
            sources = await selectWithin(task, context.signal);
            if (isLeaseLostError(context.signal.reason)) throw new TaskLeaseLostError();
          }
          for (const url of sources) {
            const outcome = await engine.download({ ...task, source_url: url, source_kind: 'engine' }, context);
            const reason = outcome.kind === 'complete' ? 'done' : outcome.kind === 'failure' ? outcome.code : outcome.reason;
            log('info', '引擎回退下载', { taskId: task.id, host: hostOf(url), outcome: outcome.kind, reason });
            if (outcome.kind === 'complete') return outcome;
            // 任务层的停止（预算耗尽/停机中断）不是这个源的问题：不再换源，按原分类收口。
            if (outcome.kind === 'incomplete' && (outcome.reason === 'budget_exhausted' || outcome.reason === 'interrupted')) return outcome;
          }
          return primary ?? unavailable('search');
        },
      };
    },
  };
}
