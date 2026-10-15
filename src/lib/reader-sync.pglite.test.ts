// readsync42：reader_sync_state（migrations/0006）在真库上的迁移幂等、往返与
// last-write-wins 双向语义。PGlite 真库（不连生产），只测 SQL 层；HTTP 与前端合并逻辑另有测试。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteClient, createPGliteSql } from './fixtures/pglite-sql';
import { initializeBusinessSchema } from './business-schema';
import { readerSyncEntriesForUserQuery, saveReaderSyncEntriesForUserQueries } from './user-data';
import { readerSyncItemKey, type ReaderSyncEntry } from './reader-sync';
import { applyMigration, loadMigrations } from '../../scripts/db-migration-lib.mjs';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

type StoredRow = { item_key: string; payload: unknown; client_updated_at: number | string };

function toEntry(row: StoredRow): ReaderSyncEntry {
  const [kind, key] = [row.item_key.slice(0, row.item_key.indexOf(':')), row.item_key.slice(row.item_key.indexOf(':') + 1)];
  return { kind: kind as ReaderSyncEntry['kind'], key, payload: row.payload as Record<string, unknown>, updatedAt: Number(row.client_updated_at) };
}

maybe('readsync42：阅读进度/设置云端存储（0006 reader_sync_state）', () => {
  let pg: PGliteLike;
  const sql = () => createPGliteSql(pg) as never;

  async function push(userId: number, entries: readonly ReaderSyncEntry[]) {
    await createPGliteSql(pg).transaction((tx) => saveReaderSyncEntriesForUserQueries(
      tx as never, userId,
      entries.map((entry) => ({
        item_key: readerSyncItemKey(entry.kind, entry.key),
        payload: entry.payload,
        client_updated_at: entry.updatedAt,
      })),
    ));
  }

  async function pull(userId: number, itemKeys?: readonly string[]): Promise<ReaderSyncEntry[]> {
    return (await readerSyncEntriesForUserQuery(sql(), userId, itemKeys) as StoredRow[]).map(toEntry);
  }

  const progress = (chapterIndex: number, updatedAt: number): ReaderSyncEntry => ({
    kind: 'progress', key: 'novel-finder-reading-progress-source-u1-src-7',
    payload: { schema: 1, version: 'v1', chapterIndex, partIndex: 0, ratio: 0.5, updatedAt }, updatedAt,
  });
  const settings = (fontSize: number, updatedAt: number): ReaderSyncEntry => ({
    kind: 'settings', key: 'default', payload: { fontSize, lineHeight: 1.9, theme: 'day' }, updatedAt,
  });

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await pg.exec(`CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users (id) VALUES (1), (2);`);
    await initializeBusinessSchema(sql());
  });
  afterEach(async () => { await pg.close(); });

  it('0006 迁移与运行时 DDL 逐列同构，且重复执行只补记账、行与形状都不动', async () => {
    const migration6 = (await loadMigrations()).find((item) => item.version === 6)!;
    expect(migration6.name).toBe('0006_reader_sync_state.sql');
    await push(1, [progress(3, 100)]);
    const shape = () => pg.query(
      `SELECT column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reader_sync_state'
       ORDER BY ordinal_position`,
    ).then((result) => result.rows);
    const before = await shape();

    // 老库形态：表已由运行时 DDL 建好、带数据。迁移整批跑一遍只补记账。
    const client = createPGliteClient(pg);
    expect((await applyMigration(client, [migration6])).status).toBe('applied');
    expect((await applyMigration(client, [migration6])).status).toBe('unchanged');
    expect(await shape()).toEqual(before);
    expect(await pull(1)).toEqual([progress(3, 100)]);

    // 冷建库形态：只有 users，跑 0006 建出的表必须与上面那张逐列一致。
    const fresh = new PGliteCtor!();
    await fresh.exec(`CREATE TABLE users (id int PRIMARY KEY)`);
    await applyMigration(createPGliteClient(fresh), [migration6]);
    const freshShape = await (fresh.query(
      `SELECT column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reader_sync_state'
       ORDER BY ordinal_position`,
    )).then((result) => result.rows);
    expect(freshShape).toEqual(before);
    await fresh.close();
  }, 120_000);

  it('PUT→GET 往返：进度与设置各自成行，payload 原样回来', async () => {
    await push(1, [progress(5, 1_000), settings(22, 2_000)]);
    expect(await pull(1)).toEqual([progress(5, 1_000), settings(22, 2_000)]);
    // 带键回读（PUT 的响应就是它）：未提交的键不出现在结果里。
    expect(await pull(1, [readerSyncItemKey('settings', 'default')])).toEqual([settings(22, 2_000)]);
  });

  it('last-write-wins 双向：客户端版本更大才覆盖；更小与相等都保持服务端现值', async () => {
    await push(1, [progress(5, 1_000)]);
    // 本地较新 → 覆盖。
    await push(1, [progress(9, 2_000)]);
    expect(await pull(1)).toEqual([progress(9, 2_000)]);
    // 云端较新 → 本地那次迟到写入被丢弃，不报错、不静默改写。
    await expect(push(1, [progress(1, 1_500)])).resolves.toBeUndefined();
    expect(await pull(1)).toEqual([progress(9, 2_000)]);
    // 同版本写入同样不覆盖：客户端「刚好等于」多见于同一毫秒内两次保存。
    await push(1, [progress(2, 2_000)]);
    expect(await pull(1)).toEqual([progress(9, 2_000)]);
  });

  it('按用户隔离：另一用户既读不到也覆盖不了本人的行', async () => {
    await push(1, [progress(5, 1_000)]);
    expect(await pull(2)).toEqual([]);
    // 同一 item_key 在不同 user_id 下是两行，不冲突。
    await push(2, [progress(1, 900)]);
    expect(await pull(1)).toEqual([progress(5, 1_000)]);
    expect(await pull(2)).toEqual([progress(1, 900)]);
  });

  it('非法 userId 在构造 SQL 时就拒（不会发出带 userId=0 的查询）', () => {
    expect(() => readerSyncEntriesForUserQuery(sql(), 0)).toThrow('explicit userId is required');
    expect(() => saveReaderSyncEntriesForUserQueries(sql(), -1, [])).toThrow('explicit userId is required');
  });
});
