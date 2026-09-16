#!/usr/bin/env node
import { parseTarget, requireTestDatabaseUrl, safeError } from './db-migration-lib.mjs';
import { runMigrationUpgradeSuite } from '../tests/db/migration-upgrade.mjs';

try {
  parseTarget(process.argv.slice(2));
  const results = await runMigrationUpgradeSuite(requireTestDatabaseUrl());
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
  process.exitCode = 1;
}
