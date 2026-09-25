import { authJson } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { isDbQuotaError, recordDbQuotaSeen } from '@/lib/db-quota';
import { getShuyuanPoolHealth } from '@/lib/shuyuan';
import {
  CRON_ALERT_HOURS, SHUYUAN_REFRESH_ALERT_HOURS, hoursSince,
  readAdmissionCheckedAgeHours, readCronSuccessTimes,
} from '@/lib/source-health';
import { dbQuotaLatch, requestHitDbQuota, withDbQuotaGuard } from '@/lib/db-quota-guard';

// S5-1：三条 cron（shuyuan / reclaim / drain）失败时此前没有任何告警通道。
// 这是一个**匿名只读**健康端点，供无凭据的 GitHub Actions 探针按阈值开 issue 留痕。
//
// 🔴 红线（硬性）：payload 只含聚合数字与时间戳——不得出现源站域名 / URL、源名、用户 id、
// 任何凭据，或任何可在别处复用的标识。字段集是契约，多一个键都算缺陷（route.test.ts 用
// Object.keys(...).sort() 精确比对钉死）。
//
// 失败语义：任何异常都返回 200 + ok:false，**绝不 500**——探针必须能区分「端点挂了」
// （HTTP 非 200 / 解析不出 JSON）与「池子陈旧或 cron 没跑」（200 + ok:false）。
//
// dbQuota（41-q402fix）：数据库配额告警。exceeded = 本次探测撞到配额（Neon 402）或本实例仍在配额冷却中；
// lastSeenAt = 最近一次发现时刻，取本实例内存与 cron_health.db_quota_exceeded 行（各进程恢复后补记）的较晚者。
// 402 期间其余字段照旧全 null + ok:false，但探针能凭 dbQuota 说出「为什么」。

export const dynamic = 'force-dynamic';

const QUERY_TIMEOUT_MS = 10_000;

interface SourceHealth {
  ok: boolean;
  refreshedAtAgeHours: number | null;
  admissionCheckedAtAgeHours: number | null;
  crons: {
    shuyuan: { lastSuccessAt: string | null };
    reclaim: { lastSuccessAt: string | null };
    drain: { lastSuccessAt: string | null };
  };
  dbQuota: { state: 'ok' | 'exceeded'; lastSeenAt: string | null };
}

// 单一构造点：成功与失败路径返回**同一组键**，探针不会因为键缺失而误判。
function emptyHealth(): SourceHealth {
  return {
    ok: false,
    refreshedAtAgeHours: null,
    admissionCheckedAtAgeHours: null,
    crons: {
      shuyuan: { lastSuccessAt: null },
      reclaim: { lastSuccessAt: null },
      drain: { lastSuccessAt: null },
    },
    dbQuota: { state: 'ok', lastSeenAt: null },
  };
}

// 取若干时刻里最晚的一个（null / 不可解析的忽略），归一为 ISO 文本。
function latestIso(...values: (string | null)[]): string | null {
  const times = values.map(v => (v ? Date.parse(v) : Number.NaN)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function isFresh(iso: string | null, maxAgeHours: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && hoursSince(ms) <= maxAgeHours;
}

async function handleGET() {
  const health = emptyHealth();
  let quotaSeenAt: string | null = null;
  let quotaHit = false;
  try {
    await ensureSchema();
    // 三次只读查询，无 N+1：池健康度（内含一次 meta 读）、cron_health 全表、准入 MAX 聚合。
    const [pool, crons, admissionCheckedAtAgeHours] = await Promise.all([
      getShuyuanPoolHealth(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
      readCronSuccessTimes(),
      readAdmissionCheckedAgeHours(),
    ]);
    health.refreshedAtAgeHours = pool.refreshedAtAgeHours;
    health.admissionCheckedAtAgeHours = admissionCheckedAtAgeHours;
    // shuyuan 的「上次成功时间」就是 refreshed_at（同一条 meta 行，刷新成功才推进）。
    // 端点只读一次 meta、不额外读时间戳，故由已取到的年龄反推（0.1h 取整，相对 26h 阈值可忽略）。
    health.crons.shuyuan.lastSuccessAt = pool.refreshedAtAgeHours === null
      ? null
      : new Date(Date.now() - pool.refreshedAtAgeHours * 3_600_000).toISOString();
    health.crons.reclaim.lastSuccessAt = crons.reclaim;
    health.crons.drain.lastSuccessAt = crons.drain;
    health.ok = poolFresh(pool.refreshedAtAgeHours)
      && isFresh(crons.reclaim, CRON_ALERT_HOURS)
      && isFresh(crons.drain, CRON_ALERT_HOURS);
    quotaSeenAt = crons.dbQuotaSeenAt;
    // 库可读写了：本实例若有配额期间没能写进库的发现时刻，此时补记（失败只记日志，不影响本次响应）。
    const unrecorded = dbQuotaLatch.takeUnrecorded();
    if (unrecorded) {
      await recordDbQuotaSeen(getSql(), unrecorded).catch(() => {
        console.error('db quota record failed', { event: 'db_quota_record_failed', component: 'vercel' });
      });
      quotaSeenAt = latestIso(quotaSeenAt, unrecorded);
    }
  } catch (error) {
    // 池健康度取不到（库不可用 / schema 未就绪）⇒ ok:false，且所有字段保持 null。
    quotaHit = isDbQuotaError(error);
    console.error('source health probe failed', {
      reason: quotaHit ? 'DB_QUOTA_EXCEEDED' : error instanceof Error ? error.name : typeof error,
    });
  }
  const local = dbQuotaLatch.status();
  const exceeded = quotaHit || requestHitDbQuota() || local.state === 'exceeded';
  health.dbQuota = {
    state: exceeded ? 'exceeded' : 'ok',
    // 撞到配额却没有本实例记录（错误不经 fetch 咽喉时）⇒ 以本次探测时刻为准。
    lastSeenAt: latestIso(quotaSeenAt, local.lastSeenAt, exceeded && !local.lastSeenAt ? new Date().toISOString() : null),
  };
  return authJson(health);
}

// 直接用年龄判 shuyuan：crons.shuyuan.lastSuccessAt 是由它反推的，等价，但避免 0.1h 取整
// 在阈值边界上来回抖动。null（从未刷新）视为不新鲜。
function poolFresh(refreshedAtAgeHours: number | null): boolean {
  return refreshedAtAgeHours !== null && refreshedAtAgeHours <= SHUYUAN_REFRESH_ALERT_HOURS;
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
