import type { neon } from '@neondatabase/serverless';
type Sql = ReturnType<typeof neon>;

export async function initializeBusinessSchema(s: Sql) {
  // 仅在已完成 v4 专用迁移后由业务入口调用；声明不含旧全局唯一键或 owner 默认值。
  await s`
    CREATE TABLE IF NOT EXISTS profile (
      id int PRIMARY KEY CONSTRAINT profile_user_fk REFERENCES users(id),
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
      user_id int NOT NULL CONSTRAINT recommendations_user_fk REFERENCES users(id),
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
    CREATE UNIQUE INDEX IF NOT EXISTS recommendations_user_book_query_idx
    ON recommendations (user_id, book_id, query)`;
  await s`
    CREATE TABLE IF NOT EXISTS feedback (
      id serial PRIMARY KEY,
      user_id int NOT NULL CONSTRAINT feedback_user_fk REFERENCES users(id),
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
  await s`INSERT INTO shuyuan_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  // Disposable online-reader directories only; chapter text is never stored here.
  await s`
    CREATE TABLE IF NOT EXISTS source_read_catalogs (
      id text PRIMARY KEY,
      payload jsonb NOT NULL,
      expires_at timestamptz NOT NULL
    )`;
  await s`CREATE INDEX IF NOT EXISTS source_read_catalogs_expiry_idx ON source_read_catalogs (expires_at)`;
  await s`
    CREATE TABLE IF NOT EXISTS profile_seed_audit (
      id bigserial PRIMARY KEY,
      user_id int NOT NULL,
      previous_version text NOT NULL,
      saved_version text NOT NULL,
      added_titles jsonb NOT NULL,
      removed_titles jsonb NOT NULL,
      previous_seeds jsonb NOT NULL,
      saved_seeds jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await s`CREATE INDEX IF NOT EXISTS profile_seed_audit_user_time_idx ON profile_seed_audit (user_id, created_at DESC)`;
}
