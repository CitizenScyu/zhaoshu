import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sources: vi.fn(), getSql: vi.fn() }));
vi.mock('./db', () => ({ getSql: mocks.getSql }));
vi.mock('./shuyuan', () => ({ getReadingSources: mocks.sources, getSourcePools: async () => ({ traversal: [], selectable: [] }) }));

// 合成同站配对（与 source-reader.test.ts 同款约定）：唯一的内建同站对（book15）在真实注册表里
// lifecycle='retired'，退休门会在物理发射前拒绝；本文件的「同站别名/换 host 兜底」用例只测冷却
// 共享语义，把 alternateSourceHost 钉成 cooldown.test ↔ www.cooldown.test（非内建 host，退休门不适用）。
vi.mock('./source-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source-policy')>();
  return {
    ...actual,
    alternateSourceHost: (host: string) => host === 'cooldown.test' ? 'www.cooldown.test'
      : host === 'www.cooldown.test' ? 'cooldown.test' : actual.alternateSourceHost(host),
  };
});

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
  (await import('./source-policy')).refreshSupportedHosts(['cooldown.test', 'www.cooldown.test', 'other.test']);
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
    pages.set(host + '/limited', { status: 503, headers: { 'retry-after': '60' } });
    pages.set(other + '/good', { text: 'other' });
    await expect(ctx.page(host + '/limited')).rejects.toMatchObject({ status: 503 });
    await expect(ctx.page('https://www.cooldown.test/good')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    const allowed = settle(ctx.page(other + '/good'));
    await vi.advanceTimersByTimeAsync(350);
    expect((await allowed).value).toMatchObject({ text: 'other' });
    expect(requests.map(call => call.url)).toEqual([host + '/limited', other + '/good']);
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
    pages.set(host + '/network', { delay: 40, networkFailure: true });
    pages.set('https://www.cooldown.test/limited', { status: 503, headers: { 'retry-after': '60' } });
    const first = settle(ctx.page(host + '/network'));
    const limited = settle(ctx.page('https://www.cooldown.test/limited'));
    await vi.advanceTimersByTimeAsync(400);
    expect((await limited).error).toMatchObject({ status: 503 });
    expect((await first).error).toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED' });
    expect(requests).toEqual([
      { url: host + '/network', at: 0 }, { url: 'https://www.cooldown.test/limited', at: 350 },
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

describe('46-probecool 补测：本地冷却拒绝与主机健康记账的边界', () => {
  // 冷却表里预置一个未到期条目 ⇒ page() 在 beforeRequest 阶段就抛 SourceCooldownError，一次上游请求
  // 都不发。该错误被 source-fetch 标 fromBeforeRequest ⇒ isTransportError 排除 ⇒ hostFailureKind 返
  // null ⇒ 不记账；SourceCooldownError 的注释就是这么要求的（本地拒绝不代表又收到一次 HTTP 503）。
  // 判据必须是「连拒两次」：HOST_SUSPECT_FAILURES=2，误记账两次就到线、isHostSuspect 翻 true。
  // 上面 53 用例里那条 isHostSuspect=false 钉不住这点 —— 同一次 429 本身就记 1 次，本来就未到门槛。
  it('连续两次被本地冷却拦下：不出网、也不把好源写进主机健康', async () => {
    const health = await import('./source-host-health');
    const cooldowns = new Map([[service.sourceStationKey(host + '/good'), epoch + 60_000]]);
    pages.set(host + '/good', { text: 'ok' }); // 站本身可达：冷却逻辑若失效，请求会成功而不是被拒
    const ctx = new service.SourceRequestContext(new AbortController().signal, undefined, { cooldownSlots: cooldowns });
    for (let i = 0; i < 2; i += 1) {
      await expect(ctx.page(host + '/good')).rejects.toMatchObject({ code: 'SOURCE_SCOPE_EXHAUSTED', status: 503 });
    }
    expect(requests).toEqual([]); // 一次上游请求都没发
    expect(health.isHostSuspect('cooldown.test')).toBe(false);
    expect(cooldowns.size).toBe(1); // 未到期条目原样留着，不被 checkCooldown 顺手删掉
  });

  it('429 不带 Retry-After：照记主机健康（两次即 suspect），但不设冷却、同站下一个请求照常出网', async () => {
    // 冷却窗口只在源站明确给出正 Retry-After 时才设（page() catch 里的 positiveRetryAfter）：裸 429
    // 没说「等多久」，凭空设窗口等于给全站加一把没有期限的锁。但它确实是限流信号 ⇒ isSourceThrottled
    // 认 429 ⇒ recordHostFailure('http_429') 照记，两件事不能互相顶替。
    // 三次请求必须在**同一棵请求树**里：冷却表是树内共享（53 语义），换成三个独立 root 的话
    // 各自新建空表，误设冷却也影响不到下一次，这条就钉不住了。
    const health = await import('./source-host-health');
    pages.set(host + '/rl', { status: 429 }); // 无 retry-after 头
    pages.set(host + '/good', { text: 'ok' });
    const ctx = root();
    await expect(ctx.child(host).page(host + '/rl')).rejects.toMatchObject({ status: 429 });
    expect(health.isHostSuspect('cooldown.test')).toBe(false); // 1 次未到 HOST_SUSPECT_FAILURES
    await vi.advanceTimersByTimeAsync(400); // 过掉同站节流槽的 350ms 间隔
    await expect(ctx.child(host).page(host + '/rl')).rejects.toMatchObject({ status: 429 });
    expect(health.isHostSuspect('cooldown.test')).toBe(true); // 第 2 次到线 ⇒ 候选排序会避开这个站
    await vi.advanceTimersByTimeAsync(400);
    // suspect 只影响排序、不设冷却：同站另一个 url 立刻照常出网。
    // 裸 429 若被误设冷却，这里会是 SOURCE_SCOPE_EXHAUSTED 且 requests 不增。
    await expect(ctx.page(host + '/good')).resolves.toMatchObject({ text: 'ok' });
    expect(requests.map(call => call.url)).toEqual([host + '/rl', host + '/rl', host + '/good']);
    expect(health.isHostSuspect('cooldown.test')).toBe(false); // 成功一次即恢复（既有语义）
  });
});
