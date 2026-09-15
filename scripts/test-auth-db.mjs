import { neon } from '@neondatabase/serverless';
import { initializeAuthSchema } from '../src/lib/auth-store.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error('TEST_DATABASE_URL is required; refusing to read DATABASE_URL or run database tests.');
  process.exitCode = 2;
} else {
  const sql = neon(connectionString);
  await Promise.all([initializeAuthSchema(sql), initializeAuthSchema(sql)]);
  const rows = await sql`
    SELECT
      (SELECT count(*)::int FROM users) AS user_count,
      (SELECT count(*)::int FROM users WHERE id = 1 AND username = 'owner' AND role = 'owner'
        AND password_hash IS NULL AND can_find AND can_read AND can_download) AS owner_count,
      (SELECT count(*)::int FROM auth_settings WHERE id = 1 AND members_enabled = false
        AND registration_mode = 'closed') AS closed_settings_count,
      pg_get_serial_sequence('users', 'id') AS identity_sequence`;
  const row = rows[0];
  if (row.user_count !== 1 || row.owner_count !== 1 || row.closed_settings_count !== 1 || !row.identity_sequence) {
    throw new Error('Auth database skeleton verification failed. Use a dedicated empty test database.');
  }
  const nextRows = await sql`SELECT nextval(${row.identity_sequence}::regclass)::int AS next_id`;
  if (nextRows[0]?.next_id < 2) throw new Error('users identity sequence must allocate IDs from 2');
  console.log('Auth database skeleton passed empty/repeated/concurrent initialization checks.');
}
