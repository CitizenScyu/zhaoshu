// T8 验收：withoutProcessSignals（发现 5 —— 常驻 drain 不累积 SIGINT/SIGTERM 监听）。
import { describe, expect, it } from 'vitest';
import { withoutProcessSignals } from './without-process-signals';

function makeProc() {
  const counts: Record<string, number> = {};
  const bump = (event: string | symbol, delta: number) => {
    const k = String(event);
    counts[k] = (counts[k] ?? 0) + delta;
    return proc as unknown as NodeJS.Process;
  };
  type L = (...args: unknown[]) => void;
  const proc = {
    on(event: string | symbol, _listener: L) { return bump(event, 1); },
    addListener(event: string | symbol, _listener: L) { return bump(event, 1); },
    off(event: string | symbol, _listener: L) { return bump(event, -1); },
    removeListener(event: string | symbol, _listener: L) { return bump(event, -1); },
  };
  return { proc, counts };
}

describe('withoutProcessSignals', () => {
  it('SIGINT/SIGTERM 注册被拦成 no-op，其它事件透传；调用后还原原始方法', async () => {
    const { proc, counts } = makeProc();
    const originalOn = proc.on;
    const originalOff = proc.off;
    const wrapped = withoutProcessSignals(async () => {
      proc.on('SIGINT', () => {});
      proc.addListener('SIGTERM', () => {});
      proc.on('message', () => {});
      proc.off('SIGINT', () => {});
    }, proc);
    await wrapped();
    expect(counts.SIGINT).toBeUndefined();
    expect(counts.SIGTERM).toBeUndefined();
    expect(counts.message).toBe(1);
    // outermost 退出后还原
    expect(proc.on).toBe(originalOn);
    expect(proc.off).toBe(originalOff);
  });

  it('fn 抛错也在 finally 还原（模拟 downloadBook 的 finally 未跑到）', async () => {
    const { proc, counts } = makeProc();
    const originalOn = proc.on;
    const leaky = withoutProcessSignals(async () => {
      proc.on('SIGINT', () => {}); // downloadBook 起手注册；下面抛错，其 finally 不会 off
      throw new Error('boom');
    }, proc);
    for (let i = 0; i < 5; i++) await leaky().catch(() => {});
    expect(counts.SIGINT).toBeUndefined(); // 5 次调用零累积
    expect(proc.on).toBe(originalOn); // 每次都还原
  });

  it('作用于真实 process：反复调用不累积 SIGINT/SIGTERM 监听', async () => {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const leaky = withoutProcessSignals(async () => {
      process.on('SIGINT', () => {});
      process.on('SIGTERM', () => {});
      throw new Error('boom'); // finally 不 off
    });
    for (let i = 0; i < 8; i++) await leaky().catch(() => {});
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });
});
