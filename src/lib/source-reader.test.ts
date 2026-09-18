import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceCatalog, SourceReaderError, SourceSimilarCandidate } from './source-reader';

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
const pages = new Map<string, { text?: string; status?: number }>();
const catalogs = new Map<string, SourceCatalog>();
let hints: unknown[];
let writes: Query[];
const transaction = vi.fn();
const context = (limit?: number) => new service.SourceRequestContext(new AbortController().signal, limit);
// status: -2 表示连接层失败（TypeError('fetch failed')），text 可省略。
const networkFailure = { status: -2 } as const;

function request(resource = 'index', query = 'title=测试书&author=作者', token: string | null = 'source-owner') {
  return GET(new NextRequest('http://localhost/api/read/source/' + resource + '?' + query, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  }), { params: Promise.resolve({ resource }) });
}

function expectPrivate(res: Response) {
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
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
    if (fixture.status === -2) throw new TypeError('fetch failed'); // 连接层失败（DNS/重置），page() 内重试后抛回
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
    // 模糊层语义：标题对得上但作者不符 ⇒ 不自动取书，改交用户选（SOURCE_SIMILAR + 候选）。
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({
      code: 'SOURCE_SIMILAR', candidates: [{ title: '测试书', author: '其他作者' }],
    });
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

  it('falls back to an author search when the title search yields no candidates, matching a renamed book via its self-reported alias', async () => {
    // 站点把《改名书》上架为《站点新书》，标题搜索 0 结果；
    // 作者搜索命中，详情页简介自报【原书名：改名书】。
    const renamed = { title: '改名书', author: '原作者' };
    const authorSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(renamed.author);
    const detailHtml = (id: number, title: string, author: string, alias?: string) =>
      `<meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${author}">`
      + (alias ? `<div>小说简介:【原书名：${alias}】正文</div>` : '')
      + '<dd><a href="/chapter/index' + id + '-1.html">第一章</a></dd>';
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(renamed.title), { text: '' });
    pages.set(authorSearch, { text: '<a href="/books/details7.html">站点新书</a><a href="/books/details8.html">其他书</a>' });
    pages.set('https://book15.net/books/details7.html', { text: detailHtml(7, '站点新书', '原作者', '改名书') });
    pages.set('https://book15.net/books/details8.html', { text: detailHtml(8, '其他书', '另一作者', '无关原名') });
    const catalog = await service.resolveSourceBook(renamed, context());
    expect(catalog).toMatchObject({ title: '站点新书', author: '原作者', bookUrl: 'https://book15.net/books/details7.html' });
  });

  it('does not mis-pair an alias candidate whose author differs (renamed-book negative control)', async () => {
    // 目标《改名书》作者 A；作者搜索按 A 命中的唯一候选其实是另一作者的同素材书，
    // 其简介自报的原书名恰好也叫《改名书》。作者门必须拒 ⇒ 不自动取书；模糊层列为候选。
    const target = { title: '改名书', author: '作者A' };
    const authorSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(target.author);
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.title), { text: '' });
    pages.set(authorSearch, { text: '<a href="/books/details7.html">站点新书</a>' });
    pages.set('https://book15.net/books/details7.html', {
      text: '<meta property="og:novel:book_name" content="站点新书"><meta property="og:novel:author" content="作者B">'
        + '<div>小说简介:【原书名：改名书】正文</div>'
        + '<dd><a href="/chapter/index7-1.html">第一章</a></dd>',
    });
    await expect(service.resolveSourceBook(target, context())).rejects.toMatchObject({
      code: 'SOURCE_SIMILAR',
      candidates: [{ title: '站点新书', author: '作者B', alias: '改名书' }],
    });
  });

  it('does not run the author-search fallback when the title already matched', async () => {
    const authorSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(book.author);
    pages.set(authorSearch, { text: '' });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.bookUrl).toBe(pageUrl());
    expect(mocks.fetch).toHaveBeenCalledTimes(2); // title search + detail only, no author search
  });

  it('returns similar candidates instead of 404 when the site has fuzzy-titled detail pages', async () => {
    // 标题搜索只有一个「书名对得上但作者不符」的候选（用户痛点：站点作者挂错/为空）。
    // 精确层拒，模糊层必须收集并列出，不能直接 SOURCE_NOT_FOUND。
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details42.html">测试书</a>',
    });
    pages.set(pageUrl(), { text: detail(42, '站点挂错的作者') });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({
      code: 'SOURCE_SIMILAR',
      candidates: [{ title: '测试书', author: '站点挂错的作者', chapters: 2, bookUrl: pageUrl() }],
    });
  });

  it('excludes unrelated books from similar candidates (negative control)', async () => {
    // 作者搜索命中两个候选：一个书名相似（作者不符）、一个完全无关 —— 只有前者可进候选。
    // 书名取「我的改名书」（≥4 字）以覆盖包含判据；无关书共享 ≤1 字必须被淘汰。
    const target = { title: '我的改名书', author: '作者A' };
    const authorSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(target.author);
    const unrelatedDetail = (id: number, title: string, author: string) =>
      `<meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${author}">`
      + '<dd><a href="/chapter/index' + id + '-1.html">第一章</a></dd>';
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.title), { text: '' });
    pages.set(authorSearch, {
      text: '<a href="/books/details7.html">我的改名书·全本</a><a href="/books/details8.html">全球高武</a>',
    });
    pages.set('https://book15.net/books/details7.html', { text: unrelatedDetail(7, '我的改名书·全本', '别人') });
    pages.set('https://book15.net/books/details8.html', { text: unrelatedDetail(8, '全球高武', '别人') });
    await expect(service.resolveSourceBook(target, context())).rejects.toMatchObject({
      code: 'SOURCE_SIMILAR',
      candidates: [{ title: '我的改名书·全本' }],
    });
  });

  it('resolves a user-confirmed book_url without title/author matching', async () => {
    // 用户在候选列表点选后的确认重放：bookUrl 即用户决定，跳过书名/作者校验。
    pages.set('https://book15.net/books/details77.html', {
      text: detail(77, '随便什么作者')
        .replace('content="测试书"', 'content="随便什么书名"'),
    });
    const catalog = await service.resolveSourceBook(book, context(), { bookUrl: 'https://book15.net/books/details77.html' });
    expect(catalog).toMatchObject({ title: '随便什么书名', author: '随便什么作者', bookUrl: 'https://book15.net/books/details77.html' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('still rejects a confirmed book_url outside the source allowlist', async () => {
    await expect(service.resolveSourceBook(book, context(), { bookUrl: 'https://evil.invalid/books/details1.html' }))
      .rejects.toThrow();
  });

  // ---- 去闸门回归（fix/read-source-gate）：部分搜索失败不再否决已拿到的唯一匹配 / 相似候选 ----

  it('delivers the sole no-author match even when an earlier candidate detail fetch failed', async () => {
    // 改动 1 回归：author=''、唯一匹配，前一个候选详情页连接层失败（TypeError，page() 重试后抛回）。
    // 旧闸门：hadFailure ⇒ 丢弃唯一匹配 503 SOURCE_UNAVAILABLE；新语义：照常交付目录。
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details41.html">测试书</a><a href="/books/details42.html">测试书</a>',
    });
    pages.set(pageUrl(41), networkFailure);
    pages.set(pageUrl(42), { text: detail() });
    const catalog = await service.resolveSourceBook({ ...book, author: '' }, context());
    expect(catalog).toMatchObject({ title: '测试书', bookUrl: pageUrl(), chapters: [{ title: '第一章' }, { title: '第二章' }] });
  });

  it('still surfaces SOURCE_SIMILAR candidates when a request failed mid-resolve', async () => {
    // 改动 1 回归：有相似候选 + 一次网络失败 → 仍 422 SOURCE_SIMILAR，且候选与健康路径一致。
    // 主源抓到作者不符的候选（进 similar）；镜像源健康时也复查同一详情页，候选不变。
    const mirror = { ...source, url: 'https://book15.net/mirror', searchUrl: '/mirror/search.html?kw={{key}}' };
    mocks.sources.mockResolvedValue([source, mirror]);
    pages.set(pageUrl(), { text: detail(42, '站点挂错的作者') });
    const mirrorSearch = 'https://book15.net/mirror/search.html?kw=' + encodeURIComponent(book.title);
    pages.set(mirrorSearch, { text: '<a href="/books/details42.html">测试书</a>' });
    const healthy = await service.resolveSourceBook(book, context())
      .catch((error: SourceReaderError & { candidates?: SourceSimilarCandidate[] }) => error);
    pages.set(mirrorSearch, networkFailure); // 唯一变量：镜像源搜索连接层失败（hadFailure=true）
    const degraded = await service.resolveSourceBook(book, context())
      .catch((error: SourceReaderError & { candidates?: SourceSimilarCandidate[] }) => error);
    expect(healthy).toMatchObject({ code: 'SOURCE_SIMILAR', status: 422 });
    expect(degraded).toMatchObject({ code: 'SOURCE_SIMILAR', status: 422 });
    expect((degraded as SourceReaderError & { candidates?: SourceSimilarCandidate[] }).candidates)
      .toEqual((healthy as SourceReaderError & { candidates?: SourceSimilarCandidate[] }).candidates);
  });

  it('returns the match already found when the shared budget runs out mid-resolve', async () => {
    // 改动 2 回归：预算中途耗尽不再终结 resolve（旧：503 SOURCE_BUDGET_EXCEEDED 重抛作废全部）。
    // 构造：无作者书在主源收集到唯一匹配（搜索+详情=2 请求）；镜像源搜索时预算已耗尽 ⇒
    // SOURCE_BUDGET_EXCEEDED 从 page() 抛到外层 catch → 特判 break → 已有唯一匹配照常返回。
    mocks.sources.mockResolvedValue([source, { ...source, url: 'https://book15.net/mirror', searchUrl: '/mirror/search.html?kw={{key}}' }]);
    const catalog = await service.resolveSourceBook({ ...book, author: '' }, context(2));
    expect(catalog).toMatchObject({ title: '测试书', bookUrl: pageUrl(), chapters: [{ title: '第一章' }, { title: '第二章' }] });
  });

  it('falls back to SOURCE_SIMILAR when the budget runs out after collecting candidates', async () => {
    // 改动 2 回归：similar 已收集 + 预算中途耗尽 → 不再 503，落 422 SOURCE_SIMILAR。
    // 构造：主源搜索+详情（2 请求）抓到作者不符候选（进 similar）；镜像源搜索（第 3 请求）
    // 后其详情页触发 BUDGET → inspect 内层特判 break → similar 保留。
    mocks.sources.mockResolvedValue([source, { ...source, url: 'https://book15.net/mirror', searchUrl: '/mirror/search.html?kw={{key}}' }]);
    pages.set(pageUrl(), { text: detail(42, '站点挂错的作者') });
    pages.set('https://book15.net/mirror/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details43.html">测试书</a>',
    });
    await expect(service.resolveSourceBook(book, context(3))).rejects.toMatchObject({
      code: 'SOURCE_SIMILAR', status: 422, candidates: [{ title: '测试书', author: '站点挂错的作者' }],
    });
  });

  it('still reports 503 SOURCE_UNAVAILABLE when the search itself fails with no results', async () => {
    // 负控（语义不变）：空结果 + 关键路径失败（标题搜索自身网络失败）→ 仍 503 SOURCE_UNAVAILABLE。
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), networkFailure);
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE', status: 503,
    });
  });

  it('reports 404 SOURCE_NOT_FOUND when only the optional fuzzy-collection layer failed', async () => {
    // 改动 3 回归：模糊收集层（作者候选补抓）失败不记账 hadFailure → 关键路径全成功、无匹配 ⇒ 404。
    const target = { title: '改名书', author: '作者A' };
    const titleSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(target.title);
    const authorSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(target.author);
    const unrelatedDetail = (id: number, title: string, author: string) =>
      `<meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${author}">`
      + '<dd><a href="/chapter/index' + id + '-1.html">第一章</a></dd>';
    pages.set(titleSearch, { text: '' }); // 标题搜索 0 候选 ⇒ 作者回退
    // 作者搜索给 6 个候选：前 4 进 inspect（关键路径），后 2 才是模糊补抓层（可选）。
    pages.set(authorSearch, {
      text: Array.from({ length: 6 }, (_, i) => `<a href="/books/details${60 + i}.html">无关书${i}</a>`).join(''),
    });
    for (let i = 0; i < 6; i++) {
      pages.set(pageUrl(60 + i), i >= 4 ? networkFailure : { text: unrelatedDetail(60 + i, '无关书' + i, '别人') });
    }
    await expect(service.resolveSourceBook(target, context())).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND', status: 404,
    });
  });

  it('bounds a miss to 8 requests: title search, author search, 4 inspects, 2 fuzzy pages', async () => {
    // 改动 3 回归（定量）：miss 路径请求上限 ≤ 1(标题)+1(作者)+4(inspect)+2(模糊补抓) = 8。
    const target = { title: '改名书', author: '作者A' };
    const titleSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(target.title);
    const authorSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(target.author);
    const links = Array.from({ length: 23 }, (_, i) => `<a href="/books/details${800 + i}.html">无关书${i}</a>`).join('');
    const unrelatedDetail = (id: number, title: string, author: string) =>
      `<meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${author}">`
      + '<dd><a href="/chapter/index' + id + '-1.html">第一章</a></dd>';
    pages.set(titleSearch, { text: links });
    pages.set(authorSearch, { text: links });
    for (let i = 0; i < 23; i++) pages.set(pageUrl(800 + i), { text: unrelatedDetail(800 + i, '无关书' + i, '别人') });
    await expect(service.resolveSourceBook(target, context())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(mocks.fetch).toHaveBeenCalledTimes(8);
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

  it('logs a structured 503 line with the error code when the source is unavailable', async () => {
    // 改动 4 回归：SOURCE_UNAVAILABLE 的 503 档必须有结构化日志（此前零观测）。
    // 只记 code/requests/elapsedMs，不打书名、作者、URL、查询串。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), networkFailure);
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(errorSpy).toHaveBeenCalledOnce();
    const line = errorSpy.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ code: 'SOURCE_UNAVAILABLE', requests: expect.any(Number), elapsedMs: expect.any(Number) });
    expect(line).not.toContain('测试书');
    expect(line).not.toContain('作者');
  });
});
