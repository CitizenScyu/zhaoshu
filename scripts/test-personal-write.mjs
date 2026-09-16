import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
    const waitForLock = async (key) => {
      const until = Date.now() + 12_000;
      while (Date.now() < until) {
        const rows = await sql`SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE locktype='advisory' AND classid=3205 AND objid=${key} AND granted) AS ready`;
        if (rows[0].ready) return;
        await delay(100);
      }
      throw new Error('authorization race marker was not observed');
    };
    for (const change of ['logout', 'disabled', 'downgraded']) {
      const reset = () => sql.transaction((tx) => [
        tx`UPDATE users SET can_find=true,disabled_at=NULL WHERE id=2`,
        tx`INSERT INTO sessions VALUES (${'a'.repeat(64)},2,'password',NULL,now()+interval '1 hour') ON CONFLICT DO NOTHING`,
      ]);
      const revoke = (tx) => change === 'logout' ? tx`DELETE FROM sessions WHERE user_id=2`
        : change === 'disabled' ? tx`UPDATE users SET disabled_at=now() WHERE id=2`
          : tx`UPDATE users SET can_find=false WHERE id=2`;
      await reset();
      const key = randomInt(1, 2_000_000_000);
      const writing = authorizedTransaction(sql, actor(), (tx) => [
        tx`SELECT pg_advisory_xact_lock(3205,${key})`,
        tx`UPDATE profile SET content=${'write-first-' + change} WHERE id=2`,
        tx`SELECT pg_sleep(5)`,
      ], new AbortController().signal);
      void writing.catch(() => {});
      try {
        await waitForLock(key); // 已经过前置授权并持有用户/会话 SHARE 行锁。
        await assert.rejects(sql.transaction((tx) => [
          tx`SELECT set_config('lock_timeout','200ms',true)`, revoke(tx),
        ]), (error) => error.code === '55P03');
        await writing;
        await revoke(sql);
        await assert.rejects(write('forbidden-after-revoke'), AuthorizationRevokedError);
        passed++;
      } finally { await writing.catch(() => {}); }

      await reset();
      const before = (await sql`SELECT content FROM profile WHERE id=2`)[0].content;
      const revokeKey = randomInt(1, 2_000_000_000);
      const revoking = sql.transaction((tx) => [
        revoke(tx), tx`SELECT pg_advisory_xact_lock(3205,${revokeKey})`, tx`SELECT pg_sleep(5)`,
      ]);
      void revoking.catch(() => {});
      try {
        await waitForLock(revokeKey); // 撤销先持锁但尚未提交，写事务必须等候并重新检查。
        await assert.rejects(write('forbidden-racing-revoke'), AuthorizationRevokedError);
        await revoking;
        assert.equal((await sql`SELECT content FROM profile WHERE id=2`)[0].content, before);
        passed++;
      } finally { await revoking.catch(() => {}); }
    }
    console.log(`最终授权事务真库检查：${passed}/${passed} 通过；独立测试 schema 已隔离。`);
    return passed;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkPersonalWrite().catch(reportDatabaseFailure);
}
