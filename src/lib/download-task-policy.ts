// The worker pulses every 60 seconds, including retries, LLM checks and uploads.
// Keep the recovery margin well above its heartbeat/query budgets (test:contracts).
export const DOWNLOAD_TASK_STALE_MS = 30 * 60_000;

// 书源不可达（source_unavailable，41-EXEC-SRCUNAVAIL）不是终态：放回 pending，按 attempt_count
// 指数退避（15m、30m，之后每次 30m）；第 SOURCE_RETRY_MAX_ATTEMPTS（16）次领取仍不可达即落
// partial 终态，不再退避。累计退避 = 第 1–15 次逐次求和 = 15m+30m×14 = 7.25h，
// 由 download-task-policy.test.ts 按代码求和钉住。永久坏数据（如非 https 源地址）也因此有界。
// 2026-10-09 提速整改：封顶 6h → 30m。原 6h 封顶使 1500+ 无源任务每 6h 才重试一次，工人大量
// 空转（drain no-task），且瞬时不可达的源要等 6h 才被重试；改为 30m 后同一本书每小时可重试两次，
// 更快捞回瞬时恢复的源、也更快把真正无源的书推进终态。每 host QPS≤1 由共享限速器保证不变。
export const SOURCE_RETRY_BASE_DELAY_MS = 15 * 60_000;
export const SOURCE_RETRY_MAX_DELAY_MS = 30 * 60_000;
export const SOURCE_RETRY_MAX_ATTEMPTS = 16;

/**
 * 全池 0 候选（no_candidates）与「源瞬时不可达」是两回事，退避曲线必须分开（nocand42）。
 * 0 候选 = 选源器实探了整池（N 个源）、这本书一个都没有；瞬时不可达 = 源/网络正忙、池读不到、
 * 预算尽——这两种在旧版同归 source_unavailable，15m+30m×14 = 7.25h 就烧穿落 partial。
 * poolcap42 实测（2026-10-15）：POST 部署后 145 次 source_unavailable 里 140 次（96.6%）是真 0 候选。
 * 免费站的收录变化以天计，30 分钟重扫一轮纯属空烧：每本每轮约 110 次出网搜索，partial 2833 本在
 * 3 小时窗口里空烧约 7 万次。改 1h 起、×2 递增、4h 封顶，15 次累计 1h+2h+4h×13 = 55h（≈2.3 天），
 * 仍由 SOURCE_RETRY_MAX_ATTEMPTS 同一个上限收口，因此依旧有界。
 */
export const NO_CANDIDATE_RETRY_BASE_DELAY_MS = 60 * 60_000;
export const NO_CANDIDATE_RETRY_MAX_DELAY_MS = 4 * 60 * 60_000;

/** 退避曲线类别：no_candidates 走长曲线，其余（源瞬时不可达/发布失败）走 15m/30m 短曲线。 */
export type SourceRetryClass = 'no_candidates' | 'transient';

// 发布可重试失败（B2-03）：GitHub 写入中途失败（网络/限流/5xx）也不是终态——规范阶段半途失败会让
// 规范卷与 index.json 停在半新半旧，只有重跑才会收敛。worker 进程内失败与崩溃后被 reclaim 回收的
// system 任务都放回 pending，与书源不可达共用同一 attempt_count 阶梯（sourceRetryDelayMs）和同一上限：
// attempt_count 记的是「自动放回 pending 的总次数」，不分原因，总数封顶，重试因此有界。
export const PUBLICATION_RETRY_MAX_ATTEMPTS = SOURCE_RETRY_MAX_ATTEMPTS;

/** 第 attempt 次（1 起，即领取时的 attempt_count）不可达后的退避时长。 */
export function sourceRetryDelayMs(attempt: number, retryClass: SourceRetryClass = 'transient'): number {
  const exponent = Math.max(0, Math.min(Math.floor(attempt) - 1, 30));
  if (retryClass === 'no_candidates') {
    return Math.min(NO_CANDIDATE_RETRY_BASE_DELAY_MS * 2 ** exponent, NO_CANDIDATE_RETRY_MAX_DELAY_MS);
  }
  return Math.min(SOURCE_RETRY_BASE_DELAY_MS * 2 ** exponent, SOURCE_RETRY_MAX_DELAY_MS);
}
