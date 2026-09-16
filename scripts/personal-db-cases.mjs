import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeAuthSchema, assertAuthSchema } from '../src/lib/auth-store.ts';
import { initializeAuthSchema as initializeV3 } from './fixtures/auth-schema-v3.ts';
import { initializeBusinessSchema } from '../src/lib/business-schema.ts';
import { authorizedTransaction } from '../src/lib/personal-write.ts';
import {
  profileForUserQuery, saveProfileForUserQuery, persistRecommendationsForUserQueries,
  feedbackForUserQueries, feedbackSnapshotForUserQuery, recommendationsForUserQuery, deleteShelfForUserQuery,
  personalExportQueries, findStatsForUserQuery, shelfStatsForUserQuery,
  addShelfForUserQueries, shelfExistsForUserQuery,
} from '../src/lib/user-data.ts';
import { withTestSchema } from './auth-db-fixtures.mjs';
import { checkPersonalWrite } from './test-personal-write.mjs';

export async function migrationMetadata(sql) {
  const exists = await sql`SELECT to_regclass('auth_schema_migrations') IS NOT NULL AS exists`;
  const version = exists[0].exists ? (await sql`SELECT max(version)::int AS version FROM auth_schema_migrations`)[0].version : null;
  const constraints = await sql`SELECT t.relname AS table_name, c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema() AND t.relname IN ('profile','recommendations','feedback') ORDER BY t.relname,c.conname`;
  const defaults = await sql`SELECT c.relname AS table_name, a.attname AS column_name, a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS value
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = current_schema() AND ((c.relname = 'profile' AND a.attname = 'id') OR
      (c.relname IN ('recommendations','feedback') AND a.attname = 'user_id')) ORDER BY c.relname`;
  const indexes = await sql`SELECT indexname AS name,indexdef AS definition FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'recommendations' ORDER BY indexname`;
  return { version, constraints, defaults, indexes };
}

async function legacyDatabase(sql) {
  await sql.transaction((tx) => [
    tx`CREATE TABLE profile (id integer PRIMARY KEY DEFAULT 1,seeds jsonb NOT NULL DEFAULT '[]',content text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now())`,
    tx`CREATE TABLE books (id serial PRIMARY KEY,title text NOT NULL,author text NOT NULL,douban_id text,douban_rating float8,douban_rating_count int,meta jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now())`,
    tx`CREATE UNIQUE INDEX books_title_author_idx ON books (lower(title),lower(author))`,
    tx`CREATE TABLE recommendations (id serial PRIMARY KEY,book_id int NOT NULL REFERENCES books(id),query text NOT NULL,match_score float8,hit_likes jsonb,risks text,reason text,status text NOT NULL DEFAULT 'new',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(book_id,query))`,
    tx`CREATE UNIQUE INDEX recommendations_book_query_idx ON recommendations (book_id,query)`,
    tx`CREATE TABLE feedback (id serial PRIMARY KEY,book_id int NOT NULL REFERENCES books(id),status text NOT NULL,note text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now())`,
    tx`INSERT INTO profile(id,seeds,content,updated_at) VALUES(1,'[{"title":"历史种子𠮷"}]','历史原文\n不能覆写','2026-09-15 00:00:00.123456+00')`,
    tx`INSERT INTO books(title,author) VALUES('owner-only-book','历史作者')`,
    tx`INSERT INTO recommendations(book_id,query,reason) SELECT id,'legacy-query','owner-private-reason' FROM books`,
    tx`INSERT INTO feedback(book_id,status,note) SELECT id,'done','owner-private-note' FROM books`,
  ]);
  await initializeV3(sql);
}

async function history(sql) {
  return sql.transaction((tx) => [
    tx`SELECT id,seeds,content,updated_at::text AS updated_at FROM profile ORDER BY id`,
    tx`SELECT * FROM recommendations ORDER BY id`,tx`SELECT * FROM feedback ORDER BY id`,
  ],{isolationLevel:'RepeatableRead',readOnly:true});
}
function assertClosedV4(metadata) {
  assert.equal(metadata.version,4);
  assert.equal(metadata.defaults.length,3);
  assert.ok(metadata.defaults.every((column)=>column.value===null && column.not_null));
  assert.equal(metadata.indexes.filter((index)=>/\(book_id, query\)/.test(index.definition)).length,0);
  assert.equal(metadata.indexes.filter((index)=>/UNIQUE INDEX.*\(user_id, book_id, query\)/.test(index.definition)).length,1);
  assert.equal(metadata.constraints.filter((constraint)=>constraint.type==='f' && /REFERENCES users\(id\)/.test(constraint.definition)).length,3);
}

export async function personalMigrationCase() {
  let checks=0;
  await withTestSchema(async(sql)=>{
    await legacyDatabase(sql);
    assert.equal((await migrationMetadata(sql)).version,3);checks++;
    const before=await history(sql);
    await sql`ALTER TABLE recommendations RENAME CONSTRAINT recommendations_book_id_query_key TO legacy_renamed_unique`;
    await Promise.all([initializeAuthSchema(sql),initializeAuthSchema(sql)]);
    assertClosedV4(await migrationMetadata(sql));checks++;
    assert.deepEqual(await history(sql),before);checks++;
    assert.equal(before[0][0].updated_at,'2026-09-15 00:00:00.123456+00');checks++;
    await initializeAuthSchema(sql);assertClosedV4(await migrationMetadata(sql));checks++;
    await assertAuthSchema(sql);await initializeBusinessSchema(sql);
    assertClosedV4(await migrationMetadata(sql));assert.deepEqual(await history(sql),before);checks++;
    assert.deepEqual(await sql`SELECT members_enabled,registration_mode FROM auth_settings WHERE id=1`,[{members_enabled:false,registration_mode:'closed'}]);checks++;
    const [{id}]=await sql`SELECT id FROM books ORDER BY id LIMIT 1`;
    await assert.rejects(sql`INSERT INTO recommendations(book_id,query) VALUES(${id},'missing-user')`,(e)=>e.code==='23502');checks++;
    await assert.rejects(sql`INSERT INTO feedback(book_id,status) VALUES(${id},'done')`,(e)=>e.code==='23502');checks++;
    await sql`INSERT INTO auth_schema_migrations(version) VALUES(99)`;
    await assert.rejects(initializeAuthSchema(sql));await assert.rejects(assertAuthSchema(sql));checks++;
  });
  await withTestSchema(async(sql)=>{
    await legacyDatabase(sql);const before=await history(sql);
    await sql`DROP INDEX recommendations_book_query_idx`;
    await assert.rejects(initializeAuthSchema(sql));
    assert.equal((await migrationMetadata(sql)).version,3);assert.deepEqual(await history(sql),before);checks++;
  });
  console.log(`personal-migration：${checks}/${checks} 检查通过。`);
  return checks;
}

async function waitForMarker(sql,key) {
  const until=Date.now()+12_000;
  while(Date.now()<until) {
    const rows=await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=3204 AND objid=${key} AND granted) AS ready`;
    if(rows[0].ready)return;
    await delay(100);
  }
  throw new Error('snapshot marker was not observed');
}
function verifyExport(userId,datasets) {
  const [profiles,books,recommendations,feedback]=datasets;
  assert.ok(profiles.every((row)=>row.id===userId));
  assert.ok(recommendations.every((row)=>row.user_id===userId));
  assert.ok(feedback.every((row)=>row.user_id===userId));
  assert.deepEqual(new Set(books.map((book)=>book.id)),new Set([...recommendations,...feedback].map((row)=>row.book_id)));
  assert.ok(!JSON.stringify(datasets).includes('fixture-password-hash'));
}

export async function personalIsolationCase() {
  let checks=0;
  await withTestSchema(async(sql)=>{
    await legacyDatabase(sql);await initializeAuthSchema(sql);await initializeBusinessSchema(sql);
    await sql.transaction((tx)=>[
      tx`INSERT INTO users(id,username,password_hash,role) VALUES(2,'member_a','fixture-password-hash','member'),(3,'member_b','fixture-password-hash','member')`,
      tx`INSERT INTO profile(id,seeds,content,updated_at) VALUES(2,'[]','A-private','2099-01-01 00:00:00.123456+00'),(3,'[]','B-private','2099-01-01 00:00:00.123456+00')`,
      tx`INSERT INTO sessions(token_hash,user_id,auth_method,expires_at) VALUES(${'a'.repeat(64)},2,'password',now()+interval '1 hour'),(${'b'.repeat(64)},3,'password',now()+interval '1 hour')`,
      tx`UPDATE auth_settings SET members_enabled=true WHERE id=1`,
    ]);
    const grant=(userId)=>({userId,role:'member',method:'session',tokenHash:(userId===2?'a':'b').repeat(64),ownerTag:null,expiresAt:new Date(Date.now()+60_000).toISOString()});
    const write=(userId,batch)=>authorizedTransaction(sql,grant(userId),batch,new AbortController().signal);
    const version='2099-01-01 00:00:00.123456+00';
    const updated=await Promise.all([2,3].map((id)=>write(id,(tx)=>[saveProfileForUserQuery(tx,id,[],`user-${id}`,version)])));
    assert.ok(updated.every((rows)=>rows[0][0].updated_at==='2099-01-01 00:00:00.123457+00'));checks++;
    const racing=await Promise.all(['one','two'].map((content)=>write(2,(tx)=>[saveProfileForUserQuery(tx,2,[],content,updated[0][0][0].updated_at)])));
    assert.equal(racing.filter((rows)=>rows[0].length===1).length,1);
    assert.equal((await profileForUserQuery(sql,2))[0].updated_at,'2099-01-01 00:00:00.123458+00');checks++;
    const shelfA=await write(2,(tx)=>addShelfForUserQueries(tx,2,'shared-shelf-book','同一作者'));
    const shelfB=await write(3,(tx)=>addShelfForUserQueries(tx,3,'shared-shelf-book','同一作者'));
    assert.equal(shelfA[1][0].book_id,shelfB[1][0].book_id);
    assert.equal((await write(2,(tx)=>addShelfForUserQueries(tx,2,'shared-shelf-book','同一作者')))[1].length,0);checks++;
    const shelfRows=await sql`SELECT id,user_id FROM recommendations WHERE book_id=${shelfA[1][0].book_id} ORDER BY user_id`;
    await write(2,(tx)=>[deleteShelfForUserQuery(tx,2,shelfRows[0].id)]);
    assert.equal((await shelfExistsForUserQuery(sql,2,'shared-shelf-book','同一作者')).length,0);
    assert.equal((await shelfExistsForUserQuery(sql,3,'shared-shelf-book','同一作者')).length,1);checks++;
    await write(3,(tx)=>[deleteShelfForUserQuery(tx,3,shelfRows[1].id)]);
    const common={title:'shared-book',author:'共同作者',category:'测试',wordCount:100,matchScore:80,hitLikes:['设定'],risks:'',reason:'A-reason'};
    await write(2,(tx)=>persistRecommendationsForUserQueries(tx,2,'same-query',[common]));
    await write(3,(tx)=>persistRecommendationsForUserQueries(tx,3,'same-query',[{...common,reason:'B-reason'}]));
    assert.equal((await sql`SELECT count(*)::int AS n FROM recommendations WHERE query='same-query'`)[0].n,2);checks++;
    // 前两次是各用户的首次创建（版本 0）；第三次是 user2 的二次写入并清空 note，
    // 必须带上当前版本，才能验证「清空 note 不回退旧原因」的追加语义。版本从快照
    // 读出（与路由同源），不写死：legacy 迁移保留的历史反馈会占用更小的 id。
    await write(2,(tx)=>feedbackForUserQueries(tx,2,common,'done','A-note',0));
    await write(3,(tx)=>feedbackForUserQueries(tx,3,common,'reading','B-note',0));
    const [[{id:currentFeedbackVersion}]]=await sql.transaction((tx)=>[feedbackSnapshotForUserQuery(tx,2,common.title,common.author)]);
    await write(2,(tx)=>feedbackForUserQueries(tx,2,common,'done','',currentFeedbackVersion));
    const a=await recommendationsForUserQuery(sql,2,false),b=await recommendationsForUserQuery(sql,3,false);
    assert.equal(a[0].note,'');assert.equal(a[0].status,'done');assert.equal(a[0].reason,'A-reason');
    assert.equal(b[0].note,'B-note');assert.equal(b[0].status,'reading');assert.equal(b[0].reason,'B-reason');checks++;
    assert.equal((await write(2,(tx)=>[deleteShelfForUserQuery(tx,2,b[0].id)]))[0].length,0);
    assert.equal((await recommendationsForUserQuery(sql,3,false))[0].id,b[0].id);checks++;
    const [{id:bookId}]=await sql`SELECT id FROM books WHERE title='shared-book'`;
    await sql`INSERT INTO download_tasks(book_id,title,author,status) VALUES(${bookId},'shared-book','共同作者','done')`;
    assert.equal((await recommendationsForUserQuery(sql,2,false))[0].read_task_id,null);
    assert.equal(typeof(await recommendationsForUserQuery(sql,2,true))[0].read_task_id,'number');checks++;
    assert.deepEqual(await findStatsForUserQuery(sql,2),[{queries:1,recommendations:1}]);
    assert.deepEqual(await shelfStatsForUserQuery(sql,3),[{name:'reading',count:1}]);checks++;
    for(const id of [1,2,3]) {
      verifyExport(id,await sql.transaction(personalExportQueries(sql,id),{isolationLevel:'RepeatableRead',readOnly:true}));checks++;
    }
    const key=randomInt(1,2_000_000_000),queries=personalExportQueries(sql,2);
    const exporting=sql.transaction((tx)=>[
      tx`SELECT pg_advisory_xact_lock(3204,${key})`,queries[0],tx`SELECT pg_sleep(5)`,...queries.slice(1),
    ],{isolationLevel:'RepeatableRead',readOnly:true});
    await waitForMarker(sql,key);
    await write(2,(tx)=>persistRecommendationsForUserQueries(tx,2,'after-snapshot',[common]));
    const result=await exporting,snapshot=[result[1],...result.slice(3)];
    verifyExport(2,snapshot);assert.ok(snapshot[2].every((row)=>row.query!=='after-snapshot'));
    assert.equal((await sql`SELECT count(*)::int AS n FROM recommendations WHERE user_id=2 AND query='after-snapshot'`)[0].n,1);checks++;
    await write(2,(tx)=>[deleteShelfForUserQuery(tx,2,a[0].id)]);
    verifyExport(2,await sql.transaction(personalExportQueries(sql,2),{isolationLevel:'RepeatableRead',readOnly:true}));
    assert.equal((await recommendationsForUserQuery(sql,3,false)).length,1);checks++;
    await sql`UPDATE auth_settings SET members_enabled=false WHERE id=1`;
  });
  checks+=await checkPersonalWrite();
  console.log(`personal-isolation：${checks}/${checks} 检查通过。`);
  return checks;
}
