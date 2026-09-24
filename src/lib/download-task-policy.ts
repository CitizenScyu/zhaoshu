// The worker pulses every 60 seconds, including retries, LLM checks and uploads.
// Keep the recovery margin well above its heartbeat/query budgets (test:contracts).
export const DOWNLOAD_TASK_STALE_MS = 30 * 60_000;

// 书源不可达（source_unavailable，41-EXEC-SRCUNAVAIL）不是终态：放回 pending，按 attempt_count
// 指数退避（15m、30m、1h、2h、4h，之后每次 6h）；第 SOURCE_RETRY_MAX_ATTEMPTS（16）次领取仍不可达即落
// partial 终态，不再退避。累计退避 = 第 1–15 次逐次求和 = 15m+30m+1h+2h+4h+6h×10 = 67.75h（约 2.8 天），
// 由 download-task-policy.test.ts 按代码求和钉住。永久坏数据（如非 https 源地址）也因此有界。
export const SOURCE_RETRY_BASE_DELAY_MS = 15 * 60_000;
export const SOURCE_RETRY_MAX_DELAY_MS = 6 * 60 * 60_000;
export const SOURCE_RETRY_MAX_ATTEMPTS = 16;

// 发布可重试失败（B2-03）：GitHub 写入中途失败（网络/限流/5xx）也不是终态——规范阶段半途失败会让
// 规范卷与 index.json 停在半新半旧，只有重跑才会收敛。worker 进程内失败与崩溃后被 reclaim 回收的
// system 任务都放回 pending，与书源不可达共用同一 attempt_count 阶梯（sourceRetryDelayMs）和同一上限：
// attempt_count 记的是「自动放回 pending 的总次数」，不分原因，总数封顶，重试因此有界。
export const PUBLICATION_RETRY_MAX_ATTEMPTS = SOURCE_RETRY_MAX_ATTEMPTS;

/** 第 attempt 次（1 起，即领取时的 attempt_count）不可达后的退避时长。 */
export function sourceRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(attempt) - 1, 30));
  return Math.min(SOURCE_RETRY_BASE_DELAY_MS * 2 ** exponent, SOURCE_RETRY_MAX_DELAY_MS);
}
