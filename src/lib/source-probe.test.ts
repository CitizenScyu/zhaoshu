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
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?').replace(/\s+/g, ' ').trim(), values });
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

  it('无 source 参数 ⇒ 候选列表(url/name/tier/readable)与上限', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      limit: 24,
      sources: [
        { url: book15.url, name: book15.name, tier: 'builtin', readable: true },
        { url: E1.url, name: E1.name, tier: 'M1', readable: false },
      ],
    });
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
});
