import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// 本文件钉两条不变量，共用同一套 5 段表达式解析（避免两份「间隔」口径漂移）：
//   ① 每条 cron 每天触发 ≤ 1 次（Vercel Hobby 硬限制，违反即整次部署被拒，见下）；
//   ② 每条 cron 的告警阈值 > 它的实际触发间隔（见文件末用例，防「阈值与计划脱节」）。
//
// 阈值常量只从 source-health.ts 取，绝不在这里复述数字 —— 复述一次就是下一个「注释与代码相反」。
// source-health.ts 顶层 import './db'，这里 mock 掉，免得把 neon / 业务 schema 链拖进离线门禁；
// 本文件仍然不触网、不读 .env*。
vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('vercel-cron 门禁不应触库'); } }));

import { CRON_ALERT_HOURS, SHUYUAN_REFRESH_ALERT_HOURS } from './source-health';

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
//
// 关于「条数」：`b89f575`（2026-09-19）的提交信息写「Hobby 限每项目 2 个 cron」，
// 经查**不成立**——Vercel 官方文档表（https://vercel.com/docs/cron-jobs/usage-and-pricing，
// 2026-09-23 抓取）Hobby/Pro/Enterprise 均为 **100 cron jobs / 项目**；且本仓 3 条 cron 的
// `vercel.json` 已有多次成功上线的生产部署（最新 READY：`7786d38`，2026-09-22T11:57Z，
// `vercel inspect` 内联 `vercelConfig.crons` 实为 3 条）。故这里的条数上限取文档值 100，
// 而非误传的 2；cron 频率才是唯一的硬限制。

type Cron = { path: string; schedule: string };

/** Vercel 文档表：Hobby 计划每项目 cron 条数上限（2026-09-23 抓取核实）。 */
const HOBBY_MAX_CRON_JOBS = 100;

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

/** 该 cron 的平均触发间隔（小时）：按表达式真算 = 24 / 每天触发次数，**不写死 24**。
 *  日/月/周字段只会把触发**减少**到更低频（真实间隔更大），故该值是真实间隔的**下界**（最紧情形）；
 *  「阈值 > 下界」是最严要求，成立即任何日/月/周约束下都成立。 */
function intervalHours(schedule: string): number {
  return 24 / triggersPerDay(schedule);
}

/** 路径 → 告警阈值（允许的最大静默小时数）。与 src/lib/source-health.ts 同源（直接 import，
 *  不在本文件复述数字）。新增 cron 必须在此登记，否则用例会报「没有对应的告警阈值」。 */
const ALERT_HOURS_BY_PATH: Record<string, number> = {
  '/api/shuyuan': SHUYUAN_REFRESH_ALERT_HOURS,
  '/api/download/reclaim': CRON_ALERT_HOURS,
  '/api/profile/absorb/drain': CRON_ALERT_HOURS,
};

describe('vercel.json crons 离线门禁（Vercel Hobby：每条每天最多一次）', () => {
  it('每条 cron 都能解析成合法的 5 段表达式', () => {
    for (const { path, schedule } of config.crons) {
      expect(() => triggersPerDay(schedule), `路径 ${path} 的 schedule 非法: ${schedule}`).not.toThrow();
    }
  });

  it('保留 /api/shuyuan 入口（不被静默删掉）', () => {
    expect(config.crons.map((c) => c.path)).toContain('/api/shuyuan');
  });

  it(`cron 条数 ≤ ${HOBBY_MAX_CRON_JOBS}（Hobby 文档上限；「每项目 2 条」系误传）`, () => {
    expect(
      config.crons.length,
      `vercel.json 有 ${config.crons.length} 条 cron，超过 Hobby 文档上限 ${HOBBY_MAX_CRON_JOBS} 条 ` +
        `（https://vercel.com/docs/cron-jobs/usage-and-pricing，2026-09-23 核实）。` +
        `注意：b89f575 提交信息里的「每项目限 2 条」是误传——本仓 3 条 cron 已成功部署多次，` +
        `真正的硬限制是「每条每天一次」（见下一条用例）。`,
    ).toBeLessThanOrEqual(HOBBY_MAX_CRON_JOBS);
  });

  it.each(config.crons)('$path 每天触发 ≤ 1 次（Hobby 限制，违反即整次部署被拒）', ({ path, schedule }) => {
    const perDay = triggersPerDay(schedule);
    expect(
      perDay,
      `cron「${path}」的 schedule "${schedule}" 每天触发 ${perDay} 次 > 1 次。` +
        `Vercel 在部署前校验阶段直接拒绝，报错原文：` +
        `"Hobby accounts are limited to daily cron jobs. This cron expression would run more than once per day."` +
        `该错误只在 GitHub commit status 上留下 Vercel / failure / "Deployment failed."，` +
        `Vercel 侧不生成部署记录（vercel ls 查不到），极易被误判成「cron 没触发」。` +
        `本仓已被此坑击穿两次：2026-09-19 b89f575、2026-09-23 c26c3b8。` +
        `提交信息不是防线，这条测试才是。` +
        `需要更频繁消化队列请改用外部定时器（如 GitHub Actions 打 /api/shuyuan），不要把小时段写成列表。`,
    ).toBeLessThanOrEqual(1);
  });
});

describe('告警阈值 vs cron 计划 离线门禁（阈值必须 > 实际触发间隔）', () => {
  // 缺陷复盘：f474e27（告警线）按当时 master 的 `0 2,8,14,20`（每 6h）把
  //   SHUYUAN_REFRESH_ALERT_HOURS 定为 8；但 b561fba（cron 线，实际上更早）已把它改回
  //   每日一次 `0 2 * * *`。两条线各自都对，合起来 8h 阈值配上 HEALTH_URL 会**每天误报一次**。
  // 光把 8 改成 26 治不了本 —— 下次改 cron 计划还会脱节。所以把不变量钉进离线测试。
  it.each(config.crons)('$path 的告警阈值 > 其 cron 实际间隔', ({ path, schedule }) => {
    const threshold = ALERT_HOURS_BY_PATH[path];
    expect(
      threshold,
      `vercel.json 里的 cron「${path}」没有对应的告警阈值 —— 新增 cron 时必须同时在 ` +
        `src/lib/source-health.ts 定义阈值，并在本文件 ALERT_HOURS_BY_PATH 里登记。`,
    ).toBeTypeOf('number');

    const interval = intervalHours(schedule);
    expect(
      threshold,
      `cron「${path}」实际间隔约 ${interval}h（schedule "${schedule}"），但告警阈值只有 ${threshold}h。` +
        `阈值必须**大于**间隔，否则每次正常运行都会误报。Hobby 下每条 cron 每天只能一次` +
        `（间隔 24h），阈值应为 24h + 容差（本仓用 26h）。改 vercel.json 的 cron 计划时，` +
        `必须同步改 src/lib/source-health.ts 的阈值，以及 .github/workflows/source-health.yml ` +
        `里复述的同一组数字。`,
    ).toBeGreaterThan(interval);
  });
});
