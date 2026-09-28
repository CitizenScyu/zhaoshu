import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth-client';

const oldUser = { id: 4, username: 'synthetic_old', role: 'member', canFind: true,
  canRead: true, canDownload: false, authMethod: 'session' };
const newUser = { ...oldUser, id: 8, username: 'synthetic_new' };
const json = (body: unknown) => Response.json(body);

function fixture() {
  const storage = {
    value: 'synthetic_legacy',
    read: () => storage.value,
    readSessionOnly: () => false,
    clear: vi.fn(() => { storage.value = ''; }),
    write: vi.fn((value: string) => { storage.value = value; }),
  };
  const notify = vi.fn();
  const instance = new AuthController({ origin: () => 'https://synthetic.invalid', storage, notify, requestTimeoutMs: 100 });
  const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => json({ user: newUser, accountsEnabled: true }));
  vi.stubGlobal('fetch', fetch);
  return { instance, storage, notify, fetch };
}

function pendingBody(status = 200) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { status });
  const read = vi.spyOn(response.body!, 'getReader');
  return {
    response, read,
    finish(body: unknown) { stream.enqueue(new TextEncoder().encode(JSON.stringify(body))); stream.close(); },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('认证操作的关闭与代际守卫', () => {
  const cases = (['login', 'owner', 'exchange', 'refresh'] as const)
    .flatMap(operation => (['close', 'restart', 'external'] as const).map(invalidation => ({ operation, invalidation })));

  it.each(cases)('$operation 读体中 $invalidation，迟到正文不应用旧身份或副作用', async ({ operation, invalidation }) => {
    const { instance, storage, notify, fetch } = fixture();
    if (operation === 'owner') {
      storage.value = '';
      fetch.mockResolvedValueOnce(json({ user: null, accountsEnabled: true }));
      await instance.start();
      storage.value = 'synthetic_legacy';
    }
    if (operation === 'exchange') fetch.mockResolvedValueOnce(json({ user: null, accountsEnabled: true }));
    const body = pendingBody();
    fetch.mockResolvedValueOnce(body.response);
    const pending = operation === 'login' ? instance.login('synthetic_old', 'synthetic_password', false)
      : operation === 'owner' ? instance.loginOwner('synthetic_owner', false) : instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(body.read).toHaveBeenCalledOnce();
    if (invalidation !== 'external') instance.close();
    const next = invalidation === 'restart' ? instance.start()
      : invalidation === 'external' ? instance.handleExternalChange() : Promise.resolve();
    const generation = instance.session.id;
    const closedState = instance.state;
    const observed: number[] = [];
    instance.subscribe(() => { if (instance.state.user) observed.push(instance.state.user.id); });
    body.finish({ user: oldUser, accountsEnabled: true });
    await pending;
    await next;
    expect(storage.write).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(observed).not.toContain(oldUser.id);
    if (invalidation === 'close') {
      expect(storage.clear).not.toHaveBeenCalled();
      expect(storage.value).toBe('synthetic_legacy');
      expect(instance.session.id).toBe(generation);
      expect(instance.state).toBe(closedState);
    } else {
      // 只有随后合法的会话探测清存储、旋转一次，不允许迟到登录先落地再被覆盖。
      expect(storage.clear).toHaveBeenCalledOnce();
      expect(instance.session.id).toBe(generation + 1);
      expect(instance.state.user?.id).toBe(newUser.id);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['legacy-owner', 'logout'] as const)('%s 等响应头期间关闭，不写存储或广播', async operation => {
    const { instance, storage, notify, fetch } = fixture();
    let resolve!: (response: Response) => void;
    fetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = operation === 'logout' ? instance.logout() : instance.loginOwner('synthetic_new_owner', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    instance.close();
    const generation = instance.session.id;
    resolve(json({ ok: true }));
    await pending;
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(instance.session.id).toBe(generation);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('关闭后旧登录错误正文不向新一轮操作报告失败，队列仍可恢复', async () => {
    const { instance, storage, notify, fetch } = fixture();
    const body = pendingBody(401);
    fetch.mockResolvedValueOnce(body.response);
    const pending = instance.login('synthetic_old', 'synthetic_password', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.read).toHaveBeenCalledOnce();
    instance.close();
    const restarted = instance.start();
    body.finish({ error: 'synthetic old rejection' });
    await expect(pending).resolves.toBeUndefined();
    await restarted;
    expect(instance.state.user?.id).toBe(newUser.id);
    expect(storage.clear).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it('旧自动兑换读体超时不能把重新启动的状态改成unavailable', async () => {
    const { instance, storage, notify, fetch } = fixture();
    fetch.mockResolvedValueOnce(json({ user: null, accountsEnabled: true }));
    const body = pendingBody();
    fetch.mockResolvedValueOnce(body.response);
    const start = instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(body.read).toHaveBeenCalledOnce();
    instance.close();
    const restarted = instance.start();
    const phases: string[] = [];
    instance.subscribe(() => phases.push(instance.state.phase));
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([start, restarted]);
    expect(phases).not.toContain('unavailable');
    expect(instance.state.user?.id).toBe(newUser.id);
    expect(storage.clear).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('关闭后未执行的本地操作与外部通知不产生存储或代际变化', async () => {
    const { instance, storage, notify, fetch } = fixture();
    instance.close();
    const generation = instance.session.id;
    await Promise.all([instance.login('synthetic', 'synthetic', false), instance.loginOwner('synthetic', false),
      instance.logout(), instance.refresh(), instance.handleExternalChange()]);
    instance.setLegacySessionOnly(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(instance.session.id).toBe(generation);
  });

  it('关闭并重启后，旧生命周期中排队但尚未开始的登录不再发送', async () => {
    const { instance, storage, notify, fetch } = fixture();
    const body = pendingBody();
    fetch.mockResolvedValueOnce(body.response);
    const start = instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(body.read).toHaveBeenCalledOnce();
    const oldLogin = instance.login('synthetic_old', 'synthetic_password', false);
    instance.close();
    const restarted = instance.start();
    body.finish({ user: oldUser, accountsEnabled: true });
    await Promise.all([start, oldLogin, restarted]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([request]) => new URL(request.url).pathname === '/api/auth/session')).toBe(true);
    expect(instance.state.user?.id).toBe(newUser.id);
    expect(storage.clear).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it('StrictMode同步start/close/start仅让新生命周期完成探测', async () => {
    const { instance, fetch } = fixture();
    const first = instance.start();
    instance.close();
    const second = instance.start();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(instance.state.user?.id).toBe(newUser.id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('合法排队的退出再登录仍按顺序执行，不被前一步rotate误取消', async () => {
    const { instance, fetch } = fixture();
    const logout = instance.logout();
    const login = instance.login('synthetic_new', 'synthetic_password', false);
    await Promise.all([logout, login]);
    expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname))
      .toEqual(['/api/auth/logout', '/api/auth/login']);
    expect(instance.state.user?.id).toBe(newUser.id);
  });

  it.each(['success', 'error', 'timeout'] as const)('读体%s后释放读锁，取消永不结束也不拖住超时', async outcome => {
    const { instance, fetch } = fixture();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = outcome === 'success' ? json({ user: newUser, accountsEnabled: true })
      : new Response(new ReadableStream({
        start(controller) { if (outcome === 'error') controller.error(new Error('synthetic stream failure')); },
        cancel,
      }));
    fetch.mockResolvedValueOnce(response);
    const start = instance.start();
    await vi.advanceTimersByTimeAsync(outcome === 'timeout' ? 100 : 0);
    await start;
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'timeout') expect(cancel).toHaveBeenCalledOnce();
  });
});
