// T8 验收：createSourceTransport 的限速器接线（合成 global fetch，不真联网）。
// 判别力（删掉修复即失败）：
//   - 成功 → recordSuccess(host)；
//   - 源站 HTTP 错误（含 429）→ recordFailure(host, ...)，429 带 Retry-After 则含 retryAfterMs（发现 4）；
//   - 网络/传输错误（无 status）→ 不计熔断（recordFailure 不被调用）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResolveSource, createSourceTransport, downloadHeadersTimeoutMs, loadEnginePool, ResolveSourceBlockedError, type EngineModules, type RateLimiterLike } from "./engine";
import { refreshSupportedHosts, stationKeyOfHost } from "../src/lib/source-policy";

vi.mock("../src/lib/supported-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/supported-sources")>();
  return { ...actual, isRetiredBuiltinHost: () => false };
});

// book15 已被退休源闸（assertNotRetiredBuiltin）拦死，传输语义用例迁合成域：
// 运行时 host 门注册合成 host 即可放行，且该 host 不在静态 SUPPORTED_SOURCE_HOSTS
// 二元组内 ⇒ 无换 host 兜底，断言语义（429/503/TypeError）保持原样。
const HOST = 't8-transport.test';

beforeEach(() => refreshSupportedHosts([HOST]));
afterEach(() => { refreshSupportedHosts([]); vi.unstubAllGlobals(); });

function fakeLimiter(): RateLimiterLike & { acquireCalls: string[]; success: string[]; failures: { key: string; opts?: { retryAfterMs?: number } }[] } {
  const acquireCalls: string[] = [];
  const success: string[] = [];
  const failures: { key: string; opts?: { retryAfterMs?: number } }[] = [];
  return {
    acquireCalls, success, failures,
    async acquire(key) { acquireCalls.push(key); },
    recordSuccess(key) { success.push(key); },
    recordFailure(key, opts) { failures.push({ key, opts }); },
  };
}

const opts = () => ({ signal: new AbortController().signal });

describe('T8 createSourceTransport 限速器接线', () => {
  it('成功：acquire(host) 先行，返回页面并 recordSuccess(host)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('正文')));
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    const page = await transport(`https://${HOST}/x`, opts());
    expect(page.text).toBe('正文');
    expect(limiter.acquireCalls).toEqual([HOST]);
    expect(limiter.success).toEqual([HOST]);
    expect(limiter.failures).toHaveLength(0);
  });

  it('429 带 Retry-After → recordFailure(host, {retryAfterMs}) 并原样上抛', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '5' } })));
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport(`https://${HOST}/x`, opts())).rejects.toMatchObject({ status: 429 });
    expect(limiter.failures).toEqual([{ key: HOST, opts: { retryAfterMs: 5000 } }]);
    expect(limiter.success).toHaveLength(0);
  });

  it('HTTP 错误无 Retry-After → recordFailure(host, undefined)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport(`https://${HOST}/x`, opts())).rejects.toMatchObject({ status: 503 });
    expect(limiter.failures).toEqual([{ key: HOST, opts: undefined }]);
  });

  it('pageopts1105：取页覆写交给 fetchSourceText——POST + body 真发出，GBK 响应按声明解码', async () => {
    const gbk = Uint8Array.from([0xd5, 0xfd, 0xce, 0xc4]); // 「正文」
    const fetchMock = vi.fn().mockResolvedValue(new Response(gbk, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await createSourceTransport(fakeLimiter())(`https://${HOST}/s`, {
      ...opts(), request: { method: 'POST', body: 'k=1', charset: 'gbk' }, responseCharset: 'gbk',
    });
    expect(page.text).toBe('正文');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(new TextDecoder().decode(fetchMock.mock.calls[0][1].body)).toBe('k=1');
  });

  it('pageopts1105：不带覆写 = GET + UTF-8 严格解码，同改前', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Uint8Array.from([0xd5, 0xfd, 0xce, 0xc4]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSourceTransport(fakeLimiter())(`https://${HOST}/s`, opts())).rejects.toMatchObject({ code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('网络/传输错误（无 status）→ 不计熔断', async () => {
    // fetch 抛传输错误：fetchSourceText 会换 host 重试，最终仍抛无 status 的 TypeError。
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'))));
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport(`https://${HOST}/x`, opts())).rejects.toBeInstanceOf(TypeError);
    expect(limiter.failures).toHaveLength(0);
    expect(limiter.success).toHaveLength(0);
  });
});

describe('headers1111 下载线首包上限', () => {
  afterEach(() => vi.useRealTimers());

  // 响应头 4s 才到：默认 3s 判 ConnectTimeoutError（合成 host 无备用 host，不换 host），覆写 6s 则拿到正文。
  const slowHeaders = () => vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
    setTimeout(() => resolve(new Response('正文')), 4_000);
  }));

  it('缺省不覆写：仍是 source-fetch 的 3s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', slowHeaders());
    const result = createSourceTransport(fakeLimiter())(`https://${HOST}/s`, opts());
    const assertion = expect(result).rejects.toMatchObject({ name: 'ConnectTimeoutError' });
    await vi.advanceTimersByTimeAsync(3_001);
    await assertion;
  });

  it('connectTimeoutMs=6000：4s 首包照常成功', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', slowHeaders());
    const result = createSourceTransport(fakeLimiter(), { connectTimeoutMs: 6_000 })(`https://${HOST}/s`, opts());
    await vi.advanceTimersByTimeAsync(4_001);
    await expect(result).resolves.toMatchObject({ text: '正文' });
  });

  it('DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS：缺省/非法 = undefined，正整数夹到 1000..8000', () => {
    expect(downloadHeadersTimeoutMs({})).toBeUndefined();
    expect(downloadHeadersTimeoutMs({ DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS: '' })).toBeUndefined();
    expect(downloadHeadersTimeoutMs({ DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS: 'six' })).toBeUndefined();
    expect(downloadHeadersTimeoutMs({ DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS: '-5' })).toBeUndefined();
    expect(downloadHeadersTimeoutMs({ DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS: '0' })).toBeUndefined();
    expect(downloadHeadersTimeoutMs({ DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS: ' 6000 ' })).toBe(6000);
    expect(downloadHeadersTimeoutMs({ DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS: '200' })).toBe(1000);
    expect(downloadHeadersTimeoutMs({ DOWNLOAD_SOURCE_HEADERS_TIMEOUT_MS: '30000' })).toBe(8000);
  });
});

describe('引擎源完整 URL 解析', () => {
  function resolverFixture() {
    const first = { url: 'https://source.example/rules?v=1', name: 'first', searchUrl: '/first', rules: {} };
    const selected = { url: 'https://source.example/other?v=2', name: 'selected', searchUrl: '/selected', rules: {} };
    const alternate = { url: 'https://www.source.example/rules', name: 'alternate', searchUrl: '/alternate', rules: {} };
    const pool = [alternate, first, selected];
    const modules = {
      supported: {
        isRetiredBuiltinHost: vi.fn(() => false),
        builtinSourceForHost: vi.fn<() => object | null>(() => null),
      },
      policy: {
        refreshSupportedHosts: vi.fn(),
        stationKeyOfHost,
      },
      shuyuan: {
        getPoolEngineHosts: vi.fn(async () => ['source.example', 'www.source.example']),
        getEngineSources: vi.fn(async () => pool),
        // bpool-expand：loadEnginePool 现走 Download 池入口（开关关时内部即回落上两者）。
        getDownloadPoolEngineHosts: vi.fn(async () => ['source.example', 'www.source.example']),
        getDownloadEngineSources: vi.fn(async () => pool),
        getBuiltinRequestSource: vi.fn(async () => first),
      },
    };
    const resolve = createResolveSource(modules as unknown as EngineModules);
    return { first, selected, alternate, modules, resolve };
  }

  it('同 host 多规则保留完整 path/query 身份，不被池首项或备用 host 抢先', async () => {
    const h = resolverFixture();
    for (const source of [h.first, h.selected]) {
      const result = await h.resolve(null, source.url, new AbortController().signal);
      expect(result.source).toBe(source);
      expect(result.builtin).toBe(false);
    }
  });

  it('没有完整 URL 匹配时保留原 host/同站孪生池序兼容（www 孪生与 apex 同站键，池序首匹配即得）', async () => {
    const h = resolverFixture();
    const result = await h.resolve(null, 'https://source.example/book/42', new AbortController().signal);
    expect(result.source).toBe(h.alternate);
  });

  // 41-cnresolve：任务 URL 带语言/版块前缀（noveltri 形态 /zh-cn/book/…）时，
  // 匹配序 = 精确 URL > 最长前缀源（同版块）> host 兜底。判别力：删掉前缀匹配即命中 zh-tw 主源失败。
  it('同 host 分版源：任务 URL 的最长前缀源优先于 host 兜底首项（noveltri zh-cn/zh-tw）', async () => {
    const tw = { url: 'https://source.example', name: 'tw', searchUrl: '/zh-tw/search', rules: {} };
    const cn = { url: 'https://source.example/zh-cn', name: 'cn', searchUrl: '/zh-cn/search', rules: {} };
    // 池序与 DB 一致：zh-tw 主源在前。
    const pool = [tw, cn];
    const modules = {
      supported: { isRetiredBuiltinHost: vi.fn(() => false), builtinSourceForHost: vi.fn(() => null) },
      policy: { refreshSupportedHosts: vi.fn(), stationKeyOfHost },
      shuyuan: {
        getDownloadPoolEngineHosts: vi.fn(async () => ['source.example']),
        getDownloadEngineSources: vi.fn(async () => pool),
        getPoolEngineHosts: vi.fn(async () => ['source.example']),
        getEngineSources: vi.fn(async () => pool),
      },
    };
    const resolve = createResolveSource(modules as unknown as EngineModules);
    const result = await resolve(null, 'https://source.example/zh-cn/book/abc.html', new AbortController().signal);
    expect(result.source).toBe(cn);
    expect(result.builtin).toBe(false);
    // 无前缀命中时仍走 host 兜底（首项），既有行为不变。
    const fallback = await resolve(null, 'https://source.example/read/other.html', new AbortController().signal);
    expect(fallback.source).toBe(tw);
  });

  it('HTTPS 和退休门仍先于池加载，内建源仍先于引擎精确匹配', async () => {
    const h = resolverFixture();
    const signal = new AbortController().signal;
    await expect(h.resolve(null, 'http://source.example/rules?v=1', signal))
      .rejects.toMatchObject({ code: 2, reason: 'source_url_must_be_https' });
    h.modules.supported.isRetiredBuiltinHost.mockReturnValue(true);
    await expect(h.resolve(null, h.selected.url, signal))
      .rejects.toMatchObject({ code: 2, reason: 'builtin_source_retired' });
    expect(h.modules.shuyuan.getEngineSources).not.toHaveBeenCalled();
    h.modules.supported.isRetiredBuiltinHost.mockReturnValue(false);
    h.modules.supported.builtinSourceForHost.mockReturnValue({});
    const result = await h.resolve(null, h.selected.url, signal);
    expect(result).toEqual({ source: h.first, builtin: true });
    expect(h.modules.shuyuan.getEngineSources).not.toHaveBeenCalled();
  });

  // adultmiss1104：落空分三档——普通落空仍是 ResolveSourceError（回退层会换源）；成人站/判定失败改抛
  // ResolveSourceBlocked（构造器名不同，回退层不换源）。命中池时不查成人判定。
  it('池内落空：普通站 ResolveSourceError(1)；成人站与判定失败 ResolveSourceBlocked(1)', async () => {
    const h = resolverFixture();
    const isAdultSourceStation = vi.fn(async () => false);
    Object.assign(h.modules.shuyuan, { isAdultSourceStation });
    const signal = new AbortController().signal;
    await h.resolve(null, h.selected.url, signal);
    expect(isAdultSourceStation).not.toHaveBeenCalled();
    const miss = h.resolve(null, 'https://other.example/book/1', signal);
    await expect(miss).rejects.toMatchObject({ name: 'ResolveSourceError', code: 1, reason: 'no_engine_source_for_host' });
    expect(isAdultSourceStation).toHaveBeenCalledWith('other.example', signal);
    isAdultSourceStation.mockResolvedValueOnce(true);
    await expect(h.resolve(null, 'https://other.example/book/1', signal))
      .rejects.toMatchObject({ name: 'ResolveSourceBlocked', code: 1, reason: 'adult_station_excluded' });
    isAdultSourceStation.mockRejectedValueOnce(new Error('db down'));
    const blocked = await h.resolve(null, 'https://other.example/book/1', signal).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ResolveSourceBlockedError);
    expect(blocked).toMatchObject({ name: 'ResolveSourceBlocked', code: 1, reason: 'adult_check_unavailable' });
  });
});

describe('afterAcquire 物理门', () => {
  it('callerGate → acquire → afterAcquire → fetch 顺序', async () => {
    const order: string[] = [];
    const limiter = fakeLimiter();
    const acquire = limiter.acquire;
    limiter.acquire = async key => { order.push('acquire'); await acquire(key); };
    vi.stubGlobal('fetch', vi.fn(async () => { order.push('fetch'); return new Response('正文'); }));
    await createSourceTransport(limiter)('https://book15.net/x', {
      ...opts(),
      beforeFetch: async () => { order.push('caller-gate'); },
      afterAcquire: async () => { order.push('after-acquire'); },
    });
    expect(order).toEqual(['caller-gate', 'acquire', 'after-acquire', 'fetch']);
  });

  it('只有 afterAcquire、无 limiter 时重定向每跳仍复查', async () => {
    const afterAcquire = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://www.book15.net/y' } }))
      .mockResolvedValueOnce(new Response('正文')));
    const page = await createSourceTransport(undefined)('https://book15.net/x', { ...opts(), afterAcquire });
    expect(page.url).toBe('https://www.book15.net/y');
    expect(afterAcquire.mock.calls.map(([, url]) => url)).toEqual(['https://book15.net/x', 'https://www.book15.net/y']);
  });

  it('复查拒绝即使附 status=429 也零 fetch、不计源站失败', async () => {
    const error = Object.assign(new Error('synthetic gate'), { status: 429, retryAfterMs: 5000 });
    const limiter = fakeLimiter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSourceTransport(limiter)('https://book15.net/x', {
      ...opts(), afterAcquire: async () => { throw error; },
    })).rejects.toBe(error);
    expect(limiter.acquireCalls).toEqual(['book15.net']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.failures).toEqual([]);
    expect(limiter.success).toEqual([]);
  });

  it('限速排队后 abort 阻止发射', async () => {
    const controller = new AbortController();
    const error = new Error('synthetic cancellation');
    const limiter = fakeLimiter();
    limiter.acquire = async key => { limiter.acquireCalls.push(key); controller.abort(error); };
    const afterAcquire = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSourceTransport(limiter)('https://book15.net/x', {
      signal: controller.signal, afterAcquire,
    })).rejects.toBe(error);
    expect(afterAcquire).toHaveBeenCalledTimes(1);
    expect(afterAcquire.mock.calls[0][0].aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.failures).toEqual([]);
  });

  it('换备用 host 按实际发射 URL 复查', async () => {
    const afterAcquire = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('正文')));
    const limiter = fakeLimiter();
    const page = await createSourceTransport(limiter)('https://book15.net/x', { ...opts(), afterAcquire });
    expect(page.url).toBe('https://www.book15.net/x');
    expect(limiter.acquireCalls).toEqual(['book15.net', 'www.book15.net']);
    expect(afterAcquire.mock.calls.map(([, url]) => url)).toEqual(['https://book15.net/x', 'https://www.book15.net/x']);
  });
});

describe('loadEnginePool 下载池接线', () => {
  it('先按下载门刷 host 门，再取下载池；不下探 getPoolEngineHosts/getEngineSources', async () => {
    const pool = [{ url: 'https://source.example/rules', name: 's', searchUrl: '/s', rules: {} }];
    const modules = {
      policy: { refreshSupportedHosts: vi.fn() },
      shuyuan: {
        getPoolEngineHosts: vi.fn(async () => ['source.example']),
        getEngineSources: vi.fn(async () => pool),
        getDownloadPoolEngineHosts: vi.fn(async () => ['source.example', 'www.source.example']),
        getDownloadEngineSources: vi.fn(async () => pool),
      },
    };
    const result = await loadEnginePool(modules as unknown as EngineModules, new AbortController().signal);
    expect(result).toBe(pool);
    expect(modules.shuyuan.getDownloadPoolEngineHosts).toHaveBeenCalledTimes(1);
    expect(modules.shuyuan.getDownloadEngineSources).toHaveBeenCalledTimes(1);
    expect(modules.shuyuan.getPoolEngineHosts).not.toHaveBeenCalled();
    expect(modules.shuyuan.getEngineSources).not.toHaveBeenCalled();
    expect(modules.policy.refreshSupportedHosts).toHaveBeenCalledWith(['source.example', 'www.source.example']);
  });
});
