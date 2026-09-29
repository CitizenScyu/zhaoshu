// 41-fanout53（CC main42）：引擎档搜索「坏候选隔离」的合成复现。
// 覆盖任务书四场景（引擎源）：正确命中 / 同名异作拒绝 / 坏候选隔离 / 全部候选失败可重试。
// 全合成：fetch 按 URL 取夹具、白名单外一律 Unexpected（零真实网络、零 DB 写、零凭据）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Query = { text: string; values: unknown[] };
const mocks = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn(), sources: vi.fn(), selectable: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('./db', () => ({ getSql: mocks.getSql, ensureSchema: mocks.ensureSchema }));
vi.mock('./shuyuan', () => ({
  getReadingSources: mocks.sources,
  getSourcePools: async (signal: AbortSignal) => {
    const traversal = await mocks.sources(signal);
    return { traversal, selectable: (await mocks.selectable(signal)) ?? traversal };
  },
}));

let service: typeof import('./source-reader');

// 引擎源：搜索列表 .book、详情 .title/.writer、目录 .chapter（41-swq 惯例夹具）。
const engineSource = {
  url: 'https://e1.test/', name: '引擎源1', searchUrl: 'https://e1.test/s?q={{key}}',
  tier: 'M1' as const,
  rules: {
    ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  },
};
const book = { title: '测试书', author: '作者' };
const searchUrl = 'https://e1.test/s?q=' + encodeURIComponent(book.title);
const detailUrl = (id: number) => `https://e1.test/d${id}.html`;
const detail = (id: number, author = '作者', title = '测试书') =>
  `<h1 class="title">${title}</h1><span class="writer">${author}</span><a class="toc" href="/t${id}.html">目录</a>`;
const toc = (id: number) =>
  `<li class="chapter"><a href="/c${id}-1.html">第一章</a></li><li class="chapter"><a href="/c${id}-2.html">第二章</a></li>`;
const item = (id: number, title: string, author: string) =>
  `<div class="book"><span class="name">${title}</span><span class="author">${author}</span><a href="/d${id}.html">x</a></div>`;

const pages = new Map<string, { text?: string; status?: number }>();
const networkFailure = { status: -2 } as const;
const context = (limit?: number) => new service.SourceRequestContext(new AbortController().signal, limit);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  pages.clear();
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?'), values });
  const transaction = vi.fn(async (queries: Query[]) => queries.map(() => []));
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction }));
  mocks.sources.mockResolvedValue([engineSource]);
  mocks.selectable.mockReset();
  mocks.fetch.mockImplementation(async (input) => {
    const fixture = pages.get(String(input));
    if (!fixture) throw new Error('Unexpected source request ' + input);
    if (fixture.status === -2) throw new TypeError('fetch failed');
    return new Response(fixture.text, { status: fixture.status ?? 200 });
  });
  vi.stubGlobal('fetch', mocks.fetch);
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time += 400);
  service = await import('./source-reader');
  (await import('./source-policy')).refreshSupportedHosts(['e1.test']);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('53-search53: 引擎档候选循环四场景', () => {
  it('场景1 正确命中：搜索→详情→目录，有作者书首命中即交付', async () => {
    pages.set(searchUrl, { text: item(1, '测试书', '作者') });
    pages.set(detailUrl(1), { text: detail(1) });
    pages.set('https://e1.test/t1.html', { text: toc(1) });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog).toMatchObject({ title: '测试书', author: '作者', bookUrl: detailUrl(1) });
    expect(catalog.chapters).toHaveLength(2);
  });

  it('场景2 同名异作拒绝：错误作者候选不得自动确认，正确书随后命中', async () => {
    // d1 是同名异作（站点搜索行作者错标为同作者、详情页自报真实作者「别人」）：
    // 搜索行 rank=-1 排最前，详情页身份 sourceBookMatches 用详情作者 → 拒绝、continue。
    // d2 是正确书 → 交付。防「错误自动确认」。
    pages.set(searchUrl, { text: item(1, '测试书', '作者') + item(2, '测试书', '作者') });
    pages.set(detailUrl(1), { text: detail(1, '别人') });
    pages.set('https://e1.test/t1.html', { text: toc(1) });
    pages.set(detailUrl(2), { text: detail(2) });
    pages.set('https://e1.test/t2.html', { text: toc(2) });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.bookUrl).toBe(detailUrl(2));
    expect(catalog.author).toBe('作者');
  });

  it('场景3 坏候选隔离：前排详情 500/连接失败，后排正确同书照常交付', async () => {
    // 三个候选都是同一本书（站点重复上架）。d1 详情 500（重试后仍 500）、
    // d2 连接层失败（fetch failed）、d3 完好。坏候选不得阻断 d3。
    pages.set(searchUrl, { text: item(1, '测试书', '作者') + item(2, '测试书', '作者') + item(3, '测试书', '作者') });
    pages.set(detailUrl(1), { text: '', status: 500 });
    pages.set(detailUrl(2), networkFailure);
    pages.set(detailUrl(3), { text: detail(3) });
    pages.set('https://e1.test/t3.html', { text: toc(3) });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog).toMatchObject({ title: '测试书', author: '作者', bookUrl: detailUrl(3) });
    expect(catalog.chapters).toHaveLength(2);
  });

  it('场景3b 坏候选隔离：详情页解析壳页（无 tocUrl、目录空）不阻断后续候选', async () => {
    // d1 详情页是反爬壳页：ruleBookInfo 全部取空 ⇒ 无 tocUrl ⇒ 回退用 d1 自身抓目录 ⇒
    // 解析出 0 章 ⇒ continue（不是异常路径，是空目录路径）。d2 真书照常交付。
    pages.set(searchUrl, { text: item(1, '测试书', '作者') + item(2, '测试书', '作者') });
    pages.set(detailUrl(1), { text: '<div>Just a moment...</div>' });
    pages.set(detailUrl(2), { text: detail(2) });
    pages.set('https://e1.test/t2.html', { text: toc(2) });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.bookUrl).toBe(detailUrl(2));
    expect(catalog.chapters).toHaveLength(2);
  });

  it('场景4 全部候选失败可重试：整轮 503 SOURCE_UNAVAILABLE（不是 404）', async () => {
    // 三个候选详情全 500：hadFailure ⇒ 503 SOURCE_UNAVAILABLE（可重试语义），不是 404「没这本书」。
    pages.set(searchUrl, { text: item(1, '测试书', '作者') + item(2, '测试书', '作者') });
    pages.set(detailUrl(1), { text: '', status: 500 });
    pages.set(detailUrl(2), { text: '', status: 500 });
    await expect(service.resolveSourceBook(book, context()))
      .rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 503 });
    expect(mocks.fetch.mock.calls.map(([url]) => String(url)))
      .not.toContain('https://e1.test/s?q=' + encodeURIComponent(book.author));
  });
});

describe('53-rename53: 引擎档改名书缺口（builtin 有作者搜索回退+别名，引擎档没有）', () => {
  // 生产真实形态（book15 实测先例）：站点把书上架为新名，简介自报【原书名：X】。
  // builtin 档：标题搜索 0 候选 ⇒ 作者搜索回退 ⇒ 详情页别名过门 ⇒ 交付（source-reader.test.ts:317 已钉）。
  // 引擎档基线：标题搜索 0 行级匹配 ⇒ 直接 miss——同一本书在引擎源上搜不到 ⇒ 404。
  const renamed = { title: '旧书名', author: '作者' };
  const renamedSearchUrl = 'https://e1.test/s?q=' + encodeURIComponent(renamed.title);
  const authorSearchUrl = 'https://e1.test/s?q=' + encodeURIComponent(renamed.author);
  const renamedDetailHtml = '<h1 class="title">新名字</h1><span class="writer">作者</span>'
    + '<p class="intro">小说简介:【原书名：旧书名】站点改名上架。</p>'
    + '<a class="toc" href="/t9.html">目录</a>';

  const prepareRenamed = () => {
    pages.set(renamedSearchUrl, { text: '<div>没有结果</div>' });
    pages.set(authorSearchUrl, { text: item(9, '新名字', '作者') });
    pages.set(detailUrl(9), { text: renamedDetailHtml });
    pages.set('https://e1.test/t9.html', { text: toc(9) });
  };

  it('修后绿测：引擎源改名书经作者搜索回退 + 详情别名过门交付（与 builtin 同语义）', async () => {
    pages.set(renamedSearchUrl, { text: '<div>没有结果</div>' });       // 旧书名搜索 0 行
    pages.set(authorSearchUrl, { text: item(9, '新名字', '作者') });     // 作者搜索能搜到（站点索引只有新名）
    pages.set(detailUrl(9), { text: renamedDetailHtml });
    pages.set('https://e1.test/t9.html', { text: toc(9) });
    const catalog = await service.resolveSourceBook(renamed, context());
    expect(catalog).toMatchObject({ title: '新名字', author: '作者', alias: '旧书名', bookUrl: detailUrl(9) });
    expect(catalog.chapters).toHaveLength(2);
    expect(mocks.fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([renamedSearchUrl, authorSearchUrl, detailUrl(9), 'https://e1.test/t9.html']);
  });

  it('负控：作者搜索回退仍拒绝同名异作（作者不符不因回退放宽）', async () => {
    pages.set(renamedSearchUrl, { text: '<div>没有结果</div>' });
    pages.set(authorSearchUrl, { text: item(9, '新名字', '作者') });
    // 详情页作者是「别人」：作者门拒绝 ⇒ 不得交付，落 404（无 hadFailure）。
    pages.set(detailUrl(9), { text: '<h1 class="title">新名字</h1><span class="writer">别人</span>'
      + '<p class="intro">小说简介:【原书名：旧书名】站点改名上架。</p>'
      + '<a class="toc" href="/t9.html">目录</a>' });
    pages.set('https://e1.test/t9.html', { text: toc(9) });
    await expect(service.resolveSourceBook(renamed, context()))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 404 });
    expect(mocks.fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([renamedSearchUrl, authorSearchUrl, detailUrl(9)]);
  });

  it('负控：标题已命中时不跑作者回退（不多发请求）', async () => {
    pages.set(renamedSearchUrl, { text: item(9, '旧书名', '作者') });
    pages.set(detailUrl(9), { text: detail(9, '作者', '旧书名') });
    pages.set('https://e1.test/t9.html', { text: toc(9) });
    const before = 0;
    const catalog = await service.resolveSourceBook(renamed, context());
    expect(catalog.bookUrl).toBe(detailUrl(9));
    // 只发 搜索+详情+目录 3 点，无作者搜索第 4 点。
    expect(mocks.fetch).toHaveBeenCalledTimes(before + 3);
  });

  it('负控：无作者书不触发引擎作者回退', async () => {
    pages.set(searchUrl, { text: '<div>没有结果</div>' });
    await expect(service.resolveSourceBook({ title: '测试书', author: '' }, context()))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 404 });
    // 只发 1 点（标题搜索），未发作者搜索。
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['probe', 'survey'] as const)('改名书在%s入口同样可见', async (entry) => {
    prepareRenamed();
    if (entry === 'probe') {
      expect(await service.probeSourceForBook(engineSource, renamed, new AbortController().signal))
        .toMatchObject({ status: 'ok', book: { bookUrl: detailUrl(9), alias: '旧书名', chapters: 2 } });
    } else {
      expect(await service.surveySourceBooks(renamed, context()))
        .toMatchObject({ sources: [{ status: 'ok', bookUrl: detailUrl(9), chapters: 2 }], partial: false });
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([3, 4])('child总预算%s：作者搜索前需要详情及目录两点', async (limit) => {
    prepareRenamed();
    const child = context().child(engineSource.url, { limit, shareSlice: true });
    if (limit === 4) {
      expect(await service.resolveSourceBook(renamed, child)).toMatchObject({ bookUrl: detailUrl(9) });
      expect(child.requests).toBe(4);
    } else {
      await expect(service.resolveSourceBook(renamed, child)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
      expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual([renamedSearchUrl]);
    }
  });

  it('无关标题候选不会先耗光child预算', async () => {
    prepareRenamed();
    pages.set(renamedSearchUrl, { text: [1, 2, 3, 4].map((id) => item(id, '无关书' + id, '别人')).join('') });
    const child = context().child(engineSource.url, { limit: 6, shareSlice: true });
    expect(await service.resolveSourceBook(renamed, child)).toMatchObject({ bookUrl: detailUrl(9) });
    expect(mocks.fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([renamedSearchUrl, authorSearchUrl, detailUrl(9), 'https://e1.test/t9.html']);
  });

  it('作者搜索重复的已检查详情URL不重抓', async () => {
    prepareRenamed();
    pages.set(renamedSearchUrl, { text: item(1, '无关作品', '别人') });
    pages.set(detailUrl(1), { text: detail(1, '别人', '无关作品') });
    pages.set(authorSearchUrl, { text: item(1, '无关作品', '别人') + item(9, '新名字', '作者') });
    expect(await service.resolveSourceBook(renamed, context())).toMatchObject({ bookUrl: detailUrl(9) });
    expect(mocks.fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([renamedSearchUrl, detailUrl(1), authorSearchUrl, detailUrl(9), 'https://e1.test/t9.html']);
  });

  it.each(['', '错标作者'])('精确书名行作者%s不因预算预留被跳过，身份仍由详情核对', async (searchAuthor) => {
    pages.set(renamedSearchUrl, { text: item(9, '旧书名', searchAuthor) });
    pages.set(detailUrl(9), { text: detail(9, '作者', '旧书名') });
    pages.set('https://e1.test/t9.html', { text: toc(9) });
    const child = context().child(engineSource.url, { limit: 6, shareSlice: true });
    expect(await service.resolveSourceBook(renamed, child)).toMatchObject({ author: '作者', bookUrl: detailUrl(9) });
    expect(mocks.fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([renamedSearchUrl, detailUrl(9), 'https://e1.test/t9.html']);
  });

  it('相同作者没有自报原名时不认领改名书，probe记miss而非无候选', async () => {
    prepareRenamed();
    pages.set(detailUrl(9), { text: detail(9, '作者', '新名字') });
    expect(await service.probeSourceForBook(engineSource, renamed, new AbortController().signal))
      .toMatchObject({ status: 'miss' });
    expect(mocks.fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([renamedSearchUrl, authorSearchUrl, detailUrl(9)]);
  });

  it('详情作者缺省仍按既有设计用搜索行作者，作者等于书名不二次搜索', async () => {
    prepareRenamed();
    pages.set(detailUrl(9), { text: renamedDetailHtml.replace('<span class="writer">作者</span>', '') });
    expect(await service.resolveSourceBook(renamed, context())).toMatchObject({ author: '作者', alias: '旧书名' });
    mocks.fetch.mockClear();
    await expect(service.resolveSourceBook({ title: '旧书名', author: '旧书名' }, context()))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual([renamedSearchUrl]);
  });
});
