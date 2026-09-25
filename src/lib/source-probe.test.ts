import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 41-fanout 通用单源 probe（probeSourceForBook）与单源路由 /api/read/source-probe。
// 夹具沿用 source-reader.host-health.test.ts：DB mock、fetch 按 URL 取夹具、假时钟（setTimeout/clearTimeout/Date）。
// 两种源形态都要命中：引擎源（非 book15 形态，rule-engine 的 ruleSearch/ruleBookInfo/ruleToc 规则）与 builtin book15。

type Query = { text: string; values: unknown[] };
const mocks = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn(), pool: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('./db', () => ({ getSql: mocks.getSql, ensureSchema: mocks.ensureSchema }));
vi.mock('./shuyuan', async (original) => ({
  ...await original<typeof import('./shuyuan')>(),
  getReadingSources: vi.fn(async () => { throw new Error('probe 不得读取取书池'); }),
  getFanoutPool: mocks.pool,
}));

let service: typeof import('./source-reader');
const book = { title: '测试书', author: '作者' };
const q = (keyword: string) => encodeURIComponent(keyword);

// 引擎源：非 book15 形态（搜索列表 .book、详情 .title/.writer、目录 .chapter），规则取自 host-health 用例同款。
const engineRules = {
  ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.content@text' },
};
const E1 = { url: 'https://e1.test/', name: '引擎源1', searchUrl: 'https://e1.test/s?q={{key}}', tier: 'M1' as const, rules: engineRules };
const e1 = {
  search: (keyword = book.title) => 'https://e1.test/s?q=' + q(keyword),
  detail: 'https://e1.test/d/1.html',
  toc: 'https://e1.test/toc/1.html',
};
const engineListItem = (title: string, author: string, href = '/d/1.html') =>
  `<div class="book"><span class="name">${title}</span><span class="author">${author}</span><a href="${href}">x</a></div>`;
const primeEngineHit = () => {
  pages.set(e1.search(), { text: engineListItem('测试书', '作者') });
  pages.set(e1.detail, { text: '<h1 class="title">测试书</h1><span class="writer">作者</span><a class="toc" href="/toc/1.html">目录</a>' });
  pages.set(e1.toc, { text: '<li class="chapter"><a href="/c/1.html">第一章</a></li><li class="chapter"><a href="/c/2.html">第二章</a></li>' });
};

// builtin book15。
const book15 = {
  url: 'https://book15.net/', name: 'book15.net', searchUrl: 'https://book15.net/books/search.html?kw={{key}}',
  rules: {}, tier: 'builtin' as const,
};
const book15Search = (keyword = book.title) => 'https://book15.net/books/search.html?kw=' + q(keyword);
const book15Detail = (id = 42) => `https://book15.net/books/details${id}.html`;
const book15DetailHtml = (id = 42, title = '测试书', author = '作者') =>
  `<meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${author}">`
  + `<dd><a href="/chapter/index${id}-1.html">第一章</a></dd><dd><a href="/chapter/index${id}-2.html">第二章</a></dd>`;

const pages = new Map<string, { text?: string; status?: number }>();
/** 响应头延迟(虚拟毫秒);Infinity = 挂起直到请求被中止。 */
const headerDelay = new Map<string, number>();
/** 有响应头、正文卡住(直到请求被中止)的 URL。 */
const stallBody = new Set<string>();
let requested: string[];
/** 每次上游请求的发出时刻(虚拟时钟),节流用例用。 */
let stamps: { url: string; at: number }[];
/** 限流计数(scope|key_hash → attempts)。 */
const rateCounts = new Map<string, number>();

/** 假时钟下推进到定时器排空再交出结果。 */
const drive = async <T>(work: Promise<T>): Promise<T> => {
  const settled = work.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
};
const probe = (source: Parameters<typeof service.probeSourceForBook>[0], identity = book, signal = new AbortController().signal) =>
  drive(service.probeSourceForBook(source, identity, signal));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  requested = [];
  stamps = [];
  pages.clear();
  headerDelay.clear();
  stallBody.clear();
  rateCounts.clear();
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?').replace(/\s+/g, ' ').trim();
    // 限流计数(auth_rate_limits 原子 UPSERT)直接 await sql``:按 (scope, key_hash) 计数,窗口不滚动。
    if (text.includes('INSERT INTO auth_rate_limits')) {
      const key = `${values[0]}|${values[1]}`;
      rateCounts.set(key, (rateCounts.get(key) ?? 0) + 1);
      return Promise.resolve([{ attempts: rateCounts.get(key), retry_after_seconds: 321 }]);
    }
    return { text, values };
  };
  const transaction = vi.fn(async (queries: Query[]) => queries.map((query) => {
    if (query.text.includes('FROM labeled_books')) return [];
    throw new Error('probe 不得写库或读其他表: ' + query.text);
  }));
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction }));
  mocks.fetch.mockImplementation(async (input, init) => {
    const url = String(input);
    requested.push(url);
    stamps.push({ url, at: Date.now() });
    const signal = init?.signal ?? undefined;
    const wait = headerDelay.get(url);
    if (wait !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = Number.isFinite(wait)
          ? setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, wait)
          : undefined;
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (stallBody.has(url)) return new Response(new ReadableStream({ start() {} }), { status: 200 });
    const fixture = pages.get(url);
    if (!fixture) throw new Error('Unexpected source request ' + url);
    return new Response(fixture.text ?? '', { status: fixture.status ?? 200 });
  });
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  service = await import('./source-reader');
  (await import('./source-policy')).refreshSupportedHosts(['e1.test']);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('probeSourceForBook:命中', () => {
  it('引擎源(非 book15 形态)⇒ ok,带详情 URL 与章节数;只走 搜索 → 详情 → 目录', async () => {
    primeEngineHit();
    const result = await probe(E1);
    expect(result).toMatchObject({
      status: 'ok', sourceUrl: E1.url, sourceName: E1.name, requests: 3,
      book: { title: '测试书', author: '作者', bookUrl: e1.detail, chapters: 2 },
    });
    expect(requested).toEqual([e1.search(), e1.detail, e1.toc]);
  });

  it('builtin book15:精确层命中 ⇒ ok', async () => {
    pages.set(book15Search(), { text: '<a href="/books/details42.html">测试书</a>' });
    pages.set(book15Detail(), { text: book15DetailHtml() });
    const result = await probe(book15);
    expect(result).toMatchObject({ status: 'ok', book: { bookUrl: book15Detail(), chapters: 2 }, requests: 2 });
  });

  it('builtin book15:锚文本带修饰(精确层 0)⇒ parseSourceDetailLinks 同页兜底仍命中', async () => {
    pages.set(book15Search(), { text: '<a href="/books/details42.html">【完结】测试书</a>' });
    pages.set(book15Detail(), { text: book15DetailHtml() });
    const result = await probe(book15);
    expect(result).toMatchObject({ status: 'ok', book: { bookUrl: book15Detail() } });
  });
});

describe('probeSourceForBook:未命中的各结果类型', () => {
  it('搜索页 0 候选 ⇒ no_candidates', async () => {
    pages.set(e1.search(), { text: '<div>没有结果</div>' });
    expect(await probe(E1)).toMatchObject({ status: 'no_candidates', requests: 1 });
  });

  it('有候选但身份不符 ⇒ miss(不是 no_candidates)', async () => {
    pages.set(e1.search(), { text: engineListItem('别的书', '别人') });
    pages.set(e1.detail, { text: '<h1 class="title">别的书</h1><span class="writer">别人</span>' });
    expect(await probe(E1)).toMatchObject({ status: 'miss' });
  });

  it('模糊降级层(沿用 SOURCE_SIMILAR):相似详情页交给用户确认 ⇒ similar + candidates', async () => {
    pages.set(book15Search(), { text: '<a href="/books/details43.html">测试书</a>' });
    pages.set(book15Detail(43), { text: book15DetailHtml(43, '测试书(精品版)') });
    pages.set(book15Search('作者'), { text: '' });
    const result = await probe(book15);
    expect(result.status).toBe('similar');
    expect(result.candidates).toEqual([expect.objectContaining({ title: '测试书(精品版)', bookUrl: book15Detail(43), chapters: 2 })]);
  });

  it('无作者书在本源命中两部同名作品 ⇒ ambiguous', async () => {
    pages.set(book15Search(), { text: '<a href="/books/details42.html">测试书</a><a href="/books/details43.html">测试书</a>' });
    pages.set(book15Detail(42), { text: book15DetailHtml(42, '测试书', '甲') });
    pages.set(book15Detail(43), { text: book15DetailHtml(43, '测试书', '乙') });
    expect(await probe(book15, { title: '测试书', author: '' })).toMatchObject({ status: 'ambiguous' });
  });

  it('上游 5xx(重试后仍失败)⇒ unreachable,code=SOURCE_UNAVAILABLE', async () => {
    pages.set(e1.search(), { text: '', status: 500 });
    expect(await probe(E1)).toMatchObject({ status: 'unreachable', code: 'SOURCE_UNAVAILABLE', requests: 2 });
  });
});

describe('probeSourceForBook:超时与编译失败', () => {
  it('连接挂起 ⇒ 两次 3s 连接段超时后本源判 unreachable(约 6s,不必等满预算)', async () => {
    primeEngineHit();
    headerDelay.set(e1.search(), Number.POSITIVE_INFINITY);
    const result = await probe(E1);
    expect(result).toMatchObject({ status: 'unreachable', code: 'SOURCE_UNAVAILABLE', requests: 2, elapsedMs: 6_000 });
  });

  it('响应头即到、正文卡住(8s 总超时 × 重试 = 16s)⇒ 在内部预算 15s 处返回 timeout(不抛)', async () => {
    primeEngineHit();
    stallBody.add(e1.search());
    const result = await probe(E1);
    expect(result).toMatchObject({ status: 'timeout', elapsedMs: service.SOURCE_PROBE_BUDGET_MS, requests: 2 });
  });

  it('响应慢但持续有进展的源在预算内照常交付;超过 budgetMs 即 timeout', async () => {
    primeEngineHit();
    for (const url of [e1.search(), e1.detail, e1.toc]) headerDelay.set(url, 2_000);
    expect(await probe(E1)).toMatchObject({ status: 'ok', elapsedMs: 6_000 });
    const short = await drive(service.probeSourceForBook(E1, book, new AbortController().signal, { budgetMs: 5_000 }));
    expect(short).toMatchObject({ status: 'timeout', elapsedMs: 5_000 });
  });

  it('调用方中止(客户端关面板)⇒ timeout,不再发新请求', async () => {
    primeEngineHit();
    headerDelay.set(e1.search(), 1_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('closed')), 500);
    const result = await probe(E1, book, controller.signal);
    expect(result.status).toBe('timeout');
    expect(requested).toEqual([e1.search()]);
  });

  it('引擎规则缺必需字段 ⇒ compile_failed(RULES_UNSUPPORTED + missingFields),不发任何请求', async () => {
    const broken = { ...E1, rules: { ...engineRules, ruleSearch: { name: '.name@text', bookUrl: 'a@href' } } };
    expect(await probe(broken)).toMatchObject({
      status: 'compile_failed', code: 'RULES_UNSUPPORTED', missingFields: ['ruleSearch.bookList'], requests: 0,
    });
    expect(requested).toEqual([]);
  });

  it('引擎规则字段编译不过(JS 规则)⇒ compile_failed', async () => {
    const js = { ...E1, rules: { ...engineRules, ruleToc: { ...engineRules.ruleToc, chapterList: '@js:result.list' } } };
    expect(await probe(js)).toMatchObject({ status: 'compile_failed', code: 'RULES_UNSUPPORTED', missingFields: ['ruleToc.chapterList'] });
    expect(requested).toEqual([]);
  });

  it('搜索模板展不开(动态规则 / POST 选项)⇒ compile_failed(SEARCH_URL_UNSUPPORTED)', async () => {
    const post = { ...E1, searchUrl: 'https://e1.test/s,{"method":"POST","body":"q={{key}}"}' };
    expect(await probe(post)).toMatchObject({ status: 'compile_failed', code: 'SEARCH_URL_UNSUPPORTED' });
    const dynamic = { ...E1, searchUrl: 'https://e1.test/s?q={{key}}&t={{java.time()}}' };
    expect(await probe(dynamic)).toMatchObject({ status: 'compile_failed', code: 'SEARCH_URL_UNSUPPORTED' });
    expect(requested).toEqual([]);
  });
});

// 41-confirmtoc:生产 kxdu.net 实测 —— 面板 probe 判 ok(1726 章),点「切换到此源」却 404「无法建立目录」。
// 该源 ruleBookInfo 不写 name/author(legado 语义:书名取搜索结果行,详情页只补简介/封面),
// probe 的身份回退到搜索结果,确认路径却硬要详情页书名。probe 判 ok 的候选,确认必须打得开。
describe('probe ok ⇒ 确认路径(index?book_url=&source=)一定建得出目录(41-confirmtoc)', () => {
  const noNameRules = { ...engineRules, ruleBookInfo: { intro: '.intro@text', tocUrl: '.toc@href' } };
  const NoName = { ...E1, name: '无书名规则源', rules: noNameRules };
  const confirm = (source: Parameters<typeof service.probeSourceForBook>[0], bookUrl: string, identity = book) => drive(service.resolveSourceBook(
    identity, new service.SourceRequestContext(new AbortController().signal), { bookUrl, sourceUrl: source.url, sources: [source] },
  ));
  const confirmEvents = () => vi.mocked(console.warn).mock.calls
    .filter(([tag]) => tag === '[read-source] source_confirm_failed')
    .map(([, payload]) => JSON.parse(String(payload)) as Record<string, unknown>);
  const fallbackEvents = () => vi.mocked(console.warn).mock.calls
    .filter(([tag]) => tag === '[read-source] source_confirm_identity_fallback')
    .map(([, payload]) => JSON.parse(String(payload)) as Record<string, unknown>);
  /** 确认路径两类观测的原文：不得出现书名/作者（confirmtocrev §6 M5：把书名塞进事件的变异须被杀）。 */
  const confirmEventText = () => JSON.stringify(vi.mocked(console.warn).mock.calls
    .filter(([tag]) => String(tag).startsWith('[read-source] source_confirm_')));

  it('详情页无书名规则(kxdu.net 形态)⇒ probe ok 且确认成功,书名/作者取请求的书', async () => {
    pages.set(e1.search(), { text: engineListItem('测试书', '作者') });
    pages.set(e1.detail, { text: '<p class="intro">简介</p><a class="toc" href="/toc/1.html">目录</a>' });
    pages.set(e1.toc, { text: '<li class="chapter"><a href="/c/1.html">第一章</a></li><li class="chapter"><a href="/c/2.html">第二章</a></li>' });
    const probed = await probe(NoName);
    expect(probed).toMatchObject({ status: 'ok', book: { title: '测试书', bookUrl: e1.detail, chapters: 2 } });
    const catalog = await confirm(NoName, probed.book!.bookUrl);
    expect(catalog).toMatchObject({ title: '测试书', author: '作者', sourceUrl: NoName.url, bookUrl: e1.detail });
    expect(catalog.chapters).toHaveLength(2);
    expect(confirmEvents()).toEqual([]);
    // 成功但用了回退：一行 host 级事件，字段集合钉死（多一个 title/bookUrl 字段即红）。
    expect(fallbackEvents()).toEqual([{
      event: 'source_confirm_identity_fallback', sourceHost: 'e1.test', tier: 'engine', identityFallback: 'both',
    }]);
    expect(confirmEventText()).not.toContain('测试书');
    expect(confirmEventText()).not.toContain('作者');
    expect(confirmEventText()).not.toContain('/d/1.html');
  });

  it('身份回退观测只在请求真的补上值时标记:详情页齐全 ⇒ 不发;只缺作者 ⇒ author;请求无作者 ⇒ 只 title', async () => {
    primeEngineHit();
    await confirm(E1, e1.detail);
    expect(fallbackEvents()).toEqual([]);
    pages.set(e1.detail, { text: '<h1 class="title">测试书</h1><a class="toc" href="/toc/1.html">目录</a>' });
    await confirm(E1, e1.detail);
    pages.set(e1.detail, { text: '<p class="intro">简介</p><a class="toc" href="/toc/1.html">目录</a>' });
    await confirm(NoName, e1.detail, { title: '测试书', author: '' });
    expect(fallbackEvents().map((event) => event.identityFallback)).toEqual(['author', 'title']);
    expect(confirmEventText()).not.toContain('测试书');
  });

  it('详情页有书名时仍以详情页为准(用户点选的是站上这本书,不改写成请求书名)', async () => {
    primeEngineHit();
    pages.set(e1.detail, { text: '<h1 class="title">测试书(修订版)</h1><a class="toc" href="/toc/1.html">目录</a>' });
    const catalog = await confirm(E1, e1.detail);
    expect(catalog).toMatchObject({ title: '测试书(修订版)', author: '作者' });
  });

  it('目录为空 ⇒ 404 且文案点明「目录为空」;发 source_confirm_failed(host + reason=toc_empty,不带路径)', async () => {
    pages.set(e1.detail, { text: '<h1 class="title">测试书</h1><a class="toc" href="/toc/1.html">目录</a>' });
    pages.set(e1.toc, { text: '<div>空</div>' });
    await expect(confirm(E1, e1.detail)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 404, message: expect.stringContaining('目录为空') });
    expect(confirmEvents()).toEqual([expect.objectContaining({
      event: 'source_confirm_failed', sourceHost: 'e1.test', tier: 'engine', reason: 'toc_empty', requests: 2,
    })]);
    expect(JSON.stringify(confirmEvents())).not.toContain('/d/1.html');
    expect(confirmEventText()).not.toContain('测试书');
    expect(confirmEventText()).not.toContain('作者');
  });

  it('详情页取不出书名、请求也没带书名 ⇒ 404「详情页解析失败」,不再去取目录', async () => {
    pages.set(e1.detail, { text: '<p class="intro">简介</p>' });
    await expect(confirm(NoName, e1.detail, { title: '', author: '' }))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', message: expect.stringContaining('详情页') });
    expect(requested).toEqual([e1.detail]);
    expect(confirmEvents()).toEqual([expect.objectContaining({ reason: 'detail_unparsed', requests: 1 })]);
  });

  it('上游 5xx ⇒ 503 SOURCE_UNAVAILABLE(可重试,改前原样抛出被 route 落成 500 SOURCE_INTERNAL),观测 reason 记细分码', async () => {
    pages.set(e1.detail, { text: '', status: 500 });
    await expect(confirm(E1, e1.detail)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 503 });
    expect(confirmEvents()).toEqual([expect.objectContaining({ sourceHost: 'e1.test', tier: 'engine', reason: 'SOURCE_HTTP_5XX' })]);
  });

  it('书页 4xx ⇒ 404「书页已无法打开」;连接挂起(单请求超时)⇒ 504 SOURCE_TIMEOUT', async () => {
    pages.set(e1.detail, { text: '', status: 404 });
    await expect(confirm(E1, e1.detail)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', message: expect.stringContaining('无法打开') });
    pages.set(e1.detail, { text: '' });
    headerDelay.set(e1.detail, Number.POSITIVE_INFINITY);
    await expect(confirm(E1, e1.detail)).rejects.toMatchObject({ code: 'SOURCE_TIMEOUT', status: 504 });
    expect(confirmEvents().map((event) => event.reason)).toEqual(['SOURCE_HTTP_4XX', 'SOURCE_REQUEST_TIMEOUT']);
  });

  it('builtin book15 确认失败:文案与错误码逐字不变(零回归),只多一条观测', async () => {
    pages.set(book15Detail(), { text: '<meta property="og:novel:book_name" content="测试书">' });
    await expect(confirm(book15, book15Detail())).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND', status: 404, message: '用户选择的书源无法建立目录，请重试或换一个候选。',
    });
    expect(confirmEvents()).toEqual([expect.objectContaining({ sourceHost: 'book15.net', tier: 'builtin', reason: 'toc_empty' })]);
  });

  it('builtin book15 上游 5xx:仍原样抛出(不套引擎源的归类),只多一条观测', async () => {
    pages.set(book15Detail(), { text: '', status: 500 });
    pages.set(book15Detail().replace('book15.net', 'www.book15.net'), { text: '', status: 500 });
    const error = await confirm(book15, book15Detail()).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(service.SourceReaderError);
    expect(confirmEvents()).toEqual([expect.objectContaining({ tier: 'builtin', reason: 'SOURCE_HTTP_5XX' })]);
  });
});

describe('probeSourceForBook:进程级同站节流(41-fanfix N1)', () => {
  // 浏览器扇出 = N 个独立 HTTP 请求各自一棵 context 树。节流表若是请求级的,同站 probe 会同一时刻打到源站。
  const E1b = { ...E1, url: 'https://e1.test/alt/', name: '引擎源1(同站另一行)' };
  const E2 = { ...E1, url: 'https://e2.test/', name: '引擎源2', searchUrl: 'https://e2.test/s?q={{key}}' };
  const firstStamp = (host: string, skip = 0) => stamps.filter((item) => new URL(item.url).hostname === host)[skip].at;

  it('两个并发 probe 打同一站 ⇒ 第二个的首个请求排到 350ms 槽之后;异站 probe 不排队', async () => {
    (await import('./source-policy')).refreshSupportedHosts(['e1.test', 'e2.test']);
    pages.set(e1.search(), { text: '<div>没有结果</div>' });
    pages.set('https://e2.test/s?q=' + q(book.title), { text: '<div>没有结果</div>' });
    const t0 = Date.now();
    const results = await drive(Promise.all([
      service.probeSourceForBook(E1, book, new AbortController().signal),
      service.probeSourceForBook(E1b, book, new AbortController().signal),
      service.probeSourceForBook(E2, book, new AbortController().signal),
    ]));
    expect(results.map((item) => item.status)).toEqual(['no_candidates', 'no_candidates', 'no_candidates']);
    expect(firstStamp('e1.test') - t0).toBe(0);
    expect(firstStamp('e1.test', 1) - firstStamp('e1.test')).toBeGreaterThanOrEqual(350);
    expect(firstStamp('e2.test') - t0).toBe(0);
  });

  it('阅读路径(非 probe)的独立 context 仍是请求级节流表,关开关时行为不变', async () => {
    pages.set(e1.search(), { text: '' });
    const t0 = Date.now();
    await drive(Promise.all([
      new service.SourceRequestContext(new AbortController().signal).page(e1.search()),
      new service.SourceRequestContext(new AbortController().signal).page(e1.search()),
    ]));
    expect(stamps.map((item) => item.at - t0)).toEqual([0, 0]);
  });

  it('SOURCE_THROTTLE_PER_HOST=0 ⇒ probe 也退回请求级单槽(不跨请求共享)', async () => {
    vi.stubEnv('SOURCE_THROTTLE_PER_HOST', '0');
    pages.set(e1.search(), { text: '<div>没有结果</div>' });
    const t0 = Date.now();
    await drive(Promise.all([
      service.probeSourceForBook(E1, book, new AbortController().signal),
      service.probeSourceForBook(E1b, book, new AbortController().signal),
    ]));
    expect(stamps.map((item) => item.at - t0)).toEqual([0, 0]);
  });
});

describe('GET /api/read/source-probe', () => {
  let GET: typeof import('@/app/api/read/source-probe/route').GET;
  const fanout = [
    { ...book15, readable: true },
    { ...E1, readable: false },
  ];
  const call = (query: string, token: string | null = 'probe-owner') =>
    drive(GET(new NextRequest('http://localhost/api/read/source-probe' + (query ? '?' + query : ''), {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    })));

  beforeEach(async () => {
    vi.stubEnv('APP_OWNER_TOKEN', 'probe-owner');
    vi.stubEnv('SOURCE_FANOUT_ENABLED', '1');
    // 限流键 HMAC 用的测试假值(≥32 字节),与任何真实配置无关。
    vi.stubEnv('AUTH_SECURITY_SECRET', 'test-only-source-probe-secret-0123456789');
    mocks.pool.mockResolvedValue(fanout);
    mocks.ensureSchema.mockResolvedValue(undefined);
    ({ GET } = await import('@/app/api/read/source-probe/route'));
  });

  it('开关默认关 ⇒ 鉴权通过后 404 SOURCE_FANOUT_DISABLED,不碰候选池', async () => {
    vi.stubEnv('SOURCE_FANOUT_ENABLED', '');
    const res = await call('');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'SOURCE_FANOUT_DISABLED' });
    expect(mocks.pool).not.toHaveBeenCalled();
  });

  it('未鉴权 ⇒ 401(先鉴权后判开关)', async () => {
    expect((await call('', null)).status).toBe(401);
  });

  it('无 source 参数 ⇒ 候选列表(url/name/tier/readable/hostKey)与上限', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      limit: 24,
      sources: [
        { url: book15.url, name: book15.name, tier: 'builtin', readable: true, hostKey: 'book15.net' },
        { url: E1.url, name: E1.name, tier: 'M1', readable: false, hostKey: 'e1.test' },
      ],
    });
  });

  it('候选 hostKey 与服务端节流同一站键:book15 apex/www 同键;节流回滚开关(=0)不把它变成全局 *', async () => {
    mocks.pool.mockResolvedValue([
      { ...book15, readable: true },
      { ...book15, url: 'https://www.book15.net/', name: 'book15 www', readable: true },
      { ...E1, readable: true },
    ]);
    vi.stubEnv('SOURCE_THROTTLE_PER_HOST', '0');
    const { sources } = await (await call('')).json() as { sources: { url: string; hostKey: string }[] };
    expect(sources.map((item) => item.hostKey)).toEqual(['book15.net', 'book15.net', 'e1.test']);
  });

  it('单源 probe:readable=false 的引擎源命中 ⇒ 200 + status unreadable(found=ok,book 保留供展示);一次只打这一个源', async () => {
    primeEngineHit();
    const res = await call(`title=${q('测试书')}&author=${q('作者')}&source=${q(E1.url)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'unreadable', found: 'ok', sourceUrl: E1.url, readable: false, book: { bookUrl: e1.detail },
    });
    expect(requested).toEqual([e1.search(), e1.detail, e1.toc]);
  });

  it('readable=true 的源命中 ⇒ status ok(无 found);readable=false 的 similar ⇒ unreadable(found=similar);未命中不改写', async () => {
    mocks.pool.mockResolvedValue([{ ...book15, readable: true }, { ...E1, readable: true }]);
    primeEngineHit();
    const ok = await (await call(`title=${q('测试书')}&author=${q('作者')}&source=${q(E1.url)}`)).json();
    expect(ok).toMatchObject({ status: 'ok', readable: true });
    expect(ok).not.toHaveProperty('found');

    mocks.pool.mockResolvedValue([{ ...book15, readable: false }]);
    pages.set(book15Search(), { text: '<a href="/books/details43.html">测试书</a>' });
    pages.set(book15Detail(43), { text: book15DetailHtml(43, '测试书(精品版)') });
    pages.set(book15Search('作者'), { text: '' });
    const similar = await (await call(`title=${q('测试书')}&author=${q('作者')}&source=${q(book15.url)}`)).json();
    expect(similar).toMatchObject({ status: 'unreadable', found: 'similar', readable: false, candidates: [{ bookUrl: book15Detail(43) }] });

    pages.set(e1.search(), { text: '<div>没有结果</div>' });
    mocks.pool.mockResolvedValue([{ ...E1, readable: false }]);
    expect(await (await call(`title=${q('测试书')}&source=${q(E1.url)}`)).json()).toMatchObject({ status: 'no_candidates', readable: false });
  });

  it('source 不在扇出候选里 ⇒ 404 SOURCE_PROBE_UNKNOWN_SOURCE,不发上游请求', async () => {
    const res = await call(`title=${q('测试书')}&source=${q('https://evil.test/')}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'SOURCE_PROBE_UNKNOWN_SOURCE' });
    expect(requested).toEqual([]);
  });

  it('缺书名 / 空 source ⇒ 400', async () => {
    expect((await call(`source=${q(E1.url)}`)).status).toBe(400);
    expect((await call(`title=${q('测试书')}&source=`)).status).toBe(400);
  });

  it('候选池合成失败 ⇒ 500 SOURCE_INTERNAL', async () => {
    mocks.pool.mockRejectedValue(new Error('db down'));
    const res = await call(`title=${q('测试书')}&source=${q(E1.url)}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'SOURCE_INTERNAL' });
  });

  describe('用户级限流(41-fanfix N7)', () => {
    const probeQuery = `title=${q('测试书')}&author=${q('作者')}&source=${q(E1.url)}`;

    it('默认阈值:一次默认上限(24 个)的扫描全部放行,不误拒正常扇出', async () => {
      pages.set(e1.search(), { text: '<div>没有结果</div>' });
      const statuses: number[] = [];
      for (let i = 0; i < 24; i++) statuses.push((await call(probeQuery)).status);
      expect(statuses.every((status) => status === 200)).toBe(true);
    });

    it('超限 ⇒ 429 SOURCE_PROBE_RATE_LIMITED + Retry-After,不合成候选池、不出网;候选列表不计数', async () => {
      vi.stubEnv('SOURCE_PROBE_RATE_LIMITS', '2/600');
      pages.set(e1.search(), { text: '<div>没有结果</div>' });
      for (let i = 0; i < 3; i++) expect((await call('')).status).toBe(200);
      expect((await call(probeQuery)).status).toBe(200);
      expect((await call(probeQuery)).status).toBe(200);
      mocks.pool.mockClear();
      const before = requested.length;
      const res = await call(probeQuery);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('321');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await res.json()).toMatchObject({ code: 'SOURCE_PROBE_RATE_LIMITED', retryAfterSeconds: 321 });
      expect(mocks.pool).not.toHaveBeenCalled();
      expect(requested).toHaveLength(before);
    });

    it('多窗口:任一窗口超限即拒;SOURCE_PROBE_RATE_LIMITS=0 关闭限流且不写计数', async () => {
      vi.stubEnv('SOURCE_PROBE_RATE_LIMITS', '5/600,1/86400');
      pages.set(e1.search(), { text: '<div>没有结果</div>' });
      expect((await call(probeQuery)).status).toBe(200);
      expect((await call(probeQuery)).status).toBe(429);
      vi.stubEnv('SOURCE_PROBE_RATE_LIMITS', '0');
      rateCounts.clear();
      expect((await call(probeQuery)).status).toBe(200);
      expect(rateCounts.size).toBe(0);
    });

    it('缺 AUTH_SECURITY_SECRET(无法算限流键)⇒ 503 SOURCE_PROBE_RATE_LIMIT_UNAVAILABLE,不出网', async () => {
      vi.stubEnv('AUTH_SECURITY_SECRET', '');
      const res = await call(probeQuery);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'SOURCE_PROBE_RATE_LIMIT_UNAVAILABLE' });
      expect(requested).toEqual([]);
    });
  });
});

describe('source-probe-rate-limit 配置与主体', () => {
  it('阈值解析:默认两窗;非法配置整体回退默认;0 关闭', async () => {
    const { sourceProbeRateLimits } = await import('./source-probe-rate-limit');
    const defaults = [
      { scope: 'source-probe-600', limit: 180, windowSeconds: 600 },
      { scope: 'source-probe-86400', limit: 720, windowSeconds: 86400 },
    ];
    expect(sourceProbeRateLimits({})).toEqual(defaults);
    // 41-readall：扇出开到上限 60 时，一个用户 10 分钟内整面板扫三次不被自己限流。
    const { MAX_SOURCE_FANOUT_LIMIT } = await import('./shuyuan');
    for (const window of sourceProbeRateLimits({})) expect(window.limit).toBeGreaterThanOrEqual(3 * MAX_SOURCE_FANOUT_LIMIT);
    for (const bad of ['abc', '12/0', '0/600', '12/600,x', '12/999999999']) expect(sourceProbeRateLimits({ SOURCE_PROBE_RATE_LIMITS: bad })).toEqual(defaults);
    expect(sourceProbeRateLimits({ SOURCE_PROBE_RATE_LIMITS: ' 30/60 ' })).toEqual([{ scope: 'source-probe-60', limit: 30, windowSeconds: 60 }]);
    expect(sourceProbeRateLimits({ SOURCE_PROBE_RATE_LIMITS: '0' })).toEqual([]);
  });

  it('主体:有用户按用户 id;无用户按平台追加的最后一跳来源 IP', async () => {
    const { sourceProbeRateLimitSubject } = await import('./source-probe-rate-limit');
    const req = new NextRequest('http://localhost/api/read/source-probe', { headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' } });
    const principal = { userId: 7, role: 'member' as const, canFind: false, canRead: true, canDownload: false, authMethod: 'session' as const };
    expect(sourceProbeRateLimitSubject(req, principal)).toBe('user:7');
    expect(sourceProbeRateLimitSubject(req, undefined)).toBe('ip:203.0.113.9');
  });
});
