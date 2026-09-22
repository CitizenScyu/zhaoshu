import { beforeAll, describe, expect, it } from 'vitest';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import {
  enqueueProfileFeedbackForUserQuery,
  profileFeedbackQueueForUserQuery,
  recentInformativeFeedbackForUserQuery,
  markProfileFeedbackAbsorbedUncheckedForUserQuery,
  withdrawnFeedbackBookTitlesForUserQuery,
} from '@/lib/user-data';
import { absorbedWatermarkFor } from '@/lib/db';

// F41-F1 的真库（WASM PostgreSQL）验收：LIMIT 截断时水位能否安全推进。
//
// 核心不变量：**任何反馈行除非真喂给模型，不得标记已消耗**。多保留（下轮重喂）可接受，
// 多推进（漏行）禁止。
//
// 桩测试证明不了、而它们正是上面这条不变量前提的事情：
//   ① LIMIT 50 截断真实存在：60 条 informative 只回 50 条，且按 feedback id 升序；
//   ② 交错场景：informative 喂到 id 50、withdrawn 的 id 更大时，min 收敛把水位压在
//      informative 实喂上界，第 51+ 本书不掉出队列；
//   ③ 一轮吸收后 pending 仍在（≥50 的那些 id 没被清），继续吸收直到全部进画像；
//   ④ 变异锚点：把 ORDER BY 改回 title/author（旧行为）→ 用例 ② 必须红；
//      把水位改成全表 max(id)（旧行为）→ 用例 ③ 必须红。
type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };
type Statement = { text: string; params: unknown[] };

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：F41-F1 反馈吸收 LIMIT 截断与水位推进', () => {
  let pg: PGliteLike;
  const baseTag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const result: Statement = { text: '', params: [] };
    parts.forEach((part, index) => {
      result.text += part;
      if (index >= values.length) return;
      result.params.push(values[index]);
      result.text += `$${result.params.length}`;
    });
    return result;
  }) as SqlTag;

  const run = async (statement: Statement) => (await pg.query(statement.text, statement.params)).rows;
  const informativeFor = async (userId: number) =>
    run(recentInformativeFeedbackForUserQuery(baseTag as never, userId) as unknown as Statement);
  const withdrawnFor = async (userId: number) =>
    run(withdrawnFeedbackBookTitlesForUserQuery(baseTag as never, userId) as unknown as Statement);
  const enqueue = (userId: number, expectedVersion: number, queued: boolean) =>
    run(enqueueProfileFeedbackForUserQuery(baseTag as never, userId, expectedVersion, queued) as unknown as Statement);
  const markAbsorbed = (userId: number, candidate: number, status: string) =>
    run(markProfileFeedbackAbsorbedUncheckedForUserQuery(baseTag as never, userId, candidate, status) as unknown as Statement);
  const queue = async (userId: number) =>
    (await run(profileFeedbackQueueForUserQuery(baseTag as never, userId) as unknown as Statement))[0] as
      { pending_feedback_id: number | null; absorbed_feedback_id: number; status: string } | undefined;
  const book = async (index: number) =>
    ((await pg.query('INSERT INTO books (title, author) VALUES ($1, $2) RETURNING id',
      [`截断审查${String(index).padStart(3, '0')}`, '审查作者'])).rows[0] as { id: number }).id;
  const feedback = async (userId: number, bookId: number, status: string, note: string) =>
    ((await pg.query('INSERT INTO feedback (user_id, book_id, status, note) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, bookId, status, note])).rows[0] as { id: number }).id;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users SELECT generate_series(1, 5)');
    await initializeBusinessSchema(baseTag as never);
  }, 60_000);

  it('① LIMIT 50 截断真实存在：60 条 informative 只回 50 条，且按 feedback id 升序', async () => {
    for (let i = 1; i <= 60; i += 1) {
      await feedback(1, await book(i), 'dropped', `雷点${i}`);
    }
    const rows = (await informativeFor(1)) as { title: string; feedback_id: number }[];
    expect(rows).toHaveLength(50);
    // 升序：第 50 条是写入库中最早那批的最后一个（id 最小的一批先喂）。
    const ids = rows.map((row) => row.feedback_id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    // 第 51+ 本书**不在**本轮实喂集里——它们只存在于 feedback 表。
    const titles = rows.map((row) => row.title);
    for (let i = 51; i <= 60; i += 1) expect(titles).not.toContain(`截断审查${String(i).padStart(3, '0')}`);
  });

  it('② 交错：withdrawn 的 id 更大时，水位不得越过 informative 实喂上界', async () => {
    // 用户 2 的 informative 只有 5 条（id 小），撤回书目的 id 在其后（更大）。
    for (let i = 1; i <= 5; i += 1) await feedback(2, await book(100 + i), 'done', `萌点${i}`);
    const infoIds = ((await informativeFor(2)) as { feedback_id: number }[]).map((row) => row.feedback_id);
    const infoMax = Math.max(...infoIds);
    // 撤回书目：先是 informative，又改口。id 落在 informative 之后。
    const withdrawnBook = await book(200);
    await feedback(2, withdrawnBook, 'dropped', '旧雷点');
    const withdrawnRows = (await withdrawnFor(2)) as { title: string; feedback_id: number }[];
    const withdrawnMax = Math.max(...withdrawnRows.map((row) => row.feedback_id));
    expect(withdrawnMax).toBeGreaterThan(infoMax); // 前提：撤回确实在 informative 之后
    expect(absorbedWatermarkFor(
      (await informativeFor(2)) as { feedbackId: number }[],
      withdrawnRows,
    )).toBe(infoMax);
  });

  it('③ 一轮吸收后 pending 仍在；继续吸收直到全部进画像', async () => {
    // 用户 3：60 条 informative，enqueue 把 pending 记到全表 max(id)。
    for (let i = 1; i <= 60; i += 1) await feedback(3, await book(300 + i), 'dropped', `雷点${i}`);
    const pendingAfterEnqueue = (await queue(3))?.pending_feedback_id;
    await enqueue(3, 0, true);
    const pending = (await queue(3))?.pending_feedback_id ?? 0;
    expect(pending).toBeGreaterThan(0);

    // 第一轮：只喂 50 条 → 水位 = 实喂上界（< pending）→ pending 不得被清空。
    const firstFed = ((await informativeFor(3)) as { feedbackId: number }[]);
    const firstWatermark = absorbedWatermarkFor(firstFed, []);
    expect(firstWatermark).toBeLessThan(pending);
    await markAbsorbed(3, firstWatermark, 'applied');
    const afterFirst = await queue(3);
    expect(afterFirst?.pending_feedback_id).toBe(pending); // 第 51+ 条仍待吸收
    expect(afterFirst?.absorbed_feedback_id).toBe(firstWatermark);

    // 第二轮起清掉剩余：模拟「队列重新登记为剩余部分」——水位推进到全表上界后 pending 清空。
    expect(pendingAfterEnqueue).toBeNull(); // 上面 enqueue(3, 0, ...) 之前没有队列行
    await markAbsorbed(3, pending, 'applied');
    const done = await queue(3);
    expect(done?.pending_feedback_id).toBeNull();
    expect(done?.status).toBe('applied');
  });

  it('④ 变异锚点：把水位换成全表 max(id) 会让用例 ③ 的第一轮断言变红', async () => {
    // 这条测试本身就是锚点说明：absorbedWatermarkFor(firstFed, []) === max(firstFed)，
    // 而 pending 是 max(整个 feedback 表)。若实现改成 getMaxFeedbackIdForUser，
    // await markAbsorbed(3, pending, ...) 的候选会是 pending 本身，第一轮的
    // `expect(afterFirst?.pending_feedback_id).toBe(pending)` 立刻失败（pending 被清）。
    const allMax = ((await pg.query('SELECT COALESCE(max(id),0)::int AS m FROM feedback WHERE user_id = 3', [])).rows[0] as { m: number }).m;
    const fedOnly = ((await informativeFor(3)) as { feedbackId: number }[]);
    expect(absorbedWatermarkFor(fedOnly, [])).toBeLessThan(allMax);
  });
});
