import { createHash } from 'node:crypto';
import { getSql } from './db';
import { getReadingSources, type ReadingSource } from './shuyuan';
import { fetchSourceText, sourceAbortable, SourceHttpError } from './source-fetch';
import { SourcePolicyError, validateSourceUrl } from './source-policy';
import {
  knownSourceAuthor, normalizeSourceTitle, parseSourceChapters, parseSourceChapterText,
  parseSourceDetailLinks, parseSourceIdentity, parseSourceSearch, sourceBookMatches,
  sourceSearchUrl, sourceTitleSimilarity,
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
const revision = (source: ReadingSource) => hash([source.url, source.searchUrl, source.rules]);

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
  const sourceRevision = revision(source);
  return {
    ...identity, sourceUrl: source.url, sourceName: source.name, sourceRevision, bookUrl: page.url,
    sourceId, version: hash([PARSER_VERSION, sourceId, sourceRevision, identity, chapters]), chapters,
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
  const sourceRevision = revision(source);
  return {
    ...identity, sourceUrl: source.url, sourceName: source.name, sourceRevision, bookUrl: page.url,
    sourceId, version: hash([PARSER_VERSION, sourceId, sourceRevision, identity, chapters]), chapters,
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

/** Search/detail validation only; never fetches chapter text or evaluates source rules. */
export async function resolveSourceBook(
  book: SourceBookIdentity,
  context: SourceRequestContext,
  options: { excludeBookUrl?: string; sources?: ReadingSource[]; bookUrl?: string } = {},
): Promise<SourceCatalog> {
  const sources = options.sources ?? await getReadingSources(context.signal);
  // 用户在前端候选列表里点选后的确认路径：URL 即用户决定，跳过书名/作者校验，
  // 只保留结构性防御（域名白名单在 validateSourceUrl、目录可解析、非 excludeBookUrl）。
  if (options.bookUrl) {
    const url = validateSourceUrl(options.bookUrl).href;
    if (url === options.excludeBookUrl) throw new SourceReaderError('该书源已失效，请重新搜索。', 'SOURCE_NOT_FOUND', 404);
    const source = sources[0];
    if (!source) throw new SourceReaderError('书源已停用或规则已更新，请重新选择书源。', 'SOURCE_CHANGED', 409);
    const confirmed = confirmedCatalogFrom(await context.page(url), source);
    if (!confirmed) throw new SourceReaderError('用户选择的书源无法建立目录，请重试或换一个候选。', 'SOURCE_NOT_FOUND', 404);
    return confirmed;
  }
  const hints = await hintsFor(book, context.signal);
  let hadFailure = false;
  const checked = new Set<string>();
  const matches = new Map<string, SourceCatalog>();
  const similar = new Map<string, SourceSimilarCandidate>();
  const collectSimilar = (page: { text: string; url: string }) => {
    const candidate = similarCandidateFrom(page);
    if (candidate) similar.set(candidate.bookUrl, candidate);
  };
  for (const source of sources) {
    context.signal.throwIfAborted();
    try {
      // Known metadata links save a source search but still require live identity checks.
      const inspect = async (urls: string[], collectFuzzy = false): Promise<SourceCatalog | undefined> => {
        if (urls.length > MAX_DETAIL_CANDIDATES && !knownSourceAuthor(book.author)) {
          throw new SourceReaderError('同名作品过多，请补全作者后再阅读。', 'SOURCE_AMBIGUOUS', 422);
        }
        for (const url of urls.slice(0, MAX_DETAIL_CANDIDATES)) {
          if (url === options.excludeBookUrl || checked.has(source.url + url)) continue;
          checked.add(source.url + url);
          try {
            const page = await context.page(url);
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
      const search = await context.page(sourceSearchUrl(source.searchUrl, book.title, source.url));
      let candidates: string[] = [];
      if (/^\/books\/details\d+\.html$/.test(new URL(search.url).pathname) && search.url !== options.excludeBookUrl) {
        const direct = catalogFrom(search, source, book);
        if (direct) {
          if (knownSourceAuthor(book.author)) return direct;
          matches.set(direct.bookUrl, direct);
        } else {
          collectSimilar(search);
        }
      } else {
        candidates = parseSourceSearch(search.text, search.url, book.title);
      }
      const result = await inspect(candidates, true);
      if (result) return result;
      // 作者搜索回退：标题搜索 0 候选、有作者可搜且作者不是书名本身时（改名书的站点索引
      // 只有新名），改搜作者。候选不看锚文本，身份靠详情页的标题/别名 + 作者门校验。
      if (!candidates.length && knownSourceAuthor(book.author) && knownSourceAuthor(book.author) !== normalizeSourceTitle(book.title)) {
        const authorSearch = await context.page(sourceSearchUrl(source.searchUrl, book.author, source.url));
        const authorCandidates = /^\/books\/details\d+\.html$/.test(new URL(authorSearch.url).pathname)
          ? [authorSearch.url]
          : parseSourceDetailLinks(authorSearch.text, authorSearch.url);
        const authorResult = await inspect(authorCandidates, true);
        if (authorResult) return authorResult;
        // 模糊层收集面 b)：作者搜索里 L1/L2 未消费过的其余详情页候选。
        // 可选层限量：只再补 MAX_SIMILAR_PAGES 页，纯为凑候选不值得放大请求；
        // 预算余量不足时 SourceRequestContext 会抛 SOURCE_BUDGET_EXCEEDED，停止收集即可。
        for (const url of authorCandidates.slice(MAX_DETAIL_CANDIDATES, MAX_DETAIL_CANDIDATES + MAX_SIMILAR_PAGES)) {
          if (checked.has(source.url + url) || url === options.excludeBookUrl) continue;
          try {
            // 可选请求不重试（attempts=1）：一次抖动不应吃掉 2 点预算 + 2×8s。
            collectSimilar(await context.page(url, 1));
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
        throw error;
      }
      hadFailure = true;
    }
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

async function loadSourceCatalog(session: string, context: SourceRequestContext): Promise<SourceCatalog> {
  const sql = getSql();
  const [row] = await queryRows<{ payload: SourceCatalog }>(sql`
    SELECT payload FROM source_read_catalogs WHERE id = ${session} AND expires_at > now()`, context.signal);
  if (!row) throw new SourceReaderError('阅读目录已过期，请重新加载目录。', 'SOURCE_SESSION_EXPIRED', 409);
  const catalog = row.payload;
  const sources = await getReadingSources(context.signal);
  if (!sources.some((source) => source.url === catalog.sourceUrl && revision(source) === catalog.sourceRevision)) {
    throw new SourceReaderError('书源已停用或规则已更新，请重新选择书源。', 'SOURCE_CHANGED', 409);
  }
  validateSourceUrl(catalog.bookUrl);
  return catalog;
}

const chapterCache = new Map<string, { text: string; servedFrom: string; expires: number; bytes: number }>();
let cacheBytes = 0;
async function chapterText(context: SourceRequestContext, chapter: SourceChapter): Promise<string> {
  const page = await context.page(chapter.url);
  if (new URL(page.url).pathname !== new URL(chapter.url).pathname) throw new SourcePolicyError('章节跳转到了另一页面');
  return parseSourceChapterText(page.text, chapter.title);
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
  // Recheck enablement even for a warm chapter cache.
  const catalog = await loadSourceCatalog(session, context);
  const chapter = catalog.chapters[chapterIndex];
  if (!chapter) throw new SourceReaderError('章节不存在。', 'SOURCE_CHAPTER_INVALID', 400);
  const key = catalog.version + ':' + chapterIndex;
  const cached = chapterCache.get(key);
  let text = cached && cached.expires > Date.now() ? cached.text : '';
  let servedFrom = cached && cached.expires > Date.now() ? cached.servedFrom : catalog.sourceName;
  if (!text) {
    try {
      text = await chapterText(context, chapter);
    } catch {
      context.signal.throwIfAborted();
      try {
        const alternative = await resolveSourceBook(catalog, context, { excludeBookUrl: catalog.bookUrl });
        // Never assume two catalogs have the same ordinal positions.
        const chapters = alternative.chapters.filter((item) => normalizeSourceTitle(item.title) === normalizeSourceTitle(chapter.title));
        if (chapters.length !== 1) throw new Error('No unique matching chapter');
        text = await chapterText(context, chapters[0]);
        servedFrom = alternative.sourceName;
      } catch {
        context.signal.throwIfAborted();
        throw new SourceReaderError('本章暂不可读，备用书源也未找到相同章节。可重试或尝试「下载全书」。', 'SOURCE_CHAPTER_UNAVAILABLE', 503);
      }
    }
    remember(key, text, servedFrom);
  }
  return {
    taskId: null, sourceId: catalog.sourceId, servedFrom, version: catalog.version, chapterIndex,
    partIndex: 0, partCount: 1, title: chapter.title, startByte: 0, endByte: Buffer.byteLength(text, 'utf8'), text,
  };
}
