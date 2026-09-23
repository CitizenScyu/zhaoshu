import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { AuthResult, Permission, Principal } from './auth-types';
import { hasPermission, OWNER_PRINCIPAL } from './permissions';
import {
  findSessionByToken,
  getAuthSecuritySecret,
  getSessionCookieName,
  ownerCredentialTag,
  type SessionRecord,
} from './auth-session';
import {
  OWNER_FAIL_GLOBAL_RATE_LIMIT,
  OWNER_FAIL_SOURCE_RATE_LIMIT,
  GLOBAL_RATE_LIMIT_KEY,
  bumpAuthRateLimit,
  peekAuthRateLimit,
  rateLimitKeyHash,
  requestSourceIdentifier,
} from './auth-rate-limit';
import { getSql } from './db';

// 部署开关 AUTH_ACCOUNTS_ENABLED（设计 §2.2）：默认 false，旧入口保持零数据库契约。
export function authAccountsEnabled(): boolean {
  return process.env.AUTH_ACCOUNTS_ENABLED === 'true';
}

export function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireApiOwner(req: NextRequest): NextResponse | null {
  const expected = process.env.APP_OWNER_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'APP_OWNER_TOKEN is not configured', code: 'OWNER_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const authorization = req.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : req.headers.get('x-owner-token') ?? '';
  if (!secretsEqual(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }
  return null;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
}

function serviceUnavailable(code: string, retryAfterSeconds?: number): NextResponse {
  return NextResponse.json({ error: 'authentication service unavailable', code }, {
    status: 503,
    ...(retryAfterSeconds !== undefined ? { headers: { 'Retry-After': String(retryAfterSeconds) } } : {}),
  });
}

function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return NextResponse.json({ error: 'too many authentication attempts', code: 'RATE_LIMITED' }, {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

function ownerHeaderCredential(req: NextRequest): string | null {
  const authorization = req.headers.get('authorization');
  const ownerHeader = req.headers.get('x-owner-token');
  if (authorization !== null && ownerHeader !== null) return null;
  if (authorization === null && ownerHeader === null) return null;
  if (authorization !== null) {
    return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  }
  return ownerHeader ?? '';
}

// 显式 owner 头校验：账号模式下进入共享失败预算（先查冷却再验证，错误才计数），
// 旧模式保持同步等价的零数据库行为。显式错误头永远不回退为 Cookie 身份。
export async function verifyOwnerHeader(req: NextRequest): Promise<AuthResult> {
  const provided = ownerHeaderCredential(req);
  if (provided === null) return { ok: false, response: unauthorized() };

  const expected = process.env.APP_OWNER_TOKEN;
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'APP_OWNER_TOKEN is not configured', code: 'OWNER_NOT_CONFIGURED' },
        { status: 503 },
      ),
    };
  }

  const valid = provided !== '' && secretsEqual(provided, expected);
  if (!authAccountsEnabled()) {
    return valid
      ? { ok: true, principal: OWNER_PRINCIPAL }
      : { ok: false, response: unauthorized() };
  }

  const secret = getAuthSecuritySecret();
  if (!secret) {
    return { ok: false, response: serviceUnavailable('AUTH_SECURITY_SECRET_REQUIRED') };
  }

  const sql = getSql();
  const source = requestSourceIdentifier(req);
  try {
    const sourceBucket = await peekAuthRateLimit(
      sql,
      OWNER_FAIL_SOURCE_RATE_LIMIT,
      rateLimitKeyHash(secret, OWNER_FAIL_SOURCE_RATE_LIMIT.scope, source),
    );
    const globalBucket = await peekAuthRateLimit(
      sql,
      OWNER_FAIL_GLOBAL_RATE_LIMIT,
      rateLimitKeyHash(secret, OWNER_FAIL_GLOBAL_RATE_LIMIT.scope, GLOBAL_RATE_LIMIT_KEY),
    );
    if (sourceBucket.attempts >= OWNER_FAIL_SOURCE_RATE_LIMIT.limit
      || globalBucket.attempts >= OWNER_FAIL_GLOBAL_RATE_LIMIT.limit) {
      return {
        ok: false,
        response: tooManyRequests(
          Math.max(sourceBucket.retryAfterSeconds, globalBucket.retryAfterSeconds),
        ),
      };
    }
  } catch {
    // 限速状态不可用时账号模式失败关闭，不把服务故障当密码错误。
    return { ok: false, response: serviceUnavailable('AUTH_RATE_LIMIT_UNAVAILABLE') };
  }

  if (valid) {
    // 正确的日常请求不累计失败数。
    return { ok: true, principal: OWNER_PRINCIPAL };
  }

  // 失败预算（设计 §4.4）：先挡单来源，再累计全局。
  //
  // 全局桶只在**单来源桶本次耗尽自身预算**时才计入一次。单来源预算耗尽后，
  // 其后的请求会被上面 peek 的单来源判据直接挡掉（不再走到这里），所以每个来源
  // 最多向全局桶贡献 1 次——单一 IP 无法靠狂发错误头锁死全站 owner 认证。
  // 全局桶保留的是它真正的设计意图：挡**分布式**爆破（换 IP 绕过单来源桶），
  // 多来源各自耗尽预算时仍会逐次累计到全局上限。
  try {
    const sourceBump = await bumpAuthRateLimit(
      sql,
      OWNER_FAIL_SOURCE_RATE_LIMIT,
      rateLimitKeyHash(secret, OWNER_FAIL_SOURCE_RATE_LIMIT.scope, source),
    );
    if (sourceBump.attempts >= OWNER_FAIL_SOURCE_RATE_LIMIT.limit) {
      await bumpAuthRateLimit(
        sql,
        OWNER_FAIL_GLOBAL_RATE_LIMIT,
        rateLimitKeyHash(secret, OWNER_FAIL_GLOBAL_RATE_LIMIT.scope, GLOBAL_RATE_LIMIT_KEY),
      );
    }
  } catch {
    // 限速状态不可用时账号模式失败关闭，不把服务故障当密码错误。
    return { ok: false, response: serviceUnavailable('AUTH_RATE_LIMIT_UNAVAILABLE') };
  }
  return { ok: false, response: unauthorized() };
}

// 把数据库会话记录映射为 Principal：owner 凭据代际标签不匹配即失效，
// 成员闸门未开时 member 一律拒绝，未知角色或坏权限值默认拒绝。
export function principalFromSessionRecord(record: SessionRecord | null): AuthResult {
  if (!record) return { ok: false, response: unauthorized() };
  if (record.role !== 'owner' && record.role !== 'member') {
    return { ok: false, response: unauthorized() };
  }
  if (
    typeof record.canFind !== 'boolean' || typeof record.canRead !== 'boolean'
    || typeof record.canDownload !== 'boolean' || typeof record.userId !== 'number'
  ) {
    return { ok: false, response: unauthorized() };
  }
  if (record.role === 'owner') {
    // owner 行没有密码，password 会话不可能合法；owner_token 会话须匹配当前口令代际。
    if (record.authMethod !== 'owner_token') return { ok: false, response: unauthorized() };
    const ownerToken = process.env.APP_OWNER_TOKEN;
    const secret = getAuthSecuritySecret();
    if (!ownerToken || !secret) return { ok: false, response: unauthorized() };
    if (record.ownerCredentialTag !== ownerCredentialTag(secret, ownerToken)) {
      return { ok: false, response: unauthorized() };
    }
  } else if (!record.membersEnabled) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'member access is not enabled', code: 'MEMBERS_DISABLED' },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    principal: {
      userId: record.userId,
      role: record.role,
      canFind: record.canFind,
      canRead: record.canRead,
      canDownload: record.canDownload,
      authMethod: 'session',
    },
  };
}

// 每请求一次身份查询：同一请求内的重复 guard 复用同一个 Promise。
const principalCache = new WeakMap<NextRequest, Promise<AuthResult>>();

export function resolvePrincipal(req: NextRequest, signal?: AbortSignal): Promise<AuthResult> {
  let cached = principalCache.get(req);
  if (!cached) {
    cached = resolvePrincipalUncached(req, signal);
    principalCache.set(req, cached);
  }
  return cached;
}

async function resolvePrincipalUncached(req: NextRequest, signal?: AbortSignal): Promise<AuthResult> {
  const authorization = req.headers.get('authorization');
  const ownerHeader = req.headers.get('x-owner-token');
  if (authorization !== null || ownerHeader !== null) {
    return verifyOwnerHeader(req);
  }

  // Cookie 会话只在账号模式启用；旧模式忽略 Cookie，不触碰数据库。
  if (!authAccountsEnabled()) return { ok: false, response: unauthorized() };
  const cookie = req.cookies.get(getSessionCookieName())?.value;
  if (typeof cookie !== 'string' || cookie.length === 0) {
    return { ok: false, response: unauthorized() };
  }
  let record: SessionRecord | null;
  try {
    record = signal ? await findSessionByToken(getSql(), cookie, signal) : await findSessionByToken(getSql(), cookie);
  } catch {
    // session 数据库不可用时不把 Cookie 当有效，也不降级为 owner。
    return { ok: false, response: serviceUnavailable('AUTH_DB_UNAVAILABLE') };
  }
  return principalFromSessionRecord(record);
}

export async function requirePermission(
  req: NextRequest,
  permission: Permission,
  signal?: AbortSignal,
): Promise<AuthResult> {
  const result = await resolvePrincipal(req, signal);
  if (!result.ok) return result;
  if (!hasPermission(result.principal, permission)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    };
  }
  return result;
}

export async function requireOwner(req: NextRequest): Promise<AuthResult> {
  const result = await resolvePrincipal(req);
  if (!result.ok) return result;
  if (result.principal.role !== 'owner') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    };
  }
  return result;
}

// 长操作写回前必须重新查询原请求的凭据，不能复用请求内的 Principal 缓存。
export async function revalidatePermission(
  req: NextRequest,
  original: Principal,
  permission: Permission,
  signal?: AbortSignal,
): Promise<AuthResult> {
  const fresh = await resolvePrincipalUncached(req, signal);
  if (!fresh.ok) return fresh;
  if (fresh.principal.userId !== original.userId || fresh.principal.role !== original.role ||
      fresh.principal.authMethod !== original.authMethod || !hasPermission(fresh.principal, permission)) {
    return { ok: false, response: NextResponse.json({ error: 'authorization changed', code: 'AUTHORIZATION_CHANGED' }, { status: 403 }) };
  }
  return fresh;
}
