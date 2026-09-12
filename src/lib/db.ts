import { neon } from '@neondatabase/serverless';

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
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (title, author)
    )`;
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
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`
    CREATE TABLE IF NOT EXISTS feedback (
      id serial PRIMARY KEY,
      book_id int NOT NULL REFERENCES books(id),
      status text NOT NULL,
      note text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
}

export async function getProfile(): Promise<{ seeds: SeedJson[]; content: string }> {
  const s = getSql();
  const rows = (await s`SELECT seeds, content FROM profile WHERE id = 1`) as {
    seeds: SeedJson[];
    content: string;
  }[];
  if (rows.length === 0) {
    return { seeds: [], content: '' };
  }
  return { seeds: rows[0].seeds, content: rows[0].content };
}

export async function saveProfile(seeds: unknown, content: string) {
  const s = getSql();
  await s`
    UPDATE profile
    SET seeds = ${JSON.stringify(seeds)}::jsonb, content = ${content}, updated_at = now()
    WHERE id = 1`;
}

type SeedJson = { title: string; author?: string; kind: string; reason?: string };

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
    ON CONFLICT (title, author) DO UPDATE
      SET douban_id = COALESCE(EXCLUDED.douban_id, books.douban_id),
          douban_rating = COALESCE(EXCLUDED.douban_rating, books.douban_rating),
          douban_rating_count = COALESCE(EXCLUDED.douban_rating_count, books.douban_rating_count)
    RETURNING id`) as { id: number }[];
  return rows[0].id;
}
