/** 共享读取的等待者与实际任务分开结算：取消等待不代表网络已经释放。 */
export interface ReaderPending<T> {
  signal: AbortSignal;
  wait(signal?: AbortSignal): Promise<T>;
}

export function readerPending<T>(run: (signal: AbortSignal) => Promise<T>, finished: () => void): ReaderPending<T> {
  const controller = new AbortController();
  let waiters = 0;
  let settled = false;
  // 延后一拍启动，让首个等待者先登记，且同步抛错也走实际任务收尾。
  const promise = Promise.resolve().then(() => run(controller.signal)).finally(() => {
    settled = true;
    finished();
  });
  // 即使调用方在登记前已取消，底层失败也必须有拒绝处理器。
  void promise.catch(() => {});
  return {
    signal: controller.signal,
    wait(signal) {
      signal?.throwIfAborted();
      waiters++;
      return new Promise<T>((resolve, reject) => {
        let done = false;
        const finish = (action: () => void) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', abort);
          waiters--;
          if (!waiters && !settled) controller.abort(new DOMException('No active readers', 'AbortError'));
          action();
        };
        const abort = () => finish(() => reject(signal!.reason));
        signal?.addEventListener('abort', abort, { once: true });
        promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        if (signal?.aborted) abort();
      });
    },
  };
}
