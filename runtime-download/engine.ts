// T8 接线：engine-download.mjs 的运行时装配（`m = { compile, api, parser }` + resolveSource + transport）。
//
// 复用既有导出，不新造取数逻辑：
//   - m 装配 = rule-engine/api + compile + shuyuan + supported-sources + source-policy + source-parser
//     + source-reader 的原样 re-export（engine-fetch.mjs:74-85 的同一组模块）。
//   - resolveSource = engine-fetch.mjs:112-184 的 host 判定/引擎源池口径（builtin 直通；非 builtin
//     走 shuyuan.getEngineSources 池按 host 反查；非法 URL / 池不可用回 code=2）。
//   - transport = src/lib/source-fetch.ts 的 fetchSourceText，外面套运行时 SourceRateLimiter
//     （§B.4：限速必须落在真实 HTTP 请求层；单实例由调用方保证）。

import * as api from '../src/lib/rule-engine/api';
import * as compile from '../src/lib/rule-engine/compile';
import * as shuyuan from '../src/lib/shuyuan';
import * as supported from '../src/lib/supported-sources';
import * as policy from '../src/lib/source-policy';
import * as parser from '../src/lib/source-parser';
import * as reader from '../src/lib/source-reader';
import { fetchSourceText } from '../src/lib/source-fetch';

export {
  createFeedbackDeadlineLimiter, FeedbackDeadlineError, FeedbackHostStateError,
  type FeedbackDeadlineOptions, type FeedbackDeadlineLimiter, type FeedbackDiagnostic,
  type FeedbackHostStatus, type FeedbackPublicState, type FeedbackIOState, type FeedbackPhase,
} from './limiter-feedback-deadline';

export interface EngineModules {
  api: typeof api;
  compile: typeof compile;
  shuyuan: typeof shuyuan;
  supported: typeof supported;
  policy: typeof policy;
  parser: typeof parser;
  reader: typeof reader;
}

export function assembleEngineModules(): EngineModules {
  return { api, compile, shuyuan, supported, policy, parser, reader };
}

interface ReadingSourceLike {
  url: string;
  name: string;
  searchUrl: unknown;
  rules: Record<string, unknown>;
  tier?: string;
}

export interface ResolvedSource {
  source: ReadingSourceLike;
  builtin: boolean;
}

/** 与 engine-fetch.mjs 同形的错误：code=2 表示「无法尝试」（用法/依赖不可用），code=1 表示 miss。 */
export class ResolveSourceError extends Error {
  constructor(readonly code: 1 | 2, readonly reason: string) {
    super(reason);
    this.name = 'ResolveSourceError';
  }
}

/** resolveSource 的退休收口（code=2、稳定原因码）：识别集合内但无活跃内建源的 host。 */
export const RETIRED_BUILTIN_REASON = 'builtin_source_retired';

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

// 退休 host 在池反查**之前**收口：退休是静态事实，不依赖引擎池/DB 是否可用——
// 池不可用、池里恰好有同站行，都不能让 resolveSource 对退休 host 给出可下载的源。
const isRetiredBuiltin = (m: EngineModules, host: string) => m.supported.isRetiredBuiltinHost(host);

/** 引擎源池：先刷新运行时 host 门，再读 getEngineSources（同 engine-fetch.mjs loadEnginePool）。 */
export async function loadEnginePool(m: EngineModules, signal: AbortSignal): Promise<ReadingSourceLike[]> {
  // 41-poolimpl：host 门与池同源（源池产物优先、失败回退库；开关关时即 engineHosts 鲜读）。
  // bpool-expand：下载腿走 Download 池入口，开关开时接受 phoenix_ok: 源（阅读池不受影响）。
  m.policy.refreshSupportedHosts(await m.shuyuan.getDownloadPoolEngineHosts(signal));
  return (await m.shuyuan.getDownloadEngineSources(signal)) as unknown as ReadingSourceLike[];
}

function findSourceByHost(m: EngineModules, sources: ReadingSourceLike[], host: string): ReadingSourceLike | undefined {
  return sources.find((s) => {
    const h = hostOf(s.url);
    return h === host || (h.length > 0 && m.policy.alternateSourceHost?.(host) === h);
  });
}

// 41-cnresolve：任务 URL 带站内语言/版块前缀（noveltri /zh-cn/book/…）而池里同 host 有多行源
// （第 1 行 /zh-tw 搜索模板、第 2 行 /zh-cn）时，host 兜底会命中第 1 行——zh-tw 搜简体书名恒空，
// 该书在这一源下永远不可达。精确 URL 匹配失败后先选**池中 url 是任务 URL 前缀的最长一条**
// （= 与任务 URL 同版块的源），再落 host 兜底；不引入任何新 host（只在同 host 内重排）。
function findSourceByLongestPrefix(sources: ReadingSourceLike[], url: string): ReadingSourceLike | undefined {
  let best: ReadingSourceLike | undefined;
  let bestLen = -1;
  for (const s of sources) {
    if (s.url && url.startsWith(s.url) && s.url.length > bestLen) { best = s; bestLen = s.url.length; }
  }
  return best;
}

/**
 * resolveSource(m, url, signal)：engine-download 的源解析接缝。
 * 返回 { source, builtin }；builtin=true 时 downloadBook 走 book15 source-parser 分支。
 */
export function createResolveSource(m: EngineModules) {
  return async (_m: unknown, url: string, signal: AbortSignal): Promise<ResolvedSource> => {
    if (!/^https:\/\//i.test(url)) throw new ResolveSourceError(2, 'source_url_must_be_https');
    const host = hostOf(url);
    if (!host) throw new ResolveSourceError(2, 'source_url_host_unparseable');
    // 退休 host（识别集合内、无活跃内建源）：**永久书源不可达**（code=2，稳定原因码可观测）。
    // 与池反查的 code=1 miss 区分：退休是静态事实，池不可用/池里同站行都不改变这个结论，
    // 下载腿按 source_unavailable 退避（可重试、零发布），永不向退休 host 发请求。
    if (isRetiredBuiltin(m, host)) throw new ResolveSourceError(2, RETIRED_BUILTIN_REASON);
    if (m.supported.builtinSourceForHost(host)) {
      let source: shuyuan.ReadingSource | null;
      try {
        source = await m.shuyuan.getBuiltinRequestSource(host, signal);
      } catch {
        signal.throwIfAborted();
        throw new ResolveSourceError(2, 'builtin_source_unavailable');
      }
      if (!source) throw new ResolveSourceError(2, 'builtin_source_unavailable');
      return { source: source as ReadingSourceLike, builtin: true };
    }
    let pool: ReadingSourceLike[];
    try {
      pool = await loadEnginePool(m, signal);
    } catch {
      // 池不可用（DB 不可达等）：code=2，「没尝试成抓取」，与引擎 CLI 同档。
      throw new ResolveSourceError(2, 'engine_source_pool_unavailable');
    }
    // 匹配序（41-cnresolve）：精确 URL > 同 host 最长前缀（zh-cn/zh-tw 分版源各归各位） > host 兜底。
    const source = pool.find(candidate => candidate.url === url)
      ?? findSourceByLongestPrefix(pool, url)
      ?? findSourceByHost(m, pool, host);
    if (!source) throw new ResolveSourceError(1, 'no_engine_source_for_host');
    return { source, builtin: false };
  };
}

/** 运行时限速器接缝（zhaoshu-books runtime/lib/rate-limiter.mjs 的 SourceRateLimiter 形态）。 */
export interface RateLimiterLike {
  acquire(sourceKey: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  recordSuccess?(sourceKey: string, options?: { permit?: unknown }): void | Promise<void>;
  recordFailure?(sourceKey: string, options?: { retryAfterMs?: number; permit?: unknown }): void | Promise<void>;
}

/** 反馈持久化不可确认；原错误仅保留引用，不复制源站status或敏感消息。 */
export class LimiterFeedbackError extends Error {
  readonly code = 'LIMITER_FEEDBACK_UNAVAILABLE';
  readonly origin = 'limiter-feedback';
  readonly persistenceOutcome = 'unknown';
  readonly cause: unknown;
  readonly requestError?: unknown;
  readonly abortReason?: unknown;

  constructor(
    readonly phase: 'success' | 'failure',
    readonly host: string,
    readonly feedbackError: unknown,
    details: { requestError?: unknown; abortReason?: unknown } = {},
  ) {
    super('Limiter feedback persistence unavailable');
    this.name = 'LimiterFeedbackError';
    this.cause = feedbackError;
    if ('requestError' in details) this.requestError = details.requestError;
    if ('abortReason' in details) this.abortReason = details.abortReason;
  }
}

export type SourceTransport = (
  url: string,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    beforeRequest?: (signal: AbortSignal) => Promise<void>;
    /** 调用方已有的物理策略门（冷却等）：每次物理发射前先走，再取限速许可。 */
    beforeFetch?: (signal: AbortSignal, url: string) => void | Promise<void>;
    afterAcquire?: (signal: AbortSignal, url: string) => void | Promise<void>;
  },
) => Promise<{ url: string; text: string }>;

/** source-fetch 的门拒绝标记（结构判别）：beforeRequest/beforeFetch 抛出的错误被标
 * fromBeforeRequest=true——发生在物理 fetch 之前，不是源站行为。 */
interface GateRejection { fromBeforeRequest?: boolean }

/**
 * 真实 HTTP 请求层（bphysical788）：限速许可不再在外层 acquire 一次，而是组合进
 * fetchSourceText 的物理门 beforeFetch——先保留调用方已有物理策略门，再按**该次 current URL
 * 的真实 hostname** 取 limiter 许可。初始/302 跳转后/传输失败换备用 host 的每次物理发射各取
 * 一次许可，无初始双扣；beforeRequest 预算合同不变（换 host 重试仍 skipFirstBeforeRequest，
 * 点数/节流不重复扣）。host 不私自合并 apex/www，沿 hostOf 原样。
 * 成功反馈记到返回 page.url 的 host；HTTP 状态类失败记到 SourceHttpError.responseHost
 * （真正返回响应的站）或最近实际发射的 host，不把备用 host 记到初始 host。
 * 许可被拒/排队中止等 beforeFetch 异常沿用 source-fetch 的 fromBeforeRequest 标记：
 * 不触发换 host 重试、不计源站失败。同一 limiter 实例被整个执行器共享（单实例）。
 */
export function createSourceTransport(limiter?: RateLimiterLike): SourceTransport {
  return async (url, options) => {
    const { signal, timeoutMs, beforeRequest, beforeFetch: callerGate, afterAcquire } = options;
    // 最近一次物理发射的 host（许可按它取过）：无 responseHost 的 HTTP 失败反馈归它。
    let lastHost = hostOf(url);
    // opaque许可只在本次transport内保留原引用；不解析字段或按反馈host重绑。
    let lastPermit: unknown;
    const beforeFetch = limiter || callerGate || afterAcquire
      ? async (gateSignal: AbortSignal, current: string) => {
        lastPermit = undefined;
        await callerGate?.(gateSignal, current);
        if (limiter) {
          const key = hostOf(current) || current;
          lastHost = key;
          lastPermit = await limiter.acquire(key, { signal: gateSignal });
        }
        await afterAcquire?.(gateSignal, current);
      }
      : undefined;
    let page: { url: string; text: string };
    // 请求结果与反馈结果分开捕获，反馈失败不能再次归因成HTTP失败。
    try {
      page = await fetchSourceText(url, { signal, timeoutMs, beforeRequest, beforeFetch });
    } catch (error) {
      // 只认调用方取消reason的同一引用，不吞掉已收到的不同HTTP错误。
      if (signal.aborted && error === signal.reason) throw error;
      const status = (error as { status?: unknown })?.status;
      // 源站行为类错误（SourceHttpError 带 status，含 429）计入熔断；网络/中止不算源站失败。
      // 429/503 若带 Retry-After（SourceHttpError.retryAfterMs 已解析）则传给限速器尊重退避窗口。
      // 门拒绝（beforeRequest/beforeFetch，含 acquire/callerGate 抛出的带 status 的普通 Error）
      // 被 source-fetch 标 fromBeforeRequest=true：发生在物理 fetch 之前，不是源站行为，
      // 即使错误带 status/retryAfterMs 也不记 recordFailure，原样上抛保持错误身份。
      const gateRejected = (error as GateRejection)?.fromBeforeRequest === true;
      if (limiter && !gateRejected && typeof status === 'number') {
        const responseHost = (error as { responseHost?: unknown })?.responseHost;
        const key = (typeof responseHost === 'string' && responseHost) || lastHost || hostOf(url) || url;
        const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
        const failureOptions = typeof retryAfterMs === 'number' ? { retryAfterMs } : undefined;
        try {
          await limiter.recordFailure?.(key, lastPermit === undefined
            ? failureOptions
            : { ...failureOptions, permit: lastPermit });
        } catch (feedbackError) {
          throw new LimiterFeedbackError('failure', key, feedbackError, {
            requestError: error,
            ...(signal.aborted ? { abortReason: signal.reason } : {}),
          });
        }
      }
      throw error;
    }
    const successHost = hostOf(page.url) || lastHost;
    try {
      if (lastPermit === undefined) await limiter?.recordSuccess?.(successHost);
      else await limiter?.recordSuccess?.(successHost, { permit: lastPermit });
    } catch (feedbackError) {
      throw new LimiterFeedbackError('success', successHost, feedbackError, {
        ...(signal.aborted ? { abortReason: signal.reason } : {}),
      });
    }
    // 已取得请求结果就结算反馈；不以abort裸race遗弃反馈Promise。
    signal.throwIfAborted();
    return page;
  };
}
