import { describe, expect, it, vi } from 'vitest';

import {
  FANQIE_FAULT_HEALTH_ROW, FANQIE_FAULT_SINCE_HEALTH_ROW, FANQIE_OK_HEALTH_ROW,
  recordFanqieFault, recordFanqieOk,
} from './channel-health';

// fqhealth1111：番茄渠道心跳。fault_since 只在「自上次成功以来第一次故障」时落，成功即删——
// 探针用 fault - fault_since 判「故障持续多久没成功过」，这两条语义错一条就会漏报或常报。

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
const statements = (sql: ReturnType<typeof vi.fn<SqlTag>>) =>
  sql.mock.calls.map(([strings, ...values]) => ({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values }));

describe('channel-health (fqhealth1111)', () => {
  it('行名是库里的字面值（探针与端点都按它读）', () => {
    expect([FANQIE_OK_HEALTH_ROW, FANQIE_FAULT_HEALTH_ROW, FANQIE_FAULT_SINCE_HEALTH_ROW])
      .toEqual(['fanqie_ok', 'fanqie_fault', 'fanqie_fault_since']);
  });

  it('成功：upsert fanqie_ok 到 now()，再删 fault_since（故障区间结束）', async () => {
    const sql = vi.fn<SqlTag>(async () => []);
    await recordFanqieOk(sql);
    expect(statements(sql)).toEqual([
      {
        text: 'INSERT INTO cron_health (name, last_success_at) VALUES (?, now()) ON CONFLICT (name) DO UPDATE SET last_success_at = now()',
        values: ['fanqie_ok'],
      },
      { text: 'DELETE FROM cron_health WHERE name = ?', values: ['fanqie_fault_since'] },
    ]);
  });

  it('故障：upsert fanqie_fault；fault_since 只插不改（保留区间起点）', async () => {
    const sql = vi.fn<SqlTag>(async () => []);
    await recordFanqieFault(sql);
    expect(statements(sql)).toEqual([
      {
        text: 'INSERT INTO cron_health (name, last_success_at) VALUES (?, now()) ON CONFLICT (name) DO UPDATE SET last_success_at = now()',
        values: ['fanqie_fault'],
      },
      {
        text: 'INSERT INTO cron_health (name, last_success_at) VALUES (?, now()) ON CONFLICT (name) DO NOTHING',
        values: ['fanqie_fault_since'],
      },
    ]);
  });

  it('写失败原样抛给调用方（由番茄腿吞掉，见 fanqie-leg.ts health）', async () => {
    const sql = vi.fn<SqlTag>(async () => { throw new Error('db down'); });
    await expect(recordFanqieOk(sql)).rejects.toThrow('db down');
    await expect(recordFanqieFault(sql)).rejects.toThrow('db down');
  });
});
