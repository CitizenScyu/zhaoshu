// zhuigeng42：追更链路的**真库**行为回归（PGlite 真 PostgreSQL）。
//
// 桩测试钉不住这里的任何一条：候选集合的四个交集、库级活动任务去重、退避写回的时间推进、
// 以及「有更新」徽标的真假。全部用生产同源的 schema（createProductionSchema）与生产同款 SQL 跑。
//
// 迁移幂等另由 runtime-tables-migration.pglite.test.ts 覆盖同构；本文件补一条「0007 重跑是空转」。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema, seedProductionMembers } from '@/lib/fixtures/production-schema';
import { applyMigration, loadMigrations } from '../../scripts/db-migration-lib.mjs';
import {
  claimFollowupLease, followupCandidatesQuery, followupPrefixKey, processFollowupCandidate,
  type FollowupCandidate, type FollowupProbeOutcome,
} from '@/lib/followup';

/** 候选行是库侧 snake_case 列名，按生产映射逐字段取（与 runner 里的 candidateOf 同口径）。 */
function candidateOf(row: Record<string, unknown>): FollowupCandidate {
  return {
    userId: Number(row.user_id), bookId: Number(row.book_id), title: String(row.title), author: String(row.author),
    sourceUrl: String(row.source_url), sourceKind: String(row.source_kind),
    sourceId: row.source_id === null ? null : String(row.source_id), sourceRevision: String(row.source_revision),
    lastChapterCount: row.last_chapter_count === null ? null : Number(row.last_chapter_count),
    lastTocPrefixHash: String(row.last_toc_prefix_hash ?? ''),
    consecutiveNoNew: Number(row.consecutive_no_new ?? 0),
  };
}
import { recommendationsForUserQuery } from '@/lib/user-data';

/**
 * 能内联子语句的标签。createPGliteSql 会把嵌套的 sql`` 当**参数**绑进去（Neon 会展开），
 * 而 recommendationsForUserQuery 内部就是按 canRead 拼子语句的，所以这里要用与
 * user-data.shelf.pglite.test.ts 同款的展开标签跑它。
 */
type Statement = { text: string; params: unknown[] };
function nestTag(parts: TemplateStringsArray, ...values: unknown[]): Statement {
  const result: Statement = { text: '', params: [] };
  parts.forEach((part, index) => {
    result.text += part;
    if (index >= values.length) return;
    const value = values[index];
    if (value && typeof value === 'object' && 'text' in value && 'params' in value) {
      const child = value as Statement;
      const offset = result.params.length;
      result.text += child.text.replace(/\$(\d+)/g, (_, number: string) => `$${Number(number) + offset}`);
      result.params.push(...child.params);
    } else {
      result.params.push(value);
      result.text += `$${result.params.length}`;
    }
  });
  return result;
}
const shelfSql = nestTag as never;

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

let pg: PGliteLike;
const sql = () => createPGliteSql(pg) as never;

const MIGRATION_0007 = new URL('../../migrations/0007_followup_probe_state.sql', import.meta.url);

async function insertBook(title: string, author = '追更作者', sourceUrl = 'https://reader.example/book') {
  const rows = await pg.query(
    `INSERT INTO labeled_books (title, author, source_url) VALUES ($1, $2, $3) RETURNING id`,
    [title, author, sourceUrl]);
  return rows.rows[0].id as number;
}

async function insertTask(
  bookId: number, userId: number, status: string, title: string, createdOffsetSeconds = 0,
): Promise<number> {
  const rows = await pg.query(
    `INSERT INTO download_tasks (user_id, book_id, title, author, source_url, status, requested_by,
       source_kind, source_id, source_revision, created_at, updated_at)
     VALUES ($1, $2, $3, '追更作者', 'https://reader.example/book', $4, 'user', 'engine',
       'https://reader.example', 'rev1', now() + $5::interval, now() + $5::interval)
     RETURNING id`, [userId, bookId, title, status, `${createdOffsetSeconds} seconds`]);
  return rows.rows[0].id as number;
}

/** 写入一条「用户读过这本书某版全文」的阅读进度（item_key 与生产同形状）。 */
async function markRead(userId: number, taskId: number, atSql = "now() - interval '1 day'") {
  await pg.query(
    `INSERT INTO reader_sync_state (user_id, item_key, payload, client_updated_at, updated_at)
     VALUES ($1, $2, '{"chapterIndex":1,"updatedAt":1}', 1, ${atSql})
     ON CONFLICT (user_id, item_key) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [userId, `progress:novel-finder-reading-progress-u${userId}-${taskId}`]);
}

/** 书架推荐行指向 books(id)（与 labeled_books 是两套身份），这里按书名作者建书架行。 */
async function addShelfRow(userId: number, title: string) {
  await pg.query(
    `INSERT INTO books (title, author) VALUES ($1, '追更作者') ON CONFLICT DO NOTHING`, [title]);
  await pg.query(
    `INSERT INTO recommendations (user_id, book_id, query)
     SELECT $1, id, '追更测试' FROM books WHERE title = $2
     ON CONFLICT (user_id, book_id, query) DO NOTHING`, [userId, title]);
}

async function stateOf(bookId: number) {
  const rows = await pg.query(
    `SELECT last_chapter_count, last_toc_prefix_hash, consecutive_no_new, last_enqueued_task_id,
       round(extract(epoch FROM (next_probe_at - last_probe_at)) * 1000)::bigint AS interval_ms
     FROM followup_probe_state WHERE book_id = $1`, [bookId]);
  return rows.rows[0] as Record<string, unknown> | undefined;
}

const probe = (titles: string[]): FollowupProbeOutcome => ({ ok: true, titles });
const failed: FollowupProbeOutcome = { ok: false, titles: [], reason: 'source_unavailable' };

maybe('0007 本地干跑：迁移链跑到 0007，重跑是空转', () => {
  let pg: PGliteLike;

  beforeAll(async () => {
    pg = new PGliteCtor!();
  }, 60_000);
  afterAll(() => pg.close());

  it('db:migrate 走到 0007 并建出状态表与到期索引；再跑一次全部 unchanged', async () => {
    const client = createPGliteClient(pg);
    const migrations = await loadMigrations();
    const first = await applyMigration(client, migrations);
    expect(first.status).toBe('applied');
    expect(first.versions.at(-1)).toMatchObject({ version: 7, name: '0007_followup_probe_state.sql', status: 'applied' });
    const columns = (await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'followup_probe_state' ORDER BY column_name`))
      .rows.map((row) => row.column_name);
    expect(columns).toEqual([
      'book_id', 'consecutive_no_new', 'created_at', 'last_chapter_count', 'last_enqueued_task_id',
      'last_probe_at', 'last_toc_prefix_hash', 'next_probe_at', 'updated_at',
    ]);
    expect((await pg.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'followup_probe_state' AND indexname = 'followup_probe_state_due_idx'`)).rows)
      .toHaveLength(1);

    const second = await applyMigration(client, migrations);
    expect(second.status).toBe('unchanged');
    expect(second.versions.every((item) => item.status === 'unchanged')).toBe(true);
  }, 120_000);
});

maybe('追更轮：真库上的候选 / 判定 / 入队 / 退避', () => {
  beforeAll(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
    await seedProductionMembers(pg, 6);
  }, 120_000);
  afterAll(() => pg.close());

  it('0007 迁移重跑是空转（表形状不变、无重复索引报错）', async () => {
    const before = await pg.query(`SELECT count(*)::int AS n FROM followup_probe_state`);
    await pg.exec(readFileSync(MIGRATION_0007, 'utf8'));
    await pg.exec(readFileSync(MIGRATION_0007, 'utf8'));
    expect((await pg.query(`SELECT count(*)::int AS n FROM followup_probe_state`)).rows).toEqual(before.rows);
  });

  it('候选 = 在读（有进度项）∩ 最新 done ∩ 无活动任务 ∩ 到期', async () => {
    const bookDone = await insertBook('追更候选-读完');
    const bookNoRead = await insertBook('追更候选-没读过');
    const bookActive = await insertBook('追更候选-有活动任务');
    const doneTask = await insertTask(bookDone, 2, 'done', '追更候选-读完');
    await insertTask(bookNoRead, 2, 'done', '追更候选-没读过');
    const activeTask = await insertTask(bookActive, 2, 'done', '追更候选-有活动任务');
    await insertTask(bookActive, 2, 'pending', '追更候选-有活动任务');
    await markRead(2, doneTask);
    await markRead(2, activeTask);
    const rows = await followupCandidatesQuery(sql(), 6) as unknown as Record<string, unknown>[];
    expect(rows.map(row => Number(row.book_id))).toContain(bookDone);
    expect(rows.map(row => Number(row.book_id))).not.toContain(bookNoRead);
    expect(rows.map(row => Number(row.book_id))).not.toContain(bookActive);
    const picked = candidateOf(rows.find(row => Number(row.book_id) === bookDone)!);
    expect(picked).toMatchObject({
      userId: 2, title: '追更候选-读完', sourceKind: 'engine', sourceId: 'https://reader.example',
      sourceRevision: 'rev1', lastChapterCount: null, lastTocPrefixHash: '', consecutiveNoNew: 0,
    });
  });

  it('未到期的书不进候选；到期后重新入选', async () => {
    const bookId = await insertBook('追更候选-退避未到期');
    const taskId = await insertTask(bookId, 3, 'done', '追更候选-退避未到期');
    await markRead(3, taskId);
    await pg.query(`INSERT INTO followup_probe_state (book_id, next_probe_at) VALUES ($1, now() + interval '3 hours')`, [bookId]);
    expect((await followupCandidatesQuery(sql(), 50) as unknown as Record<string, unknown>[]).map(row => Number(row.book_id))).not.toContain(bookId);
    await pg.query(`UPDATE followup_probe_state SET next_probe_at = now() - interval '1 second' WHERE book_id = $1`, [bookId]);
    expect((await followupCandidatesQuery(sql(), 50) as unknown as Record<string, unknown>[]).map(row => Number(row.book_id))).toContain(bookId);
  });

  it('首轮只记基线：不入队，但把目录指纹写进状态', async () => {
    const bookId = await insertBook('追更首轮');
    const taskId = await insertTask(bookId, 4, 'done', '追更首轮');
    await markRead(4, taskId);
    const [candidate] = (await followupCandidatesQuery(sql(), 6) as unknown as Record<string, unknown>[])
      .filter(row => Number(row.book_id) === bookId).map(candidateOf);
    const titles = ['第1章', '第2章', '第3章'];
    const handled = await processFollowupCandidate(sql(), candidate, probe(titles));
    expect(handled).toEqual({ outcome: 'baseline', taskId: null });
    expect(await pg.query(`SELECT count(*)::int AS n FROM download_tasks WHERE book_id = $1 AND id <> $2`, [bookId, taskId]))
      .toMatchObject({ rows: [{ n: 0 }] });
    const state = await stateOf(bookId);
    expect(state).toMatchObject({
      last_chapter_count: 3, last_toc_prefix_hash: followupPrefixKey(titles, 3), consecutive_no_new: 1,
      last_enqueued_task_id: null,
    });
    // 首轮之后 4h 才再探（退避基数）。
    expect(Number(state!.interval_ms)).toBeGreaterThanOrEqual(4 * 3_600_000 - 5_000);
  });

  it('纯追加：入队到在读那个用户名下（与 /api/download 同口径），基线推进到新目录', async () => {
    const bookId = await insertBook('追更追加');
    const doneTask = await insertTask(bookId, 5, 'done', '追更追加');
    await markRead(5, doneTask);
    const titles = ['第1章', '第2章'];
    await processFollowupCandidate(sql(), {
      bookId, userId: 5, title: '追更追加', author: '追更作者', sourceUrl: 'https://reader.example/book',
      sourceKind: 'engine', sourceId: 'https://reader.example', sourceRevision: 'rev1',
      lastChapterCount: null, lastTocPrefixHash: '', consecutiveNoNew: 0,
    }, probe(titles));
    // 首轮把 next_probe_at 推到退避窗口里；下一轮之前先让它到期，否则根本选不进候选。
    await pg.query(`UPDATE followup_probe_state SET next_probe_at = now() - interval '1 second' WHERE book_id = $1`, [bookId]);
    const [candidate] = (await followupCandidatesQuery(sql(), 6) as unknown as Record<string, unknown>[])
      .filter(row => Number(row.book_id) === bookId).map(candidateOf);
    expect(candidate).toMatchObject({ lastChapterCount: 2, lastTocPrefixHash: followupPrefixKey(titles, 2) });
    const appended = [...titles, '第3章'];
    const handled = await processFollowupCandidate(sql(), candidate, probe(appended));
    expect(handled.outcome).toBe('appended');
    const enqueued = await pg.query(
      `SELECT id, user_id, status, requested_by, source_url, source_kind, source_revision
       FROM download_tasks WHERE id = $1`, [handled.taskId]);
    expect(enqueued.rows[0]).toMatchObject({
      user_id: 5, status: 'pending', requested_by: 'user',
      source_url: 'https://reader.example/book', source_kind: 'engine', source_revision: 'rev1',
    });
    const state = await stateOf(bookId);
    expect(state).toMatchObject({
      last_chapter_count: 3, last_toc_prefix_hash: followupPrefixKey(appended, 3), consecutive_no_new: 0,
    });
    expect(state!.last_enqueued_task_id).toBe(handled.taskId);
    // 入队成功后回到 4h 节奏。
    expect(Number(state!.interval_ms)).toBeLessThanOrEqual(4 * 3_600_000 + 5_000);
  });

  it('站方改写旧章标题：不入队，按新目录重建基线', async () => {
    const bookId = await insertBook('追更改标题');
    const doneTask = await insertTask(bookId, 6, 'done', '追更改标题');
    await markRead(6, doneTask);
    const rewritten = ['第1章', '第2章（修订）'];
    const handled = await processFollowupCandidate(sql(), {
      bookId, userId: 6, title: '追更改标题', author: '追更作者', sourceUrl: 'https://reader.example/book',
      sourceKind: 'engine', sourceId: 'https://reader.example', sourceRevision: 'rev1',
      lastChapterCount: 2, lastTocPrefixHash: followupPrefixKey(['第1章', '第2章'], 2), consecutiveNoNew: 0,
    }, probe([...rewritten, '第3章']));
    expect(handled).toEqual({ outcome: 'rebased', taskId: null });
    expect(await stateOf(bookId)).toMatchObject({
      last_chapter_count: 3, last_toc_prefix_hash: followupPrefixKey(rewritten.concat('第3章'), 3),
    });
    expect((await pg.query(`SELECT count(*)::int AS n FROM download_tasks WHERE book_id = $1 AND id <> $2`, [bookId, doneTask])).rows[0].n).toBe(0);
  });

  it('目录收缩：不入队', async () => {
    const bookId = await insertBook('追更收缩');
    const doneTask = await insertTask(bookId, 6, 'done', '追更收缩');
    await markRead(6, doneTask);
    const handled = await processFollowupCandidate(sql(), {
      bookId, userId: 6, title: '追更收缩', author: '追更作者', sourceUrl: 'https://reader.example/book',
      sourceKind: 'engine', sourceId: 'https://reader.example', sourceRevision: 'rev1',
      lastChapterCount: 5, lastTocPrefixHash: followupPrefixKey(['1', '2', '3', '4', '5'], 5), consecutiveNoNew: 0,
    }, probe(['1', '2']));
    expect(handled).toEqual({ outcome: 'rebased', taskId: null });
    expect((await pg.query(`SELECT count(*)::int AS n FROM download_tasks WHERE book_id = $1 AND id <> $2`, [bookId, doneTask])).rows[0].n).toBe(0);
  });

  it('同书已有活动任务：判为 deduped，不插第二条、也不清零退避计数', async () => {
    const bookId = await insertBook('追更去重');
    const doneTask = await insertTask(bookId, 6, 'done', '追更去重');
    await markRead(6, doneTask);
    const running = await insertTask(bookId, 6, 'running', '追更去重');
    const titles = ['第1章', '第2章'];
    const handled = await processFollowupCandidate(sql(), {
      bookId, userId: 6, title: '追更去重', author: '追更作者', sourceUrl: 'https://reader.example/book',
      sourceKind: 'engine', sourceId: 'https://reader.example', sourceRevision: 'rev1',
      lastChapterCount: 2, lastTocPrefixHash: followupPrefixKey(titles, 2), consecutiveNoNew: 2,
    }, probe([...titles, '第3章']));
    expect(handled).toEqual({ outcome: 'deduped', taskId: null });
    const rows = await pg.query(`SELECT id FROM download_tasks WHERE book_id = $1 ORDER BY id`, [bookId]);
    expect(rows.rows.map(row => row.id)).toEqual([doneTask, running]);
    // 基线仍推进到新目录（避免下一轮又判成追加再撞一次），但退避不清零。
    expect(await stateOf(bookId)).toMatchObject({
      last_chapter_count: 3, consecutive_no_new: 3, last_enqueued_task_id: null,
    });
  });

  it('退避节奏：连续失败与连续无新章都按 4h·2^N 递增、24h 封顶', async () => {
    const bookId = await insertBook('追更退避');
    await insertTask(bookId, 6, 'done', '追更退避');
    const intervals: number[] = [];
    for (let round = 1; round <= 4; round++) {
      await processFollowupCandidate(sql(), {
        bookId, userId: 6, title: '追更退避', author: '追更作者', sourceUrl: 'https://reader.example/book',
        sourceKind: 'engine', sourceId: 'https://reader.example', sourceRevision: 'rev1',
        lastChapterCount: 1, lastTocPrefixHash: followupPrefixKey(['第1章'], 1), consecutiveNoNew: round - 1,
      }, failed);
      intervals.push(Number((await stateOf(bookId))!.interval_ms));
    }
    const hours = intervals.map(ms => Math.round(ms / 3_600_000));
    expect(hours).toEqual([8, 16, 24, 24]);
    expect((await stateOf(bookId))!.consecutive_no_new).toBe(4);
  });

  it('租约：同一时刻只领得到一次，未过期不再发放', async () => {
    expect(await claimFollowupLease(sql())).toEqual({ generation: '1' });
    expect(await claimFollowupLease(sql())).toBeNull();
    await pg.query(`UPDATE cron_health SET last_success_at = now() - interval '1 second' WHERE name = 'followup_probe_lease'`);
    expect(await claimFollowupLease(sql())).toEqual({ generation: '2' });
  });
});

maybe('书架「有更新」徽标：真库上的真假两例', () => {
  let shelfBook = 0;
  let followupTask = 0;
  const runShelf = async (userId: number, canRead: boolean) => {
    const { text, params } = recommendationsForUserQuery(shelfSql, userId, canRead) as unknown as Statement;
    return (await pg.query(text, params)).rows as { book_id: number; read_task_id: number | null; has_update: boolean }[];
  };

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
    await seedProductionMembers(pg, 6);
    shelfBook = await insertBook('徽标测试书');
    await addShelfRow(2, '徽标测试书');
    // 发布在 2 小时前、阅读在 1 小时前 ⇒ 读完的那一版没有更新。
    const doneTask = await insertTask(shelfBook, 2, 'done', '徽标测试书', -7_200);
    await markRead(2, doneTask, "now() - interval '1 hour'");
    const newer = await insertBook('徽标测试书-有新章');
    const newerDone = await insertTask(newer, 2, 'done', '徽标测试书-有新章');
    await addShelfRow(2, '徽标测试书-有新章');
    // 这一本：发布（刚才那一版）晚于最后阅读 ⇒ 有更新。
    await markRead(2, newerDone, "now() - interval '1 hour'");
    followupTask = newerDone;
  }, 120_000);
  afterAll(() => pg.close());

  it('读过的那一版没有更新；后来重抓发布的那一版亮「有更新」', async () => {
    const rows = await runShelf(2, true);
    const old = rows.find(row => row.book_id === shelfBook)!;
    expect(old.has_update).toBe(false);
    const fresh = rows.find(row => row.book_id !== shelfBook)!;
    expect(fresh.read_task_id).toBe(followupTask);
    expect(fresh.has_update).toBe(true);
  });

  it('从未读过（无进度项）时，刚下载完的那一版也算有更新', async () => {
    const bookId = await insertBook('徽标测试书-没打开过');
    const doneTask = await insertTask(bookId, 2, 'done', '徽标测试书-没打开过');
    await addShelfRow(2, '徽标测试书-没打开过');
    const rows = await runShelf(2, true);
    expect(rows.find(row => row.book_id === bookId)!.has_update).toBe(true);
    expect(doneTask).toBeGreaterThan(0);
  });

  it('无下载权限（canRead=false）时不查 download_tasks/reader_sync_state，一律无更新', async () => {
    const rows = await runShelf(2, false);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.has_update === false)).toBe(true);
  });
});
