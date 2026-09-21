import { createHash } from 'node:crypto';
import { getSql } from './db';
import { getReadingSources, type ReadingSource } from './shuyuan';
import { fetchSourceText, sourceAbortable, SourceHttpError } from './source-fetch';
import { SourcePolicyError, alternateSourceHost, validateSourceUrl } from './source-policy';
import { sourceRevision } from './source-revision';
import {
  engineFetchContent, engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource,
} from './rule-engine/api';
import { compileSource } from './rule-engine/compile';
import {
  knownSourceAuthor, matchSourceChapter, MAX_SOURCE_CHAPTER_CHARACTERS, normalizeSourceTitle, parseSourceChapters,
  parseSourceChapterText, parseSourceDetailLinks, parseSourceIdentity, parseSourceSearch,
  sourceBookMatches, sourceSearchUrl, sourceTitleSimilarity,
  type SourceBookIdentity, type SourceChapter,
} from './source-parser';
import type { ReaderIndex, ReaderPart } from './reader-types';

const MAX_SOURCE_REQUESTS = 12;
const MAX_SOURCE_ATTEMPTS = 2;
const SOURCE_DELAY_MS = 350;
// M2 预算三层闸门的常量出处见 multisource-project-plan M0.2 与 m2-scaleout-design §3.1：
// L1 单源点数/切片（非 builtin 源生效）、L2 全局兜底（openPool 抬高 totalLimit）、
// 软预算 45s 的起点由根 context 的 startedAt 给出（判据本身在 M2-2）。
export const PER_SOURCE_REQUESTS = 6;
export const PER_SOURCE_SLICE_MS = 14_000;
export const SOFT_BUDGET_MS = 45_000;
export const MAX_POOL_REQUESTS = 30;
/** 根 context 的 scope：builtin 首源不受 L1 单源闸门约束（零回归的机械保证）。 */
export const BUILTIN_SCOPE = 'builtin';
const MAX_DETAIL_CANDIDATES = 4;
const MAX_SIMILAR_PAGES = 2;
const MAX_SIMILAR_CANDIDATES = 6;
const CHAPTER_CACHE_MS = 2 * 60_000;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_CHAPTERS = 24;
const PARSER_VERSION = 'book15-v1';

export class SourceReaderError extends Error {
  constructor(message: string, readonly code: string, readonly status = 404) { super(message); }
}

/** 模糊降级层交给用户确认的候选（已拉过详情页、目录可解析、按相似度排序）。 */
export interface SourceSimilarCandidate {
  title: string;
  author: string;
  alias?: string;
  chapters: number;
  bookUrl: string;
}

/** 父子共享的预算状态（设计 §3.1 的 shared）：计数、350ms 节流槽、全局上限、软预算起点。 */
interface SharedSourceBudget {
  requests: number;
  nextRequestAt: number;
  totalLimit: number;
  startedAt: number;
}

interface SourceContextOptions {
  budget?: SharedSourceBudget;
  scope?: string;
  sliceMs?: number;
  sliceController?: AbortController;
}

export class SourceRequestContext {
  /** 源归属：根 context 是 builtin，其余由 child(sourceUrl) 指定（M2-2 消费）。 */
  readonly scope: string;
  /** 本 scope 独立的点数上限；全局上限见 totalLimit。 */
  readonly limit: number;
  private readonly budget: SharedSourceBudget;
  // 本 scope 已扣点数：与 shared.requests 同步递增，但单独记账用于 L1 单源闸门判定。
  private readonly scoped = { used: 0 };

  constructor(readonly signal: AbortSignal, limit = MAX_SOURCE_REQUESTS, options: SourceContextOptions = {}) {
    this.scope = options.scope ?? BUILTIN_SCOPE;
    this.limit = limit;
    // 根 context 的全局上限初值 = 构造 limit：单独用 context(n) 的既有调用路径行为逐点不变
    //（openPool 只在 M2-2 的 resolveSourceBook 里被调用，M2-1 不改任何现有调用路径）。
    this.budget = options.budget ?? { requests: 0, nextRequestAt: 0, totalLimit: limit, startedAt: Date.now() };
    const sliceController = options.sliceController;
    if (sliceController) {
      // 单源切片：到点只 abort 子 signal（原因码 SOURCE_SCOPE_EXHAUSTED），父 signal 不受影响。
      const timer = setTimeout(
        () => sliceController.abort(new SourceReaderError('当前书源查询预算已用完，正在尝试下一个书源。', 'SOURCE_SCOPE_EXHAUSTED', 503)),
        options.sliceMs ?? PER_SOURCE_SLICE_MS,
      );
      (timer as { unref?: () => void }).unref?.();
      if (this.signal.aborted) clearTimeout(timer);
      else this.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    }
  }

  /** 全局请求计数：父子共享，子 context 的请求同样计入且不回退（设计 §3.1）。 */
  get requests(): number { return this.budget.requests; }

  // 保留可写：既有消费方（source-verification 的共享预算判定/测试模拟）会直接回写计数。
  set requests(value: number) { this.budget.requests = value; }

  /** 全局兜底上限：openPool 只增不减地抬高它。 */
  get totalLimit(): number { return this.budget.totalLimit; }

  /** 软预算起点（M2-2 用 Date.now() − startedAt 与 SOFT_BUDGET_MS 比较）。 */
  get startedAt(): number { return this.budget.startedAt; }

  /** 池大小 → 全局兜底上限 min(30, max(12, 6×n))；幂等取最大值：failover 复用 context 时不得收窄。 */
  openPool(poolSize: number): void {
    const opened = Math.min(MAX_POOL_REQUESTS, Math.max(MAX_SOURCE_REQUESTS, PER_SOURCE_REQUESTS * poolSize));
    this.budget.totalLimit = Math.max(this.budget.totalLimit, opened);
  }

  /** 单源子 context：requests/节流槽共享，limit 与切片独立；signal = any([父 signal, 切片定时器])。 */
  child(scope: string, opts: { limit?: number; sliceMs?: number } = {}): SourceRequestContext {
    const sliceController = new AbortController();
    return new SourceRequestContext(AbortSignal.any([this.signal, sliceController.signal]), opts.limit ?? PER_SOURCE_REQUESTS, {
      budget: this.budget, scope, sliceMs: opts.sliceMs, sliceController,
    });
  }

  async page(url: string, attempts = MAX_SOURCE_ATTEMPTS): Promise<{ url: string; text: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.signal.throwIfAborted();
      try {
        return await fetchSourceText(url, {
          signal: this.signal,
          beforeRequest: async (signal) => {
            // L2 全局兜底：池预算用尽即停所有源（错误码与文案与今天逐字相同）。
            if (this.budget.requests >= this.budget.totalLimit) throw new SourceReaderError('书源查询预算已用完，请稍后重试或下载全书。', 'SOURCE_BUDGET_EXCEEDED', 503);
            // L1 单源点数：只放弃当前源（跳源），父/兄弟源的计数不回退；builtin 首源不受此闸门约束。
            if (this.scope !== BUILTIN_SCOPE && this.scoped.used >= this.limit) throw new SourceReaderError('当前书源查询预算已用完，正在尝试下一个书源。', 'SOURCE_SCOPE_EXHAUSTED', 503);
            this.budget.requests++;
            this.scoped.used++;
            // 同步预占时间槽：并发调用各自拿到互不重叠的发射时刻，起始间隔恒为 SOURCE_DELAY_MS。
            // 若像以前那样在 await 之后才写回 nextRequestAt，多个并发 page() 会读到同一个旧值、
            // 一起免等、一起发射，节流对源站失效。槽位在父子 context 间共享（M2 不做每 host 分桶）。
            const now = Date.now();
            const at = Math.max(now, this.budget.nextRequestAt);
            this.budget.nextRequestAt = at + SOURCE_DELAY_MS;
            if (at > now) await pause(at - now, signal);
          },
        });
      } catch (error) {
        this.signal.throwIfAborted();
        if (error instanceof SourcePolicyError || error instanceof SourceReaderError
          || (error instanceof SourceHttpError && error.status < 500)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export interface SourceCatalog extends SourceBookIdentity {
  sourceUrl: string;
  sourceName: string;
  sourceRevision: string;
  bookUrl: string;
  sourceId: string;
  version: string;
  chapters: SourceChapter[];
}

const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
// 目录版本口径的唯一实现在 source-revision.ts（与 admission.rules_hash 同源，M1 任务3 复审 P1-1）。
// 引擎源的 version 用 rule-engine-v1 前缀与 builtin 区分（设计 §7.2）。
const ENGINE_PARSER_VERSION = 'rule-engine-v1';

/** builtin 档走 source-parser 站点特化路径；引擎档（M1/T7，rules 非空）走 rule-engine 门面。 */
function isBuiltinReadingSource(source: ReadingSource): boolean {
  return source.tier === 'builtin' || !source.rules || Object.keys(source.rules).length === 0;
}

function engineSourceOf(source: ReadingSource): EngineSource {
  return {
    url: source.url, name: source.name,
    searchUrl: typeof source.searchUrl === 'string' ? source.searchUrl : '',
    compiled: compileSource({ url: source.url, searchUrl: source.searchUrl, rules: source.rules }),
  };
}

/** 引擎源目录构造：与 catalogFrom 同构，version 用 ENGINE_PARSER_VERSION 区分（设计 §7.2）。 */
function engineCatalogFrom(
  pageUrl: string, source: ReadingSource, identity: SourceBookIdentity, chapters: SourceChapter[],
): SourceCatalog {
  const sourceId = hash([source.url, pageUrl]);
  const revisionValue = sourceRevision(source);
  return {
    ...identity, sourceUrl: source.url, sourceName: source.name, sourceRevision: revisionValue, bookUrl: pageUrl,
    sourceId, version: hash([ENGINE_PARSER_VERSION, sourceId, revisionValue, identity, chapters]), chapters,
  };
}

// ---- 只读观测（不改行为）：生产 404 零日志无法定位「空页 / 反爬页 / 解析错」----
// 只输出 host、URL、字节数、计数、书名等非敏感字段；绝不输出 Cookie/Authorization/整页 HTML。
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function stripHash(url: string): string {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return url; }
}

// 反爬/挑战页的常见标记，语汇沿用 src/lib/llm.ts:491-492（`Just a moment` / `challenge-platform`），
// 补 Cloudflare「Attention Required」、瑞数 ge_js_validator、cf-chl 挑战资源。
const CHALLENGE_HINTS = [
  'just a moment', 'cf-mitigated', 'attention required', 'ge_js_validator',
  'challenge-platform', 'cf-chl', 'enable javascript and cookies to continue',
];

/** 页内是否疑似反爬挑战页；只读判定，不影响控制流。空响应不算挑战页（bytes 字段已单独体现）。 */
function hasChallengeHint(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (CHALLENGE_HINTS.some((hint) => lower.includes(hint))) return true;
  // 空壳 + script：正文极短却带脚本，常见于 JS 挑战页（真实目录页远大于此）。
  return text.length < 1024 && /<script\b/i.test(text);
}

// candidates = **精确层**（parseSourceSearch 锚文本相等）命中数；fallbackCandidates = 精确层收 0 后
// 按详情页形态从同页兜到的数。两者分开记：「搜索页有结果却 0 候选」这个 P0 信号靠 candidates 表达，
// 混成一个数会让它失效（40 任审查 D）。
interface SourceSearchStat { host: string; searched: boolean; candidates: number; fallbackCandidates: number; bytes: number }


async function queryRows<T>(query: ReturnType<ReturnType<typeof getSql>>, signal: AbortSignal, readOnly = true): Promise<T[]> {
  signal.throwIfAborted();
  const [rows] = await sourceAbortable(getSql().transaction([query], { readOnly, fetchOptions: { signal } }), signal);
  signal.throwIfAborted();
  return rows as T[];
}

async function hintsFor(book: SourceBookIdentity, signal: AbortSignal): Promise<string[]> {
  const sql = getSql();
  const rows = await queryRows<SourceBookIdentity & { source_url: string }>(sql`
    SELECT title, author, source_url FROM labeled_books
    WHERE lower(btrim(title)) = lower(${book.title.trim()}) LIMIT 6`, signal);
  return rows.filter((row) => sourceBookMatches(book, row)).flatMap((row) => {
    try { return [validateSourceUrl(row.source_url).href]; } catch { return []; }
  });
}

function catalogFrom(page: { text: string; url: string }, source: ReadingSource, expected: SourceBookIdentity): SourceCatalog | null {
  const identity = parseSourceIdentity(page.text);
  if (identity.title.length > 200 || identity.author.length > 200
    || (identity.alias?.length ?? 0) > 200 || !sourceBookMatches(expected, identity)) return null;
  const chapters = parseSourceChapters(page.text, page.url);
  if (!chapters.length) return null;
  const sourceId = hash([source.url, page.url]);
  const revisionValue = sourceRevision(source);
  return {
    ...identity, sourceUrl: source.url, sourceName: source.name, sourceRevision: revisionValue, bookUrl: page.url,
    sourceId, version: hash([PARSER_VERSION, sourceId, revisionValue, identity, chapters]), chapters,
  };
}

// 详情页 → 可展示的模糊候选；不套 sourceBookMatches（标题/作者放宽正是这一层的语义），
// 只保留结构性防御（长度、目录可解析）。
function similarCandidateFrom(page: { text: string; url: string }): SourceSimilarCandidate | null {
  const identity = parseSourceIdentity(page.text);
  if (identity.title.length > 200 || identity.author.length > 200
    || (identity.alias?.length ?? 0) > 200 || !identity.title) return null;
  const chapters = parseSourceChapters(page.text, page.url);
  if (!chapters.length) return null;
  return { ...identity, chapters: chapters.length, bookUrl: page.url };
}

// 用户点选确认后的目录构建：身份校验让位于用户决定，仍要求目录可解析。
function confirmedCatalogFrom(page: { text: string; url: string }, source: ReadingSource): SourceCatalog | null {
  const identity = parseSourceIdentity(page.text);
  if (identity.title.length > 200 || identity.author.length > 200
    || (identity.alias?.length ?? 0) > 200 || !identity.title) return null;
  const chapters = parseSourceChapters(page.text, page.url);
  if (!chapters.length) return null;
  const sourceId = hash([source.url, page.url]);
  const revisionValue = sourceRevision(source);
  return {
    ...identity, sourceUrl: source.url, sourceName: source.name, sourceRevision: revisionValue, bookUrl: page.url,
    sourceId, version: hash([PARSER_VERSION, sourceId, revisionValue, identity, chapters]), chapters,
  };
}

function rankSimilarCandidates(expected: SourceBookIdentity, found: SourceSimilarCandidate[]): SourceSimilarCandidate[] {
  return found
    .map((candidate) => ({ candidate, tier: sourceTitleSimilarity(expected.title, candidate) }))
    .filter(({ tier }) => Number.isFinite(tier))
    .sort((a, b) => a.tier - b.tier
      || sourceTitleSimilarity(expected.title, { title: a.candidate.title, author: a.candidate.author })
        - sourceTitleSimilarity(expected.title, { title: b.candidate.title, author: b.candidate.author })
      || b.candidate.chapters - a.candidate.chapters)
    .slice(0, MAX_SIMILAR_CANDIDATES)
    .map(({ candidate }) => candidate);
}

/**
 * 洞 3:换源时把**当前源**(含同站备用 host)的候选降到队尾 —— 稳定重排,其余保持原有优先级。
 * 不是绝对禁止:全网只剩同站候选时它仍能被选到,只是排在最后,避免「同站换 URL 不换站」原地打转。
 */
function deprioritizeSource(sources: ReadingSource[], url: string | undefined): ReadingSource[] {
  if (!url) return sources;
  const host = hostOf(url);
  if (!host) return sources;
  const current: ReadingSource[] = [];
  const rest: ReadingSource[] = [];
  for (const source of sources) {
    const sourceHost = hostOf(source.url);
    const sameStation = sourceHost === host || (sourceHost.length > 0 && alternateSourceHost(host) === sourceHost);
    (sameStation ? current : rest).push(source);
  }
  return current.length && rest.length ? [...rest, ...current] : sources;
}

/** Search/detail validation only; never fetches chapter text or evaluates source rules. */
export async function resolveSourceBook(
  book: SourceBookIdentity,
  context: SourceRequestContext,
  options: { excludeBookUrl?: string; sources?: ReadingSource[]; preferAfterSourceUrl?: string; bookUrl?: string } = {},
): Promise<SourceCatalog> {
  const sources = deprioritizeSource(
    options.sources ?? await getReadingSources(context.signal), options.preferAfterSourceUrl,
  );
  // 用户在前端候选列表里点选后的确认路径：URL 即用户决定，跳过书名/作者校验，
  // 只保留结构性防御（域名白名单在 validateSourceUrl、目录可解析、非 excludeBookUrl）。
  if (options.bookUrl) {
    const url = validateSourceUrl(options.bookUrl).href;
    if (url === options.excludeBookUrl) throw new SourceReaderError('该书源已失效，请重新搜索。', 'SOURCE_NOT_FOUND', 404);
    // 源归属按 host 反查（m2-scaleout §3.7 的铺路）：池内匹配 bookUrl 的 host，避免用
    // builtin 的 url 给引擎源的 bookUrl 算 sourceId/revision。匹配不到保持既有 sources[0]
    // 回退（单源池下等价），M2 收紧为 404。
    const targetHost = hostOf(url);
    const source = sources.find((item) => {
      const host = hostOf(item.url);
      // 同站备用 host（book15.net ↔ www.book15.net，fetch 层换 host 兜底）视为同一个源。
      return host === targetHost || (host.length > 0 && alternateSourceHost(targetHost) === host);
    });
    // 匹配不到 → 404 让用户重新选择（设计 §3.7：不猜、不回退 sources[0]，避免源标识错配）。
    if (!source) throw new SourceReaderError('没有找到该候选对应的可用书源，请重新搜索。', 'SOURCE_NOT_FOUND', 404);
    if (!isBuiltinReadingSource(source)) {
      // 用户点选即用户决定：跳过书名/作者校验，只保留结构性防御与目录可解析（沿用现有语义）。
      const engineSource = engineSourceOf(source);
      const detail = await engineFetchDetail(engineSource, url, context);
      const toc = detail.title ? await engineFetchToc(engineSource, detail.tocUrl ?? url, context) : { chapters: [] };
      if (!detail.title || !toc.chapters.length) {
        throw new SourceReaderError('用户选择的书源无法建立目录，请重试或换一个候选。', 'SOURCE_NOT_FOUND', 404);
      }
      return engineCatalogFrom(url, source, {
        title: detail.title, author: detail.author ?? '', ...(detail.alias ? { alias: detail.alias } : {}),
      }, toc.chapters);
    }
    const confirmed = confirmedCatalogFrom(await context.page(url), source);
    if (!confirmed) throw new SourceReaderError('用户选择的书源无法建立目录，请重试或换一个候选。', 'SOURCE_NOT_FOUND', 404);
    return confirmed;
  }
  // 池预算（设计 §3.1）：只有池里真的含引擎源时才抬高全局兜底上限。builtin-only 池保持
  // 今日预算语义逐点不变（零回归红线）；confirm 路径已在上面 return，不进入这里（§3.7）。
  if (sources.some((source) => !isBuiltinReadingSource(source))) context.openPool(sources.length);
  const hints = await hintsFor(book, context.signal);
  let hadFailure = false;
  const checked = new Set<string>();
  const matches = new Map<string, SourceCatalog>();
  const similar = new Map<string, SourceSimilarCandidate>();
  const collectSimilar = (page: { text: string; url: string }) => {
    const candidate = similarCandidateFrom(page);
    if (candidate) similar.set(candidate.bookUrl, candidate);
  };
  // 只读观测账本：逐源记录「搜没搜、命中几候选、多少字节」，供整轮 404 汇总（不改控制流）。
  const searchStats: SourceSearchStat[] = [];
  // 「精确层 0 候选」观测：抓到搜索页却锚文本无一精确命中。**推迟到整轮无果时才发**——
  // 曾经在精确层一收 0 就无条件发，随后同页兜底 / 作者搜索成功交付时这条告警已经在成功路径上
  // 打过了，监控按「无候选」告警会误报（41 任审查 P2-①）。payload 在收集时就序列化好，顺序即源序。
  const pendingNoCandidateWarnings: string[] = [];
  let index = 0;
  for (const source of sources) {
    const isFirst = index === 0;
    index += 1;
    // 软预算 + 切片余量两段式判据（设计 §3.2）：只从第 2 个源起生效，builtin 首源不受约束。
    // 剩余不足一片切片就不开新源——那次源注定被切片砍掉，只白白消耗墙钟与已扣点数。
    // 判据与常量都在实现里（elapsed + slice > soft ⇔ remaining < slice），测试只做两侧反向断言。
    if (!isFirst && SOFT_BUDGET_MS - (Date.now() - context.startedAt) < PER_SOURCE_SLICE_MS) {
      hadFailure = true;
      break;
    }
    // 首源沿用根 context；第 2 源起各自的 child（单源点数上限 + 切片定时器），requests/节流槽父子共享。
    const sourceContext = isFirst ? context : context.child(source.url);
    // 「整体中止」（父 deadline/取消 ⇒ route 504）只认父 signal：切片只 abort 子 signal（§3.3 陷阱）。
    context.signal.throwIfAborted();
    const stat: SourceSearchStat = { host: hostOf(source.url), searched: false, candidates: 0, fallbackCandidates: 0, bytes: 0 };
    searchStats.push(stat);
    try {
      // 引擎档分派（设计 §7.2）：rules 非空且非 builtin ⇒ 走 rule-engine 门面；
      // 只做「搜索→详情→目录 + 身份校验」，身份校验沿用 sourceBookMatches（留在调用方）。
      if (!isBuiltinReadingSource(source)) {
        const engineSource = engineSourceOf(source);
        const results = await engineSearchBook(engineSource, book.title, sourceContext);
        stat.searched = true;
        stat.candidates = results.length;
        for (const result of results.slice(0, MAX_DETAIL_CANDIDATES)) {
          if (result.bookUrl === options.excludeBookUrl || checked.has(source.url + result.bookUrl)) continue;
          checked.add(source.url + result.bookUrl);
          try {
            const detail = await engineFetchDetail(engineSource, result.bookUrl, sourceContext);
            const identity: SourceBookIdentity = {
              title: detail.title ?? result.title, author: detail.author ?? result.author,
              ...(detail.alias ? { alias: detail.alias } : {}),
            };
            // 引擎只解释规则，不判断「这是不是那本书」——identity 是业务语义，留在调用方（§7.2）。
            if (!sourceBookMatches(book, identity)) continue;
            const toc = await engineFetchToc(engineSource, detail.tocUrl ?? result.bookUrl, sourceContext);
            if (!toc.chapters.length) continue;
            const catalog = engineCatalogFrom(result.bookUrl, source, identity, toc.chapters);
            matches.set(catalog.bookUrl, catalog);
            if (knownSourceAuthor(book.author)) return catalog;
          } catch (error) {
            context.signal.throwIfAborted();
            if (error instanceof SourceReaderError) {
              // 全局兜底耗尽 ⇒ 交给外层统一 break（保留已收集，走既有 503 分桶）。
              if (error.code === 'SOURCE_BUDGET_EXCEEDED') throw error;
              // 单源点数/切片耗尽 ⇒ 该源本轮放弃，跳下一个源（hadFailure 置位，空结果最终 503 不 404）。
              if (error.code === 'SOURCE_SCOPE_EXHAUSTED') { hadFailure = true; break; }
              throw error;
            }
            hadFailure = true;
          }
        }
        continue;
      }
      // Known metadata links save a source search but still require live identity checks.
      const inspect = async (urls: string[], collectFuzzy = false): Promise<SourceCatalog | undefined> => {
        if (urls.length > MAX_DETAIL_CANDIDATES && !knownSourceAuthor(book.author)) {
          throw new SourceReaderError('同名作品过多，请补全作者后再阅读。', 'SOURCE_AMBIGUOUS', 422);
        }
        for (const url of urls.slice(0, MAX_DETAIL_CANDIDATES)) {
          if (url === options.excludeBookUrl || checked.has(source.url + url)) continue;
          checked.add(source.url + url);
          try {
            const page = await sourceContext.page(url);
            const catalog = catalogFrom(page, source, book);
            if (catalog) {
              matches.set(catalog.bookUrl, catalog);
              if (knownSourceAuthor(book.author)) return catalog;
            } else if (collectFuzzy) {
              // 标题/别名没对上（或作者不符）的详情页：模糊层不丢弃，留作用户候选。
              collectSimilar(page);
            }
          } catch (error) {
            context.signal.throwIfAborted();
            // 预算是全部源共享的：耗尽即停止请求，保留已收集的匹配/候选。
            if (error instanceof SourceReaderError) {
              if (error.code === 'SOURCE_BUDGET_EXCEEDED') {
                // 预算耗尽=搜索不完整，空结果仍 503；有结果不受影响已被去闸门放行。
                hadFailure = true;
                break;
              }
              throw error;
            }
            hadFailure = true;
          }
        }
      };
      const hinted = await inspect(hints);
      if (hinted) return hinted;
      const search = await sourceContext.page(sourceSearchUrl(source.searchUrl, book.title, source.url));
      let candidates: string[] = [];
      // 标题搜索页的**精确层**（parseSourceSearch 锚文本相等）是否收 0 候选。作者搜索回退判的是这个，
      // **不是** candidates 是否为空 —— 同页形态兜底会把无关详情链接填进 candidates，拿它当判据
      // 等于把「改名书」（站点索引只有新名）唯一的救命路径关掉（40 任实测 + 审查 A）。
      let exactLayerEmpty = false;
      stat.searched = true;
      stat.bytes = search.text.length;
      if (/^\/books\/details\d+\.html$/.test(new URL(search.url).pathname) && search.url !== options.excludeBookUrl) {
        const direct = catalogFrom(search, source, book);
        if (direct) {
          if (knownSourceAuthor(book.author)) return direct;
          matches.set(direct.bookUrl, direct);
        } else {
          collectSimilar(search);
        }
      } else {
        const exact = parseSourceSearch(search.text, search.url, book.title);
        exactLayerEmpty = !exact.length;
        // 搜索页抓取成功(无异常)却一个可核验候选都没有 —— 区分「空页 / 反爬页 / 解析错」。
        // 候选收集两级:parseSourceSearch 仍按锚文本精确相等取(收 0 个时打下面这条观测);
        // 再从同一页按详情页形态兜一轮 —— book15 把「图片链接 + 标题链接 + 阅读小说链接」三份
        // 重复指向同一详情页,锚文本带修饰(【完结】书名 / 空白标点差异)时精确层会全丢。
        // 兜底只放宽「候选收集」:身份判定仍是详情页层的 sourceBookMatches(标题/别名 + 作者门),
        // 误配防线原地不动。两轮都走 inspect 的同一个 MAX_DETAIL_CANDIDATES 切片,不增请求上限。
        // 兜底**不**改变作者搜索回退的判据(见上面 exactLayerEmpty):兜底捡到的无关详情链接
        // 只表示「同页有别的书」,不代表「这本书不在本站」。
        if (!exact.length) {
          // 只**登记**，不发：见上方 pendingNoCandidateWarnings 的语义说明（成功交付路径不得误报）。
          pendingNoCandidateWarnings.push(JSON.stringify({
            event: 'search_no_candidates',
            sourceHost: stat.host,
            searchUrl: stripHash(search.url),
            bytes: search.text.length,
            candidateCount: 0,
            title: book.title,
            hadChallengeHint: hasChallengeHint(search.text),
          }));
        }
        const fallback = exact.length ? [] : parseSourceDetailLinks(search.text, search.url, book.title);
        candidates = exact.length ? exact : fallback;
        // 观测账本分开记:混成一个数会让「搜索页有结果却 0 候选」这个 P0 信号失效。
        stat.candidates = exact.length;
        stat.fallbackCandidates = fallback.length;
      }
      // 无重叠最坏构成（41 任审查 P2-②）：标题搜索 1 + 同页兜底 4 + 作者搜索 1 + 作者层 inspect 4
      // + 模糊补抓 2 = 12，恰好顶到全局上限、没有任何余量。一旦库 hints（最多 4 次）或任意 5xx
      // 触发 MAX_SOURCE_ATTEMPTS=2 重试把计数抬高，作者层 inspect 会在途中被 L2 掐断 ⇒ hadFailure
      // ⇒ 用户见 503，而真书明明还在作者页后段（41 任 PROBE_B 实测复现：details903 从未被抓）。
      // 修正：作者回退**即将运行**时，标题页兜底这轮 speculative inspect 不得吃掉作者层所需的预算，
      // 预留「作者搜索 1 + 作者层 inspect MAX_DETAIL_CANDIDATES」。精确层命中（exactLayerEmpty=false）
      // 或无需作者回退时不设此限，既有请求构成逐点不变（零回归）。
      const authorFallbackPending = (exactLayerEmpty || !candidates.length)
        && knownSourceAuthor(book.author) && knownSourceAuthor(book.author) !== normalizeSourceTitle(book.title);
      const reserveForAuthor = 1 + MAX_DETAIL_CANDIDATES;
      const fallbackWidth = authorFallbackPending
        ? Math.max(0, Math.min(MAX_DETAIL_CANDIDATES, context.totalLimit - context.requests - reserveForAuthor))
        : MAX_DETAIL_CANDIDATES;
      const result = await inspect(candidates.slice(0, fallbackWidth), true);
      if (result) return result;
      // 作者搜索回退:标题搜索页的**精确层** 0 候选(搜索页可能仍吐一堆无关详情链接)、有作者可搜
      // 且作者不是书名本身时(改名书的站点索引只有新名),改搜作者。候选不看锚文本,
      // 身份靠详情页的标题/别名 + 作者门校验。
      // `!candidates.length` 保留给「搜索 URL 本身就是详情页」那一支的既有语义。
      if (authorFallbackPending) {
        const authorSearch = await sourceContext.page(sourceSearchUrl(source.searchUrl, book.author, source.url));
        const authorCandidates = /^\/books\/details\d+\.html$/.test(new URL(authorSearch.url).pathname)
          ? [authorSearch.url]
          : parseSourceDetailLinks(authorSearch.text, authorSearch.url, book.title);
        const authorResult = await inspect(authorCandidates, true);
        if (authorResult) return authorResult;
        // 模糊层收集面 b)：作者搜索里 L1/L2 未消费过的其余详情页候选。
        // 可选层限量：只再补 MAX_SIMILAR_PAGES 页，纯为凑候选不值得放大请求；
        // 预算余量不足时 SourceRequestContext 会抛 SOURCE_BUDGET_EXCEEDED，停止收集即可。
        for (const url of authorCandidates.slice(MAX_DETAIL_CANDIDATES, MAX_DETAIL_CANDIDATES + MAX_SIMILAR_PAGES)) {
          if (checked.has(source.url + url) || url === options.excludeBookUrl) continue;
          try {
            // 可选请求不重试（attempts=1）：一次抖动不应吃掉 2 点预算 + 2×8s。
            collectSimilar(await sourceContext.page(url, 1));
          } catch (error) {
            context.signal.throwIfAborted();
            if (error instanceof SourceReaderError && error.code === 'SOURCE_BUDGET_EXCEEDED') break;
            // 可选层失败不记账：只有决定「这本书在不在」的关键路径失败才算 partial，
            // 为凑候选而失败的抓取不否决任何东西。
          }
        }
      }
    } catch (error) {
      context.signal.throwIfAborted();
      // 预算是全部源共享的：耗尽即停止请求，保留已有匹配/候选（与上方 break 语义对齐）。
      if (error instanceof SourceReaderError) {
        if (error.code === 'SOURCE_BUDGET_EXCEEDED') {
          // 预算耗尽=搜索不完整，空结果仍 503；有结果不受影响已被去闸门放行。
          hadFailure = true;
          break;
        }
        if (error.code === 'SOURCE_SCOPE_EXHAUSTED') {
          // 单源点数/切片耗尽=跳源（设计 §3.3）：置 hadFailure（空结果 ⇒ 503 而非 404），继续下一个源。
          hadFailure = true;
          continue;
        }
        throw error;
      }
      hadFailure = true;
    }
  }
  // 跨源同名去重（设计 §3.6）：无作者书里「同标题同作者」的跨源命中是同一本书的不同来源，
  // 只保留源优先级最高的首条（Map 插入序=源序），交给 M3 换源；「同标题不同作者」仍计入 ⇒ 保留 422。
  // 池=1 时不启用：单源内同键重复条目是该源的**真实歧义**，保持既有 422 语义（零回归红线）。
  if (sources.length > 1 && !knownSourceAuthor(book.author) && matches.size > 1) {
    const unique = new Map<string, SourceCatalog>();
    for (const catalog of matches.values()) {
      const key = normalizeSourceTitle(catalog.title) + '|' + knownSourceAuthor(catalog.author);
      if (!unique.has(key)) unique.set(key, catalog);
    }
    matches.clear();
    for (const [key, catalog] of unique) matches.set(key, catalog);
  }
  if (matches.size > 1) throw new SourceReaderError('找到多部同名作品，请补全作者后再阅读。', 'SOURCE_AMBIGUOUS', 422);
  // 无作者书的唯一匹配照常交付：接受「部分搜索下的唯一性风险」（生产无作者书 0-1 本，交付优于拒付；
  // 搜索不完整只意味着可能漏掉第二个匹配，交给 SOURCE_AMBIGUOUS 的多匹配档兜底，参照 legado 换源行为：
  // 单源失败绝不影响整体判定）。有作者书的命中在 :206/:225 提前返回，不受此处影响。
  if (matches.size === 1) return [...matches.values()][0];
  // 模糊降级层：精确/别名/作者回退都没命中，但抓到过相似的详情页 ⇒ 交给用户选，不再 404。
  // 候选层语义就是「不确定交给用户」，不能用「搜索不完整」否决它（那会剥夺用户自救手段）。
  const ranked = rankSimilarCandidates(book, [...similar.values()]);
  if (ranked.length) {
    const message = hadFailure
      ? `没有完全匹配的书源，但找到 ${ranked.length} 个相似结果，请确认后阅读。（部分请求本轮未完成）`
      : `没有完全匹配的书源，但找到 ${ranked.length} 个相似结果，请确认后阅读。`;
    const error = new SourceReaderError(message, 'SOURCE_SIMILAR', 422) as SourceReaderError & { candidates?: SourceSimilarCandidate[] };
    error.candidates = ranked;
    throw error;
  }
  // 整轮结束仍 404（所有抓取成功、只是没有匹配）时的汇总观测：一次带出「哪些源、搜没搜、命中几候选、多少字节」。
  // 只在 SOURCE_NOT_FOUND 触发，不覆盖 hadFailure/预算耗尽（那是 SOURCE_UNAVAILABLE）。
  if (!hadFailure) {
    console.warn('[read-source] source_not_found', JSON.stringify({
      event: 'source_not_found',
      title: book.title,
      sourcesTried: searchStats.length,
      perSource: searchStats,
    }));
  }
  // 整轮无果（既没交付目录、也没走 SOURCE_SIMILAR/SOURCE_AMBIGUOUS）才发「精确层 0 候选」观测：
  // 兜底 / 作者回退成功交付的路径在上面已 return，永不到这里 ⇒ 成功路径不再误报（P2-①）。
  for (const payload of pendingNoCandidateWarnings) {
    console.warn('[read-source] search_no_candidates', payload);
  }
  throw new SourceReaderError(
    hadFailure ? '书源暂时无法提供这本书，请稍后重试，也可返回书库尝试「下载全书」。' : '没有找到书名和作者相符的可读书源，可返回书库尝试「下载全书」。',
    hadFailure ? 'SOURCE_UNAVAILABLE' : 'SOURCE_NOT_FOUND', hadFailure ? 503 : 404,
  );
}

export async function saveSourceCatalog(catalog: SourceCatalog, signal: AbortSignal): Promise<void> {
  const sql = getSql();
  // Immutable directory versions: delayed requests cannot replace newer catalogs.
  await queryRows(sql`
    INSERT INTO source_read_catalogs (id, payload, expires_at)
    VALUES (${catalog.version}, ${JSON.stringify(catalog)}::jsonb, now() + interval '24 hours')
    ON CONFLICT (id) DO UPDATE SET expires_at = GREATEST(source_read_catalogs.expires_at, EXCLUDED.expires_at)`, signal, false);
  await queryRows(sql`DELETE FROM source_read_catalogs WHERE expires_at < now()`, signal, false);
}

export function sourceReaderIndex(catalog: SourceCatalog): ReaderIndex {
  const index: ReaderIndex = {
    taskId: null, title: catalog.title, author: catalog.author, version: catalog.version, totalBytes: 0,
    source: { id: catalog.sourceId, name: catalog.sourceName, url: catalog.bookUrl, session: catalog.version },
    chapters: catalog.chapters.map((chapter, index) => ({ index, title: chapter.title, startByte: 0, endByte: 0, partCount: 1 })),
  };
  if (Buffer.byteLength(JSON.stringify(index), 'utf8') > 4 * 1024 * 1024) {
    throw new SourceReaderError('章节目录过大，请尝试下载全书。', 'SOURCE_DIRECTORY_TOO_LARGE', 422);
  }
  return index;
}

async function loadSourceCatalog(session: string, context: SourceRequestContext): Promise<LoadedSource> {
  const sql = getSql();
  const [row] = await queryRows<{ payload: SourceCatalog }>(sql`
    SELECT payload FROM source_read_catalogs WHERE id = ${session} AND expires_at > now()`, context.signal);
  if (!row) throw new SourceReaderError('阅读目录已过期,请重新加载目录。', 'SOURCE_SESSION_EXPIRED', 409);
  const catalog = row.payload;
  const sources = await getReadingSources(context.signal);
  // N01:revision 校验用 find() 把命中的源带出供 chapterText 分派(零额外查询)。
  // 旧实现在找不到时抛 SOURCE_CHANGED(409):源记录一刷新(改名/改规则),在途读者的
  // 旧 catalog 全书 409,只能手点「重新加载目录」自救。现在两档降级(洞 1):
  // 1) url+revision 精确相符 ⇒ 就是它;2) **同 URL 换版本**(revision 漂移)⇒ 复用池中当前记录,
  //    目录内容未变、源站未变,直接用当前规则继续读;3) 同 URL 也没了 ⇒ source=null,调用方换源。
  const source = sources.find((item) => item.url === catalog.sourceUrl && sourceRevision(item) === catalog.sourceRevision)
    ?? sources.find((item) => item.url === catalog.sourceUrl) ?? null;
  validateSourceUrl(catalog.bookUrl);
  return { catalog, source, sources };
}

const chapterCache = new Map<string, { text: string; servedFrom: string; expires: number; bytes: number }>();
let cacheBytes = 0;

/** 目录加载时随 catalog 一起带出的源归属（N01）：按 builtin/engine 分派正文提取。 */
interface LoadedSource {
  catalog: SourceCatalog;
  /** 与目录 revision 精确相符的当前源;null = 已停用或规则漂移(调用方走换源)。 */
  source: ReadingSource | null;
  /** 目录加载时的池快照:章节级 failover 复用(备用的源标识必在同一快照内,确定性反查)。 */
  sources: ReadingSource[];
}

async function chapterText(context: SourceRequestContext, chapter: SourceChapter, source: ReadingSource): Promise<string> {
  // N01 分派：builtin 走 book15 特化解析（逐字不变）；引擎档走 rule-engine 取正文。
  // 取页两侧都经 context.page ⇒ 预算/节流/重试层沿用；builtin 分支零行为变化。
  if (isBuiltinReadingSource(source)) {
    const page = await context.page(chapter.url);
    if (new URL(page.url).pathname !== new URL(chapter.url).pathname) throw new SourcePolicyError('章节跳转到了另一页面');
    return parseSourceChapterText(page.text, chapter.title);
  }
  const { text } = await engineFetchContent(engineSourceOf(source), chapter.url, context);
  // 引擎只解释规则不做内容判定：builtin 的两道内容闸（空正文 / 单章限长）在这里补齐，
  // 错误语义与 builtin 对齐（同样落入章节级 failover，最终 SOURCE_CHAPTER_UNAVAILABLE 不变）。
  if (!text) throw new SourcePolicyError('书源未提供有效正文');
  if (text.length > MAX_SOURCE_CHAPTER_CHARACTERS) throw new SourcePolicyError('单章过长，请尝试下载全书');
  return text;
}

function remember(key: string, text: string, servedFrom: string) {
  const old = chapterCache.get(key);
  if (old) cacheBytes -= old.bytes;
  chapterCache.delete(key);
  const bytes = Buffer.byteLength(text, 'utf8');
  chapterCache.set(key, { text, servedFrom, expires: Date.now() + CHAPTER_CACHE_MS, bytes });
  cacheBytes += bytes;
  while (chapterCache.size > MAX_CACHE_CHAPTERS || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = chapterCache.keys().next().value!;
    cacheBytes -= chapterCache.get(oldest)!.bytes;
    chapterCache.delete(oldest);
  }
}

export async function readSourceChapter(session: string, chapterIndex: number, context: SourceRequestContext): Promise<ReaderPart> {
  // 目录会话与源池快照:不再因源身份漂移硬 409 —— 变化交给 loadSourceCatalog 区分后,这里按需换源。
  const { catalog, source, sources } = await loadSourceCatalog(session, context);
  const chapter = catalog.chapters[chapterIndex];
  if (!chapter) throw new SourceReaderError('章节不存在。', 'SOURCE_CHAPTER_INVALID', 400);
  const key = catalog.version + ':' + chapterIndex;
  const cached = chapterCache.get(key);
  let text = cached && cached.expires > Date.now() ? cached.text : '';
  let servedFrom = cached && cached.expires > Date.now() ? cached.servedFrom : (source?.name ?? catalog.sourceName);
  // 洞 1:当前源身份失效(池中已无同 URL 版本或源被停用)时不再抛 409,直接进换源;
  // 洞 2:换源成功即把本返回值换成新源的 version/sourceId,前端随之切目录、下一章直接用新源。
  let switched: Awaited<ReturnType<typeof switchSourceChapter>> | null = null;
  if (text) {
    // 暖缓存命中:正文与源状态无关,直接交付(不校验源身份,保持既有缓存语义)。
  } else if (!source) {
    context.signal.throwIfAborted();
    switched = await switchSourceChapter(catalog, chapter, chapterIndex, context, sources);
    text = switched.text;
    servedFrom = switched.sourceName;
  } else {
    try {
      text = await chapterText(context, chapter, source);
    } catch {
      // 章节正文失败(含源被停用/服务端判定失效):进换源流程。
      context.signal.throwIfAborted();
      switched = await switchSourceChapter(catalog, chapter, chapterIndex, context, sources);
      text = switched.text;
      servedFrom = switched.sourceName;
    }
  }
  remember(key, text, servedFrom);
  return {
    taskId: null, sourceId: switched?.sourceId ?? catalog.sourceId, servedFrom,
    version: switched?.version ?? catalog.version,
    // 洞 2:换源成功时带出新源的目录会话版本,前端据此把阅读目录切成新源,
    // 下一章直接用新源(不再每章从故障原源重试)。未换源时省略,响应体与既有逐字相同。
    ...(switched ? { sourceSession: switched.version } : {}),
    chapterIndex,
    partIndex: 0, partCount: 1, title: chapter.title, startByte: 0, endByte: Buffer.byteLength(text, 'utf8'), text,
  };
}

/**
 * 章节级换源:在同一池快照里找同书的另一个源,按标题对齐取回本章正文。
 * 返回备用源目录 + 正文 —— 调用方据此把 version/sourceId/servedFrom 换成新源(洞 2)。
 * 找不到(无备用源 / 备用源无同章)时抛既有的 SOURCE_CHAPTER_UNAVAILABLE(503)。
 */
async function switchSourceChapter(
  catalog: SourceCatalog, chapter: SourceChapter, chapterIndex: number,
  context: SourceRequestContext, sources: ReadingSource[],
): Promise<SourceCatalog & { text: string }> {
  try {
    // 池快照钉在目录加载时点(N01):备用源的 url+revision 必能在同一快照反查到 ReadingSource,
    // 避免读取瞬间源池变更导致备用源没有规则可分派;也省一次源池查询。
    // 洞 3:preferAfterSourceUrl 把当前源的同站候选降到队尾(不是绝对禁止 —— 全网只剩同站时仍可用)。
    const alternative = await resolveSourceBook(catalog, context, {
      excludeBookUrl: catalog.bookUrl, sources, preferAfterSourceUrl: catalog.sourceUrl,
    });
    // Never assume two catalogs have the same ordinal positions —— 章节按标题对齐:
    // 完全无关的章不得匹配,重名章取序号最接近当前章的一条(洞 4)。
    const alternativeIndex = matchSourceChapter(alternative.chapters, chapter.title, chapterIndex);
    if (alternativeIndex === null) throw new Error('No matching chapter in the alternative source');
    const alternativeSource = sources.find((item) => item.url === alternative.sourceUrl && sourceRevision(item) === alternative.sourceRevision);
    if (!alternativeSource) throw new Error('Alternative source not in pool snapshot');
    // 洞 2 的持久化半边:把备用源目录**落库**(与 index 路径同一张表/同一写入口),
    // 这样带回到前端的 sourceSession 才是可续读的会话 —— 下一章直接用它取数,
    // 不再每章回到故障原源重试。写失败按换源失败处理(fail-closed,仍 503)。
    await saveSourceCatalog(alternative, context.signal);
    const text = await chapterText(context, alternative.chapters[alternativeIndex], alternativeSource);
    return { ...alternative, text };
  } catch {
    context.signal.throwIfAborted();
    throw new SourceReaderError('本章暂不可读,备用书源也未找到相同章节。可重试或尝试「下载全书」。', 'SOURCE_CHAPTER_UNAVAILABLE', 503);
  }
}
