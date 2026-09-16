#!/usr/bin/env node
import { applyMigration, createClient, isPooledEndpoint, parseTarget, probeEndpoint, requireTestDatabaseUrl, safeError } from './db-migration-lib.mjs';

let client;
let connectionString;
try {
  parseTarget(process.argv.slice(2));
  connectionString = requireTestDatabaseUrl();
  if (isPooledEndpoint(connectionString)) {
    console.error('提示：TEST_DATABASE_URL 指向 Neon pooler 端点；迁移依赖会话语义，执行前会先实测校验。');
  }
  const endpoint = await probeEndpoint(connectionString);
  if (!endpoint.serializedLocks || !endpoint.transactionPinned) {
    throw new Error(`连接端点不满足迁移所需的事务语义（serializedLocks=${endpoint.serializedLocks}, transactionPinned=${endpoint.transactionPinned}）`);
  }
  client = createClient(connectionString);
  await client.connect();
  console.log(JSON.stringify({ ...(await applyMigration(client)), endpoint }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: safeError(error) }));
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
