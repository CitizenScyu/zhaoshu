import type { getSql } from './db';
import { DOWNLOAD_TASK_STALE_MS } from './download-task-policy';

export type DownloadSql = ReturnType<typeof getSql>;

// 心跳失联阈值：worker 每 60 秒独立更新 updated_at（含重试、抽验、上传路径），
// 因此只有真正被硬终止、心跳停止超过 DOWNLOAD_TASK_STALE_MS 的 running 任务
// 才会落进这个谓词。活跃任务的最新心跳永远晚于阈值，不会被误回收。
export async function reclaimStaleTasks(sql: DownloadSql): Promise<void> {
  await sql`
    UPDATE download_tasks
    SET status = 'failed',
        error = CONCAT(COALESCE(error, ''), ${'\nworker 中断自动回收'}),
        updated_at = now()
    WHERE status = 'running' AND updated_at < now() - (${DOWNLOAD_TASK_STALE_MS} * interval '1 millisecond')`;
}

// GET 保持只读：不写库，只把「running 且心跳过期」派生为可操作状态。
// updatedAt 由 SQL 以 ISO-8601 UTC 文本返回，这里用进程时钟比较即可——
// 阈值是 30 分钟，NTP 同步的服务器时钟偏差远小于它。
// 时间无法判定时返回 false（不宣称过期），避免误报诱导用户重复提交。
export function isLeaseExpired(status: string, updatedAtIso: string, nowMs: number = Date.now()): boolean {
  if (status !== 'running') return false;
  const updatedAt = Date.parse(updatedAtIso);
  if (!Number.isFinite(updatedAt)) return false;
  return nowMs - updatedAt > DOWNLOAD_TASK_STALE_MS;
}
