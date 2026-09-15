// The worker pulses every 60 seconds, including retries, LLM checks and uploads.
// Keep the recovery margin well above its heartbeat/query budgets (test:contracts).
export const DOWNLOAD_TASK_STALE_MS = 30 * 60_000;
