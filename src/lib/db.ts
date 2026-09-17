import { neon } from '@neondatabase/serverless';
import type { ProfileSnapshot, RerankedItem } from '@/lib/types';
import { LLM_USAGE_PHASES, type LlmUsagePhase, type LlmUsageRecord, type TokenStats, type TokenTotals } from './llm-usage';
import { assertAuthSchema } from './auth-store';
import { initializeBusinessSchema } from './business-schema';
import type { PersonalWriter } from './personal-write';
import { requireUserId, profileForUserQuery, saveProfileForUserQuery, excludedBooksForUserQuery, persistRecommendationsForUserQueries, feedbackForUserQueries, feedbackSnapshotForUserQuery } from './user-data';
export { canonicalBookKey } from './book-identity';

const DATABASE_URL = process.env.DATABASE_URL;

let sql: ReturnType<typeof neon> | null = null;

export function getSql() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!sql) {
    sql = neon(DATABASE_URL);
  }
  return sql;
}

// 冷启动时确保表结构存在（幂等 DDL）
export async function ensureSchema() {
  if (schemaReady) return;
  if (!schemaPromise) {
    schemaPromise = createSchema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
  schemaReady = true;
}

let schemaReady = false;
let schemaPromise: Promise<void> | null = null;

async function createSchema() {
  const s = getSql();
  await assertAuthSchema(s);
  await initializeBusinessSchema(s);
}

// 用量表延迟、独立初始化；统计 DDL 失败不能阻断业务，也不占用找书首字节时间。
let usageSchemaPromise: Promise<void> | null = null;

export async function ensureUsageSchema(): Promise<void> {
  if (!usageSchemaPromise) {
    usageSchemaPromise = createUsageSchema().catch((error) => {
      usageSchemaPromise = null;
      throw error;
    });
  }
  await usageSchemaPromise;
}

async function createUsageSchema(): Promise<void> {
  const s = getSql();
  await s`
    CREATE TABLE IF NOT EXISTS llm_usage (
      id bigserial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      phase text NOT NULL CHECK (phase IN ('find_recall', 'find_rerank', 'profile', 'feedback')),
      model text NOT NULL,
      prompt_tokens bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
      completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
      total_tokens bigint CHECK (total_tokens >= 0),
      cache_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_tokens >= 0),
      usage_missing boolean NOT NULL DEFAULT true,
      request_id text,
      usage_details jsonb NOT NULL DEFAULT '{}'
    )`;
  // 兼容已经建过基础用量表的实例；老行的 total 在聚合时由已知计数相加。
  await s`
    ALTER TABLE llm_usage
      ADD COLUMN IF NOT EXISTS total_tokens bigint CHECK (total_tokens >= 0),
      ADD COLUMN IF NOT EXISTS usage_details jsonb NOT NULL DEFAULT '{}'`;
  await s`
    CREATE INDEX IF NOT EXISTS llm_usage_phase_created_at_idx ON llm_usage (phase, created_at DESC)`;
}

export async function recordLlmUsage(record: LlmUsageRecord): Promise<void> {
  try {
    await ensureUsageSchema();
    const s = getSql();
    const { phase, model, requestId, createdAt, usage } = record;
    // usage_details 的组成：上游原始 usage 之上叠加我们自己的观测字段，观测值放后面因此优先
    // （attempts / firstByteTimeouts / retried / fallbackUsed / ttfbMs / cfRay / errorCode）。
    // 🔴 零迁移：usage_details 本来就是 jsonb（见 createUsageSchema），这里只加键，不改表结构。
    // 观测字段全部可选：chat 直接调用、或旧版本写入的行都不会有它们，读侧必须容忍缺失。
    const details = { ...(usage.rawUsage ?? {}), ...(record.observation ?? {}) };
    await s`
      INSERT INTO llm_usage
        (created_at, phase, model, prompt_tokens, completion_tokens, total_tokens,
         cache_tokens, usage_missing, request_id, usage_details)
      VALUES (${createdAt}::timestamptz, ${phase}, ${model}, ${usage.promptTokens},
              ${usage.completionTokens}, ${usage.totalTokens}, ${usage.cacheTokens},
              ${usage.usageMissing}, ${requestId}, ${JSON.stringify(details)}::jsonb)`;
  } catch {
    console.error('LLM usage write failed:', { phase: record.phase, model: record.model, requestId: record.requestId });
  }
}

function emptyTokenTotals(): TokenTotals {
  return { prompt: 0, completion: 0, total: 0, cache: 0, calls: 0, missingUsageCalls: 0 };
}

export async function getLlmUsageStats(): Promise<TokenStats> {
  await ensureUsageSchema();
  const s = getSql();
  // 一次扫描、一次聚合请求，返回最多四行；24h 与累计采用同一查询快照。
  const rows = await s`
    SELECT phase,
      jsonb_build_object(
        'prompt', COALESCE(sum(prompt_tokens), 0),
        'completion', COALESCE(sum(completion_tokens), 0),
        'total', COALESCE(sum(COALESCE(total_tokens, prompt_tokens + completion_tokens)), 0),
        'cache', COALESCE(sum(cache_tokens), 0),
        'calls', count(*),
        'missingUsageCalls', count(*) FILTER (WHERE usage_missing)
      ) AS total,
      jsonb_build_object(
        'prompt', COALESCE(sum(prompt_tokens) FILTER (WHERE created_at >= now() - interval '24 hours'), 0),
        'completion', COALESCE(sum(completion_tokens) FILTER (WHERE created_at >= now() - interval '24 hours'), 0),
        'total', COALESCE(sum(COALESCE(total_tokens, prompt_tokens + completion_tokens))
                         FILTER (WHERE created_at >= now() - interval '24 hours'), 0),
        'cache', COALESCE(sum(cache_tokens) FILTER (WHERE created_at >= now() - interval '24 hours'), 0),
        'calls', count(*) FILTER (WHERE created_at >= now() - interval '24 hours'),
        'missingUsageCalls', count(*) FILTER (WHERE usage_missing AND created_at >= now() - interval '24 hours')
      ) AS last_24h
    FROM llm_usage GROUP BY phase` as { phase: LlmUsagePhase; total: TokenTotals; last_24h: TokenTotals }[];
  const total = emptyTokenTotals();
  const last24h = emptyTokenTotals();
  for (const row of rows) {
    for (const key of Object.keys(total) as (keyof TokenTotals)[]) {
      total[key] += row.total[key];
      last24h[key] += row.last_24h[key];
    }
  }
  return {
    total,
    last24h,
    byPhase: LLM_USAGE_PHASES.map((phase) => ({
      phase, ...(rows.find((row) => row.phase === phase)?.total ?? emptyTokenTotals()),
    })),
  };
}

export async function getProfileForUser(userId: number): Promise<ProfileSnapshot> {
  requireUserId(userId);
  const rows = await profileForUserQuery(getSql(), userId) as {
    seeds: ProfileSnapshot['seeds']; content: string; updated_at: string;
  }[];
  if (!rows.length) return { seeds: [], content: '', updatedAt: '' };
  return { seeds: rows[0].seeds, content: rows[0].content, updatedAt: rows[0].updated_at };
}

export async function saveProfileForUser(
  userId: number, seeds: unknown, content: string, expectedUpdatedAt: string, write: PersonalWriter,
): Promise<string | null> {
  requireUserId(userId);
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) throw new Error('profile version is required');
  if (typeof write !== 'function') throw new Error('authorized writer is required');
  const rows = (await write((sql) => [saveProfileForUserQuery(sql, userId, seeds, content, expectedUpdatedAt)]))[0] as { updated_at: string }[];
  return rows[0]?.updated_at ?? null;
}

export async function getExcludedBookTitlesForUser(userId: number): Promise<{ title: string; author: string }[]> {
  requireUserId(userId);
  return await excludedBooksForUserQuery(getSql(), userId) as { title: string; author: string }[];
}

export async function persistRecommendationsForUser(userId: number, query: string, items: RerankedItem[], write: PersonalWriter): Promise<void> {
  requireUserId(userId);
  if (!items.length) return;
  await write((sql) => persistRecommendationsForUserQueries(sql, userId, query, items));
}

export class FeedbackConflictError extends Error {}

// books 里没有这本书时，追加历史的 INSERT ... SELECT 会插入 0 行且不报错。
// 单独成类，让调用方把"静默成功"变成显式的 BOOK_NOT_FOUND。
export class FeedbackBookNotFoundError extends Error {
  readonly code = 'BOOK_NOT_FOUND';
}

export async function getFeedbackSnapshotForUser(userId: number, title: string, author: string): Promise<{ version: number; status: string | null; note: string }> {
  requireUserId(userId);
  const rows = await feedbackSnapshotForUserQuery(getSql(), userId, title, author) as { id: number; status: string; note: string }[];
  const row = rows?.[0];
  return row ? { version: row.id, status: row.status, note: row.note } : { version: 0, status: null, note: '' };
}

export async function recordFeedbackForUser(userId: number, book: { title: string; author: string }, status: string, note: string, expectedVersion: number, write: PersonalWriter): Promise<void> {
  try {
    const results = await write((sql) => feedbackForUserQueries(sql, userId, book, status, note, expectedVersion));
    // 第 4 条语句（索引 3）是按 title/author 定位后追加 feedback 的 INSERT ... RETURNING id。
    // books 里没有这本书时它插入 0 行——旧行为是静默成功，这里显式失败。
    // 该情况下第 5 条 UPDATE recommendations 同样匹配 0 行，整个批次没有写入任何数据。
    const inserted = results?.[3];
    if (Array.isArray(inserted) && inserted.length === 0) throw new FeedbackBookNotFoundError();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '22012') throw new FeedbackConflictError();
    throw error;
  }
}
