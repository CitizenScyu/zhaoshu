import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// audit-41 S5-1：cron_health 写/读。写路径必须幂等 upsert，且**写失败不能把 cron 打挂**
// （否则告警系统自己制造故障）。读路径缺行归一为 null。全部走 SQL 文本断言，不发真库。

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));

vi.mock('@/lib/db', () => ({ getSql: mocks.getSql }));

import {
  ADMISSION_ALERT_HOURS, CRON_ALERT_HOURS, DOWNLOAD_DONE_ALERT_HOURS, FANQIE_FAULT_ALERT_HOURS,
  LEDGER_SYNC_HEALTH_ROW, SHUYUAN_REFRESH_ALERT_HOURS,
  hoursSince, readAdmissionCheckedAgeHours, readCronSuccessTimes, readDownloadActivity, recordCronSuccess,
} from './source-health';
import { FANQIE_FAULT_HEALTH_ROW, FANQIE_FAULT_SINCE_HEALTH_ROW, FANQIE_OK_HEALTH_ROW } from './channel-health';

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

  it('阈值常数：三条 cron 均为每日一次 + 2h 容差 = 26h（Hobby 下间隔恒为 24h）', () => {
    // 判据钉在常数上：改 phoenix timer 的 OnCalendar 计划时必须同步改这里（与 workflow 里的数字一致）。
    // 「阈值必须 > 实际 cron 间隔」这条不变量由 src/lib/vercel-cron.test.ts 按表达式真算把关。
    expect(SHUYUAN_REFRESH_ALERT_HOURS).toBe(26);
    expect(CRON_ALERT_HOURS).toBe(26);
    // 42-admhealth：准入一天两轮（任一成功即刷新），30h = 一轮失败后最坏间隔 24h + 漂移余量。
    expect(ADMISSION_ALERT_HOURS).toBe(30);
    // fqhealth1111：下载线停摆 / 番茄渠道持续故障都按 6h 判（workflow 里复述同一组数字）。
    expect(DOWNLOAD_DONE_ALERT_HOURS).toBe(6);
    expect(FANQIE_FAULT_ALERT_HOURS).toBe(6);
  });

  // 探针在 workflow env 里复述同一组阈值。此前只靠两边注释「必须一致」，这里钉死（fqhealth1111）。
  it('探针 workflow 复述的阈值与这里的常数逐个一致', () => {
    const yml = readFileSync('.github/workflows/source-health.yml', 'utf8');
    const value = (name: string) => Number(yml.match(new RegExp(`^\\s+${name}: '(\\d+)'`, 'm'))?.[1]);
    expect({
      SHUYUAN_REFRESH_ALERT_HOURS: value('SHUYUAN_REFRESH_ALERT_HOURS'),
      CRON_ALERT_HOURS: value('CRON_ALERT_HOURS'),
      ADMISSION_ALERT_HOURS: value('ADMISSION_ALERT_HOURS'),
      DOWNLOAD_DONE_ALERT_HOURS: value('DOWNLOAD_DONE_ALERT_HOURS'),
      FANQIE_FAULT_ALERT_HOURS: value('FANQIE_FAULT_ALERT_HOURS'),
    }).toEqual({
      SHUYUAN_REFRESH_ALERT_HOURS, CRON_ALERT_HOURS, ADMISSION_ALERT_HOURS,
      DOWNLOAD_DONE_ALERT_HOURS, FANQIE_FAULT_ALERT_HOURS,
    });
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
      reclaim: null, drain: '2026-09-23T06:00:00.000Z', admission: null,
      followup: null, ledgerSync: null, dbQuotaSeenAt: null,
      fanqieOk: null, fanqieFault: null, fanqieFaultSince: null,
    });
    expect(sql).toHaveBeenCalledOnce();
  });

  it('readCronSuccessTimes 同一次查询带回 db_quota_exceeded 行（41-q402fix），不串进 cron 字段', async () => {
    const sql = sqlMock(async () => [
      { name: 'reclaim', last_success_at: '2026-09-23T05:00:00.000Z' },
      { name: 'db_quota_exceeded', last_success_at: '2026-09-25T03:43:00.000Z' },
    ]);
    mocks.getSql.mockReturnValue(sql);
    expect(await readCronSuccessTimes()).toEqual({
      reclaim: '2026-09-23T05:00:00.000Z', drain: null, admission: null,
      followup: null, ledgerSync: null, dbQuotaSeenAt: '2026-09-25T03:43:00.000Z',
      fanqieOk: null, fanqieFault: null, fanqieFaultSince: null,
    });
    expect(sql).toHaveBeenCalledOnce();
  });

  it('readCronSuccessTimes 带回 admission 成功行（42-admhealth），租约行 admission_lease 不串进来', async () => {
    const sql = sqlMock(async () => [
      { name: 'admission', last_success_at: '2026-09-27T14:02:00.000Z' },
      { name: 'admission_lease', last_success_at: '2026-09-27T14:59:29.000Z' },
    ]);
    mocks.getSql.mockReturnValue(sql);
    expect(await readCronSuccessTimes()).toMatchObject({ admission: '2026-09-27T14:02:00.000Z' });
    expect((await readCronSuccessTimes()).dbQuotaSeenAt).toBeNull();
  });

  // obsfix45：追更轮与台账同步的成功心跳行。同表的 followup_probe_lease 存的是**到期时刻**
  // （now()+TTL，未来时间），绝不能被当成 followup 的成功心跳——那正是本缺陷的原形态。
  it('readCronSuccessTimes 带回 followup 与 ledger_sync 行，两个租约行都不串进来', async () => {
    const sql = sqlMock(async () => [
      { name: 'followup', last_success_at: '2026-10-22T09:00:00.000Z' },
      { name: 'followup_probe_lease', last_success_at: '2026-10-22T09:30:50.000Z' },
      { name: LEDGER_SYNC_HEALTH_ROW, last_success_at: '2026-10-22T09:37:00.000Z' },
    ]);
    mocks.getSql.mockReturnValue(sql);
    expect(await readCronSuccessTimes()).toEqual({
      reclaim: null, drain: null, admission: null,
      followup: '2026-10-22T09:00:00.000Z',
      ledgerSync: '2026-10-22T09:37:00.000Z',
      dbQuotaSeenAt: null,
      fanqieOk: null, fanqieFault: null, fanqieFaultSince: null,
    });
  });

  it('recordCronSuccess 接受 followup（CronName 覆盖追更轮心跳行）', async () => {
    const sql = sqlMock(async () => []);
    mocks.getSql.mockReturnValue(sql);
    await recordCronSuccess('followup');
    expect(sql.mock.calls[0][1]).toBe('followup');
  });

  // fqhealth1111：番茄渠道三行同表同查询带回，只进各自字段，不冒充任何 cron 成功心跳。
  it('readCronSuccessTimes 带回番茄渠道心跳行（不串进 cron 字段）', async () => {
    const sql = sqlMock(async () => [
      { name: 'drain', last_success_at: '2026-11-11T06:00:00.000Z' },
      { name: FANQIE_OK_HEALTH_ROW, last_success_at: '2026-11-09T01:00:00.000Z' },
      { name: FANQIE_FAULT_HEALTH_ROW, last_success_at: '2026-11-11T05:00:00.000Z' },
      { name: FANQIE_FAULT_SINCE_HEALTH_ROW, last_success_at: '2026-11-09T02:00:00.000Z' },
    ]);
    mocks.getSql.mockReturnValue(sql);
    expect(await readCronSuccessTimes()).toEqual({
      reclaim: null, drain: '2026-11-11T06:00:00.000Z', admission: null,
      followup: null, ledgerSync: null, dbQuotaSeenAt: null,
      fanqieOk: '2026-11-09T01:00:00.000Z',
      fanqieFault: '2026-11-11T05:00:00.000Z',
      fanqieFaultSince: '2026-11-09T02:00:00.000Z',
    });
    expect(sql).toHaveBeenCalledOnce();
  });

  it('readDownloadActivity 一次查询带回最近完成时刻与「有活」任务数；空表归一', async () => {
    const sql = sqlMock(async () => [{ last_done_at: '2026-11-11T13:00:00.000Z', active_tasks: 31 }]);
    mocks.getSql.mockReturnValue(sql);
    expect(await readDownloadActivity()).toEqual({ lastDoneAt: '2026-11-11T13:00:00.000Z', activeTasks: 31 });
    expect(sql).toHaveBeenCalledOnce();
    const text = sql.mock.calls[0][0].join('?').replace(/\s+/g, ' ');
    expect(text).toContain("max(updated_at)::text FROM download_tasks WHERE status = 'done'");
    // 退避中的 pending 不算「有活」：只数 running 与已到重试时刻的 pending。
    expect(text).toContain("status = 'running' OR (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))");

    mocks.getSql.mockReturnValue(sqlMock(async () => [{ last_done_at: null, active_tasks: '0' }]));
    expect(await readDownloadActivity()).toEqual({ lastDoneAt: null, activeTasks: 0 });
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
