import { createOwnerRequest } from './owner-request';
import { OwnerSession } from './owner-session';
import type { AuthTransport } from './owner-request';

export type Permission = 'find' | 'read' | 'download';

/** 服务端 §5.3 `/api/auth/session` 的最小用户信息；绝不包含 token / hash。 */
export interface AuthUser {
  id: number;
  username: string;
  role: 'owner' | 'member';
  canFind: boolean;
  canRead: boolean;
  canDownload: boolean;
  authMethod: 'owner-header' | 'session';
}

export type AuthPhase = 'loading' | 'anonymous' | 'authenticated' | 'unavailable';

export interface AuthState {
  phase: AuthPhase;
  user: AuthUser | null;
  /** 部署开关 AUTH_ACCOUNTS_ENABLED；仅用于选择登录流程，不是秘密。 */
  accountsEnabled: boolean;
  transport: AuthTransport;
  /** 旧模式下“仅本次会话保存”的当前取值。 */
  sessionOnly: boolean;
  /** 最近一次会话探测明确返回 401；只作提示，不代表已切换身份。 */
  expired: boolean;
  /** 前端请求代际；数据库 session token 永远不进这个字段。 */
  generation: number;
}

export interface LegacyTokenStore {
  read(): string;
  /** 当前保存的口令是否只在 sessionStorage（“仅本次会话保存”）。 */
  readSessionOnly(): boolean;
  write(token: string, sessionOnly: boolean): void;
  clear(): void;
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const SESSION_TIMEOUT_MS = 15_000;
const DEFAULT_PHASE: AuthPhase = 'loading';

const OWNER_USER: AuthUser = {
  id: 1,
  username: 'owner',
  role: 'owner',
  canFind: true,
  canRead: true,
  canDownload: true,
  authMethod: 'owner-header',
};

export function hasPermission(user: AuthUser | null, permission: Permission): boolean {
  if (!user) return false;
  if (permission === 'find') return user.canFind;
  if (permission === 'read') return user.canRead;
  return user.canDownload;
}

/** 防御式解析：任一字段类型不符就当没有身份，未知角色默认拒绝。 */
export function parseAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const role = record.role;
  if (role !== 'owner' && role !== 'member') return null;
  if (record.authMethod !== 'session' && record.authMethod !== 'owner-header') return null;
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id < 1) return null;
  if (typeof record.username !== 'string' || !record.username) return null;
  if (typeof record.canFind !== 'boolean' || typeof record.canRead !== 'boolean'
    || typeof record.canDownload !== 'boolean') return null;
  return {
    id: record.id,
    username: record.username,
    role,
    canFind: record.canFind,
    canRead: record.canRead,
    canDownload: record.canDownload,
    authMethod: record.authMethod,
  };
}

/**
 * 单次净化：只接受同源站内相对路径；拒绝 `//`、反斜杠、控制字符和外站跳转。
 * 返回 `new URL` 规范化后的站内路径，或 null。
 */
function normalizeReturnPathOnce(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\\\x00-\x1f\x7f]/.test(value)) return null;
  // 解码一次后再判断：`/%2F%2Foutside.example` 这类目标可能被下游再解码成外站。
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.startsWith('/\\')) return null;
  if (/[\\\x00-\x1f\x7f]/.test(decoded)) return null;
  try {
    const url = new URL(value, 'https://internal.invalid');
    if (url.origin !== 'https://internal.invalid') return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/**
 * 深链返回路径：在单次净化的基础上强制**不动点**——净化产物必须能再次通过同一
 * 套校验，否则拒绝。`new URL` 会把 `/..//evil.com` 规范化成 `//evil.com`
 * （协议相对 URL，浏览器解析成外站），因此只校验「输入」不够，必须校验「输出」。
 * 这样保证任意输入下返回值都以单个 `/` 开头，绝不产出 `//` 或反斜杠。
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  const normalized = normalizeReturnPathOnce(value);
  if (normalized === null) return null;
  // f(f(x)) === f(x)：产物必须是不动点，否则它自己会被本函数拒绝。
  return normalizeReturnPathOnce(normalized) === normalized ? normalized : null;
}

export interface AuthControllerOptions {
  /** 惰性取同源 origin：SSR 期间没有 window，构造不能依赖它。 */
  origin: () => string;
  storage: LegacyTokenStore;
  /** 跨标签广播“认证已变化”，只送非秘密通知。 */
  notify?: () => void;
}

/**
 * §6.2–6.3 的双模式客户端状态机：Cookie 优先、旧口令兑换、代际取消。
 * 只依赖 fetch / AbortController，可在 node 环境直接单测。
 */
export class AuthController {
  private stateValue: AuthState = {
    phase: DEFAULT_PHASE,
    user: null,
    accountsEnabled: false,
    transport: 'cookie',
    sessionOnly: false,
    expired: false,
    generation: 0,
  };
  private sessionValue: OwnerSession;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private notifyHandler: (() => void) | null;
  private closed = false;

  constructor(private readonly options: AuthControllerOptions) {
    this.sessionValue = new OwnerSession('', 0, 'cookie');
    this.notifyHandler = options.notify ?? null;
  }

  /** 由 React 层在订阅时挂上跨标签广播；避免把 ref 传进构造函数。 */
  setNotify(handler: (() => void) | null): void {
    this.notifyHandler = handler;
  }

  private broadcast(): void {
    this.notifyHandler?.();
  }

  get state(): AuthState {
    return this.stateValue;
  }

  /** 当前代际：所有业务请求都必须经它，旧闭包拿到的是已 close 的实例。 */
  get session(): OwnerSession {
    return this.sessionValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async start(): Promise<void> {
    this.closed = false;
    return this.refresh('start');
  }

  /** 中止当前代际；React Strict Mode 重放后 start() 会重新建立代际。 */
  close(): void {
    this.closed = true;
    this.rotate(this.stateValue.transport, this.sessionValue.transport === 'owner-header' ? this.sessionValue.token : '');
  }

  /**
   * 收到跨标签“认证已变化”：先关闭当前代际，再重新查 session。
   * 迟到响应因此进不了新代际。
   */
  async handleExternalChange(): Promise<void> {
    this.rotate(this.stateValue.transport, this.sessionValue.transport === 'owner-header' ? this.sessionValue.token : '');
    await this.refresh('broadcast');
  }

  /** 关闭旧代际 → 递增 sessionId → 清私有内存；身份变化都必须走这里。 */
  private rotate(transport: AuthTransport, token = ''): void {
    this.sessionValue.close();
    this.sessionValue = new OwnerSession(token, this.sessionValue.id + 1, transport);
  }

  private set(patch: Partial<AuthState>): void {
    if (this.closed) return;
    this.stateValue = { ...this.stateValue, ...patch, generation: this.sessionValue.id };
    for (const listener of [...this.listeners]) listener();
  }

  private identity(user: AuthUser | null, transport: AuthTransport): string {
    return user
      ? `${transport}|${user.id}|${user.role}|${user.canFind}${user.canRead}${user.canDownload}`
      : `anonymous|${transport}`;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  private async request(
    input: string,
    init: RequestInit,
    transport: AuthTransport,
    token = '',
  ): Promise<Response> {
    const request = createOwnerRequest(input, {
      cache: 'no-store',
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
      ...init,
    }, token, this.options.origin(), transport);
    return fetch(request);
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 'cookie');
  }

  /**
   * 启动 / 复核：先问 `/api/auth/session`。有效 Cookie 优先（含普通用户），
   * 只有“明确没有 Cookie”且处于账号模式时才尝试本机旧口令兑换 owner Cookie。
   */
  async refresh(reason: 'start' | 'visible' | 'broadcast' | 'unauthorized' | 'forbidden' = 'visible'): Promise<void> {
    return this.enqueue(async () => {
      if (reason === 'start') this.set({ phase: 'loading' });
      const generation = this.sessionValue.id;
      let response: Response;
      try {
        response = await this.request('/api/auth/session', { method: 'GET' }, 'cookie');
      } catch {
        // 网络不确定：保持界面锁定，不清除可恢复的旧口令，也不切换身份。
        if (this.sessionValue.id === generation) this.set({ phase: 'unavailable' });
        return;
      }
      if (this.sessionValue.id !== generation) return;

      if (response.status === 401) {
        // Cookie 失效的 401 不触发自动 owner 兑换，也不清除旧口令。
        this.rotate('cookie');
        this.set({ phase: 'anonymous', user: null, transport: 'cookie', expired: true });
        return;
      }
      if (response.status === 503) {
        this.set({ phase: 'unavailable' });
        return;
      }
      if (!response.ok) {
        this.set({ phase: 'unavailable' });
        return;
      }

      const body = await response.json().catch(() => null) as
        { user?: unknown; accountsEnabled?: unknown } | null;
      if (this.sessionValue.id !== generation) return;
      const accountsEnabled = body?.accountsEnabled === true;
      const user = parseAuthUser(body?.user);

      if (user) {
        // 任何 Cookie 登录成功都清除旧存储口令，旧 token 不能把 member 顶替成 owner。
        const current = this.stateValue;
        if (current.user?.id !== user.id || current.transport !== 'cookie') this.rotate('cookie');
        this.options.storage.clear();
        this.set({ phase: 'authenticated', user, accountsEnabled, transport: 'cookie', expired: false });
        return;
      }

      if (!accountsEnabled) {
        // 部署开关关闭：维持原 owner 登录流程，旧模式完全保留 sessionStorage 行为。
        const stored = this.options.storage.read();
        const owner = stored ? OWNER_USER : null;
        if (this.identity(owner, 'owner-header') !== this.identity(this.stateValue.user, this.stateValue.transport)) {
          this.rotate('owner-header', stored);
        }
        this.set({
          phase: owner ? 'authenticated' : 'anonymous',
          user: owner,
          accountsEnabled: false,
          transport: 'owner-header',
          sessionOnly: owner ? this.options.storage.readSessionOnly() : false,
          expired: false,
        });
        return;
      }

      const stored = this.options.storage.read();
      if (stored) {
        // 账号模式 + 明确无 Cookie + 本机旧口令：兑换一次 owner Cookie。
        const exchanged = await this.exchangeOwnerToken(stored, false, generation);
        if (exchanged) return;
      }
      if (this.sessionValue.id !== generation && this.stateValue.transport !== 'cookie') return;
      this.rotate('cookie');
      this.set({ phase: 'anonymous', user: null, accountsEnabled: true, transport: 'cookie', expired: false });
    });
  }

  /** 返回 true 表示已经应用了结果（成功或明确的 401）；false 表示服务不可用。 */
  private async exchangeOwnerToken(token: string, remember: boolean, generation: number): Promise<boolean> {
    let response: Response;
    try {
      response = await this.post('/api/auth/owner', { token, remember });
    } catch {
      if (this.sessionValue.id === generation) this.set({ phase: 'unavailable' });
      return true;
    }
    if (this.sessionValue.id !== generation) return true;
    if (response.ok) {
      const body = await response.json().catch(() => null) as { user?: unknown } | null;
      const user = parseAuthUser(body?.user);
      this.rotate('cookie');
      this.options.storage.clear();
      this.set({
        phase: user ? 'authenticated' : 'anonymous',
        user,
        accountsEnabled: true,
        transport: 'cookie',
        expired: false,
      });
      this.broadcast();
      return true;
    }
    if (response.status === 503) {
      // 兑换失败不自动切成其他身份，也不清掉可恢复的旧口令。
      this.set({ phase: 'unavailable' });
      return true;
    }
    // 401：旧口令不可用，保留存储以便重试；不自动切换身份。
    this.rotate('cookie');
    this.set({ phase: 'anonymous', user: null, accountsEnabled: true, transport: 'cookie', expired: false });
    return true;
  }

  /** 用户名 + 密码登录（账号模式）。 */
  login(username: string, password: string, remember: boolean): Promise<void> {
    return this.enqueue(async () => {
      const response = await this.post('/api/auth/login', {
        username: username.trim().toLowerCase(), password, remember,
      });
      if (!response.ok) throw await this.describeFailure(response, '登录失败，请稍后重试');
      const body = await response.json().catch(() => null) as { user?: unknown } | null;
      const user = parseAuthUser(body?.user);
      this.rotate('cookie');
      this.options.storage.clear();
      this.set({ phase: user ? 'authenticated' : 'anonymous', user, accountsEnabled: true, transport: 'cookie', expired: false });
      this.broadcast();
    });
  }

  /**
   * 管理员口令入口：账号模式走 CSRF + 限速的兑换接口，旧模式保持原 `/api/owner` 流程。
   */
  loginOwner(draft: string, sessionOnly: boolean): Promise<void> {
    return this.enqueue(async () => {
      const token = draft.trim();
      if (!token) throw new AuthError('请先输入访问口令', 400);
      if (this.stateValue.accountsEnabled) {
        const response = await this.post('/api/auth/owner', { token, remember: !sessionOnly });
        if (!response.ok) throw await this.describeFailure(response, '暂时无法验证口令，请稍后重试');
        const body = await response.json().catch(() => null) as { user?: unknown } | null;
        const user = parseAuthUser(body?.user);
        this.rotate('cookie');
        this.options.storage.clear();
        this.set({ phase: user ? 'authenticated' : 'anonymous', user, accountsEnabled: true, transport: 'cookie', expired: false });
        this.broadcast();
        return;
      }
      let response: Response;
      try {
        response = await this.request('/api/owner', { method: 'GET' }, 'owner-header', token);
      } catch {
        throw new AuthError('暂时无法验证口令，请稍后重试', 503);
      }
      if (response.status === 401) throw new AuthError('口令不正确，当前口令未更改', 401);
      if (!response.ok) throw new AuthError('暂时无法验证口令，请稍后重试', response.status);
      this.options.storage.write(token, sessionOnly);
      this.rotate('owner-header', token);
      this.set({
        phase: 'authenticated',
        user: OWNER_USER,
        transport: 'owner-header',
        sessionOnly,
        expired: false,
      });
    });
  }

  /** 旧模式下切换“仅本次会话保存”。 */
  setLegacySessionOnly(value: boolean): void {
    if (this.stateValue.transport !== 'owner-header') return;
    this.options.storage.write(this.sessionValue.token, value);
    this.set({ sessionOnly: value });
  }

  /**
   * 退出：同一标签内串行，等完成在途认证操作后再撤销真实会话。
   * 服务端撤销失败不清屏冒充成功，抛错让界面提示重试。
   */
  logout(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stateValue.transport === 'owner-header') {
        this.options.storage.clear();
        this.rotate('owner-header');
        this.set({ phase: 'anonymous', user: null, sessionOnly: false, expired: false });
        return;
      }
      let response: Response;
      try {
        response = await this.post('/api/auth/logout', undefined);
      } catch {
        throw new AuthError('退出尚未完成，请重试', 503);
      }
      if (!response.ok) throw new AuthError('退出尚未完成，请重试', response.status);
      this.options.storage.clear();
      this.rotate('cookie');
      this.set({ phase: 'anonymous', user: null, expired: false });
      this.broadcast();
    });
  }

  /**
   * 业务请求入口：经当前代际发出；401 关闭代际并复核身份，403 刷新权限。
   * 迟到的 401 / 403 不影响调用方拿到的响应体。
   */
  fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const session = this.sessionValue;
    return session.fetch(input, init, this.options.origin()).then((response) => {
      if (response.status === 401 && session.id === this.sessionValue.id) {
        void this.refresh('unauthorized').catch(() => {});
      } else if (response.status === 403) {
        void this.refresh('forbidden').catch(() => {});
      }
      return response;
    });
  }

  private async describeFailure(response: Response, fallback: string): Promise<AuthError> {
    const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    if (response.status === 401) return new AuthError('用户名或密码不正确', 401, code);
    if (response.status === 403 && code === 'MEMBERS_DISABLED') {
      return new AuthError('当前部署尚未开放成员访问', 403, code);
    }
    if (response.status === 503 && code === 'ACCOUNTS_DISABLED') {
      return new AuthError('账号功能尚未启用，请使用管理员口令入口', 503, code);
    }
    if (code === 'INVALID_USERNAME') {
      return new AuthError('用户名需为 3–32 位小写字母、数字或下划线，且以字母开头', 400, code);
    }
    if (code === 'INVALID_PASSWORD') return new AuthError('密码长度不符合要求', 400, code);
    if (response.status === 429) return new AuthError('尝试过于频繁，请稍后再试', 429, code);
    if (response.status === 503) return new AuthError('服务暂不可用，请稍后重试', 503, code);
    const message = typeof body?.error === 'string' && body.error ? body.error : fallback;
    return new AuthError(message, response.status, code);
  }
}
