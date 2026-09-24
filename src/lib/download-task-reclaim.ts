import type { getSql } from './db';
import {
  DOWNLOAD_TASK_STALE_MS, PUBLICATION_RETRY_MAX_ATTEMPTS, SOURCE_RETRY_BASE_DELAY_MS, SOURCE_RETRY_MAX_DELAY_MS,
} from './download-task-policy';

export type DownloadSql = ReturnType<typeof getSql>;

// 心跳失联阈值：worker 每 60 秒独立更新 updated_at（含重试、抽验、上传路径），
// 因此只有真正被硬终止、心跳停止超过 DOWNLOAD_TASK_STALE_MS 的 running 任务
// 才会落进这个谓词。活跃任务的最新心跳永远晚于阈值，不会被误回收。
//
// B2-03：system 任务没有人会替它点重试，崩溃在发布中途时规范区还停在半新半旧，
// 因此未达 PUBLICATION_RETRY_MAX_ATTEMPTS 的 system 任务放回 pending，按 attempt_count
// 退避（与 download-task-policy.ts sourceRetryDelayMs 同一阶梯，SQL 内同式计算）；
// 达上限或 user 任务仍置 failed（user 任务走前端受控重试）。两种都递增 lease_generation、
// 清空 owner：僵尸 worker 的租约条件写与发布器 guard.check() 从此全部失败，不会与重领者并发写。
export async function reclaimStaleTasks(sql: DownloadSql): Promise<void> {
  await sql`
    UPDATE download_tasks
    SET status = CASE WHEN requested_by = 'system' AND attempt_count < ${PUBLICATION_RETRY_MAX_ATTEMPTS}
          THEN 'pending' ELSE 'failed' END,
        attempt_count = CASE WHEN requested_by = 'system' AND attempt_count < ${PUBLICATION_RETRY_MAX_ATTEMPTS}
          THEN attempt_count + 1 ELSE attempt_count END,
        next_attempt_at = CASE WHEN requested_by = 'system' AND attempt_count < ${PUBLICATION_RETRY_MAX_ATTEMPTS}
          THEN now() + (LEAST(
            ${SOURCE_RETRY_BASE_DELAY_MS}::bigint * power(2, LEAST(GREATEST(attempt_count - 1, 0), 30))::bigint,
            ${SOURCE_RETRY_MAX_DELAY_MS}::bigint
          ) * interval '1 millisecond')
          ELSE next_attempt_at END,
        error = CONCAT(COALESCE(error, ''), CASE WHEN requested_by = 'system' AND attempt_count < ${PUBLICATION_RETRY_MAX_ATTEMPTS}
          THEN ${'\nworker 中断自动回收，退避后重新入队'}::text
          ELSE ${'\nworker 中断自动回收'}::text END),
        lease_generation = lease_generation + 1,
        lease_owner = '',
        updated_at = now()
    WHERE status = 'running' AND updated_at < now() - (${DOWNLOAD_TASK_STALE_MS}::bigint * interval '1 millisecond')`;
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
