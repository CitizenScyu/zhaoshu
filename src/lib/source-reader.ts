import { createHash } from 'node:crypto';
import { getSql } from './db';
import { getReadingSources, type ReadingSource } from './shuyuan';
import { fetchSourceText, sourceAbortable, SourceHttpError } from './source-fetch';
import { SourcePolicyError, validateSourceUrl } from './source-policy';
import {
  knownSourceAuthor, normalizeSourceTitle, parseSourceChapters, parseSourceChapterText,
  parseSourceIdentity, parseSourceSearch, sourceBookMatches, sourceSearchUrl,
  type SourceBookIdentity, type SourceChapter,
} from './source-parser';
import type { ReaderIndex, ReaderPart } from './reader-types';

const MAX_SOURCE_REQUESTS = 12;
const MAX_SOURCE_ATTEMPTS = 2;
const SOURCE_DELAY_MS = 350;
const MAX_DETAIL_CANDIDATES = 4;
const CHAPTER_CACHE_MS = 2 * 60_000;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_CHAPTERS = 24;
const PARSER_VERSION = 'book15-v1';

export class SourceReaderError extends Error {
  constructor(message: string, readonly code: string, readonly status = 404) { super(message); }
}

export class SourceRequestContext {
  requests = 0;
  private nextRequestAt = 0;
  constructor(readonly signal: AbortSignal, readonly limit = MAX_SOURCE_REQUESTS) {}

  async page(url: string): Promise<{ url: string; text: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SOURCE_ATTEMPTS; attempt++) {
      this.signal.throwIfAborted();
      try {
        return await fetchSourceText(url, {
          signal: this.signal,
          beforeRequest: async (signal) => {
            if (this.requests >= this.limit) throw new SourceReaderError('书源查询预算已用完，请稍后重试或下载全书。', 'SOURCE_BUDGET_EXCEEDED', 503);
            this.requests++;
            // 同步预占时间槽：并发调用各自拿到互不重叠的发射时刻，起始间隔恒为 SOURCE_DELAY_MS。
            // 若像以前那样在 await 之后才写回 nextRequestAt，多个并发 page() 会读到同一个旧值、
            // 一起免等、一起发射，节流对源站失效。
            const now = Date.now();
            const at = Math.max(now, this.nextRequestAt);
            this.nextRequestAt = at + SOURCE_DELAY_MS;
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
  if (identity.title.length > 200 || identity.author.length > 200 || !sourceBookMatches(expected, identity)) return null;
  const chapters = parseSourceChapters(page.text, page.url);
  if (!chapters.length) return null;
  const sourceId = hash([source.url, page.url]);
  const sourceRevision = revision(source);
  return {
    ...identity, sourceUrl: source.url, sourceName: source.name, sourceRevision, bookUrl: page.url,
    sourceId, version: hash([PARSER_VERSION, sourceId, sourceRevision, identity, chapters]), chapters,
  };
}

/** Search/detail validation only; never fetches chapter text or evaluates source rules. */
export async function resolveSourceBook(
  book: SourceBookIdentity,
  context: SourceRequestContext,
  options: { excludeBookUrl?: string; sources?: ReadingSource[] } = {},
): Promise<SourceCatalog> {
  const sources = options.sources ?? await getReadingSources(context.signal);
  const hints = await hintsFor(book, context.signal);
  let hadFailure = false;
  const checked = new Set<string>();
  const matches = new Map<string, SourceCatalog>();
  for (const source of sources) {
    context.signal.throwIfAborted();
    try {
      // Known metadata links save a source search but still require live identity checks.
      const inspect = async (urls: string[]): Promise<SourceCatalog | undefined> => {
        if (urls.length > MAX_DETAIL_CANDIDATES && !knownSourceAuthor(book.author)) {
          throw new SourceReaderError('同名作品过多，请补全作者后再阅读。', 'SOURCE_AMBIGUOUS', 422);
        }
        for (const url of urls.slice(0, MAX_DETAIL_CANDIDATES)) {
          if (url === options.excludeBookUrl || checked.has(source.url + url)) continue;
          checked.add(source.url + url);
          try {
            const catalog = catalogFrom(await context.page(url), source, book);
            if (catalog) {
              matches.set(catalog.bookUrl, catalog);
              if (knownSourceAuthor(book.author)) return catalog;
            }
          } catch (error) {
            context.signal.throwIfAborted();
            if (error instanceof SourceReaderError) throw error;
            hadFailure = true;
          }
        }
      };
      const hinted = await inspect(hints);
      if (hinted) return hinted;
      const search = await context.page(sourceSearchUrl(source.searchUrl, book.title, source.url));
      if (/^\/books\/details\d+\.html$/.test(new URL(search.url).pathname) && search.url !== options.excludeBookUrl) {
        const direct = catalogFrom(search, source, book);
        if (direct) {
          if (knownSourceAuthor(book.author)) return direct;
          matches.set(direct.bookUrl, direct);
        }
      }
      const result = await inspect(parseSourceSearch(search.text, search.url, book.title));
      if (result) return result;
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof SourceReaderError) throw error;
      hadFailure = true;
    }
  }
  if (matches.size > 1) throw new SourceReaderError('找到多部同名作品，请补全作者后再阅读。', 'SOURCE_AMBIGUOUS', 422);
  // A partial search cannot establish uniqueness for a book without an author.
  if (matches.size === 1 && !hadFailure) return [...matches.values()][0];
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
