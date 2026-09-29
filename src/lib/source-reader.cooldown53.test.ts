import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sources: vi.fn(), getSql: vi.fn() }));
vi.mock('./db', () => ({ getSql: mocks.getSql }));
vi.mock('./shuyuan', () => ({ getReadingSources: mocks.sources, getSourcePools: async () => ({ traversal: [], selectable: [] }) }));

let service: typeof import('./source-reader');
const epoch = Date.parse('2026-09-29T00:00:00Z');
const host = 'https://cooldown.test';
const other = 'https://other.test';
type Fixture = { text?: string; status?: number; headers?: Record<string, string>; delay?: number; networkFailure?: boolean };
const pages = new Map<string, Fixture>();
let requests: Array<{ url: string; at: number }>;
const root = (limit?: number) => new service.SourceRequestContext(new AbortController().signal, limit);
const settle = <T>(work: Promise<T>) => work.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(epoch);
  requests = [];
  pages.clear();
  const sql = (parts: TemplateStringsArray) => ({ text: parts.join('?') });
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction: async (queries: Array<{ text: string }>) => queries.map(query => {
    if (query.text.includes('FROM labeled_books')) return [];
    throw new Error('Unexpected synthetic SQL');
  }) }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), fixture = pages.get(url);
    requests.push({ url, at: Date.now() - epoch });
    if (!fixture) throw new Error('Unexpected synthetic request ' + url);
    if (fixture.delay) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(init?.signal?.reason); };
      const timer = setTimeout(() => { init?.signal?.removeEventListener('abort', abort); resolve(); }, fixture.delay);
      init?.signal?.addEventListener('abort', abort, { once: true });
    });
    if (fixture.networkFailure) throw new TypeError('fetch failed');
    return new Response(fixture.text ?? '', { status: fixture.status ?? 200, headers: fixture.headers });
  });
  service = await import('./source-reader');
  (await import('./source-policy')).refreshSupportedHosts(['cooldown.test', 'other.test']);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('53 请求树共享冷却', () => {
  it.each([429, 503])('%s 窗口跨父子共享，异站可用，前1ms仍拒绝、到点恢复', async (status) => {
    const ctx = root();
    pages.set(host + '/limited', { status, headers: { 'retry-after': '60' } });
    pages.set(host + '/good', { text: 'ok' });
    pages.set(other + '/good', { text: 'other' });
    await expect(ctx.child(host).page(host + '/limited')).rejects.toMatchObject({ status });
    await expect(ctx.page(host + '/good')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    await expect(ctx.child(host).page(host + '/good')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    expect(ctx.requests).toBe(1);
    expect((await import('./source-host-health')).isHostSuspect('cooldown.test')).toBe(false);
    await expect(ctx.page(other + '/good')).resolves.toMatchObject({ text: 'other' });
    vi.setSystemTime(epoch + 59_999);
    await expect(ctx.page(host + '/good')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    vi.setSystemTime(epoch + 60_000);
    await expect(ctx.page(host + '/good')).resolves.toMatchObject({ text: 'ok' });
    expect(requests).toEqual([
      { url: host + '/limited', at: 0 }, { url: other + '/good', at: 0 }, { url: host + '/good', at: 60_000 },
    ]);
    expect(ctx.requests).toBe(3);
    // 新的根请求没有共享本树的冷却；不扩大为进程/跨请求全局限流。
    await expect(root().page(host + '/good')).resolves.toMatchObject({ text: 'ok' });
  });

  it.each([429, 503])('%s 响应前已占350ms槽的兄弟请求，醒来后仍被拦截', async (status) => {
    const ctx = root();
    pages.set(host + '/limited', { status, headers: { 'retry-after': '60' }, delay: 40 });
    pages.set(host + '/queued', { text: '不应发射' });
    const first = settle(ctx.child(host).page(host + '/limited'));
    const queued = settle(ctx.child(host).page(host + '/queued'));
    await vi.advanceTimersByTimeAsync(400);
    expect((await first).error).toMatchObject({ status });
    expect((await queued).error).toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    expect(requests).toEqual([{ url: host + '/limited', at: 0 }]);
    expect(ctx.requests).toBe(2); // 窗口出现前已预占的点数保留，不能当第二次物理请求。
    expect((await import('./source-host-health')).isHostSuspect('cooldown.test')).toBe(false);
  });

  it('超Node计时器上限的窗口保留完整期限，不生成冷却计时器', async () => {
    const ctx = root(), delayMs = 4_294_968_000;
    pages.set(host + '/limited', { status: 503, headers: { 'retry-after': '4294968' } });
    pages.set(host + '/good', { text: 'ok' });
    await expect(ctx.page(host + '/limited')).rejects.toMatchObject({ status: 503 });
    expect(vi.getTimerCount()).toBe(0);
    for (const at of [2_147_484_000, delayMs - 1]) {
      vi.setSystemTime(epoch + at);
      await expect(ctx.page(host + '/good')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    }
    vi.setSystemTime(epoch + delayMs);
    await expect(ctx.page(host + '/good')).resolves.toMatchObject({ text: 'ok' });
    expect(requests.map(call => call.at)).toEqual([0, delayMs]);
  });

  it('取消优先于冷却，预算耗尽不多发，child拒绝不取消root', async () => {
    const controller = new AbortController();
    const ctx = new service.SourceRequestContext(controller.signal, 1);
    pages.set(host + '/limited', { status: 503, headers: { 'retry-after': '60' } });
    pages.set(other + '/good', { text: 'ok' });
    await expect(ctx.page(host + '/limited')).rejects.toMatchObject({ status: 503 });
    await expect(ctx.child(host).page(host + '/limited')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    expect(ctx.signal.aborted).toBe(false);
    await expect(ctx.page(other + '/good')).rejects.toMatchObject({ code: 'SOURCE_BUDGET_EXCEEDED' });
    controller.abort(new Error('synthetic parent cancelled'));
    await expect(ctx.page(host + '/limited')).rejects.toThrow('synthetic parent cancelled');
    expect(requests).toHaveLength(1);
  });

  it('同站别名共享窗口，节流全局回滚也不把冷却扩大到异站', async () => {
    vi.stubEnv('SOURCE_THROTTLE_PER_HOST', '0');
    const ctx = root();
    pages.set('https://book15.net/limited', { status: 503, headers: { 'retry-after': '60' } });
    pages.set(other + '/good', { text: 'other' });
    await expect(ctx.page('https://book15.net/limited')).rejects.toMatchObject({ status: 503 });
    await expect(ctx.page('https://www.book15.net/good')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    const allowed = settle(ctx.page(other + '/good'));
    await vi.advanceTimersByTimeAsync(350);
    expect((await allowed).value).toMatchObject({ text: 'other' });
    expect(requests.map(call => call.url)).toEqual(['https://book15.net/limited', other + '/good']);
  });

  it('重定向后的503按实际响应站记窗，不误封起始站', async () => {
    const ctx = root();
    pages.set(host + '/redirect', { status: 302, headers: { location: other + '/limited' } });
    pages.set(other + '/limited', { status: 503, headers: { 'retry-after': '60' } });
    pages.set(host + '/good', { text: 'origin仍可用' });
    const first = settle(ctx.page(host + '/redirect'));
    await vi.advanceTimersByTimeAsync(350);
    expect((await first).error).toMatchObject({ status: 503 });
    await expect(ctx.page(other + '/sibling')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    const allowed = settle(ctx.page(host + '/good'));
    await vi.advanceTimersByTimeAsync(350);
    expect((await allowed).value).toMatchObject({ text: 'origin仍可用' });
    expect(requests).toEqual([
      { url: host + '/redirect', at: 0 }, { url: other + '/limited', at: 350 }, { url: host + '/good', at: 700 },
    ]);
  });

  it('连接失败准备换host时收到同站503，兜底发射也重查且不重复扣点', async () => {
    const ctx = root();
    pages.set('https://book15.net/network', { delay: 40, networkFailure: true });
    pages.set('https://www.book15.net/limited', { status: 503, headers: { 'retry-after': '60' } });
    const first = settle(ctx.page('https://book15.net/network'));
    const limited = settle(ctx.page('https://www.book15.net/limited'));
    await vi.advanceTimersByTimeAsync(400);
    expect((await limited).error).toMatchObject({ status: 503 });
    expect((await first).error).toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    expect(requests).toEqual([
      { url: 'https://book15.net/network', at: 0 }, { url: 'https://www.book15.net/limited', at: 350 },
    ]);
    expect(ctx.requests).toBe(2);
  });
});

const book = { title: '合成书', author: '合成作者' };
const rules = {
  ruleSearch: { bookList: '.book', name: '.title@text', author: '.author@text', bookUrl: 'a@href' },
  ruleBookInfo: { name: '.title@text', author: '.author@text', tocUrl: '.toc@href' },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.content@text' },
};
const makeSource = (url: string) => ({ url, name: url, searchUrl: url + '/search?q={{key}}', rules });
const searchUrl = (url: string) => url + '/search?q=' + encodeURIComponent(book.title);
const row = (url: string) => `<div class="book"><b class="title">合成书</b><b class="author">合成作者</b><a href="${url}">详情</a></div>`;
const detail = (url: string, author = book.author) => `<h1 class="title">合成书</h1><b class="author">${author}</b><a class="toc" href="${url}/toc">目录</a>`;
const toc = '<li class="chapter"><a href="/chapter/1">第一章</a></li>';

describe('53 有效正窗口才结束源，保留普通失败后的可用候选', () => {
  it.each([
    [503, undefined], [503, '0'], [503, 'Mon, 28 Sep 2026 00:00:00 GMT'], [503, 'not-a-date'],
    [404, '60'], [500, '60'],
  ])('%s / Retry-After=%s 仍检查后续可用详情', async (status, retryAfter) => {
    mocks.sources.mockResolvedValue([makeSource(host)]);
    pages.set(searchUrl(host), { text: row(host + '/failed') + row(host + '/good') });
    pages.set(host + '/failed', { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });
    pages.set(host + '/good', { text: detail(host) });
    pages.set(host + '/toc', { text: toc });
    const pending = settle(service.resolveSourceBook(book, root()));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).value).toMatchObject({ sourceUrl: host });
    expect(requests.filter(call => call.url === host + '/failed')).toHaveLength(status < 500 ? 1 : 2);
    expect(requests.at(-1)?.url).toBe(host + '/toc');
  });

  it('root首个详情503后保留备用双候选的目录预算：6请求、1400ms交付', async () => {
    mocks.sources.mockResolvedValue([makeSource(host), makeSource(other)]);
    pages.set(searchUrl(host), { text: [1, 2, 3, 4].map(id => row(host + '/failed/' + id)).join('') });
    for (const id of [1, 2, 3, 4]) pages.set(host + '/failed/' + id, { status: 503, headers: { 'retry-after': '60' } });
    pages.set(searchUrl(other), { text: row(other + '/wrong') + row(other + '/good') });
    pages.set(other + '/wrong', { text: detail(other, '另一作者') });
    pages.set(other + '/good', { text: detail(other) });
    pages.set(other + '/toc', { text: toc });
    const ctx = root(), pending = settle(service.resolveSourceBook(book, ctx));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).value).toMatchObject({ sourceUrl: other });
    expect(requests.map(call => call.at)).toEqual([0, 350, 350, 700, 1050, 1400]);
    expect(ctx.requests).toBe(6);
  });
});
