import { requireTestDatabaseUrl, reportDatabaseFailure } from './auth-db-fixtures.mjs';
import { personalMigrationCase, personalIsolationCase, downloadIsolationCase } from './personal-db-cases.mjs';

try {
  requireTestDatabaseUrl();
  const args = process.argv.slice(2);
  if (args.some((arg) => !arg.startsWith('--case=')) || args.length > 1) throw new Error('Unknown database test argument');
  const testCase = args[0]?.slice('--case='.length);
  if (args.length && !['personal-migration','personal-isolation','download-isolation'].includes(testCase)) throw new Error('Unknown database test case');
  if (!testCase || testCase === 'personal-migration') await personalMigrationCase();
  if (!testCase || testCase === 'personal-isolation') await personalIsolationCase();
  if (!testCase || testCase === 'download-isolation') await downloadIsolationCase();
} catch (error) { reportDatabaseFailure(error); }
