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
  personalExportQueries, findStatsForUserQuery, shelfStatsForUserQuery, downloadStatsForUserQuery,
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
    tx`ALTER TABLE books ADD COLUMN title_key text GENERATED ALWAYS AS (lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\\1')))) STORED`,
    tx`ALTER TABLE books ADD COLUMN author_key text GENERATED ALWAYS AS (lower(btrim(normalize(author, NFKC)))) STORED`,
    tx`CREATE UNIQUE INDEX books_identity_idx ON books (title_key, author_key)`,
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
  assert.equal(metadata.version,5);
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
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(1,${bookId},'shared-book','共同作者','done')`;
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

// worker.mjs 先建表的旧结构：没有 user_id。worker 的 CREATE TABLE IF NOT EXISTS 与
// v5 迁移必须在两种建表顺序下收敛到同一形状。
function legacyDownloadTasks(tx) {
  return tx`CREATE TABLE download_tasks (
    id serial PRIMARY KEY, book_id int NOT NULL, title text NOT NULL,
    author text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending',
    source_url text NOT NULL DEFAULT '', chapters_total int NOT NULL DEFAULT 0,
    chapters_done int NOT NULL DEFAULT 0, chars_total int NOT NULL DEFAULT 0,
    error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`;
}

async function downloadTableShape(sql) {
  return sql`SELECT a.attname AS column_name, a.attnotnull AS not_null
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = current_schema() AND c.relname = 'download_tasks' AND a.attnum > 0 ORDER BY a.attname`;
}

export async function downloadIsolationCase() {
  let checks=0;
  // 建表顺序一：worker 先按旧结构建表，且库里已有历史任务；应用侧 v5 迁移必须保留数据。
  await withTestSchema(async(sql)=>{
    await sql.transaction((tx)=>[
      legacyDownloadTasks(tx),
      tx`INSERT INTO download_tasks(book_id,title,author,status) VALUES(7,'旧任务','旧作者','running')`,
    ]);
    await assert.rejects(assertAuthSchema(sql));
    await initializeAuthSchema(sql);
    assert.deepEqual(await sql`SELECT user_id,status,title FROM download_tasks`,
      [{user_id:1,status:'running',title:'旧任务'}]);checks++;
    assert.equal((await downloadTableShape(sql)).find((row)=>row.column_name==='user_id')?.not_null,true);checks++;
    await assert.rejects(sql`INSERT INTO download_tasks(book_id,title,author) VALUES(8,'缺归属','谁')`,(e)=>e.code==='23502');checks++;
    await assert.rejects(sql`INSERT INTO download_tasks(user_id,book_id,title,author) VALUES(999,8,'孤儿','谁')`,(e)=>e.code==='23503');checks++;
  });
  // 建表顺序二：应用侧先建（auth v5 建表，业务 schema 的 CREATE TABLE IF NOT EXISTS 是空操作）。
  await withTestSchema(async(sql)=>{
    await initializeAuthSchema(sql);
    await initializeBusinessSchema(sql);
    const shape=await downloadTableShape(sql);
    assert.equal(shape.find((row)=>row.column_name==='user_id')?.not_null,true);checks++;
    assert.equal((await sql`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=current_schema()
      AND tablename='download_tasks' AND indexname='download_tasks_active_book_idx'`)[0].n,1);checks++;
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(1,7,'共享书','谁','pending')`;
    assert.equal((await sql`SELECT count(*)::int AS n FROM download_tasks`)[0].n,1);checks++;
    await initializeAuthSchema(sql);await initializeBusinessSchema(sql);
    assert.equal((await sql`SELECT count(*)::int AS n FROM download_tasks`)[0].n,1);checks++;
  });
  // 归属与全局去重：跨用户活动任务仍然互斥，终态任务不占锁。
  await withTestSchema(async(sql)=>{
    await legacyDatabase(sql);await initializeAuthSchema(sql);await initializeBusinessSchema(sql);
    await sql.transaction((tx)=>[
      tx`INSERT INTO users(id,username,password_hash,role) VALUES(2,'dl_member_a','fixture-password-hash','member'),(3,'dl_member_b','fixture-password-hash','member')`,
    ]);
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(2,11,'共享书','谁','pending')`;
    await assert.rejects(sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(3,11,'共享书','谁','pending')`,(e)=>e.code==='23505');checks++;
    assert.deepEqual(await sql`SELECT user_id,status FROM download_tasks WHERE book_id=11`,[{user_id:2,status:'pending'}]);checks++;
    // 并发入队同一本书只有一个活动任务；另一个必须拿到唯一键冲突而不是第二行。
    const race=await Promise.allSettled([
      sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(2,12,'竞态','谁','pending')`,
      sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(3,12,'竞态','谁','pending')`,
    ]);
    assert.equal(race.filter((item)=>item.status==='fulfilled').length,1);
    assert.equal(race.filter((item)=>item.status==='rejected'&&item.reason?.code==='23505').length,1);checks++;
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(3,12,'已完成','谁','done')`;
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(2,13,'已完成','谁','done')`;
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(3,13,'终态后重排','谁','pending')`;
    assert.equal((await sql`SELECT count(*)::int AS n FROM download_tasks WHERE book_id=13`)[0].n,2);checks++;
    // 路由谓词（route.test.ts 锁定其原文，这里只验证谓词在真实库中的效果）。
    const own=(userId)=>sql`SELECT id,user_id,status FROM download_tasks WHERE book_id=11 AND user_id=${userId}`;
    assert.equal((await own(3)).length,0);assert.equal((await own(2)).length,1);checks++;
    const cancel=(userId,id)=>sql`DELETE FROM download_tasks WHERE id=${id} AND user_id=${userId}
      AND status IN ('pending', 'failed') RETURNING id`;
    const [{id:sharedTaskId}]=await sql`SELECT id FROM download_tasks WHERE book_id=11`;
    assert.equal((await cancel(3,sharedTaskId)).length,0);checks++;
    assert.deepEqual(await sql`SELECT user_id,status FROM download_tasks WHERE id=${sharedTaskId}`,[{user_id:2,status:'pending'}]);checks++;
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(2,14,'跑着','谁','running')`;
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status) VALUES(2,15,'失败了','谁','failed')`;
    const [{id:runningId}]=await sql`SELECT id FROM download_tasks WHERE book_id=14`;
    const [{id:failedId}]=await sql`SELECT id FROM download_tasks WHERE book_id=15`;
    assert.equal((await cancel(2,runningId)).length,0);
    assert.equal((await sql`SELECT status FROM download_tasks WHERE id=${runningId}`)[0].status,'running');checks++;
    assert.equal((await cancel(2,failedId)).length,1);checks++;
  });
  // 既有冲突活动任务：v5 的唯一索引让迁移中止，且不删除任何既有行。
  await withTestSchema(async(sql)=>{
    await sql.transaction((tx)=>[
      legacyDownloadTasks(tx),
      tx`INSERT INTO download_tasks(book_id,title,author,status) VALUES(20,'冲突A','谁','pending')`,
      tx`INSERT INTO download_tasks(book_id,title,author,status) VALUES(20,'冲突B','谁','running')`,
    ]);
    await assert.rejects(initializeAuthSchema(sql));checks++;
    assert.equal((await sql`SELECT count(*)::int AS n FROM download_tasks WHERE book_id=20`)[0].n,2);checks++;
    await assert.rejects(assertAuthSchema(sql));checks++;
  });
  // stats 的 download 分区：按 user_id 统计，绝不串号；章数/字数只累加已完成任务。
  await withTestSchema(async(sql)=>{
    await legacyDatabase(sql);await initializeAuthSchema(sql);await initializeBusinessSchema(sql);
    await sql.transaction((tx)=>[
      tx`INSERT INTO users(id,username,password_hash,role) VALUES(2,'stats_member_a','fixture-password-hash','member'),(3,'stats_member_b','fixture-password-hash','member')`,
    ]);
    await sql`INSERT INTO download_tasks(user_id,book_id,title,author,status,chapters_done,chars_total) VALUES
      (2,21,'A 已完成','谁','done',10,1000),
      (2,22,'A 失败','谁','failed',7,700),
      (2,23,'A 进行中','谁','running',3,300),
      (3,31,'B 已完成','谁','done',20,2000)`;
    assert.deepEqual(await downloadStatsForUserQuery(sql,2),[{total:3,done:1,chapters:10,chars:1000}]);checks++;
    assert.deepEqual(await downloadStatsForUserQuery(sql,3),[{total:1,done:1,chapters:20,chars:2000}]);checks++;
    // 用户 1 在本 schema 里没有任何下载任务；B 的任务绝不能落进 A 的统计。
    assert.deepEqual(await downloadStatsForUserQuery(sql,1),[{total:0,done:0,chapters:0,chars:0}]);checks++;
  });
  console.log(`download-isolation：${checks}/${checks} 检查通过。`);
  return checks;
}
