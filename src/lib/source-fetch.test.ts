import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText, MAX_SOURCE_BYTES } from './source-fetch';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const options = () => ({ signal: new AbortController().signal });

describe('source fetch worker policy parity', () => {
  it('checks each redirect before sending a request, including relative redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('正文'));
    const beforeRequest = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://book15.net/start', { ...options(), beforeRequest })).toEqual({ url: 'https://book15.net/next', text: '正文' });
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init.redirect === 'manual' && init.cache === 'no-store')).toBe(true);
  });

  it.each(['http://book15.net/a', 'https://book15.net.evil.invalid/a', 'https://@book15.net/a', 'https://127.0.0.1/a'])(
    'blocks redirect target %s before fetching it', async (location) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('stops redirect loops', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/' } })));
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('循环');
  });

  it('bounds redirects even when every location is new', async () => {
    let ordinal = 0;
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/hop' + ++ordinal } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('次数超限');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([true, false])('bounds declared and streamed bodies (declared=%s)', async (declared) => {
    const body = new Uint8Array(MAX_SOURCE_BYTES + 1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: declared ? { 'content-length': String(body.length) } : {} })));
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('体积超限');
  });

  it('keeps a single deadline for headers, redirects and body even if the upstream ignores abort', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    // 两 host 都挂起（ReadableStream 不产出且不结束），总超时必须仍然成立。
    // 每次 fetch 都要新 Response：同一 Response 的 body 只能读一次。
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new ReadableStream({ cancel }))));
    const result = fetchSourceText('https://book15.net/', { ...options(), timeoutMs: 100, connectTimeoutMs: 1000 });
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    // 首次总超时 → 换 host 重试（新计时器）→ 第二次总超时；两次都到点才算收敛。
    await vi.advanceTimersByTimeAsync(101);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(2); // apex 与 www 各释放一次迟到的响应体
  });

  it('propagates cancellation and does not begin an aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller left'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', { signal: controller.signal })).rejects.toThrow('caller left');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('www.book15.net 同站兜底与超时拆段', () => {
  const transportFailure = new TypeError('fetch failed');

  it('swaps to the alternate host once after a transport failure, as one logical request', async () => {
    // apex 连接层失败 → www 成功；beforeRequest 仅扣一次（换 host 重试是同一次逻辑请求）。
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(new Response('正文'));
    const beforeRequest = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://book15.net/books/details1.html', { ...options(), beforeRequest }))
      .toEqual({ url: 'https://www.book15.net/books/details1.html', text: '正文' });
    expect(fetchMock.mock.calls.map(([url]) => url))
      .toEqual(['https://book15.net/books/details1.html', 'https://www.book15.net/books/details1.html']);
    expect(beforeRequest).toHaveBeenCalledOnce();
  });

  it('swaps back from www to the apex host symmetrically', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://www.book15.net/a', options()))
      .toEqual({ url: 'https://book15.net/a', text: '正文' });
  });

  it('rethrows the network error when both hosts fail on the transport layer', async () => {
    const fetchMock = vi.fn().mockRejectedValue(transportFailure);
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not swap hosts for HTTP status errors', async () => {
    // 4xx/5xx 是源站行为，不是路径故障；换 host 只会掩盖真实的源站响应。
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('aborts a stalled connect phase at connectTimeoutMs and falls back to the alternate host', async () => {
    vi.useFakeTimers();
    // apex：fetch 永不 settle（连接挂起）；www：返回正常正文。
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(async () => new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchSourceText('https://book15.net/a', { ...options(), connectTimeoutMs: 3_000 });
    const assertion = expect(result).resolves.toEqual({ url: 'https://www.book15.net/a', text: '正文' });
    await vi.advanceTimersByTimeAsync(3_001);
    await assertion;
  });
});
