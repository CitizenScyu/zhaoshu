import { neon } from '@neondatabase/serverless';
import { initializeAuthSchema } from '../src/lib/auth-store.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error('TEST_DATABASE_URL is required; DATABASE_URL is never used by this migration.');
  process.exitCode = 2;
} else {
  await initializeAuthSchema(neon(connectionString));
  console.log('Auth schema migration completed for the explicit test database.');
}
