// obsfix45 缺陷1：追更轮的**成功心跳**（cron_health 行 'followup'）在 PGlite 真库上的语义。
//
// 为什么必须真库：本缺陷的原形态是「followup 对 cron_health 的唯一写入是租约行
// followup_probe_lease，其 last_success_at 存的是 now()+TTL 的**到期时刻**」。只看语句形状的
// mock 测试无法区分「过去/现在」与「未来时刻」这两种语义，而差别正是「timer 停摆能不能被发现」：
// 租约行每轮开始就被推进到未来，跑没跑完都一样新鲜。
//
// 走 runFollowupRound 真实入口（getSql 换成 PGlite 标签），与 shuyuan.admission-lease.pglite.test.ts 同款。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema, seedProductionMembers } from './fixtures/production-schema';

const { getSql } = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));

import {
  FOLLOWUP_HEALTH_ROW, FOLLOWUP_LEASE_ROW, FOLLOWUP_LEASE_TTL_MS, runFollowupRound,
  type FollowupProbeOutcome,
} from './followup';
import { readCronSuccessTimes } from './source-health';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('obsfix45 追更轮成功心跳（PGlite 真库）', () => {
  let pg: PGliteLike;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, (statement) => pg.exec(statement));
    await seedProductionMembers(pg, 3);
    getSql.mockReturnValue(createPGliteSql(pg));
  }, 120_000);

  afterEach(async () => { await pg.close(); vi.restoreAllMocks(); });

  /** cron_health 里某行的 last_success_at 相对 now() 的毫秒数（正数 = 未来时刻）。 */
  async function ageMsOf(name: string): Promise<number | null> {
    const rows = (await pg.query(
      `SELECT extract(epoch FROM (now() - last_success_at)) * 1000 AS ms FROM cron_health WHERE name = $1`,
      [name],
    )).rows as { ms: number | string }[];
    return rows.length ? Number(rows[0].ms) : null;
  }

  const rowNames = async () => (await pg.query(`SELECT name FROM cron_health ORDER BY name`)).rows
    .map((row) => String((row as { name: string }).name));

  /** 造一本「在读且最新任务 done、无活动任务、到期」的候选书（与 followup.pglite.test.ts 同口径）。 */
  async function seedDueBook(title: string, userId: number): Promise<number> {
    const bookId = (await pg.query(
      `INSERT INTO labeled_books (title, author, source_url) VALUES ($1, '追更作者', 'https://reader.example/book') RETURNING id`,
      [title],
    )).rows[0].id as number;
    const taskId = (await pg.query(
      `INSERT INTO download_tasks (user_id, book_id, title, author, source_url, status, requested_by,
         source_kind, source_id, source_revision)
       VALUES ($1, $2, $3, '追更作者', 'https://reader.example/book', 'done', 'user', 'engine',
         'https://reader.example', 'rev1') RETURNING id`, [userId, bookId, title],
    )).rows[0].id as number;
    await pg.query(
      `INSERT INTO reader_sync_state (user_id, item_key, payload, client_updated_at, updated_at)
       VALUES ($1, $2, '{"chapterIndex":1,"updatedAt":1}', 1, now())`,
      [userId, `progress:novel-finder-reading-progress-u${userId}-${taskId}`]);
    return bookId;
  }

  it('一轮跑完（候选为 0 也算）⇒ 写 followup 心跳，readCronSuccessTimes 读得到', async () => {
    const report = await runFollowupRound();
    expect(report.candidates).toBe(0);
    expect(report).not.toHaveProperty('skipped');
    expect(await rowNames()).toContain(FOLLOWUP_HEALTH_ROW);
    const times = await readCronSuccessTimes();
    expect(times.followup).not.toBeNull();
  });

  it('心跳是**过去**的时刻，租约行是**未来**的到期时刻——两者语义相反，不得互相冒充', async () => {
    await runFollowupRound();
    const heartbeatAge = await ageMsOf(FOLLOWUP_HEALTH_ROW);
    const leaseAge = await ageMsOf(FOLLOWUP_LEASE_ROW);
    expect(heartbeatAge).not.toBeNull();
    expect(leaseAge).not.toBeNull();
    // 心跳：刚刚写的，年龄 ≥ 0（允许 1s 时钟/取整误差）。
    expect(heartbeatAge!).toBeGreaterThan(-1_000);
    // 租约：now()+TTL，年龄是负的（未来时刻），量级 = TTL。
    expect(leaseAge!).toBeLessThan(0);
    expect(-leaseAge!).toBeGreaterThan(FOLLOWUP_LEASE_TTL_MS - 60_000);
    // 端点透传的就是心跳行的值：它必须可解析成一个**不晚于现在**的时刻。租约行的值若被当成心跳
    // 透传出去，探针算出的年龄会被 hoursSince 夹到 0，永远「刚刚成功」——那正是本缺陷。
    const { followup } = await readCronSuccessTimes();
    expect(followup).not.toBeNull();
    expect(Date.parse(followup!)).toBeLessThanOrEqual(Date.now());
  });

  it('租约被占 ⇒ skipped:lease，且**不写**心跳（跳过不是完成，空转不得显示成健康）', async () => {
    await pg.query(
      `INSERT INTO cron_health (name, last_success_at, lease_generation)
       VALUES ($1, now() + interval '60 seconds', 1)`, [FOLLOWUP_LEASE_ROW]);
    const report = await runFollowupRound();
    expect(report.skipped).toBe('lease');
    expect(await rowNames()).not.toContain(FOLLOWUP_HEALTH_ROW);
    expect((await readCronSuccessTimes()).followup).toBeNull();
  });

  it('轮内失败（探测抛错）⇒ 不写心跳：停摆对探针可见', async () => {
    await seedDueBook('追更心跳-失败轮', 2);
    const boom = async (): Promise<FollowupProbeOutcome> => { throw new Error('probe exploded'); };
    await expect(runFollowupRound(undefined, { probe: boom })).rejects.toThrow(/probe exploded/);
    expect(await rowNames()).not.toContain(FOLLOWUP_HEALTH_ROW);
    expect((await readCronSuccessTimes()).followup).toBeNull();
  });

  it('只有租约行时 followup 读数为 null（readCronSuccessTimes 只认成功行名）', async () => {
    await pg.query(
      `INSERT INTO cron_health (name, last_success_at, lease_generation)
       VALUES ($1, now() + interval '60 seconds', 7)`, [FOLLOWUP_LEASE_ROW]);
    const times = await readCronSuccessTimes();
    expect(times.followup).toBeNull();
    expect(Object.keys(times)).not.toContain(FOLLOWUP_LEASE_ROW);
  });

  it('连续两轮成功：心跳被 upsert 覆盖，cron_health 里只有一行 followup（不累积）', async () => {
    await runFollowupRound();
    await pg.query(`UPDATE cron_health SET last_success_at = now() - interval '1 hour' WHERE name = $1`, [FOLLOWUP_HEALTH_ROW]);
    // 上一轮的租约仍在 TTL 内 ⇒ 先让它过期，第二轮才领得到。
    await pg.query(`UPDATE cron_health SET last_success_at = now() - interval '1 second' WHERE name = $1`, [FOLLOWUP_LEASE_ROW]);
    await runFollowupRound();
    const rows = (await pg.query(`SELECT count(*)::int AS n FROM cron_health WHERE name = $1`, [FOLLOWUP_HEALTH_ROW])).rows as { n: number }[];
    expect(rows[0].n).toBe(1);
    expect((await ageMsOf(FOLLOWUP_HEALTH_ROW))!).toBeLessThan(60_000);
  });
});
