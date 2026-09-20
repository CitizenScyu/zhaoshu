import type { DownloadSql } from './download-task-reclaim';
import { DOWNLOAD_TASK_STALE_MS } from './download-task-policy';

export const DOWNLOAD_STATES = ['pending', 'running', 'done', 'partial', 'failed', 'leaseExpired'] as const;
export type DownloadState = typeof DOWNLOAD_STATES[number];
export const DOWNLOAD_STATE_LABELS: Record<DownloadState, string> = {
  pending: '排队中', running: '下载中', done: '已完成', partial: '未完成', failed: '失败', leaseExpired: '心跳过期',
};
export interface DownloadObservation {
  total: number;
  groups: { requestedBy: 'user' | 'system'; total: number; share: number; leaseExpiredRate: number;
    states: Record<DownloadState, number>; retries: number; withArtifact: number }[];
}

/** A single read-only snapshot. Expired running tasks are not counted twice. */
export async function downloadObservation(sql: DownloadSql): Promise<DownloadObservation> {
  const rows = await sql`
    SELECT requested_by,
      CASE WHEN status = 'running' AND updated_at < now() - (${DOWNLOAD_TASK_STALE_MS}::bigint * interval '1 millisecond') THEN 'leaseExpired'
           WHEN status = 'superseded_by_incomplete' THEN 'partial' ELSE status END AS state,
      count(*)::int AS count,
      count(retry_of)::int AS retries, count(artifact_id)::int AS with_artifact
    FROM download_tasks GROUP BY 1, 2` as {
      requested_by: 'user' | 'system'; state: DownloadState; count: number; retries: number; with_artifact: number;
    }[];
  const total = rows.reduce((n, row) => n + row.count, 0);
  const groups = (['user', 'system'] as const).map(requestedBy => {
    const states = Object.fromEntries(DOWNLOAD_STATES.map(state => [state, 0])) as Record<DownloadState, number>;
    let count = 0, retries = 0, withArtifact = 0;
    for (const row of rows.filter(row => row.requested_by === requestedBy)) {
      states[row.state] = row.count;
      count += row.count; retries += row.retries; withArtifact += row.with_artifact;
    }
    return { requestedBy, total: count, share: total ? count / total : 0,
      leaseExpiredRate: count ? states.leaseExpired / count : 0, states, retries, withArtifact };
  });
  return { total, groups };
}
