#!/usr/bin/env node
import { createClient, evaluateSchema, inspectSchema, isPooledEndpoint, loadMigrations, parseTarget, requireTestDatabaseUrl, safeError, SCHEMA_VERSION, TARGET_SCHEMA } from './db-migration-lib.mjs';

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
  // 逐版本核对摘要、缺表、auth 记账版本，判定集中在 evaluateSchema（有真库测试钉住）。
  const verdict = evaluateSchema(report, migrations);
  const head = migrations[migrations.length - 1];
  console.log(JSON.stringify({ target: 'test', schema: TARGET_SCHEMA, pooledEndpoint: isPooledEndpoint(connectionString),
    expectedVersion: SCHEMA_VERSION, expectedChecksum: head?.checksum ?? null,
    expectedMigrations: verdict.expectedMigrations, checksumOk: verdict.checksumOk,
    authVersion: verdict.authVersion, expectedAuthVersion: verdict.expectedAuthVersion, authVersionOk: verdict.authVersionOk,
    artifactVersion: verdict.artifactVersion, expectedArtifactVersion: verdict.expectedArtifactVersion, artifactVersionOk: verdict.artifactVersionOk,
    missingTables: verdict.missingTables, dangerous: report.dangerous, versions: report.versions,
    columns: report.columns, indexes: report.indexes, constraints: report.constraints }, null, 2));
  if (!verdict.ok) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
