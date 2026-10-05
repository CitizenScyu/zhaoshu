// bphysical788 合成测试草稿（只写未跑）：beforeFetch 门支持 void|Promise<void> 的传输语义。
// 载体与口径沿用 source-fetch.test.ts：book15 传输语义用例把 isRetiredBuiltinHost 钉成 false
// （等价「book15 仍活跃」的注册表形态），聚焦传输层而非生命周期；全程 stub global fetch，不真联网。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText } from './source-fetch';
import { refreshSupportedHosts } from './source-policy';

const gate = vi.hoisted(() => ({ realRetiredGate: false }));
vi.mock('./supported-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supported-sources')>();
  return {
    ...actual,
    isRetiredBuiltinHost: (host: string) => (gate.realRetiredGate ? actual.isRetiredBuiltinHost(host) : false),
  };
});

afterEach(() => { vi.unstubAllGlobals(); refreshSupportedHosts([]); });
const options = () => ({ signal: new AbortController().signal });
const transportFailure = new TypeError('fetch failed');

describe('beforeFetch 物理门支持异步（bphysical788）', () => {
  it('异步门 resolve 后才发射；门逐物理发射按 current URL 调用', async () => {
    const gateCalls: string[] = [];
    const beforeFetch = vi.fn(async (_signal: AbortSignal, current: string) => { gateCalls.push(current); });
    const fetchMock = vi.fn().mockResolvedValue(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://book15.net/a', { ...options(), beforeFetch }))
      .toEqual({ url: 'https://book15.net/a', text: '正文' });
    expect(beforeFetch).toHaveBeenCalledOnce();
    expect(gateCalls).toEqual(['https://book15.net/a']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('302 跳转后的新 current 也过物理门：两次发射两次门，参数为各自 current', async () => {
    refreshSupportedHosts(['e1.test', 'e2.test']);
    const gateCalls: string[] = [];
    const beforeFetch = vi.fn(async (_signal: AbortSignal, current: string) => { gateCalls.push(current); });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://e2.test/next' } }))
      .mockResolvedValueOnce(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://e1.test/start', { ...options(), beforeFetch }))
      .toEqual({ url: 'https://e2.test/next', text: '正文' });
    expect(gateCalls).toEqual(['https://e1.test/start', 'https://e2.test/next']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('传输失败换备用 host：两次发射两次门，换 host 后的 current 是备用 host', async () => {
    const gateCalls: string[] = [];
    const beforeFetch = vi.fn(async (_signal: AbortSignal, current: string) => { gateCalls.push(current); });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://book15.net/books/details1.html', { ...options(), beforeFetch }))
      .toEqual({ url: 'https://www.book15.net/books/details1.html', text: '正文' });
    expect(gateCalls).toEqual(['https://book15.net/books/details1.html', 'https://www.book15.net/books/details1.html']);
  });

  it('异步物理门拒绝：零 fetch、标 fromBeforeRequest、不触发换 host 重试', async () => {
    const policyStop = Object.assign(new Error('physical gate refused'), { fromBeforeRequest: undefined as boolean | undefined });
    const beforeFetch = vi.fn(async () => { throw policyStop; });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/a', { ...options(), beforeFetch })).rejects.toBe(policyStop);
    expect(fetchMock).not.toHaveBeenCalled(); // 拒绝后不发射，也无备用 host 第二发
    expect((policyStop as { fromBeforeRequest?: boolean }).fromBeforeRequest).toBe(true);
  });

  it('await 期间父 signal 中止：门以 signal 拒绝，不发射 fetch', async () => {
    // 模拟真实限速器的合同：acquire 收 signal，中止即拒绝（不悬挂）。
    const controller = new AbortController();
    const beforeFetch = vi.fn((signal: AbortSignal, _current: string) => new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchSourceText('https://book15.net/a', { signal: controller.signal, beforeFetch });
    queueMicrotask(() => controller.abort(new Error('cancelled')));
    await expect(pending).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
    // 门被中止拒绝时不改判为传输失败：无第二次 fetch（不换 host）。
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('门 resolve 但等待期间父 signal 已中止：门后中止复查拦下，仍不发射 fetch', async () => {
    // 限速器未必严格看 signal（实现差异）：门可能正常 resolve。门后的 throwIfAborted 是兜底。
    const controller = new AbortController();
    const beforeFetch = vi.fn(async () => { controller.abort(new Error('late cancel')); });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/a', { signal: controller.signal, beforeFetch }))
      .rejects.toThrow('late cancel');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('同步旧门兼容：同步 beforeFetch 照常拦截每次物理发射', async () => {
    const gateCalls: string[] = [];
    const beforeFetch = vi.fn((_signal: AbortSignal, current: string) => { gateCalls.push(current); });
    const fetchMock = vi.fn().mockResolvedValue(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://book15.net/a', { ...options(), beforeFetch }))
      .toEqual({ url: 'https://book15.net/a', text: '正文' });
    expect(gateCalls).toEqual(['https://book15.net/a']);
  });
});
