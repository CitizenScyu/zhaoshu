#!/usr/bin/env node
import { createClient, EXPECTED_TABLES, inspectSchema, isPooledEndpoint, loadMigration, parseTarget, requireTestDatabaseUrl, safeError, TARGET_SCHEMA } from './db-migration-lib.mjs';

let client;
try {
  parseTarget(process.argv.slice(2));
  const connectionString = requireTestDatabaseUrl();
  client = createClient(connectionString);
  await client.connect();
  const migration = await loadMigration();
  await client.query('BEGIN READ ONLY');
  let report;
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    report = await inspectSchema(client, TARGET_SCHEMA);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
  const present = new Set(report.columns.map((item) => item.table_name));
  const missingTables = EXPECTED_TABLES.filter((table) => !present.has(table));
  const current = report.versions.find((row) => row.version === migration.version);
  const checksumOk = current ? current.name === migration.name && current.checksum.trim() === migration.checksum : false;
  console.log(JSON.stringify({ target: 'test', schema: TARGET_SCHEMA, pooledEndpoint: isPooledEndpoint(connectionString),
    expectedVersion: migration.version, expectedChecksum: migration.checksum, checksumOk,
    missingTables, dangerous: report.dangerous, versions: report.versions,
    columns: report.columns, indexes: report.indexes, constraints: report.constraints }, null, 2));
  if (!checksumOk || missingTables.length || report.dangerous.length) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
