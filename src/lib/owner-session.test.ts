import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerSession } from './owner-session';

const origin = 'https://books.example';
describe('owner credential generations', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prevents a delayed pipeline from starting its next step with retired credentials', async () => {
    const transport = vi.fn(async () => Response.json({ candidates: [] }));
    vi.stubGlobal('fetch', transport);
    const session = new OwnerSession('token', 1);
    const apiFetch = (url: string) => session.fetch(url, {}, origin);
    await apiFetch('/api/find');
    session.close();
    await expect(apiFetch('/api/find')).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('aborts all requests still in flight when the owner logs out', async () => {
    vi.stubGlobal('fetch', vi.fn((request: Request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    })));
    const session = new OwnerSession('token', 1);
    const results = Promise.allSettled([session.fetch('/api/find', {}, origin), session.fetch('/api/profile', {}, origin)]);
    session.close();
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) },
      { status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) },
    ]);
  });

  it('discards a late response even if a transport ignores cancellation', async () => {
    let resolve!: (value: Response) => void;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(accept => { resolve = accept; })));
    const session = new OwnerSession('token', 1);
    const result = session.fetch('/api/find', {}, origin);
    session.close();
    resolve(new Response(new ReadableStream({ cancel })));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('allows reauthentication with the same token using a new generation', async () => {
    const transport = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', transport);
    const old = new OwnerSession('token', 1);
    old.close();
    const current = new OwnerSession('token', 2);
    await expect(old.fetch('/api/read/1/index', {}, origin)).rejects.toMatchObject({ name: 'AbortError' });
    expect((await current.fetch('/api/read/1/index', {}, origin)).status).toBe(200);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('retains request-body cancellation after response headers arrive', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => new Response(new ReadableStream({
      start(controller) { request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true }); },
    }))));
    const session = new OwnerSession('token', 1);
    const response = await session.fetch('/api/read/1/chapter', {}, origin);
    const text = response.text();
    session.close();
    await expect(text).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not end the owner session when an individual caller cancels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const session = new OwnerSession('token', 1);
    const caller = new AbortController(); caller.abort();
    await expect(session.fetch('/api/read/1/index', { signal: caller.signal }, origin)).rejects.toMatchObject({ name: 'AbortError' });
    expect((await session.fetch('/api/stats', {}, origin)).status).toBe(200);
  });

  it('carries the cookie transport without attaching a legacy token', async () => {
    const transport = vi.fn(async (request: Request) => Response.json({ url: request.url }));
    vi.stubGlobal('fetch', transport);
    const session = new OwnerSession('', 1, 'cookie');
    await session.fetch('/api/profile', { headers: { Authorization: 'Bearer stale' } }, origin);
    const request = transport.mock.calls[0][0];
    expect(request.headers.has('Authorization')).toBe(false);
    expect(request.headers.has('x-owner-token')).toBe(false);
    expect(request.credentials).toBe('same-origin');
  });

  it.each(['owner-header', 'cookie'] as const)('applies the H02 generation rules to the %s transport', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const session = new OwnerSession(kind === 'cookie' ? '' : 'token', 1, kind);
    session.close();
    await expect(session.fetch('/api/find', { method: 'POST' }, origin)).rejects.toMatchObject({ name: 'AbortError' });
  });
  // 会话关闭会把中止信号转发给所有在飞请求。合并信号必须在中止时摘掉挂在代际
  // controller.signal 上的监听,否则每次代际轮换都要在它上面留一个悬空 listener。
  it('leaves no abort listeners behind after the session closes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const session = new OwnerSession('token', 1);
    // 直接数挂在这个具体 signal 上的监听:被中止的 signal 不能再 addEventListener,
    // 所以替换实例方法而不是打 AbortSignal.prototype 的 spy。
    // controller 是 private;测试只看 listener 计数,用断言取它,不改生产可见性。
    const signal = (session as unknown as { controller: AbortController }).controller.signal;
    let adds = 0;
    let removes = 0;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { adds += 1; return realAdd(...args); };
    signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removes += 1; return realRemove(...args); };
    await session.fetch('/api/find', {}, origin);
    expect(adds).toBe(1);
    session.close();
    expect(removes).toBe(adds);
  });
});
