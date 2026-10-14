// T8 验收：createSourceTransport 的限速器接线（合成 global fetch，不真联网）。
// 判别力（删掉修复即失败）：
//   - 成功 → recordSuccess(host)；
//   - 源站 HTTP 错误（含 429）→ recordFailure(host, ...)，429 带 Retry-After 则含 retryAfterMs（发现 4）；
//   - 网络/传输错误（无 status）→ 不计熔断（recordFailure 不被调用）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResolveSource, createSourceTransport, type EngineModules, type RateLimiterLike } from "./engine";
import { refreshSupportedHosts } from "../src/lib/source-policy";

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
        alternateSourceHost: vi.fn(() => 'www.source.example'),
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

  it('没有完整 URL 匹配时保留原 host/alternate 池序兼容', async () => {
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
      policy: { refreshSupportedHosts: vi.fn(), alternateSourceHost: vi.fn(() => undefined) },
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
