import { createHash } from 'node:crypto';
import { getSql } from './db';
import { getReadingSources, type ReadingSource } from './shuyuan';
import { fetchSourceText, sourceAbortable, SourceHttpError, SOURCE_TIMEOUT_MS } from './source-fetch';
import { SourcePolicyError, alternateSourceHost, validateSourceUrl } from './source-policy';
import { sourceRevision } from './source-revision';
import { orderByHostHealth } from './source-host-health';
import { normalizeBookTitle } from './book-identity';
import {
  engineFetchContent, engineFetchDetail, engineFetchToc, engineSearchBook, MAX_CONTENT_PAGES, type EngineSource,
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
// 章节级换源预算（41-M1.1 第二轮 / 41-M1.2）：候选 child 用默认单源点数 PER_SOURCE_REQUESTS
// （翻页、一次 5xx 重试、第二条搜索结果、作者回退都要点数）；切片按进展滑动（见 SourceSliceSlide）：
// 基准取 min(旋钮, 软预算余量)，每次成功请求顺延一个基准，目录与正文共用一片。名额只数「昂贵失败」：
// SOURCE_NOT_FOUND 不占。切片与名额这里是默认值，生效值走 sourceFailoverSliceMs() / sourceFailoverMaxAttempts()。
// 候选基准 12s：卡死的候选 12s 就放弃（当前源 12s + 两个卡死候选 24s 后，余量仍 ≥ 起跑门槛 8s，
// 第三个候选还能开跑）；一直在出数据的候选靠顺延不被砍；12s 也装得下 book15 候选
// 「apex 卡住 8s + 换 host 0.35s + www 一页 ≤3.6s ≈ 11.95s」这条救援路径。
export const SOURCE_FAILOVER_SLICE_MS = 12_000;
export const SOURCE_FAILOVER_MAX_ATTEMPTS = 3;
/** 软预算余量不足一次完整物理请求就不再开新候选，走 504 超时出口（partial：还有候选没试）；也是给原源兜底预留的时间。 */
export const SOURCE_FAILOVER_MIN_START_MS = SOURCE_TIMEOUT_MS;
/**
 * 当前源正文切片基准（41-M1.2）：12s = 一次卡住的请求（SOURCE_TIMEOUT_MS 8s）+ 换 host 退避 0.35s
 * + 另一 host 上实测最慢的一页（≤3.6s）≈ 11.95s，救援路径完整装得下。按进展滑动：多页正文每成功一页顺延一个基准，
 * 慢但一直在出数据的当前源不被砍，卡住 12s 没有进展才放弃、进换源。
 */
export const SOURCE_CURRENT_SLICE_MS = 12_000;
// 标定旋钮的钳位（误配兜底）：候选基准 [4s, 20s]，低于 4s 时一页正常的慢请求（详情页实测 ≤3.6s）加节流就可能被砍；
// 当前源基准 ≤ 20s，卡住的当前源至多占 20s、给换源留出 ≥ 25s 软预算（有进展时的顺延另受上限约束）；昂贵名额 ≤ 7。
const MIN_TUNED_FAILOVER_SLICE_MS = 4_000;
const MAX_TUNED_SLICE_MS = 20_000;
const MAX_TUNED_FAILOVER_ATTEMPTS = 7;
/** 根 context 的 scope：builtin 首源不受 L1 单源闸门约束（零回归的机械保证）。 */
export const BUILTIN_SCOPE = 'builtin';
const MAX_DETAIL_CANDIDATES = 4;
const MAX_SIMILAR_PAGES = 2;
const MAX_SIMILAR_CANDIDATES = 6;
const CHAPTER_CACHE_MS = 2 * 60_000;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_CHAPTERS = 24;
const PARSER_VERSION = 'book15-v1';

/** env 形状（宽松：process.env 与测试注入对象都可直接代入）。 */
type SourceTuningEnv = Record<string, string | undefined>;

// 换源标定旋钮（41-M1.1），写法同 admissionMaxProbes()：env 以参数注入便于单测；非法/≤0/缺失回退默认，
// 合法值钳到 [min, max]。不设 env 时与默认常量逐点相同。只调数值、不开关行为（行为开关属 M0，已定推后）。
function tunedValue(raw: string | undefined, fallback: number, max: number, min = 1): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(Math.max(parsed, min), max) : fallback;
}

/** 换源单候选切片基准：env `SOURCE_FAILOVER_SLICE_MS`，默认 12000，钳在 [4000, 20000]。 */
export function sourceFailoverSliceMs(env: SourceTuningEnv = process.env): number {
  return tunedValue(env.SOURCE_FAILOVER_SLICE_MS, SOURCE_FAILOVER_SLICE_MS, MAX_TUNED_SLICE_MS, MIN_TUNED_FAILOVER_SLICE_MS);
}

/** 换源昂贵名额：env `SOURCE_FAILOVER_MAX_ATTEMPTS`，默认 3，上限 7。 */
export function sourceFailoverMaxAttempts(env: SourceTuningEnv = process.env): number {
  return tunedValue(env.SOURCE_FAILOVER_MAX_ATTEMPTS, SOURCE_FAILOVER_MAX_ATTEMPTS, MAX_TUNED_FAILOVER_ATTEMPTS);
}

/** 当前源正文切片基准：env `SOURCE_CURRENT_SLICE_MS`，默认 12000，上限 20000。 */
export function sourceCurrentSliceMs(env: SourceTuningEnv = process.env): number {
  return tunedValue(env.SOURCE_CURRENT_SLICE_MS, SOURCE_CURRENT_SLICE_MS, MAX_TUNED_SLICE_MS);
}

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

/**
 * 按进展滑动的切片（41-M1.2）：本 context 或其子孙每完成一次**成功**的上游请求，切片截止时间顺延到
 * min(now + stepMs, until)，只延后不提前；失败、超时、被中止的请求不顺延。慢但一直在出数据的源不被砍，
 * 卡住的源在最后一次进展之后 stepMs 到点放弃。until 是绝对时刻（软预算终点减去要保留的兜底时间），
 * 顺延不会越过它。
 */
export interface SourceSliceSlide {
  stepMs: number;
  until: number;
}

interface SourceContextOptions {
  budget?: SharedSourceBudget;
  scope?: string;
  sliceMs?: number;
  sliceController?: AbortController;
  slide?: SourceSliceSlide;
  /** 进展逐级上报的上游 context（正文 context → 候选 context 共用一片滑动切片）。 */
  parent?: SourceRequestContext;
}

export class SourceRequestContext {
  /** 源归属：根 context 是 builtin，其余由 child(sourceUrl) 指定（M2-2 消费）。 */
  readonly scope: string;
  /** 本 scope 独立的点数上限；全局上限见 totalLimit。 */
  readonly limit: number;
  private readonly budget: SharedSourceBudget;
  // 本 scope 已扣点数：与 shared.requests 同步递增，但单独记账用于 L1 单源闸门判定。
  private readonly scoped = { used: 0 };
  private readonly parent?: SourceRequestContext;
  private readonly slide?: SourceSliceSlide;
  private sliceDeadline = Number.POSITIVE_INFINITY;
  private armSlice?: (deadline: number) => void;

  constructor(readonly signal: AbortSignal, limit = MAX_SOURCE_REQUESTS, options: SourceContextOptions = {}) {
    this.scope = options.scope ?? BUILTIN_SCOPE;
    this.limit = limit;
    // 根 context 的全局上限初值 = 构造 limit：不经 openPool 的调用路径（单独用 context(n)）行为逐点不变。
    // openPool 的调用点：resolveSourceBook（池里含引擎源时）、surveySourceBooks 开头、switchSourceChapter 开头，都只增不减。
    this.budget = options.budget ?? { requests: 0, nextRequestAt: 0, totalLimit: limit, startedAt: Date.now() };
    this.parent = options.parent;
    const sliceController = options.sliceController;
    if (sliceController) {
      // 单源切片：到点只 abort 子 signal（原因码 SOURCE_SCOPE_EXHAUSTED），父 signal 不受影响。
      // 滑动切片（slide）在每次进展时重新定时，截止时刻记在 sliceDeadline。
      this.slide = options.slide;
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.armSlice = (deadline) => {
        clearTimeout(timer);
        this.sliceDeadline = deadline;
        timer = setTimeout(
          () => sliceController.abort(new SourceReaderError('当前书源查询预算已用完，正在尝试下一个书源。', 'SOURCE_SCOPE_EXHAUSTED', 503)),
          Math.max(0, deadline - Date.now()),
        );
        (timer as { unref?: () => void }).unref?.();
      };
      this.armSlice(Date.now() + (options.sliceMs ?? PER_SOURCE_SLICE_MS));
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

  /** 池大小 → 全局兜底上限 min(30, max(12, 6×n))；幂等取最大值：同一请求里多次调用（整池 resolveSourceBook、章节级换源开头各一次）不得把已抬高的上限收窄。 */
  openPool(poolSize: number): void {
    const opened = Math.min(MAX_POOL_REQUESTS, Math.max(MAX_SOURCE_REQUESTS, PER_SOURCE_REQUESTS * poolSize));
    this.budget.totalLimit = Math.max(this.budget.totalLimit, opened);
  }

  /**
   * 单源子 context：requests/节流槽共享，limit 与切片独立；signal = any([父 signal, 切片定时器])。
   * slide 给定时切片按进展滑动；shareSlice 时不另起切片，signal 直接沿用父 context（与父共用同一片切片）。
   * 子 context 的进展一律逐级上报给父 context。
   */
  child(scope: string, opts: { limit?: number; sliceMs?: number; slide?: SourceSliceSlide; shareSlice?: boolean } = {}): SourceRequestContext {
    const limit = opts.limit ?? PER_SOURCE_REQUESTS;
    if (opts.shareSlice) return new SourceRequestContext(this.signal, limit, { budget: this.budget, scope, parent: this });
    const sliceController = new AbortController();
    return new SourceRequestContext(AbortSignal.any([this.signal, sliceController.signal]), limit, {
      budget: this.budget, scope, sliceMs: opts.sliceMs, sliceController, slide: opts.slide, parent: this,
    });
  }

  /** 一次成功的上游请求：滑动切片顺延（只延后、不越过 until），再逐级上报给父 context。 */
  private noteProgress(): void {
    if (this.slide && this.armSlice && !this.signal.aborted) {
      const next = Math.min(Date.now() + this.slide.stepMs, this.slide.until);
      if (next > this.sliceDeadline) this.armSlice(next);
    }
    this.parent?.noteProgress();
  }

  /**
   * 统一余量查询（review-42 MS-01/MS-17）：预留 reserve 点后，本 context 还能发出多少次 page()。
   * 两级预算取窄者回答：root（builtin 首源）只受 L2 全局闸门约束（totalLimit − requests，
   * openPool 抬高后随之放宽）；child 还要过 L1 单源闸门（limit − 本源已扣点数）。
   * **所有「为后续阶段预留预算」的计算必须走这里**，不得在调用方手写
   * totalLimit − requests —— 第 4 次预算补丁（13d00ad）就是在调用方手写、只看 root 视角，
   * 漏掉 child 的 L1 闸门，导致非首源的作者回退被单源预算掐断（review-42 MS-01）。
   * 调用方应传入**实际发请求的 context**（首源 = root，非首源 = 对应 child），而不是循环外的根 context。
   */
  remainingFor(reserve: number): number {
    const scoped = this.scope === BUILTIN_SCOPE
      ? Number.POSITIVE_INFINITY
      : this.limit - this.scoped.used;
    return Math.max(0, Math.min(this.budget.totalLimit - this.budget.requests, scoped) - reserve);
  }

  async page(url: string, attempts = MAX_SOURCE_ATTEMPTS): Promise<{ url: string; text: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.signal.throwIfAborted();
      try {
        const page = await fetchSourceText(url, {
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
        // 成功请求 = 源在出数据：滑动切片据此顺延。失败/超时/中止都走下面的 catch，不顺延。
        this.noteProgress();
        return page;
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
    WHERE title_key = ${normalizeBookTitle(book.title)} LIMIT 6`, signal);
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
 * 洞 3:把**当前源**(含同站备用 host)的候选降到队尾 —— 稳定重排,其余保持原有优先级;
 * 全网只剩同站候选时它们仍能被选到,只是排在最后,避免「同站换 URL 不换站」原地打转。
 * 章节级换源在此之上更严一格(见 switchSourceChapter):原源本身(同一 url)先不进队列,
 * 只有他源全部确认无此书时才作为最后一个候选带 excludeBookUrl 再试一次。
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
  options: {
    excludeBookUrl?: string; sources?: ReadingSource[]; preferAfterSourceUrl?: string; bookUrl?: string;
    /**
     * 内部选项：章节级换源逐个候选调用时置真 —— 收尾的 source_not_found / search_no_candidates 不在这里发，
     * 由换源结尾那一条 source_failover 聚合事件替代（否则每个 miss 候选各发一次，成功换源路径上也误报）。
     */
    deferNotFoundWarnings?: boolean;
  } = {},
): Promise<SourceCatalog> {
  // 41-M1.3：suspect 站（连续传输层硬失败，见 source-host-health.ts）挪到队尾，含 builtin 的 book15 hint 抓取；
  // 只降序不剔除，记忆为空时原样返回（顺序与改动前逐字节相同）。
  const sources = orderByHostHealth(deprioritizeSource(
    options.sources ?? await getReadingSources(context.signal), options.preferAfterSourceUrl,
  ));
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
              if (error.code === 'SOURCE_SCOPE_EXHAUSTED') {
                // 本源 L1 点数/切片耗尽（review-42 MS-01 修前症状的另一半）：作者层 inspect 与
                // 外层 sourceContext 同一个 scope，单源预算用尽即**本源**结束，不是整轮失败。
                // 旧行为直接 throw，在非首源上把改名书的作者页候选丢弃并跳源。这里记成跳源，
                // 让外层 SOURCE_SCOPE_EXHAUSTED 分支（:572）继续下一源，保留已收集的 similar 候选。
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
      // 余量统一走 remainingFor（review-42 MS-01/MS-17）：以**实际发请求的 sourceContext 视角**回答，
      // 首源=root 只看 L2，非首源=child 还要过 L1 单源闸门（取窄者）。第 4 次补丁（13d00ad）在调用方
      // 手写 context.totalLimit - context.requests（只看 root 视角），非首源上作者回退还没撞 L2 就先
      // 被 L1 掐断 ⇒ 改名书在第 2+ 个源上仍 503。
      const fallbackWidth = authorFallbackPending
        ? sourceContext.remainingFor(reserveForAuthor)
        : MAX_DETAIL_CANDIDATES;
      const result = await inspect(candidates.slice(0, Math.min(MAX_DETAIL_CANDIDATES, fallbackWidth)), true);
      if (result) return result;
      // 作者搜索回退:标题搜索页的**精确层** 0 候选(搜索页可能仍吐一堆无关详情链接)、有作者可搜
      // 且作者不是书名本身时(改名书的站点索引只有新名),改搜作者。候选不看锚文本,
      // 身份靠详情页的标题/别名 + 作者门校验。
      // `!candidates.length` 保留给「搜索 URL 本身就是详情页」那一支的既有语义。
      // 余量校验（review-42 MS-01）：作者搜索 1 点是硬需求，作者层 inspect 至少要能发出第 1 点
      // （真书常在作者页前段；后续候选由 inspect 内的 L1/L2 闸门自然封顶，不足整宽是降级不是失败）。
      // 本源连「作者搜索 + 首个详情」都发不出时跳过本轮作者回退 —— 强开的首个 page() 会抛预算码
      // （L1 单源耗尽或 L2 全局耗尽），被外层记成跳源/整轮失败，真书丢在作者页里。
      // 门槛取 min(1, 本源单源上限)：单源上限小于 2 的 child 不强开。
      if (authorFallbackPending && sourceContext.remainingFor(1) >= 1) {
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
  // deferNotFoundWarnings（章节级换源的逐候选调用）时两类收尾告警都不发，交给调用方的聚合事件。
  if (!hadFailure && !options.deferNotFoundWarnings) {
    console.warn('[read-source] source_not_found', JSON.stringify({
      event: 'source_not_found',
      title: book.title,
      sourcesTried: searchStats.length,
      perSource: searchStats,
    }));
  }
  // 整轮无果（既没交付目录、也没走 SOURCE_SIMILAR/SOURCE_AMBIGUOUS）才发「精确层 0 候选」观测：
  // 兜底 / 作者回退成功交付的路径在上面已 return，永不到这里 ⇒ 成功路径不再误报（P2-①）。
  if (!options.deferNotFoundWarnings) {
    for (const payload of pendingNoCandidateWarnings) {
      console.warn('[read-source] search_no_candidates', payload);
    }
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

// ---- M3 手动换源:可用源列表(survey)----
// 与 resolveSourceBook 的差异(设计 §3,† 标出):逐源扫描、每源**首命中即停**、
// 单源失败记 unreachable 继续下一源、跨源不去重、不做 knownSourceAuthor 提前返回、
// 不抛 422 SOURCE_AMBIGUOUS(多源同名正是本接口的目的)。不动既有函数。
const MAX_SURVEY_SOURCES = 6;

/** 换源面板的一行:每源一个候选(ok/miss/unreachable),current 标记当前在用源。 */
export interface SourceAlternateStatus {
  sourceName: string;
  status: 'ok' | 'miss' | 'unreachable';
  current?: boolean;
  // status === 'ok' 时:
  bookUrl?: string; title?: string; author?: string; chapters?: number;
}

/** 单源探测:首命中即返回该源候选;无命中返回 null(由调用方记 miss)。异常交给调用方记 unreachable。 */
async function surveyOneSource(
  book: SourceBookIdentity, source: ReadingSource, context: SourceRequestContext,
  hints: string[], excludeBookUrl: string | undefined,
): Promise<SourceAlternateStatus | null> {
  const checked = new Set<string>();
  const record = (catalog: SourceCatalog): SourceAlternateStatus => ({
    sourceName: source.name, status: 'ok', bookUrl: catalog.bookUrl,
    title: catalog.title, author: catalog.author, chapters: catalog.chapters.length,
  });
  if (!isBuiltinReadingSource(source)) {
    const engineSource = engineSourceOf(source);
    const results = await engineSearchBook(engineSource, book.title, context);
    for (const result of results.slice(0, MAX_DETAIL_CANDIDATES)) {
      if (result.bookUrl === excludeBookUrl || checked.has(result.bookUrl)) continue;
      checked.add(result.bookUrl);
      const detail = await engineFetchDetail(engineSource, result.bookUrl, context);
      const identity: SourceBookIdentity = {
        title: detail.title ?? result.title, author: detail.author ?? result.author,
        ...(detail.alias ? { alias: detail.alias } : {}),
      };
      if (!sourceBookMatches(book, identity)) continue;
      const toc = await engineFetchToc(engineSource, detail.tocUrl ?? result.bookUrl, context);
      if (!toc.chapters.length) continue;
      return record(engineCatalogFrom(result.bookUrl, source, identity, toc.chapters));
    }
    return null;
  }
  const inspect = async (urls: string[]): Promise<SourceCatalog | null> => {
    for (const url of urls.slice(0, MAX_DETAIL_CANDIDATES)) {
      if (url === excludeBookUrl || checked.has(url)) continue;
      checked.add(url);
      const catalog = catalogFrom(await context.page(url), source, book);
      if (catalog) return catalog;
    }
    return null;
  };
  const hinted = await inspect(hints);
  if (hinted) return record(hinted);
  const search = await context.page(sourceSearchUrl(source.searchUrl, book.title, source.url));
  let candidates: string[] = [];
  // 精确层(parseSourceSearch 锚文本相等)是否收 0 —— 与 resolveSourceBook(:486)同口径。
  // 作者搜索回退判的是这个,而不是「兜底后 candidates 是否为空」:同页兜底(parseSourceDetailLinks)
  // 捡到的无关详情链接只表示「本页有别的书」,不代表「本书不在本站」,不能据此拦掉作者回退(复审 P1-2)。
  let exactLayerEmpty = false;
  if (/^\/books\/details\d+\.html$/.test(new URL(search.url).pathname) && search.url !== excludeBookUrl) {
    const direct = catalogFrom(search, source, book);
    if (direct) return record(direct);
  } else {
    const exact = parseSourceSearch(search.text, search.url, book.title);
    exactLayerEmpty = !exact.length;
    candidates = exact.length ? exact : parseSourceDetailLinks(search.text, search.url, book.title);
  }
  const found = await inspect(candidates);
  if (found) return record(found);
  // 作者搜索回退(同 resolveSourceBook:精确层 0 候选 + 有独立作者可搜)。
  if ((exactLayerEmpty || !candidates.length) && knownSourceAuthor(book.author) && knownSourceAuthor(book.author) !== normalizeSourceTitle(book.title)) {
    const authorSearch = await context.page(sourceSearchUrl(source.searchUrl, book.author, source.url));
    const authorCandidates = /^\/books\/details\d+\.html$/.test(new URL(authorSearch.url).pathname)
      ? [authorSearch.url]
      : parseSourceDetailLinks(authorSearch.text, authorSearch.url, book.title);
    const authorResult = await inspect(authorCandidates);
    if (authorResult) return record(authorResult);
  }
  return null;
}

/**
 * 扫全池、每源一候选(设计 §3)。独立池上限 min(池, 6)(§9 开放问题 1,第一期即加)。
 * partial = true 当且仅当软预算/全局预算导致有源没被扫完。
 */
export async function surveySourceBooks(
  book: SourceBookIdentity,
  context: SourceRequestContext,
  options: { excludeBookUrl?: string; currentBookUrl?: string; currentSourceName?: string } = {},
): Promise<{ sources: SourceAlternateStatus[]; partial: boolean }> {
  const all = await getReadingSources(context.signal);
  const pool = all.slice(0, Math.min(all.length, MAX_SURVEY_SOURCES));
  // 无论池里是否含引擎源,都先开满池点数(复审 P2):引擎源同样占请求预算,
  // 只在「有引擎源时」才 openPool 会让纯内置源池的预算记账缺失。
  context.openPool(pool.length);
  const hints = await hintsFor(book, context.signal);
  const excludeBookUrl = options.excludeBookUrl ?? options.currentBookUrl;
  const results: SourceAlternateStatus[] = [];
  let partial = false;
  let index = 0;
  for (const source of pool) {
    const isFirst = index === 0;
    index += 1;
    // 软预算判据照抄 resolveSourceBook:只从第 2 源起生效;剩余不足一片切片就不开新源 ⇒ partial。
    if (!isFirst && SOFT_BUDGET_MS - (Date.now() - context.startedAt) < PER_SOURCE_SLICE_MS) {
      partial = true;
      break;
    }
    const sourceContext = isFirst ? context : context.child(source.url);
    context.signal.throwIfAborted();
    try {
      const found = await surveyOneSource(book, source, sourceContext, hints, excludeBookUrl);
      results.push(found ?? { sourceName: source.name, status: 'miss' });
    } catch (error) {
      context.signal.throwIfAborted();
      // 全局预算耗尽 ⇒ 停止整轮(partial);其余单源失败(网络/切片/点数)⇒ 记 unreachable 继续。
      if (error instanceof SourceReaderError && error.code === 'SOURCE_BUDGET_EXCEEDED') {
        partial = true;
        break;
      }
      results.push({ sourceName: source.name, status: 'unreachable' });
    }
  }
  // current 标记以 session 目录实况(sourceName)为准,与探测状态无关:当前源即便本轮 miss/unreachable
  // 也要标出来,面板才认得「哪个是我正在读的」。
  if (options.currentSourceName) {
    for (const entry of results) if (entry.sourceName === options.currentSourceName) entry.current = true;
  }
  return { sources: results, partial };
}

/** alternates 分支用:session 目录当前源信息;过期/缺失一律降级为无标记(设计 §2,不抛错)。 */
export async function currentSourceHint(
  session: string, context: SourceRequestContext,
): Promise<{ currentSourceName?: string; currentBookUrl?: string; catalog?: SourceCatalog }> {
  try {
    const [row] = await queryRows<{ payload: SourceCatalog }>(getSql()`
      SELECT payload FROM source_read_catalogs WHERE id = ${session} AND expires_at > now()`, context.signal);
    // catalog 一并带出:H7 换源响应要附新目录(route 层 attachSwitchedCatalog 复用本查询,零额外往返)。
    return row ? { currentSourceName: row.payload.sourceName, currentBookUrl: row.payload.bookUrl, catalog: row.payload } : {};
  } catch {
    context.signal.throwIfAborted();
    return {};
  }
}

/**
 * 引擎正文翻页的停止哨兵（41-PAGEFIX，legado BookContent.analyzeContent 同款）：下一章 URL；
 * 末章没有下一章时取第 0 章 URL（legado 同样回退到第 0 章，站点末章的「下一页」常回绕到首章）。
 */
function nextChapterUrlOf(chapters: SourceChapter[], index: number): string | undefined {
  return chapters[index + 1]?.url ?? chapters[0]?.url;
}

async function chapterText(
  context: SourceRequestContext, chapter: SourceChapter, source: ReadingSource, nextChapterUrl?: string,
): Promise<string> {
  // N01 分派：builtin 走 book15 特化解析（逐字不变）；引擎档走 rule-engine 取正文。
  // 取页两侧都经 context.page ⇒ 预算/节流/重试层沿用；builtin 分支零行为变化。
  if (isBuiltinReadingSource(source)) {
    const page = await context.page(chapter.url);
    if (new URL(page.url).pathname !== new URL(chapter.url).pathname) throw new SourcePolicyError('章节跳转到了另一页面');
    return parseSourceChapterText(page.text, chapter.title);
  }
  const { text } = await engineFetchContent(engineSourceOf(source), chapter.url, context, false, nextChapterUrl);
  // 引擎只解释规则不做内容判定：builtin 的两道内容闸（空正文 / 单章限长）在这里补齐，错误语义与 builtin
  // 对齐：当前源失败同样进章节级换源；候选失败记 SOURCE_POLICY_REJECTED 后试下一个候选。
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
  // 洞 2:换源成功即把本返回值换成新源的 version/sourceId,并带出新源目录会话 sourceSession。
  let switched: Awaited<ReturnType<typeof switchSourceChapter>> | null = null;
  if (text) {
    // 暖缓存命中:正文与源状态无关,直接交付(不校验源身份,保持既有缓存语义)。
  } else if (!source) {
    context.signal.throwIfAborted();
    // 当前源已不在池里(停用/整条下线):换源触发原因记旧实现给这种情形的码 SOURCE_CHANGED(只进日志)。
    switched = await switchSourceChapter(catalog, chapter, chapterIndex, context, sources, 'SOURCE_CHANGED');
    text = switched.text;
    servedFrom = switched.sourceName;
  } else {
    try {
      // 当前源正文走按进展滑动的切片(41-M1.2):死源卡住 12s 没有进展就放弃、进换源,不再靠 8s 单请求超时 ×
      // 重试耗到十几二十秒;多页正文每成功一页顺延一个基准，慢但一直在出数据的当前源不被砍。顺延上限是软预算
      // 终点，池里有他源时再扣掉换源的起跑门槛(否则换源一个候选都开不了)。到点只 abort 这个 child
      // (SOURCE_SCOPE_EXHAUSTED),父 signal 不受影响。L1 上限取引擎翻页上限，多页正文不会被单源点数掐断;
      // builtin 只抓 1 页，真正的约束仍是 L2,与改动前走根 context 时一致。
      const baseMs = sourceCurrentSliceMs();
      const hasOthers = sources.some((item) => item.url !== catalog.sourceUrl);
      const until = context.startedAt + SOFT_BUDGET_MS - (hasOthers ? SOURCE_FAILOVER_MIN_START_MS : 0);
      const currentContext = context.child(source.url, { limit: MAX_CONTENT_PAGES, sliceMs: baseMs, slide: { stepMs: baseMs, until } });
      text = await chapterText(currentContext, chapter, source, nextChapterUrlOf(catalog.chapters, chapterIndex));
    } catch (error) {
      // 章节正文失败(含源被停用/服务端判定失效/切片到点):进换源流程。
      context.signal.throwIfAborted();
      switched = await switchSourceChapter(catalog, chapter, chapterIndex, context, sources, failureCode(error));
      text = switched.text;
      servedFrom = switched.sourceName;
    }
  }
  remember(key, text, servedFrom);
  return {
    taskId: null, sourceId: switched?.sourceId ?? catalog.sourceId, servedFrom,
    version: switched?.version ?? catalog.version,
    // 洞 2:换源成功时带出新源的目录会话版本,前端据此改用新源会话续读(不再每章从故障原源重试;
    // 新旧目录序号可能不同,阅读位置按标题迁移由前端负责)。未换源时省略,响应体与既有逐字相同。
    ...(switched ? { sourceSession: switched.version } : {}),
    chapterIndex,
    partIndex: 0, partCount: 1, title: chapter.title, startByte: 0, endByte: Buffer.byteLength(text, 'utf8'), text,
  };
}

/**
 * 失败 → 有限枚举原因码：换源日志的 trigger / reasonCounts 与 503 的 reasons 共用。
 * 已带 code 的 SourceReaderError 沿用原码；其余只按错误类型与状态段归类，message 一律不进码
 * （可能带站点回显或 URL）。认不出的兜底 SOURCE_CANDIDATE_FAILED。
 */
function failureCode(error: unknown): string {
  if (error instanceof SourceReaderError) return error.code;
  if (error instanceof SourceHttpError) return error.status >= 500 ? 'SOURCE_HTTP_5XX' : 'SOURCE_HTTP_4XX';
  if (error instanceof SourcePolicyError) return 'SOURCE_POLICY_REJECTED';
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'ConnectTimeoutError')) {
    return 'SOURCE_REQUEST_TIMEOUT';
  }
  if (error instanceof TypeError && /^fetch failed/i.test(error.message)) return 'SOURCE_NETWORK_ERROR';
  return 'SOURCE_CANDIDATE_FAILED';
}

/**
 * 章节级换源:在目录加载时的池快照里逐个找同书的另一个源,按标题对齐取回本章正文;正文拿到后才把
 * 备用源目录落库,调用方据此把 version/sourceId/servedFrom 换成新源(洞 2)。
 *
 * 队列与名额(41-M1.2):队列固定为 [他源…, 原源]。先试他源(同站异 URL 的源被 deprioritizeSource 排在他源末尾);
 * 原源**总是**最后一个候选,带 excludeBookUrl 再搜一次,不占名额(深审 A 第二轮 R1)。名额只数「昂贵失败」
 * (SOURCE_NOT_FOUND 以外),满 sourceFailoverMaxAttempts() 后其余他源不再试,直接轮到原源兜底。
 * 每个候选一个 child:默认单源点数,切片按进展滑动(SourceSliceSlide):基准 min(sourceFailoverSliceMs(), 余量),
 * 每次成功请求顺延一个基准,顺延上限 = 软预算终点(原源兜底还在后面时再扣掉 8s);最后一个他源的基准放宽到
 * 「余量 − 8s」,原源兜底的基准 = 全部余量(R4/P2)。目录与正文共用这一片。
 *
 * 出口:成功;504 SOURCE_TIMEOUT 只有两种 —— 循环顶软预算余量不足一次完整请求、且还有真正的候选没试(partial),
 * 以及父 signal 中止(原样抛出,route 转 504);其余(候选试完、只剩原源兜底而余量不足、L2 请求数用尽、目录落库失败)
 * 一律 503 SOURCE_CHAPTER_UNAVAILABLE。每个出口恰好一行 source_failover 聚合日志;trigger 是当前源失败的原因码。
 */
async function switchSourceChapter(
  catalog: SourceCatalog, chapter: SourceChapter, chapterIndex: number,
  context: SourceRequestContext, sources: ReadingSource[], trigger: string,
): Promise<SourceCatalog & { text: string }> {
  const startedAt = Date.now();
  const requestsAtStart = context.requests;
  // L2:路由根 context 的全局上限是 12,候选各自 resolveSourceBook(sources:[候选]) 时 openPool(1) 抬不高它。
  // 换源开始时按整个池开一次(只增不减,封顶 30),与整池调用 resolveSourceBook 同口径(深审 A F3)。
  context.openPool(sources.length);
  const baseMs = sourceFailoverSliceMs();
  const maxExpensiveAttempts = sourceFailoverMaxAttempts();
  const softEnd = context.startedAt + SOFT_BUDGET_MS;
  // 池快照钉在目录加载时点(N01)。原源刚刚失败,先试他源;但原源总是排在最后再试一次:他源没有这本书、只有
  // 同名异作、或者临时故障时,这本书仍可能在原站(重新上架/换了条目,当前 bookUrl 已失效)。旧实现把原站降到
  // 队尾而不是排除,这里保持同样的兜底。池里没有他源时,原源就是唯一的候选。
  const ordered = deprioritizeSource(sources, catalog.sourceUrl);
  // 41-M1.3:suspect 站(连续传输层硬失败,见 source-host-health.ts)排到他源队尾 —— 只降序不剔除;记忆为空时原样返回。
  const others = orderByHostHealth(ordered.filter((item) => item.url !== catalog.sourceUrl));
  const originals = ordered.filter((item) => item.url === catalog.sourceUrl);
  const queue = [...others, ...originals];
  const failures: Array<{ source: string; reason: string }> = [];
  const reasonCounts: Record<string, number> = {};
  let attempted = 0;
  let expensiveAttempts = 0;
  // 每个出口恰好一行聚合日志:只有结局、计数、耗时和原因码(有限枚举),书名、作者、源名、URL、host、
  // 查询串一概不进。elapsedMs 与 requests 只算换源这一段。成功换源是「降级但已交付」,不是错误:按本模块
  // 观测事件的惯例打 warn;exhausted / timeout 才打 error(深审 A O1)。
  const report = (outcome: 'success' | 'exhausted' | 'timeout') => {
    const line = JSON.stringify({
      event: 'source_failover', outcome, trigger, attempted, expensiveAttempts,
      elapsedMs: Date.now() - startedAt, requests: context.requests - requestsAtStart, reasonCounts,
    });
    if (outcome === 'success') console.warn(line);
    else console.error(line);
  };
  const fail = (source: string, reason: string) => {
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    failures.push({ source, reason });
  };
  const unavailable = () => {
    const error = new SourceReaderError('本章暂不可读,备用书源也未找到相同章节。可重试或尝试「下载全书」。', 'SOURCE_CHAPTER_UNAVAILABLE', 503);
    Object.assign(error, { attempted, reasons: failures });
    report('exhausted');
    return error;
  };
  // 父 signal 中止(路由 deadline/客户端断开)也是出口:记一行 timeout,再把中止原因原样抛出(route 转 504)。
  const throwIfCancelled = () => {
    if (!context.signal.aborted) return;
    report('timeout');
    context.signal.throwIfAborted();
  };
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    const isOriginal = candidate.url === catalog.sourceUrl;
    // 昂贵名额用满:其余他源不再试,直接轮到队尾的原源兜底。
    if (!isOriginal && expensiveAttempts >= maxExpensiveAttempts) continue;
    throwIfCancelled();
    const remaining = softEnd - Date.now();
    if (remaining < SOURCE_FAILOVER_MIN_START_MS) {
      // 只剩原源兜底(他源都已处理过)而余量不足:候选已经试完,按 503 收尾(P1b);还有他源没试才是 504(partial)。
      if (isOriginal && others.length) break;
      report('timeout');
      throw new SourceReaderError('书源查询已取消或超时，可重试或尝试「下载全书」。', 'SOURCE_TIMEOUT', 504);
    }
    // L2 请求数用尽不是超时:不再开新候选,走下面的 503。
    if (context.remainingFor(0) === 0) break;
    attempted += 1;
    // 切片(R4/P2):原源兜底还在后面时,给它留出一次起跑门槛;最后一个他源可以用到「余量 − 留给原源的」,
    // 原源兜底用全部余量;其余候选取 min(基准, 余量)。顺延上限同样扣掉留给原源的时间。
    const reserve = !isOriginal && originals.length ? SOURCE_FAILOVER_MIN_START_MS : 0;
    const isLast = isOriginal || index === others.length - 1;
    const sliceMs = isLast ? Math.max(Math.min(baseMs, remaining), remaining - reserve) : Math.min(baseMs, remaining);
    let alternative: SourceCatalog;
    let text: string;
    try {
      const sourceContext = context.child(candidate.url, { sliceMs, slide: { stepMs: baseMs, until: softEnd - reserve } });
      alternative = await resolveSourceBook(catalog, sourceContext, {
        excludeBookUrl: catalog.bookUrl, sources: [candidate], deferNotFoundWarnings: true,
      });
      // Never assume two catalogs have the same ordinal positions —— 章节按标题对齐。
      const alternativeIndex = matchSourceChapter(alternative.chapters, chapter.title, chapterIndex);
      if (alternativeIndex === null) {
        throw new SourceReaderError('No matching chapter in the alternative source', 'SOURCE_CHAPTER_MISSING');
      }
      const alternativeSource = sources.find((item) => item.url === alternative.sourceUrl
        && sourceRevision(item) === alternative.sourceRevision);
      if (!alternativeSource) throw new SourceReaderError('Alternative source not in pool snapshot', 'SOURCE_NOT_IN_SNAPSHOT');
      // 正文 context 不另起切片,直接用候选 context 的 signal(目录+正文共用一片),每页进展照样让这一片顺延。
      // L1 取引擎翻页上限:引擎正文按 nextContentUrl 逐页 page(),上限低于翻页数时第 2 页就撞 SOURCE_SCOPE_EXHAUSTED。
      const chapterContext = sourceContext.child(candidate.url, { limit: MAX_CONTENT_PAGES, shareSlice: true });
      text = await chapterText(
        chapterContext, alternative.chapters[alternativeIndex], alternativeSource,
        nextChapterUrlOf(alternative.chapters, alternativeIndex),
      );
    } catch (error) {
      throwIfCancelled();
      const reason = failureCode(error);
      fail(candidate.name, reason);
      // 名额只数昂贵失败:SOURCE_NOT_FOUND(搜索确认本站没有这本书)不占,原源兜底那一次也不占。
      if (reason !== 'SOURCE_NOT_FOUND' && !isOriginal) expensiveAttempts += 1;
      continue;
    }
    // 正文拿到后才固化目录,避免失败候选污染可续读会话。落库失败 fail-closed:DB 故障换源救不了,
    // 不再去打后面候选的上游(深审 A F8)。
    try {
      await saveSourceCatalog(alternative, context.signal);
    } catch {
      throwIfCancelled();
      fail(candidate.name, 'SOURCE_CATALOG_SAVE_FAILED');
      throw unavailable();
    }
    report('success');
    return { ...alternative, text };
  }
  throwIfCancelled();
  throw unavailable();
}