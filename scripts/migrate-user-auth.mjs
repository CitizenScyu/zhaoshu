import { neon } from '@neondatabase/serverless';
import { initializeAuthSchema, assertAuthSchema } from '../src/lib/auth-store.ts';
import { requireTestDatabaseUrl, reportDatabaseFailure } from './auth-db-fixtures.mjs';
import { migrationMetadata } from './personal-db-cases.mjs';

try {
  const connectionString = requireTestDatabaseUrl();
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check') || args.length > 1) throw new Error('Unknown migration argument');
  const sql = neon(connectionString);
  const before = await migrationMetadata(sql);
  console.log(JSON.stringify({ phase: 'preflight', ...before }));
  if (!args.includes('--check')) {
    await initializeAuthSchema(sql);
    await assertAuthSchema(sql);
    console.log(JSON.stringify({ phase: 'complete', ...await migrationMetadata(sql) }));
    console.log('专用 TEST_DATABASE_URL 的认证 schema v7 迁移完成；没有使用业务 DATABASE_URL。');
  }
} catch (error) { reportDatabaseFailure(error); }
