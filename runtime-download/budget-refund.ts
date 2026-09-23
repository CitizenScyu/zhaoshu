// 41-EXEC-SRCUNAVAIL：书源不可达（source_unavailable）的尝试退还日预算。
//
// 状态文件与 shell runtime/lib/daily-budget.mjs 同一份（main.mjs 的 join(stateDir,'daily-budget.json')，
// 由打包注入的 budgetStatePath 传入）、同一格式（{date, used} + 换行，date 为 UTC 日）、同一写口径
// （mkdir + writeFile，无独立锁）：并发安全的前提与 shell consume 相同——单实例锁 + drain 并发=1，
// 退还与扣减在同一次 runOnce 里先后发生，不存在并发写者。与兄弟仓真实实现的往返由
// scripts/check-worker-contract.mjs 回归。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BudgetTicket {
  /** 一次扣减的身份：任务 id + 租约 generation（每次领取唯一）。 */
  key: string;
  /** 扣减发生的 UTC 日（shell consume 回传的 date）。 */
  date: string;
}

export type BudgetRefundOutcome = 'refunded' | 'duplicate' | 'other_day' | 'nothing_to_refund';

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createBudgetRefund({ statePath, now = () => Date.now() }: { statePath: string; now?: () => number }) {
  let day = '';
  const refunded = new Set<string>();
  return async function refund(ticket: BudgetTicket): Promise<BudgetRefundOutcome> {
    const today = utcDay(now());
    if (day !== today) { refunded.clear(); day = today; }
    if (refunded.has(ticket.key)) return 'duplicate'; // 同一次扣减只退一次
    if (ticket.date !== today) return 'other_day'; // 跨 UTC 日：当日计数与那次扣减无关
    let used = 0;
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      // 与 shell read() 同口径：非当日/坏 JSON/无文件都当作当日零本。
      if (raw && typeof raw === 'object' && raw.date === today && Number.isFinite(raw.used)) used = raw.used;
    } catch {
      /* 无文件/坏 JSON */
    }
    if (used <= 0) return 'nothing_to_refund'; // 计数不减到负数
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ date: today, used: used - 1 }) + '\n', 'utf8');
    refunded.add(ticket.key);
    return 'refunded';
  };
}
