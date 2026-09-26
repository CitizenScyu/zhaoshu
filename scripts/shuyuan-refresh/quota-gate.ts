// 书源刷新运行器的数据库配额闸（41-q402fix）。纯函数，文件读写留在 entry.ts。
//
// 运行器是每日 oneshot，本身不高频；但 Persistent=true 补跑、人工重跑都可能在 Neon 402 期间反复打库。
// 配额失败时把 STATUS_FILE 写成 db-quota-exceeded（带 retryAfter，不写驱动原文）；下次启动若仍在冷却期
// 就不碰库、原样保留状态文件并正常退出。冷却后首次成功由调用方在 cron_health 补记发现时刻。

import { MAX_DB_QUOTA_BACKOFF_MS } from '@/lib/db-quota';

export const QUOTA_STATE = 'db-quota-exceeded';

interface StatusShape {
  state?: unknown;
  consecutive?: unknown;
  firstFailedAt?: unknown;
  lastFailedAt?: unknown;
  retryAfter?: unknown;
}

function parseStatus(text: string | null): StatusShape | null {
  if (!text || !text.trim()) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as StatusShape : null;
  } catch {
    return null;
  }
}

export type QuotaGate =
  | { skip: true; retryAt: string }
  /** quotaSeenAt：上次以配额错误收场的时刻（本次成功后应补记）；否则 null。 */
  | { skip: false; quotaSeenAt: string | null };

/** 启动闸：上次配额失败且未到 retryAfter ⇒ 跳过（不碰库）。状态文件缺失/损坏/非配额态一律放行。 */
export function quotaGate(statusText: string | null, now: number): QuotaGate {
  const status = parseStatus(statusText);
  if (status?.state !== QUOTA_STATE) return { skip: false, quotaSeenAt: null };
  const retryAt = typeof status.retryAfter === 'string' ? Date.parse(status.retryAfter) : Number.NaN;
  // 时钟回拨或手改出的超远 retryAfter 不应把刷新长期挡住：等待超过冷却上限（4h）的一律放行。
  if (Number.isFinite(retryAt) && retryAt > now && retryAt - now <= MAX_DB_QUOTA_BACKOFF_MS) {
    return { skip: true, retryAt: new Date(retryAt).toISOString() };
  }
  const seen = typeof status.lastFailedAt === 'string' && Number.isFinite(Date.parse(status.lastFailedAt))
    ? new Date(Date.parse(status.lastFailedAt)).toISOString()
    : null;
  return { skip: false, quotaSeenAt: seen };
}

/**
 * 失败状态：沿用 refresh-failed 的两个单调计数（consecutive / firstFailedAt，跨两种失败态连续累计）。
 * quotaBackoffMs 非 null ⇒ 配额态：reason 固定为原因码、附 retryAfter；否则为原 refresh-failed 形态。
 */
export function buildFailureStatus(
  prevText: string | null, safeMessage: string, now: number, quotaBackoffMs: number | null,
): Record<string, unknown> {
  const prev = parseStatus(prevText);
  let consecutive = 1;
  let firstFailedAt = new Date(now).toISOString();
  if (prev && Number.isSafeInteger(prev.consecutive) && (prev.consecutive as number) > 0) {
    consecutive = (prev.consecutive as number) + 1;
    if (typeof prev.firstFailedAt === 'string') firstFailedAt = prev.firstFailedAt;
  }
  const lastFailedAt = new Date(now).toISOString();
  if (quotaBackoffMs === null) {
    return { state: 'refresh-failed', consecutive, firstFailedAt, lastFailedAt, reason: safeMessage };
  }
  return {
    state: QUOTA_STATE, consecutive, firstFailedAt, lastFailedAt,
    retryAfter: new Date(now + quotaBackoffMs).toISOString(), reason: 'db_quota_exceeded',
  };
}
