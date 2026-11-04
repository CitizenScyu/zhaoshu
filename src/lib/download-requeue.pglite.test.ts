import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createArtifactSchema, createProductionSchema, seedProductionMembers } from '@/lib/fixtures/production-schema';
import { demotePreviewTasks, requeueUnfinishedBooks } from './download-requeue';

// requeue1104：真库验证「只挑终态未完成、无 done、无活动系统任务」的书，付费墙源默认排除，
// dryRun 零写入，同一 revision 重放幂等。全部合成数据。
let pg: PGliteLike;
let sql: ReturnType<typeof createPGliteSql>;

beforeAll(async () => {
  const PGlite = await loadPGlite();
  if (!PGlite) throw new Error('PGlite required');
  pg = new PGlite();
  sql = createPGliteSql(pg);
  await createProductionSchema(sql as never, statement => pg.exec(statement));
  await seedProductionMembers(pg, 2);
  await pg.exec(`
    INSERT INTO labeled_books(id,title,author,source_url) VALUES
      (1,'付费墙书','甲','https://book.qq.com/book-detail/1'),
      (2,'坏章书','乙','https://www.zzxsa.example/book/2?t=x'),
      (3,'别人读过','丙','https://a.example/3'),
      (4,'在排队','丁','https://a.example/4'),
      (5,'后来成了','戊','https://a.example/5'),
      (6,'缺章书','己','https://b.example/6'),
      (7,'没任务','庚','https://a.example/7');
    INSERT INTO download_tasks(id,user_id,book_id,title,author,status,requested_by,enqueue_key,error) VALUES
      (11,NULL,1,'付费墙书','甲','partial','system','1:p:','源不可用（search 阶段，已连续 16 次，停止自动重试）：no_candidates'),
      (12,NULL,2,'坏章书','乙','failed','system','2:p:','invalid_chapter: 第 3 章为空'),
      (13,NULL,3,'别人读过','丙','partial','system','3:p:','missing_chapters'),
      (14,2,3,'别人读过','丙','done','user',NULL,''),
      (15,NULL,4,'在排队','丁','failed','system','4:p:','download_failed'),
      (16,NULL,4,'在排队','丁','pending','system','4:p:r2',''),
      (17,NULL,5,'后来成了','戊','failed','system','5:p:','download_failed'),
      (18,NULL,5,'后来成了','戊','done','system','5:p:r2',''),
      (19,NULL,6,'缺章书','己','partial','system','6:p:','missing_chapters: 缺 2 章');
    SELECT setval('download_tasks_id_seq', 100);`);
}, 60_000);
afterAll(() => pg?.close());

const count = async () => ((await pg.query('SELECT count(*)::int AS n FROM download_tasks')).rows[0] as { n: number }).n;

it('dryRun 只统计不写：付费墙源默认排除，统计里单列', async () => {
  const before = await count();
  const result = await requeueUnfinishedBooks(sql, { sourceRevision: 'requeue-test', limit: 10, dryRun: true, policyVersion: 'p' });
  expect(result).toMatchObject({ dryRun: true, eligible: 3, paywall: 1, selected: 2, inserted: 0 });
  expect(result.byHost).toEqual(expect.arrayContaining([{ host: 'book.qq.com', n: 1 }, { host: 'www.zzxsa.example', n: 1 }]));
  expect(result.byReason).toEqual(expect.arrayContaining([
    { reason: 'no_candidates', n: 1 }, { reason: 'invalid_chapter', n: 1 }, { reason: 'missing_chapters', n: 1 },
  ]));
  expect(JSON.stringify(result)).not.toContain('t=x');
  expect(await count()).toBe(before);
});

it('原因过滤与 includePaywall 只影响选中集合', async () => {
  const only = await requeueUnfinishedBooks(sql, { sourceRevision: 'requeue-test', limit: 10, dryRun: true, policyVersion: 'p', reasons: ['missing_chapters'] });
  expect(only.selected).toBe(1);
  const all = await requeueUnfinishedBooks(sql, { sourceRevision: 'requeue-test', limit: 10, dryRun: true, policyVersion: 'p', includePaywall: true });
  expect(all.selected).toBe(3);
  const capped = await requeueUnfinishedBooks(sql, { sourceRevision: 'requeue-test', limit: 1, dryRun: true, policyVersion: 'p' });
  expect(capped.selected).toBe(1);
});

it('apply 插全新 pending 系统任务（attempt_count=1、新事件键），同 revision 重放不再插', async () => {
  const applied = await requeueUnfinishedBooks(sql, { sourceRevision: 'requeue-test', limit: 10, dryRun: false, policyVersion: 'p' });
  expect(applied).toMatchObject({ inserted: 2, selected: 2 });
  const rows = (await pg.query(`SELECT book_id, status, requested_by, user_id, attempt_count, enqueue_key, source_revision
    FROM download_tasks WHERE id > 100 ORDER BY book_id`)).rows;
  expect(rows).toEqual([
    { book_id: 2, status: 'pending', requested_by: 'system', user_id: null, attempt_count: 1, enqueue_key: '2:p:requeue-test', source_revision: 'requeue-test' },
    { book_id: 6, status: 'pending', requested_by: 'system', user_id: null, attempt_count: 1, enqueue_key: '6:p:requeue-test', source_revision: 'requeue-test' },
  ]);
  // 新任务还在排队 → 不再符合条件；即使它们之后又落 partial，同 revision 也不会重选。
  await pg.exec(`UPDATE download_tasks SET status = 'partial' WHERE id > 100`);
  const replay = await requeueUnfinishedBooks(sql, { sourceRevision: 'requeue-test', limit: 10, dryRun: false, policyVersion: 'p' });
  expect(replay).toMatchObject({ eligible: 1, selected: 0, inserted: 0 });
});

it('拒绝非法 revision 与越界 limit', async () => {
  await expect(requeueUnfinishedBooks(sql, { sourceRevision: 'Bad Rev', limit: 1, dryRun: true })).rejects.toThrow('sourceRevision');
  await expect(requeueUnfinishedBooks(sql, { sourceRevision: 'requeue-x', limit: 501, dryRun: true })).rejects.toThrow('limit');
});

// demote1104：试读本下架只动给定的系统 done 任务（书库/阅读随之不列），可按原样恢复；之后可按 preview_truncated 重排。
it('demote：dryRun 不写；只下架系统 done；restore 只恢复挂 artifact 的下架行；下架后可按原因重排', async () => {
  await createArtifactSchema(sql as never);
  await pg.exec(`
    INSERT INTO labeled_books(id,title,author,source_url) VALUES
      (20,'试读本','辛','https://book.qq.com/book-detail/20'),
      (21,'用户本','壬','https://a.example/21'),
      (22,'引擎判的','癸','https://a.example/22');
    INSERT INTO storage_repositories(id,owner,repo,branch,enabled) VALUES (1,'fixture','private-a','main',true);
    INSERT INTO book_artifacts(id,labeled_book_id,identity_key,repository_id,branch,canonical_path,version,blob_sha,bytes,quality_status,published_at)
      VALUES (1,20,'id-20',1,'main','books/20.txt','v1','${'a'.repeat(40)}',10,'published',now());
    INSERT INTO download_tasks(id,user_id,book_id,title,author,status,requested_by,enqueue_key,error,artifact_id) VALUES
      (40,NULL,20,'试读本','辛','done','system','20:p:','',1),
      (41,2,21,'用户本','壬','done','user',NULL,'',NULL),
      (42,NULL,22,'引擎判的','癸','partial','system','22:p:','preview_truncated',NULL);`);
  const status = async (id: number) => (await pg.query('SELECT status,error FROM download_tasks WHERE id=$1', [id])).rows[0];
  expect(await demotePreviewTasks(sql, { taskIds: [40, 41, 42, 999], dryRun: true }))
    .toEqual({ dryRun: true, restore: false, requested: 4, matched: 1, updated: 0 });
  expect(await status(40)).toEqual({ status: 'done', error: '' });
  expect(await demotePreviewTasks(sql, { taskIds: [40, 41, 40], dryRun: false })).toMatchObject({ requested: 2, matched: 1, updated: 1 });
  expect(await status(40)).toEqual({ status: 'partial', error: 'preview_truncated' });
  expect(await status(41)).toEqual({ status: 'done', error: '' });
  const requeue = await requeueUnfinishedBooks(sql, {
    sourceRevision: 'demote-test', limit: 10, dryRun: true, policyVersion: 'p', includePaywall: true, reasons: ['preview_truncated'],
  });
  expect(requeue.selected).toBe(2);
  // 恢复：40 挂 artifact → 回 done；42 是引擎零发布的 preview_truncated、无 artifact → 不动。
  expect(await demotePreviewTasks(sql, { taskIds: [40, 42], dryRun: false, restore: true })).toMatchObject({ matched: 1, updated: 1 });
  expect(await status(40)).toEqual({ status: 'done', error: '' });
  expect(await status(42)).toEqual({ status: 'partial', error: 'preview_truncated' });
  await expect(demotePreviewTasks(sql, { taskIds: [], dryRun: true })).rejects.toThrow('taskIds');
  await expect(demotePreviewTasks(sql, { taskIds: [0], dryRun: true })).rejects.toThrow('taskIds');
});
