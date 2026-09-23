import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 41-M1.3 主机级健康记忆：判定规则(④⑥)与唯一记录点 fetchSourceText 的计数口径(⑤)。
// 记忆是模块级状态：每条用例 resetModules 后重新 import,source-fetch 与本用例拿到的是同一份新记忆。

let health: typeof import('./source-host-health');
let sourceFetch: typeof import('./source-fetch');
const WINDOW = 600_000;
const source = (url: string) => ({ url, name: url });
const urls = (list: Array<{ url: string }>) => list.map(({ url }) => url);
/** 连续记 n 次硬失败。 */
const fail = (host: string, n = 2, at = 0) => {
  for (let i = 0; i < n; i += 1) health.recordHostFailure(host, 'timeout', at);
};

beforeEach(async () => {
  vi.resetModules();
  health = await import('./source-host-health');
  sourceFetch = await import('./source-fetch');
  (await import('./source-policy')).refreshSupportedHosts(['e1.test']);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('判定：连续硬失败 ≥ 2 次且最近一次在窗口内 ⇒ suspect', () => {
  it('1 次不算,2 次才算', () => {
    fail('dead.test', 1);
    expect(health.isHostSuspect('dead.test', 1)).toBe(false);
    fail('dead.test', 1);
    expect(health.isHostSuspect('dead.test', 1)).toBe(true);
  });

  it('④ 窗口过期后恢复原位(半开);计数保留，再硬失败一次立即重判 suspect', () => {
    fail('dead.test');
    const pool = [source('https://dead.test/'), source('https://ok.test/')];
    expect(urls(health.orderByHostHealth(pool, WINDOW - 1))).toEqual(['https://ok.test/', 'https://dead.test/']);
    expect(health.isHostSuspect('dead.test', WINDOW)).toBe(false);
    expect(health.orderByHostHealth(pool, WINDOW)).toBe(pool);
    health.recordHostFailure('dead.test', 'timeout', WINDOW + 5);
    expect(health.isHostSuspect('dead.test', WINDOW + 5)).toBe(true);
  });

  it('④ 中间有一次成功就立即清零：成功后要重新攒满 2 次;已 suspect 时成功一次也立即恢复', () => {
    fail('flaky.test', 1, 0);
    health.recordHostSuccess('flaky.test');
    fail('flaky.test', 1, 10);
    expect(health.isHostSuspect('flaky.test', 10)).toBe(false);
    fail('flaky.test', 1, 20);
    expect(health.isHostSuspect('flaky.test', 20)).toBe(true);
    health.recordHostSuccess('flaky.test');
    expect(health.isHostSuspect('flaky.test', 21)).toBe(false);
  });

  it('窗口 env SOURCE_HOST_SUSPECT_MS 生效，钳在 [60000, 3600000],空串/非数字/0/负数回退默认 600000', () => {
    const read = health.sourceHostSuspectMs;
    expect(read({})).toBe(WINDOW);
    expect(read({ SOURCE_HOST_SUSPECT_MS: '120000' })).toBe(120_000);
    expect(read({ SOURCE_HOST_SUSPECT_MS: '5' })).toBe(60_000);
    expect(read({ SOURCE_HOST_SUSPECT_MS: '3600000' })).toBe(3_600_000);
    expect(read({ SOURCE_HOST_SUSPECT_MS: '99999999' })).toBe(3_600_000);
    for (const invalid of ['', 'abc', '0', '-3']) expect(read({ SOURCE_HOST_SUSPECT_MS: invalid })).toBe(WINDOW);
    vi.stubEnv('SOURCE_HOST_SUSPECT_MS', '120000'); // 缺省参数读 process.env,判定随之生效
    fail('dead.test');
    expect(health.isHostSuspect('dead.test', 119_999)).toBe(true);
    expect(health.isHostSuspect('dead.test', 120_000)).toBe(false);
  });

  it('apex 与 www 是同一个站：两边的失败记在同一条上', () => {
    health.recordHostFailure('www.book15.net', 'timeout', 0);
    health.recordHostFailure('book15.net', 'http_5xx', 0);
    expect(health.isHostSuspect('book15.net', 1)).toBe(true);
    expect(health.isHostSuspect('www.book15.net', 1)).toBe(true);
    health.recordHostSuccess('www.book15.net');
    expect(health.isHostSuspect('book15.net', 1)).toBe(false);
  });

  it('⑥ 上限 256:满了淘汰最久没记过失败的 host;再记一次失败会刷新它的位置', () => {
    expect(health.HOST_HEALTH_MAX_ENTRIES).toBe(256);
    for (let i = 0; i < 256; i += 1) fail(`h${i}.test`);
    for (let i = 0; i < 256; i += 1) expect(health.isHostSuspect(`h${i}.test`, 1)).toBe(true);
    fail('h0.test'); // 刷新 h0 ⇒ 最旧的变成 h1
    fail('new.test'); // 第 257 个 ⇒ 淘汰 h1
    expect(health.isHostSuspect('h1.test', 1)).toBe(false);
    expect(health.isHostSuspect('h0.test', 1)).toBe(true);
    expect(health.isHostSuspect('h2.test', 1)).toBe(true);
    expect(health.isHostSuspect('new.test', 1)).toBe(true);
  });

  it('刚跨进 suspect 时打一行 host_suspect(只有 host 与计数);suspect 期间不重复打，过期后再次进入再打', () => {
    const warn = vi.mocked(console.warn);
    health.recordHostFailure('www.book15.net', 'timeout', 0);
    expect(warn).not.toHaveBeenCalled();
    health.recordHostFailure('book15.net', 'http_5xx', 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[source-health] host_suspect');
    expect(JSON.parse(String(warn.mock.calls[0][1]))).toEqual({
      event: 'host_suspect', host: 'book15.net', failures: 2, kind: 'http_5xx', suspectMs: WINDOW,
    });
    health.recordHostFailure('book15.net', 'http_5xx', 2);
    expect(warn).toHaveBeenCalledTimes(1);
    health.recordHostFailure('book15.net', 'timeout', 2 + WINDOW);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('orderByHostHealth:只降序、不剔除、稳定', () => {
  it('③ 记忆为空 ⇒ 原样返回同一个数组，连时钟都不读', () => {
    const now = vi.spyOn(Date, 'now');
    const pool = [source('https://book15.net/'), source('https://e1.test/'), source('https://e2.test/')];
    expect(health.orderByHostHealth(pool)).toBe(pool);
    expect(now).not.toHaveBeenCalled();
  });

  it('suspect 挪到队尾，前后两段各自保持相对顺序，一个都不少', () => {
    fail('a.test');
    fail('c.test');
    const pool = ['a', 'b', 'c', 'd'].map((n) => source(`https://${n}.test/`));
    expect(urls(health.orderByHostHealth(pool, 1))).toEqual(['https://b.test/', 'https://d.test/', 'https://a.test/', 'https://c.test/']);
  });

  it('没有 suspect、全部 suspect、只有一个源 ⇒ 原样返回同一个数组', () => {
    fail('x.test', 1); // 未达阈值
    const pool = [source('https://x.test/'), source('https://y.test/')];
    expect(health.orderByHostHealth(pool, 1)).toBe(pool);
    fail('x.test', 1);
    fail('y.test');
    expect(health.orderByHostHealth(pool, 1)).toBe(pool);
    const single = [source('https://x.test/')];
    expect(health.orderByHostHealth(single, 1)).toBe(single);
  });

  it('builtin 的 book15(https://book15.net/)被 www 上的失败带着降序', () => {
    fail('www.book15.net');
    const pool = [source('https://book15.net/'), source('https://e1.test/')];
    expect(urls(health.orderByHostHealth(pool, 1))).toEqual(['https://e1.test/', 'https://book15.net/']);
  });
});

describe('唯一记录点 fetchSourceText:只有传输层硬失败才计数', () => {
  const E1 = 'https://e1.test/a';
  const call = (url = E1, init: { signal?: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> } = {}) =>
    sourceFetch.fetchSourceText(url, { signal: init.signal ?? new AbortController().signal, beforeRequest: init.beforeRequest })
      .then(() => 'ok', (error: unknown) => error);
  const respondWith = (make: () => Response | Promise<Response>) => {
    const fetchMock = vi.fn().mockImplementation(async () => make());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  /** 按真实时钟记 1 次硬失败(与 fetchSourceText 记录用的是同一个时钟)。 */
  const failNow = (host: string) => health.recordHostFailure(host, 'timeout');

  it.each([
    ['HTTP 522', () => new Response('', { status: 522 })],
    ['HTTP 500', () => new Response('', { status: 500 })],
    ['fetch failed', () => { throw new TypeError('fetch failed'); }],
  ])('%s 连续 2 次 ⇒ suspect', async (_, make) => {
    respondWith(make);
    await call();
    expect(health.isHostSuspect('e1.test')).toBe(false);
    await call();
    expect(health.isHostSuspect('e1.test')).toBe(true);
  });

  it('连接段超时计数(每次 3s 到点放弃)', async () => {
    vi.useFakeTimers();
    respondWith(() => new Promise<Response>(() => {}));
    for (let i = 0; i < 2; i += 1) {
      const pending = call();
      await vi.advanceTimersByTimeAsync(sourceFetch.SOURCE_CONNECT_TIMEOUT_MS);
      expect(await pending).toMatchObject({ name: 'ConnectTimeoutError' });
    }
    expect(health.isHostSuspect('e1.test')).toBe(true);
  });

  it('换 host 兜底算同一次逻辑请求：apex 与 www 都失败只计 1 次;www 成功即清零', async () => {
    const fetchMock = respondWith(() => { throw new TypeError('fetch failed'); });
    await call('https://book15.net/a');
    expect(fetchMock).toHaveBeenCalledTimes(2); // apex + www 两发物理请求
    expect(health.isHostSuspect('book15.net')).toBe(false);
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response('正文'));
    expect(await call('https://book15.net/a')).toBe('ok');
    // 清零后再失败一次仍不够 2 次。
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await call('https://book15.net/a');
    expect(health.isHostSuspect('book15.net')).toBe(false);
  });

  it.each([
    ['HTTP 404', () => new Response('', { status: 404 })],
    ['HTTP 403', () => new Response('', { status: 403 })],
    ['HTTP 429', () => new Response('', { status: 429 })],
    ['策略拒绝(响应体超限)', () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))],
    ['解码失败(非法 UTF-8)', () => new Response(new Uint8Array([0xff, 0xfe, 0xfd]))],
  ])('⑤ %s:不计数，也不清零', async (_, make) => {
    failNow('e1.test');
    respondWith(make);
    for (let i = 0; i < 3; i += 1) expect(await call()).not.toBe('ok');
    expect(health.isHostSuspect('e1.test')).toBe(false); // 计了数就会 suspect
    failNow('e1.test');
    expect(health.isHostSuspect('e1.test')).toBe(true); // 清了零就只有 1 次
  });

  it('⑤ 搜不到书(SOURCE_NOT_FOUND)在 HTTP 层是 200:算成功，清零', async () => {
    failNow('e1.test');
    respondWith(() => new Response('<html>没有结果</html>'));
    expect(await call()).toBe('ok');
    failNow('e1.test');
    expect(health.isHostSuspect('e1.test')).toBe(false);
  });

  it('beforeRequest 的预算/节流中止、调用方中止都不计数', async () => {
    failNow('e1.test');
    const fetchMock = respondWith(() => { throw new TypeError('fetch failed'); });
    const budget = async () => { throw new Error('预算已用完'); };
    for (let i = 0; i < 2; i += 1) expect(await call(E1, { beforeRequest: budget })).toMatchObject({ message: '预算已用完' });
    expect(fetchMock).not.toHaveBeenCalled();
    // 请求在飞时调用方中止：理由用 AbortSignal.timeout() 那种 TimeoutError —— 形态和 host 超时一模一样，
    // 只能靠「父 signal 已中止」这条守卫排除(去掉守卫这条就红)。
    for (let i = 0; i < 2; i += 1) {
      const controller = new AbortController();
      fetchMock.mockImplementationOnce(async () => {
        controller.abort(new DOMException('调用方的总时限到了', 'TimeoutError'));
        throw controller.signal.reason;
      });
      expect(await call(E1, { signal: controller.signal })).toMatchObject({ name: 'TimeoutError' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(health.isHostSuspect('e1.test')).toBe(false);
  });
});
