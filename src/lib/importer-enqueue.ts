// T5:把「labels 成功入库」与「系统下载任务入队」做成**同一语句 = 同一事务**。
//
// 为什么不是 JS 里先装再入队:Neon HTTP 的 `sql.transaction()` 是非交互批处理,拿不到
// 中间结果做分支;而「先 await UPSERT 再 await 入队」会留下「标签入了、任务没入」的
// 中间态,只能靠人补账。单条 SQL 语句本身即原子事务,故用一条语句同时完成两件事:
// 任一步失败(约束、类型、连接中断)整体回滚,labels.jsonl 原样保留可重放。
//
// 与 T1 的关系(T1 未合并;只读参考其冻结契约,不复制其文件):
//   - 列契约:`download_tasks(user_id, book_id, title, author, source_url, status,
//     requested_by, source_kind, source_id, source_revision, policy_version, enqueue_key)`
//     ——见 t1-worktree/src/lib/download-task-queue.ts 与 auth v7 迁移。
//   - 事件键:`${labeledBookId}:${policyVersion}:${sourceRevision}`。T1 在 JS 侧
//     `systemTaskEnqueueKey()` 构造;本模块在 SQL 侧用同一表达式
//     (`id::text || ':' || policy || ':' || revision`)构造,合并时若键格式变更只需改这一处。
//   - artifact 接缝:`SystemTaskArtifactPolicy.hasReadableArtifact` 与 T1 同形,T2 填实现。
//
// 幂等:系统事件键唯一 → 重复导入只产生一条系统任务;已存在返回 existing。
// 红线:books 与 labeled_books 是两个 ID 空间。下载任务的 book_id **只**来自
// labeled_books 的 RETURNING 或按身份键查得的行;外部传入整数必须先过 assertLabeledBookId。

import type { neon } from '@neondatabase/serverless';

/**
 * 事务内/外通用的 SQL 模板函数。刻意用最小结构类型,不引用 neon 的私有泛型别名:
 * 生产侧的 neon `sql` 与测试侧的 PGlite 适配器结构上都满足它。
 * 等待结果既可能是行数组(neon),也可能是 `{ rows }`(PGlite),见 rowsOf()。
 */
export interface ImporterSql {
  (parts: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** 生产侧唯一的类型转换点。 */
export function asImporterSql(sql: ReturnType<typeof neon>): ImporterSql {
  return sql as unknown as ImporterSql;
}

/** T2 接缝(与 T1 `SystemTaskArtifactPolicy` 同形):已有可读产物则只补账不重下。 */
export interface SystemTaskArtifactPolicy {
  hasReadableArtifact(labeledBookId: number, policyVersion: string, sourceRevision: string): Promise<boolean>;
}

/** 未合并 T2 时的默认策略:一律认为没有可读产物。 */
export const NO_ARTIFACTS: SystemTaskArtifactPolicy = { hasReadableArtifact: async () => false };

/**
 * 事件策略的**单一来源**:importer 与补账脚本都从这里取默认值。
 * policyVersion 代表「这一次抓取策略 / 来源规则版本」;只有规则或来源快照真的变了才换号,
 * 否则会把同一本书当成两个事件重复下载。可用环境变量在部署时覆盖(不经命令行)。
 */
export const DEFAULT_POLICY_VERSION = process.env.LABELER_DOWNLOAD_POLICY_VERSION || 't5-backfill-v1';

export interface ImportTaskPolicy {
  policyVersion: string;
  sourceRevision?: string;
  sourceKind?: string;
  sourceId?: string | null;
}

/** importer 侧记录形态(与 import_labels.mjs writeImportRecord / import_one.build_upsert 入参对齐)。 */
export interface ImportedLabelRecord {
  title: string;
  author: string;
  category: string;
  finishStatus: string;
  sourceSite: string;
  sourceUrl: string | null;
  charsLabeled: number;
  /** 原样 JSON 材料,写入前只做既有字符清洗,不补造字段。 */
  labels: unknown;
  primaryGenre: string;
  subTags: unknown;
  quality: number | null;
}

/** 标记类型:与 import_labels.mjs / import_one.py 的 status 字符串逐字对应。 */
export type ImportMarkerKind = 'ready' | 'imported' | 'duplicate' | 'review' | 'skipped' | 'twin-skipped' | 'failed' | 'disabled';

export type ImportDisposition =
  /** 新记录或内容有更新:写 labels + 按需入队。 */
  | 'import-and-enqueue'
  /** 标记已存在(此前导入成功过):不重写 labels,只补账——缺系统任务就补上。 */
  | 'ledger-only'
  /** review / skipped / twin-skipped / failed:既不入库也不入队。 */
  | 'no-enqueue';

/**
 * twin/review 类标记一律不入队。duplicate 是例外:标记只说明「曾经导入成功」,
 * 不说明后来有系统任务(去重上线前的历史书),必须走补账而不是直接跳过。
 */
export function classifyImportMarker(kind: ImportMarkerKind): ImportDisposition {
  if (kind === 'ready' || kind === 'imported') return 'import-and-enqueue';
  if (kind === 'duplicate') return 'ledger-only';
  if (kind === 'review' || kind === 'skipped' || kind === 'twin-skipped' || kind === 'failed' || kind === 'disabled') return 'no-enqueue';
  throw new Error(`unknown import marker: ${String(kind)}`);
}

export interface ImportOutcome {
  /** labeled_books.id;只有真正落库的路径才有。 */
  labeledBookId: number | null;
  /** created 新任务 / existing 事件键已有 / artifact_exists 有产物 / not_enqueued 未入队。 */
  taskOutcome: 'created' | 'existing' | 'artifact_exists' | 'not_enqueued';
  taskId: number | null;
  /** 本条是否真的写过 labeled_books(ledger-only 与 no-enqueue 为 false)。 */
  labelsWritten: boolean;
}

export interface ImportWithSystemTaskOptions {
  record: ImportedLabelRecord;
  /** 标记类型:决定是否入队、是否重写 labels。 */
  marker: ImportMarkerKind;
  task: ImportTaskPolicy;
  artifacts?: SystemTaskArtifactPolicy;
}

/**
 * 红线校验:所有接受**外部** id 的入口(补账、重试、手工重导)先过这里,
 * 而不是拿一个来路不明的整数直接构造下载任务。
 */
export async function assertLabeledBookId(sql: ImporterSql, labeledBookId: number): Promise<void> {
  requirePositiveInteger(labeledBookId, 'labeledBookId');
  const rows = rowsOf(await sql`SELECT id FROM labeled_books WHERE id = ${labeledBookId} LIMIT 1`);
  if (rows.length !== 1) {
    throw new Error(
      `labeled_book_id_not_in_space: ${labeledBookId} 不是 labeled_books.id(不得用 books.id 建下载任务)`,
    );
  }
}

/**
 * 一条语句完成:UPSERT labeled_books → 需要时插入系统下载任务。
 * 语句失败即整体回滚,不会留下「标签已入库、任务没入队」的半状态。
 *
 * 已有可读产物的检查在语句**之前**完成:artifact 引用 labeled_book_id(NOT NULL FK),
 * 因此全新身份不可能有产物;已存在身份则先按身份键取 id 再问接缝。接缝只能提前问,
 * 是因为 JS 侧的 `hasReadableArtifact` 无法在 SQL 里调用。竞态最坏结果只是多入一条
 * 任务——消费端仍会先查 artifact 再决定是否抓全书(设计 §B.1),不会重复下载。
 */
export async function importLabelWithSystemTask(
  sql: ImporterSql,
  options: ImportWithSystemTaskOptions,
): Promise<ImportOutcome> {
  const disposition = classifyImportMarker(options.marker);
  if (disposition === 'no-enqueue') {
    return { labeledBookId: null, taskOutcome: 'not_enqueued', taskId: null, labelsWritten: false };
  }
  const task = normalizeTaskPolicy(options.task);

  // 补账路径:标记已存在 = 此前导入成功,不重写 labels,只确保系统任务存在。
  if (disposition === 'ledger-only') {
    return { ...(await ensureSystemTask(sql, options.record, task, options.artifacts)), labelsWritten: false };
  }

  const record = options.record;
  const existingId = await findLabeledBookId(sql, record);
  const artifactExists = existingId !== null
    && await (options.artifacts ?? NO_ARTIFACTS)
      .hasReadableArtifact(existingId, task.policyVersion, task.sourceRevision);

  let result: Record<string, unknown>;
  try {
    result = firstRow(await sql`
    WITH upserted AS (
      INSERT INTO labeled_books
        (title, author, category, finish_status, source_site, source_url,
         chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality)
      VALUES (${record.title}, ${record.author}, ${record.category}, ${record.finishStatus},
              ${record.sourceSite}, ${record.sourceUrl ?? ''}, ${record.charsLabeled},
              ${JSON.stringify(record.labels)}::jsonb, now(),
              ${record.primaryGenre}, ${JSON.stringify(record.subTags)}::jsonb, ${record.quality})
      ON CONFLICT (title_key, author_key) DO UPDATE SET
        labels = EXCLUDED.labels,
        finish_status = EXCLUDED.finish_status,
        chars_labeled = EXCLUDED.chars_labeled,
        source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), labeled_books.source_url),
        primary_genre = EXCLUDED.primary_genre,
        sub_tags = EXCLUDED.sub_tags,
        quality = COALESCE(EXCLUDED.quality, labeled_books.quality),
        labeled_at = now()
      RETURNING id, title, author, source_url
    ), inserted AS (
      INSERT INTO download_tasks
        (user_id, book_id, title, author, source_url, status, requested_by,
         source_kind, source_id, source_revision, policy_version, enqueue_key)
      SELECT NULL, u.id, u.title, u.author, u.source_url, 'pending', 'system',
             ${task.sourceKind}, ${task.sourceId}, ${task.sourceRevision}, ${task.policyVersion},
             u.id::text || ':' || ${task.policyVersion} || ':' || ${task.sourceRevision}
      FROM upserted u
      WHERE ${!artifactExists}
        -- 同书已有活动系统任务(pending/running)时不再插第二条:否则会撞
        -- download_tasks_system_active_book_idx 的 23505,把**整个导入**回滚掉,
        -- 让「书已在队列里」这个正常状态反而阻塞标签更新。T1 的 enqueue 函数对这类
        -- 竞争同样解析为「返回该书现有活动任务」,这里在 SQL 里提前等价处理。
        AND NOT EXISTS (
          SELECT 1 FROM download_tasks t
          WHERE t.requested_by = 'system' AND t.book_id = u.id
            AND t.status IN ('pending', 'running')
        )
      ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL
      DO NOTHING
      RETURNING id
    )
    SELECT (SELECT id FROM upserted)          AS labeled_book_id,
           (SELECT count(*)::int FROM inserted) AS created_task_count,
           (SELECT id FROM inserted)          AS created_task_id`);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const labeledBookId = await upsertLabelsOnly(sql, record);
    const active = await findActiveSystemTask(sql, labeledBookId);
    return { labeledBookId, taskOutcome: active !== null ? 'existing' : 'artifact_exists', taskId: active, labelsWritten: true };
  }

  const labeledBookId = positiveIntOrNull(result.labeled_book_id);
  if (labeledBookId === null) throw new Error('labeled book upsert returned no row');
  const created = positiveIntOrNull(result.created_task_id);
  if (created !== null) return { labeledBookId, taskOutcome: 'created', taskId: created, labelsWritten: true };
  if (Number(result.created_task_count ?? 0) > 0) {
    return { labeledBookId, taskOutcome: 'created', taskId: null, labelsWritten: true };
  }
  if (artifactExists) return { labeledBookId, taskOutcome: 'artifact_exists', taskId: null, labelsWritten: true };
  // 没插进去且没有产物 ⇒ 事件键已有任务(幂等重放),或同书已有活动任务(不同事件)。
  const existing = await findSystemTaskByEnqueueKey(sql, labeledBookId, task)
    ?? await findActiveSystemTask(sql, labeledBookId);
  return {
    labeledBookId,
    taskOutcome: existing !== null ? 'existing' : 'artifact_exists',
    taskId: existing,
    labelsWritten: true,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return value?.code === '23505' || value?.cause?.code === '23505';
}

async function upsertLabelsOnly(sql: ImporterSql, record: ImportedLabelRecord): Promise<number> {
  const row = firstRow(await sql`
    INSERT INTO labeled_books
      (title, author, category, finish_status, source_site, source_url,
       chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality)
    VALUES (${record.title}, ${record.author}, ${record.category}, ${record.finishStatus},
            ${record.sourceSite}, ${record.sourceUrl ?? ''}, ${record.charsLabeled},
            ${JSON.stringify(record.labels)}::jsonb, now(), ${record.primaryGenre},
            ${JSON.stringify(record.subTags)}::jsonb, ${record.quality})
    ON CONFLICT (title_key, author_key) DO UPDATE SET
      labels = EXCLUDED.labels, finish_status = EXCLUDED.finish_status,
      chars_labeled = EXCLUDED.chars_labeled, source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), labeled_books.source_url),
      primary_genre = EXCLUDED.primary_genre, sub_tags = EXCLUDED.sub_tags,
      quality = COALESCE(EXCLUDED.quality, labeled_books.quality), labeled_at = now()
    RETURNING id`);
  const id = positiveIntOrNull(row.id);
  if (id === null) throw new Error('labeled book upsert returned no row');
  return id;
}

/**
 * 补账:标记已存在(duplicate)或一次性回扫时调用。不写 labels,只在缺系统任务时补一条。
 * 同样是一条语句一个事务;先查后插让「有产物 / 已有任务」两种跳过更省一次写。
 */
export async function ensureSystemTask(
  sql: ImporterSql,
  record: Pick<ImportedLabelRecord, 'title' | 'author'>,
  policy: ImportTaskPolicy | NormalizedTaskPolicy,
  artifacts: SystemTaskArtifactPolicy = NO_ARTIFACTS,
): Promise<Omit<ImportOutcome, 'labelsWritten'>> {
  const task = 'policyVersion' in policy && !('sourceKind' in policy)
    ? normalizeTaskPolicy(policy as ImportTaskPolicy)
    : (policy as NormalizedTaskPolicy);
  const labeledBookId = await findLabeledBookId(sql, record);
  if (labeledBookId === null) throw new Error('labeled book not found');
  if (await artifacts.hasReadableArtifact(labeledBookId, task.policyVersion, task.sourceRevision)) {
    return { labeledBookId, taskOutcome: 'artifact_exists', taskId: null };
  }
  const existing = await findSystemTaskByEnqueueKey(sql, labeledBookId, task)
    ?? await findActiveSystemTask(sql, labeledBookId);
  if (existing !== null) return { labeledBookId, taskOutcome: 'existing', taskId: existing };

  const result = firstRow(await sql`
    WITH target AS (
      SELECT id, title, author, source_url FROM labeled_books WHERE id = ${labeledBookId}
    ), inserted AS (
      INSERT INTO download_tasks
        (user_id, book_id, title, author, source_url, status, requested_by,
         source_kind, source_id, source_revision, policy_version, enqueue_key)
      SELECT NULL, t.id, t.title, t.author, t.source_url, 'pending', 'system',
             ${task.sourceKind}, ${task.sourceId}, ${task.sourceRevision}, ${task.policyVersion},
             t.id::text || ':' || ${task.policyVersion} || ':' || ${task.sourceRevision}
      FROM target t
      WHERE NOT EXISTS (
        SELECT 1 FROM download_tasks d
        WHERE d.requested_by = 'system' AND d.book_id = t.id
          AND d.status IN ('pending', 'running')
      )
      ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL
      DO NOTHING
      RETURNING id
    )
    SELECT (SELECT id FROM target)              AS labeled_book_id,
           (SELECT count(*)::int FROM inserted) AS created_task_count,
           (SELECT id FROM inserted)            AS created_task_id`);
  const created = positiveIntOrNull(result.created_task_id);
  if (created !== null) return { labeledBookId, taskOutcome: 'created', taskId: created };
  if (Number(result.created_task_count ?? 0) > 0) {
    return { labeledBookId, taskOutcome: 'created', taskId: null };
  }
  const raced = await findSystemTaskByEnqueueKey(sql, labeledBookId, task)
    ?? await findActiveSystemTask(sql, labeledBookId);
  return {
    labeledBookId,
    taskOutcome: raced !== null ? 'existing' : 'artifact_exists',
    taskId: raced,
  };
}

// ---- 内部小工具 ----

/** 事件键已有任务时取回那一行(只读,不建任务)。 */
async function findSystemTaskByEnqueueKey(
  sql: ImporterSql,
  labeledBookId: number,
  task: NormalizedTaskPolicy,
): Promise<number | null> {
  const rows = rowsOf(await sql`
    SELECT id FROM download_tasks
    WHERE requested_by = 'system' AND enqueue_key = ${enqueueKey(labeledBookId, task)}
    ORDER BY id
    LIMIT 1`);
  return positiveIntOrNull(rows[0]?.id);
}

/** 同书已有活动系统任务(pending/running)时取回那一行;用于「不同事件同书」的竞争。 */
async function findActiveSystemTask(sql: ImporterSql, labeledBookId: number): Promise<number | null> {
  const rows = rowsOf(await sql`
    SELECT id FROM download_tasks
    WHERE requested_by = 'system' AND book_id = ${labeledBookId}
      AND status IN ('pending', 'running')
    ORDER BY id
    LIMIT 1`);
  return positiveIntOrNull(rows[0]?.id);
}

/** 事件键:`${id}:${policyVersion}:${sourceRevision}`,与 T1 `systemTaskEnqueueKey()` 逐字一致。 */
function enqueueKey(labeledBookId: number, task: NormalizedTaskPolicy): string {
  return `${labeledBookId}:${task.policyVersion}:${task.sourceRevision}`;
}

/**
 * 按身份键取已存在的 labeled_books.id。身份键表达式**原样抄自 DDL**
 * (migrations/0002_identity_key.sql 的生成列),而不是在 JS 里重写一遍 NFKC/trim 规则:
 * 两边一旦漂移,补账就会查错行。
 */
async function findLabeledBookId(
  sql: ImporterSql,
  record: Pick<ImportedLabelRecord, 'title' | 'author'>,
): Promise<number | null> {
  const rows = rowsOf(await sql`
    SELECT id FROM labeled_books
    WHERE title_key = lower(btrim(regexp_replace(btrim(normalize(${record.title}, NFKC)), '^《(.+)》$', '\\1')))
      AND author_key = lower(btrim(normalize(${record.author}, NFKC)))
    ORDER BY id
    LIMIT 1`);
  return positiveIntOrNull(rows[0]?.id);
}

interface NormalizedTaskPolicy {
  policyVersion: string;
  sourceRevision: string;
  sourceKind: string;
  sourceId: string | null;
}

function normalizeTaskPolicy(policy: ImportTaskPolicy): NormalizedTaskPolicy {
  return {
    policyVersion: requireNonEmpty(policy.policyVersion, 'policyVersion'),
    sourceRevision: (policy.sourceRevision ?? '').trim(),
    sourceKind: requireNonEmpty(policy.sourceKind ?? 'builtin', 'sourceKind', 64),
    sourceId: policy.sourceId?.trim() || null,
  };
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function requireNonEmpty(value: string, name: string, maxLength = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${name} is invalid`);
  return normalized;
}

function positiveIntOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** neon 返回行数组;PGlite 适配器返回 { rows }。两种都兼容。 */
function firstRow(value: unknown): Record<string, unknown> {
  return rowsOf(value)[0] ?? {};
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  return ((value as { rows?: unknown })?.rows ?? []) as Record<string, unknown>[];
}
