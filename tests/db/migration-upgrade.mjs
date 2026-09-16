import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigration, assertIdentifier, createClient, EXPECTED_TABLES, inspectSchema, loadMigration, runInSchema } from '../../scripts/db-migration-lib.mjs';

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function connect(connectionString) {
  const client = createClient(connectionString);
  await client.connect();
  return client;
}

// 不设置任何会话级 search_path：夹具 SQL 在事务里用 SET LOCAL 落到临时 schema。
async function createFixture(connectionString, schema, fixture) {
  const admin = await connect(connectionString);
  await admin.query(`CREATE SCHEMA ${assertIdentifier(schema)}`);
  await admin.end();
  const client = await connect(connectionString);
  const sql = await readFile(resolve(fixtureDir, fixture), 'utf8');
  await runInSchema(client, schema, () => client.query(sql));
  return client;
}

// 三类起点必须收敛到同一份结构契约：把 schema 名擦掉后比对全部列/索引/约束。
// 比较按行排序后进行：旧库的 user_id 是 ALTER 追加的，物理列序必然排在末尾，
// 而 SQL 一律按列名访问，统一列序需要重建表——本批不做有损重建，因此列序不算契约差异。
function fingerprint(report) {
  const scrub = (text) => String(text).replaceAll(`"${report.schema}".`, '').replaceAll(`${report.schema}.`, '');
  const rows = (items) => items.map((item) => JSON.stringify(item)).sort();
  return JSON.stringify({
    columns: rows(report.columns.map((c) => [c.table_name, c.column_name, c.data_type, c.is_nullable, scrub(c.column_default ?? '')])),
    indexes: rows(report.indexes.map((i) => [i.index_name, scrub(i.indexdef)])),
    constraints: rows(report.constraints.map((c) => [c.table_name, c.conname, scrub(c.definition)])),
  });
}

async function assertContract(client, schema, expectedChecksum) {
  const report = await inspectSchema(client, schema);
  const tables = new Set(report.columns.map((column) => column.table_name));
  assert.deepEqual(EXPECTED_TABLES.filter((table) => !tables.has(table)), []);
  assert.equal(report.dangerous.length, 0);
  assert.equal(report.versions.length, 1);
  assert.equal(report.versions[0].version, 1);
  assert.equal(report.versions[0].checksum.trim(), expectedChecksum);
  const required = report.columns.filter((column) => column.table_name === 'download_tasks');
  assert.ok(required.length > 0 && required.every((column) => column.is_nullable === 'NO'));
  return report;
}

// 迁移不得删除历史数据：逐条核对三类起点里既有行的归属与内容。
const preservationChecks = {
  'empty.sql': null,
  'legacy-app.sql': async (client, schema) => {
    const t = assertIdentifier(schema);
    const count = async (relation, where = '') =>
      (await client.query(`SELECT count(*)::int AS n FROM ${t}.${relation} ${where}`)).rows[0].n;
    assert.equal(await count('books'), 1);
    assert.equal((await client.query(`SELECT content FROM ${t}.profile WHERE id = 1`)).rows[0].content, 'legacy');
    assert.equal(await count('recommendations', 'WHERE user_id = 1'), 1);
    assert.equal(await count('feedback', 'WHERE user_id = 1'), 1);
    assert.equal(await count('recommendations', 'WHERE user_id IS NULL'), 0);
    assert.equal(await count('feedback', 'WHERE user_id IS NULL'), 0);
  },
  'worker-first.sql': async (client, schema) => {
    const t = assertIdentifier(schema);
    assert.deepEqual((await client.query(`SELECT count(*)::int AS n FROM ${t}.download_tasks`)).rows, [{ n: 1 }]);
    assert.deepEqual((await client.query(`SELECT status, chapters_total FROM ${t}.download_tasks`)).rows,
      [{ status: 'pending', chapters_total: 0 }]);
  },
};

export async function runMigrationUpgradeSuite(connectionString) {
  const runId = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const schemas = Object.fromEntries(['empty', 'legacy', 'worker', 'concurrent', 'failure', 'danger']
    .map((name) => [name, `migration_test_${runId}_${name}`]));
  const migration = await loadMigration();
  const results = [];
  const fingerprints = {};
  try {
    for (const [fixture, key] of [['empty.sql', 'empty'], ['legacy-app.sql', 'legacy'], ['worker-first.sql', 'worker']]) {
      const schema = schemas[key];
      const client = await createFixture(connectionString, schema, fixture);
      const first = await applyMigration(client, migration, { schema });
      const second = await applyMigration(client, migration, { schema });
      assert.equal(first.status, 'applied');
      assert.equal(second.status, 'unchanged');
      fingerprints[fixture] = fingerprint(await assertContract(client, schema, migration.checksum));
      await preservationChecks[fixture]?.(client, schema);
      await client.end();
      results.push({ fixture, first: first.status, second: second.status, historyPreserved: true });
    }
    assert.equal(new Set(Object.values(fingerprints)).size, 1, '三类起点升级后必须得到同一份结构契约');
    results.push({ identicalContract: Object.keys(fingerprints) });

    const seed = await createFixture(connectionString, schemas.concurrent, 'empty.sql');
    await seed.end();
    const [left, right] = await Promise.all([connect(connectionString), connect(connectionString)]);
    const concurrent = await Promise.all([
      applyMigration(left, migration, { schema: schemas.concurrent }),
      applyMigration(right, migration, { schema: schemas.concurrent }),
    ]);
    assert.deepEqual(concurrent.map((item) => item.status).sort(), ['applied', 'unchanged']);
    assert.equal(fingerprint(await assertContract(left, schemas.concurrent, migration.checksum)), fingerprints['empty.sql']);
    await Promise.all([left.end(), right.end()]);
    results.push({ concurrent: concurrent.map((item) => item.status) });

    const failure = await createFixture(connectionString, schemas.failure, 'empty.sql');
    await assert.rejects(applyMigration(failure, {
      version: 99, name: 'fault.sql', checksum: 'f'.repeat(64),
      sql: 'CREATE TABLE must_rollback(id int); SELECT missing_column FROM must_rollback',
    }, { schema: schemas.failure }));
    assert.equal((await failure.query(`SELECT to_regclass('${schemas.failure}.must_rollback') AS value`)).rows[0].value, null);
    assert.equal((await failure.query(`SELECT to_regclass('${schemas.failure}.schema_migrations') AS value`)).rows[0].value, null);
    await failure.end();
    results.push({ failureRollback: 'verified' });

    const danger = await createFixture(connectionString, schemas.danger, 'worker-first.sql');
    const inserted = await danger.query(
      `INSERT INTO ${assertIdentifier(schemas.danger)}.download_tasks(book_id, title)
       VALUES(NULL, 'ambiguous') RETURNING id`);
    const blockedId = inserted.rows[0].id;
    const blocked = await applyMigration(danger, migration, { schema: schemas.danger }).then(() => null, (error) => error);
    assert.ok(blocked, '含无法推断的必填 NULL 时必须阻断迁移');
    assert.match(blocked.message, /record ids:/);
    assert.match(blocked.message, new RegExp(`record ids: ${blockedId}(\\D|$)`));
    assert.equal((await danger.query(`SELECT to_regclass('${schemas.danger}.schema_migrations') AS value`)).rows[0].value, null);
    assert.equal((await danger.query(`SELECT count(*)::int AS n FROM ${assertIdentifier(schemas.danger)}.download_tasks`)).rows[0].n, 2);
    await danger.end();
    results.push({ dangerousNulls: 'blocked-with-id', blockedRecordId: blockedId });
    return results;
  } finally {
    const admin = await connect(connectionString);
    for (const schema of Object.values(schemas)) {
      assert.match(schema, /^migration_test_[a-zA-Z0-9_]+$/);
      await admin.query(`DROP SCHEMA IF EXISTS ${assertIdentifier(schema)} CASCADE`);
    }
    await admin.end();
  }
}
