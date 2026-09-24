/**
 * 手工合并多个 AbortSignal 的小工具(MS-23)。
 *
 * 不使用 `AbortSignal.any`:它要 Chrome 116 / Safari 17.4 以上,低于这个基线的浏览器
 * 里「找书」会直接抛异常。这里自己做等价的合并:监听每一个源 signal 的 abort,
 * 转发到一个 AbortController;结束时移除监听,避免 listener 跟着长寿命 signal 泄漏。
 *
 * 中止即终态:一旦合并信号中止,内部立刻摘掉所有源监听——理由已经确定,再留监听只会
 * 挂在长寿命 signal 上。这样「信号已中止」的调用点即使拿不到 dispose 的时机
 * (owner-session.ts 里中止信号要活到响应体读完)也不会泄漏。正常路径上监听保留到
 * 调用方 dispose。
 */
export function mergeAbortSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  };

  const forward = (source: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(source.reason);
    dispose();
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

  return { signal: controller.signal, dispose };
}

/**
 * 手工实现的「N 毫秒后按 TimeoutError 中止」signal(替代 `AbortSignal.timeout`)。
 *
 * 两处细节都不是装饰:
 * 1. abort 的理由要是 name 为 `TimeoutError` 的 DOMException,与 `AbortSignal.timeout`
 *    一致:调用点靠这个 name 把「超时」和「用户取消」分开,给出不同的用户文案。
 * 2. 定时器必须能被调用方清掉。`AbortSignal.timeout` 的内建定时器在请求结束后仍会到期:
 *    一到点就 abort 那条已经返回、只是还没 drain 的响应流,浏览器于是给成功的请求记一条
 *    假的 `net::ERR_ABORTED`(同一个坑见 auth-client.ts:240 的正文)。所以返回 dispose(),
 *    调用方在请求真正结束时 `clearTimeout`。
 */
export function timeoutSignal(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`操作超时(${ms}ms)。`, 'TimeoutError'));
  }, ms);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}
