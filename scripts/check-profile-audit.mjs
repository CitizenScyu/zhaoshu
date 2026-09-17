// Offline SQL integration check. Pass an installed PGlite dist/index.js path;
// this script never reads DATABASE_URL or connects to a database server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node scripts/check-profile-audit.mjs <pglite/dist/index.js>');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const schemaSource = await readFile(new URL('../src/lib/business-schema.ts', import.meta.url), 'utf8');
const querySource = await readFile(new URL('../src/lib/user-data.ts', import.meta.url), 'utf8');
// 画像 CAS/审计 SQL 由 user-data.ts 的 saveProfileForUserQuery 构造，db.ts 的
// saveProfileForUser 只负责注入带授权边界的事务写入器。
const queryTemplate = /return sql`(\s*WITH input AS \([\s\S]*?)`;\s*\n\}/.exec(querySource)?.[1];
assert.ok(queryTemplate, 'Read the actual application CAS/audit SQL');
const scenarios = [];
async function scenario(name, check) { await check(); scenarios.push(name); }
const seed = (title) => ({ title, kind: 'love' });
const savedProfile = async (id = 1) => (await db.query('SELECT seeds, content, updated_at::text AS version FROM profile WHERE id = $1', [id])).rows[0];
const audits = async () => (await db.query('SELECT * FROM profile_seed_audit ORDER BY id')).rows;

function save(seeds, content, expectedUpdatedAt, userId = 1) {
  const input = { 'JSON.stringify(seeds)': JSON.stringify(seeds), content, userId, expectedUpdatedAt };
  const params = [];
  const query = queryTemplate.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
    assert.ok(Object.hasOwn(input, expression), 'Unexpected SQL parameter: ' + expression);
    params.push(input[expression]);
    return '$' + params.length;
  });
  return db.query(query, params);
}

try {
  // profile 现在通过外键指向 users；这里只建最小账号桩，不复制认证 schema。
  await db.exec('CREATE TABLE users (id int PRIMARY KEY)');
  await db.query('INSERT INTO users VALUES (1), (2)');
  for (const table of ['profile', 'profile_seed_audit']) {
    // business-schema.ts 现在把 DDL 合成单次事务（task-55），语句由事务回调里的 tx 标签构造。
    const ddl = new RegExp('(?:await s|tx)`\\s*(CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?)`').exec(schemaSource)?.[1];
    assert.ok(ddl, 'Read actual runtime DDL for ' + table);
    await db.exec(ddl);
  }
  await db.query("INSERT INTO profile (id, seeds, content, updated_at) VALUES (1, $1::jsonb, 'old', '2026-09-16 00:00:00.123456+00'), (2, '[]', 'other user', '2026-09-16 00:00:00.123456+00')", [JSON.stringify([seed('甲书'), seed('乙书')])]);
  const original = await savedProfile();

  await scenario('removal and recovery snapshots commit atomically', async () => {
    assert.equal((await save([seed('甲书')], 'new', original.version)).rows.length, 1);
    const [audit] = await audits();
    assert.deepEqual(audit.removed_titles, ['乙书']);
    assert.deepEqual(audit.added_titles, []);
    assert.deepEqual(audit.previous_seeds, original.seeds);
    assert.deepEqual(audit.saved_seeds, [seed('甲书')]);
    assert.equal(audit.previous_version, original.version);
    assert.equal(audit.saved_version, (await savedProfile()).version);
  });

  await scenario('stale snapshots write neither profile nor audit', async () => {
    assert.equal((await save([], 'stale', original.version)).rows.length, 0);
    assert.deepEqual((await savedProfile()).seeds, [seed('甲书')]);
    assert.equal((await audits()).length, 1);
  });

  await scenario('only one submitted write using the same version wins', async () => {
    const version = (await savedProfile()).version;
    const writes = await Promise.all([save([seed('甲书'), seed('丙书')], 'A', version), save([], 'B', version)]);
    assert.deepEqual(writes.map((result) => result.rows.length).sort(), [0, 1]);
    assert.equal((await audits()).length, 2);
  });

  await scenario('content-only writes retain seeds without noisy seed audit entries', async () => {
    const current = await savedProfile();
    await save(current.seeds, 'content only', current.version);
    assert.equal((await audits()).length, 2);
  });

  await scenario('duplicate seed removals are counted with EXCEPT ALL', async () => {
    await save([seed('甲书'), seed('甲书')], 'duplicates', (await savedProfile()).version);
    await save([seed('甲书')], 'one', (await savedProfile()).version);
    assert.deepEqual((await audits()).at(-1).removed_titles, ['甲书']);
  });

  await scenario('an audit failure rolls back the profile and version', async () => {
    const before = await savedProfile();
    const count = (await audits()).length;
    await db.exec("CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON profile_seed_audit FOR EACH ROW EXECUTE FUNCTION reject_audit();");
    await assert.rejects(save([], 'must rollback', before.version), /audit unavailable/);
    assert.deepEqual(await savedProfile(), before);
    assert.equal((await audits()).length, count);
    await db.exec('DROP TRIGGER reject_audit ON profile_seed_audit; DROP FUNCTION reject_audit();');
  });

  await scenario('profile and audit remain scoped to the selected user', async () => {
    assert.deepEqual(await savedProfile(2), { seeds: [], content: 'other user', version: original.version });
    assert.ok((await audits()).every((row) => row.user_id === 1));
    const current = await savedProfile();
    assert.equal((await save([], 'wrong user', current.version, 2)).rows.length, 0);
  });

  // --- CAS CASE coverage: the version must advance on real changes and only on real changes. ---

  await scenario('a byte-identical write is a no-op that keeps the optimistic-lock version', async () => {
    const before = await savedProfile();
    const auditCount = (await audits()).length;
    const result = await save(before.seeds, before.content, before.version);
    assert.equal(result.rows.length, 1, 'the matching version must still return the CAS row');
    const after = await savedProfile();
    assert.deepEqual(after.seeds, before.seeds);
    assert.equal(after.content, before.content);
    assert.equal(after.version, before.version, 'identical seeds and content must not advance updated_at');
    assert.equal((await audits()).length, auditCount, 'identical seeds must not append a seed audit row');
    const again = await save(before.seeds, before.content, before.version);
    assert.equal(again.rows.length, 1, 'the kept version must remain valid for drafts still holding it');
    assert.equal((await savedProfile()).version, before.version, 'repeated no-op writes must not advance it either');
  });

  await scenario('a content-only change advances the version without a seed audit row', async () => {
    const before = await savedProfile();
    const auditCount = (await audits()).length;
    assert.equal((await save(before.seeds, before.content + ' v2', before.version)).rows.length, 1);
    const after = await savedProfile();
    assert.equal(after.content, before.content + ' v2');
    assert.notEqual(after.version, before.version, 'changed content must advance updated_at');
    assert.equal((await audits()).length, auditCount, 'unchanged seeds must not append a seed audit row');
    assert.equal((await save([], 'stale after content change', before.version)).rows.length, 0,
      'the pre-change version must now be stale');
  });

  await scenario('a seed-only change advances the version and records the diff', async () => {
    const before = await savedProfile();
    const auditCount = (await audits()).length;
    const nextSeeds = [...before.seeds, seed('新书')];
    assert.equal((await save(nextSeeds, before.content, before.version)).rows.length, 1,
      'identified content with changed seeds must advance, not no-op');
    const after = await savedProfile();
    assert.deepEqual(after.seeds, nextSeeds);
    assert.equal(after.content, before.content);
    assert.notEqual(after.version, before.version, 'changed seeds with identical content must advance updated_at');
    const rows = await audits();
    assert.equal(rows.length, auditCount + 1, 'changed seeds must commit exactly one audit row');
    const [audit] = rows.slice(-1);
    assert.deepEqual(audit.added_titles, ['新书']);
    assert.deepEqual(audit.removed_titles, []);
    assert.deepEqual(audit.previous_seeds, before.seeds);
    assert.deepEqual(audit.saved_seeds, nextSeeds);
    assert.equal(audit.previous_version, before.version);
    assert.equal(audit.saved_version, after.version);
    assert.equal((await save([], 'stale after seed change', before.version)).rows.length, 0,
      'the pre-change version must now be stale');
  });

  console.log(JSON.stringify({ engine: 'PGlite (in-memory PostgreSQL)', passed: scenarios.length, scenarios }, null, 2));
} finally { await db.close(); }
