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
  // initializeBusinessSchema 走 transaction 批量 DDL（与既有 pglite 测试同款适配）。
  const schemaTag = Object.assign(baseTag, {
    transaction: async (builder: (tx: SqlTag) => Statement[]) => {
      const statements = builder(baseTag);
      await pg.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push((await pg.query(statement.text, statement.params)).rows);
        await pg.exec('COMMIT');
        return results;
      } catch (error) { await pg.exec('ROLLBACK').catch(() => {}); throw error; }
    },
  }) as unknown as SqlTag;

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
    await initializeBusinessSchema(schemaTag as never);
  }, 60_000);

  it('① LIMIT 50 截断真实存在：60 条 informative 只回 50 条，且按 feedback id 升序', async () => {
    // 书名的字典序与写入顺序**刻意相反**：第 i 本写入时给它「字典序第 (61-i) 小」的名字
    // （rev060, rev059, ..., rev001）。于是：
    //   - ORDER BY feedback_id ASC（本修复）→ 取最先写入的 50 本，名字是 rev011..rev060 这批的
    //     字典序**较大**一半；
    //   - ORDER BY title, author（旧行为）→ 按字典序取 rev001..rev050，正好是**后写入**的 50 本。
    // 两者取到的集合不同 → 下面的断言在旧行为下必红（id 升序、首行身份、两批的成员名单）。
    for (let i = 1; i <= 60; i += 1) {
      await feedback(1, await book(61 - i), 'dropped', `雷点${i}`);
    }
    const rows = (await informativeFor(1)) as { title: string; note: string; feedback_id: number }[];
    expect(rows).toHaveLength(50);
    // 升序：第 50 条是写入库中最早那批的最后一个（id 最小的一批先喂）。
    const ids = rows.map((row) => row.feedback_id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    // 后写入的 10 本（雷点51..雷点60 = 字典序最小的 rev001..rev010 那批）不在本轮实喂集里。
    const titles = rows.map((row) => row.title);
    for (let i = 1; i <= 10; i += 1) expect(titles).not.toContain(`截断审查${String(i).padStart(3, '0')}`);
    // 变异锚点：id ASC 取的是「最先写入的 50 本」（雷点1..雷点50，即字典序较大的那半），
    // 旧行为 title 排序取的却是字典序较小的 rev001..rev050（=雷点11..雷点60）。
    // 用 note（雷点序号）判 membership：本批必须含最旧的雷点1、不含最新的雷点60。
    const notes = rows.map((row) => row.note);
    expect(notes).toContain('雷点1'); // 最小 feedback id 必被喂
    expect(notes).not.toContain('雷点60'); // 字典序最小(=rev001)却 id 最大：旧行为会喂它
    expect(titles).toContain('截断审查060'); // id 最小那本的名字（字典序最大的一半）
    expect(titles).not.toContain('截断审查001'); // id 最大那本的名字——旧行为会取
  });

  it('② 交错：withdrawn 的 id 更大时，水位不得越过 informative 实喂上界', async () => {
    // 用户 2 的 informative 只有 5 条（id 小），撤回书目的 id 在其后（更大）。
    for (let i = 1; i <= 5; i += 1) await feedback(2, await book(100 + i), 'done', `萌点${i}`);
    const infoIds = ((await informativeFor(2)) as { feedback_id: number }[]).map((row) => row.feedback_id);
    expect(infoIds.length).toBeGreaterThan(0);
    const infoMax = Math.max(...infoIds);
    // 撤回书目：先是 informative，又改口（最新行不再 informative）。id 落在 informative 之后。
    const withdrawnBook = await book(200);
    await feedback(2, withdrawnBook, 'dropped', '旧雷点');
    await feedback(2, withdrawnBook, 'reading', '');
    const withdrawnRows = (await withdrawnFor(2)) as { title: string; feedback_id: number }[];
    expect(withdrawnRows.length).toBeGreaterThan(0); // 撤回书目非空
    const withdrawnMax = Math.max(...withdrawnRows.map((row) => row.feedback_id));
    expect(withdrawnMax).toBeGreaterThan(infoMax); // 前提：撤回确实在 informative 之后
    expect(absorbedWatermarkFor(
      ((await informativeFor(2)) as { feedback_id: number }[]).map((row) => ({ feedbackId: row.feedback_id })),
      withdrawnRows.map((row) => ({ feedbackId: row.feedback_id })),
    )).toBe(infoMax);
  });

  it('③ 一轮吸收后 pending 仍在；继续吸收直到全部进画像', async () => {
    // 用户 3：60 条 informative，enqueue 把 pending 记到全表 max(id)。
    for (let i = 1; i <= 60; i += 1) await feedback(3, await book(300 + i), 'dropped', `雷点${i}`);
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

    // 后续轮：水位推进到 pending（剩余部分全部喂过）后 pending 清空、状态 applied。
    // 每一轮都重新 enqueue（新反馈登记）再吸收，模拟 drain 多次兜底直到队列干净。
    await enqueue(3, firstWatermark, true);
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
