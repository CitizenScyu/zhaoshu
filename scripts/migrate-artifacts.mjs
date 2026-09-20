import { neon } from '@neondatabase/serverless';
import { initializeArtifactSchema } from '../src/lib/artifact-schema.ts';
import { requireTestDatabaseUrl, reportDatabaseFailure } from './auth-db-fixtures.mjs';

// Explicit local/test migration entry point, never loads business DATABASE_URL.
try {
  if (process.argv.length > 2) throw new Error('Unknown migration argument');
  await initializeArtifactSchema(neon(requireTestDatabaseUrl()));
  console.log('Artifact schema v1 ready in TEST_DATABASE_URL; existing business tables required.');
} catch (error) { reportDatabaseFailure(error); }
