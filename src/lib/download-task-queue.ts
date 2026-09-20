import type { neon } from '@neondatabase/serverless';

export type DownloadQueueSql = ReturnType<typeof neon>;

export interface SystemTaskArtifactPolicy {
  hasReadableArtifact(labeledBookId: number, policyVersion: string, sourceRevision: string): Promise<boolean>;
}

export interface EnqueueSystemTaskInput {
  labeledBookId: number;
  policyVersion: string;
  sourceRevision?: string;
  sourceKind?: string;
  sourceId?: string | null;
}

export type EnqueueSystemTaskResult =
  | { outcome: 'artifact_exists'; taskId: null }
  | { outcome: 'created' | 'existing'; taskId: number };

export interface DownloadTaskLease {
  id: number;
  leaseGeneration: number;
  leaseOwner: string;
  attemptCount: number;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function requireNonEmpty(value: string, name: string, maxLength = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${name} is invalid`);
  return normalized;
}

export function systemTaskEnqueueKey(labeledBookId: number, policyVersion: string, sourceRevision = ''): string {
  requirePositiveInteger(labeledBookId, 'labeledBookId');
  return `${labeledBookId}:${requireNonEmpty(policyVersion, 'policyVersion')}:${sourceRevision.trim()}`;
}

/**
 * Importer seam: call from the same database transaction that upserts labeled_books.
 * Artifact lookup stays injectable until T2 supplies the durable artifact registry.
 */
export async function enqueueSystemDownloadTask(
  sql: DownloadQueueSql,
  input: EnqueueSystemTaskInput,
  artifacts: SystemTaskArtifactPolicy,
): Promise<EnqueueSystemTaskResult> {
  requirePositiveInteger(input.labeledBookId, 'labeledBookId');
  const policyVersion = requireNonEmpty(input.policyVersion, 'policyVersion');
  const sourceRevision = input.sourceRevision?.trim() ?? '';
  if (await artifacts.hasReadableArtifact(input.labeledBookId, policyVersion, sourceRevision)) {
    return { outcome: 'artifact_exists', taskId: null };
  }
  const enqueueKey = systemTaskEnqueueKey(input.labeledBookId, policyVersion, sourceRevision);
  const sourceKind = requireNonEmpty(input.sourceKind ?? 'builtin', 'sourceKind', 64);
  const sourceId = input.sourceId?.trim() || null;
  let rows: { id: number; created: boolean }[];
  try {
    rows = await sql`
    WITH book AS MATERIALIZED (
      SELECT id, title, author, source_url
      FROM labeled_books
      WHERE id = ${input.labeledBookId}
    ), inserted AS (
      INSERT INTO download_tasks (
        user_id, book_id, title, author, source_url, status, requested_by,
        source_kind, source_id, source_revision, policy_version, enqueue_key
      )
      SELECT NULL, id, title, author, source_url, 'pending', 'system',
             ${sourceKind}, ${sourceId}, ${sourceRevision}, ${policyVersion}, ${enqueueKey}
      FROM book
      ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL
      DO NOTHING
      RETURNING id, true AS created
    )
    SELECT id, created FROM inserted
    UNION ALL
    SELECT id, false AS created
    FROM download_tasks
    WHERE requested_by = 'system' AND enqueue_key = ${enqueueKey}
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1` as { id: number; created: boolean }[];
    if (rows.length === 0) {
      // DO NOTHING can wait for a winner invisible to this statement's snapshot.
      // A separate READ COMMITTED statement sees that winner after it commits.
      rows = await sql`
        SELECT id, false AS created
        FROM download_tasks
        WHERE requested_by = 'system' AND enqueue_key = ${enqueueKey}
          AND EXISTS (SELECT 1 FROM labeled_books WHERE id = ${input.labeledBookId})
        LIMIT 1` as { id: number; created: boolean }[];
    }
  } catch (error) {
    // A different policy/source-revision event can lose the system-active-book
    // partial-index race before it can conflict on enqueue_key. Resolve that
    // contention to the already active system task; all other DB errors remain errors.
    if (!(error && typeof error === 'object' && 'code' in error && error.code === '23505')) throw error;
    rows = await sql`
      SELECT id, false AS created
      FROM download_tasks
      WHERE requested_by = 'system' AND book_id = ${input.labeledBookId}
        AND status IN ('pending', 'running')
      ORDER BY created_at, id
      LIMIT 1` as { id: number; created: boolean }[];
  }
  const row = rows[0];
  if (!row) throw new Error('labeled book not found');
  return { outcome: row.created ? 'created' : 'existing', taskId: row.id };
}

export async function claimDownloadTask(
  sql: DownloadQueueSql,
  leaseOwner: string,
): Promise<DownloadTaskLease | null> {
  const owner = requireNonEmpty(leaseOwner, 'leaseOwner', 128);
  const rows = await sql`
    UPDATE download_tasks
    SET status = 'running',
        lease_generation = lease_generation + 1,
        lease_owner = ${owner},
        updated_at = now()
    WHERE id = (
      SELECT id FROM download_tasks
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at, id
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, lease_generation, lease_owner, attempt_count` as {
      id: number; lease_generation: number; lease_owner: string; attempt_count: number;
    }[];
  const row = rows[0];
  return row ? {
    id: row.id,
    leaseGeneration: Number(row.lease_generation),
    leaseOwner: row.lease_owner,
    attemptCount: row.attempt_count,
  } : null;
}

/** Create a new immutable attempt after a terminal failure; never rewinds the old row. */
export async function retryDownloadTask(
  sql: DownloadQueueSql,
  failedTaskId: number,
  nextAttemptAt: Date | null = null,
): Promise<number> {
  requirePositiveInteger(failedTaskId, 'failedTaskId');
  const rows = await sql`
    INSERT INTO download_tasks (
      user_id, book_id, title, author, status, source_url, requested_by,
      source_kind, source_id, source_revision, policy_version, enqueue_key,
      attempt_count, retry_of, next_attempt_at
    )
    SELECT user_id, book_id, title, author, 'pending', source_url, requested_by,
           source_kind, source_id, source_revision, policy_version,
           CASE WHEN requested_by = 'system'
             THEN enqueue_key || ':attempt:' || (attempt_count + 1)::text
             ELSE NULL
           END,
           attempt_count + 1, id, ${nextAttemptAt}
    FROM download_tasks
    WHERE id = ${failedTaskId}
      AND status IN ('failed', 'partial', 'superseded_by_incomplete')
    RETURNING id` as { id: number }[];
  const row = rows[0];
  if (!row) throw new Error('download task is not retryable');
  return row.id;
}

export async function heartbeatDownloadTask(sql: DownloadQueueSql, lease: DownloadTaskLease): Promise<boolean> {
  const rows = await sql`
    UPDATE download_tasks SET updated_at = now()
    WHERE id = ${lease.id} AND status = 'running'
      AND lease_generation = ${lease.leaseGeneration} AND lease_owner = ${lease.leaseOwner}
    RETURNING id` as { id: number }[];
  return rows.length === 1;
}

export async function updateDownloadTaskProgress(
  sql: DownloadQueueSql,
  lease: DownloadTaskLease,
  progress: { chaptersDone: number; chaptersTotal: number; charsTotal: number },
): Promise<boolean> {
  const rows = await sql`
    UPDATE download_tasks
    SET chapters_done = ${progress.chaptersDone}, chapters_total = ${progress.chaptersTotal},
        chars_total = ${progress.charsTotal}, updated_at = now()
    WHERE id = ${lease.id} AND status = 'running'
      AND lease_generation = ${lease.leaseGeneration} AND lease_owner = ${lease.leaseOwner}
    RETURNING id` as { id: number }[];
  return rows.length === 1;
}

export async function finishDownloadTask(
  sql: DownloadQueueSql,
  lease: DownloadTaskLease,
  result: { status: 'done' | 'failed' | 'partial' | 'superseded_by_incomplete'; error?: string },
): Promise<boolean> {
  const rows = await sql`
    UPDATE download_tasks
    SET status = ${result.status}, error = ${result.error ?? ''}, lease_owner = '', updated_at = now()
    WHERE id = ${lease.id} AND status = 'running'
      AND lease_generation = ${lease.leaseGeneration} AND lease_owner = ${lease.leaseOwner}
    RETURNING id` as { id: number }[];
  return rows.length === 1;
}
