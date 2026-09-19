import { neon } from '@neondatabase/serverless';
import type { ProfileSnapshot, RerankedItem } from '@/lib/types';
import { LLM_USAGE_PHASES, type LlmUsagePhase, type LlmUsageRecord, type TokenStats, type TokenTotals } from './llm-usage';
import { assertAuthSchema } from './auth-store';
import { initializeBusinessSchema } from './business-schema';
import type { PersonalWriter } from './personal-write';
import { completeProfileFeedbackForUserQuery } from './user-data';
import { requireUserId, profileForUserQuery, saveProfileForUserQuery, excludedBooksForUserQuery, persistRecommendationsForUserQueries, feedbackForUserQueries, feedbackSnapshotForUserQuery, recentInformativeFeedbackForUserQuery, withdrawnFeedbackBookTitlesForUserQuery, enqueueProfileFeedbackForUserQuery, profileFeedbackQueueForUserQuery, markProfileFeedbackAbsorbedForUserQuery, markProfileFeedbackFailedForUserQuery, markProfileFeedbackAbsorbedUncheckedForUserQuery, profileFeedbackFailCountForUserQuery, maxFeedbackIdForUserQuery, ensureProfileForUserQuery, claimProfileFeedbackForUserQuery, drainableProfileFeedbackUsersQuery, profileFeedbackBackoffMs } from './user-data';
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

// 返回**实际写入的推荐行数**：调用方（/api/find）必须与本批期望本数比对，
// 数量不符不得回报 persisted=true（F09：静默漏写不能当成功）。
export async function persistRecommendationsForUser(userId: number, query: string, items: RerankedItem[], write: PersonalWriter): Promise<number> {
  requireUserId(userId);
  if (!items.length) return 0;
  const results = await write((sql) => persistRecommendationsForUserQueries(sql, userId, query, items));
  // 第二条语句是 recommendations 落库，RETURNING b.id 每行一条。
  return (results[1] as unknown[] | undefined)?.length ?? 0;
}

export class FeedbackConflictError extends Error {}

// books 里没有这本书时，追加历史的 INSERT ... SELECT 会插入 0 行且不报错。
// 单独成类，让调用方把"静默成功"变成显式的 BOOK_NOT_FOUND。
export class FeedbackBookNotFoundError extends Error {
  readonly code = 'BOOK_NOT_FOUND';
}

export interface ProfileFeedback { title: string; author: string; status: string; note: string }

// 重新生成画像时并入模型的「本人最新有效反馈」（F04）。查询本身见
// user-data.recentInformativeFeedbackForUserQuery：按 user_id 隔离 + 每本书取最新一行。
export async function getProfileFeedbackForUser(userId: number): Promise<ProfileFeedback[]> {
  requireUserId(userId);
  return await recentInformativeFeedbackForUserQuery(getSql(), userId) as ProfileFeedback[];
}

// 已撤回反馈的书名（F04）：曾 informative、最新已非 informative。空数组表示没有撤回信号，
// 路由据此不渲染撤回段。查询语义见 user-data.withdrawnFeedbackBookTitlesForUserQuery。
export async function getWithdrawnFeedbackBookTitlesForUser(userId: number): Promise<string[]> {
  requireUserId(userId);
  const rows = await withdrawnFeedbackBookTitlesForUserQuery(getSql(), userId) as { title: string }[];
  return rows.map((row) => row.title);
}

export async function getFeedbackSnapshotForUser(userId: number, title: string, author: string): Promise<{ version: number; status: string | null; note: string }> {
  requireUserId(userId);
  const rows = await feedbackSnapshotForUserQuery(getSql(), userId, title, author) as { id: number; status: string; note: string }[];
  const row = rows?.[0];
  return row ? { version: row.id, status: row.status, note: row.note } : { version: 0, status: null, note: '' };
}

export async function recordFeedbackForUser(userId: number, book: { title: string; author: string }, status: string, note: string, expectedVersion: number, write: PersonalWriter, queued = false): Promise<void> {
  try {
    // 第 7 条语句（索引 6）是与反馈写入同一事务的「待吸收事件」登记（F15）：反馈落库即事件
    // 落库。queued=false（本次改动不含信息量、也不是对既有 informative 反馈的撤回）时它写 0 行。
    const results = await write((sql) => [
      ...feedbackForUserQueries(sql, userId, book, status, note, expectedVersion),
      enqueueProfileFeedbackForUserQuery(sql, userId, expectedVersion, queued),
    ]);
    // 第 5 条语句（索引 4）是按 title/author 定位后追加 feedback 的 INSERT ... RETURNING id
    // （索引 0 是 route B 补 books 行的 upsert，见 user-data.ts feedbackForUserQueries）。
    // books 里没有这本书时它插入 0 行——旧行为是静默成功，这里显式失败。
    // route B 之后这条路径基本不可达（upsert 已在同事务补行），但保留作护栏：身份键相同而
    // 拼写不同的历史行会让 upsert 走 DO NOTHING、随后的 lower(title) 比较仍可能落空。
    // 该情况下第 5 条 UPDATE recommendations 同样匹配 0 行，整个批次没有写入任何数据。
    const inserted = results?.[4];
    if (Array.isArray(inserted) && inserted.length === 0) throw new FeedbackBookNotFoundError();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '22012') throw new FeedbackConflictError();
    throw error;
  }
}

// F15：每用户一行的待吸收反馈队列。语义见 user-data.ts 的队列查询注释与报告 §2。
export interface ProfileFeedbackQueueState {
  pendingFeedbackId: number | null;
  absorbedFeedbackId: number;
  status: string;
  attempts: number;
  lastError: string;
  updatedAt: string;
  /** 退避到期时刻（ISO 文本）；NULL = 无退避。absorb 路由用它区分 busy 与 failed。 */
  nextEligibleAt: string | null;
}

export async function getProfileFeedbackQueueForUser(userId: number): Promise<ProfileFeedbackQueueState | null> {
  requireUserId(userId);
  const rows = await profileFeedbackQueueForUserQuery(getSql(), userId) as {
    pending_feedback_id: number | null; absorbed_feedback_id: number; status: string;
    attempts: number; last_error: string; updated_at: string; next_eligible_at: string | null;
  }[];
  const row = rows?.[0];
  if (!row) return null;
  return {
    pendingFeedbackId: row.pending_feedback_id,
    absorbedFeedbackId: row.absorbed_feedback_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    updatedAt: row.updated_at,
    nextEligibleAt: row.next_eligible_at,
  };
}

// 返回推进后仍待处理的反馈 id（null = 已清空）。吸收期间若又有新反馈把 pending 抬高，
// 这里会看到更高的 id，调用方据此知道还没吸收干净。
// leaseToken：完成提交前校验租约未易主（WHERE lease_token = token），租约过期被重领后
// R3：明确区分租约失配（零行）与成功完成（pending 清空或仍有更高水位）。
// 无租约的重建路径继续使用 markProfileFeedbackAbsorbedUncheckedForUser。
export type ProfileFeedbackCompletion =
  | { matched: false }
  | { matched: true; pendingFeedbackId: number | null };

export async function markProfileFeedbackAbsorbedForUser(
  userId: number, candidate: number, status: string, write: PersonalWriter, leaseToken = '',
): Promise<ProfileFeedbackCompletion> {
  requireUserId(userId);
  if (typeof write !== 'function') throw new Error('authorized writer is required');
  const rows = (await write((sql) => [markProfileFeedbackAbsorbedForUserQuery(sql, userId, candidate, status, leaseToken)]))[0] as { pending_feedback_id: number | null }[];
  return rows.length === 0 ? { matched: false } : { matched: true, pendingFeedbackId: rows[0].pending_feedback_id };
}

export type ProfileFeedbackCommit =
  | { outcome: 'lostLease' }
  | { outcome: 'profileConflict' }
  | { outcome: 'matched'; updatedAt: string; pendingFeedbackId: number | null };

export async function completeProfileFeedbackForUser(
  userId: number, candidate: number, status: string, content: string, expectedUpdatedAt: string,
  write: PersonalWriter, leaseToken: string,
): Promise<ProfileFeedbackCommit> {
  requireUserId(userId);
  if (!expectedUpdatedAt.trim()) throw new Error('profile version is required');
  if (!leaseToken) throw new Error('lease token is required');
  if (typeof write !== 'function') throw new Error('authorized writer is required');
  const rows = (await write((sql) => [completeProfileFeedbackForUserQuery(
    sql, userId, candidate, status, leaseToken, content, expectedUpdatedAt,
  )]))[0] as { outcome: 'lostLease' | 'profileConflict' | 'matched'; updated_at: string; pending_feedback_id: number | null }[];
  const row = rows[0];
  if (!row || row.outcome === 'lostLease') return { outcome: 'lostLease' };
  if (row.outcome === 'profileConflict') return { outcome: 'profileConflict' };
  return { outcome: 'matched', updatedAt: row.updated_at, pendingFeedbackId: row.pending_feedback_id };
}

// 迁移兼容：候选上界推进（/api/profile 重建成功后推水位、pglite 测试替身等旧路径）不持有
// 租约，不能带 token 校验——否则永远写 0 行。此变体不校验也不清租约（没有租约可清），
// 只推水位。幂等安全：重建确实已把反馈并入画像，等价于一次成功的吸收。
export async function markProfileFeedbackAbsorbedUncheckedForUser(
  userId: number, candidate: number, status: string, write: PersonalWriter,
): Promise<number | null> {
  requireUserId(userId);
  if (typeof write !== 'function') throw new Error('authorized writer is required');
  const rows = (await write((sql) => [markProfileFeedbackAbsorbedUncheckedForUserQuery(sql, userId, candidate, status)]))[0] as { pending_feedback_id: number | null }[];
  return rows[0]?.pending_feedback_id ?? null;
}

export async function markProfileFeedbackFailedForUser(
  userId: number, status: string, error: string, write: PersonalWriter, leaseToken = '',
): Promise<void> {
  requireUserId(userId);
  if (typeof write !== 'function') throw new Error('authorized writer is required');
  // 退避档位 = 失败前的连续失败数 + 1（本次是第几次连续失败）；先读再算，
  // 曲线函数 profileFeedbackBackoffMs 单独可测，SQL 只落数值。
  const backoffMs = profileFeedbackBackoffMs(await getProfileFeedbackFailCountForUser(userId) + 1);
  await write((sql) => [markProfileFeedbackFailedForUserQuery(sql, userId, status, error, leaseToken, backoffMs)]);
}

// 退避要用「失败前」的 fail_count（+1 后作为本次档位）；单独读一次而不是塞进 UPDATE 的
// 表达式里，是为了让 backoff 曲线可测（曲线函数在 TS 侧，SQL 只落数值）。
export async function getProfileFeedbackFailCountForUser(userId: number): Promise<number> {
  requireUserId(userId);
  const rows = await profileFeedbackFailCountForUserQuery(getSql(), userId) as { fail_count: number }[];
  return rows[0]?.fail_count ?? 0;
}

// 排他领取：UPDATE CAS，拿到才返回候选反馈 id；被别人持租约/退避未到 → null。
// token 由调用方生成（crypto.randomUUID）；leaseMs 默认 8 分钟（模型调用 + 合并的耗时
// 级别，见报告 §1；测试可注入短租约）。
export const PROFILE_FEEDBACK_LEASE_MS = 8 * 60_000;

export async function claimProfileFeedbackForUser(userId: number, leaseToken: string, leaseMs = PROFILE_FEEDBACK_LEASE_MS): Promise<number | null> {
  requireUserId(userId);
  if (typeof leaseToken !== 'string' || leaseToken.length > 128) throw new Error('lease token is required');
  const rows = await claimProfileFeedbackForUserQuery(getSql(), userId, leaseToken, leaseMs) as { candidate: number }[];
  return rows[0]?.candidate ?? null;
}

// drain：扫描全部可领取用户（有 pending、租约空/过期、退避到期）。
export async function drainableProfileFeedbackUsers(limit: number): Promise<number[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('drain limit out of range');
  const rows = await drainableProfileFeedbackUsersQuery(getSql(), limit) as { user_id: number }[];
  return rows.map((row) => row.user_id);
}

export async function getMaxFeedbackIdForUser(userId: number): Promise<number> {
  requireUserId(userId);
  const rows = await maxFeedbackIdForUserQuery(getSql(), userId) as { max_id: number }[];
  return rows[0]?.max_id ?? 0;
}

// 空画像起步：没有 profile 行时先建一行（seeds 空），让反馈吸收拿到有效的 updated_at 走 CAS。
export async function ensureProfileForUser(userId: number, write: PersonalWriter): Promise<void> {
  requireUserId(userId);
  if (typeof write !== 'function') throw new Error('authorized writer is required');
  await write((sql) => [ensureProfileForUserQuery(sql, userId)]);
}
