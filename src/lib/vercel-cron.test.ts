import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// 调度门禁（2026-10-18 crons5 迁移）：调度唯一来源是 phoenix 的 systemd timer，
// 单元副本在 deploy/phoenix/。本文件钉三条不变量：
//   ① vercel.json 不得再有 crons —— 有就是与 phoenix timer 双跑（写库、扣预算、重复写 cron_health）；
//   ② 每个 timer 的 OnCalendar 都能解析，且其告警阈值 > 实际触发间隔；
//   ③ 每个 timer 对应 service 的 ExecStart 指向预期路由 —— 防 timer 改名/换路由后门禁脱节。
//
// 阈值常量只从 source-health.ts 取，绝不在这里复述数字 —— 复述一次就是下一个「注释与代码相反」。
// source-health.ts 顶层 import './db'，这里 mock 掉，免得把 neon / 业务 schema 链拖进离线门禁；
// 本文件仍然不触网、不读 .env*。
vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('vercel-cron 门禁不应触库'); } }));

import { ADMISSION_ALERT_HOURS, CRON_ALERT_HOURS, SHUYUAN_REFRESH_ALERT_HOURS } from './source-health';

const PHOENIX_DIR = 'deploy/phoenix';

const readUnit = (name: string) => readFileSync(`${PHOENIX_DIR}/${name}`, 'utf8');

/** 从单元文件里取出某条指令的**全部**取值（systemd 允许同名指令多次出现）。 */
function directiveValues(unit: string, key: string): string[] {
  return unit
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1).trim());
}

/**
 * `OnCalendar=` → 触发间隔（小时）。**只支持本仓实际在用的三种写法**，其余一律抛错：
 *   `*-*-* HH:MM:SS <TZ>`      每日一次 → 24h
 *   `*-*-* HH/M:MM:SS <TZ>`    每 M 小时一次 → M h（如准点的 `*-*-* 00/1:17:00 UTC`）
 * 段数、字面量以外的语法（列表、区间、`*~` 等）都属「解析不了」—— 抛错让用例红，
 * 绝不静默跳过：静默跳过等于把新写的计划放出门禁，正是本门禁要防的事。
 */
function intervalHoursFromOnCalendar(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  if (parts[0] !== '*-*-*') {
    throw new Error(`OnCalendar 的日期段只支持 \`*-*-*\`，收到 \`${parts[0]}\`（完整表达式：${expr}）`);
  }
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`OnCalendar 期望 \`*-*-* <时刻> [时区]\`，收到 ${parts.length - 1} 段时刻部分：${expr}`);
  }
  const m = /^(\d{1,2})(?:\/(\d{1,2}))?:(\d{2}):(\d{2})$/.exec(parts[1]);
  if (!m) throw new Error(`OnCalendar 的时刻段必须是 \`HH:MM:SS\` 或 \`HH/M:MM:SS\`，收到 \`${parts[1]}\``);

  const hour = Number(m[1]);
  const step = m[2] === undefined ? null : Number(m[2]);
  const minute = Number(m[3]);
  const second = Number(m[4]);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`OnCalendar 时刻越界：${parts[1]}`);
  if (step !== null && (step < 1 || step > 24)) throw new Error(`OnCalendar 的步进越界：${parts[1]}`);

  // 日/月/周段只会把触发**减少**到更低频，真实间隔只会更长；这里算的是最紧情形。
  return step ?? 24;
}

/** service 的 ExecStart 里的路由参数（`cron-call.sh <路由> <秒>` 形态）。 */
function routeFromExecStart(unit: string): string {
  const execStarts = directiveValues(unit, 'ExecStart');
  expect(execStarts, 'service 必须有且只有一条 ExecStart').toHaveLength(1);
  const m = /(?:^|\/)cron-call\.sh\s+(\S+)/.exec(execStarts[0]);
  if (!m) throw new Error(`ExecStart 不是 cron-call.sh 形态，无法取出路由：${execStarts[0]}`);
  return m[1];
}

type TimerSpec = {
  timer: string;
  alertHours: number;
  /** cron-call.sh 打 HTTP 路由（走 Next 路由的 maxDuration 预算）。 */
  route?: string;
  /** admrunner42 runner 形态：不打 HTTP 路由，直接调仓库里的 admitRows（§10.6 ④ 的有意偏离，见 deploy/phoenix/README.md）。 */
  runnerFragments?: string[];
};

const TIMERS: TimerSpec[] = [
  { timer: 'zhaoshu-cron-shuyuan.timer', alertHours: SHUYUAN_REFRESH_ALERT_HOURS, route: '/api/shuyuan' },
  { timer: 'zhaoshu-cron-reclaim.timer', alertHours: CRON_ALERT_HOURS, route: '/api/download/reclaim' },
  { timer: 'zhaoshu-cron-drain.timer', alertHours: CRON_ALERT_HOURS, route: '/api/profile/absorb/drain' },
  { timer: 'zhaoshu-admission.timer', alertHours: ADMISSION_ALERT_HOURS, runnerFragments: ['refresh-runner.mjs', '--admission'] },
];

describe('vercel.json 不得再有 crons（调度唯一来源 = phoenix timer）', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons?: unknown };

  it('crons 键不存在或为空数组', () => {
    const crons = config.crons ?? [];
    expect(
      Array.isArray(crons) ? crons.length : crons,
      'vercel.json 里仍有 crons：Vercel 侧部署的实例会按计划执行，与 phoenix 的 systemd timer **双跑**' +
        '（同一轮探测/回收写两遍库、扣两遍预算、cron_health 被两个来源交替刷新，判龄失去意义）。' +
        '调度唯一来源是 deploy/phoenix/zhaoshu-cron-*.timer 与 zhaoshu-admission.timer。',
    ).toEqual(0);
  });
});

describe('phoenix timer 的告警阈值 > 实际触发间隔（阈值必须留容差）', () => {
  // 缺陷复盘：f474e27（告警线）按当时 master 的 `0 2,8,14,20`（每 6h）把
  //   SHUYUAN_REFRESH_ALERT_HOURS 定为 8；但 b561fba（cron 线，实际上更早）已把它改回
  //   每日一次 `0 2 * * *`。两条线各自都对，合起来 8h 阈值配上 HEALTH_URL 会**每天误报一次**。
  // 光把 8 改成 26 治不了本 —— 下次改 cron 计划还会脱节。所以把不变量钉进离线测试。
  it.each(TIMERS)('$timer 的阈值 > 其 OnCalendar 间隔', ({ timer, alertHours }) => {
    const onCalendars = directiveValues(readUnit(timer), 'OnCalendar');
    expect(
      onCalendars.length,
      `${timer} 必须恰好有一条 OnCalendar（收到 ${onCalendars.length} 条；多条会让间隔无法唯一确定）`,
    ).toBe(1);

    const expr = onCalendars[0];
    let interval: number;
    try {
      interval = intervalHoursFromOnCalendar(expr);
    } catch (error) {
      throw new Error(
        `${timer} 的 OnCalendar=\`${expr}\` 解析失败：${(error as Error).message}。` +
          `本门禁只认本仓在用的写法（\`*-*-* HH:MM:SS [TZ]\` 与 \`*-*-* HH/M:MM:SS [TZ]\`）。` +
          `若确实要换语法，请同步扩 intervalHoursFromOnCalendar，不要为了让测试变绿而改测试。`,
      );
    }

    expect(
      alertHours,
      `${timer}（OnCalendar=\`${expr}\`）实际间隔 ${interval}h，但告警阈值只有 ${alertHours}h。` +
        `阈值必须**大于**间隔，否则每次正常运行都会误报。改 timer 计划时必须同步改 ` +
        `src/lib/source-health.ts 的阈值，以及 .github/workflows/source-health.yml 里复述的同一组数字。`,
    ).toBeGreaterThan(interval);
  });
});

describe('timer 与 service 的路由对得上（防改名/换路由后门禁脱节）', () => {
  const serviceOf = (timer: string) => timer.replace(/\.timer$/, '.service');

  it.each(TIMERS.filter((t) => t.route))('$timer 的 service 打 $route', ({ timer, route }) => {
    expect(
      routeFromExecStart(readUnit(serviceOf(timer))),
      `${serviceOf(timer)} 的 ExecStart 路由与本文件登记的 \`${route}\` 不一致。` +
        `改了路由就同步改这里的 TIMERS 表，否则「阈值 > 间隔」的结论会挂在错误的路由上。`,
    ).toBe(route);
  });

  it.each(TIMERS.filter((t) => t.runnerFragments))('$timer 的 service 是 runner 形态（不打 HTTP 路由）', ({ timer, runnerFragments }) => {
    const execStart = directiveValues(readUnit(serviceOf(timer)), 'ExecStart');
    expect(execStart).toHaveLength(1);
    for (const fragment of runnerFragments!) {
      expect(execStart[0]).toContain(fragment);
    }
    // 有意偏离架构书 §10.6 ④（准入也走 cron-call.sh 打路由）：现网是 admrunner42 runner，
    // 直接调仓库 admitRows、与路由共用 admission_lease，是唯一准入源。理由见 deploy/phoenix/README.md。
    // 若哪天收敛回路由形态，把这条断言删掉并把 TIMERS 里该行换成 route 形态。
    expect(execStart[0], '准入若改回 cron-call.sh 形态，请同步改本断言与 deploy/phoenix/README.md').not.toContain('cron-call.sh');
  });
});

describe('deploy/phoenix/ 目录完整性', () => {
  const onDisk = readdirSync(PHOENIX_DIR).filter((name) => /^zhaoshu-.*\.timer$/.test(name)).sort();

  it('目录里的每个 timer 都在门禁表里登记（新增 timer 必须同时定阈值）', () => {
    expect(onDisk).toEqual(TIMERS.map((t) => t.timer).sort());
  });

  it('每个 timer 都有配套的 service 副本', () => {
    const files = new Set(readdirSync(PHOENIX_DIR));
    for (const { timer } of TIMERS) {
      expect(files, `${timer} 缺配套的 ${timer.replace(/\.timer$/, '.service')}`).toContain(timer.replace(/\.timer$/, '.service'));
    }
  });
});
