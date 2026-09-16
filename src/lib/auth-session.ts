import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { neon } from '@neondatabase/serverless';
import { getSql } from './db';
import { initializeAuthSchema } from './auth-store';

type Sql = ReturnType<typeof neon>;

// 设计 §2.3：随机 32 字节 Cookie token，数据库只存 SHA-256 摘要。
export const SESSION_TOKEN_BYTES = 32;
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const REMEMBER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_SESSIONS_PER_USER = 5;

export const PRODUCTION_SESSION_COOKIE_NAME = '__Host-nf-session';
export const DEVELOPMENT_SESSION_COOKIE_NAME = 'nf-dev-session';

export function getSessionCookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? PRODUCTION_SESSION_COOKIE_NAME
    : DEVELOPMENT_SESSION_COOKIE_NAME;
}

export function sessionCookieOptions(remember: boolean) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    ...(remember ? { maxAge: REMEMBER_SESSION_TTL_SECONDS } : {}),
  };
}

export function clearedSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
}

export function getSessionTokenFromRequest(req: NextRequest): string | null {
  const value = req.cookies.get(getSessionCookieName())?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// 新随机 AUTH_SECURITY_SECRET（≥32 字节）用于限速键 HMAC 与 owner 凭据代际标签。
export function getAuthSecuritySecret(): string | null {
  const secret = process.env.AUTH_SECURITY_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) return null;
  return secret;
}

export function ownerCredentialTag(secret: string, ownerToken: string): string {
  return createHmac('sha256', secret)
    .update(`owner-credential-v1\0${ownerToken}`)
    .digest('hex');
}

// 冷启动懒初始化认证表；失败后允许重试，不长期缓存失败的 Promise。
let authSchemaPromise: Promise<void> | null = null;

export async function ensureAuthSchema(): Promise<void> {
  if (!authSchemaPromise) {
    authSchemaPromise = initializeAuthSchema(getSql()).catch((error) => {
      authSchemaPromise = null;
      throw error;
    });
  }
  await authSchemaPromise;
}

export type CreateSessionInput = {
  userId: number;
  authMethod: 'password' | 'owner_token';
  ownerCredentialTag?: string | null;
  remember: boolean;
};

export async function createSession(
  sql: Sql,
  input: CreateSessionInput,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const ttlSeconds = input.remember ? REMEMBER_SESSION_TTL_SECONDS : DEFAULT_SESSION_TTL_SECONDS;
  // 用户行短事务锁保证并发下的 5 会话上限；新会话本身永不被裁剪，其余按 created_at 保留最新。
  const results = (await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(18521403, ${input.userId}::int)`,
    tx`
      INSERT INTO sessions (token_hash, user_id, auth_method, owner_credential_tag, expires_at)
      VALUES (${tokenHash}, ${input.userId}, ${input.authMethod}, ${input.ownerCredentialTag ?? null},
              now() + (${ttlSeconds}::double precision * interval '1 second'))
      RETURNING expires_at::text AS expires_at`,
    tx`
      DELETE FROM sessions
      WHERE user_id = ${input.userId}
        AND token_hash <> ${tokenHash}
        AND token_hash IN (
          SELECT token_hash FROM sessions
          WHERE user_id = ${input.userId}
          ORDER BY created_at DESC, token_hash DESC
          OFFSET ${MAX_SESSIONS_PER_USER}
        )`,
  ])) as unknown as { expires_at: string }[][];
  const expiresAt = results[1][0]?.expires_at;
  if (!expiresAt) throw new Error('session insert returned no expiry');
  return { token, expiresAt };
}

export type SessionRecord = {
  userId: number;
  username: string;
  role: 'owner' | 'member';
  canFind: boolean;
  canRead: boolean;
  canDownload: boolean;
  authMethod: 'password' | 'owner_token';
  ownerCredentialTag: string | null;
  membersEnabled: boolean;
};

// 每请求一次身份查询：会话、用户与成员闸门设置在同一个 JOIN 里读取。
export async function findSessionByToken(sql: Sql, token: string, signal?: AbortSignal): Promise<SessionRecord | null> {
  const query = sql`
    SELECT s.user_id, s.auth_method, s.owner_credential_tag, u.username, u.role,
           u.can_find, u.can_read, u.can_download, m.members_enabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    CROSS JOIN auth_settings m
    WHERE s.token_hash = ${hashSessionToken(token)}
      AND s.expires_at > now()
      AND u.disabled_at IS NULL`;
  const rows = (signal ? (await sql.transaction([query], { fetchOptions: { signal } }))[0] : await query) as {
    user_id: number;
    username: string;
    role: string;
    can_find: boolean;
    can_read: boolean;
    can_download: boolean;
    auth_method: string;
    owner_credential_tag: string | null;
    members_enabled: boolean;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    username: row.username,
    role: row.role === 'owner' ? 'owner' : 'member',
    canFind: row.can_find,
    canRead: row.can_read,
    canDownload: row.can_download,
    authMethod: row.auth_method === 'owner_token' ? 'owner_token' : 'password',
    ownerCredentialTag: row.owner_credential_tag,
    membersEnabled: row.members_enabled,
  };
}

export async function revokeSession(sql: Sql, token: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM sessions WHERE token_hash = ${hashSessionToken(token)}
    RETURNING token_hash`) as unknown[];
  return rows.length > 0;
}

// 顺带有界清理（每次最多 100 行），不依赖分钟级 cron。
export async function cleanupExpiredAuthRows(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM sessions WHERE ctid IN (
      SELECT ctid FROM sessions WHERE expires_at < now() LIMIT 100)`;
  await sql`
    DELETE FROM auth_rate_limits WHERE ctid IN (
      SELECT ctid FROM auth_rate_limits WHERE expires_at < now() LIMIT 100)`;
}
