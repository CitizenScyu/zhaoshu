// T8 验收：storage 绑定（WorkerStorage 的运行时实现）。PGlite 真库语义，不连生产。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchema, loadPGlite, makeSqlTag, type PGliteLike } from './testing/pglite';
import { createWorkerStorage, type DownloadSql } from './storage';
import { artifactIdentityKey } from '../src/lib/artifact-registry';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const publication = (artifactId: number) => ({
  artifactId, version: 'abcd1234', blobSha: 'a'.repeat(40), bytes: 1234,
  chaptersTotal: 3, chaptersDone: 3, charsTotal: 5678, sourceRevision: 'rev', snapshotPath: 'books/.snapshots/x/abcd1234.txt',
});

maybe('T8 storage 绑定：租约条件/心跳/进度/终态/artifact 幂等', () => {
  let pg: PGliteLike;
  let pgToClose: PGliteLike | undefined;
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
    pgToClose = pg; // 在 schema 初始化前登记，初始化失败也会关闭。
    sql = makeSqlTag(pg);
    await createSchema(pg);
  }, 60_000);

  afterEach(async () => {
    const current = pgToClose;
    pgToClose = undefined;
    if (current) {
      await current.close();
      expect(current).toHaveProperty('closed', true);
    }
  });

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

  it('defer：租约条件放回 pending，attempt_count+1、next_attempt_at=now+delay，未到期不可领；失权返回 null', async () => {
    const id = await insertTask();
    const storage = createWorkerStorage(sql);
    const lease = (await storage.claim('owner-a'))!;
    const retryAt = await storage.defer(lease, { delayMs: 15 * 60_000, error: 'source_unavailable' });
    expect(retryAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const row = (await pg.query(
      `SELECT status, lease_owner, attempt_count, error,
              (extract(epoch FROM (next_attempt_at - updated_at)) * 1000)::float8 AS delay_ms
       FROM download_tasks WHERE id = $1`, [id],
    )).rows[0];
    expect(row).toMatchObject({ status: 'pending', lease_owner: '', attempt_count: 2, error: 'source_unavailable', delay_ms: 15 * 60_000 });
    expect(await storage.claim('owner-b')).toBeNull(); // 退避未到期
    expect(await storage.defer(lease, { delayMs: 1000 })).toBeNull(); // 行已不是本租约的 running
    await pg.query(`UPDATE download_tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await storage.claim('owner-b')).toMatchObject({ id, attemptCount: 2 }); // 到期自动重领
    await expect(storage.defer(lease, { delayMs: -1 })).rejects.toThrow('delayMs is invalid');
  });

  it('taskRow：读取完整行，缺失返回 null', async () => {
    const id = await insertTask();
    const storage = createWorkerStorage(sql);
    expect(await storage.taskRow(id)).toMatchObject({ id, title: '测试书', source_kind: 'engine', status: 'pending' });
    expect(await storage.taskRow(999999)).toBeNull();
  });

  const registration = async () => {
    const id = await insertTask();
    const storage = createWorkerStorage(sql);
    const lease = (await storage.claim('owner-a'))!;
    const identityKey = artifactIdentityKey('测试书', '佚名');
    const input = { labeledBookId: 1, identityKey, repositoryId: 1, branch: 'main', canonicalPath: 'books/%E6%B5%8B%E8%AF%95%E4%B9%A6-%E4%BD%9A%E5%90%8D.txt' };
    const first = await storage.reserveArtifactPath(input);
    const second = await storage.reserveArtifactPath(input);
    expect(second).toBe(first); // identity_key 唯一 → 同 id
    return { id, storage, lease, artifactId: first, input: publication(first) };
  };
  const snapshot = async () => ({
    tasks: (await pg.query('SELECT * FROM download_tasks ORDER BY id')).rows,
    artifacts: (await pg.query('SELECT * FROM book_artifacts ORDER BY id')).rows,
  });

  it('合法首次登记registered，同artifact同出版事实重试already且两表不变', async () => {
    const { id, storage, lease, artifactId, input } = await registration();
    expect(await storage.registerArtifact(lease, input)).toBe('registered');
    const artifact = (await pg.query('SELECT quality_status, blob_sha, chapters_done FROM book_artifacts WHERE id = $1', [artifactId])).rows[0];
    expect(artifact).toMatchObject({ quality_status: 'published', blob_sha: 'a'.repeat(40), chapters_done: 3 });
    expect((await state(id)).artifact_id).toBe(artifactId);
    const before = await snapshot();
    expect(await storage.registerArtifact(lease, input)).toBe('already');
    expect(await snapshot()).toEqual(before);
  });

  it.each([{ version: '00000001' }, { blobSha: 'b'.repeat(40) }, { bytes: 2345 },
    { chaptersTotal: 4 }, { chaptersDone: 2 }, { charsTotal: 6000 },
    { sourceRevision: 'new-rev' }, { snapshotPath: 'books/.snapshots/x/new.txt' }])
    ('同artifact出版字段改变必须重新registered，不按版本大小猜顺序（%#）', async (change) => {
      const { storage, lease, input } = await registration();
      expect(await storage.registerArtifact(lease, input)).toBe('registered');
      const next = { ...input, ...change };
      expect(await storage.registerArtifact(lease, next)).toBe('registered');
      expect(await storage.registerArtifact(lease, next)).toBe('already');
    });

  it.each(['generation', 'owner', 'not-running', 'missing-task', 'wrong-book', 'missing-artifact', 'other-artifact'])
    ('失权或错配%s：登记前后两表完全相同', async (kind) => {
      const { id, storage, lease, input } = await registration();
      let requestLease = lease;
      let request = input;
      if (kind === 'generation') await pg.query('UPDATE download_tasks SET lease_generation = lease_generation + 1 WHERE id = $1', [id]);
      if (kind === 'owner') await pg.query("UPDATE download_tasks SET lease_owner = 'owner-b' WHERE id = $1", [id]);
      if (kind === 'not-running') await pg.query("UPDATE download_tasks SET status = 'pending' WHERE id = $1", [id]);
      if (kind === 'missing-task') requestLease = { ...lease, id: 999999 };
      if (kind === 'wrong-book') {
        const other = (await pg.query("INSERT INTO labeled_books(title, author, source_url) VALUES ('合成另一书', '合成作者', '') RETURNING id")).rows[0] as { id: number };
        await pg.query('UPDATE download_tasks SET book_id = $1 WHERE id = $2', [other.id, id]);
      }
      if (kind === 'missing-artifact') request = { ...input, artifactId: 999999 };
      if (kind === 'other-artifact') {
        const other = await storage.reserveArtifactPath({ labeledBookId: 1, identityKey: 'synthetic-other',
          repositoryId: 1, branch: 'main', canonicalPath: 'books/other.txt' });
        await pg.query('UPDATE download_tasks SET artifact_id = $1 WHERE id = $2', [other, id]);
      }
      const before = await snapshot();
      expect(await storage.registerArtifact(requestLease, request)).toBe(
        ['generation', 'owner', 'not-running', 'missing-task'].includes(kind) ? 'lost' : 'mismatch');
      expect(await snapshot()).toEqual(before);
    });

  it('出版字段约束异常时整条SQL回滚，不遗留单侧task挂接', async () => {
    const { storage, lease, input } = await registration();
    const before = await snapshot();
    await expect(storage.registerArtifact(lease, { ...input, bytes: -1 })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});

describe('登记返回证据的假SQL映射（不证明数据库原子性）', () => {
  const lease = { id: 1, leaseGeneration: 2, leaseOwner: 'synthetic-owner', attemptCount: 1 };
  const registered = { status: 'registered', atomic_ok: 1, lease_ok: 1, guard_ok: 1, already_ok: 0, attach_ok: 1, pub_ok: 1 };
  it.each([
    registered,
    { ...registered, status: 'already', already_ok: 1, attach_ok: 0, pub_ok: 0 },
    { ...registered, status: 'lost', lease_ok: 0, guard_ok: 0, attach_ok: 0, pub_ok: 0 },
    { ...registered, status: 'mismatch', guard_ok: 0, attach_ok: 0, pub_ok: 0 },
  ])('完整证据映射$status且只提交一条SQL', async (row) => {
    const fake = vi.fn().mockResolvedValue([row]);
    expect(await createWorkerStorage(fake as unknown as DownloadSql).registerArtifact(lease, publication(1))).toBe(row.status);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0].slice(1, 4)).toEqual([lease.id, lease.leaseGeneration, lease.leaseOwner]);
  });
  it.each([{ rows: [] }, { rows: [{}] }, { rows: [registered, registered] },
    { rows: [{ ...registered, pub_ok: 0 }] }, { rows: [{ ...registered, attach_ok: 0 }] },
    { rows: [{ ...registered, atomic_ok: 0 }] }, { rows: [{ status: 'already', was_attached: true }] }])
    ('无完整成功证据拒绝（%#）', async ({ rows }) => {
      const fake = vi.fn().mockResolvedValue(rows);
      await expect(createWorkerStorage(fake as unknown as DownloadSql).registerArtifact(lease, publication(1)))
        .rejects.toThrow('ARTIFACT_REGISTRATION_INVALID_RESULT');
  });
});
