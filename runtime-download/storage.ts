// T8 接线：WorkerStorage 的运行时绑定（T3 任务层的 storage 接缝实现）。
//
// claim/心跳/进度/终态复用既有v7 SQL；路径声明复用artifact-registry。
// 出版登记在本模块用单条SQL锁定准确租约与artifact，原子更新并返回幂等结果。
//
// 不做 DDL：只 DML。

import type { neon } from '@neondatabase/serverless';
import {
  claimDownloadTask, deferDownloadTask, finishDownloadTask, heartbeatDownloadTask, updateDownloadTaskProgress,
  type DownloadTaskLease,
} from '../src/lib/download-task-queue';
import { reserveArtifactPath } from '../src/lib/artifact-registry';
import type { ArtifactRegistrationResult, TaskRow, WorkerStorage } from '../src/lib/download-worker';

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

    async registerArtifact(lease, input) {
      const rows = await sql`
        WITH lease_guard AS MATERIALIZED (
          SELECT id, book_id, artifact_id FROM download_tasks
          WHERE id = ${lease.id} AND status = 'running'
            AND lease_generation = ${lease.leaseGeneration} AND lease_owner = ${lease.leaseOwner}
          FOR UPDATE
        ), artifact_guard AS MATERIALIZED (
          SELECT a.*, t.id AS task_id,
            (t.artifact_id IS NOT DISTINCT FROM a.id
              AND a.quality_status = 'published' AND a.published_at IS NOT NULL
              AND a.version IS NOT DISTINCT FROM ${input.version}
              AND a.blob_sha IS NOT DISTINCT FROM ${input.blobSha}
              AND a.bytes IS NOT DISTINCT FROM ${input.bytes}
              AND a.chapters_total IS NOT DISTINCT FROM ${input.chaptersTotal}
              AND a.chapters_done IS NOT DISTINCT FROM ${input.chaptersDone}
              AND a.chars IS NOT DISTINCT FROM ${input.charsTotal}
              AND a.snapshot_path IS NOT DISTINCT FROM ${input.snapshotPath}
              AND a.source_revision IS NOT DISTINCT FROM ${input.sourceRevision}) AS is_same
          FROM book_artifacts a JOIN lease_guard t ON a.labeled_book_id = t.book_id
          WHERE a.id = ${input.artifactId} AND (t.artifact_id IS NULL OR t.artifact_id = a.id)
          FOR UPDATE OF a
        ), attached AS (
          UPDATE download_tasks t SET artifact_id = g.id
          FROM artifact_guard g WHERE t.id = g.task_id AND NOT g.is_same
          RETURNING t.id
        ), published AS (
          UPDATE book_artifacts a SET quality_status = 'published',
            version = ${input.version}, blob_sha = ${input.blobSha}, bytes = ${input.bytes},
            chapters_total = ${input.chaptersTotal}, chapters_done = ${input.chaptersDone},
            chars = ${input.charsTotal}, snapshot_path = ${input.snapshotPath},
            source_revision = ${input.sourceRevision}, published_at = now()
          FROM artifact_guard g
          WHERE a.id = g.id AND NOT g.is_same AND EXISTS (SELECT 1 FROM attached t WHERE t.id = g.task_id)
          RETURNING a.id
        ), proof AS (
          SELECT (SELECT count(*)::int FROM lease_guard) AS lease_ok,
            (SELECT count(*)::int FROM artifact_guard) AS guard_ok,
            (SELECT count(*)::int FROM artifact_guard WHERE is_same) AS already_ok,
            (SELECT count(*)::int FROM attached) AS attach_ok,
            (SELECT count(*)::int FROM published) AS pub_ok
        ), verdict AS (
          SELECT proof.*, CASE
            WHEN lease_ok = 0 AND guard_ok = 0 AND already_ok = 0 AND attach_ok = 0 AND pub_ok = 0 THEN 'lost'
            WHEN lease_ok = 1 AND guard_ok = 0 AND already_ok = 0 AND attach_ok = 0 AND pub_ok = 0 THEN 'mismatch'
            WHEN lease_ok = 1 AND guard_ok = 1 AND already_ok = 1 AND attach_ok = 0 AND pub_ok = 0 THEN 'already'
            WHEN lease_ok = 1 AND guard_ok = 1 AND already_ok = 0 AND attach_ok = 1 AND pub_ok = 1 THEN 'registered'
            ELSE NULL END AS status FROM proof
        )
        -- 非预期行数在同一语句内报错回滚，不能提交只有一侧成功的结果。
        SELECT verdict.*, 1 / CASE WHEN status IS NULL THEN 0 ELSE 1 END AS atomic_ok FROM verdict
      ` as unknown as Record<string, unknown>[];
      const expected = {
        lost: [0, 0, 0, 0, 0], mismatch: [1, 0, 0, 0, 0],
        already: [1, 1, 1, 0, 0], registered: [1, 1, 0, 1, 1],
      } as const;
      const row = rows[0];
      const status = row?.status;
      const equalsCount = (value: unknown, count: number) => value === count || value === String(count);
      if (rows.length !== 1 || !row || typeof status !== 'string'
        || !Object.prototype.hasOwnProperty.call(expected, status) || !equalsCount(row.atomic_ok, 1)) {
        throw new Error('ARTIFACT_REGISTRATION_INVALID_RESULT');
      }
      const result = status as ArtifactRegistrationResult;
      const counts = [row.lease_ok, row.guard_ok, row.already_ok, row.attach_ok, row.pub_ok];
      if (!expected[result].every((count, index) => equalsCount(counts[index], count))) {
        throw new Error('ARTIFACT_REGISTRATION_INVALID_RESULT');
      }
      return result;
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
