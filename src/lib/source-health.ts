import { getSql } from './db';
import { DB_QUOTA_HEALTH_ROW } from './db-quota';
import { FANQIE_FAULT_HEALTH_ROW, FANQIE_FAULT_SINCE_HEALTH_ROW, FANQIE_OK_HEALTH_ROW } from './channel-health';

// 源池 / cron 健康观测（audit-41 S5-1）。三条 Vercel cron（shuyuan / reclaim / drain）
// 失败时此前零告警通道——2026-09-21 源池停摆 10 小时，靠人肉盯 refreshed_at 才发现。
// 本文件是健康端点 /api/health/sources 的唯一数据来源；探针（GitHub Actions）只读那个端点。
//
// 阈值集中在这里一处（探针侧在 workflow 里复述同一组数字，两边必须一致；source-health.test.ts 逐个比对钉死）。
// 判据 =「该 cron 的计划间隔 + 2h 容差」：漏掉一次计划运行后不久即暴露，而不是拖到第二天。
//
// ⚠️ 不变量：**每条 cron 的告警阈值必须 > 它在 phoenix systemd timer 里的实际触发间隔**。
// 调度唯一来源是 phoenix 的 systemd timer（deploy/phoenix/，2026-10-18 crons5 起 vercel.json
// 已无 crons）：shuyuan / reclaim / drain / followup 的间隔恒为 24h（followup 为 0.5h），
// shuyuan 阈值一律 = 24h + 2h 容差 = 26h（followup 沿用 26h，远大于 0.5h）。
// CRON_ALERT_HOURS 同时是 followup（0.5h）与台账同步（1h）的阈值：对这两条亚日级 timer，26h
// 意味着**最坏 26h 才发现停摆**，是有意选的宽松值——它们守的故障各有余裕（追更下一轮就能补上、
// 准入续期有 30 天窗口），收紧到 2h 只会把单次上游抖动变成告警噪声。
// shuyuan 原为 8h —— f474e27 定该值时调度还是每 6h 的 `0 2,8,14,20`，但 b561fba（实际上更早）
// 已把调度改回每日一次 `0 2 * * *`，两条线各自都对、合起来 8h 阈值配上 HEALTH_URL 会**每天误报**。
// 改 phoenix timer 的 OnCalendar 计划时必须同步改这里与 workflow 里的数字；`src/lib/vercel-cron.test.ts`
// 有一条离线门禁按 OnCalendar 表达式真算间隔、比对这里的常数，脱节即红（防下次再靠人记）。
export const SHUYUAN_REFRESH_ALERT_HOURS = 26;
export const CRON_ALERT_HOURS = 26;
// 42-admhealth：准入成功行 name='admission' 的判龄阈值。一天两轮（02:00 刷新尾部 + 14:00 独立轮）
// 任一成功即刷新该行，正常刷新间隔 12h；30h = 一轮整体失败后的最坏间隔（24h）+ Hobby cron 小时级
// 漂移与探针采样（3h 一次）余量。比 26h 宽是为了「一轮失败不告警、两轮都失败才告警」。
export const ADMISSION_ALERT_HOURS = 30;
// fqhealth1111：下载线与番茄渠道的告警阈值（探针侧同样复述，两边必须一致）。都只透传、不进 ok。
// 下载线：有活（running 或已到重试时刻的 pending）却 6h 没有一本完成 = 停摆（worker 全挂 / 每本都失败 /
// 全卡住）。必须同时看「有活」：近两周完成间隔的最大值 12h、9.9h 都出现在队列空着的时候。
export const DOWNLOAD_DONE_ALERT_HOURS = 6;
// 番茄渠道：自上次成功以来的通道故障持续 ≥6h（期间零成功）。熔断每 3h 放行一次，6h ≈ 熔断后又连败两轮。
export const FANQIE_FAULT_ALERT_HOURS = 6;

/**
 * 台账同步（zhaoshu-repo-rollover.timer 的 ExecStartPost，每小时一轮）的成功行名。
 * 该行由 scripts/sync-ledger-capacity.mjs 自己写（脚本自包含、不 import TS，故行名在这里
 * 与脚本里各写一次字面值——改一处必须改两处，本仓无编译期手段可钉）。
 * 为什么要有它：那个 timer 承担 F1 准入续期（每轮把 ready+granted 行的 admission_valid_until
 * 顺延 30 天）。它停摆 = 30 天后 2026-11-12 那种「三仓准入同时到期、发布全停」的悬崖重现，
 * 而库里没有任何别的东西会因为「没续期」而变陈旧到可观测。
 */
export const LEDGER_SYNC_HEALTH_ROW = 'ledger_sync';

export type CronName = 'reclaim' | 'drain' | 'admission' | 'followup';

/** 各 cron 上次成功时间（ISO-8601 文本；null = 从未记录到一次成功）。 */
export interface CronSuccessTimes {
  reclaim: string | null;
  drain: string | null;
  /** 准入上次成功（42-admhealth）：02:00 刷新尾部与 14:00 独立轮两个入口共记同一行。 */
  admission: string | null;
  /**
   * 追更轮上次成功（obsfix45）：runFollowupRound 真跑完一轮才记；租约被占而跳过（skipped:'lease'）
   * **不记**——那不是完成，拿跳过冒充成功会把「轮次一直空转」显示成健康。
   */
  followup: string | null;
  /** 台账同步/准入续期上次成功（obsfix45），行名见 LEDGER_SYNC_HEALTH_ROW。 */
  ledgerSync: string | null;
  /**
   * 同表另一行（41-q402fix）：最近一次发现数据库配额错误的时刻（库恢复可写后由各进程补记，
   * 见 db-quota.ts recordDbQuotaSeen）；不是 cron 成功时间，不参与 ok 判据。从未记录为 null。
   */
  dbQuotaSeenAt: string | null;
  /** 番茄渠道心跳（fqhealth1111，行名见 channel-health.ts）：同样不是 cron 成功时间，不进 ok。 */
  fanqieOk: string | null;
  fanqieFault: string | null;
  fanqieFaultSince: string | null;
}

/**
 * cron_health 行名 → CronSuccessTimes 字段。行名是库里的字面值，这张表就是「哪些行算成功心跳」
 * 的唯一判据：**同表还住着租约行**（admission_lease / followup_probe_lease，它们的 last_success_at
 * 存的是租约**到期时刻**，是未来时间）与配额发现行，都不在本表里，因此绝不会被当成成功心跳。
 */
const CRON_ROW_FIELDS: Record<string, keyof CronSuccessTimes> = {
  reclaim: 'reclaim',
  drain: 'drain',
  admission: 'admission',
  followup: 'followup',
  [LEDGER_SYNC_HEALTH_ROW]: 'ledgerSync',
};

// 同表的非成功心跳行：原样透传时间戳，消费方各自按语义判（见上面字段注释）。
const SIGNAL_ROW_FIELDS: Record<string, keyof CronSuccessTimes> = {
  [DB_QUOTA_HEALTH_ROW]: 'dbQuotaSeenAt',
  [FANQIE_OK_HEALTH_ROW]: 'fanqieOk',
  [FANQIE_FAULT_HEALTH_ROW]: 'fanqieFault',
  [FANQIE_FAULT_SINCE_HEALTH_ROW]: 'fanqieFaultSince',
};

// cron 成功分支调用一次。监控写入失败绝不能把 cron 本身打挂（否则告警系统自己制造故障）：
// 吞掉异常、只记一行日志。写失败时健康端点会看到该 cron 的 lastSuccessAt 陈旧，这本身也是信号。
// 42-admhealth：name='admission' 由 shuyuan.ts 准入轮成功分支调（见 runAdmissionRound / admitRows 尾部）。
// obsfix45：name='followup' 由 followup.ts 的 runFollowupRound 在**真跑完一轮**时调。
// 台账同步行（LEDGER_SYNC_HEALTH_ROW）不经本函数——写它的 scripts/sync-ledger-capacity.mjs
// 是自包含脚本（部署到 phoenix 与只装 serverless 的探针同目录，不 import 仓内 TS），行名与
// upsert 语句在脚本内就地内联。
export async function recordCronSuccess(name: CronName): Promise<void> {
  try {
    await getSql()`
      INSERT INTO cron_health (name, last_success_at) VALUES (${name}, now())
      ON CONFLICT (name) DO UPDATE SET last_success_at = now()`;
  } catch (error) {
    console.error('cron health write failed', {
      name, reason: error instanceof Error ? error.name : typeof error,
    });
  }
}

// 一次查询读回全部 cron 行（表最多几行，不做动态 WHERE IN）。缺行归一为 null。
export async function readCronSuccessTimes(): Promise<CronSuccessTimes> {
  const rows = await getSql()`
    SELECT name, last_success_at::text AS last_success_at FROM cron_health` as {
    name: string; last_success_at: string | null;
  }[];
  const out: CronSuccessTimes = {
    reclaim: null, drain: null, admission: null, followup: null, ledgerSync: null, dbQuotaSeenAt: null,
    fanqieOk: null, fanqieFault: null, fanqieFaultSince: null,
  };
  for (const row of rows) {
    const field = CRON_ROW_FIELDS[row.name] ?? SIGNAL_ROW_FIELDS[row.name];
    if (field) out[field] = row.last_success_at;
  }
  return out;
}

/** 下载线活动（fqhealth1111）：最近一本完成的时刻 + 当前「有活」的任务数。 */
export interface DownloadActivity {
  lastDoneAt: string | null;
  /** running + 已到重试时刻的 pending；退避中的 pending 不算（它们本来就不该被领）。 */
  activeTasks: number;
}

// 一次查询两个聚合（表一万多行，生产实测 5ms，探针 3h 一次）。
export async function readDownloadActivity(): Promise<DownloadActivity> {
  const rows = await getSql()`
    SELECT
      (SELECT max(updated_at)::text FROM download_tasks WHERE status = 'done') AS last_done_at,
      (SELECT count(*)::int FROM download_tasks WHERE status = 'running'
        OR (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))) AS active_tasks` as {
    last_done_at: string | null; active_tasks: number | string | null;
  }[];
  return {
    lastDoneAt: rows[0]?.last_done_at ?? null,
    activeTasks: Number(rows[0]?.active_tasks ?? 0),
  };
}

// 准入批次的代表时间：source_admission.search_checked_at 的 MAX（一次聚合，无 N+1）。
// 准入因预算不足整批跳过（S3-3）时该值冻结 ⇒ 年龄单调上涨，这是它唯一的外部可见信号。
// 空表 / 从未探测 ⇒ null。纯观测字段：不参与 ok 判据（ok 只看池新鲜度与三条 cron）。
export async function readAdmissionCheckedAgeHours(): Promise<number | null> {
  const rows = await getSql()`
    SELECT max(search_checked_at)::text AS max_checked_at FROM source_admission` as {
    max_checked_at: string | null;
  }[];
  const iso = rows[0]?.max_checked_at;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? hoursSince(ms) : null;
}

// 与 shuyuan.ts 的 refreshedAtAgeHours 同口径：0.1h 取整，未来时间（时钟回拨）夹到 0。
export function hoursSince(ms: number): number {
  return Math.max(0, Math.round((Date.now() - ms) / 3_600_000 * 10) / 10);
}
