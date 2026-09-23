// T8 接线：WorkerStorage 的运行时绑定（T3 任务层的 storage 接缝实现）。
//
// 只做接线，不新造存取语义：claim/心跳/进度/终态直接复用 download-task-queue.ts 的既有
// v7 SQL；artifact 路径声明复用 artifact-registry.ts 的 reserveArtifactPath。任务行的
// 两处写（taskRow 读取、registerArtifact 收口）在 T3 层没有独立导出函数（T3 测试在
// 绑定处内联），本文件按 T3 测试的同形语句实现，并在报告中记为 T3 接口缺件。
//
// 不做 DDL：只 DML。

import type { neon } from '@neondatabase/serverless';
import {
  claimDownloadTask, deferDownloadTask, finishDownloadTask, heartbeatDownloadTask, updateDownloadTaskProgress,
  type DownloadTaskLease,
} from '../src/lib/download-task-queue';
import { reserveArtifactPath } from '../src/lib/artifact-registry';
import type { TaskRow, WorkerStorage } from '../src/lib/download-worker';

export type DownloadSql = ReturnType<typeof neon>;

/** T3 存储接缝 + 运行时扩展：领取后预算耗尽时把任务安全放回 pending（不落终态、不占租约）。 */
export interface RuntimeWorkerStorage extends WorkerStorage {
  /** 租约条件回退为 pending：预算不扣（consume 未写入）、任务不被 stranding。 */
  releaseClaim(lease: DownloadTaskLease): Promise<boolean>;
}

export function createWorkerStorage(sql: DownloadSql): RuntimeWorkerStorage {
  return {
    claim: owner => claimDownloadTask(sql, owner),

    // T3 WorkerStorage.taskRow 没有对应的导出函数（T3 测试绑定内联同一 SELECT）。
    async taskRow(id) {
      const rows = await sql`
        SELECT id, book_id, title, author, status, source_url, source_kind, source_id, requested_by
        FROM download_tasks WHERE id = ${id}` as unknown as TaskRow[];
      return rows[0] ?? null;
    },

    heartbeat: lease => heartbeatDownloadTask(sql, lease),
    progress: (lease, update) => updateDownloadTaskProgress(sql, lease, update),
    finish: (lease, result) => finishDownloadTask(sql, lease, result),
    defer: (lease, input) => deferDownloadTask(sql, lease, input),

    reserveArtifactPath: input => reserveArtifactPath(sql, input),

    // T3 WorkerStorage.registerArtifact 只给 artifactId（无 taskId/lease），无法直接定位任务行。
    // 单写者 + 并发=1 下，book 的 running 且未登记 artifact 的任务行唯一，按 book_artifacts
    // 的 labeled_book_id 关联收口（T3 测试用「最近 running 行」近似，同义收窄）。
    async registerArtifact(input) {
      await sql`
        UPDATE book_artifacts SET
          quality_status = 'published', version = ${input.version}, blob_sha = ${input.blobSha},
          bytes = ${input.bytes}, chapters_total = ${input.chaptersTotal},
          chapters_done = ${input.chaptersDone}, chars = ${input.charsTotal},
          snapshot_path = ${input.snapshotPath}, source_revision = ${input.sourceRevision},
          published_at = now()
        WHERE id = ${input.artifactId}`;
      const rows = await sql`
        UPDATE download_tasks SET artifact_id = ${input.artifactId}
        WHERE status = 'running' AND artifact_id IS NULL
          AND book_id = (SELECT labeled_book_id FROM book_artifacts WHERE id = ${input.artifactId})
        RETURNING id` as unknown as { id: number }[];
      return rows.length === 1;
    },

    // 租约条件回退：只对「仍是本租约的 running 行」生效，失权后零行（不改他人行）。
    async releaseClaim(lease) {
      const rows = await sql`
        UPDATE download_tasks SET status = 'pending', lease_owner = '', updated_at = now()
        WHERE id = ${lease.id} AND status = 'running'
          AND lease_generation = ${lease.leaseGeneration} AND lease_owner = ${lease.leaseOwner}
        RETURNING id` as unknown as { id: number }[];
      return rows.length === 1;
    },
  };
}
