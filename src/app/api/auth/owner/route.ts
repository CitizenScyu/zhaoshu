import type { NextRequest } from 'next/server';
import { authAccountsEnabled, secretsEqual } from '@/lib/auth';
import {
  cleanupExpiredAuthRows,
  createSession,
  ensureAuthSchema,
  getAuthSecuritySecret,
  getSessionCookieName,
  getSessionTokenFromRequest,
  ownerCredentialTag,
  revokeSession,
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

const MAX_EXCHANGE_BODY_CHARS = 4096;

// 验证旧口令并兑换 owner Cookie：不保存口令明文，也不把 APP_OWNER_TOKEN 转存为普通密码。
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
  if (raw.length > MAX_EXCHANGE_BODY_CHARS) {
    return authError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return authError(400, 'INVALID_BODY', 'request body must be JSON');
  }
  const { token, remember } = (body ?? {}) as { token?: unknown; remember?: unknown };
  if (typeof token !== 'string' || token.length === 0) {
    return authError(400, 'INVALID_BODY', 'token is required');
  }
  if (remember !== undefined && typeof remember !== 'boolean') {
    return authError(400, 'INVALID_BODY', 'remember must be a boolean');
  }

  const ownerToken = process.env.APP_OWNER_TOKEN;
  if (!ownerToken) {
    return authError(503, 'OWNER_NOT_CONFIGURED', 'APP_OWNER_TOKEN is not configured');
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

  // 兑换与密码登录共用昂贵认证预算：来源、用户名（owner）与全站桶。
  const source = requestSourceIdentifier(req);
  const buckets = [
    { window: LOGIN_SOURCE_RATE_LIMIT, keyHash: rateLimitKeyHash(secret, LOGIN_SOURCE_RATE_LIMIT.scope, source) },
    { window: LOGIN_USER_RATE_LIMIT, keyHash: rateLimitKeyHash(secret, LOGIN_USER_RATE_LIMIT.scope, 'owner') },
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

  if (!secretsEqual(token, ownerToken)) {
    return authError(401, 'INVALID_CREDENTIALS', 'invalid owner token');
  }

  // 账号切换：旧 Cookie 对应会话在兑换成功路径上先撤销，撤销失败则保持旧状态。
  const previousToken = getSessionTokenFromRequest(req);
  if (previousToken !== null) {
    try {
      await revokeSession(sql, previousToken);
    } catch {
      return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
    }
  }

  let created: { token: string; expiresAt: string };
  try {
    created = await createSession(sql, {
      userId: 1,
      authMethod: 'owner_token',
      ownerCredentialTag: ownerCredentialTag(secret, ownerToken),
      remember: remember === true,
    });
  } catch {
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }
  try {
    await cleanupExpiredAuthRows(sql);
  } catch {
    // 顺带清理失败不影响兑换结果。
  }

  const response = authJson({
    user: {
      id: 1,
      username: 'owner',
      role: 'owner',
      canFind: true,
      canRead: true,
      canDownload: true,
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
