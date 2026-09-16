import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceCatalog } from './source-reader';

type Query = { text: string; values: unknown[] };
const mocks = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn(), sources: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('./db', () => ({ getSql: mocks.getSql, ensureSchema: mocks.ensureSchema }));
vi.mock('./shuyuan', () => ({ getReadingSources: mocks.sources }));

let service: typeof import('./source-reader');
let GET: typeof import('@/app/api/read/source/[resource]/route').GET;
const source = { url: 'https://book15.net/', name: '测试书源', searchUrl: '/books/search.html?kw={{key}}', rules: {} };
const book = { title: '测试书', author: '作者' };
const pageUrl = (id = 42) => `https://book15.net/books/details${id}.html`;
const chapterUrl = (id = 42, chapter = 1) => `https://book15.net/chapter/index${id}-${chapter}.html`;
const detail = (id = 42, author = '作者', titles = ['第一章', '第二章']) =>
  `<meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="${author}">`
  + titles.map((title, i) => `<dd><a href="/chapter/index${id}-${i + 1}.html">${title}</a></dd>`).join('');
const chapterHtml = (text = '离线测试正文。') => `<li class="chapter-content"><p>${text}</p></li>`;
const pages = new Map<string, { text: string; status?: number }>();
const catalogs = new Map<string, SourceCatalog>();
let hints: unknown[];
let writes: Query[];
const transaction = vi.fn();
const context = (limit?: number) => new service.SourceRequestContext(new AbortController().signal, limit);

function request(resource = 'index', query = 'title=测试书&author=作者', token: string | null = 'source-owner') {
  return GET(new NextRequest('http://localhost/api/read/source/' + resource + '?' + query, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  }), { params: Promise.resolve({ resource }) });
}

function expectPrivate(res: Response) {
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(res.headers.get('Vary')).toBe('Authorization, X-Owner-Token');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('APP_OWNER_TOKEN', 'source-owner');
  mocks.sources.mockResolvedValue([source]);
  hints = [];
  writes = [];
  catalogs.clear();
  pages.clear();
  pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
    text: '<a href="/books/details42.html">测试书</a>',
  });
  pages.set(pageUrl(), { text: detail() });
  pages.set(chapterUrl(), { text: chapterHtml() });
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?').replace(/\s+/g, ' ').trim(), values });
  transaction.mockImplementation(async (queries: Query[], options: { fetchOptions: { signal: AbortSignal } }) => {
    expect(options.fetchOptions.signal).toBeInstanceOf(AbortSignal);
    return queries.map((query) => {
      if (query.text.includes('FROM labeled_books')) return hints;
      if (query.text.startsWith('INSERT INTO source_read_catalogs')) {
        writes.push(query);
        catalogs.set(query.values[0] as string, JSON.parse(query.values[1] as string));
        return [];
      }
      if (query.text.startsWith('DELETE')) { writes.push(query); return []; }
      if (query.text.includes('FROM source_read_catalogs')) {
        const payload = catalogs.get(query.values[0] as string);
        return payload ? [{ payload }] : [];
      }
      throw new Error('Unexpected SQL ' + query.text);
    });
  });
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction }));
  mocks.fetch.mockImplementation(async (input) => {
    const fixture = pages.get(String(input));
    if (!fixture) throw new Error('Unexpected source request');
    return new Response(fixture.text, { status: fixture.status ?? 200 });
  });
  vi.stubGlobal('fetch', mocks.fetch);
  // No real wait is needed for successful source spacing in offline tests.
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time += 400);
  service = await import('./source-reader');
  GET = (await import('@/app/api/read/source/[resource]/route')).GET;
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('online reader source resolution and budgets', () => {
  it('searches by title, validates the detail author, and does not fetch any chapters', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog).toMatchObject({ ...book, bookUrl: pageUrl(), chapters: [{ title: '第一章' }, { title: '第二章' }] });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([]);
  });

  it('uses a known library URL only after revalidating the actual source identity', async () => {
    hints = [{ ...book, source_url: pageUrl() }];
    expect((await service.resolveSourceBook(book, context())).bookUrl).toBe(pageUrl());
    expect(mocks.fetch).toHaveBeenCalledOnce();
    pages.set(pageUrl(), { text: detail(42, '其他作者') });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });

  it('rejects a same-title work by a different author', async () => {
    pages.set(pageUrl(), { text: detail(42, '其他作者') });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });

  it('refuses ambiguous title-only matches', async () => {
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details42.html">测试书</a><a href="/books/details43.html">测试书</a>',
    });
    pages.set(pageUrl(43), { text: detail(43, '另一作者') });
    await expect(service.resolveSourceBook({ ...book, author: '' }, context())).rejects.toMatchObject({ code: 'SOURCE_AMBIGUOUS' });
  });

  it('falls back after a failed search source within the same request budget', async () => {
    mocks.sources.mockResolvedValue([{ ...source, url: 'https://book15.net/old', searchUrl: '/failed?kw={{key}}' }, source]);
    pages.set('https://book15.net/failed?kw=' + encodeURIComponent(book.title), { text: '', status: 500 });
    const budget = context();
    expect((await service.resolveSourceBook(book, budget)).bookUrl).toBe(pageUrl());
    expect(budget.requests).toBe(4); // two failed attempts + one search + one detail
  });

  it('bounds retries and HTTP requests, counting redirects too', async () => {
    const budget = context(1);
    mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: '/redirect' } }));
    await expect(budget.page('https://book15.net/')).rejects.toMatchObject({ code: 'SOURCE_BUDGET_EXCEEDED' });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('does not retry rate-limited sources', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 429 }));
    await expect(context().page('https://book15.net/')).rejects.toMatchObject({ status: 429 });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('stops before source/DB access when cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(new service.SourceRequestContext(controller.signal).page(pageUrl())).rejects.toThrow('cancelled');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('only caches immutable directories in the DB, never chapter text', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    await service.saveSourceCatalog(catalog, context().signal);
    expect(writes[0].text).toContain('ON CONFLICT (id) DO UPDATE SET expires_at = GREATEST');
    expect(writes[0].text).not.toContain('SET payload');
    expect(writes[1].text).toContain('expires_at < now()');
    expect(JSON.stringify(writes)).not.toContain('离线测试正文');
  });

  it('fetches just the requested chapter and reuses a short cache', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    mocks.fetch.mockClear();
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part).toMatchObject({ taskId: null, sourceId: catalog.sourceId, chapterIndex: 0, text: '离线测试正文。' });
    expect(await service.readSourceChapter(catalog.version, 0, context())).toEqual(part);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('expires chapter cache entries', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    await service.readSourceChapter(catalog.version, 0, context());
    const later = Date.now() + 121_000;
    vi.mocked(Date.now).mockReturnValue(later);
    pages.set(chapterUrl(), { text: chapterHtml('更新正文') });
    expect((await service.readSourceChapter(catalog.version, 0, context())).text).toBe('更新正文');
  });

  it('rejects disabled sources even when the chapter is cached', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    await service.readSourceChapter(catalog.version, 0, context());
    mocks.sources.mockResolvedValue([]);
    await expect(service.readSourceChapter(catalog.version, 0, context())).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('fails over by unique chapter title instead of the chapter ordinal', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    pages.set(chapterUrl(), { text: '', status: 404 });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details43.html">测试书</a>',
    });
    pages.set(pageUrl(43), { text: detail(43, '作者', ['序言', '第一章']) });
    pages.set(chapterUrl(43, 2), { text: chapterHtml('备用来源第一章') });
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part.text).toBe('备用来源第一章');
    expect(part.chapterIndex).toBe(0);
    expect(part.sourceId).toBe(catalog.sourceId);
  });
});

describe('GET /api/read/source/[resource]', () => {
  it.each([null, 'incorrect'])('requires owner credentials before any data access (%s)', async (token) => {
    const res = await request('index', '', token);
    expect(res.status).toBe(401);
    expectPrivate(res);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.sources).not.toHaveBeenCalled();
  });

  it('returns private 503 when owner credentials are unconfigured', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    const res = await request();
    expect(res.status).toBe(503);
    expectPrivate(res);
    expect(res.headers.get('Retry-After')).toBe('5');
  });

  it.each(['', 'title=%00', 'title=' + 'a'.repeat(201), 'title=书&author=%00'])(
    'validates a book before DB access: %s', async (query) => {
      const res = await request('index', query);
      expect(res.status).toBe(400);
      expectPrivate(res);
      expect(mocks.ensureSchema).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'chapter=-1', 'chapter=01', 'chapter=10000', 'chapter=0&session=../../etc', 'chapter=0&session=' + 'a'.repeat(40) + '&version=' + 'a'.repeat(40) + '&part=1'])(
    'rejects invalid chapter/session queries: %s', async (query) => {
      const res = await request('chapter', query);
      expect(res.status).toBe(400);
      expectPrivate(res);
      expect(mocks.ensureSchema).not.toHaveBeenCalled();
    },
  );

  it('returns an online directory and then a single chapter with private headers', async () => {
    const indexRes = await request();
    expect(indexRes.status).toBe(200);
    expectPrivate(indexRes);
    const index = await indexRes.json();
    expect(index.taskId).toBeNull();
    expect(index.source.session).toBe(index.version);
    const partRes = await request('chapter', `session=${index.source.session}&version=${index.version}&chapter=0`);
    expect(partRes.status).toBe(200);
    expectPrivate(partRes);
    expect((await partRes.json()).text).toBe('离线测试正文。');
  });

  it('gives an actionable error code when no supported book is found', async () => {
    mocks.sources.mockResolvedValue([]);
    const res = await request();
    expect(res.status).toBe(404);
    expectPrivate(res);
    expect(await res.json()).toMatchObject({ code: 'SOURCE_NOT_FOUND', error: expect.stringContaining('下载全书') });
  });

  it('asks to reload expired directories without fetching any source', async () => {
    const session = 'a'.repeat(40);
    const res = await request('chapter', `session=${session}&version=${session}&chapter=0`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SOURCE_SESSION_EXPIRED' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
