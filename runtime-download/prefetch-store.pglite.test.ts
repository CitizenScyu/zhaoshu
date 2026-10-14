import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrefetchStore } from './prefetch-store';
import { loadPGlite, type PGliteLike } from './testing/pglite';
import { createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import type { PrefetchSql } from './prefetch-store';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

type Row = Record<string, unknown>;

maybe('prefetch store：数据库租约与候选计划原子性', () => {
  let pg: PGliteLike;
  let sql: PrefetchSql;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = createPGliteSql(pg) as unknown as PrefetchSql;
    await pg.exec(`
      CREATE TABLE labeled_books (
        id integer PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT ''
      );
      CREATE TABLE download_tasks (
        id integer PRIMARY KEY, book_id integer REFERENCES labeled_books(id),
        title text NOT NULL, author text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending',
        source_url text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
        next_attempt_at timestamptz, lease_owner text NOT NULL DEFAULT '',
        requested_by text NOT NULL DEFAULT 'system'
      );
      CREATE TABLE download_source_candidates (
        book_id integer NOT NULL REFERENCES labeled_books(id), source_url text NOT NULL,
        host text NOT NULL, position integer NOT NULL DEFAULT 0,
        failure text NOT NULL DEFAULT '', failure_reason text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (book_id, source_url), CHECK (source_url <> 'https://fail.test/')
      );
      CREATE TABLE download_host_occupancy (
        host text PRIMARY KEY, holder text NOT NULL, kind text NOT NULL,
        task_id integer, claimed_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE download_source_prefetch (
        book_id integer PRIMARY KEY REFERENCES labeled_books(id), owner text NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO labeled_books (id, title, author) VALUES
        (1, '一号书', '甲'), (2, '二号书', '乙'), (3, '三号书', '丙'), (4, '四号书', '丁');
      INSERT INTO download_tasks (id, book_id, title, author, created_at) VALUES
        (11, 1, '一号书', '甲', now() - interval '4 seconds'),
        (12, 2, '二号书', '乙', now() - interval '3 seconds'),
        (13, 3, '三号书', '丙', now() - interval '2 seconds'),
        (14, 4, '四号书', '丁', now() - interval '1 second');
    `);
  });

  afterEach(async () => { await pg.close(); });

  it('两个 store 对同一本书互斥，且 claim 不写 download_tasks', async () => {
    const first = createPrefetchStore(sql, { leaseMs: 301_000 });
    const second = createPrefetchStore(sql, { leaseMs: 301_000 });
    const before = await pg.query('SELECT status, lease_owner, next_attempt_at FROM download_tasks WHERE book_id = 1');
    const one = await first.claimNext(new AbortController().signal);
    const two = await second.claimNext(new AbortController().signal);
    expect(one).toMatchObject({ id: 11, bookId: 1, title: '一号书', author: '甲' });
    expect(two).toMatchObject({ id: 12, bookId: 2 });
    expect(await pg.query('SELECT status, lease_owner, next_attempt_at FROM download_tasks WHERE book_id = 1')).toEqual(before);
  });

  it('仅一本 pending 时不同 store 不能同时领取', async () => {
    await pg.query("UPDATE download_tasks SET status = 'done' WHERE book_id <> 1");
    const first = createPrefetchStore(sql, { leaseMs: 301_000 });
    const second = createPrefetchStore(sql, { leaseMs: 301_000 });
    const [one, two] = await Promise.all([
      first.claimNext(new AbortController().signal), second.claimNext(new AbortController().signal),
    ]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
  });

  it('user/system 均可领，NULL book 与同 book 存活 running 不领', async () => {
    await pg.query("UPDATE download_tasks SET requested_by = 'user' WHERE id = 11");
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 1 });
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 2 });
    await pg.query(`INSERT INTO download_tasks (id, book_id, title, status, lease_owner, created_at)
      VALUES (20, 3, '存活下载', 'running', 'worker', now() - interval '10 seconds'),
             (21, NULL, '无 book', 'pending', '', now() - interval '20 seconds')`);
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 4 });
    expect(await store.claimNext(new AbortController().signal)).toBeNull();
  });

  it('全 permanent 候选仍可补扫，两个不同 host 的有效候选才阻止 claim', async () => {
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host, failure) VALUES (1, 'https://gone.test/book', 'gone.test', 'permanent')`);
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 1 });
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host) VALUES
      (2, 'https://ready.test/book', 'ready.test'), (2, 'https://ready2.test/book', 'ready2.test')`);
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 3 });
  });

  it('单 host 可领取补齐，finish 追加备用 host 且原候选字段完全不变', async () => {
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host, position)
      VALUES (1, 'https://known.test/book', 'known.test', 7)`);
    const before = (await pg.query("SELECT * FROM download_source_candidates WHERE source_url = 'https://known.test/book'")).rows;
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    expect(task).toMatchObject({ bookId: 1, sourceUrls: ['https://known.test/book'] });
    expect(await store.finish(task!, { sourceUrls: ['https://new.test/book'] })).toBe(true);
    expect((await pg.query("SELECT * FROM download_source_candidates WHERE source_url = 'https://known.test/book'")).rows).toEqual(before);
    expect((await pg.query('SELECT source_url FROM download_source_candidates WHERE book_id = 1 ORDER BY position')).rows)
      .toEqual([{ source_url: 'https://known.test/book' }, { source_url: 'https://new.test/book' }]);
    expect((await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows).toEqual([]);
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 2 });
  });

  it('非 HTTPS 旧候选不占有效 host：一次补齐两 HTTPS host 才删认领', async () => {
    // accept933 确认点：claim 只数 HTTPS host，finish 收尾也必须同口径。
    // 旧实现按未过滤 count(DISTINCT host) 数到 legacy+B 为 2，会提前删认领；
    // 之后 claim 又只数到 1 个有效 host，而调度器把 legacy 算作已知 host，缺额 0，C 永远补不上。
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host, position)
      VALUES (1, 'http://legacy.example/book', 'legacy.example', 0)`);
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const first = await store.claimNext(new AbortController().signal);
    expect(first).toMatchObject({ bookId: 1, sourceUrls: ['http://legacy.example/book'] });
    expect(await store.finish(first!, { sourceUrls: ['https://b.example/book'] })).toBe(true);
    // 只有一个有效 HTTPS host：保留 60 秒退避而不是删认领。
    expect((await pg.query('SELECT owner, expires_at > now() AS active FROM download_source_prefetch WHERE book_id = 1')).rows)
      .toEqual([{ owner: '', active: true }]);
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 2 });
    await pg.query("UPDATE download_source_prefetch SET expires_at = now() - interval '1 second' WHERE book_id = 1");
    const second = await store.claimNext(new AbortController().signal);
    expect(second).toMatchObject({ bookId: 1, sourceUrls: ['http://legacy.example/book', 'https://b.example/book'] });
    expect(await store.finish(second!, { sourceUrls: ['https://c.example/book'] })).toBe(true);
    expect((await pg.query('SELECT source_url FROM download_source_candidates WHERE book_id = 1 ORDER BY position')).rows)
      .toEqual([
        { source_url: 'http://legacy.example/book' },
        { source_url: 'https://b.example/book' },
        { source_url: 'https://c.example/book' },
      ]);
    expect((await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows).toEqual([]);
    // book2 在 line 128 已被真实领取（租约未到期），故下一个可领的是 book3；book1 已达两个有效 host，不再被领。
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 3 });
  });

  it('补齐期间下载侧新增候选后，不覆盖其结果也不写入旧预取计划', async () => {
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host)
      VALUES (1, 'https://known.test/book', 'known.test')`);
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host)
      VALUES (1, 'https://download.test/book', 'download.test')`);
    const before = (await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1 ORDER BY source_url')).rows;
    expect(await store.finish(task!, { sourceUrls: ['https://prefetch.test/book'] })).toBe(false);
    expect((await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1 ORDER BY source_url')).rows).toEqual(before);
    expect((await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows).toEqual([]);
  });

  it('首次只找到一个 host 后预取短退避，期满可再领取补齐，不改下载任务', async () => {
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    const before = (await pg.query('SELECT * FROM download_tasks WHERE book_id = 1')).rows;
    expect(await store.finish(task!, { sourceUrls: ['https://one.test/book'] })).toBe(true);
    expect((await pg.query('SELECT owner, expires_at > now() AS active FROM download_source_prefetch WHERE book_id = 1')).rows)
      .toEqual([{ owner: '', active: true }]);
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 2 });
    await pg.query("UPDATE download_source_prefetch SET expires_at = now() - interval '1 second' WHERE book_id = 1");
    expect(await store.claimNext(new AbortController().signal)).toMatchObject({ bookId: 1, sourceUrls: ['https://one.test/book'] });
    expect((await pg.query('SELECT * FROM download_tasks WHERE book_id = 1')).rows).toEqual(before);
  });

  it('失权 finish 零候选写入，并且旧 token 不能覆盖新 claim', async () => {
    const first = createPrefetchStore(sql, { leaseMs: 301_000 });
    const second = createPrefetchStore(sql, { leaseMs: 301_000 });
    const oldTask = await first.claimNext(new AbortController().signal);
    expect(oldTask).not.toBeNull();
    await pg.query(`UPDATE download_source_prefetch SET expires_at = now() - interval '1 second' WHERE book_id = 1`);
    const newTask = await second.claimNext(new AbortController().signal);
    expect(newTask).toMatchObject({ bookId: 1 });
    expect(await first.finish(oldTask!, { sourceUrls: ['https://old.test/book'] })).toBe(false);
    expect(await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1')).toMatchObject({ rows: [] });
    expect(await second.finish(newTask!, { sourceUrls: ['https://new.test/book'] })).toBe(true);
    expect((await pg.query('SELECT source_url FROM download_source_candidates WHERE book_id = 1')).rows)
      .toEqual([{ source_url: 'https://new.test/book' }]);
  });

  it('下载侧在预取期间保存候选后，finish 不覆盖候选且释放自身预取资格', async () => {
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    expect(task).toMatchObject({ bookId: 1 });
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host)
      VALUES (1, 'https://download.test/book', 'download.test')`);
    const before = (await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1')).rows;
    expect(await store.finish(task!, { sourceUrls: ['https://prefetch.test/book'] })).toBe(false);
    expect((await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1')).rows).toEqual(before);
    expect((await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows).toEqual([]);
    expect(await store.release(task!, { reason: 'prefetch_lease_lost' })).toBe(false);
  });

  it('finish 插入失败整体回滚，旧失败候选均保留', async () => {
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host, failure) VALUES (1, 'https://old.test/book', 'old.test', 'temporary')`);
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    expect(task).toMatchObject({ bookId: 1 });
    const before = (await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1 ORDER BY source_url')).rows;
    const lease = (await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows;
    await expect(store.finish(task!, { sourceUrls: ['https://fail.test/'] })).rejects.toThrow();
    expect((await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1 ORDER BY source_url')).rows).toEqual(before);
    expect((await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows).toEqual(lease);
    expect(await store.release(task!, { reason: 'scheduler_exit' })).toBe(true);
  });

  it('release 退避只改预取租约，不改 download_tasks', async () => {
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    const before = (await pg.query('SELECT status, lease_owner, next_attempt_at FROM download_tasks WHERE id = 11')).rows;
    expect(await store.release(task!, { reason: 'scan_failed', retryDelayMs: 60_000 })).toBe(true);
    expect((await pg.query('SELECT status, lease_owner, next_attempt_at FROM download_tasks WHERE id = 11')).rows).toEqual(before);
    const lease = (await pg.query('SELECT owner, expires_at > now() AS active FROM download_source_prefetch WHERE book_id = 1')).rows[0] as Row;
    expect(lease).toMatchObject({ owner: '' , active: true });
  });

  it('busyHosts 合并未过期 occupancy 与 running 任务声明 host', async () => {
    await pg.query("UPDATE download_tasks SET status = 'running', source_url = 'https://DECLARED.test:443/book', lease_owner = 'worker' WHERE id = 12");
    await pg.query(`INSERT INTO download_host_occupancy(host, holder, kind, expires_at)
      VALUES ('occupied.test', 'prefetch-x', 'prefetch', now() + interval '1 minute')`);
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    expect(await store.busyHosts(new AbortController().signal)).toEqual(expect.arrayContaining(['occupied.test', 'declared.test']));
  });

  it('release 数据库失败保留 token，重试仍能归还', async () => {
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    const query = vi.spyOn(pg, 'query');
    query.mockRejectedValueOnce(new Error('synthetic_database_failure'));
    await expect(store.release(task!, { reason: 'scheduler_exit' })).rejects.toThrow('synthetic_database_failure');
    expect(await store.release(task!, { reason: 'scheduler_exit' })).toBe(true);
    query.mockRestore();
  });

  it('release 旧 token 零写不影响接管的新租约', async () => {
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const other = createPrefetchStore(sql, { leaseMs: 301_000 });
    const oldTask = await store.claimNext(new AbortController().signal);
    await pg.query("UPDATE download_source_prefetch SET expires_at = now() - interval '1 second' WHERE book_id = 1");
    const newTask = await other.claimNext(new AbortController().signal);
    const lease = (await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows;
    expect(await store.release(oldTask!, { reason: 'old', retryDelayMs: 60_000 })).toBe(false);
    expect(await store.release(oldTask!, { reason: 'old_again' })).toBe(false);
    expect((await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows).toEqual(lease);
    expect(await other.release(newTask!, { reason: 'current' })).toBe(true);
  });

  it('release 零写且失权查询失败时保留 token，可再次归还', async () => {
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    const query = vi.spyOn(pg, 'query');
    query.mockResolvedValueOnce({ rows: [] });
    query.mockRejectedValueOnce(new Error('synthetic_unknown_lease'));
    await expect(store.release(task!, { reason: 'scheduler_exit' })).rejects.toThrow('synthetic_unknown_lease');
    expect(await store.release(task!, { reason: 'scheduler_exit' })).toBe(true);
    query.mockRestore();
  });

  it('空 plan 保留 token 可 release，全失败源 plan 回滚且不清除记忆', async () => {
    await pg.query(`INSERT INTO download_source_candidates(book_id, source_url, host, failure)
      VALUES (1, 'https://permanent.test/book', 'permanent.test', 'permanent'),
             (1, 'https://temporary.test/book', 'temporary.test', 'temporary')`);
    const store = createPrefetchStore(sql, { leaseMs: 301_000 });
    const task = await store.claimNext(new AbortController().signal);
    const before = (await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1 ORDER BY source_url')).rows;
    const lease = (await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows;
    expect(await store.finish(task!, { sourceUrls: [] })).toBe(false);
    await expect(store.finish(task!, { sourceUrls: ['https://permanent.test/book', 'https://temporary.test/book'] })).rejects.toThrow();
    expect((await pg.query('SELECT * FROM download_source_candidates WHERE book_id = 1 ORDER BY source_url')).rows).toEqual(before);
    expect((await pg.query('SELECT * FROM download_source_prefetch WHERE book_id = 1')).rows).toEqual(lease);
    expect(await store.release(task!, { reason: 'empty' })).toBe(true);
  });

  it('已 abort 的 busyHosts/claimNext 不进入数据库', async () => {
    const controller = new AbortController();
    controller.abort(new Error('synthetic_abort'));
    const failSql = (() => { throw new Error('unexpected_sql'); }) as unknown as PrefetchSql;
    const store = createPrefetchStore(failSql, { leaseMs: 301_000 });
    await expect(store.busyHosts(controller.signal)).rejects.toThrow('synthetic_abort');
    await expect(store.claimNext(controller.signal)).rejects.toThrow('synthetic_abort');
  });

  it('budgetMs 为零时不触碰预算或任务字段', async () => {
    const store = createPrefetchStore(sql, { leaseMs: 301_000, budgetMs: 0 });
    const task = await store.claimNext(new AbortController().signal);
    expect(task).toMatchObject({ bookId: 1 });
    expect((await pg.query('SELECT status, lease_owner FROM download_tasks WHERE id = 11')).rows)
      .toEqual([{ status: 'pending', lease_owner: '' }]);
  });
});
