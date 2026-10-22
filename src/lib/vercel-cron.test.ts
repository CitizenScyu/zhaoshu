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
// shuyuan-refresh/deploy 是同一批单元的第二个入仓副本（README:灾备按它重建）。
// 2026-10-22 实测教训：admission.timer 在该副本仍是旧 2h 口径而现网已 1h——灾备按旧副本
// 重建会把准入降频一半且门禁不覆盖。故门禁必须覆盖两个目录、并钉两副本 OnCalendar 一致。
const REFRESH_DIR = 'shuyuan-refresh/deploy';

const readUnit = (name: string) => readFileSync(`${PHOENIX_DIR}/${name}`, 'utf8');
const readRefreshUnit = (name: string) => readFileSync(`${REFRESH_DIR}/${name}`, 'utf8');

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
 *   `*:0/S`                    每 S 分钟一次（整点起等步进）→ S/60 h（如 `*:0/30` → 0.5）
 * 段数、字面量以外的语法（列表、区间、`*~`、非整点起的分钟步进 `*:15/10` 等）都属
 * 「解析不了」—— 抛错让用例红，绝不静默跳过：静默跳过等于把新写的计划放出门禁，
 * 正是本门禁要防的事。
 */
export function intervalHoursFromOnCalendar(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 1) {
    // 第三种形态：`*:0/S`（小时段 `*`、分钟段 `0/S`，S=1..59）。只认从整点 0 分起的等步进，
    // 其他分钟写法（`*:15/10` 等）照旧抛错——它们的首次触发时刻与步进的关系需要另算，不猜。
    const minuteStep = /^\*:(\d{1,2})\/(\d{1,2})$/.exec(parts[0]);
    if (!minuteStep) {
      throw new Error(`OnCalendar 解析不了：\`${expr}\`。本门禁只认 \`*-*-* HH:MM:SS [TZ]\`、\`*-*-* HH/M:MM:SS [TZ]\` 与 \`*:0/S\``);
    }
    const minute = Number(minuteStep[1]);
    const step = Number(minuteStep[2]);
    if (minute !== 0) throw new Error(`OnCalendar 分钟步进只认从整点起的 \`*:0/S\`，收到 \`${parts[0]}\`（完整表达式：${expr}）`);
    if (minute > 59 || step < 1 || step > 59) throw new Error(`OnCalendar 的分钟步进越界：${parts[0]}`);
    return step / 60;
  }
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
  /** OnCalendar 用 systemd 关键字而非显式表达式（如 `hourly`）时，在此登记等价小时数。 */
  onCalendarKeyword?: 'hourly';
  /** OnCalendar 用时刻列表形态（如 `*:07,37:00`）时，在此登记列表原文；间隔取相邻两项最小差。 */
  onCalendarList?: string[];
};

const TIMERS: TimerSpec[] = [
  { timer: 'zhaoshu-cron-shuyuan.timer', alertHours: SHUYUAN_REFRESH_ALERT_HOURS, route: '/api/shuyuan' },
  { timer: 'zhaoshu-cron-reclaim.timer', alertHours: CRON_ALERT_HOURS, route: '/api/download/reclaim' },
  { timer: 'zhaoshu-cron-drain.timer', alertHours: CRON_ALERT_HOURS, route: '/api/profile/absorb/drain' },
  { timer: 'zhaoshu-cron-followup.timer', alertHours: CRON_ALERT_HOURS, route: '/api/followup' },
  { timer: 'zhaoshu-admission.timer', alertHours: ADMISSION_ALERT_HOURS, runnerFragments: ['refresh-runner.mjs', '--admission'] },
  // 2026-10-22 补登记：现网已在跑、副本已入仓但此前未受门禁覆盖的四个 timer。
  { timer: 'zhaoshu-admission-confirm.timer', alertHours: ADMISSION_ALERT_HOURS, route: '/api/shuyuan/admission', onCalendarKeyword: 'hourly' },
  { timer: 'zhaoshu-pool-artifact.timer', alertHours: CRON_ALERT_HOURS, onCalendarList: ['*-*-*', '*:07,37:00'] },
  { timer: 'zhaoshu-repo-rollover.timer', alertHours: CRON_ALERT_HOURS, runnerFragments: ['repo-auto-create.mjs', 'sync-ledger-capacity.mjs'] },
  // 相对触发形态（OnBootSec/OnUnitActiveSec，无 OnCalendar）：不受「阈值 > 间隔」断言，
  // 但登记在此让目录完整性用例覆盖、runnerFragments 钉住 ExecStart 不会静默换目标。
  { timer: 'zhaoshu-pool-sync-copy.timer', alertHours: 0, runnerFragments: ['pool-artifact.json'] },
  { timer: 'zhaoshu-download-b-reclaim.timer', alertHours: 0, runnerFragments: ['reclaim.mjs'] },
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

describe('intervalHoursFromOnCalendar：`*:0/S` 分钟步进形态（syncph42）', () => {
  it('`*:0/30` → 0.5h，26h 阈值 > 0.5h 间隔（followup timer 的实际形态）', () => {
    expect(intervalHoursFromOnCalendar('*:0/30')).toBe(0.5);
    expect(CRON_ALERT_HOURS).toBeGreaterThan(intervalHoursFromOnCalendar('*:0/30'));
  });

  it('`*:0/59` → 59/60h（合法区间上界）；`*:0/1` → 1/60h（下界）', () => {
    expect(intervalHoursFromOnCalendar('*:0/59')).toBeCloseTo(59 / 60);
    expect(intervalHoursFromOnCalendar('*:0/1')).toBeCloseTo(1 / 60);
  });

  it('非整点起的分钟步进（`*:15/10`）抛错——只认从整点 0 分起', () => {
    expect(() => intervalHoursFromOnCalendar('*:15/10')).toThrow(/分钟步进只认从整点起/);
  });

  it('分钟步进越界（`*:0/60`）与非法写法（`*:30`、`*-*-* 01:00:00` 缺日段时的第三段乱写）照旧抛错', () => {
    expect(() => intervalHoursFromOnCalendar('*:0/60')).toThrow(/越界/);
    expect(() => intervalHoursFromOnCalendar('*:30')).toThrow(/解析不了/);
  });

  it('既有两种形态语义不变：`*-*-* 05:30:00 Asia/Shanghai` → 24h、`*-*-* 00/1:17:00 UTC` → 1h', () => {
    expect(intervalHoursFromOnCalendar('*-*-* 05:30:00 Asia/Shanghai')).toBe(24);
    expect(intervalHoursFromOnCalendar('*-*-* 00/1:17:00 UTC')).toBe(1);
  });
});

describe('phoenix timer 的告警阈值 > 实际触发间隔（阈值必须留容差）', () => {
  // 缺陷复盘：f474e27（告警线）按当时 master 的 `0 2,8,14,20`（每 6h）把
  //   SHUYUAN_REFRESH_ALERT_HOURS 定为 8；但 b561fba（cron 线，实际上更早）已把它改回
  //   每日一次 `0 2 * * *`。两条线各自都对，合起来 8h 阈值配上 HEALTH_URL 会**每天误报一次**。
  // 光把 8 改成 26 治不了本 —— 下次改 cron 计划还会脱节。所以把不变量钉进离线测试。

  it.each(TIMERS.filter((t) => t.alertHours > 0))('$timer 的阈值 > 其 OnCalendar 间隔', ({ timer, alertHours, onCalendarKeyword, onCalendarList }) => {
    const onCalendars = directiveValues(readUnit(timer), 'OnCalendar');
    expect(
      onCalendars.length,
      `${timer} 必须恰好有一条 OnCalendar（收到 ${onCalendars.length} 条；多条会让间隔无法唯一确定）`,
    ).toBe(1);

    const expr = onCalendars[0];
    let interval: number;
    try {
      if (onCalendarKeyword) {
        // systemd 关键字形态：等价小时数由登记方声明（hourly→1h），写错登记就测不出——
        // 所以这里同时反向断言关键字本身没拼错。
        if (expr !== onCalendarKeyword) throw new Error(`OnCalendar=\`${expr}\` 与登记的关键字 \`${onCalendarKeyword}\` 不符`);
        interval = onCalendarKeyword === 'hourly' ? 1 : 0;
      } else if (onCalendarList) {
        // 时刻列表形态（带日期段，如 `*-*-* *:07,37:00`）：登记两段原文，间隔取相邻最小差。
        const joined = onCalendarList.join(' ');
        if (expr !== joined) throw new Error(`OnCalendar=\`${expr}\` 与登记的列表 \`${joined}\` 不符`);
        const listMatch = /^\*:(\d{1,2}(?:,\d{1,2})+):(\d{2})$/.exec(onCalendarList[1]);
        if (!listMatch) throw new Error(`登记的分钟列表 \`${onCalendarList[1]}\` 不是 \`*:M1,M2,…:SS\` 形态`);
        const minutes = listMatch[1].split(',').map(Number).sort((a, b) => a - b);
        let minDiff = minutes[minutes.length - 1] - minutes[0] + 60;
        for (let i = 1; i < minutes.length; i += 1) {
          minDiff = Math.min(minDiff, minutes[i] - minutes[i - 1]);
        }
        interval = minDiff / 60;
      } else if (/^\*:\d{1,2}:\d{2}$/.test(expr.split(/\s+/)[1] ?? '')) {
        // `*-*-* *:MM:SS`：每小时固定时刻 → 1h（如 repo-rollover 的 `*-*-* *:37:00`）。
        interval = 1;
      } else {
        interval = intervalHoursFromOnCalendar(expr);
      }
    } catch (error) {
      throw new Error(
        `${timer} 的 OnCalendar=\`${expr}\` 解析失败：${(error as Error).message}。` +
          `本门禁只认本仓在用的写法（\`*-*-* HH:MM:SS [TZ]\`、\`*-*-* HH/M:MM:SS [TZ]\`、\`*:0/S\`、\`*:M1,M2:SS\` 与关键字 hourly）。` +
          `若确实要换语法，请同步扩本 describe 的解析逻辑，不要为了让测试变绿而改测试。`,
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
    // ExecStart 与 ExecStartPost 都算启动指令（repo-rollover 的 ledger sync 在 Post 里）。
    const allExec = [
      ...directiveValues(readUnit(serviceOf(timer)), 'ExecStart'),
      ...directiveValues(readUnit(serviceOf(timer)), 'ExecStartPost'),
    ];
    expect(allExec.length, `${serviceOf(timer)} 必须至少一条启动指令`).toBeGreaterThanOrEqual(1);
    for (const fragment of runnerFragments!) {
      expect(
        allExec.join('\n'),
        `${serviceOf(timer)} 的启动指令缺片段 \`${fragment}\`（F1 续期/切仓探测靠它）`,
      ).toContain(fragment);
    }
    // 有意偏离架构书 §10.6 ④（准入也走 cron-call.sh 打路由）：现网是 admrunner42 runner，
    // 直接调仓库 admitRows、与路由共用 admission_lease，是唯一准入源。理由见 deploy/phoenix/README.md。
    // 若哪天收敛回路由形态，把这条断言删掉并把 TIMERS 里该行换成 route 形态。
    expect(allExec.join('\n'), 'runner 形态若改回 cron-call.sh，请同步改本断言与 deploy/phoenix/README.md').not.toContain('cron-call.sh');
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

describe('shuyuan-refresh/deploy 副本与 deploy/phoenix 逐字一致（灾备按任一副本重建须等价）', () => {
  // 该目录的 admission 单元是 admrunner42 时期部署的、pool-artifact 单元也在现网。
  // zhaoshu-shuyuan-refresh.timer 已退役（2026-10-22 核实现网无此 unit，刷新轮由
  // deploy/phoenix/zhaoshu-cron-shuyuan.timer 每日 10:00 路由形态承担），
  // 该目录残留的旧副本仅作历史参照，不进对照表。
  // 两副本漂移的实害：README 的灾备部署命令直接 scp 本目录文件，旧口径会静默降频准入。
  const REFRESH_TIMERS = ['zhaoshu-admission.timer', 'zhaoshu-pool-artifact.timer'];

  it('目录里的 timer 集合与登记一致（新增/删除须同步本表；shuyuan-refresh.timer 是退役残留不数）', () => {
    const retired = new Set(['zhaoshu-shuyuan-refresh.timer']);
    const onDisk = readdirSync(REFRESH_DIR).filter((name) => /^zhaoshu-.*\.timer$/.test(name) && !retired.has(name)).sort();
    expect(onDisk).toEqual([...REFRESH_TIMERS].sort());
  });

  it.each(REFRESH_TIMERS)('%s 的 OnCalendar 与 deploy/phoenix 同名单元逐字一致', (timer) => {
    const phoenixExpr = directiveValues(readUnit(timer), 'OnCalendar');
    const refreshExpr = directiveValues(readRefreshUnit(timer), 'OnCalendar');
    expect(phoenixExpr, `${PHOENIX_DIR}/${timer} 必须恰好一条 OnCalendar`).toHaveLength(1);
    expect(refreshExpr, `${REFRESH_DIR}/${timer} 必须恰好一条 OnCalendar`).toHaveLength(1);
    expect(
      refreshExpr[0],
      `${REFRESH_DIR}/${timer} 的 OnCalendar=\`${refreshExpr[0]}\` 与 ${PHOENIX_DIR} 的 \`${phoenixExpr[0]}\` 不一致。` +
        `灾备按 README 用 shuyuan-refresh/deploy 重建时会部署出不同频率;以现网为准回写本副本。`,
    ).toBe(phoenixExpr[0]);
  });

  it('admission.service 两副本 ExecStart 逐字一致（40→80 探针数差异于 2026-10-22 修齐）', () => {
    expect(directiveValues(readRefreshUnit('zhaoshu-admission.service'), 'ExecStart'))
      .toEqual(directiveValues(readUnit('zhaoshu-admission.service'), 'ExecStart'));
  });
});
