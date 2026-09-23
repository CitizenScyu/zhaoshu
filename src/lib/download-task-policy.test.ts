// 41-EXEC-SRCUNAVAIL：书源不可达退避窗口按代码逐次求和钉住（注释里的时长必须与这里一致）。
import { describe, expect, it } from 'vitest';
import { SOURCE_RETRY_MAX_ATTEMPTS, sourceRetryDelayMs } from './download-task-policy';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('书源不可达退避窗口（41-EXEC-SRCUNAVAIL）', () => {
  it('第 1–15 次退避 15m→30m→1h→2h→4h→6h×10，逐次求和 = 67.75h（约 2.8 天）；第 16 次领取即落终态、不再退避', () => {
    // settleSourceUnavailable：attemptCount < SOURCE_RETRY_MAX_ATTEMPTS 才退避，等于上限即落 partial 终态。
    const delays = Array.from({ length: SOURCE_RETRY_MAX_ATTEMPTS - 1 }, (_, i) => sourceRetryDelayMs(i + 1));
    expect(delays.map(ms => ms / MINUTE)).toEqual([15, 30, 60, 120, 240, ...Array(10).fill(360)]);
    const total = delays.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(67.75 * HOUR);
    expect(Math.round((total / (24 * HOUR)) * 10) / 10).toBe(2.8);
  });

  it('退避封顶 6h，非法/越界 attempt 不产生负值或超上限的延迟', () => {
    expect(sourceRetryDelayMs(40)).toBe(6 * HOUR);
    expect(sourceRetryDelayMs(0)).toBe(15 * MINUTE);
    expect(sourceRetryDelayMs(-3)).toBe(15 * MINUTE);
  });
});
