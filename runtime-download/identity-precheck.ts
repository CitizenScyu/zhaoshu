// 身份预检：挂在执行器「扣额度前预检」钩子上（契约见 executor.ts PrecheckResult）。
//
// 背景（41-T5-IDENTITY）：名单线把外部名单的 (书名, 作者) 绑到了 book15 同名详情页。作者对不上，
// 要等 downloadBook 抛 identity_mismatch_or_no_candidate 才发现，此时日额度（每天 3 本）已经扣了。
// 预检只走「搜索 + 详情」两步，不抓目录和正文。
//
// 判据与下载器是同一个函数：identityMatches（scripts/engine-download.mjs）。候选收集照抄 downloadBook
// 身份段的调用序列（同样的 parser/api 函数）；两边是否同判由 identity-precheck.test.ts「同源同判」钉住。
// 请求走执行器共享的 transport（同一个运行时限速器实例）。
//
// 结论（41-EXEC-SRCUNAVAIL 第二轮整合，先书源可达、后身份）：
// - 搜索/详情请求判出书源不可达（与下载器同一判据 isSourceUnavailableError，外部中断不算）⇒
//   { ok: false, reason: 'source_unavailable', retryable: true, stage }，执行器按下载腿同一收口退避，不扣额度；
// - 页面都取到了：搜到但作者都对不上，或一个候选都没有 ⇒ { ok: false, reason: 'identity_mismatch' }（与下载器
//   会判 identity_mismatch_or_no_candidate 的情形一一对应）；对得上 ⇒ { ok: true }；
// - caller 停机与物理占位门拒绝上抛，不归为身份无结论。
// - 其余（源解析失败、未归类错误、4xx、逐请求超时、预检墙钟用尽、候选超过
//   MAX_PRECHECK_CANDIDATES 且前面的都对不上）⇒ { ok: true, reason: 'identity_unverified' }，放行，由下载器按原路径处理。

import { identityMatches, isSourceUnavailableError } from '../scripts/engine-download.mjs';
import { authorBridgeAccepts, authorBridgeCandidates, authorSearchKey } from '../src/lib/source-author-bridge';
import { sourceBookMatches } from '../src/lib/source-parser';
import { sourceAbortable } from '../src/lib/source-fetch';
import type { TaskRow } from '../src/lib/download-worker';
import type { PrecheckHook, PrecheckResult } from './executor';

/** 预检墙钟上限：远小于 30 分钟租约回收阈值（DOWNLOAD_TASK_STALE_MS），预检期间不发心跳。 */
export const IDENTITY_PRECHECK_BUDGET_MS = 120_000;

type Page = { url: string; text: string };
export type Transport = (url: string, options: { signal: AbortSignal; timeoutMs?: number }) => Promise<Page>;
type Candidate = { title?: string; author?: string; bookUrl: string };
type Identity = { title?: string; author?: string };
interface Modules {
  compile: { compileSource(source: unknown): unknown };
  parser: {
    sourceSearchUrl(searchUrl: unknown, title: string, base: string): string;
    parseSourceSearch(text: string, url: string, title: string): string[];
    parseSourceDetailLinks(text: string, url: string, expectedTitle?: string): string[];
    parseSourceIdentity(text: string): Identity;
  };
  api: {
    engineSearchBook(engine: unknown, title: string, ctx: unknown): Promise<Candidate[]>;
    engineFetchDetail(engine: unknown, bookUrl: string, ctx: unknown): Promise<Identity>;
  };
}
interface Resolved { source: { url: string; name: string; searchUrl: unknown }; builtin: boolean }

export interface IdentityPrecheckOptions {
  modules: unknown;
  resolveSource: (m: unknown, url: string, signal: AbortSignal) => Promise<unknown>;
  transport: unknown;
  /** 单次请求超时，默认与下载腿一致（createEngineAdapter 的 timeout-ms）。 */
  timeoutMs?: number;
  budgetMs?: number;
}

/** 与下载器 SOURCE_STAGES 同口径：只有搜索/详情请求的失败才可能是书源不可达（预检不抓目录）。 */
const REACHABILITY_STAGES = new Set(['search', 'detail']);

/**
 * 预检最多逐个核对的候选数：取下载器同款上限（rule-engine/api.ts MAX_SEARCH_CANDIDATES = 50，引擎搜索
 * 结果即按此截断；该模块导出集合被结构断言锁死，这里同值另记）。超过上限且前 50 个都对不上时不下结论
 * （下载器会看全部候选），按 identity_unverified 放行——只少拦、不错拦。
 */
export const MAX_PRECHECK_CANDIDATES = 50;

/**
 * 搜索/详情请求用的最小请求上下文（{ signal, page }）：走执行器共享 transport。与下载器 operation() 同口径：
 * 逐请求超时以 operation_timeout 中止（不算书源不可达），响应路径被改写视为失败。builtin-fallback 选源共用。
 */
export function pageContext(transport: Transport, signal: AbortSignal, timeoutMs: number) {
  return {
    signal,
    page: async (url: string) => {
      const local = new AbortController();
      const timer = setTimeout(() => local.abort(new Error('operation_timeout')), timeoutMs);
      try {
        const page = await transport(url, { signal: AbortSignal.any([signal, local.signal]), timeoutMs });
        if (new URL(page.url).pathname !== new URL(url).pathname) throw new Error('response_path_mismatch');
        return page;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * authbridge42：作者名回退轮的搜索键与候选门都归到 src/lib/source-author-bridge（与选源器、
 * 下载腿 scripts/engine-download.mjs 共用同一份），保证三处「同源同判」。
 */
export function createIdentityPrecheck(options: IdentityPrecheckOptions): PrecheckHook {
  const m = options.modules as Modules;
  const transport = options.transport as Transport;
  const timeoutMs = options.timeoutMs ?? 30000;

  // true = 有候选对得上；false = 候选（不超过上限）全看过都对不上；null = 超过上限未看完，不下结论。
  const verify = async (task: TaskRow, signal: AbortSignal, progress: { stage: string }): Promise<boolean | null> => {
    const ctx = pageContext(transport, signal, timeoutMs);
    const { source, builtin } = await options.resolveSource(m, task.source_url, signal) as Resolved;
    const engine = builtin ? null : { url: source.url, name: source.name, searchUrl: source.searchUrl, compiled: m.compile.compileSource(source) };
    const detailOf = async (candidate: Candidate): Promise<Identity> => builtin
      ? m.parser.parseSourceIdentity((await ctx.page(candidate.bookUrl)).text)
      : await m.api.engineFetchDetail(engine, candidate.bookUrl, ctx);
    const matchesAny = async (candidates: Candidate[]): Promise<boolean> => {
      progress.stage = 'detail';
      for (const candidate of candidates.slice(0, MAX_PRECHECK_CANDIDATES)) {
        if (identityMatches(await detailOf(candidate), candidate, task)) return true;
      }
      return false;
    };

    progress.stage = 'search';
    let candidates: Candidate[];
    if (builtin) {
      const page = await ctx.page(m.parser.sourceSearchUrl(source.searchUrl, task.title, source.url));
      candidates = m.parser.parseSourceSearch(page.text, page.url, task.title).map(bookUrl => ({ bookUrl }));
    } else {
      candidates = await m.api.engineSearchBook(engine, task.title, ctx);
    }
    if (await matchesAny(candidates)) return true;
    // 超过上限没看完就不下结论，也不再补搜：搜索本来就不完整时加一轮作者，只会把「没看完」伪装成
    // 「都看过且都对不上」，把放行变成错拦。
    if (candidates.length > MAX_PRECHECK_CANDIDATES) return null;

    // authbridge42 作者名回退轮（搜索键判据与选源器共用 authorSearchKey，同源同判）。这一轮**不按书名
    // 过滤**——镜像站按通行书名收录，按书名过滤等于把回退作废；候选靠详情页身份门认。
    if (!authorSearchKey(task.title, task.author)) return false;
    // 书名搜索阶段已经产出候选时不做作者回退（与阅读侧 engineAuthorSearchPending 同判据）：那种形态的
    // 失败是身份冲突不是改名，回退会白花两次出网，还可能用作者名把真实的同名异作者冲突盖过去。
    // builtin 的 parseSourceSearch 本就只收书名锚文本相等的行，产出候选即等价于「书名匹配行存在」。
    const titleMatched = builtin
      ? candidates.length > 0
      : candidates.some(c => typeof c.title === 'string'
        && sourceBookMatches({ title: task.title, author: '' }, { title: c.title, author: '' }));
    if (titleMatched) return false;
    progress.stage = 'search';
    let authorCandidates: Candidate[];
    if (builtin) {
      const page = await ctx.page(m.parser.sourceSearchUrl(source.searchUrl, task.author, source.url));
      const urls = /^\/books\/details\d+\.html$/.test(new URL(page.url).pathname)
        ? [page.url]
        : m.parser.parseSourceDetailLinks(page.text, page.url, task.title);
      authorCandidates = urls.map(bookUrl => ({ bookUrl }));
    } else {
      authorCandidates = await m.api.engineSearchBook(engine, task.author, ctx);
    }
    // B′ 门（与选源器、下载腿共用 authorBridgeAccepts）：候选按 bookUrl 去重后须恰好 1 条，
    // 且该条详情页作者门逐字对上。候选 >1（同作者多本）判不命中——没有书名证据时认哪一本都是猜。
    const authorHits = authorBridgeCandidates(authorCandidates);
    if (authorHits.length !== 1) return false;
    progress.stage = 'detail';
    return authorBridgeAccepts(authorHits, await detailOf(authorHits[0]), task);
  };

  return async (task, signal): Promise<PrecheckResult> => {
    const deadline = AbortSignal.timeout(options.budgetMs ?? IDENTITY_PRECHECK_BUDGET_MS);
    const overall = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const progress = { stage: 'resolve' };
    try {
      overall.throwIfAborted();
      const matched = await sourceAbortable(verify(task, overall, progress), overall);
      if (matched === null) return { ok: true, reason: 'identity_unverified' };
      return matched ? { ok: true } : { ok: false, reason: 'identity_mismatch' };
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as { code?: unknown } | null | undefined)?.code;
      if (code === 'HOST_OCCUPIED' || code === 'HOST_OCCUPANCY_UNAVAILABLE') throw error;
      // 先书源可达、后身份：页面没取到且是书源侧不可达（与下载器同一判据），交执行器退避；
      // 预检自己的墙钟中止不算（AbortSignal.timeout 的 reason 也是 TimeoutError）。
      if (REACHABILITY_STAGES.has(progress.stage) && !overall.aborted && isSourceUnavailableError(error)) {
        return { ok: false, reason: 'source_unavailable', retryable: true, stage: progress.stage };
      }
      return { ok: true, reason: 'identity_unverified' };
    }
  };
}
