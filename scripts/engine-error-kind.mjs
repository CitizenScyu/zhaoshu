// engine-fetch 错误 → 稳定的错误类别（giveup41）。labeler 据此区分「源确定性失效」与「网络抖动」，
// 不再靠猜 stderr 文案。CLI 在 --json 模式下把类别写成 stderr 第二行 `{"errorKind":"…"}`
// （第一行仍是原先的 safeReason 原因，旧 labeler 只取摘要，不受影响）。
//
// 确定性（同一 URL 重试结果不变）：
//   policy     跨站跳转/策略拒绝（如 302 到准入外 host → SourcePolicyError）
//   http_4xx   源站 4xx（408/425/429 除外，它们是限流/超时类抖动）
//   no_source  URL 的 host 已不在引擎源池
// 抖动：timeout、http_5xx（含 408/425/429）。
// 其余：usage（参数/用法，退 2）、pool（源池/DB 不可用）、empty（无章/空正文/解析失败）、
//   miss（search 无候选）、partial（download 部分完成）、source_unavailable（download code=2：
//   源日限额/超时/断路器，可重试、零发布——属瞬时，不是部分完成）、other。
// 「哪些类别触发放弃」由 labeler 决定（labeler.py DETERMINISTIC_ENGINE_ERRORS），这里只负责分类。

const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429]);

/** download 非零 code → errorKind（engine-download.mjs 契约：1=部分完成，2=源不可用可重试）。 */
export function downloadErrorKind(code) {
  return code === 2 ? 'source_unavailable' : 'partial';
}

/**
 * @param error 抛到 CLI 顶层的错误
 * @param classes 已加载模块里的错误类（模块未加载时为空：只能按 kind/name 判）
 */
export function engineErrorKind(error, { SourcePolicyError, SourceHttpError } = {}) {
  if (error && typeof error.kind === 'string') return error.kind; // CLI 自己抛的 ExitError 显式标注
  if (SourcePolicyError && error instanceof SourcePolicyError) return 'policy';
  if (SourceHttpError && error instanceof SourceHttpError) {
    return error.status >= 500 || TRANSIENT_HTTP_STATUS.has(error.status) ? 'http_5xx' : 'http_4xx';
  }
  const name = error?.name;
  if (name === 'TimeoutError' || name === 'ConnectTimeoutError' || name === 'AbortError') return 'timeout';
  return 'other';
}
