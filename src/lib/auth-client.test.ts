import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthController,
  AuthError,
  hasPermission,
  parseAuthUser,
  safeReturnPath,
} from './auth-client';
import type { AuthUser, LegacyTokenStore } from './auth-client';

const ORIGIN = 'https://books.example';

function store(initial = '', sessionOnly = false): LegacyTokenStore & { value: string; sessionOnly: boolean; cleared: number } {
  const state = {
    value: initial,
    sessionOnly,
    cleared: 0,
    read: () => state.value,
    readSessionOnly: () => state.sessionOnly,
    write: (token: string, only: boolean) => { state.value = token; state.sessionOnly = only; },
    clear: () => { state.value = ''; state.sessionOnly = false; state.cleared += 1; },
  };
  return state;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MEMBER: AuthUser = {
  id: 4, username: 'reader', role: 'member',
  canFind: true, canRead: true, canDownload: false, authMethod: 'session',
};

const OWNER: AuthUser = {
  id: 1, username: 'owner', role: 'owner',
  canFind: true, canRead: true, canDownload: true, authMethod: 'session',
};

type Handler = (request: Request) => Response | Promise<Response>;

function stubFetch(handlers: Record<string, Handler>) {
  const calls: { url: string; method: string; request: Request }[] = [];
  const transport = vi.fn(async (input: Request) => {
    const url = new URL(input.url);
    const key = `${input.method} ${url.pathname}`;
    calls.push({ url: url.pathname, method: input.method, request: input });
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(input);
  });
  vi.stubGlobal('fetch', transport);
  return calls;
}

function controller(options: { stored?: string; sessionOnly?: boolean; notify?: () => void } = {}) {
  const tokens = store(options.stored ?? '', options.sessionOnly ?? false);
  const instance = new AuthController({
    origin: () => ORIGIN,
    storage: tokens,
    notify: options.notify,
  });
  return { instance, tokens };
}

afterEach(() => vi.unstubAllGlobals());

describe('safeReturnPath', () => {
  it.each(['/read/12', '/?tab=shelf', '/login?returnTo=%2Fread%2F1', '/a/b#c'])('accepts in-site path %s', (value) => {
    expect(safeReturnPath(value)).toBe(value);
  });

  it.each([
    null, undefined, '', 'https://outside.example/read', '//outside.example/read',
    '/\\outside.example', '/a\\b', 'javascript:alert(1)', 'read/1',
    '/%2F%2Foutside.example',
  ])('rejects unsafe return target %s', (value) => {
    expect(safeReturnPath(value as string | null)).toBeNull();
  });

  // 回归：`new URL` 会把 `/..//evil.com` 规范化成协议相对 URL `//evil.com`，
  // 旧的「只查输入」实现会把它当作合法返回值，浏览器据此跳到 https://evil.com/。
  it.each([
    '//evil.com',
    '/..//evil.com',
    '/a/..//evil.com',
    '/..//evil.com/x',
    '/..//evil.com?x=1',
    '/a/../..//evil.com',
  ])('rejects normalization bypass %s', (value) => {
    expect(safeReturnPath(value)).toBeNull();
  });

  // 判别力核心：函数必须是不动点。只查输入的实现在这里必然失败
  // （f('/..//evil.com') === '//evil.com'，而 f('//evil.com') === null）。
  it('is a fixed point: f(f(x)) === f(x) for every corpus input', () => {
    const corpus = [
      '/read/12', '/?tab=shelf', '/login?returnTo=%2Fread%2F1', '/a/b#c', '/',
      '//evil.com', '/..//evil.com', '/a/..//evil.com', '/..//evil.com/x',
      '/..//evil.com?x=1', '/a/../..//evil.com', '/%2F%2Foutside.example',
      '/..%2F%2Fevil.com', 'https://outside.example/read', '/\\outside.example',
      '/a\\b', 'read/1', '', null, undefined,
    ];
    for (const value of corpus) {
      const once = safeReturnPath(value as string | null);
      const twice = once === null ? null : safeReturnPath(once);
      expect(twice, `f(f(${JSON.stringify(value)})) must equal f(...)`).toBe(once);
    }
  });

  it('never returns a protocol-relative, backslash or control-character target', () => {
    const corpus = [
      '/..//evil.com', '/a/..//evil.com', '/..//evil.com/x', '/..//evil.com?x=1',
      '/a/../..//evil.com', '/.', '/..', '/...//x', '/%2e%2e//evil.com',
      '/foo/../../..//evil.com', '/read/12', '/?tab=shelf', '/a/b#c', '//evil.com',
    ];
    for (const value of corpus) {
      const out = safeReturnPath(value);
      if (out === null) continue;
      expect(out.startsWith('/') && !out.startsWith('//'), `unsafe output for ${JSON.stringify(value)}: ${JSON.stringify(out)}`).toBe(true);
      expect(/[\\\x00-\x1f\x7f]/.test(out)).toBe(false);
    }
  });
});

describe('auth helpers', () => {
  it('maps permissions from the effective capability flags', () => {
    expect(hasPermission(null, 'find')).toBe(false);
    expect(hasPermission({ ...MEMBER, canFind: false, canRead: false, canDownload: false }, 'find')).toBe(false);
    expect(hasPermission(MEMBER, 'read')).toBe(true);
    expect(hasPermission(MEMBER, 'download')).toBe(false);
  });

  it.each([
    null, {}, { ...MEMBER, role: 'admin' }, { ...MEMBER, id: 0 }, { ...MEMBER, id: 1.5 },
    { ...MEMBER, username: '' }, { ...MEMBER, canRead: 'yes' }, { ...MEMBER, authMethod: 'cookie' },
  ])('refuses to treat malformed session user %s as an identity', (value) => {
    expect(parseAuthUser(value)).toBeNull();
  });
});

describe('AuthController dual mode', () => {
  it('keeps the legacy owner flow when the deployment switch is off', async () => {
    const calls = stubFetch({
      'GET /api/auth/session': () => json(200, { user: null, accountsEnabled: false }),
    });
    const { instance, tokens } = controller({ stored: 'legacy-owner' });
    await instance.start();
    expect(instance.state).toMatchObject({ phase: 'authenticated', accountsEnabled: false, transport: 'owner-header' });
    expect(instance.state.user).toMatchObject({ id: 1, role: 'owner', authMethod: 'owner-header' });
    // 旧模式不发兑换请求，也不清掉本机口令。
    expect(calls.map((call) => call.url)).toEqual(['/api/auth/session']);
    expect(tokens.value).toBe('legacy-owner');
  });

  it('keeps the legacy flow anonymous when nothing is stored', async () => {
    stubFetch({ 'GET /api/auth/session': () => json(200, { user: null, accountsEnabled: false }) });
    const { instance } = controller();
    await instance.start();
    expect(instance.state).toMatchObject({ phase: 'anonymous', user: null, accountsEnabled: false });
  });

  it('lets a valid cookie win and clears the stored legacy token', async () => {
    const calls = stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
    });
    const { instance, tokens } = controller({ stored: 'legacy-owner' });
    await instance.start();
    expect(instance.state).toMatchObject({ phase: 'authenticated', transport: 'cookie' });
    expect(instance.state.user).toMatchObject({ id: 4, role: 'member' });
    expect(tokens.value).toBe('');
    expect(calls).toHaveLength(1);
  });

  it('exchanges a stored legacy token once the accounts mode is on', async () => {
    const notify = vi.fn();
    const calls = stubFetch({
      'GET /api/auth/session': () => json(200, { user: null, accountsEnabled: true }),
      'POST /api/auth/owner': () => json(200, { user: OWNER }),
    });
    const { instance, tokens } = controller({ stored: 'legacy-owner', notify });
    await instance.start();
    expect(instance.state).toMatchObject({ phase: 'authenticated', transport: 'cookie', accountsEnabled: true });
    expect(instance.state.user).toMatchObject({ id: 1, role: 'owner', authMethod: 'session' });
    expect(tokens.value).toBe('');
    expect(notify).toHaveBeenCalled();
    const exchange = calls.find((call) => call.url === '/api/auth/owner');
    expect(exchange?.request.headers.get('X-NF-CSRF')).toBe('1');
    expect(exchange?.request.headers.has('Authorization')).toBe(false);
    expect(await exchange?.request.json()).toEqual({ token: 'legacy-owner', remember: false });
  });

  it('does not exchange or clear the stored token when the exchange is rejected', async () => {
    stubFetch({
      'GET /api/auth/session': () => json(200, { user: null, accountsEnabled: true }),
      'POST /api/auth/owner': () => json(401, { error: 'invalid owner token', code: 'INVALID_CREDENTIALS' }),
    });
    const { instance, tokens } = controller({ stored: 'wrong-owner' });
    await instance.start();
    expect(instance.state).toMatchObject({ phase: 'anonymous', user: null, expired: false });
    expect(tokens.value).toBe('wrong-owner');
  });

  it('does not auto-exchange on a cookie 401 and does not lose the stored token', async () => {
    const calls = stubFetch({ 'GET /api/auth/session': () => json(401, { code: 'UNAUTHORIZED' }) });
    const { instance, tokens } = controller({ stored: 'legacy-owner' });
    await instance.start();
    expect(instance.state).toMatchObject({ phase: 'anonymous', expired: true });
    expect(calls.map((call) => call.url)).toEqual(['/api/auth/session']);
    expect(tokens.value).toBe('legacy-owner');
  });

  it('locks the interface and keeps the stored token when the session service fails', async () => {
    stubFetch({ 'GET /api/auth/session': () => json(503, { code: 'AUTH_DB_UNAVAILABLE' }) });
    const { instance, tokens } = controller({ stored: 'legacy-owner' });
    await instance.start();
    expect(instance.state.phase).toBe('unavailable');
    expect(tokens.value).toBe('legacy-owner');
  });

  it('treats an unreachable session endpoint as unavailable instead of logged out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    const { instance, tokens } = controller({ stored: 'legacy-owner' });
    await instance.start();
    expect(instance.state.phase).toBe('unavailable');
    expect(tokens.value).toBe('legacy-owner');
  });

  it('logs a member in, clears legacy storage and rotates the generation', async () => {
    const notify = vi.fn();
    const calls = stubFetch({
      'GET /api/auth/session': () => json(200, { user: null, accountsEnabled: true }),
      'POST /api/auth/login': () => json(200, { user: MEMBER }),
    });
    const { instance, tokens } = controller({ stored: 'legacy-owner', notify });
    await instance.start();
    const before = instance.state.generation;
    await instance.login('Reader', 'secret', true);
    expect(instance.state).toMatchObject({ phase: 'authenticated', transport: 'cookie' });
    expect(instance.state.user).toMatchObject({ id: 4, username: 'reader' });
    expect(instance.state.generation).toBeGreaterThan(before);
    expect(tokens.value).toBe('');
    expect(notify).toHaveBeenCalled();
    const login = calls.find((call) => call.url === '/api/auth/login');
    expect(await login?.request.json()).toEqual({ username: 'reader', password: 'secret', remember: true });
  });

  it('surfaces login failures without changing the identity', async () => {
    stubFetch({
      'GET /api/auth/session': () => json(200, { user: null, accountsEnabled: true }),
      'POST /api/auth/login': () => json(401, { error: 'invalid username or password', code: 'INVALID_CREDENTIALS' }),
    });
    const { instance } = controller();
    await instance.start();
    const before = instance.state;
    await expect(instance.login('reader', 'wrong', false)).rejects.toBeInstanceOf(AuthError);
    expect(instance.state).toEqual(before);
  });

  it('revokes the server session and clears the generation on logout', async () => {
    const calls = stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
      'POST /api/auth/logout': () => json(200, { ok: true }),
    });
    const { instance } = controller();
    await instance.start();
    const before = instance.state.generation;
    await instance.logout();
    expect(instance.state).toMatchObject({ phase: 'anonymous', user: null });
    expect(instance.state.generation).toBeGreaterThan(before);
    expect(calls.filter((call) => call.url === '/api/auth/logout')).toHaveLength(1);
  });

  it('does not pretend the logout succeeded when the server revoke fails', async () => {
    stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
      'POST /api/auth/logout': () => json(503, { code: 'LOGOUT_INCOMPLETE' }),
    });
    const { instance } = controller();
    await instance.start();
    const before = instance.state;
    await expect(instance.logout()).rejects.toBeInstanceOf(AuthError);
    expect(instance.state).toEqual(before);
  });

  it('keeps the legacy logout local instead of calling the revoked endpoint', async () => {
    const calls = stubFetch({ 'GET /api/auth/session': () => json(200, { user: null, accountsEnabled: false }) });
    const { instance, tokens } = controller({ stored: 'legacy-owner' });
    await instance.start();
    await instance.logout();
    expect(instance.state.phase).toBe('anonymous');
    expect(tokens.value).toBe('');
    expect(calls).toHaveLength(1);
  });

  it('serializes a late login behind a logout so it cannot restore the old session', async () => {
    let releaseLogin!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLogin = resolve; });
    stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
      'POST /api/auth/login': async () => { await gate; return json(200, { user: { ...MEMBER, id: 9, username: 'late' } }); },
      'POST /api/auth/logout': () => json(200, { ok: true }),
    });
    const { instance } = controller();
    await instance.start();
    const pending = instance.login('late', 'secret', false);
    const logout = instance.logout();
    releaseLogin();
    await pending;
    await logout;
    // 迟到的登录结果被串行的退出覆盖，界面不会恢复登录态。
    expect(instance.state).toMatchObject({ phase: 'anonymous', user: null });
  });

  it('re-queries the session after an unexpected 401 from a business request', async () => {
    let sessionCalls = 0;
    stubFetch({
      'GET /api/auth/session': () => {
        sessionCalls += 1;
        return json(200, sessionCalls === 1 ? { user: MEMBER, accountsEnabled: true } : { user: null, accountsEnabled: true });
      },
      'GET /api/profile': () => json(401, { code: 'UNAUTHORIZED' }),
    });
    const { instance } = controller();
    await instance.start();
    await instance.fetch('/api/profile');
    await vi.waitFor(() => expect(instance.state.phase).toBe('anonymous'));
    expect(sessionCalls).toBe(2);
  });

  it('stops stale generations from entering the next identity', async () => {
    stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
      'POST /api/auth/logout': () => json(200, { ok: true }),
      'POST /api/auth/login': () => json(200, { user: { ...MEMBER, id: 7, username: 'second' } }),
    });
    const { instance } = controller();
    await instance.start();
    const firstGeneration = instance.session;
    const staleFetch = (url: string) => firstGeneration.fetch(url, {}, ORIGIN);
    await instance.logout();
    await instance.login('second', 'secret', false);
    await expect(staleFetch('/api/profile')).rejects.toMatchObject({ name: 'AbortError' });
    expect(instance.state.user).toMatchObject({ id: 7 });
  });
});

describe('H02 semantics in cookie mode', () => {
  it('clears Authorization and relies on the same-origin cookie', async () => {
    const calls = stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
      'GET /api/profile': () => json(200, { ok: true }),
    });
    const { instance } = controller({ stored: 'legacy-owner' });
    await instance.start();
    await instance.fetch('/api/profile', { headers: { Authorization: 'Bearer stale', 'x-owner-token': 'stale' } });
    const request = calls.find((call) => call.url === '/api/profile')?.request;
    expect(request?.headers.has('Authorization')).toBe(false);
    expect(request?.headers.has('x-owner-token')).toBe(false);
    expect(request?.credentials).toBe('same-origin');
  });

  it('aborts a stale closure before it can start the next step', async () => {
    const transport = vi.fn(async () => json(200, { candidates: [] }));
    vi.stubGlobal('fetch', transport);
    const { instance } = controller();
    const generation = instance.session;
    generation.close();
    await expect(generation.fetch('/api/find', { method: 'POST' }, ORIGIN)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('cancels the body of a response that arrives after the generation closed', async () => {
    let resolve!: (value: Response) => void;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((accept) => { resolve = accept; })));
    const { instance } = controller();
    const generation = instance.session;
    const pending = generation.fetch('/api/profile', {}, ORIGIN);
    generation.close();
    resolve(new Response(new ReadableStream({ cancel })));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps cancelling a body stream that already received headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => new Response(new ReadableStream({
      start(controller) {
        request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
      },
    }))));
    const { instance } = controller();
    const generation = instance.session;
    const response = await generation.fetch('/api/read/1/chapter', {}, ORIGIN);
    const text = response.text();
    generation.close();
    await expect(text).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not end the login session when a single caller cancels its own request', async () => {
    stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
      'GET /api/stats': () => json(200, { ok: true }),
    });
    const { instance } = controller();
    await instance.start();
    const caller = new AbortController();
    caller.abort();
    await expect(instance.fetch('/api/stats', { signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await instance.fetch('/api/stats')).status).toBe(200);
    expect(instance.state).toMatchObject({ phase: 'authenticated' });
  });

  it('allows reauthentication with the same account using a new generation', async () => {
    stubFetch({
      'GET /api/auth/session': () => json(200, { user: MEMBER, accountsEnabled: true }),
      'POST /api/auth/logout': () => json(200, { ok: true }),
      'POST /api/auth/login': () => json(200, { user: MEMBER }),
      'GET /api/profile': () => json(200, { ok: true }),
    });
    const { instance } = controller();
    await instance.start();
    const retired = instance.session;
    await instance.logout();
    await instance.login('reader', 'secret', false);
    await expect(retired.fetch('/api/profile', {}, ORIGIN)).rejects.toMatchObject({ name: 'AbortError' });
    expect((await instance.fetch('/api/profile')).status).toBe(200);
  });
});
