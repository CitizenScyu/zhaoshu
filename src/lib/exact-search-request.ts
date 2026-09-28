import { mergeAbortSignals, timeoutSignal } from '@/lib/abort-merge';

// 服务端最多 30 秒，额外留 5 秒给网络传输；响应头和 JSON 正文共享这一预算。
export const EXACT_SEARCH_TIMEOUT_MS = 35_000;

function cancelBody(response: Response) {
  // 清理不能阻塞超时恢复，底层 cancel 可能一直不落定或因流已锁定而失败。
  try { void response.body?.cancel().catch(() => {}); } catch { /* 已关闭 */ }
}

export async function fetchExactSearch(
  signal: AbortSignal,
  doFetch: (signal: AbortSignal) => Promise<Response>,
): Promise<{ response: Response; payload: unknown }> {
  const timeout = timeoutSignal(EXACT_SEARCH_TIMEOUT_MS);
  const merged = mergeAbortSignals([signal, timeout.signal]);
  let response: Response | undefined;
  const interrupted = () => merged.signal.reason?.name === 'TimeoutError'
    ? new Error('精确找书超时，请重试') : merged.signal.reason;
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(interrupted());
    if (merged.signal.aborted) { onAbort(); return; }
    merged.signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => merged.signal.removeEventListener('abort', onAbort);
  });
  void aborted.catch(() => {});
  try {
    merged.signal.throwIfAborted();
    const pending = doFetch(merged.signal).then((value) => {
      // 即使底层忽略 abort，迟到响应也只回收，不再读正文或更新页面。
      if (merged.signal.aborted) {
        cancelBody(value);
        throw interrupted();
      }
      response = value;
      return value;
    });
    const result = await Promise.race([pending, aborted]);
    const payload: unknown = await Promise.race([result.json().catch(() => null), aborted]);
    merged.signal.throwIfAborted();
    return { response: result, payload };
  } catch (error) {
    if (merged.signal.aborted) throw interrupted();
    throw error;
  } finally {
    removeAbort();
    timeout.dispose();
    merged.dispose();
    if (merged.signal.aborted && response) cancelBody(response);
  }
}
