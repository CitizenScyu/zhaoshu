// T8 验收：storage 绑定（WorkerStorage 的运行时实现）。PGlite 真库语义，不连生产。
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema, loadPGlite, makeSqlTag, type PGliteLike } from './testing/pglite';
import { createWorkerStorage, type DownloadSql } from './storage';
import { artifactIdentityKey } from '../src/lib/artifact-registry';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('T8 storage 绑定：租约条件/心跳/进度/终态/artifact 幂等', () => {
  let pg: PGliteLike;
  let sql: DownloadSql;

  const insertTask = async (status = 'pending', bookId = 1): Promise<number> => {
    const rows = await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind)
       VALUES (NULL, $1, '测试书', '佚名', $2, 'https://book15.net/books/1.html', 'system', 'engine') RETURNING id`,
      [bookId, status],
    );
    return Number((rows.rows[0] as { id: number }).id);
  };
  const state = async (id: number) =>
    (await pg.query('SELECT status, lease_owner, lease_generation, artifact_id FROM download_tasks WHERE id = $1', [id])).rows[0] as {
      status: string; lease_owner: string; lease_generation: number; artifact_id: number | null;
    };

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = makeSqlTag(pg);
    await createSchema(pg);
  }, 60_000);

  it('claim：领取 pending → running + generation+1；无 pending 时返回 null', async () => {
    const storage = createWorkerStorage(sql);
    expect(await storage.claim('owner-a')).toBeNull(); // 空队列
    const id = await insertTask();
    const lease = await storage.claim('owner-a');
    expect(lease).toMatchObject({ id, leaseOwner: 'owner-a', leaseGeneration: 1 });
    expect((await state(id)).status).toBe('running');
    expect(await storage.claim('owner-b')).toBeNull(); // 已无 pending
  });

  it('心跳/进度失权返回 false（generation 或 owner 不匹配）', async () => {
    const id = await insertTask();
    const storage = createWorkerStorage(sql);
    const lease = (await storage.claim('owner-a'))!;
    expect(await storage.heartbeat(lease)).toBe(true);
    expect(await storage.progress(lease, { chaptersDone: 1, chaptersTotal: 3, charsTotal: 10 })).toBe(true);
    // 租约被他人接管（generation+1、换 owner）
    await pg.query(`UPDATE download_tasks SET lease_generation = lease_generation + 1, lease_owner = 'owner-b' WHERE id = $1`, [id]);
    expect(await storage.heartbeat(lease)).toBe(false);
    expect(await storage.progress(lease, { chaptersDone: 2, chaptersTotal: 3, charsTotal: 20 })).toBe(false);
    // 他人租约可正常心跳
    const stolen = { id, leaseGeneration: lease.leaseGeneration + 1, leaseOwner: 'owner-b', attemptCount: lease.attemptCount };
    expect(await storage.heartbeat(stolen)).toBe(true);
  });

  it('终态：租约条件写 done 并清 owner；过期租约写 false', async () => {
    const id = await insertTask();
    const storage = createWorkerStorage(sql);
    const lease = (await storage.claim('owner-a'))!;
    expect(await storage.finish(lease, { status: 'done', error: '' })).toBe(true);
    expect(await state(id)).toMatchObject({ status: 'done', lease_owner: '' });
    expect(await storage.finish(lease, { status: 'done', error: '' })).toBe(false); // 已终态
  });

  it('releaseClaim：租约条件回退 pending（预算耗尽不 stranding）', async () => {
    const id = await insertTask();
    const storage = createWorkerStorage(sql);
    const lease = (await storage.claim('owner-a'))!;
    expect(await storage.releaseClaim(lease)).toBe(true);
    expect((await state(id)).status).toBe('pending');
    // 失权后 releaseClaim 零行（不改他人行）
    const stale = { ...lease, leaseOwner: 'other' };
    expect(await storage.releaseClaim(stale)).toBe(false);
    expect((await state(id)).status).toBe('pending');
  });

  it('taskRow：读取完整行，缺失返回 null', async () => {
    const id = await insertTask();
    const storage = createWorkerStorage(sql);
    expect(await storage.taskRow(id)).toMatchObject({ id, title: '测试书', source_kind: 'engine', status: 'pending' });
    expect(await storage.taskRow(999999)).toBeNull();
  });

  it('artifact 登记：reserve 幂等同身份、register 发布并回指任务', async () => {
    const id = await insertTask('running');
    const storage = createWorkerStorage(sql);
    const identityKey = artifactIdentityKey('测试书', '佚名');
    const input = { labeledBookId: 1, identityKey, repositoryId: 1, branch: 'main', canonicalPath: 'books/%E6%B5%8B%E8%AF%95%E4%B9%A6-%E4%BD%9A%E5%90%8D.txt' };
    const first = await storage.reserveArtifactPath(input);
    const second = await storage.reserveArtifactPath(input);
    expect(second).toBe(first); // identity_key 唯一 → 同 id

    expect(await storage.registerArtifact({
      artifactId: first, version: 'abcd1234', blobSha: 'a'.repeat(40), bytes: 1234,
      chaptersTotal: 3, chaptersDone: 3, charsTotal: 5678, sourceRevision: 'rev', snapshotPath: 'books/.snapshots/x/abcd1234.txt',
    })).toBe(true);
    const artifact = (await pg.query('SELECT quality_status, blob_sha, chapters_done FROM book_artifacts WHERE id = $1', [first])).rows[0];
    expect(artifact).toMatchObject({ quality_status: 'published', blob_sha: 'a'.repeat(40), chapters_done: 3 });
    expect((await state(id)).artifact_id).toBe(first);
    // 任务已回指：再登记同一 artifact 不再匹配 running 行 → false（幂等收口）
    expect(await storage.registerArtifact({
      artifactId: first, version: 'abcd1234', blobSha: 'a'.repeat(40), bytes: 1234,
      chaptersTotal: 3, chaptersDone: 3, charsTotal: 5678, sourceRevision: 'rev', snapshotPath: 'x',
    })).toBe(false);
  });
});
