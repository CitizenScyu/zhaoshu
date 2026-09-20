import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText, MAX_SOURCE_BYTES, SOURCE_CONNECT_TIMEOUT_MS, SOURCE_HOST_SWAP_DELAY_MS } from './source-fetch';

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
    // 首次总超时 → 换 host 退避 → 换 host 重试（新计时器）→ 第二次总超时；全部到点才算收敛。
    await vi.advanceTimersByTimeAsync(101);
    await vi.advanceTimersByTimeAsync(SOURCE_HOST_SWAP_DELAY_MS + 101);
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

  it('waits the host-swap backoff between the failed attempt and the retry', async () => {
    // www-review-2 P2-4：0ms 连打另一 host 只是撞同一抖动簇。fake timers 断言退避一拍。
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => { starts.push(Date.now()); throw transportFailure; })
      .mockImplementationOnce(async () => { starts.push(Date.now()); return new Response('正文'); });
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchSourceText('https://book15.net/a', options());
    const assertion = expect(result).resolves.toEqual({ url: 'https://www.book15.net/a', text: '正文' });
    await vi.advanceTimersByTimeAsync(SOURCE_HOST_SWAP_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledOnce(); // 退避未到，第二发还没发出
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(SOURCE_HOST_SWAP_DELAY_MS);
  });

  it('uses the 3s connect deadline without an explicit connectTimeoutMs', async () => {
    // 默认值钉子（两线审查同发现：变异 3s→300s 现有用例全绿）。不传 connectTimeoutMs，
    // 断言 3s 前不放弃、3s 整触发换 host。退避期间已越过 3s 边界，一次推进收敛。
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(async () => new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchSourceText('https://book15.net/a', options());
    const assertion = expect(result).resolves.toEqual({ url: 'https://www.book15.net/a', text: '正文' });
    await vi.advanceTimersByTimeAsync(SOURCE_CONNECT_TIMEOUT_MS - 1);
    expect(fetchMock).toHaveBeenCalledOnce(); // 默认 3s 未到，连接段还没超时
    await vi.advanceTimersByTimeAsync(SOURCE_HOST_SWAP_DELAY_MS + 1);
    await assertion;
  });

  it('does not swap hosts for decode errors', async () => {
    // 非法 UTF-8 的 TextDecoder TypeError：内容侧问题，两 host 同内容，换 host 注定再失败
    // （www-review-2 P2-2 的核心反例：兜底 instanceof Error 会放行为 4 次物理请求）。
    const badUtf8 = () => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      decoder.decode(new Uint8Array([0xff, 0xfe, 0xfd]));
      throw new TypeError('The encoded data is not valid.');
    };
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => { badUtf8(); return new Response('x'); })
      .mockImplementation(async () => new Response('x'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('not valid');
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it('parses Retry-After (seconds) into retryAfterMs on SourceHttpError', async () => {
    // 429 带 Retry-After 秒数 → SourceHttpError.retryAfterMs 供限速器尊重退避窗口。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '5' } })));
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toMatchObject({ status: 429, retryAfterMs: 5000 });
  });

  it('leaves retryAfterMs undefined when Retry-After absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    await fetchSourceText('https://book15.net/', options()).catch((e: { status: number; retryAfterMs?: number }) => {
      expect(e.status).toBe(429);
      expect(e.retryAfterMs).toBeUndefined();
    });
  });

  it('aborts a stalled connect phase at connectTimeoutMs and falls back to the alternate host', async () => {
    vi.useFakeTimers();
    // apex：fetch 永不 settle（连接挂起）；www：返回正常正文。显式传 3s 与默认用例互补。
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(async () => new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchSourceText('https://book15.net/a', { ...options(), connectTimeoutMs: 3_000 });
    const assertion = expect(result).resolves.toEqual({ url: 'https://www.book15.net/a', text: '正文' });
    await vi.advanceTimersByTimeAsync(3_000 + SOURCE_HOST_SWAP_DELAY_MS + 1);
    await assertion;
  });
});
