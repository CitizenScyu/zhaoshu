// phoenix 书源刷新运行器入口。
//
// 只做装配,不含刷新业务逻辑:refreshShuyuan 本体来自仓库 src/lib/shuyuan.ts,
// 由 scripts/build-shuyuan-refresh.mjs 用 esbuild 原样打进本入口(复用同一份代码,
// 杜绝语义漂移)。运行时读 env DATABASE_URL(向 phoenix 的 systemd 环境文件取),
// 缺失时只报键名,不回显任何值。
//
// 用法:
//   node refresh-runner.mjs              正式刷新(写库)
//   node refresh-runner.mjs --dry-run    只读干跑(抓上游 + 合并去重,打印计数,不写库)
//
// 心跳:设 HEARTBEAT_FILE 时,运行期每 25s 追加一行时间戳(给外部看门狗区分「在跑」与「卡死」)。
// 看门狗:设 WATCHDOG_MS 时,超过该毫秒仍未结束即向 stderr 告警并以码 2 退出(oneshot 会记为 failed)。
// 配额闸(41-q402fix):Neon 402 失败时 STATUS_FILE 记 db-quota-exceeded + retryAfter(默认 30 分钟,
// env DB_QUOTA_BACKOFF_MS);冷却期内再启动不碰库、保留状态文件、退 0;冷却后首次成功在 cron_health 补记。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { getSql } from '@/lib/db';
import { dbQuotaBackoffMs, isDbQuotaError, recordDbQuotaSeen } from '@/lib/db-quota';
import { refreshShuyuan } from '@/lib/shuyuan';
import { dryRunRefresh } from './dry-run';
import { buildFailureStatus, quotaGate } from './quota-gate';

const dryRun = process.argv.includes('--dry-run');

function startHeartbeat(): () => void {
  const file = process.env.HEARTBEAT_FILE;
  if (!file) return () => {};
  const tick = () => { try { appendFileSync(file, `${new Date().toISOString()} refresh-runner alive\n`); } catch { /* 心跳失败不影响刷新 */ } };
  tick();
  const timer = setInterval(tick, 25_000);
  timer.unref?.();
  return () => { clearInterval(timer); };
}

function readStatus(statusFile: string | undefined): string | null {
  if (!statusFile) return null;
  try { return readFileSync(statusFile, 'utf8'); } catch { return null; }
}

async function main() {
  const gate = quotaGate(readStatus(process.env.STATUS_FILE), Date.now());
  if (gate.skip) {
    console.log(JSON.stringify({ mode: 'skipped', reason: 'db_quota_backoff', retryAt: gate.retryAt }));
    return;
  }
  const stopHeartbeat = startHeartbeat();
  // 运行开始即清除上一次的失败标记(STATUS_FILE 由调用方设定;刷新成功则保持清除)。
  if (process.env.STATUS_FILE) { try { writeFileSync(process.env.STATUS_FILE, '', 'utf8'); } catch { /* 忽略 */ } }
  const budgetMs = Number.parseInt(process.env.WATCHDOG_MS ?? '', 10);
  const watchdog = Number.isSafeInteger(budgetMs) && budgetMs > 0
    ? setTimeout(() => {
        console.error(`watchdog: refresh exceeded ${budgetMs}ms without completing`);
        process.exit(2);
      }, budgetMs)
    : undefined;
  watchdog?.unref?.();
  try {
    if (dryRun) {
      const counts = await dryRunRefresh();
      console.log(JSON.stringify({ mode: 'dry-run', ...counts }));
      return;
    }
    const stats = await refreshShuyuan();
    console.log(JSON.stringify({
      mode: 'refresh',
      refreshedAt: stats.refreshedAt,
      total: stats.total, active: stats.active, unprobed: stats.unprobed,
      reachable: stats.reachable, failed: stats.failed,
    }));
    // 上次以配额错误收场、这次写库成功:补记发现时刻(失败不影响本次刷新结果)。
    if (gate.quotaSeenAt) {
      await recordDbQuotaSeen(getSql(), gate.quotaSeenAt).catch(() => {
        console.error(JSON.stringify({ event: 'db_quota_record_failed', component: 'shuyuan-refresh' }));
      });
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    stopHeartbeat();
  }
}

// 失败标记:上游/写库失败时写 STATUS_FILE,让外部(或下一任)无需读 journalctl 就能看到
// 「刷新停摆及其原因」。只写原因与两个单调计数,不写任何连接串/正文;配额失败只写原因码 + retryAfter
// (计数与状态形态见 quota-gate.ts buildFailureStatus)。
function writeFailureStatus(statusFile: string, message: string, quotaBackoffMs: number | null): void {
  const safeMessage = message
    .replace(/\S*:\/\/\S*/g, '[redacted-url]')
    .replace(/\S+@\S+/g, '[redacted]')
    .slice(0, 300);
  try {
    const status = buildFailureStatus(readStatus(statusFile), safeMessage, Date.now(), quotaBackoffMs);
    writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n', 'utf8');
  } catch { /* 状态文件写失败不掩盖真正的失败 */ }
}

main().then(
  () => process.exit(0),
  (error) => {
    const quota = isDbQuotaError(error);
    // 配额失败不回显驱动原文(带 Neon 响应体),另打一行结构化日志。
    const message = quota ? 'database quota exceeded' : error instanceof Error ? error.message : String(error);
    console.error(`shuyuan refresh runner failed: ${message}`);
    const backoffMs = quota ? dbQuotaBackoffMs() : null;
    if (backoffMs !== null) {
      console.error(JSON.stringify({
        event: 'db_quota_exceeded', component: 'shuyuan-refresh', backoffMs,
        retryAt: new Date(Date.now() + backoffMs).toISOString(),
      }));
    }
    if (process.env.STATUS_FILE) writeFailureStatus(process.env.STATUS_FILE, message, backoffMs);
    if (process.env.DEBUG_STACK && error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  },
);