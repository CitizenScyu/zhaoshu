import type { NextRequest } from 'next/server';
import { authAccountsEnabled } from '@/lib/auth';
import {
  createSession,
  cleanupExpiredAuthRows,
  ensureAuthSchema,
  getAuthSecuritySecret,
  getSessionCookieName,
  sessionCookieOptions,
} from '@/lib/auth-session';
import {
  GLOBAL_RATE_LIMIT_KEY,
  LOGIN_GLOBAL_RATE_LIMIT,
  LOGIN_SOURCE_RATE_LIMIT,
  LOGIN_USER_RATE_LIMIT,
  bumpAuthRateLimit,
  decideRateLimit,
  rateLimitKeyHash,
  requestSourceIdentifier,
} from '@/lib/auth-rate-limit';
import { isJsonContentType, verifySameOriginWrite } from '@/lib/csrf';
import { getSql } from '@/lib/db';
import { authError, authJson } from '@/lib/auth-http';
import { checkPasswordBounds, runDummyKdf, verifyPassword } from '@/lib/password';

// 用户名 + 密码合计请求体上限 4 KiB（设计 §4.1）。
const MAX_LOGIN_BODY_CHARS = 4096;
const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

function invalidCredentials() {
  return authError(401, 'INVALID_CREDENTIALS', 'invalid username or password');
}

type MemberRow = {
  id: number;
  username: string;
  role: string;
  password_hash: string | null;
  disabled_at: string | null;
  can_find: boolean;
  can_read: boolean;
  can_download: boolean;
};

export async function POST(req: NextRequest) {
  if (!authAccountsEnabled()) {
    return authError(503, 'ACCOUNTS_DISABLED', 'account features are not enabled');
  }
  const csrfFailure = verifySameOriginWrite(req);
  if (csrfFailure) return csrfFailure;
  if (!isJsonContentType(req)) {
    return authError(415, 'UNSUPPORTED_MEDIA_TYPE', 'expected application/json');
  }
  const raw = await req.text();
  if (raw.length > MAX_LOGIN_BODY_CHARS) {
    return authError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return authError(400, 'INVALID_BODY', 'request body must be JSON');
  }
  const { username, password, remember } = (body ?? {}) as {
    username?: unknown;
    password?: unknown;
    remember?: unknown;
  };
  if (typeof username !== 'string' || typeof password !== 'string') {
    return authError(400, 'INVALID_BODY', 'username and password are required');
  }
  if (remember !== undefined && typeof remember !== 'boolean') {
    return authError(400, 'INVALID_BODY', 'remember must be a boolean');
  }
  const normalizedUsername = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return authError(400, 'INVALID_USERNAME', 'username format is invalid');
  }
  const boundsError = checkPasswordBounds(password);
  if (boundsError) {
    return authError(400, 'INVALID_PASSWORD', 'password format is invalid');
  }

  const secret = getAuthSecuritySecret();
  if (!secret) {
    return authError(503, 'AUTH_SECURITY_SECRET_REQUIRED', 'authentication service unavailable');
  }

  const sql = getSql();
  try {
    await ensureAuthSchema();
  } catch {
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }

  // 先限速再计算 KDF：计数在 KDF 前原子预占，不因错误返回或账号不存在跳过。
  const source = requestSourceIdentifier(req);
  const buckets = [
    { window: LOGIN_SOURCE_RATE_LIMIT, keyHash: rateLimitKeyHash(secret, LOGIN_SOURCE_RATE_LIMIT.scope, source) },
    { window: LOGIN_USER_RATE_LIMIT, keyHash: rateLimitKeyHash(secret, LOGIN_USER_RATE_LIMIT.scope, normalizedUsername) },
    { window: LOGIN_GLOBAL_RATE_LIMIT, keyHash: rateLimitKeyHash(secret, LOGIN_GLOBAL_RATE_LIMIT.scope, GLOBAL_RATE_LIMIT_KEY) },
  ];
  try {
    for (const bucket of buckets) {
      const decision = decideRateLimit(
        await bumpAuthRateLimit(sql, bucket.window, bucket.keyHash),
        bucket.window.limit,
      );
      if (!decision.allowed) {
        return authError(429, 'RATE_LIMITED', 'too many authentication attempts', {
          'Retry-After': String(decision.retryAfterSeconds),
        });
      }
    }
  } catch {
    return authError(503, 'AUTH_RATE_LIMIT_UNAVAILABLE', 'authentication service unavailable');
  }

  let user: MemberRow | undefined;
  try {
    const rows = (await sql`
      SELECT id, username, role, password_hash, disabled_at, can_find, can_read, can_download
      FROM users WHERE username = ${normalizedUsername}`) as MemberRow[];
    user = rows[0];
  } catch {
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }

  // 不存在、禁用、owner 或无密码哈希统一走 dummy KDF + 相同文案，不泄露用户存在性。
  if (!user || user.disabled_at !== null || user.role !== 'member' || typeof user.password_hash !== 'string') {
    await runDummyKdf();
    return invalidCredentials();
  }

  let valid: boolean;
  try {
    valid = await verifyPassword(password, user.password_hash);
  } catch {
    return authError(503, 'AUTH_KDF_UNAVAILABLE', 'authentication service unavailable');
  }
  if (!valid) {
    // 登录失败不改变已有 session。
    return invalidCredentials();
  }

  let created: { token: string; expiresAt: string };
  try {
    created = await createSession(sql, {
      userId: user.id,
      authMethod: 'password',
      remember: remember === true,
    });
  } catch {
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }
  try {
    await cleanupExpiredAuthRows(sql);
  } catch {
    // 顺带清理失败不影响登录结果。
  }

  const response = authJson({
    user: {
      id: user.id,
      username: user.username,
      role: 'member',
      canFind: user.can_find,
      canRead: user.can_read,
      canDownload: user.can_download,
      authMethod: 'session',
    },
  });
  response.cookies.set(
    getSessionCookieName(),
    created.token,
    sessionCookieOptions(remember === true),
  );
  return response;
}
