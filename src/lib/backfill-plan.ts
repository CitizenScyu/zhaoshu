// T5 有界历史补账:系统入队此前不存在,所以早先导入成功的书(import_one.py /
// import_labels.mjs 写过 labeled_books)没有系统任务,不补账就永远漏下载(设计 §B.1)。
//
// 本模块只做两件事,都不连库:
//   1. `buildBackfillPlan` / `parseBackfillPlanJsonl`:在给定的 labeled_books 快照上筛出
//      「无系统任务、无系统活动任务、无 artifact」的书,输出纯数据清单;
//   2. `submitBackfillPlan`:把清单**整批**一条语句提交(一个事务 = 一批)。
//
// 为什么整批一条语句:Neon HTTP 下拿不到逐条语句的事务控制,逐条提交要么每人一个事务
// (本已幂等,但 N 次 RTT),要么用 `sql.transaction([...])` 把 N 条语句塞进一个事务——
// 后者需要先把清单当数据传进去,故实现为「一条语句吃一个 jsonb 数组」。批内任一行违规
// (如伪造的 ID 空间混入)整批回滚,不留半批状态;批与批之间独立,可重试。
//
// 红线:books 与 labeled_books 是两个 ID 空间。清单里的 `labeledBookId` 必须同时满足
// 「该 id 在 labeled_books 里存在」与「enqueue_key 与 id/policy/revision 自洽」两条,
// 后者能挡住「把 books.id 塞进计划文件再提交」这类手改。

import type { neon } from '@neondatabase/serverless';

export interface BackfillPolicy {
  policyVersion: string;
  sourceRevision?: string;
  sourceKind?: string;
  sourceId?: string | null;
}

/** 供筛选用的最小快照行(只需 id/标题,不读正文)。 */
export interface LabeledBookSnapshotRow {
  id: number;
  title?: string;
  author?: string;
  sourceUrl?: string;
}

/** 供筛选用的既有系统任务(reason='task')与产物(reason='artifact')。 */
export interface BackfillSkipRow {
  labeledBookId: number;
  /** task:已有系统任务(含终态,事件键全生命周期去重);artifact:已有可读产物。 */
  reason: 'task' | 'artifact';
}

export interface BackfillPlanEntry {
  labeledBookId: number;
  title: string;
  author: string;
  sourceUrl: string;
  policyVersion: string;
  sourceRevision: string;
  sourceKind: string;
  sourceId: string | null;
  /** 事件键,与 T1 `systemTaskEnqueueKey()` 逐字一致。 */
  enqueueKey: string;
}

export interface BackfillPlan {
  requested: BackfillPlanEntry[];
  skipped: BackfillSkipRow[];
}

export function backfillEnqueueKey(labeledBookId: number, policyVersion: string, sourceRevision = ''): string {
  if (!Number.isSafeInteger(labeledBookId) || labeledBookId < 1) throw new Error('labeledBookId must be a positive integer');
  const policy = requireNonEmpty(policyVersion, 'policyVersion');
  return `${labeledBookId}:${policy}:${sourceRevision.trim()}`;
}

/**
 * 纯函数筛选:`candidates` 减去已有系统任务与已有产物。排序保证 dry-run 与 apply 的
 * 条目顺序一致(验收要求两者一致)。`limit` 有界(默认 500)。
 */
export function buildBackfillPlan(
  candidates: LabeledBookSnapshotRow[],
  skip: BackfillSkipRow[],
  policy: BackfillPolicy,
  limit = 500,
): BackfillPlan {
  const skipTask = new Set(skip.filter((row) => row.reason === 'task').map((row) => row.labeledBookId));
  const skipArtifact = new Set(skip.filter((row) => row.reason === 'artifact').map((row) => row.labeledBookId));
  const requested: BackfillPlanEntry[] = [];
  const skipped: BackfillSkipRow[] = [];
  const ordered = [...candidates].sort((a, b) => a.id - b.id);
  for (const row of ordered) {
    if (skipTask.has(row.id)) { skipped.push({ labeledBookId: row.id, reason: 'task' }); continue; }
    if (skipArtifact.has(row.id)) { skipped.push({ labeledBookId: row.id, reason: 'artifact' }); continue; }
    if (requested.length >= limit) continue;
    requested.push({
      labeledBookId: row.id,
      title: row.title ?? '',
      author: row.author ?? '',
      sourceUrl: row.sourceUrl ?? '',
      policyVersion: requireNonEmpty(policy.policyVersion, 'policyVersion'),
      sourceRevision: (policy.sourceRevision ?? '').trim(),
      sourceKind: requireNonEmpty(policy.sourceKind ?? 'builtin', 'sourceKind', 64),
      sourceId: policy.sourceId?.trim() || null,
      enqueueKey: backfillEnqueueKey(row.id, policy.policyVersion, policy.sourceRevision),
    });
  }
  return { requested, skipped };
}

/** 清单落盘形态:dry-run 的输出物,apply 的输入物——同一个东西,才能断言两者一致。 */
export function serializeBackfillPlanJsonl(plan: BackfillPlanEntry[]): string {
  return plan.map((entry) => JSON.stringify(entry)).join('\n');
}

/** 读回计划文件。逐行 JSON,坏行直接报错(计划文件是可信输入,不做静默跳过)。 */
export function parseBackfillPlanJsonl(text: string): BackfillPlanEntry[] {
  const entries: BackfillPlanEntry[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`backfill plan line ${index + 1} is not JSON`);
    }
    const labeledBookId = Number(parsed.labeledBookId);
    const entry = {
      labeledBookId,
      title: String(parsed.title ?? ''),
      author: String(parsed.author ?? ''),
      sourceUrl: String(parsed.sourceUrl ?? ''),
      policyVersion: String(parsed.policyVersion ?? ''),
      sourceRevision: String(parsed.sourceRevision ?? ''),
      sourceKind: String(parsed.sourceKind ?? 'builtin'),
      sourceId: parsed.sourceId == null || parsed.sourceId === '' ? null : String(parsed.sourceId),
      enqueueKey: String(parsed.enqueueKey ?? ''),
    };
    if (entry.enqueueKey !== backfillEnqueueKey(entry.labeledBookId, entry.policyVersion, entry.sourceRevision)) {
      throw new Error(`backfill plan line ${index + 1} has an enqueue_key that does not match its id/policy/revision`);
    }
    entries.push(entry);
  }
  return entries;
}

export interface BackfillSubmission {
  /** 计划里送入语句的条数。 */
  submitted: number;
  /** 通过 ID 空间与事件键自洽校验、且 book 行真实存在的条数。 */
  accepted: number;
  /** 实际落库的新任务条数(事件键已在库里的一律跳过)。 */
  inserted: number;
  tasks: { taskId: number; labeledBookId: number; enqueueKey: string }[];
}

/**
 * 整批提交:一条语句 = 一个事务。批内任一行违规(或不存在的 labeled_books.id)整批回滚;
 * 事件键已存在的行被 `ON CONFLICT DO NOTHING` 跳过,因此重放幂等。
 * 只接受 `ImporterSql` 形状(PGlite 适配器与 neon 都满足),便于离线测试。
 */
export async function submitBackfillPlan(
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
  plan: BackfillPlanEntry[],
): Promise<BackfillSubmission> {
  if (plan.length === 0) return { submitted: 0, accepted: 0, inserted: 0, tasks: [] };
  const payload = JSON.stringify(plan.map((entry) => ({
    labeled_book_id: entry.labeledBookId,
    title: entry.title,
    author: entry.author,
    source_url: entry.sourceUrl,
    source_kind: entry.sourceKind,
    source_id: entry.sourceId,
    source_revision: entry.sourceRevision,
    policy_version: entry.policyVersion,
    enqueue_key: entry.enqueueKey,
  })));
  const value = await sql`
    WITH batch AS (
      SELECT (e->>'labeled_book_id')::int AS labeled_book_id,
             e->>'title' AS title,
             COALESCE(e->>'author', '') AS author,
             COALESCE(e->>'source_url', '') AS source_url,
             COALESCE(e->>'source_kind', 'builtin') AS source_kind,
             NULLIF(e->>'source_id', '') AS source_id,
             COALESCE(e->>'source_revision', '') AS source_revision,
             e->>'policy_version' AS policy_version,
             e->>'enqueue_key' AS enqueue_key
      FROM jsonb_array_elements(${payload}::jsonb) AS e
    ), eligible AS (
      -- ID 空间红线:必须命中 labeled_books,且事件键必须与 id/policy/revision 自洽
      -- (手改计划文件把 books.id 塞进来会在这里被排除)。
      SELECT b.* FROM batch b
      JOIN labeled_books lb ON lb.id = b.labeled_book_id
      WHERE b.enqueue_key = b.labeled_book_id::text || ':' || b.policy_version || ':' || b.source_revision
    ), inserted AS (
      INSERT INTO download_tasks
        (user_id, book_id, title, author, source_url, status, requested_by,
         source_kind, source_id, source_revision, policy_version, enqueue_key)
      SELECT NULL, e.labeled_book_id, e.title, e.author, e.source_url, 'pending', 'system',
             e.source_kind, e.source_id, e.source_revision, e.policy_version, e.enqueue_key
      FROM eligible e
      WHERE NOT EXISTS (
        SELECT 1 FROM download_tasks active
        WHERE active.requested_by = 'system' AND active.book_id = e.labeled_book_id
          AND active.status IN ('pending', 'running')
      )
      ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL
      DO NOTHING
      RETURNING id, book_id, enqueue_key
    )
    SELECT (SELECT count(*)::int FROM batch) AS submitted,
           (SELECT count(*)::int FROM eligible) AS accepted,
           (SELECT count(*)::int FROM inserted) AS inserted,
           (SELECT jsonb_agg(jsonb_build_object(
              'taskId', id, 'labeledBookId', book_id, 'enqueueKey', enqueue_key))
            FROM inserted) AS tasks`;
  const row = firstRow(value);
  const tasks = Array.isArray(row.tasks) ? row.tasks as BackfillSubmission['tasks'] : [];
  return {
    submitted: Number(row.submitted ?? 0),
    accepted: Number(row.accepted ?? 0),
    inserted: Number(row.inserted ?? 0),
    tasks,
  };
}

/** 生产侧唯一类型转换点(与 importer-enqueue.ts 同名导出保持同一风格)。 */
export function asBackfillSql(sql: ReturnType<typeof neon>) {
  return sql as unknown as (parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}

function requireNonEmpty(value: string, name: string, maxLength = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${name} is invalid`);
  return normalized;
}

function firstRow(value: unknown): Record<string, unknown> {
  const rows = Array.isArray(value) ? value : ((value as { rows?: unknown })?.rows ?? []);
  return (rows as Record<string, unknown>[])[0] ?? {};
}
