// T8 接线：常驻 drain 服务里包住 engine-download 的 downloadBook，去掉它对 process 的
// SIGINT/SIGTERM 注册。
//
// 现役 downloadBook 每次调用都 `process.on('SIGINT'/'SIGTERM', stop)` 并在 finally `process.off`。
// CLI 一次性进程无碍；但常驻 drain 服务每本调用一次，若 finally 未跑到（如 openSync 抛错）
// 监听器会累积（EventEmitter 泄漏警告 + 越来越多的中止回调）。外部停机中止已由 hooks.signal
// （drain 注入）覆盖，进程级信号注册对本服务是多余且有害的。
//
// 做法：在调用窗口内把 process 对 SIGINT/SIGTERM 的 on/off/addListener/removeListener 拦成 no-op，
// 其余事件透传。**不改 engine-download.mjs 源**。并发前提：drain 单线程、并发=1（同一时刻只有一
// 次 downloadBook 在跑），用深度计数兜住极端重入，outermost 退出时才还原原始方法。

const SUPPRESSED = new Set(['SIGINT', 'SIGTERM']);

type ListenerMethod = (event: string | symbol, listener: (...args: unknown[]) => void) => NodeJS.Process;

interface Patchable {
  on: ListenerMethod;
  off: ListenerMethod;
  addListener: ListenerMethod;
  removeListener: ListenerMethod;
}

/**
 * 包一层：调用 fn 期间，对目标进程的 SIGINT/SIGTERM 注册/注销全部 no-op（返回进程本身以维持链式）。
 * fn 的其它行为不变；返回值/异常原样透传。并发=1 前提下安全；重入用深度计数兜底。
 */
export function withoutProcessSignals<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  proc: Patchable = process as unknown as Patchable,
): (...args: A) => Promise<R> {
  let depth = 0;
  let saved: Pick<Patchable, 'on' | 'off' | 'addListener' | 'removeListener'> | null = null;

  const install = () => {
    saved = { on: proc.on, off: proc.off, addListener: proc.addListener, removeListener: proc.removeListener };
    const wrap = (real: ListenerMethod): ListenerMethod =>
      function patched(this: unknown, event, listener) {
        if (typeof event === 'string' && SUPPRESSED.has(event)) return proc as unknown as NodeJS.Process;
        return real.call(proc, event, listener);
      };
    proc.on = wrap(saved.on);
    proc.addListener = wrap(saved.addListener);
    proc.off = wrap(saved.off);
    proc.removeListener = wrap(saved.removeListener);
  };

  const restore = () => {
    if (!saved) return;
    proc.on = saved.on;
    proc.off = saved.off;
    proc.addListener = saved.addListener;
    proc.removeListener = saved.removeListener;
    saved = null;
  };

  return async (...args: A): Promise<R> => {
    if (depth === 0) install();
    depth += 1;
    try {
      return await fn(...args);
    } finally {
      depth -= 1;
      if (depth === 0) restore();
    }
  };
}
