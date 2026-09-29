// 53-ratelimit（cc-source-ratelimit53）：上游限流与恢复节奏的合成复现。
// 任务书 B 段：429/503 与 Retry-After 的传递、取消/预算结束后是否还有无用请求、
// 同一限流源是否反复被打而挤掉备用源。全合成：fetch 按记录顺序回放、假时钟、零真实网络。
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

// builtin 夹具（与 source-reader.test.ts 同款形态）。
const source = { url: 'https://book15.net/', name: '测试书源', searchUrl: '/books/search.html?kw={{key}}', rules: {} };
const backup = { url: 'https://backup.test/', name: '备用书源', searchUrl: '/books/search.html?kw={{key}}', rules: {} };
const book = { title: '测试书', author: '作者' };
const pageUrl = (id = 42) => `https://book15.net/books/details${id}.html`;
const backupDetail = (id = 777) =>
  `<meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者">`
  + `<dd><a href="/chapter/index${id}-1.html">第一章</a></dd><dd><a href="/chapter/index${id}-2.html">第二章</a></dd>`;

// 引擎源夹具（与 source-reader.fanout53.test.ts 同款形态）。
const engineSource = {
  url: 'https://e1.test/', name: '引擎源', searchUrl: 'https://e1.test/s?q={{key}}',
  tier: 'M1' as const,
  rules: {
    ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  },
};
const eSearch = (key: string) => 'https://e1.test/s?q=' + encodeURIComponent(key);
const eDetail = (id: number) => `https://e1.test/d${id}.html`;
const engineDetailHtml = (id: number, author = '作者') =>
  `<h1 class="title">测试书</h1><span class="writer">${author}</span><a class="toc" href="/t${id}.html">目录</a>`;
const engineToc = (id: number) =>
  `<li class="chapter"><a href="/c${id}-1.html">第一章</a></li><li class="chapter"><a href="/c${id}-2.html">第二章</a></li>`;
const engineItem = (id: number, title = '测试书', author = '作者') =>
  `<div class="book"><span class="name">${title}</span><span class="author">${author}</span><a href="/d${id}.html">x</a></div>`;

// 合成 fetch：按完整请求 URL 回放固定页（status/headers/retryAfterMs 可控），并记录发射时间线。
const pages = new Map<string, { text?: string; status?: number; headers?: Record<string, string> }>();
const timeline: Array<{ url: string; at: number }> = [];
let nowMs: number;
const context = (limit?: number) => new service.SourceRequestContext(new AbortController().signal, limit);
const callsTo = (host: string) => timeline.filter((entry) => entry.url.includes(host)).length;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  pages.clear();
  timeline.length = 0;
  nowMs = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?'), values });
  const transaction = vi.fn(async (queries: Query[]) => queries.map(() => []));
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction }));
  mocks.sources.mockResolvedValue([source]);
  mocks.selectable.mockReset();
  mocks.fetch.mockImplementation(async (input) => {
    const url = String(input);
    const fixture = pages.get(url);
    timeline.push({ url, at: Date.now() });
    if (!fixture) throw new Error('Unexpected source request ' + url);
    if (fixture.status === -2) throw new TypeError('fetch failed');
    return new Response(fixture.text ?? '', { status: fixture.status ?? 200, headers: fixture.headers });
  });
  vi.stubGlobal('fetch', mocks.fetch);
  service = await import('./source-reader');
  (await import('./source-policy')).refreshSupportedHosts(['backup.test', 'e1.test']);
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('53-ratelimit：429 的候选层与作者回退行为（builtin 档）', () => {
  it('搜索页 429 ⇒ 跳源，不再打该站（既有语义，负控）', async () => {
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), { status: 429, headers: { 'retry-after': '60' } });
    mocks.sources.mockResolvedValue([source, backup]);
    pages.set('https://backup.test/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details777.html">测试书</a>',
    });
    pages.set('https://backup.test/books/details777.html', { text: backupDetail() });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.bookUrl).toBe('https://backup.test/books/details777.html');
    expect(callsTo('book15.net')).toBe(1);
  });

  it('详情页 429 ⇒ 止损跳源：不再打同站其余候选、不再作者回退（53-ratelimit 修复回归）', async () => {
    // 搜索页正常返回 3 个精确候选；第一个详情页 429 + Retry-After: 60。
    // 修复前行为（基线 b0985ac 复现）：3 个详情全打完（≥4 次物理请求），Retry-After 无人消费。
    // 修复后判据：首个 429 详情即止损——同站恰 2 次（搜索 1 + 详情 1），作者回退被拦。
    mocks.sources.mockResolvedValue([source, backup]);
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details41.html">测试书</a><a href="/books/details42.html">测试书</a><a href="/books/details43.html">测试书</a>',
    });
    for (const id of [41, 42, 43]) pages.set(pageUrl(id), { status: 429, headers: { 'retry-after': '60' } });
    pages.set('https://backup.test/books/search.html?kw=' + encodeURIComponent(book.author), { status: 404 });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 503 });
    expect(callsTo('book15.net')).toBe(2);
  });

  it('详情页 429 止损后备用源照常拿到全书（预算不再被限流源挤占）', async () => {
    // 限流源吃掉 2 点即止；备用源用剩余预算完成搜索→详情→交付。
    mocks.sources.mockResolvedValue([source, backup]);
    pages.set('https://book15.net/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details41.html">测试书</a><a href="/books/details42.html">测试书</a>',
    });
    for (const id of [41, 42]) pages.set(pageUrl(id), { status: 429, headers: { 'retry-after': '60' } });
    pages.set('https://backup.test/books/search.html?kw=' + encodeURIComponent(book.title), {
      text: '<a href="/books/details777.html">测试书</a>',
    });
    pages.set('https://backup.test/books/details777.html', { text: backupDetail() });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.bookUrl).toBe('https://backup.test/books/details777.html');
    expect(callsTo('book15.net')).toBe(2); // 429 止损：搜索 1 + 详情 1，不多打
  });
});

describe('53-ratelimit：503 与 Retry-After 的退避', () => {
  it('page() 对带有效 Retry-After 的 503 首次响应即停止重试', async () => {
    pages.set(pageUrl(), { status: 503, headers: { 'retry-after': '60' } });
    await expect(context().page(pageUrl())).rejects.toMatchObject({ status: 503 });
    expect(callsTo('book15.net')).toBe(1);
  });
});

describe('53-ratelimit：引擎档候选循环', () => {
  it('引擎源详情 429 ⇒ 止损跳源：同站恰 2 次物理请求（修复回归）', async () => {
    // 修复前（基线 b0985ac）：搜索 1 + 两个 429 详情 ≥ 3 次；修复后首个 429 即止损。
    mocks.sources.mockResolvedValue([engineSource]);
    pages.set(eSearch(book.title), { text: engineItem(1) + engineItem(2) });
    pages.set(eDetail(1), { status: 429, headers: { 'retry-after': '60' } });
    pages.set(eDetail(2), { status: 429, headers: { 'retry-after': '60' } });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 503 });
    expect(callsTo('e1.test')).toBe(2); // 搜索 1 + 首个 429 详情，第二个候选不再打
  });

  it('无 Retry-After 的普通 4xx/网络失败不触发止损（负控：既有 continue 语义不变）', async () => {
    // 404 是「这本书的详情页没了」，不是「站点限流」：其余候选照常打，好候选仍能交付。
    mocks.sources.mockResolvedValue([engineSource]);
    pages.set(eSearch(book.title), { text: engineItem(1) + engineItem(2) });
    pages.set(eDetail(1), { status: 404 });
    pages.set(eDetail(2), { text: engineDetailHtml(2) });
    pages.set('https://e1.test/t2.html', { text: engineToc(2) });
    const catalog = await service.resolveSourceBook(book, context());
    expect(catalog.bookUrl).toBe(eDetail(2));
    expect(callsTo('e1.test')).toBe(4); // 搜索 1 + 404 详情 1 + 好详情 1 + 目录 1
  });

  it('带 Retry-After 的 503 同样触发止损（retryAfterMs 路径）', async () => {
    mocks.sources.mockResolvedValue([engineSource]);
    pages.set(eSearch(book.title), { text: engineItem(1) + engineItem(2) });
    pages.set(eDetail(1), { status: 503, headers: { 'retry-after': '30' } });
    pages.set(eDetail(2), { text: engineDetailHtml(2) });
    pages.set('https://e1.test/t2.html', { text: engineToc(2) });
    await expect(service.resolveSourceBook(book, context())).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 503 });
    expect(callsTo('e1.test')).toBe(2); // 搜索 1 + 503 首次响应即止损，d2 不再打。
  });
});

describe('53-ratelimit：预算与取消后的多余请求（负控）', () => {
  it('L2 预算耗尽后不再发任何物理请求', async () => {
    pages.set(pageUrl(), { status: 503 });
    const budget = context(1);
    await expect(budget.page(pageUrl())).rejects.toMatchObject({ code: 'SOURCE_BUDGET_EXCEEDED' });
    // 第 1 次尝试扣 1 点；重试的 beforeRequest 撞 L2 即停 ⇒ 恰 1 次物理请求。
    expect(callsTo('book15.net')).toBe(1);
  });

  it('取消后不再发请求（既有语义，负控）', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(new service.SourceRequestContext(controller.signal).page(pageUrl())).rejects.toThrow('cancelled');
    expect(timeline).toHaveLength(0);
  });
});
