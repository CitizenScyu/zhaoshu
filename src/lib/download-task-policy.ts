// The worker pulses every 60 seconds, including retries, LLM checks and uploads.
// Keep the recovery margin well above its heartbeat/query budgets (test:contracts).
export const DOWNLOAD_TASK_STALE_MS = 30 * 60_000;

// 书源不可达（source_unavailable，41-EXEC-SRCUNAVAIL）不是终态：放回 pending，按 attempt_count
// 指数退避（15m、30m、1h、2h、4h，之后每次 6h）；第 SOURCE_RETRY_MAX_ATTEMPTS 次仍不可达才落
// partial 终态，约 2.8 天后停止自动重试。永久坏数据（如非 https 源地址）也因此有界。
export const SOURCE_RETRY_BASE_DELAY_MS = 15 * 60_000;
export const SOURCE_RETRY_MAX_DELAY_MS = 6 * 60 * 60_000;
export const SOURCE_RETRY_MAX_ATTEMPTS = 16;

/** 第 attempt 次（1 起，即领取时的 attempt_count）不可达后的退避时长。 */
export function sourceRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(attempt) - 1, 30));
  return Math.min(SOURCE_RETRY_BASE_DELAY_MS * 2 ** exponent, SOURCE_RETRY_MAX_DELAY_MS);
}
