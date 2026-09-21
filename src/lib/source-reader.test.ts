import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceCatalog, SourceReaderError, SourceSimilarCandidate } from './source-reader';
import { sourceRevision } from './source-revision';

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
// 换源测试用的「另一个站」备用源:与主源**不同 host**,且章名写法不同(「第1章」)。
const backup = { url: 'https://backup.test/', name: '备用书源', searchUrl: '/books/search.html?kw={{key}}', rules: {} };
const backupSearch = () => 'https://backup.test/books/search.html?kw=' + encodeURIComponent(book.title);
const backupPage = 'https://backup.test/books/details777.html';
const backupChapter = (id: number, chapter: number) => `https://backup.test/chapter/index${id}-${chapter}.html`;
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
  // 换源测试用另一个站:host 必须先过运行时白名单(source-policy),否则请求在到达 fetch 前就被拒。
  (await import('./source-policy')).refreshSupportedHosts(['backup.test']);
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
    // 302 是源站行为不是路径故障，不触发换 host；首次请求成功（拿到 302 响应）后，
    // 预算已扣 1，重定向下一跳的 beforeRequest 撞预算即停，只此一发。
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

  it('switches source instead of a hard 409 when the stored source is gone', async () => {
    // 洞 1:旧实现在 loadSourceCatalog 抛 SOURCE_CHANGED(409)⇒ 换源流程永远到不了,
    // 用户只能手点「重新加载目录」。现在同一 URL 若还在池里就继续读;整条源被停用时进换源。
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    // (a) 源记录被刷新(revision 漂移:改名/改规则)但 URL 还在池里 —— 旧 409 挡不住阅读,
    //     直接用池里的当前记录继续读(生产复现:源名「📂网阅小说」→「网阅小说」)。
    mocks.sources.mockResolvedValue([{ ...source, name: '刷新后的书源' }]);
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part.text).toBe('离线测试正文。');
    expect(part.servedFrom).toBe('刷新后的书源');

    // (b) 源整条被停用(池空):不再 409,而是找不到备用源 ⇒ 503 章节不可读。
    // 换一章读(上一章已进暖缓存,缓存语义与源状态无关,不参与本断言)。
    mocks.sources.mockResolvedValue([]);
    await expect(service.readSourceChapter(catalog.version, 1, context()))
      .rejects.toMatchObject({ code: 'SOURCE_CHAPTER_UNAVAILABLE', status: 503 });
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
    // 洞 2:换源成功即把目录换成备用源(version/sourceId/session 一并换新),
    // 前端据此把后续章节的请求直接打向新源。
    const alternative = catalogs.get(part.version)!;
    expect(part.version).toBe(alternative.version);
    expect(part.sourceId).toBe(alternative.sourceId);
    expect(part.sourceSession).toBe(alternative.version);
    expect(part.servedFrom).toBe(alternative.sourceName);
  });

  // ---- 换源的四条洞(修复批次 fix/autoswitch-holes) ----

  it('SOURCE_CHANGED(源整条不在池里)也进换源,换源成功后 chapter/sourceId/session 换新源(洞 1+2)', async () => {
    // 旧行为:loadSourceCatalog 抛 409 SOURCE_CHANGED ⇒ 换源流程永远到不了。
    // 新行为:同 URL 换版本 ⇒ 复用当前记录(上一用例);同 URL 也没了 ⇒ 换源。
    mocks.sources.mockResolvedValue([source, backup]);
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    pages.set(chapterUrl(), { text: '', status: 404 }); // 当前源章节失效(与源被停用等价的可达路径)
    pages.set(backupSearch(), { text: '<a href="/books/details777.html">测试书</a>' });
    pages.set(backupPage, { text: detail(777, '作者', ['第1章', '第2章']) });
    // detail() 生成的章节链接从 1 起编号:第 1 章 = index777-1。
    pages.set(backupChapter(777, 1), { text: chapterHtml('备用源第1章正文') });
    // 备用站的章名写法与当前站不同(「第1章」vs「第一章」)—— 洞 4 的对齐在这里生效。
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part.text).toBe('备用源第1章正文');
    expect(part.servedFrom).toBe(backup.name);
    expect(part.version).not.toBe(catalog.version);
    expect(part.sourceId).toBe(catalogs.get(part.version)!.sourceId);
    expect(part.sourceSession).toBe(part.version);
    // 洞 2:备用源目录已落库(换源固化),新会话可直接续读下一章。
    expect(catalogs.has(part.version)).toBe(true);
    // 下一章直接用新源:不再回到故障原源(原源章节页一次都没被再请求)。
    mocks.fetch.mockClear();
    pages.set(backupChapter(777, 2), { text: chapterHtml('备用源第2章正文') });
    const next = await service.readSourceChapter(part.sourceSession!, 1, context());
    expect(next.text).toBe('备用源第2章正文');
    expect(next.servedFrom).toBe(backup.name);
    expect(mocks.fetch.mock.calls.map(([input]) => String(input))).not.toContain(chapterUrl());
  });

  it('换源候选排除当前源(同站候选降到队尾),全网只剩同站时才用它(洞 3)', async () => {
    // 当前源失效后,若候选只排除了「当前 bookUrl」,同站另一个详情页会立刻被选中 ——
    // 「换源」变成同站换 URL,仍留在故障站点。这里断言同站候选被降到**另一个站**之后。
    const sameStation = { ...source, url: 'https://book15.net/same', name: '同站备用', searchUrl: '/same/search.html?kw={{key}}' };
    mocks.sources.mockResolvedValue([source, sameStation, backup]);
    pages.set(backupSearch(), { text: '<a href="/books/details777.html">测试书</a>' });
    pages.set(backupPage, { text: detail(777, '作者', ['第一章']) });
    pages.set(backupChapter(777, 1), { text: chapterHtml('另一站正文') });
    pages.set('https://book15.net/same/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details888.html">测试书</a>',
    });
    pages.set(pageUrl(888), { text: detail(888, '作者', ['第一章']) });
    pages.set(chapterUrl(888, 1), { text: chapterHtml('同站正文') });
    // 洞 3 的正向断言:同站新 URL 必须**先不被选中** —— 一旦被选中,另一站根本不会被访问。
    const catalog = await service.resolveSourceBook(book, context(), { sources: [source, sameStation, backup] });
    const alternative = await service.resolveSourceBook(catalog, context(), {
      excludeBookUrl: catalog.bookUrl, sources: [source, sameStation, backup], preferAfterSourceUrl: catalog.sourceUrl,
    });
    expect(alternative.sourceName).toBe(backup.name); // 先出另一站,而不是同站的新 URL
    // 只剩同站时仍可用(降级不是禁止):同站候选排在最后但能被选到。
    const onlySame = await service.resolveSourceBook(catalog, context(), {
      excludeBookUrl: catalog.bookUrl, sources: [source, sameStation], preferAfterSourceUrl: catalog.sourceUrl,
    });
    expect(onlySame.sourceName).toBe('同站备用');
  });

  it('章节标题跨站写法差异仍能对齐;完全无关的章不匹配(洞 4)', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    pages.set(chapterUrl(), { text: '', status: 404 });
    pages.set(backupSearch(), { text: '<a href="/books/details777.html">测试书</a>' });
    // 备用站把「第一章」写成「第 1 章」并带主体;旧实现「归一化后须完全相同且唯一」⇒ 换源失败。
    pages.set(backupPage, { text: detail(777, '作者', ['序言', '第 1 章']) });
    pages.set(backupChapter(777, 2), { text: chapterHtml('跨站写法对齐') });
    mocks.sources.mockResolvedValue([source, backup]);
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part.text).toBe('跨站写法对齐');
    // 负对照:备用站目录里只有完全无关的章名 ⇒ 不匹配,仍 503(绝不交付别的章)。
    pages.set(backupPage, { text: detail(777, '作者', ['楔子', '风起云涌']) });
    await expect(service.readSourceChapter(catalog.version, 1, context()))
      .rejects.toMatchObject({ code: 'SOURCE_CHAPTER_UNAVAILABLE', status: 503 });
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
    expect((healthy as Error).message).not.toContain('部分请求本轮未完成');
    expect((degraded as Error).message).toContain('部分请求本轮未完成');
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

  it('still reports 503 SOURCE_UNAVAILABLE when the shared budget runs out with no results', async () => {
    // P1-1 负控：空结果 + 仅 BUDGET（无网络失败）→ 503，不能把「没搜完」说成「没这本书」。
    // 双源 miss：主源标题/作者搜索均空（2 请求），镜像源搜索触发 BUDGET。
    const target = { title: '不存在的书', author: '作者A' };
    mocks.sources.mockResolvedValue([source, { ...source, url: 'https://book15.net/mirror', searchUrl: '/mirror/search.html?kw={{key}}' }]);
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.title), { text: '' });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.author), { text: '' });
    await expect(service.resolveSourceBook(target, context(2))).rejects.toMatchObject({
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

  it('bounds a miss with the same-page fallback inside the previous request ceiling', async () => {
    // 定量红线:站点吐 23 条详情链接时,同页兜底切片与作者搜索回退**共用**同一个
    // MAX_DETAIL_CANDIDATES=4 宽度,请求数不放大。精确构成:
    //   标题搜索 1 + 同页兜底 inspect 4 + 作者搜索 1 + 作者层重走已核验候选 0(checked 去重)+ 模糊补抓 2 = 8。
    // 关键回归:同页兜底捡到无关详情链接**不得**关掉作者搜索回退 —— 它判的是「精确层 0 候选」,
    // 不是「candidates 是否为空」(40 任实测:改判据前作者搜索根本没跑,改名书路径被掐断)。
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
    // 23 个候选页全部抓取成功、身份全不符 ⇒ 这是「完整搜索后的未找到」(404),不是「书源故障」(503)。
    await expect(service.resolveSourceBook(target, context())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 404 });
    expect(mocks.fetch.mock.calls.length).toBe(8);
  });

  it('still runs the author fallback when the same-page fallback only returns unrelated books', async () => {
    // A 点回归(核心):标题搜索页有详情链接但都是**无关书**,精确层 0 候选;
    // 改名书的站点索引里只有新名,只能靠作者搜索找到 —— 而作者搜索**必须仍然触发**。
    const target = { title: '旧名', author: '作者甲' };
    // 别名走站点自报的「【原书名：X】」标记（parseSourceAlias），不是 meta。
    const renamedDetail = (id: number) =>
      '<meta property="og:novel:book_name" content="新名"><meta property="og:novel:author" content="作者甲">'
      + '<div>小说简介:【原书名：旧名】改名前的版本。</div>'
      + '<dd><a href="/chapter/index' + id + '-1.html">第一章</a></dd>';
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.title), {
      text: '<a href="/books/details61.html">无关书</a>',
    });
    pages.set('https://book15.net/books/details61.html', {
      text: '<meta property="og:novel:book_name" content="无关书"><meta property="og:novel:author" content="别人">'
        + '<dd><a href="/chapter/index61-1.html">第一章</a></dd>',
    });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.author), {
      text: '<a href="/books/details62.html">新名</a>',
    });
    pages.set('https://book15.net/books/details62.html', { text: renamedDetail(62) });
    const catalog = await service.resolveSourceBook(target, context());
    expect(catalog).toMatchObject({ title: '新名', author: '作者甲', bookUrl: 'https://book15.net/books/details62.html' });
  });

  it('falls back to same-page detail links when no anchor text matches the title exactly', async () => {
    // 核心回归:搜索页有详情链接,但锚文本带修饰(【完结】书名)⇒ parseSourceSearch 精确层 0 候选。
    // 兜底改按详情页形态收候选;身份仍由详情页的 sourceBookMatches(标题/别名 + 作者门)判定。
    const titleSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title);
    const decor = (id: number, title: string) => `<a href="/books/details${id}.html" title="${title}">【完结】${title}</a>`;
    pages.set(titleSearch, {
      text: decor(41, '测试书') + Array.from({ length: 8 }, (_, i) => `<a href="/books/details${900 + i}.html">无关书${i}</a>`).join(''),
    });
    pages.set(pageUrl(41), { text: detail(41) });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog).toMatchObject({ title: '测试书', author: '作者', bookUrl: pageUrl(41) });
  });

  it('does not mis-pair a same-title detail page by another author reached through the fallback', async () => {
    // 误配负控:兜底收到的候选里,同名详情页作者不符 ⇒ 不进 matches,继续找后面的候选。
    const titleSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title);
    pages.set(titleSearch, {
      text: '<a href="/books/details95.html" title="测试书">【完结】测试书</a>'
        + '<a href="/books/details96.html" title="测试书">测试书(全本)</a>',
    });
    pages.set('https://book15.net/books/details95.html', { text: detail(95, '别的作者') });
    pages.set(pageUrl(96), { text: detail(96) });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.bookUrl).toBe(pageUrl(96)); // 作者不符的 95 被作者门挡下,不误配
  });

  it('never auto-delivers an unrelated detail page reached through the fallback', async () => {
    // 负控:兜底收到的详情页书名作者都对不上 ⇒ 不自动取书,交回既有判据(404,不放大到 503)。
    const titleSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title);
    pages.set(titleSearch, { text: '<a href="/books/details97.html" title="别的书">别的书</a>' });
    pages.set('https://book15.net/books/details97.html', {
      text: '<meta property="og:novel:book_name" content="别的书"><meta property="og:novel:author" content="别人">'
        + '<dd><a href="/chapter/index97-1.html">第一章</a></dd>',
    });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.author), { text: '' });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND', status: 404,
    });
    // 基线不会请求这条链接（精确层 0 ⇒ 直接转作者搜索），新实现必须**真的核验过**它 ——
    // 否则这条负控在基线上恒真，证明不了兜底路径被守住（40 任审查 E）。
    expect(mocks.fetch.mock.calls.map((call) => String(call[0])))
      .toContain('https://book15.net/books/details97.html');
  });

  it('warns search_no_candidates when no anchor text matches the title exactly', async () => {
    // 只加观测：搜索页抓到（200）但锚点无一匹配 ⇒ 打一条结构化 warn，字段可 JSON.parse。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const titleSearch = 'https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title);
    pages.set(titleSearch, { text: '<html><body><a href="/books/details99.html">别的书</a></body></html>' });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.author), { text: '' });
    await service.resolveSourceBook(book, context()).catch(() => {});
    const calls = warn.mock.calls.filter(([tag]) => tag === '[read-source] search_no_candidates');
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0][1] as string);
    expect(payload).toMatchObject({
      event: 'search_no_candidates',
      sourceHost: 'book15.net',
      searchUrl: titleSearch,
      candidateCount: 0,
      title: '测试书',
      hadChallengeHint: false,
    });
    expect(typeof payload.bytes).toBe('number');
    expect(payload.bytes).toBeGreaterThan(0);
    expect(payload.searchUrl).not.toContain('#'); // 去 hash
  });

  it('flags hadChallengeHint for an anti-bot shell search page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<html><head><title>Just a moment...</title></head><body></body></html>',
    });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.author), { text: '' });
    await service.resolveSourceBook(book, context()).catch(() => {});
    const calls = warn.mock.calls.filter(([tag]) => tag === '[read-source] search_no_candidates');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1] as string).hadChallengeHint).toBe(true);
  });

  it('does not emit read-source observability warnings on the successful path', async () => {
    // 成功路径不打日志（避免日志洪泛）：默认 fixture 命中详情页并返回目录。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.resolveSourceBook(book, context());
    const observability = warn.mock.calls.filter(([tag]) => String(tag).startsWith('[read-source]'));
    expect(observability).toEqual([]);
  });

  it('warns source_not_found with per-source stats when the round ends 404', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = { title: '不存在书', author: '作者A' };
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.title), {
      text: '<a href="/books/details99.html">别的书</a>',
    });
    // 新语义下同页兜底**会**去核验这条无关详情链接（基线不会），故必须给它 fixture：
    // 抓取成功 + 身份不符 ⇒ 干净 404；不给 fixture 会让 mock 抛错、hadFailure=true、错放大成 503。
    pages.set('https://book15.net/books/details99.html', {
      text: '<meta property="og:novel:book_name" content="别的书"><meta property="og:novel:author" content="别人">'
        + '<dd><a href="/chapter/index99-1.html">第一章</a></dd>',
    });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(target.author), { text: '' });
    await expect(service.resolveSourceBook(target, context())).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND', status: 404,
    });
    const calls = warn.mock.calls.filter(([tag]) => tag === '[read-source] source_not_found');
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0][1] as string);
    expect(payload).toMatchObject({
      event: 'source_not_found',
      title: '不存在书',
      sourcesTried: 1,
      // candidates 仍只指**精确层**命中数（0）；同页兜到的那 1 条另记 fallbackCandidates
      // —— 混成一个数会让「搜索页有结果却 0 候选」这个 P0 信号失效（40 任审查 D）。
      perSource: [{ host: 'book15.net', searched: true, candidates: 0, fallbackCandidates: 1 }],
    });
    expect(typeof payload.perSource[0].bytes).toBe('number');
    // 汇总与逐源信号是两条独立事件，且都出现。
    expect(warn.mock.calls.some(([tag]) => tag === '[read-source] search_no_candidates')).toBe(true);
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

// M2-1 只做原语：SourceRequestContext.child / openPool 的语义与信号传递。
// 软预算判据与跳源循环在 M2-2（设计 §9 任务卡：本文件这 5 条才是 M2-1 的权威验收）。
describe('source budget primitives: child scopes and openPool (M2-1)', () => {
  const scopedUrl = (id: number) => `https://book15.net/books/details${id}.html`;

  it('opens the global pool with a 12 floor and a 30 cap, never shrinking', () => {
    // 设计 §3.1：openPool(n) = min(30, max(12, 6n))，幂等取最大值。
    const root = context();
    expect(root.totalLimit).toBe(12); // 池里只有 builtin：与今天的单源预算逐点相同
    root.openPool(1);
    expect(root.totalLimit).toBe(12);
    root.openPool(2);
    expect(root.totalLimit).toBe(12); // 6×2=12 仍在保底线上
    root.openPool(3);
    expect(root.totalLimit).toBe(18);
    root.openPool(5);
    expect(root.totalLimit).toBe(30);
    root.openPool(1);
    expect(root.totalLimit).toBe(30); // failover 复用同一 context 时第二次调用不得把预算收窄
  });

  it('keeps the shared counter writable for existing budget consumers', () => {
    // source-verification 的共享预算判定会直接回写 requests（source-verification.ts:69），不能退化成只读。
    const root = context();
    root.requests = root.limit;
    expect(root.requests).toBe(12);
  });

  it('shares the request counter with a child while keeping the limits independent', async () => {
    pages.set(scopedUrl(50), { text: '正文占位' });
    const root = context();
    const child = root.child('https://book15.net/mirror-page');
    expect(root.scope).toBe('builtin'); // 根 context 是 builtin 首源
    expect(child.scope).toBe('https://book15.net/mirror-page');
    expect(root.limit).toBe(12);
    expect(child.limit).toBe(service.PER_SOURCE_REQUESTS); // 单源默认 6（设计 §3.1）
    expect(root.child('https://book15.net/x', { limit: 3 }).limit).toBe(3);
    await child.page(scopedUrl(50));
    expect(child.requests).toBe(1); // 子计数写回共享
    expect(root.requests).toBe(1);
    await root.page(scopedUrl(50));
    expect(root.requests).toBe(2); // 父的请求同样进同一个计数
  });

  it('abandons only the exhausted source scope and keeps the shared count', async () => {
    // 设计 §3.3：单源点数耗尽 ⇒ SOURCE_SCOPE_EXHAUSTED（跳源信号，M2-2 消费）；
    // 父计数不回退，兄弟/首源仍可用剩余全局预算。
    for (const id of [51, 52, 53, 54]) pages.set(scopedUrl(id), { text: '正文占位' });
    const root = context();
    const child = root.child('https://book15.net/mirror-page', { limit: 2 });
    await child.page(scopedUrl(51));
    await child.page(scopedUrl(52));
    await expect(child.page(scopedUrl(53))).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED', status: 503 });
    expect(root.requests).toBe(2); // 父计数不回退
    // 红线（2eca42d）：beforeRequest 的预算拒绝不得被当成传输错误 ⇒ 不换 host 重试，一次物理请求都没多发。
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await root.page(scopedUrl(54)); // builtin 首源不受 L1 单源闸门约束
    expect(root.requests).toBe(3);
  });

  it('propagates a parent abort to an in-flight child request', async () => {
    // 验收 3：child 的 signal = AbortSignal.any([父 signal, 切片定时器])，父 abort 立刻传到子。
    const controller = new AbortController();
    const root = new service.SourceRequestContext(controller.signal);
    const child = root.child('https://book15.net/mirror-page');
    mocks.fetch.mockImplementation(() => new Promise<Response>(() => { /* 挂起，等父 abort */ }));
    const pending = child.page(scopedUrl(55));
    await new Promise((resolve) => setTimeout(resolve, 5)); // 让请求真正挂在 fetch 上
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(root.requests).toBe(1); // 已发出的点数照记
  });

  it('expires a source slice without aborting the parent', async () => {
    // 设计 §3.3 陷阱：切片只 abort 子 signal。若父 signal 也 aborted，M2-2 的循环会把它误判成整体取消。
    const root = context();
    const child = root.child('https://book15.net/mirror-page', { sliceMs: 5 });
    mocks.fetch.mockImplementation(() => new Promise<Response>(() => { /* 挂起，等切片超时 */ }));
    const error = await child.page(scopedUrl(56)).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED', status: 503 });
    expect(root.requests).toBe(1); // 切片前的点数已计入，不回退
    expect(root.signal.aborted).toBe(false); // 只 abort 子 signal
    expect(child.signal.aborted).toBe(true);
  });

  it('keeps one 350ms pacing series shared by the parent and its children', async () => {
    // 验收 4：M2 不做每 host 分桶，350ms 节流槽父子共享（沿用并发断言，证明没有按源分桶）。
    vi.mocked(Date.now).mockRestore(); // 本用例需要真实时钟测量槽位间隔
    const starts: number[] = [];
    mocks.fetch.mockImplementation(async () => {
      starts.push(Date.now());
      return new Response('<html></html>', { status: 200 });
    });
    const root = new service.SourceRequestContext(new AbortController().signal);
    const child = root.child('https://book15.net/mirror-page');
    await Promise.all([
      root.page('https://book15.net/a'),
      child.page('https://book15.net/b'),
      root.page('https://book15.net/c'),
    ]);
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(300);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(300);
  });
});

// M1 任务 4：sourceRevision 抽成共享实现后，builtin 目录版本必须逐字节不变（零回归红线）。
// 冻结的十六进制值 = 抽取前的实现 sha1(JSON.stringify([url, searchUrl, rules])) 的输出；
// 改回键排序序列化或改动 version 参与项都会让此用例红。
describe('builtin 目录版本逐字节冻结（M1 任务 4 零回归）', () => {
  it('sourceId/sourceRevision/version 与抽取前逐字节相同', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.sourceId).toBe('82ace1838da7f52acaca856ee2a528257903268b');
    expect(catalog.sourceRevision).toBe('a7be1f84fd76b1a0e25618ee7acf3d92b0e37a16');
    expect(catalog.version).toBe('3abbe7d9a0116f562e7e61ecdf119363a8876d48');
  });

  it('reader 的 sourceRevision 就是共享函数 sourceRevision(source)（同一实现）', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.sourceRevision).toBe(sourceRevision(source));
  });

  it('rules 为空的源仍走 builtin 路径（分派判据不含 rules 内容）', async () => {
    mocks.sources.mockResolvedValue([{ ...source, rules: {} }]);
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.sourceRevision).toBe(sourceRevision({ ...source, rules: {} }));
  });
});

// M1 任务 4 §7.2：rules 非空且非 builtin 的源走引擎门面；identity 校验留在调用方。
describe('引擎源分派（M1 任务 4 §7.2）', () => {
  const engineSource = {
    url: 'https://book15.net/engine/', name: '引擎源', searchUrl: 'https://book15.net/s?q={{key}}',
    tier: 'M1' as const,
    rules: {
      ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
      ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
      ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '.content@text' },
    },
  };
  const searchUrl = 'https://book15.net/s?q=' + encodeURIComponent('测试书');
  const detailUrl = 'https://book15.net/detail/1.html';
  const tocUrl = 'https://book15.net/toc/1.html';

  it('engineSearchBook → engineFetchDetail → engineFetchToc 产出目录（version 带 rule-engine-v1 前缀区分）', async () => {
    mocks.sources.mockResolvedValue([engineSource]);
    pages.set(searchUrl, { text: '<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/detail/1.html">x</a></div>' });
    pages.set(detailUrl, { text: '<h1 class="title">测试书</h1><span class="writer">作者</span><a class="toc" href="/toc/1.html">目录</a>' });
    pages.set(tocUrl, { text: '<li class="chapter"><a href="/c/1.html">第一章</a></li><li class="chapter"><a href="/c/2.html">第二章</a></li>' });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog).toMatchObject({
      title: '测试书', author: '作者', bookUrl: detailUrl,
      chapters: [{ url: 'https://book15.net/c/1.html', title: '第一章' }, { url: 'https://book15.net/c/2.html', title: '第二章' }],
    });
    // 源归属：sourceId 用引擎源的 url + 详情页 URL（与 builtin 同口径，m2-scaleout §5.1）。
    const sha1 = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
    expect(catalog.sourceId).toBe(sha1([engineSource.url, detailUrl]));
    expect(catalog.sourceRevision).toBe(sourceRevision(engineSource));
  });

  it('identity 不符时引擎源不自动取书（校验在调用方，§7.2）', async () => {
    mocks.sources.mockResolvedValue([engineSource]);
    pages.set(searchUrl, { text: '<div class="book"><span class="name">别的书</span><span class="author">别人</span><a href="/detail/1.html">x</a></div>' });
    pages.set(detailUrl, { text: '<h1 class="title">别的书</h1><span class="writer">别人</span><a class="toc" href="/toc/1.html">目录</a>' });
    pages.set(tocUrl, { text: '<li class="chapter"><a href="/c/1.html">第一章</a></li>' });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });
});

// M2-2 多源循环（设计 §3.1–§3.7 / §9 任务 M2-2）。
describe('M2-2 多源循环：跳源 / 软预算 / 去重 / bookUrl 反查', () => {
  const search = (kw: string, host = 'https://book15.net') => host + '/books/search.html?kw=' + encodeURIComponent(kw);
  const sourceB = { ...source, url: 'https://book15.net/b', name: '备用书源', searchUrl: '/b/search.html?kw={{key}}' };
  const bSearch = 'https://book15.net/b/search.html?kw=' + encodeURIComponent(book.title);
  // 引擎源 A：ruleToc.chapterList 在选择器无命中时返回空目录 ⇒ 每个候选只消耗 detail+toc 两点；
  // 4 个候选共 1+2×4 点，在单源 6 点闸门处撞 SOURCE_SCOPE_EXHAUSTED（跳源信号）。
  const engineRulesA = {
    ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: '.title@text', author: '.writer@text' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
  };
  const engineA = {
    url: 'https://book15.net/e-a/', name: '引擎A', searchUrl: 'https://book15.net/e-a?q={{key}}',
    tier: 'M1' as const, rules: engineRulesA,
  };
  const engineASearch = 'https://book15.net/e-a?q=' + encodeURIComponent(book.title);
  const engineABook = (n: number) => `https://book15.net/d/${n}.html`;
  // 首个源（builtin）干净 miss：标题/作者搜索都返回空页（无 hadFailure）。
  const primeMiss = () => {
    pages.set(search(book.title), { text: '' });
    pages.set(search(book.author), { text: '' });
  };
  const primeHitB = () => {
    pages.set(bSearch, { text: '<a href="/books/details42.html">测试书</a>' });
  };

  it('源 A 单源点数耗尽 ⇒ 跳源；源 B 命中 ⇒ 返回 B 的目录（验收 2）', async () => {
    primeMiss();
    mocks.sources.mockResolvedValue([source, engineA, sourceB]);
    pages.set(engineASearch, {
      text: [1, 2, 3, 4].map((n) => `<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/d/${n}.html">x</a></div>`).join(''),
    });
    for (const n of [1, 2, 3]) pages.set(engineABook(n), { text: '<h1 class="title">测试书</h1><span class="writer">作者</span>' });
    primeHitB();
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.sourceUrl).toBe(sourceB.url);
    expect(catalog.bookUrl).toBe(pageUrl());
    expect(catalog.sourceName).toBe('备用书源');
    // 引擎 A 在 6 点闸门处被跳源（detail+toc 各源独立计数），不会再发第 7 点请求。
    expect(mocks.fetch.mock.calls.filter(([input]) => String(input).startsWith('https://book15.net/e-a')).length).toBe(1);
  });

  it('全源耗尽（含跳源）⇒ 503 SOURCE_UNAVAILABLE，不是 404（验收 3）', async () => {
    primeMiss();
    mocks.sources.mockResolvedValue([source, engineA]);
    pages.set(engineASearch, {
      text: [1, 2, 3, 4].map((n) => `<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/d/${n}.html">x</a></div>`).join(''),
    });
    for (const n of [1, 2, 3]) pages.set(engineABook(n), { text: '<h1 class="title">测试书</h1><span class="writer">作者</span>' });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE', status: 503,
    });
  });

  it('软预算到点 ⇒ 不再发起后续源请求，已收集的命中照常返回（验收 4a）', async () => {
    mocks.sources.mockResolvedValue([source, sourceB, { ...sourceB, url: 'https://book15.net/c', name: '第三源' }]);
    const ctx = context();
    vi.mocked(Date.now).mockReturnValue(ctx.startedAt + 46_000); // elapsed 46000 > SOFT_BUDGET 45000
    // 无作者书：首源命中不提前返回（matches 累积），软预算到点后仍应交付首源命中。
    const catalog = await service.resolveSourceBook({ ...book, author: '' }, ctx);
    expect(catalog.bookUrl).toBe(pageUrl());
    expect(mocks.fetch).toHaveBeenCalledTimes(2); // 只发首源的 搜索+详情，第 2/3 源未发起
  });

  it('软预算边界：剩余恰为一片切片（elapsed 31000 ⇔ remaining 14000）⇒ 进入下一个源（验收 4b 放行侧）', async () => {
    primeMiss();
    primeHitB();
    mocks.sources.mockResolvedValue([source, sourceB]);
    const ctx = context();
    // 判据 remaining < PER_SOURCE_SLICE_MS ⇔ elapsed + slice > SOFT_BUDGET；边界 elapsed = 45000−14000 = 31000。
    vi.mocked(Date.now).mockReturnValue(ctx.startedAt + 31_000);
    const catalog = await service.resolveSourceBook(book, ctx);
    expect(catalog.sourceUrl).toBe(sourceB.url); // 第二个源被真实进入
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it('软预算边界−1ms（elapsed 31001 ⇔ remaining 13999）⇒ 不进新源、直接 break、hadFailure=true（验收 4b 拒绝侧）', async () => {
    primeMiss();
    primeHitB();
    mocks.sources.mockResolvedValue([source, sourceB]);
    const ctx = context();
    vi.mocked(Date.now).mockReturnValue(ctx.startedAt + 31_001);
    await expect(service.resolveSourceBook(book, ctx)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE', status: 503,
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2); // 第二个源一次都没发
  });

  it('单源切片超时 ⇒ 跳源（不 504），后续源照常命中（验收 5 前半，子/父 signal 陷阱）', async () => {
    primeMiss();
    primeHitB();
    const sourceHang = { ...source, url: 'https://book15.net/hang', name: '挂起源', searchUrl: '/hang/search.html?kw={{key}}' };
    const sourceC = { ...sourceB, url: 'https://book15.net/c', name: '命中源' };
    mocks.sources.mockResolvedValue([source, sourceHang, sourceC]);
    const hangUrl = 'https://book15.net/hang/search.html?kw=' + encodeURIComponent(book.title);
    // 测试注入机制：只缩短单源切片，不改生产签名（resolveSourceBook 内部仍用默认常量）。
    const ctx = context();
    const baseChild = ctx.child.bind(ctx);
    ctx.child = (scope: string) => baseChild(scope, { sliceMs: 5 });
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === hangUrl) return new Promise<Response>(() => { /* 永挂起，等切片超时 */ });
      return base(input);
    });
    const catalog = await service.resolveSourceBook(book, ctx);
    expect(catalog.sourceUrl).toBe(sourceC.url); // 切片只放弃挂起源，跳到命中源，绝不 504
    expect(ctx.signal.aborted).toBe(false); // 父 signal 未被切片 abort
  });

  it('父 signal 中止 ⇒ 仍按整体取消抛出（route 504），不被跳源吞成 503（验收 5 后半）', async () => {
    primeMiss();
    const sourceHang = { ...source, url: 'https://book15.net/hang', name: '挂起源', searchUrl: '/hang/search.html?kw={{key}}' };
    mocks.sources.mockResolvedValue([source, sourceHang]);
    const hangUrl = 'https://book15.net/hang/search.html?kw=' + encodeURIComponent(book.title);
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === hangUrl) return new Promise<Response>(() => { /* 挂起 */ });
      return base(input);
    });
    const controller = new AbortController();
    const ctx = new service.SourceRequestContext(controller.signal);
    const pending = service.resolveSourceBook(book, ctx);
    await vi.waitFor(() => expect(mocks.fetch.mock.calls.some(([input]) => String(input) === hangUrl)).toBe(true));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('无作者书跨源「同标题同作者」⇒ 返回首源；「同标题不同作者」⇒ 422（验收 6/§3.6）', async () => {
    mocks.sources.mockResolvedValue([source, sourceB]);
    // 同作者：两个源各命中一条 catalog，去重后保留源优先级最高的首条。
    pages.set(bSearch, { text: '<a href="/books/details43.html">测试书</a>' });
    pages.set(pageUrl(43), { text: detail(43, '作者', ['第一章']) });
    const same = await service.resolveSourceBook({ ...book, author: '' }, context());
    expect(same.bookUrl).toBe(pageUrl()); // 首源（book15 主源），不 422
    // 不同作者：同名不同书，仍是真歧义，保留 422。
    pages.set(pageUrl(43), { text: detail(43, '别的作者', ['第一章']) });
    await expect(service.resolveSourceBook({ ...book, author: '' }, context())).rejects.toMatchObject({
      code: 'SOURCE_AMBIGUOUS', status: 422,
    });
  });

  it('bookUrl 确认路径不建 child、不调 openPool，只走根预算（验收 8a/8b）', async () => {
    mocks.sources.mockResolvedValue([source, engineA]); // 池里有引擎源，openPool 本会被触发
    pages.set('https://book15.net/books/details77.html', {
      text: detail(77, '随便什么作者').replace('content="测试书"', 'content="随便什么书名"'),
    });
    const childSpy = vi.spyOn(service.SourceRequestContext.prototype, 'child');
    const poolSpy = vi.spyOn(service.SourceRequestContext.prototype, 'openPool');
    const catalog = await service.resolveSourceBook(book, context(), { bookUrl: 'https://book15.net/books/details77.html' });
    expect(catalog).toMatchObject({ title: '随便什么书名', author: '随便什么作者' });
    expect(childSpy).not.toHaveBeenCalled(); // 无 child ⇒ 无切片定时器 ⇒ SOURCE_SCOPE_EXHAUSTED 不可能出现
    expect(poolSpy).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('bookUrl 按 host 反查引擎源（不再硬取 sources[0]），走同一引擎构造器（验收 8c）', async () => {
    const { refreshSupportedHosts } = await import('./source-policy');
    refreshSupportedHosts(['engine.test']);
    const engineHost = {
      url: 'https://engine.test/', name: '外部引擎', searchUrl: 'https://engine.test/s?q={{key}}',
      tier: 'M1' as const,
      rules: {
        ruleSearch: engineRulesA.ruleSearch,
        ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
        ruleToc: engineRulesA.ruleToc,
      },
    };
    mocks.sources.mockResolvedValue([source, engineHost]); // sources[0] 恒为 builtin
    pages.set('https://engine.test/d/1.html', { text: '<h1 class="title">外部书</h1><span class="writer">外作者</span><a class="toc" href="/toc/1.html">目录</a>' });
    pages.set('https://engine.test/toc/1.html', { text: '<li class="chapter"><a href="/c/1.html">第一章</a></li>' });
    const catalog = await service.resolveSourceBook(book, context(), { bookUrl: 'https://engine.test/d/1.html' });
    expect(catalog.sourceUrl).toBe(engineHost.url); // 源标识来自反查到的引擎源，而非 builtin
    expect(catalog.sourceName).toBe('外部引擎');
    expect(catalog.chapters).toHaveLength(1);
  });

  it('bookUrl 的 host 不在池内 ⇒ 404 重选（不回退 sources[0]）（验收 8c 负控）', async () => {
    const { refreshSupportedHosts } = await import('./source-policy');
    refreshSupportedHosts(['engine.test']);
    mocks.sources.mockResolvedValue([source]);
    await expect(service.resolveSourceBook(book, context(), { bookUrl: 'https://engine.test/d/1.html' }))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 404 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('引擎源 identity 回退链：ruleBookInfo 缺 name/author ⇒ 用 ruleSearch 的名字/作者（验收 9）', async () => {
    const engineFallback = {
      url: 'https://book15.net/e-f/', name: '引擎回退', searchUrl: 'https://book15.net/e-f?q={{key}}',
      tier: 'M1' as const,
      rules: {
        ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
        ruleBookInfo: { tocUrl: '.toc@href' }, // 只有 tocUrl，没有 name/author
        ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
      },
    };
    const searchUrl = 'https://book15.net/e-f?q=' + encodeURIComponent(book.title);
    const detailUrl = 'https://book15.net/f/detail/1.html';
    mocks.sources.mockResolvedValue([engineFallback]);
    pages.set(searchUrl, { text: '<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/f/detail/1.html">x</a></div>' });
    pages.set(detailUrl, { text: '<a class="toc" href="/f/toc/1.html">目录</a>' }); // 详情页无 .title/.writer
    pages.set('https://book15.net/f/toc/1.html', { text: '<li class="chapter"><a href="/f/c/1.html">第一章</a></li>' });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog).toMatchObject({ title: '测试书', author: '作者' }); // 回退到搜索结果
    expect(catalog.chapters).toHaveLength(1);
  });

  it('章节级 failover 复用父 context：预算累加、openPool 不收窄（验收 7/§3.4）', async () => {
    mocks.sources.mockResolvedValue([source, engineA]);
    const ctx = context();
    await service.resolveSourceBook(book, ctx);
    const firstRequests = ctx.requests;
    const firstLimit = ctx.totalLimit;
    await service.resolveSourceBook(book, ctx);
    expect(ctx.requests).toBeGreaterThan(firstRequests); // 重试吃的是剩余预算，不续杯
    expect(ctx.totalLimit).toBe(firstLimit); // 二次 openPool 幂等取最大值
  });
});

// N01（P2）：目录加载保留 ReadingSource，chapterText 按 builtin/engine 分派正文提取。
// 反例出处：codex 复核报告 2026-09-19 §N01 —— 合成规则 ruleContent.content='#body@text' +
// 正文 <div id="body">…</div>：engineFetchContent 直接调成功，readSourceChapter 却返回
// SOURCE_CHAPTER_UNAVAILABLE（因为正文只走 book15 的 parseSourceChapterText）。
describe('引擎源正文分派（N01）', () => {
  // 对齐 N01 反例的合成规则：ruleContent.content='#body@text'。
  const contentEngineSource = {
    url: 'https://book15.net/n01/', name: 'N01引擎源', searchUrl: 'https://book15.net/n01s?q={{key}}',
    tier: 'M1' as const,
    rules: {
      ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
      ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
      ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '#body@text' },
    },
  };
  const n01Search = 'https://book15.net/n01s?q=' + encodeURIComponent(book.title);
  const n01Detail = 'https://book15.net/n01/d/1.html';
  const n01Toc = 'https://book15.net/n01/toc/1.html';
  const n01Chapter = 'https://book15.net/n01/c/1.html';
  const primeEngineCatalog = async () => {
    mocks.sources.mockResolvedValue([contentEngineSource]);
    pages.set(n01Search, { text: '<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/n01/d/1.html">x</a></div>' });
    pages.set(n01Detail, { text: '<h1 class="title">测试书</h1><span class="writer">作者</span><a class="toc" href="/n01/toc/1.html">目录</a>' });
    pages.set(n01Toc, { text: '<li class="chapter"><a href="/n01/c/1.html">第一章</a></li>' });
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    return catalog;
  };

  it('引擎源目录 + #body@text 正文 → readSourceChapter 成功（对齐 N01 反例）', async () => {
    const catalog = await primeEngineCatalog();
    pages.set(n01Chapter, { text: '<div id="body">Synthetic chapter body.</div>' });
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part.text).toBe('Synthetic chapter body.');
    expect(part).toMatchObject({ sourceId: catalog.sourceId, chapterIndex: 0, servedFrom: 'N01引擎源' });
  });

  it('反例对照：同一输入 engineFetchContent 直接调成功（不经过 readSourceChapter）', async () => {
    // 反例的另一半：修复前 engineFetchContent 本身就是好的，坏的是 chapterText 的分派缺失。
    const { engineFetchContent } = await import('./rule-engine/api');
    const { compileSource } = await import('./rule-engine/compile');
    const engine = {
      url: contentEngineSource.url, name: contentEngineSource.name, searchUrl: contentEngineSource.searchUrl,
      compiled: compileSource({ url: contentEngineSource.url, searchUrl: contentEngineSource.searchUrl, rules: contentEngineSource.rules }),
    };
    pages.set(n01Chapter, { text: '<div id="body">Synthetic chapter body.</div>' });
    expect(await engineFetchContent(engine, n01Chapter, context())).toEqual({ text: 'Synthetic chapter body.' });
  });

  it('builtin 源仍走 parseSourceChapterText（行为不变）：#body 页面对 builtin 是无效正文', async () => {
    const catalog = await service.resolveSourceBook(book, context()); // 默认 fixture = builtin book15
    catalogs.set(catalog.version, catalog);
    // builtin 的章节 URL 换成引擎式 #body 正文页：parseSourceChapterText 找不到
    // <li class="chapter-content"> ⇒ 按既有语义失败（负控：builtin 分支没被引擎化）。
    pages.set(chapterUrl(), { text: '<div id="body">Synthetic chapter body.</div>' });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), { text: '' });
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.author), { text: '' });
    await expect(service.readSourceChapter(catalog.version, 0, context()))
      .rejects.toMatchObject({ code: 'SOURCE_CHAPTER_UNAVAILABLE', status: 503 });
  });

  it('builtin 源正常正文仍走 parseSourceChapterText 且成功（逐字不变）', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part.text).toBe('离线测试正文。'); // 默认 fixture：<li class="chapter-content"><p>…</p></li>
  });

  it('引擎正文规则不命中（空正文）→ SOURCE_CHAPTER_UNAVAILABLE 语义保持', async () => {
    const catalog = await primeEngineCatalog();
    // 规则 #body 不命中 ⇒ engineFetchContent 返回空串 ⇒ 分派层抛书源未提供有效正文
    // ⇒ 主路径失败进 failover；failover（同池同书）也无匹配目录 ⇒ SOURCE_CHAPTER_UNAVAILABLE。
    pages.set(n01Chapter, { text: '<div class="no-body">别的容器</div>' });
    pages.set(n01Search, { text: '' });
    await expect(service.readSourceChapter(catalog.version, 0, context()))
      .rejects.toMatchObject({ code: 'SOURCE_CHAPTER_UNAVAILABLE', status: 503 });
  });

  it('换源后备用源为引擎源 → 备用源正文走引擎（按备用源自己的规则分派）', async () => {
    // 主源 builtin 目录第一章正文 404 ⇒ failover；备用引擎源命中同书 ⇒ 备用正文按 #body@text 取。
    mocks.sources.mockResolvedValue([source, contentEngineSource]);
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    pages.set(chapterUrl(), { text: '', status: 404 });
    pages.set(n01Search, { text: '<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/n01/d/1.html">x</a></div>' });
    pages.set(n01Detail, { text: '<h1 class="title">测试书</h1><span class="writer">作者</span><a class="toc" href="/n01/toc/1.html">目录</a>' });
    pages.set(n01Toc, { text: '<li class="chapter"><a href="/n01/c/1.html">第一章</a></li>' });
    pages.set(n01Chapter, { text: '<div id="body">备用引擎源正文。</div>' });
    const part = await service.readSourceChapter(catalog.version, 0, context());
    expect(part.text).toBe('备用引擎源正文。');
    expect(part.servedFrom).toBe('N01引擎源');
    // 洞 2:换源后目录归属换成备用源(不再是主源 catalog)。
    expect(part.sourceId).toBe(catalogs.get(part.version)!.sourceId);
  });

  it('端到端（离线，源池/DB mock）：引擎源目录成功 → 正文成功', async () => {
    // 完整链路 = GET /api/read/source/index（建目录+落库）→ GET /api/read/source/chapter（读正文）。
    mocks.sources.mockResolvedValue([contentEngineSource]);
    pages.set(n01Search, { text: '<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/n01/d/1.html">x</a></div>' });
    pages.set(n01Detail, { text: '<h1 class="title">测试书</h1><span class="writer">作者</span><a class="toc" href="/n01/toc/1.html">目录</a>' });
    pages.set(n01Toc, { text: '<li class="chapter"><a href="/n01/c/1.html">第一章</a></li>' });
    pages.set(n01Chapter, { text: '<div id="body">Synthetic chapter body.</div>' });
    const indexRes = await request(); // index：title=测试书&author=作者
    expect(indexRes.status).toBe(200);
    const index = await indexRes.json();
    expect(index.title).toBe('测试书');
    expect(index.source.name).toBe('N01引擎源');
    const partRes = await request('chapter', `session=${index.source.session}&version=${index.version}&chapter=0`);
    expect(partRes.status).toBe(200);
    expectPrivate(partRes);
    expect((await partRes.json()).text).toBe('Synthetic chapter body.');
  });
});

