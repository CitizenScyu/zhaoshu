import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceCatalog } from './source-reader';

// 41-M1.3 主机级健康记忆的端到端用例(建目录 + 章节级换源)。独立成文件：与 source-reader.test.ts 的
// 换源用例(M1.2 在改)互不重叠。夹具沿用 source-reader.test.ts 的写法：DB / 源池 mock,fetch 按 URL 取夹具。
// 一律假时钟(setTimeout/clearTimeout/Date):连接超时、换 host 退避、节流槽都按虚拟时间触发，断言里的毫秒数
// 就是实现的时间线。book15 的「宕机」有两种形态：522 响应(连接即回)与连接挂起(3s 连接段超时，生产实测形态)。

type Query = { text: string; values: unknown[] };
const mocks = vi.hoisted(() => ({ getSql: vi.fn(), sources: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('./db', () => ({ getSql: mocks.getSql, ensureSchema: vi.fn() }));
vi.mock('./shuyuan', () => ({ getReadingSources: mocks.sources }));

let service: typeof import('./source-reader');
const book = { title: '测试书', author: '作者' };
const q = (keyword: string) => encodeURIComponent(keyword);
const detail = (id = 42) =>
  `<meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者">`
  + `<dd><a href="/chapter/index${id}-1.html">第一章</a></dd><dd><a href="/chapter/index${id}-2.html">第二章</a></dd>`;
const chapterHtml = (text: string) => `<li class="chapter-content"><p>${text}</p></li>`;

// 池序与生产相同：builtin(book15)恒在前，其后是引擎源。
const book15 = {
  url: 'https://book15.net/', name: 'book15.net', searchUrl: 'https://book15.net/books/search.html?kw={{key}}',
  rules: {}, tier: 'builtin' as const,
};
const book15Search = (keyword = book.title) => 'https://book15.net/books/search.html?kw=' + q(keyword);
const book15Hint = 'https://book15.net/books/details42.html';
// 当前源(目录所在的源):独立 host,走 builtin 解析器。
const cur = { url: 'https://cur.test/', name: '当前书源', searchUrl: '/books/search.html?kw={{key}}', rules: {} };
const curSearch = 'https://cur.test/books/search.html?kw=' + q(book.title);
const curDetail = 'https://cur.test/books/details42.html';
const curChapter = 'https://cur.test/chapter/index42-1.html';
const engineRules = {
  ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.content@text' },
};
const engine = (n: number) => ({
  url: `https://e${n}.test/`, name: `引擎源${n}`, searchUrl: `https://e${n}.test/s?q={{key}}`, tier: 'M1' as const, rules: engineRules,
});
const E1 = engine(1);
const E2 = engine(2);
const engineUrls = (n: number) => ({
  search: `https://e${n}.test/s?q=` + q(book.title),
  detail: `https://e${n}.test/d/1.html`,
  toc: `https://e${n}.test/toc/1.html`,
  content: `https://e${n}.test/c/1.html`,
});

const pages = new Map<string, { text?: string; status?: number }>();
const catalogs = new Map<string, SourceCatalog>();
/** 响应头延迟(虚拟毫秒);Infinity = 连接挂起，直到请求被中止(3s 连接段超时)。 */
const headerDelay = new Map<string, number>();
let hints: unknown[];
let requested: Array<{ url: string; at: number }>;
const context = () => new service.SourceRequestContext(new AbortController().signal);
const requestedUrls = () => requested.map(({ url }) => url);

/** 引擎源 n 有这本书：搜索 → 详情 → 目录(第一章)→ 正文。 */
const primeEngine = (n: number) => {
  const urls = engineUrls(n);
  pages.set(urls.search, { text: `<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/d/1.html">x</a></div>` });
  pages.set(urls.detail, { text: '<h1 class="title">测试书</h1><span class="writer">作者</span><a class="toc" href="/toc/1.html">目录</a>' });
  pages.set(urls.toc, { text: '<li class="chapter"><a href="/c/1.html">第一章</a></li>' });
  pages.set(urls.content, { text: `<div class="content">引擎源${n}正文</div>` });
};
/** 引擎源 n 没有这本书：搜索结果为空(SOURCE_NOT_FOUND,一次请求)。 */
const primeEngineMiss = (n: number) => pages.set(engineUrls(n).search, { text: '' });
/** 当前源有这本书：搜索 + 详情。 */
const primeCur = () => {
  pages.set(curSearch, { text: '<a href="/books/details42.html">测试书</a>' });
  pages.set(curDetail, { text: detail() });
};
/** book15 连接挂起：apex 与 www 两个 host 都卡在连接段(生产 522 期间的实测形态)。 */
const hangBook15 = (url: string) => {
  headerDelay.set(url, Number.POSITIVE_INFINITY);
  headerDelay.set(url.replace('://book15.net/', '://www.book15.net/'), Number.POSITIVE_INFINITY);
};

/** 假时钟下一直推进到定时器排空，再交出结果(拒绝原样抛出);finishedAt 是结果落定那一刻的虚拟时间。 */
const drive = async <T>(work: Promise<T>): Promise<{ value: T; finishedAt: number }> => {
  const settled = work.then((value) => ({ value, finishedAt: Date.now() }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result;
};
const build = (ctx = context()) => drive(service.resolveSourceBook(book, ctx));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  hints = [];
  requested = [];
  pages.clear();
  catalogs.clear();
  headerDelay.clear();
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?').replace(/\s+/g, ' ').trim(), values });
  const transaction = vi.fn(async (queries: Query[]) => queries.map((query) => {
    if (query.text.includes('FROM labeled_books')) return hints;
    if (query.text.startsWith('INSERT INTO source_read_catalogs')) {
      catalogs.set(query.values[0] as string, JSON.parse(query.values[1] as string));
      return [];
    }
    if (query.text.startsWith('DELETE')) return [];
    if (query.text.includes('FROM source_read_catalogs')) {
      const payload = catalogs.get(query.values[0] as string);
      return payload ? [{ payload }] : [];
    }
    throw new Error('Unexpected SQL ' + query.text);
  }));
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction }));
  mocks.fetch.mockImplementation(async (input, init) => {
    const url = String(input);
    requested.push({ url, at: Date.now() });
    const signal = init?.signal ?? undefined;
    const wait = headerDelay.get(url);
    if (wait !== undefined) {
      // 与 undici 一致：请求被中止时以 signal.reason 拒绝(连接段超时 / 切片 / 父中止都走这里)。
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = Number.isFinite(wait)
          ? setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, wait)
          : undefined;
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    const fixture = pages.get(url);
    if (!fixture) throw new Error('Unexpected source request ' + url);
    return new Response(fixture.text ?? '', { status: fixture.status ?? 200 });
  });
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  service = await import('./source-reader');
  (await import('./source-policy')).refreshSupportedHosts(['cur.test', 'e1.test', 'e2.test']);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('41-M1.3 建目录:宕机的 book15 降到队尾', () => {
  it('①a book15 连续 2 次 522 ⇒ 下一次建目录先试引擎源,book15 一次都不再请求', async () => {
    mocks.sources.mockResolvedValue([book15, E1]);
    pages.set(book15Search(), { text: '', status: 522 }); // 5xx 会被 page() 重试一次 ⇒ 恰好连续 2 次 522
    primeEngine(1);
    const first = await build();
    expect(first.value.sourceUrl).toBe(E1.url);
    expect(requestedUrls()).toEqual([book15Search(), book15Search(), engineUrls(1).search, engineUrls(1).detail, engineUrls(1).toc]);
    requested = [];
    const second = await build();
    expect(second.value.sourceUrl).toBe(E1.url);
    expect(requestedUrls()).toEqual([engineUrls(1).search, engineUrls(1).detail, engineUrls(1).toc]);
  });

  it('①b 生产形态(连接挂起,hint + 搜索):首次建目录 26.9s,之后只剩引擎链本身的 1.5s', async () => {
    mocks.sources.mockResolvedValue([book15, E1]);
    hints = [{ title: '测试书', author: '作者', source_url: book15Hint }];
    hangBook15(book15Hint);
    hangBook15(book15Search());
    primeEngine(1);
    const urls = engineUrls(1);
    for (const url of [urls.search, urls.detail, urls.toc]) headerDelay.set(url, 500);
    // 首次(记忆为空):book15 的 hint 与搜索各一次 page() = 2 次尝试 ×(3s 连接超时 + 0.35s 换 host + 3s)= 12.7s,
    // 两次共 25.4s;引擎链 3 × 0.5s 接在后面 ⇒ 26.9s(生产 503 簇 26.89–27.03s 的同一条时间线)。
    const t0 = Date.now();
    const first = await build();
    expect(first.value.sourceUrl).toBe(E1.url);
    expect(first.finishedAt - t0).toBe(26_900);
    requested = [];
    const t1 = Date.now();
    const second = await build();
    expect(second.value.sourceUrl).toBe(E1.url);
    expect(second.finishedAt - t1).toBe(1_500); // 只剩引擎链：搜索 + 详情 + 目录各 0.5s
    expect(requestedUrls().some((url) => url.includes('book15.net'))).toBe(false);
  });

  it('①c 只降序不剔除：引擎源没有这本书时仍会试到 book15;book15 恢复后一次成功即回到队首', async () => {
    mocks.sources.mockResolvedValue([book15, E1]);
    pages.set(book15Search(), { text: '', status: 522 });
    primeEngine(1);
    await build(); // book15 连续 2 次 522 ⇒ suspect
    // book15 恢复、引擎源下架了这本书：suspect 的 book15 排在队尾，但照样被试到并交付。
    pages.set(book15Search(), { text: '<a href="/books/details42.html">测试书</a>' });
    pages.set(book15Hint, { text: detail() });
    primeEngineMiss(1);
    requested = [];
    expect((await build()).value.sourceUrl).toBe(book15.url);
    expect(requestedUrls()).toEqual([engineUrls(1).search, book15Search(), book15Hint]);
    // 成功一次即清零：下一次 book15 回到队首。
    requested = [];
    expect((await build()).value.sourceUrl).toBe(book15.url);
    expect(requestedUrls()).toEqual([book15Search(), book15Hint]);
  });
});

describe('41-M1.3 章节级换源:宕机的 book15 不再是第一个候选', () => {
  const pool = [book15, cur, E1, E2];
  /** 在池 pool 上建目录：book15 宕机(连续 2 次 522)⇒ 当前源交付;返回目录并落 catalogs。 */
  const prepareWithDeadBook15 = async () => {
    mocks.sources.mockResolvedValue(pool);
    pages.set(book15Search(), { text: '', status: 522 });
    primeCur();
    const { value: catalog } = await build();
    expect(catalog.sourceUrl).toBe(cur.url);
    catalogs.set(catalog.version, catalog);
    return catalog;
  };
  const readChapter = (catalog: SourceCatalog) => drive(service.readSourceChapter(catalog.version, 0, context()));

  it('②a 原源失败、池序 [book15(suspect), E1, E2] ⇒ 第一个候选是 E1,book15 不被请求', async () => {
    const catalog = await prepareWithDeadBook15();
    pages.set(curChapter, { text: '', status: 404 });
    primeEngine(1);
    primeEngine(2);
    requested = [];
    const { value: part } = await readChapter(catalog);
    expect(part).toMatchObject({ text: '引擎源1正文', servedFrom: E1.name });
    const e1 = engineUrls(1);
    expect(requestedUrls()).toEqual([curChapter, e1.search, e1.detail, e1.toc, e1.content]);
  });

  it('②b 候选顺序是 E1 → E2 → book15:两个引擎源都没有这本书时 book15 排在最后仍被试到', async () => {
    const catalog = await prepareWithDeadBook15();
    pages.set(curChapter, { text: '', status: 404 });
    primeEngineMiss(1);
    primeEngineMiss(2);
    // book15 已恢复且有这本书(不同于当前源的条目)。
    pages.set(book15Search(), { text: '<a href="/books/details42.html">测试书</a>' });
    pages.set(book15Hint, { text: detail() });
    pages.set('https://book15.net/chapter/index42-1.html', { text: chapterHtml('book15 正文') });
    requested = [];
    const { value: part } = await readChapter(catalog);
    expect(part).toMatchObject({ text: 'book15 正文', servedFrom: book15.name });
    expect(requestedUrls()).toEqual([
      curChapter, engineUrls(1).search, engineUrls(2).search,
      book15Search(), book15Hint, 'https://book15.net/chapter/index42-1.html',
    ]);
  });
});

describe('41-M1.3 零行为变化：记忆为空时请求序列与基点 4e1688b 逐项相同', () => {
  // 对照场景：池 [book15, cur, E1, E2],book15 健康但没有这本书(标题/作者搜索都是空页 ⇒ SOURCE_NOT_FOUND,
  // 这对 host 是「成功」,不计数)。建目录由当前源交付；当前源本章 404 ⇒ 换源队列 [book15, E1, E2]。
  // 基点上跑出的序列就是下面这张表(本文件在未改动的 4e1688b 上跑过，这一条为绿)。
  const baseline = [
    // 建目录
    book15Search(), book15Search(book.author), curSearch, curDetail,
    // 读第 0 章：当前源 404 ⇒ 换源，book15 仍是第一个候选(确认无此书，不占名额)⇒ E1 交付
    curChapter, book15Search(), book15Search(book.author),
    engineUrls(1).search, engineUrls(1).detail, engineUrls(1).toc, engineUrls(1).content,
  ];
  const arrange = () => {
    mocks.sources.mockResolvedValue([book15, cur, E1, E2]);
    pages.set(book15Search(), { text: '' });
    pages.set(book15Search(book.author), { text: '' });
    primeCur();
    pages.set(curChapter, { text: '', status: 404 });
    primeEngine(1);
    primeEngine(2);
  };
  const run = async () => {
    const { value: catalog } = await build();
    catalogs.set(catalog.version, catalog);
    const { value: part } = await drive(service.readSourceChapter(catalog.version, 0, context()));
    return { catalog, part };
  };

  it('③a 冷启动(记忆为空)⇒ 建目录 + 换源的请求序列与基点逐项相等', async () => {
    arrange();
    const { catalog, part } = await run();
    expect(catalog.sourceUrl).toBe(cur.url);
    expect(part).toMatchObject({ text: '引擎源1正文', servedFrom: E1.name });
    expect(requestedUrls()).toEqual(baseline);
  });

  it('③b 记忆非空但池内无 suspect(book15 仅 1 次硬失败、池外 host 已 suspect)⇒ 序列仍与基点逐项相等', async () => {
    arrange();
    const health = await import('./source-host-health');
    health.recordHostFailure('book15.net', 'http_5xx'); // 未达阈值
    health.recordHostFailure('gone.test', 'timeout');
    health.recordHostFailure('gone.test', 'timeout'); // 池外 host:suspect,但不在池里
    expect(health.isHostSuspect('gone.test')).toBe(true);
    const { part } = await run();
    expect(part).toMatchObject({ text: '引擎源1正文', servedFrom: E1.name });
    expect(requestedUrls()).toEqual(baseline);
  });
});

describe('41-M1.3 只有传输层硬失败才计数(⑤ 端到端)', () => {
  it('⑤ book15 连续 404 / 搜不到书(SOURCE_NOT_FOUND)都不降序：下一次建目录 book15 仍在队首', async () => {
    mocks.sources.mockResolvedValue([book15, E1]);
    primeEngine(1);
    // 两轮 404:4xx 是源站对这个 URL 的判定，不是 host 挂了。紧接着就验(中间不能夹成功请求，
    // 否则成功清零会把「404 被误计数」掩盖掉)。
    pages.set(book15Search(), { text: '', status: 404 });
    await build();
    await build();
    requested = [];
    await build();
    expect(requestedUrls()[0]).toBe(book15Search());
    // 两轮 SOURCE_NOT_FOUND:搜索页 200 空结果，对 host 是成功。
    pages.set(book15Search(), { text: '' });
    pages.set(book15Search(book.author), { text: '' });
    await build();
    await build();
    requested = [];
    await build();
    expect(requestedUrls()[0]).toBe(book15Search());
    // 正向对照：同样两轮换成 5xx,book15 就被降到队尾。
    pages.set(book15Search(), { text: '', status: 503 });
    await build();
    requested = [];
    await build();
    expect(requestedUrls()[0]).toBe(engineUrls(1).search);
  });
});
