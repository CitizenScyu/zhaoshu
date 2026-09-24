import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigration, assertIdentifier, createClient, EXPECTED_TABLES, inspectSchema, loadMigrations, runInSchema } from '../../scripts/db-migration-lib.mjs';

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

// 结构契约同时钉住「跑过哪些版本」：每个迁移版本都必须有一行且摘要与文件一致。
async function assertContract(client, schema, migrations) {
  const report = await inspectSchema(client, schema);
  const tables = new Set(report.columns.map((column) => column.table_name));
  assert.deepEqual(EXPECTED_TABLES.filter((table) => !tables.has(table)), []);
  assert.equal(report.dangerous.length, 0);
  assert.equal(report.versions.length, migrations.length);
  for (const migration of migrations) {
    const row = report.versions.find((item) => item.version === migration.version);
    assert.ok(row, `缺少迁移版本 ${migration.version} 的记账行`);
    assert.equal(row.name, migration.name);
    assert.equal(row.checksum.trim(), migration.checksum);
  }
  // 0002 的身份键落点：指纹相等已覆盖，这里显式断言让失败信息可读。
  for (const table of ['books', 'labeled_books']) {
    const columns = new Set(report.columns.filter((column) => column.table_name === table).map((column) => column.column_name));
    assert.ok(columns.has('title_key') && columns.has('author_key'), `${table} 缺少身份键生成列`);
  }
  const indexNames = new Set(report.indexes.map((index) => index.index_name));
  assert.ok(indexNames.has('books_identity_idx'), '缺少 books_identity_idx');
  assert.ok(indexNames.has('labeled_books_identity_idx'), '缺少 labeled_books_identity_idx');
  assert.ok(!indexNames.has('books_title_author_idx'), '旧表达式唯一索引不应存在');
  assert.ok(!indexNames.has('labeled_books_title_author_idx'), '旧表达式唯一索引不应存在');
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
  const schemas = Object.fromEntries(['empty', 'legacy', 'worker', 'manual', 'concurrent', 'failure', 'danger']
    .map((name) => [name, `migration_test_${runId}_${name}`]));
  const migrations = await loadMigrations();
  const results = [];
  const fingerprints = {};
  try {
    for (const [fixture, key] of [['empty.sql', 'empty'], ['legacy-app.sql', 'legacy'], ['worker-first.sql', 'worker']]) {
      const schema = schemas[key];
      const client = await createFixture(connectionString, schema, fixture);
      const first = await applyMigration(client, migrations, { schema });
      const second = await applyMigration(client, migrations, { schema });
      assert.equal(first.status, 'applied');
      assert.deepEqual(first.versions.map((item) => item.status), migrations.map(() => 'applied'));
      assert.equal(second.status, 'unchanged');
      fingerprints[fixture] = fingerprint(await assertContract(client, schema, migrations));
      await preservationChecks[fixture]?.(client, schema);
      await client.end();
      results.push({ fixture, first: first.status, second: second.status, historyPreserved: true });
    }

    // 第四类起点（生产形态）：只跑 0001 并记账，再裸跑 0002 的 DDL 但不记账——
    // 也就是「生产已手工执行过 0002」。再跑迁移必须只补记 v2、不重放任何 DDL。
    const manual = await createFixture(connectionString, schemas.manual, 'empty.sql');
    const onlyV1 = migrations.find((item) => item.version === 1);
    const identityV2 = migrations.find((item) => item.version === 2);
    assert.ok(onlyV1 && identityV2, '需要 v1 与 v2 两个迁移文件');
    const firstV1 = await applyMigration(manual, [onlyV1], { schema: schemas.manual });
    assert.equal(firstV1.status, 'applied');
    assert.deepEqual(firstV1.versions.map((item) => item.version), [1]);
    await runInSchema(manual, schemas.manual, () => manual.query(identityV2.sql));
    assert.equal((await manual.query(`SELECT count(*)::int AS n FROM ${assertIdentifier(schemas.manual)}.schema_migrations`)).rows[0].n, 1);
    const manualFirst = await applyMigration(manual, migrations, { schema: schemas.manual });
    assert.equal(manualFirst.status, 'applied');
    assert.deepEqual(manualFirst.versions.map((item) => [item.version, item.status]),
      migrations.map((item) => [item.version, item.version === 1 ? 'unchanged' : 'applied']));
    const manualSecond = await applyMigration(manual, migrations, { schema: schemas.manual });
    assert.equal(manualSecond.status, 'unchanged');
    assert.deepEqual(manualSecond.versions.map((item) => item.status), migrations.map(() => 'unchanged'));
    fingerprints['manual-0002.sql'] = fingerprint(await assertContract(manual, schemas.manual, migrations));
    await manual.end();
    results.push({ fixture: 'manual-0002.sql', first: manualFirst.status, second: manualSecond.status, historyPreserved: true });

    assert.equal(new Set(Object.values(fingerprints)).size, 1, '四类起点升级后必须得到同一份结构契约');
    results.push({ identicalContract: Object.keys(fingerprints) });

    const seed = await createFixture(connectionString, schemas.concurrent, 'empty.sql');
    await seed.end();
    const [left, right] = await Promise.all([connect(connectionString), connect(connectionString)]);
    const concurrent = await Promise.all([
      applyMigration(left, migrations, { schema: schemas.concurrent }),
      applyMigration(right, migrations, { schema: schemas.concurrent }),
    ]);
    assert.deepEqual(concurrent.map((item) => item.status).sort(), ['applied', 'unchanged']);
    assert.equal(fingerprint(await assertContract(left, schemas.concurrent, migrations)), fingerprints['empty.sql']);
    await Promise.all([left.end(), right.end()]);
    results.push({ concurrent: concurrent.map((item) => item.status) });

    const failure = await createFixture(connectionString, schemas.failure, 'empty.sql');
    await assert.rejects(applyMigration(failure, [{
      version: 99, name: 'fault.sql', checksum: 'f'.repeat(64),
      sql: 'CREATE TABLE must_rollback(id int); SELECT missing_column FROM must_rollback',
    }], { schema: schemas.failure }));
    assert.equal((await failure.query(`SELECT to_regclass('${schemas.failure}.must_rollback') AS value`)).rows[0].value, null);
    assert.equal((await failure.query(`SELECT to_regclass('${schemas.failure}.schema_migrations') AS value`)).rows[0].value, null);
    await failure.end();
    results.push({ failureRollback: 'verified' });

    const danger = await createFixture(connectionString, schemas.danger, 'worker-first.sql');
    const inserted = await danger.query(
      `INSERT INTO ${assertIdentifier(schemas.danger)}.download_tasks(book_id, title)
       VALUES(NULL, 'ambiguous') RETURNING id`);
    const blockedId = inserted.rows[0].id;
    const blocked = await applyMigration(danger, migrations, { schema: schemas.danger }).then(() => null, (error) => error);
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
