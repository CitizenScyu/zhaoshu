#!/usr/bin/env node
import { createClient, EXPECTED_TABLES, inspectSchema, isPooledEndpoint, loadMigrations, parseTarget, requireTestDatabaseUrl, safeError, SCHEMA_VERSION, TARGET_SCHEMA } from './db-migration-lib.mjs';

let client;
try {
  parseTarget(process.argv.slice(2));
  const connectionString = requireTestDatabaseUrl();
  client = createClient(connectionString);
  await client.connect();
  const migrations = await loadMigrations();
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
  // 对列表里每个版本逐条核对：缺任一版本的行（或摘要不符）都算不通过。
  const recorded = new Map(report.versions.map((row) => [row.version, row]));
  const expectedMigrations = migrations.map((migration) => {
    const row = recorded.get(migration.version);
    return { version: migration.version, name: migration.name, checksum: migration.checksum,
      recordedName: row?.name ?? null, recordedChecksum: row?.checksum?.trim() ?? null,
      checksumOk: Boolean(row) && row.name === migration.name && row.checksum.trim() === migration.checksum };
  });
  const head = migrations[migrations.length - 1];
  const checksumOk = expectedMigrations.every((item) => item.checksumOk);
  console.log(JSON.stringify({ target: 'test', schema: TARGET_SCHEMA, pooledEndpoint: isPooledEndpoint(connectionString),
    expectedVersion: SCHEMA_VERSION, expectedChecksum: head?.checksum ?? null,
    expectedMigrations, checksumOk,
    missingTables, dangerous: report.dangerous, versions: report.versions,
    columns: report.columns, indexes: report.indexes, constraints: report.constraints }, null, 2));
  if (!checksumOk || missingTables.length || report.dangerous.length) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
