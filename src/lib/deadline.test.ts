import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeadline,
  DeadlineExceededError,
  MODEL_ROUTE_INTERNAL_BUDGET_MS,
  raceDeadline,
  WRITE_BACK_RESERVE_MS,
} from './deadline';

describe('createDeadline', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('starts with the full budget and returns the remaining amount as time passes', () => {
    const d = createDeadline(10_000);
    expect(d.remainingMs).toBe(10_000);
    expect(d.expired).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(d.remainingMs).toBe(8_000);
    expect(d.expired).toBe(false);
    d.dispose();
  });

  it('fails the deadline once the timer expends the budget', () => {
    const d = createDeadline(10_000);
    vi.advanceTimersByTime(10_000);
    expect(d.expired).toBe(true);
    expect(d.signal.aborted).toBe(true);
    expect(d.signal.reason).toBeInstanceOf(DeadlineExceededError);
    d.dispose();
  });

  it('dispose clears the timer', () => {
    const d = createDeadline(10_000);
    d.dispose();
    vi.advanceTimersByTime(20_000);
    expect(d.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('modelBudgetMs (no step can regain the whole budget)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('subtracts the write-back reserve and caps to the ceiling', () => {
    const d = createDeadline(285_000);
    const ceiling = 220_000;
    // 剩余 273s，但 ceiling 只在"扣除预留前"对余量封顶，所以结果 = ceiling(220s)
    expect(d.modelBudgetMs(ceiling)).toBe(ceiling);
    // 100s into the request, narrow remaining minus reserve drops below the ceiling
    vi.advanceTimersByTime(100_000);
    expect(d.modelBudgetMs(ceiling)).toBe(285_000 - 100_000 - WRITE_BACK_RESERVE_MS);
  });

  it('returns zero once not enough time remains to write back', () => {
    const d = createDeadline(30_000);
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    vi.advanceTimersByTime(30_000 - WRITE_BACK_RESERVE_MS); // 正好耗尽模型额度（余量只够写回）
    expect(d.modelBudgetMs(10_000)).toBe(0);
    expect(d.modelBudgetMs(0)).toBe(0);
    d.dispose();
  });

  it('returns zero after the deadline has expired', () => {
    const d = createDeadline(30_000);
    vi.advanceTimersByTime(30_000); // 预算耗尽
    expect(d.modelBudgetMs(10_000)).toBe(0);
    d.dispose();
  });

  it('never exceeds the ceiling even with ample remaining time', () => {
    const d = createDeadline(285_000);
    vi.advanceTimersByTime(1_000);
    expect(d.modelBudgetMs(10_000)).toBeLessThanOrEqual(10_000);
  });
});

describe('raceDeadline', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('rejects with DeadlineExceededError when the deadline expires before the task settles', async () => {
    const d = createDeadline(5_000);
    const pending = raceDeadline(d.signal, () => new Promise<string>(() => {}));
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    d.dispose();
  });

  it('resolves the task value before expiry, then clears the listener', async () => {
    const d = createDeadline(5_000);
    await expect(raceDeadline(d.signal, () => Promise.resolve(42))).resolves.toBe(42);
    expect(d.expired).toBe(false);
    d.dispose();
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const d = createDeadline(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(raceDeadline(d.signal, () => Promise.resolve(1))).rejects.toBeInstanceOf(DeadlineExceededError);
    d.dispose();
  });
});

describe('expired deadline constants', () => {
  it('keeps the model route internal budget strictly below the platform limit', () => {
    expect(MODEL_ROUTE_INTERNAL_BUDGET_MS).toBeLessThan(295_000);
  });

  // find / profile / feedback 的单步模型 ceiling 是 260_000（各路由内的 const，由路由测试
  // 断言实际下发的 totalTimeoutMs）。这里从 deadline 侧守住预算链：
  // 可用额 = 285s 内部预算 − 12s 写回预留 = 273s > 260s，且 ceiling + 写回 < 285s。
  it('allocates a 260s single-step ceiling inside the post-reserve budget', () => {
    const d = createDeadline(MODEL_ROUTE_INTERNAL_BUDGET_MS);
    expect(d.modelBudgetMs(260_000)).toBe(260_000);
    expect(d.modelBudgetMs(260_000)).toBeGreaterThan(220_000);
    expect(d.modelBudgetMs(260_000) + WRITE_BACK_RESERVE_MS).toBeLessThan(MODEL_ROUTE_INTERNAL_BUDGET_MS);
    d.dispose();
  });
});