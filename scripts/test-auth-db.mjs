import { neon } from '@neondatabase/serverless';
import { initializeAuthSchema } from '../src/lib/auth-store.ts';

const connectionString = process.env.TEST_DATABASE_URL;
const testCase = process.argv.find((argument) => argument.startsWith('--case='))?.slice('--case='.length);
if (!connectionString) {
  console.error('TEST_DATABASE_URL is required; refusing to read DATABASE_URL or run database tests.');
  process.exitCode = 2;
} else {
  if (testCase && testCase !== 'personal-migration') {
    throw new Error(`Unknown auth database test case: ${testCase}`);
  }
  const sql = neon(connectionString);
  await sql.transaction((tx) => [
      tx`CREATE TABLE IF NOT EXISTS profile (
        id integer PRIMARY KEY DEFAULT 1,
        seeds jsonb NOT NULL DEFAULT '[]',
        content text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      tx`CREATE TABLE IF NOT EXISTS books (
        id serial PRIMARY KEY,
        title text NOT NULL,
        author text NOT NULL
      )`,
      tx`CREATE TABLE IF NOT EXISTS recommendations (
        id serial PRIMARY KEY,
        book_id integer NOT NULL REFERENCES books(id),
        query text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (book_id, query)
      )`,
      tx`CREATE UNIQUE INDEX IF NOT EXISTS recommendations_book_query_idx
        ON recommendations (book_id, query)`,
      tx`CREATE TABLE IF NOT EXISTS feedback (
        id serial PRIMARY KEY,
        book_id integer NOT NULL REFERENCES books(id),
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      tx`INSERT INTO profile (id, seeds, content, updated_at)
        VALUES (1, '[{"title":"migration-fixture"}]'::jsonb, 'migration-fixture',
          '2026-09-15 00:00:00.123456+00'::timestamptz)
        ON CONFLICT (id) DO NOTHING`,
      tx`INSERT INTO books (id, title, author)
        VALUES (31001, 'migration-recommendation', 'migration-author'),
               (31002, 'migration-feedback', 'migration-author')
        ON CONFLICT (id) DO NOTHING`,
      tx`INSERT INTO recommendations (book_id, query)
        VALUES (31001, 'migration-query')
        ON CONFLICT (book_id, query) DO NOTHING`,
      tx`INSERT INTO feedback (book_id, status)
        SELECT 31002, 'done'
        WHERE NOT EXISTS (
          SELECT 1 FROM feedback WHERE book_id = 31002 AND status = 'done'
        )`,
  ]);
  await Promise.all([initializeAuthSchema(sql), initializeAuthSchema(sql)]);
  const rows = await sql`
    SELECT
      (SELECT count(*)::int FROM users) AS user_count,
      (SELECT count(*)::int FROM users WHERE id = 1 AND username = 'owner' AND role = 'owner'
        AND password_hash IS NULL AND can_find AND can_read AND can_download) AS owner_count,
      (SELECT count(*)::int FROM auth_settings WHERE id = 1 AND members_enabled = false
        AND registration_mode = 'closed') AS closed_settings_count,
      to_regclass('sessions') IS NOT NULL AS has_sessions,
      to_regclass('auth_rate_limits') IS NOT NULL AS has_rate_limits,
      (SELECT count(*)::int FROM auth_schema_migrations WHERE version = 3) AS v3_count,
      (SELECT count(*)::int FROM profile WHERE id = 1) AS owner_profile_count,
      (SELECT count(*)::int FROM recommendations
        WHERE book_id = 31001 AND query = 'migration-query' AND user_id = 1) AS preserved_recommendation_count,
      (SELECT count(*)::int FROM feedback
        WHERE book_id = 31002 AND status = 'done' AND user_id = 1) AS preserved_feedback_count,
      (SELECT count(*)::int FROM profile
        WHERE id = 1 AND content = 'migration-fixture'
          AND seeds = '[{"title":"migration-fixture"}]'::jsonb
          AND updated_at::text = '2026-09-15 00:00:00.123456+00') AS preserved_profile_count,
      pg_get_serial_sequence('users', 'id') AS identity_sequence`;
  const row = rows[0];
  if (row.user_count !== 1 || row.owner_count !== 1 || row.closed_settings_count !== 1 || !row.identity_sequence
    || !row.has_sessions || !row.has_rate_limits || row.v3_count !== 1
    || row.owner_profile_count !== 1
    || (testCase === 'personal-migration' && row.preserved_recommendation_count !== 1)
    || (testCase === 'personal-migration' && row.preserved_feedback_count !== 1)
    || (testCase === 'personal-migration' && row.preserved_profile_count !== 1)) {
    throw new Error('Auth database skeleton verification failed. Use a dedicated empty test database.');
  }
  const nextRows = await sql`SELECT nextval(${row.identity_sequence}::regclass)::int AS next_id`;
  if (nextRows[0]?.next_id < 2) throw new Error('users identity sequence must allocate IDs from 2');
  console.log('Auth database skeleton passed empty/repeated/concurrent initialization checks.');
}
