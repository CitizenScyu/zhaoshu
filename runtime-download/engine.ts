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
  constructor(readonly code: 1 | 2, reason: string) {
    super(reason);
    this.name = 'ResolveSourceError';
  }
}

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

/** builtin book15 条目（ReadingSource 形态；rules 空 ⇒ downloadBook 走 source-parser 分支）。 */
function builtinSource(m: EngineModules): ReadingSourceLike {
  const b = m.supported.BUILTIN_SOURCES[0];
  return { url: b.url, name: b.name, searchUrl: b.searchUrl, rules: {}, tier: 'builtin' };
}

const isBuiltinHost = (m: EngineModules, host: string) => m.supported.BUILTIN_SOURCE_HOSTS.includes(host as never);

/** 引擎源池：先刷新运行时 host 门，再读 getEngineSources（同 engine-fetch.mjs loadEnginePool）。 */
async function loadEnginePool(m: EngineModules, signal: AbortSignal): Promise<ReadingSourceLike[]> {
  m.policy.refreshSupportedHosts(await m.supported.engineHosts(signal));
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
    if (isBuiltinHost(m, host)) return { source: builtinSource(m), builtin: true };
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
  options: { signal: AbortSignal; timeoutMs?: number; beforeRequest?: (signal: AbortSignal) => Promise<void> },
) => Promise<{ url: string; text: string }>;

/**
 * 真实 HTTP 请求层：先取限速许可，再交给 fetchSourceText（含其自身节流/换 host 重试）。
 * 同一 limiter 实例被整个执行器共享（单实例）。
 */
export function createSourceTransport(limiter?: RateLimiterLike): SourceTransport {
  return async (url, options) => {
    const key = hostOf(url) || url;
    await limiter?.acquire(key, { signal: options.signal });
    try {
      const page = await fetchSourceText(url, options);
      limiter?.recordSuccess?.(key);
      return page;
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      // 源站行为类错误（SourceHttpError 带 status，含 429）计入熔断；网络/中止不算源站失败。
      if (limiter && typeof status === 'number') limiter.recordFailure?.(key);
      throw error;
    }
  };
}
