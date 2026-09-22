import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// audit-41 S5-1：cron_health 写/读。写路径必须幂等 upsert，且**写失败不能把 cron 打挂**
// （否则告警系统自己制造故障）。读路径缺行归一为 null。全部走 SQL 文本断言，不发真库。

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));

vi.mock('@/lib/db', () => ({ getSql: mocks.getSql }));

import {
  CRON_ALERT_HOURS, SHUYUAN_REFRESH_ALERT_HOURS,
  hoursSince, readAdmissionCheckedAgeHours, readCronSuccessTimes, recordCronSuccess,
} from './source-health';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

// 标签模板替身：签名与 neon 的 sql 调用形态一致，断言的是「真的发出了什么语句」。
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
const sqlMock = (impl: SqlTag) => vi.fn<SqlTag>(impl);

describe('source-health (S5-1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('阈值常数：shuyuan 6h 计划 + 2h 容差 = 8h；reclaim/drain 每日 + 2h = 26h', () => {
    // 判据钉在常数上：改 vercel.json 的 cron 计划时必须同步改这里（与 workflow 里的数字一致）。
    expect(SHUYUAN_REFRESH_ALERT_HOURS).toBe(8);
    expect(CRON_ALERT_HOURS).toBe(26);
  });

  it('recordCronSuccess 幂等 upsert 到 cron_health', async () => {
    const sql = sqlMock(async () => []);
    mocks.getSql.mockReturnValue(sql);
    await recordCronSuccess('reclaim');
    expect(sql).toHaveBeenCalledOnce();
    const text = sql.mock.calls[0][0].join('?').replace(/\s+/g, ' ').trim();
    expect(text).toMatch(/^INSERT INTO cron_health \(name, last_success_at\) VALUES \(\?, now\(\)\)/);
    expect(text).toContain('ON CONFLICT (name) DO UPDATE SET last_success_at = now()');
    expect(sql.mock.calls[0][1]).toBe('reclaim');
  });

  it('recordCronSuccess 写失败只记日志、不抛出（监控写入不能打挂 cron 本身）', async () => {
    const sql = sqlMock(async () => { throw new Error('db down'); });
    mocks.getSql.mockReturnValue(sql);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordCronSuccess('drain')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toBe('cron health write failed');
  });

  it('readCronSuccessTimes 一次查询读回两行；缺行归一为 null', async () => {
    const sql = sqlMock(async () => [{ name: 'drain', last_success_at: '2026-09-23T06:00:00.000Z' }]);
    mocks.getSql.mockReturnValue(sql);
    expect(await readCronSuccessTimes()).toEqual({
      reclaim: null, drain: '2026-09-23T06:00:00.000Z',
    });
    expect(sql).toHaveBeenCalledOnce();
  });

  it('readAdmissionCheckedAgeHours 取 MAX 并换算成小时；空表为 null', async () => {
    const sql = sqlMock(async () => [{ max_checked_at: new Date(NOW - 5 * 3_600_000).toISOString() }]);
    mocks.getSql.mockReturnValue(sql);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(await readAdmissionCheckedAgeHours()).toBe(5);
    vi.useRealTimers();

    mocks.getSql.mockReturnValue(sqlMock(async () => [{ max_checked_at: null }]));
    expect(await readAdmissionCheckedAgeHours()).toBeNull();
  });

  it('hoursSince 与 shuyuan.ts 同口径：0.1h 取整、未来时间夹到 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(hoursSince(NOW)).toBe(0);
    expect(hoursSince(NOW - 3.24 * 3_600_000)).toBe(3.2);
    expect(hoursSince(NOW + 3_600_000)).toBe(0); // 时钟回拨 ⇒ 不报负数
    vi.useRealTimers();
  });
});
