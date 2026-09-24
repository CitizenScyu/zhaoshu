import type { NextRequest } from 'next/server';
import {
  bumpAuthRateLimit, decideRateLimit, rateLimitKeyHash, requestSourceIdentifier,
  type RateLimitDecision, type RateLimitWindow,
} from './auth-rate-limit';
import { getAuthSecuritySecret } from './auth-session';
import type { Principal } from './auth-types';
import { getSql } from './db';

// 41-fanfix N7：单源 probe 的用户级限流。复用登录限速的 auth_rate_limits 计数（数据库时钟、原子 UPSERT、
// 键为带用途前缀的 HMAC），所以**跨 serverless 实例有效**，不是进程内计数。只计单源 probe；候选列表不出网，不计。
// 一次换源面板打开 ≈ SOURCE_FANOUT_LIMIT 个 probe（灰度建议 12，默认 24）。

export type SourceProbeRateLimitWindow = RateLimitWindow & { limit: number };

/** 默认：10 分钟 60 次（12 个 probe 的扫描约 5 次）+ 每日 240 次（fanout-41-report §4 的灰度门槛）。 */
export const DEFAULT_SOURCE_PROBE_RATE_LIMITS = '60/600,240/86400';
const MAX_WINDOW_SECONDS = 7 * 86_400;

function parseWindows(spec: string): SourceProbeRateLimitWindow[] | null {
  const windows: SourceProbeRateLimitWindow[] = [];
  for (const item of spec.split(',')) {
    const match = /^(\d+)\/(\d+)$/.exec(item.trim());
    if (!match) return null;
    const limit = Number(match[1]);
    const windowSeconds = Number(match[2]);
    if (!Number.isSafeInteger(limit) || limit < 1 || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) return null;
    windows.push({ scope: `source-probe-${windowSeconds}`, limit, windowSeconds });
  }
  return windows;
}

/**
 * env `SOURCE_PROBE_RATE_LIMITS`：逗号分隔的 `次数/窗口秒`，如 `60/600,240/86400`。
 * `0` 关闭限流（回滚）；缺失或任一项非法 ⇒ 整体回退默认值（不按半截配置放行）。
 */
export function sourceProbeRateLimits(env: Record<string, string | undefined> = process.env): SourceProbeRateLimitWindow[] {
  const raw = env.SOURCE_PROBE_RATE_LIMITS?.trim();
  if (raw === '0') return [];
  return (raw && parseWindows(raw)) || parseWindows(DEFAULT_SOURCE_PROBE_RATE_LIMITS)!;
}

/** 限流主体：有登录身份按用户，否则按平台可信转发的来源 IP（与登录限速同一取法）。 */
export function sourceProbeRateLimitSubject(req: NextRequest, principal: Principal | undefined): string {
  const userId = principal?.userId;
  return typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0
    ? `user:${userId}`
    : `ip:${requestSourceIdentifier(req)}`;
}

export class SourceProbeRateLimitUnavailableError extends Error {
  constructor() { super('source probe rate limit unavailable'); }
}

/**
 * 逐窗口计数并判定；任一窗口超限即拒（返回最先超限窗口的 retryAfterSeconds）。先计数后判定：被拒的调用也计数。
 * 缺 AUTH_SECURITY_SECRET（无法算键）或计数写库失败 ⇒ 抛 SourceProbeRateLimitUnavailableError，
 * 由路由回 503——与登录限速一致按「关」处理，不在限流不可用时放行出网。
 */
export async function checkSourceProbeRateLimit(req: NextRequest, principal: Principal | undefined): Promise<RateLimitDecision> {
  const windows = sourceProbeRateLimits();
  if (!windows.length) return { allowed: true };
  const secret = getAuthSecuritySecret();
  if (!secret) throw new SourceProbeRateLimitUnavailableError();
  const subject = sourceProbeRateLimitSubject(req, principal);
  try {
    const sql = getSql();
    for (const window of windows) {
      const decision = decideRateLimit(
        await bumpAuthRateLimit(sql, window, rateLimitKeyHash(secret, window.scope, subject)),
        window.limit,
      );
      if (!decision.allowed) return decision;
    }
  } catch {
    throw new SourceProbeRateLimitUnavailableError();
  }
  return { allowed: true };
}
