// 41-EXEC-SRCUNAVAIL：书源不可达退避窗口按代码逐次求和钉住（注释里的时长必须与这里一致）。
import { describe, expect, it } from 'vitest';
import { SOURCE_RETRY_MAX_ATTEMPTS, sourceRetryDelayMs } from './download-task-policy';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('书源不可达退避窗口（41-EXEC-SRCUNAVAIL）', () => {
  it('第 1–15 次退避 15m→30m×14，逐次求和 = 7.25h；第 16 次领取即落终态、不再退避', () => {
    // settleSourceUnavailable：attemptCount < SOURCE_RETRY_MAX_ATTEMPTS 才退避，等于上限即落 partial 终态。
    const delays = Array.from({ length: SOURCE_RETRY_MAX_ATTEMPTS - 1 }, (_, i) => sourceRetryDelayMs(i + 1));
    expect(delays.map(ms => ms / MINUTE)).toEqual([15, ...Array(14).fill(30)]);
    const total = delays.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(7.25 * HOUR);
  });

  it('退避封顶 30m，非法/越界 attempt 不产生负值或超上限的延迟', () => {
    expect(sourceRetryDelayMs(40)).toBe(30 * MINUTE);
    expect(sourceRetryDelayMs(0)).toBe(15 * MINUTE);
    expect(sourceRetryDelayMs(-3)).toBe(15 * MINUTE);
  });
});

// nocand42：全池 0 候选与瞬时不可达分成两条曲线，共用同一个 attempt 上限（都必有界）。
describe('全池 0 候选退避曲线（nocand42）', () => {
  it('1h 起、×2 递增、4h 封顶；15 次逐次求和 = 55h（≈2.3 天），第 16 次仍落终态', () => {
    const delays = Array.from({ length: SOURCE_RETRY_MAX_ATTEMPTS - 1 }, (_, i) =>
      sourceRetryDelayMs(i + 1, 'no_candidates'));
    expect(delays.map(ms => ms / HOUR)).toEqual([1, 2, ...Array(13).fill(4)]);
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(55 * HOUR);
  });

  it('封顶 4h：非法/越界 attempt 不产生负值或超上限的延迟', () => {
    expect(sourceRetryDelayMs(40, 'no_candidates')).toBe(4 * HOUR);
    expect(sourceRetryDelayMs(0, 'no_candidates')).toBe(HOUR);
    expect(sourceRetryDelayMs(-3, 'no_candidates')).toBe(HOUR);
  });

  it('两条曲线互不串扰：同一 attempt 上 0 候选恒 ≥ 瞬时不可达，瞬时曲线逐次值不变', () => {
    for (let attempt = 1; attempt <= SOURCE_RETRY_MAX_ATTEMPTS; attempt += 1) {
      expect(sourceRetryDelayMs(attempt, 'no_candidates')).toBeGreaterThan(sourceRetryDelayMs(attempt, 'transient'));
      expect(sourceRetryDelayMs(attempt, 'transient')).toBe(sourceRetryDelayMs(attempt));
    }
    // 0 候选曲线比旧曲线多出的累计时长（55h − 7.25h）就是这轮整改要省下的空烧窗口。
    const sum = (retryClass: 'no_candidates' | 'transient') =>
      Array.from({ length: SOURCE_RETRY_MAX_ATTEMPTS - 1 }, (_, i) => sourceRetryDelayMs(i + 1, retryClass))
        .reduce((total, ms) => total + ms, 0);
    expect(sum('transient')).toBe(7.25 * HOUR);
    expect(sum('no_candidates') - sum('transient')).toBe(47.75 * HOUR);
  });
});
