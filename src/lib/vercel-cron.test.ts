import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// 离线 crons 门禁（同坑两犯，必须留闸）：
//
// 背景：Vercel **Hobby** 计划限制「每条 cron 每天只能触发一次」。表达式里时段带
// 列表/区间/步进（如 `0 2,8,14,20 * * *`）会让该 cron 每天触发多次，Vercel 在
// **部署前的配置校验阶段**直接拒绝整个 Deployment（`Vercel / failure /
// "Deployment failed."`），不生成任何部署记录 —— 于是 `vercel ls` 查不到、极易被
// 误判成「cron 没触发」。本仓 `b89f575`（2026-09-19）与 `c26c3b8`（2026-09-23）
// 已各踩一次：两次都是坏 cron 上了 master，把整条上线链路（任何基于 master 的
// push 都部署失败）卡死。所以这里把「每天最多一次」钉成离线门禁，防第三次。
//
// 门禁只看「分」「时」两段：日/月/周两段最多把触发**减少**到每周/每月一次，
// 不可能造成「同一天多次触发」，故无需参与计算。

type Cron = { path: string; schedule: string };

/** 展开单个 crontab 字段为「一天内命中该字段的取值个数」。 */
function fieldCardinality(field: string, lo: number, hi: number): number {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`非法步进: ${part}`);
    let start = lo;
    let end = hi;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      start = Number(bounds[0]);
      end = bounds.length > 1 ? Number(bounds[1]) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`非法取值: ${part}`);
    }
    if (start < lo || end > hi || start > end) throw new Error(`越界取值: ${part}`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size;
}

/** 该 cron 表达式一天内触发几次 = 分钟取值数 × 小时取值数。 */
function triggersPerDay(schedule: string): number {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 字段数应为 5，实为 ${fields.length}: ${schedule}`);
  return fieldCardinality(fields[0], 0, 59) * fieldCardinality(fields[1], 0, 23);
}

const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Cron[] };

describe('vercel.json crons 离线门禁（Vercel Hobby：每条每天最多一次）', () => {
  it('每条 cron 都能解析成合法的 5 段表达式', () => {
    for (const { path, schedule } of config.crons) {
      expect(() => triggersPerDay(schedule), `路径 ${path} 的 schedule 非法: ${schedule}`).not.toThrow();
    }
  });

  it('保留 /api/shuyuan 入口（不被静默删掉）', () => {
    expect(config.crons.map((c) => c.path)).toContain('/api/shuyuan');
  });

  it.each(config.crons)('$path 每天触发 ≤ 1 次（Hobby 限制，违反即整次部署被拒）', ({ path, schedule }) => {
    const perDay = triggersPerDay(schedule);
    expect(
      perDay,
      `cron「${path}」的 schedule "${schedule}" 每天触发 ${perDay} 次 > 1 次。` +
        `Vercel Hobby 计划规定每条 cron 每天只能触发一次，` +
        `否则部署在配置校验阶段就被拒（Vercel / failure / "Deployment failed."，无部署记录）。` +
        `参见 2026-09-19 b89f575 与 2026-09-23 c26c3b8 两次事故。` +
        `需要更频繁消化队列请改用外部定时器（如 GitHub Actions 打 /api/shuyuan），不要把小时段写成列表。`,
    ).toBeLessThanOrEqual(1);
  });
});
