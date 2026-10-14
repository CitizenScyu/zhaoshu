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
