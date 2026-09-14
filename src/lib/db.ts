import { neon } from '@neondatabase/serverless';
import type { ProfileSnapshot, RerankedItem } from '@/lib/types';

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

export async function getProfile(): Promise<ProfileSnapshot> {
  const s = getSql();
  const rows = (await s`
    SELECT seeds, content, updated_at::text AS updated_at FROM profile WHERE id = 1`) as {
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
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    throw new Error('profile version is required');
  }
  const s = getSql();
  // 同一条 UPDATE 同时比较并写入；即使时钟回拨或两个写入落在同一微秒，版本也前进。
  const rows = await s`
    UPDATE profile
    SET seeds = ${JSON.stringify(seeds)}::jsonb, content = ${content},
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE id = 1 AND updated_at::text = ${expectedUpdatedAt}
    RETURNING updated_at::text AS updated_at` as { updated_at: string }[];
  return rows[0]?.updated_at ?? null;
}

export async function getExcludedBookKeys(): Promise<string[]> {
  const s = getSql();
  const rows = (await s`
    SELECT b.title, b.author
    FROM books b
    WHERE EXISTS (
      SELECT 1 FROM feedback f
      WHERE f.book_id = b.id AND f.status IN ('done', 'dropped')
    )`) as { title: string; author: string }[];
  return rows.map((row) => canonicalBookKey(row.title, row.author));
}

// 已读/弃书列表（带书名作者，供提示词软约束用）
export async function getExcludedBookTitles(): Promise<{ title: string; author: string }[]> {
  const s = getSql();
  return (await s`
    SELECT b.title, b.author
    FROM books b
    WHERE EXISTS (
      SELECT 1 FROM feedback f
      WHERE f.book_id = b.id AND f.status IN ('done', 'dropped')
    )`) as { title: string; author: string }[];
}

export async function persistRecommendations(
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
    INSERT INTO recommendations (book_id, query, match_score, hit_likes, risks, reason)
    SELECT id, ${query}, ${item.matchScore}, ${JSON.stringify(item.hitLikes)}::jsonb,
           ${item.risks}, ${item.reason}
    FROM books
    WHERE lower(title) = lower(${item.title}) AND lower(author) = lower(${item.author})
    ON CONFLICT (book_id, query) DO UPDATE
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
