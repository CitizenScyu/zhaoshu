import { createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

// 设计 §4.4 的起始策略值：均为项目策略，可在小范围试用后调节，非平台限制。
export const LOGIN_SOURCE_RATE_LIMIT = { scope: 'login-source', limit: 20, windowSeconds: 600 } as const;
export const LOGIN_USER_RATE_LIMIT = { scope: 'login-user', limit: 10, windowSeconds: 900 } as const;
export const LOGIN_GLOBAL_RATE_LIMIT = { scope: 'login-global', limit: 100, windowSeconds: 600 } as const;
export const OWNER_FAIL_SOURCE_RATE_LIMIT = { scope: 'owner-fail-source', limit: 10, windowSeconds: 900 } as const;
export const OWNER_FAIL_GLOBAL_RATE_LIMIT = { scope: 'owner-fail-global', limit: 100, windowSeconds: 600 } as const;
// 注册（设计 §4.4：每来源 5 次 / 小时，并受登录的全局认证预算限制）。失败的邀请码也计数。
export const REGISTER_SOURCE_RATE_LIMIT = { scope: 'register-source', limit: 5, windowSeconds: 3600 } as const;

export const GLOBAL_RATE_LIMIT_KEY = 'all';

// 应用 secret 对来源 / 用户名做带用途前缀的 HMAC，数据库不存原始 IP 或用户名。
export function rateLimitKeyHash(secret: string, scope: string, identifier: string): string {
  return createHmac('sha256', secret).update(`${scope}\0${identifier}`).digest('hex');
}

// 来源地址只按平台可信转发规则获取：取 X-Forwarded-For 的最后一个跳（Vercel 平台追加端），
// 不盲信客户端自填的左侧值；取不到时退回 x-real-ip，再退回 unknown 由账号 / 全局桶兜底。
export function requestSourceIdentifier(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export type RateLimitWindow = { scope: string; windowSeconds: number };
export type RateLimitBump = { attempts: number; retryAfterSeconds: number };

// 原子 UPSERT 计数：窗口起点由数据库时钟计算，避免实例间时钟漂移；KDF 前预占计数。
export async function bumpAuthRateLimit(sql: Sql, window: RateLimitWindow, keyHash: string): Promise<RateLimitBump> {
  const rows = (await sql`
    INSERT INTO auth_rate_limits (scope, key_hash, window_start, attempts, expires_at)
    VALUES (
      ${window.scope},
      ${keyHash},
      to_timestamp(floor(extract(epoch from now()) / ${window.windowSeconds}::double precision) * ${window.windowSeconds}::double precision),
      1,
      to_timestamp(floor(extract(epoch from now()) / ${window.windowSeconds}::double precision) * ${window.windowSeconds}::double precision)
        + (${window.windowSeconds}::double precision * interval '1 second')
    )
    ON CONFLICT (scope, key_hash, window_start)
    DO UPDATE SET attempts = auth_rate_limits.attempts + 1
    RETURNING attempts, CEIL(EXTRACT(EPOCH FROM (expires_at - now())))::int AS retry_after_seconds`) as {
    attempts: number;
    retry_after_seconds: number;
  }[];
  const row = rows[0];
  if (!row) throw new Error('auth rate limit upsert returned no row');
  return { attempts: row.attempts, retryAfterSeconds: Math.max(0, row.retry_after_seconds) };
}

// 只读当前窗口计数，用于验证口令前的冷却检查；正确请求不累计失败数。
export async function peekAuthRateLimit(
  sql: Sql,
  window: RateLimitWindow,
  keyHash: string,
): Promise<RateLimitBump> {
  const rows = (await sql`
    SELECT attempts,
           CEIL(EXTRACT(EPOCH FROM (
             window_start + (${window.windowSeconds}::double precision * interval '1 second') - now())))::int AS retry_after_seconds
    FROM auth_rate_limits
    WHERE scope = ${window.scope}
      AND key_hash = ${keyHash}
      AND window_start = to_timestamp(floor(extract(epoch from now()) / ${window.windowSeconds}::double precision) * ${window.windowSeconds}::double precision)`) as {
    attempts: number;
    retry_after_seconds: number;
  }[];
  const row = rows[0];
  if (!row) return { attempts: 0, retryAfterSeconds: 0 };
  return { attempts: row.attempts, retryAfterSeconds: Math.max(0, row.retry_after_seconds) };
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function decideRateLimit(bump: RateLimitBump, limit: number): RateLimitDecision {
  if (bump.attempts <= limit) return { allowed: true };
  return { allowed: false, retryAfterSeconds: bump.retryAfterSeconds };
}
