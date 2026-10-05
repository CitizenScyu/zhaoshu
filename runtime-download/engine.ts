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
  m.policy.refreshSupportedHosts(await m.shuyuan.getPoolEngineHosts(signal));
  return (await m.shuyuan.getEngineSources(signal)) as unknown as ReadingSourceLike[];
}

function findSourceByHost(m: EngineModules, sources: ReadingSourceLike[], host: string): ReadingSourceLike | undefined {
  return sources.find((s) => {
    const h = hostOf(s.url);
    return h === host || (h.length > 0 && m.policy.alternateSourceHost?.(host) === h);
  });
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
    const source = findSourceByHost(m, pool, host);
    if (!source) throw new ResolveSourceError(1, 'no_engine_source_for_host');
    return { source, builtin: false };
  };
}

/** 运行时限速器接缝（zhaoshu-books runtime/lib/rate-limiter.mjs 的 SourceRateLimiter 形态）。 */
export interface RateLimiterLike {
  acquire(sourceKey: string, options?: { signal?: AbortSignal }): Promise<void>;
  recordSuccess?(sourceKey: string): void;
  recordFailure?(sourceKey: string, options?: { retryAfterMs?: number }): void;
}

export type SourceTransport = (
  url: string,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    beforeRequest?: (signal: AbortSignal) => Promise<void>;
    /** 调用方已有的物理策略门（冷却等）：每次物理发射前先走，再取限速许可。 */
    beforeFetch?: (signal: AbortSignal, url: string) => void | Promise<void>;
  },
) => Promise<{ url: string; text: string }>;

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
    const { signal, timeoutMs, beforeRequest, beforeFetch: callerGate } = options;
    // 最近一次物理发射的 host（许可按它取过）：无 responseHost 的 HTTP 失败反馈归它。
    let lastHost = hostOf(url);
    const beforeFetch = limiter || callerGate
      ? async (gateSignal: AbortSignal, current: string) => {
        await callerGate?.(gateSignal, current);
        if (!limiter) return;
        const key = hostOf(current) || current;
        lastHost = key;
        await limiter.acquire(key, { signal: gateSignal });
      }
      : undefined;
    try {
      const page = await fetchSourceText(url, { signal, timeoutMs, beforeRequest, beforeFetch });
      limiter?.recordSuccess?.(hostOf(page.url) || lastHost);
      return page;
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      // 源站行为类错误（SourceHttpError 带 status，含 429）计入熔断；网络/中止不算源站失败。
      // 429/503 若带 Retry-After（SourceHttpError.retryAfterMs 已解析）则传给限速器尊重退避窗口。
      if (limiter && typeof status === 'number') {
        const responseHost = (error as { responseHost?: unknown })?.responseHost;
        const key = (typeof responseHost === 'string' && responseHost) || lastHost || hostOf(url) || url;
        const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
        limiter.recordFailure?.(key, typeof retryAfterMs === 'number' ? { retryAfterMs } : undefined);
      }
      throw error;
    }
  };
}
