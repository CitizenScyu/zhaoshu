import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizedTransaction, AuthorizationRevokedError } from '../src/lib/personal-write.ts';
import { withTestSchema, reportDatabaseFailure } from './auth-db-fixtures.mjs';

export async function checkPersonalWrite() {
  return withTestSchema(async (sql) => {
    await sql.transaction((tx) => [
      tx`CREATE TABLE users (id int PRIMARY KEY, role text, can_find boolean, disabled_at timestamptz)`,
      tx`CREATE TABLE auth_settings (id int PRIMARY KEY, members_enabled boolean)`,
      tx`CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id int, auth_method text, owner_credential_tag text, expires_at timestamptz)`,
      tx`CREATE TABLE profile (id int PRIMARY KEY, content text NOT NULL)`,
      tx`INSERT INTO users VALUES (2, 'member', true, NULL), (3, 'member', true, NULL)`,
      tx`INSERT INTO auth_settings VALUES (1, true)`,
      tx`INSERT INTO sessions VALUES (${'a'.repeat(64)}, 2, 'password', NULL, now() + interval '1 hour')`,
      tx`INSERT INTO profile VALUES (2, 'before'), (3, 'B-private')`,
    ]);
    const actor = () => ({ userId: 2, role: 'member', method: 'session', tokenHash: 'a'.repeat(64), ownerTag: null, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const write = (value, grant = actor()) => authorizedTransaction(sql, grant,
      (tx) => [tx`UPDATE profile SET content = ${value} WHERE id = ${grant.userId}`], new AbortController().signal);
    await write('allowed');
    assert.deepEqual(await sql`SELECT id, content FROM profile ORDER BY id`, [{ id: 2, content: 'allowed' }, { id: 3, content: 'B-private' }]);
    let passed = 1;
    // 模拟应用已经复核完毕、但事务开始前发生撤销的窗口。
    for (const change of ['logout', 'disabled', 'downgraded', 'members-closed']) {
      await sql.transaction((tx) => [
        tx`UPDATE users SET can_find = true, disabled_at = NULL WHERE id = 2`,
        tx`UPDATE auth_settings SET members_enabled = true WHERE id = 1`,
        tx`INSERT INTO sessions VALUES (${'a'.repeat(64)}, 2, 'password', NULL, now() + interval '1 hour') ON CONFLICT DO NOTHING`,
      ]);
      if (change === 'logout') await sql`DELETE FROM sessions WHERE user_id = 2`;
      if (change === 'disabled') await sql`UPDATE users SET disabled_at = now() WHERE id = 2`;
      if (change === 'downgraded') await sql`UPDATE users SET can_find = false WHERE id = 2`;
      if (change === 'members-closed') await sql`UPDATE auth_settings SET members_enabled = false WHERE id = 1`;
      await assert.rejects(write('forbidden'), AuthorizationRevokedError);
      assert.equal((await sql`SELECT content FROM profile WHERE id = 2`)[0].content, 'allowed');
      passed++;
    }
    await sql`UPDATE auth_settings SET members_enabled = true WHERE id = 1`;
    const grant = { ...actor(), expiresAt: new Date(Date.now() + 1_500).toISOString() };
    await assert.rejects(authorizedTransaction(sql, grant, (tx) => [
      tx`UPDATE profile SET content = 'must-rollback' WHERE id = 2`,
      tx`SELECT pg_sleep(2)`,
    ], new AbortController().signal), (error) => error.code === '57014');
    assert.equal((await sql`SELECT content FROM profile WHERE id = 2`)[0].content, 'allowed');
    passed++;
    console.log(`最终授权事务真库检查：${passed}/${passed} 通过；独立测试 schema 已隔离。`);
    return passed;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkPersonalWrite().catch(reportDatabaseFailure);
}
