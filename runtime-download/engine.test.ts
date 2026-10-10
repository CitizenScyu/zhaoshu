// T8 验收：createSourceTransport 的限速器接线（合成 global fetch，不真联网）。
// 判别力（删掉修复即失败）：
//   - 成功 → recordSuccess(host)；
//   - 源站 HTTP 错误（含 429）→ recordFailure(host, ...)，429 带 Retry-After 则含 retryAfterMs（发现 4）；
//   - 网络/传输错误（无 status）→ 不计熔断（recordFailure 不被调用）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceTransport, loadEnginePool, type EngineModules, type RateLimiterLike } from './engine';
import { refreshSupportedHosts } from '../src/lib/source-policy';

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
