// T8 验收：createSourceTransport 的限速器接线（合成 global fetch，不真联网）。
// 判别力（删掉修复即失败）：
//   - 成功 → recordSuccess(host)；
//   - 源站 HTTP 错误（含 429）→ recordFailure(host, ...)，429 带 Retry-After 则含 retryAfterMs（发现 4）；
//   - 网络/传输错误（无 status）→ 不计熔断（recordFailure 不被调用）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceTransport, type RateLimiterLike } from './engine';

afterEach(() => vi.unstubAllGlobals());

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
    const page = await transport('https://book15.net/x', opts());
    expect(page.text).toBe('正文');
    expect(limiter.acquireCalls).toEqual(['book15.net']);
    expect(limiter.success).toEqual(['book15.net']);
    expect(limiter.failures).toHaveLength(0);
  });

  it('429 带 Retry-After → recordFailure(host, {retryAfterMs}) 并原样上抛', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '5' } })));
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', opts())).rejects.toMatchObject({ status: 429 });
    expect(limiter.failures).toEqual([{ key: 'book15.net', opts: { retryAfterMs: 5000 } }]);
    expect(limiter.success).toHaveLength(0);
  });

  it('HTTP 错误无 Retry-After → recordFailure(host, undefined)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', opts())).rejects.toMatchObject({ status: 503 });
    expect(limiter.failures).toEqual([{ key: 'book15.net', opts: undefined }]);
  });

  it('网络/传输错误（无 status）→ 不计熔断', async () => {
    // fetch 抛传输错误：fetchSourceText 会换 host 重试，最终仍抛无 status 的 TypeError。
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'))));
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', opts())).rejects.toBeInstanceOf(TypeError);
    expect(limiter.failures).toHaveLength(0);
    expect(limiter.success).toHaveLength(0);
  });
});
