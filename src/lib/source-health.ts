import { getSql } from './db';
import { DB_QUOTA_HEALTH_ROW } from './db-quota';

// 源池 / cron 健康观测（audit-41 S5-1）。三条 Vercel cron（shuyuan / reclaim / drain）
// 失败时此前零告警通道——2026-09-21 源池停摆 10 小时，靠人肉盯 refreshed_at 才发现。
// 本文件是健康端点 /api/health/sources 的唯一数据来源；探针（GitHub Actions）只读那个端点。
//
// 阈值集中在这里一处（探针侧在 workflow 里复述同一组数字，两边必须一致）。
// 判据 =「该 cron 的计划间隔 + 2h 容差」：漏掉一次计划运行后不久即暴露，而不是拖到第二天。
//
// ⚠️ 不变量：**每条 cron 的告警阈值必须 > 它在 vercel.json 里的实际触发间隔**。
// Vercel **Hobby** 计划限制「每条 cron 每天只能触发一次」，所以本仓三条 cron（shuyuan /
// reclaim / drain）的间隔恒为 24h，阈值一律 = 24h + 2h 容差 = 26h。
// shuyuan 原为 8h —— f474e27 定该值时 cron 还是每 6h 的 `0 2,8,14,20`，但 b561fba（实际上更早）
// 已把 cron 改回每日一次 `0 2 * * *`，两条线各自都对、合起来 8h 阈值配上 HEALTH_URL 会**每天误报**。
// 改 vercel.json 的 cron 计划时必须同步改这里与 workflow 里的数字；`src/lib/vercel-cron.test.ts`
// 有一条离线门禁按表达式真算间隔、比对这里的常数，脱节即红（防下次再靠人记）。
export const SHUYUAN_REFRESH_ALERT_HOURS = 26;
export const CRON_ALERT_HOURS = 26;

export type CronName = 'reclaim' | 'drain';

/** 各 cron 上次成功时间（ISO-8601 文本；null = 从未记录到一次成功）。 */
export interface CronSuccessTimes {
  reclaim: string | null;
  drain: string | null;
  /**
   * 同表另一行（41-q402fix）：最近一次发现数据库配额错误的时刻（库恢复可写后由各进程补记，
   * 见 db-quota.ts recordDbQuotaSeen）；不是 cron 成功时间，不参与 ok 判据。从未记录为 null。
   */
  dbQuotaSeenAt: string | null;
}

// cron 成功分支调用一次。监控写入失败绝不能把 cron 本身打挂（否则告警系统自己制造故障）：
// 吞掉异常、只记一行日志。写失败时健康端点会看到该 cron 的 lastSuccessAt 陈旧，这本身也是信号。
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

// 一次查询读回全部 cron 行（表最多三行，不做动态 WHERE IN）。缺行归一为 null。
export async function readCronSuccessTimes(): Promise<CronSuccessTimes> {
  const rows = await getSql()`
    SELECT name, last_success_at::text AS last_success_at FROM cron_health` as {
    name: string; last_success_at: string | null;
  }[];
  const out: CronSuccessTimes = { reclaim: null, drain: null, dbQuotaSeenAt: null };
  for (const row of rows) {
    if (row.name === 'reclaim' || row.name === 'drain') out[row.name] = row.last_success_at;
    else if (row.name === DB_QUOTA_HEALTH_ROW) out.dbQuotaSeenAt = row.last_success_at;
  }
  return out;
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
