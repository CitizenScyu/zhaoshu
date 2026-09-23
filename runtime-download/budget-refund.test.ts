// 41-EXEC-SRCUNAVAIL：日预算退还（书源不可达的尝试不计入每日领书额度）。
// 状态文件与 shell runtime/lib/daily-budget.mjs 同一份、同一格式（{date, used} + 换行，UTC 日）；
// 与兄弟仓真实实现的往返由 scripts/check-worker-contract.mjs 回归。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetRefund } from './budget-refund';

const TODAY = '2026-09-24';
const now = () => Date.parse(`${TODAY}T03:00:00.000Z`);

describe('日预算退还（41-EXEC-SRCUNAVAIL）', () => {
  let dir: string;
  let statePath: string;
  const write = (state: unknown) => writeFileSync(statePath, JSON.stringify(state) + '\n', 'utf8');
  const used = () => JSON.parse(readFileSync(statePath, 'utf8')).used as number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'budget-refund-'));
    statePath = join(dir, 'daily-budget.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('⑤ 幂等：同一次扣减重复退还只退一次（按票据键判重，不靠对象身份）', async () => {
    write({ date: TODAY, used: 3 });
    const refund = createBudgetRefund({ statePath, now });
    const ticket = { key: '14:1', date: TODAY };
    expect(await refund(ticket)).toBe('refunded');
    expect(used()).toBe(2);
    expect(await refund(ticket)).toBe('duplicate');
    expect(await refund({ ...ticket })).toBe('duplicate');
    expect(used()).toBe(2);
    // 同一任务下一次领取是新的扣减（generation 不同）：可以再退
    expect(await refund({ key: '14:2', date: TODAY })).toBe('refunded');
    expect(used()).toBe(1);
    // 写法与 shell consume 同形
    expect(readFileSync(statePath, 'utf8')).toBe(`{"date":"${TODAY}","used":1}\n`);
  });

  it('计数不减到负数：当日已为 0、文件缺失或坏 JSON 都不写入', async () => {
    const refund = createBudgetRefund({ statePath, now });
    write({ date: TODAY, used: 0 });
    expect(await refund({ key: '15:1', date: TODAY })).toBe('nothing_to_refund');
    expect(used()).toBe(0);
    rmSync(statePath);
    expect(await refund({ key: '15:2', date: TODAY })).toBe('nothing_to_refund');
    writeFileSync(statePath, '{bad json', 'utf8');
    expect(await refund({ key: '15:3', date: TODAY })).toBe('nothing_to_refund');
    expect(readFileSync(statePath, 'utf8')).toBe('{bad json');
  });

  it('跨 UTC 日不退：昨天的扣减不动今天的计数；文件还停在旧日也不写', async () => {
    const refund = createBudgetRefund({ statePath, now });
    write({ date: TODAY, used: 2 });
    expect(await refund({ key: '16:1', date: '2026-09-23' })).toBe('other_day');
    expect(used()).toBe(2);
    write({ date: '2026-09-23', used: 3 });
    expect(await refund({ key: '17:1', date: TODAY })).toBe('nothing_to_refund');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ date: '2026-09-23', used: 3 });
  });
});
