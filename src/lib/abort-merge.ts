/**
 * 手工合并多个 AbortSignal 的小工具（MS-23）。
 *
 * 不使用 `AbortSignal.any`：它要 Chrome 116 / Safari 17.4 以上，低于这个基线的浏览器
 * 里「找书」会直接抛异常。这里自己做等价的合并：监听每一个源 signal 的 abort，
 * 转发到一个 AbortController；结束时移除监听，避免 listener 跟着长寿命 signal 泄漏。
 */
export function mergeAbortSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  const forward = (source: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(source.reason);
  };

  for (const source of signals) {
    if (source.aborted) {
      forward(source);
      break;
    }
    const onAbort = () => forward(source);
    source.addEventListener('abort', onAbort);
    cleanups.push(() => source.removeEventListener('abort', onAbort));
  }

  const dispose = () => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  };
  return { signal: controller.signal, dispose };
}
