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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { refreshShuyuan } from '@/lib/shuyuan';
import { dryRunRefresh } from './dry-run';

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

async function main() {
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
  } finally {
    if (watchdog) clearTimeout(watchdog);
    stopHeartbeat();
  }
}

// 失败标记:上游/写库失败时写 STATUS_FILE,让外部(或下一任)无需读 journalctl 就能看到
// 「刷新停摆及其原因」。只写原因与两个单调计数,不写任何连接串/正文。
function writeFailureStatus(statusFile: string, message: string): void {
  const now = Date.now();
  let consecutive = 1;
  let firstFailedAt = new Date(now).toISOString();
  try {
    const prev = JSON.parse(readFileSync(statusFile, 'utf8')) as { consecutive?: number; firstFailedAt?: string };
    if (Number.isSafeInteger(prev.consecutive) && (prev.consecutive ?? 0) > 0) {
      consecutive = (prev.consecutive ?? 0) + 1;
      firstFailedAt = prev.firstFailedAt ?? firstFailedAt;
    }
  } catch { /* 首次失败或文件损坏:从 1 起计 */ }
  const safeMessage = message
    .replace(/\S*:\/\/\S*/g, '[redacted-url]')
    .replace(/\S+@\S+/g, '[redacted]')
    .slice(0, 300);
  try {
    writeFileSync(statusFile, JSON.stringify({
      state: 'refresh-failed', consecutive, firstFailedAt, lastFailedAt: new Date(now).toISOString(), reason: safeMessage,
    }, null, 2) + '\n', 'utf8');
  } catch { /* 状态文件写失败不掩盖真正的失败 */ }
}

main().then(
  () => process.exit(0),
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`shuyuan refresh runner failed: ${message}`);
    if (process.env.STATUS_FILE) writeFailureStatus(process.env.STATUS_FILE, message);
    if (process.env.DEBUG_STACK && error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  },
);