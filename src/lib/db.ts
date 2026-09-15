import { neon } from '@neondatabase/serverless';
import type { ProfileSnapshot, RerankedItem } from '@/lib/types';
import { LLM_USAGE_PHASES, type LlmUsagePhase, type LlmUsageRecord, type TokenStats, type TokenTotals } from './llm-usage';
import { initializeAuthSchema } from './auth-store';

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_USER_ID = 1;

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
  // 认证迁移负责建立用户外键，旧个人数据表必须先存在。
  await s`
    CREATE TABLE IF NOT EXISTS profile (
      id int PRIMARY KEY DEFAULT 1,
      seeds jsonb NOT NULL DEFAULT '[]',
      content text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`
    CREATE TABLE IF NOT EXISTS books (
      id serial PRIMARY KEY,
      title text NOT NULL,
      author text NOT NULL,
      douban_id text,
      douban_rating float8,
      douban_rating_count int,
      meta jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`
    CREATE UNIQUE INDEX IF NOT EXISTS books_title_author_idx
    ON books (lower(title), lower(author))`;
  await s`
    CREATE TABLE IF NOT EXISTS recommendations (
      id serial PRIMARY KEY,
      book_id int NOT NULL REFERENCES books(id),
      query text NOT NULL,
      match_score float8,
      hit_likes jsonb,
      risks text,
      reason text,
      status text NOT NULL DEFAULT 'new',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (book_id, query)
    )`;
  await s`
    CREATE UNIQUE INDEX IF NOT EXISTS recommendations_book_query_idx
    ON recommendations (book_id, query)`;
  await s`
    CREATE TABLE IF NOT EXISTS feedback (
      id serial PRIMARY KEY,
      book_id int NOT NULL REFERENCES books(id),
      status text NOT NULL,
      note text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await initializeAuthSchema(s);
  await s`
    CREATE TABLE IF NOT EXISTS shuyuan_sources (
      id serial PRIMARY KEY,
      source_url text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT '',
      group_name text NOT NULL DEFAULT '',
      source jsonb NOT NULL,
      disabled_at timestamptz,
      last_error text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`
    CREATE TABLE IF NOT EXISTS shuyuan_meta (
      id int PRIMARY KEY DEFAULT 1,
      collections jsonb NOT NULL DEFAULT '[]',
      refreshed_at timestamptz
    )`;
  await s`
    CREATE TABLE IF NOT EXISTS labeled_books (
      id serial PRIMARY KEY,
      title text NOT NULL,
      author text NOT NULL DEFAULT '',
      category text NOT NULL DEFAULT '',
      finish_status text NOT NULL DEFAULT '',
      source_site text NOT NULL DEFAULT '',
      source_url text NOT NULL DEFAULT '',
      chars_labeled int NOT NULL DEFAULT 0,
      labels jsonb NOT NULL DEFAULT '{}',
      labeled_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`
    CREATE UNIQUE INDEX IF NOT EXISTS labeled_books_title_author_idx
    ON labeled_books (lower(title), lower(author))`;
  // 老表建立时可能没有 source_url 列(CREATE TABLE IF NOT EXISTS 不会补列)
  await s`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS source_url text NOT NULL DEFAULT ''`;
  // 质量分与规范化分类（由 scripts/import_labels.mjs 写入；quality 为 LLM 综合分 0-10）
  await s`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS primary_genre text NOT NULL DEFAULT ''`;
  await s`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS sub_tags jsonb NOT NULL DEFAULT '[]'`;
  await s`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS quality float8`;
  await s`
    CREATE TABLE IF NOT EXISTS download_tasks (
      id serial PRIMARY KEY,
      book_id int NOT NULL,
      title text NOT NULL,
      author text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      source_url text NOT NULL DEFAULT '',
      chapters_total int NOT NULL DEFAULT 0,
      chapters_done int NOT NULL DEFAULT 0,
      chars_total int NOT NULL DEFAULT 0,
      error text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  await s`INSERT INTO shuyuan_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
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
    await s`
      INSERT INTO llm_usage
        (created_at, phase, model, prompt_tokens, completion_tokens, total_tokens,
         cache_tokens, usage_missing, request_id, usage_details)
      VALUES (${createdAt}::timestamptz, ${phase}, ${model}, ${usage.promptTokens},
              ${usage.completionTokens}, ${usage.totalTokens}, ${usage.cacheTokens},
              ${usage.usageMissing}, ${requestId}, ${JSON.stringify(usage.rawUsage ?? {})}::jsonb)`;
  } catch (error) {
    console.error('LLM usage write failed:', { phase: record.phase, model: record.model, requestId: record.requestId }, error);
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

export async function getProfile(): Promise<ProfileSnapshot> {
  return getProfileForUser(OWNER_USER_ID);
}

export async function getProfileForUser(userId: number): Promise<ProfileSnapshot> {
  const s = getSql();
  const rows = (await s`
    SELECT seeds, content, updated_at::text AS updated_at FROM profile WHERE id = ${userId}`) as {
    seeds: ProfileSnapshot['seeds'];
    content: string;
    updated_at: string;
  }[];
  if (rows.length === 0) {
    return { seeds: [], content: '', updatedAt: '' };
  }
  return {
    seeds: rows[0].seeds,
    content: rows[0].content,
    updatedAt: rows[0].updated_at,
  };
}

export async function saveProfile(
  seeds: unknown,
  content: string,
  expectedUpdatedAt: string,
): Promise<string | null> {
  return saveProfileForUser(OWNER_USER_ID, seeds, content, expectedUpdatedAt);
}

export async function saveProfileForUser(
  userId: number,
  seeds: unknown,
  content: string,
  expectedUpdatedAt: string,
): Promise<string | null> {
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    throw new Error('profile version is required');
  }
  const s = getSql();
  // 同一条 UPDATE 同时比较并写入；即使时钟回拨或两个写入落在同一微秒，版本也前进。
  const rows = await s`
    UPDATE profile
    SET seeds = ${JSON.stringify(seeds)}::jsonb, content = ${content},
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE id = ${userId} AND updated_at::text = ${expectedUpdatedAt}
    RETURNING updated_at::text AS updated_at` as { updated_at: string }[];
  return rows[0]?.updated_at ?? null;
}

export async function getExcludedBookKeys(): Promise<string[]> {
  return getExcludedBookKeysForUser(OWNER_USER_ID);
}

export async function getExcludedBookKeysForUser(userId: number): Promise<string[]> {
  const s = getSql();
  const rows = (await s`
    SELECT b.title, b.author
    FROM books b
    WHERE EXISTS (
      SELECT 1 FROM feedback f
      WHERE f.book_id = b.id AND f.user_id = ${userId} AND f.status IN ('done', 'dropped')
    )`) as { title: string; author: string }[];
  return rows.map((row) => canonicalBookKey(row.title, row.author));
}

// 已读/弃书列表（带书名作者，供提示词软约束用）
export async function getExcludedBookTitles(): Promise<{ title: string; author: string }[]> {
  return getExcludedBookTitlesForUser(OWNER_USER_ID);
}

export async function getExcludedBookTitlesForUser(userId: number): Promise<{ title: string; author: string }[]> {
  const s = getSql();
  return (await s`
    SELECT b.title, b.author
    FROM books b
    WHERE EXISTS (
      SELECT 1 FROM feedback f
      WHERE f.book_id = b.id AND f.user_id = ${userId} AND f.status IN ('done', 'dropped')
    )`) as { title: string; author: string }[];
}

export async function persistRecommendations(
  query: string,
  items: RerankedItem[],
): Promise<void> {
  return persistRecommendationsForUser(OWNER_USER_ID, query, items);
}

export async function persistRecommendationsForUser(
  userId: number,
  query: string,
  items: RerankedItem[],
): Promise<void> {
  if (items.length === 0) return;
  const s = getSql();
  const bookQueries = items.map((item) => s`
    INSERT INTO books (title, author, douban_id, douban_rating, douban_rating_count, meta)
    VALUES (${item.title}, ${item.author}, ${item.douban?.doubanId ?? null},
            ${item.douban?.rating ?? null}, ${item.douban?.ratingCount ?? null},
            ${JSON.stringify({ category: item.category, wordCount: item.wordCount })}::jsonb)
    ON CONFLICT (lower(title), lower(author)) DO UPDATE
      SET douban_id = COALESCE(EXCLUDED.douban_id, books.douban_id),
          douban_rating = COALESCE(EXCLUDED.douban_rating, books.douban_rating),
          douban_rating_count = COALESCE(EXCLUDED.douban_rating_count, books.douban_rating_count),
          meta = books.meta || EXCLUDED.meta`);
  const recommendationQueries = items.map((item) => s`
    INSERT INTO recommendations (user_id, book_id, query, match_score, hit_likes, risks, reason)
    SELECT ${userId}, id, ${query}, ${item.matchScore}, ${JSON.stringify(item.hitLikes)}::jsonb,
           ${item.risks}, ${item.reason}
    FROM books
    WHERE lower(title) = lower(${item.title}) AND lower(author) = lower(${item.author})
    ON CONFLICT (user_id, book_id, query) DO UPDATE
      SET match_score = EXCLUDED.match_score,
          hit_likes = EXCLUDED.hit_likes,
          risks = EXCLUDED.risks,
          reason = EXCLUDED.reason,
          created_at = now()`);
  await s.transaction([...bookQueries, ...recommendationQueries]);
}

function canonicalBookKey(title: string, author: string): string {
  return `${title.normalize('NFKC').trim().toLocaleLowerCase()} ${author.normalize('NFKC').trim().toLocaleLowerCase()}`;
}

export async function upsertBook(b: {
  title: string;
  author: string;
  doubanId?: string | null;
  doubanRating?: number | null;
  doubanRatingCount?: number | null;
  meta?: Record<string, unknown>;
}): Promise<number> {
  const s = getSql();
  const rows = (await s`
    INSERT INTO books (title, author, douban_id, douban_rating, douban_rating_count, meta)
    VALUES (${b.title}, ${b.author}, ${b.doubanId ?? null}, ${b.doubanRating ?? null},
            ${b.doubanRatingCount ?? null}, ${JSON.stringify(b.meta ?? {})}::jsonb)
    ON CONFLICT (lower(title), lower(author)) DO UPDATE
      SET douban_id = COALESCE(EXCLUDED.douban_id, books.douban_id),
          douban_rating = COALESCE(EXCLUDED.douban_rating, books.douban_rating),
          douban_rating_count = COALESCE(EXCLUDED.douban_rating_count, books.douban_rating_count),
          meta = books.meta || EXCLUDED.meta
    RETURNING id`) as { id: number }[];
  return rows[0].id;
}
