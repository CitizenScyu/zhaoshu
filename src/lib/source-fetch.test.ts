import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText, MAX_SOURCE_BYTES, SOURCE_CONNECT_TIMEOUT_MS, SOURCE_HOST_SWAP_DELAY_MS } from './source-fetch';
import { refreshSupportedHosts, SourcePolicyError, validateSourceUrl } from './source-policy';
import { isRetiredBuiltinHost } from './supported-sources';

// request640 起 source-fetch 有退休 builtin 请求许可门，真实注册表里 book15 lifecycle='retired'。
// 本文件两组用例对注册表的诉求不同：
// - 上方两组传输语义用例（重定向/超时/换 host 兜底）以 book15 为载体，测的是传输层而非生命周期——
//   这里把 isRetiredBuiltinHost 钉成 false（等价于「book15 仍活跃」的注册表形态），保持聚焦；
// - 下方「退休 builtin 请求许可门」组恢复真实判定（beforeEach 打开开关），只换这一处行为。
const gate = vi.hoisted(() => ({ realRetiredGate: false }));
vi.mock('./supported-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supported-sources')>();
  return {
    ...actual,
    isRetiredBuiltinHost: (host: string) => (gate.realRetiredGate ? actual.isRetiredBuiltinHost(host) : false),
  };
});

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

// request640：退休 builtin 的中央请求许可门。gate.realRetiredGate 打开后走真实注册表判定
// （book15 lifecycle='retired'，识别仍在）；「活跃合成目标」用 refreshSupportedHosts 注入
// e1.test（非 builtin 注册表 host，isRetiredBuiltinHost=false ⇒ 不拦），走真实 transport 路径。
describe('退休 builtin 请求许可门（request640）', () => {
  beforeEach(() => { gate.realRetiredGate = true; });
  afterEach(() => { gate.realRetiredGate = false; refreshSupportedHosts([]); });

  it.each([
    'https://book15.net/books/1.html', // apex
    'https://www.book15.net/books/1.html', // www 别名
  ])('初始目标为退休 host：%s 零物理请求即拒', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn().mockResolvedValue(undefined);
    await expect(fetchSourceText(url, { ...options(), beforeRequest })).rejects.toThrow('已退休');
    expect(fetchMock).not.toHaveBeenCalled(); // 0 次物理 fetch
    expect(beforeRequest).not.toHaveBeenCalled(); // 也没烧预算点数
    expect(isRetiredBuiltinHost(new URL(url).hostname)).toBe(true); // 用例前提自证
  });

  it('尾点根形态 https://book15.net./ ：静态门先行拒绝，同样零物理请求', async () => {
    // 尾点 host 不在运行时白名单的规范 hostname 形态里，validateSourceUrl 先拒
    // （即便 URL 解析器保留尾点放它过 host 门，退休门也认：normalizeBuiltinHost 尾点归一同判）。
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net./books/1.html', options())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isRetiredBuiltinHost('book15.net.')).toBe(true); // 注册表侧尾点归一仍判退休
  });

  it('活跃合成目标正常放行（非 builtin 注册表 host 不受退休门影响）', async () => {
    // 行为断言（85ba55f 阻断项修复的钉子）：活跃绝对 URL 必须到达 mock fetch，而非在
    // 退休门里因参数形态错误抛 Invalid URL TypeError。
    refreshSupportedHosts(['e1.test']);
    const fetchMock = vi.fn().mockResolvedValue(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://e1.test/a', options())).toEqual({ url: 'https://e1.test/a', text: '正文' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://e1.test/a'); // 真实物理发射了这一发
  });

  it.each(['https://book15.net/a', 'https://www.book15.net/a'])('退休变体 %s 拒为 SourcePolicyError 而非 TypeError', async (url) => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(fetchSourceText(url, options())).rejects.toBeInstanceOf(SourcePolicyError);
  });

  it('活跃请求被 302 跳向退休 host：仅第一次 fetch 发出，第二次发射前被拒', async () => {
    refreshSupportedHosts(['e1.test']);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://book15.net/retired.html' } }))
      .mockResolvedValue(new Response('不该到达'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://e1.test/a', options())).rejects.toThrow('已退休');
    expect(fetchMock).toHaveBeenCalledOnce(); // e1.test 一发；退休跳转目标零发射
  });

  it('退休拒绝是策略拒绝：不触发换 host 兜底（apex 退休 www 同退休）', async () => {
    // 若被误判为传输错误，fetchWithHostSwap 会退避后打 www.book15.net 第二发——用 fake timers
    // 推满退避窗口，断言仍零物理请求。
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchSourceText('https://book15.net/a', options());
    const assertion = expect(pending).rejects.toThrow('已退休');
    await vi.advanceTimersByTimeAsync(SOURCE_HOST_SWAP_DELAY_MS * 2);
    await assertion;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('通用旧 URL 识别仍可用：validateSourceUrl 照常认得退休 host（识别 ≠ 许可）', () => {
    expect(validateSourceUrl('https://book15.net/books/1.html').hostname).toBe('book15.net');
    expect(validateSourceUrl('/x', 'https://www.book15.net/base').href).toBe('https://www.book15.net/x');
  });
});
