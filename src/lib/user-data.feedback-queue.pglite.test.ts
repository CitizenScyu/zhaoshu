import { beforeAll, describe, expect, it } from 'vitest';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import {
  enqueueProfileFeedbackForUserQuery,
  markProfileFeedbackAbsorbedUncheckedForUserQuery,
  profileFeedbackBackoffMs,
  profileFeedbackQueueForUserQuery,
  recentInformativeFeedbackForUserQuery,
} from '@/lib/user-data';

// F15 的真库（WASM PostgreSQL）语义验收：队列水位、合并、可恢复。
//
// 桩测试证明不了、而它们正是「并发两条反馈都被吸收」「失败可重放」前提的事情：
//   ① 并发写两本书的反馈只抬水位不互相覆盖（GREATEST），一次吸收覆盖全部；
//   ② 水位只在成功（applied/unchanged）时推进，失败/冲突保留 pending；
//   ③ 吸收期间新到的反馈（更高水位）不会被旧候选清掉，状态退回 pending；
//   ④ 写 0 行（404 护栏）或 queued=false 不产生队列事件；
//   ⑤ 撤回后的最新行不再进「最新有效反馈」，从而吸收不复活旧偏好。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：profile_feedback_queue（F15 待吸收水位）', () => {
  let pg: PGliteLike;
  const baseTag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return { text, params };
  }) as SqlTag;
  const tag = Object.assign(baseTag, {
    transaction: async (builder: (tx: SqlTag) => { text: string; params: unknown[] }[]) => {
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

  const run = async (statement: { text: string; params: unknown[] }) =>
    (await pg.query(statement.text, statement.params)).rows;
  const enqueue = (userId: number, expectedVersion: number, queued: boolean) =>
    run(enqueueProfileFeedbackForUserQuery(tag as never, userId, expectedVersion, queued) as unknown as { text: string; params: unknown[] });
  // 既有水位测试不持租约：absorbed 走无租约变体（重建后推水位同款），failed 用空 token
  // 会写 0 行，因此先按无租约模式直接 UPDATE——这里保留旧断言语义（attempts/last_error
  // 如实记录），退避与租约的独立验收在 lease 专项用例里。
  const markAbsorbed = (userId: number, candidate: number, status: string) =>
    run(markProfileFeedbackAbsorbedUncheckedForUserQuery(tag as never, userId, candidate, status) as unknown as { text: string; params: unknown[] });
  const markFailed = (userId: number, status: string, error: string) =>
    pg.query(`UPDATE profile_feedback_queue
      SET status = $2, attempts = attempts + 1, last_error = $3, fail_count = fail_count + 1,
          next_eligible_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
      WHERE user_id = $1`,
      [userId, status, error, profileFeedbackBackoffMs(1)]);
  const queue = async (userId: number) =>
    (await run(profileFeedbackQueueForUserQuery(tag as never, userId) as unknown as { text: string; params: unknown[] }))[0] as
      { pending_feedback_id: number | null; absorbed_feedback_id: number; status: string; attempts: number; last_error: string } | undefined;
  const informative = async (userId: number) =>
    ((await run(recentInformativeFeedbackForUserQuery(tag as never, userId) as unknown as { text: string; params: unknown[] }))
      .map((row) => row.title) as string[]);
  const book = async (title: string, author = '审查作者') =>
    ((await pg.query('INSERT INTO books (title, author) VALUES ($1, $2) RETURNING id', [title, author])).rows[0] as { id: number }).id;
  const feedback = async (userId: number, bookId: number, status: string, note: string) =>
    ((await pg.query('INSERT INTO feedback (user_id, book_id, status, note) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, bookId, status, note])).rows[0] as { id: number }).id;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users SELECT generate_series(1, 5)');
    await initializeBusinessSchema(tag as never);
  }, 60_000);

  it('queued=false 或没有新反馈行时不产生队列事件（404 护栏不留脏 pending）', async () => {
    const b = await book('无信息量审查');
    const id = await feedback(1, b, 'want', '想读');
    await enqueue(1, id - 1, false); // 无信息量
    expect(await queue(1)).toBeUndefined();

    // 模拟 404 护栏：INSERT 写 0 行，max(id) 仍等于 expectedVersion → HAVING 落空。
    await enqueue(1, id, true);
    expect(await queue(1)).toBeUndefined();
  });

  it('有信息量的反馈抬升水位；并发写两本书只合并不覆盖（一次吸收覆盖全部）', async () => {
    const first = await book('并发审查甲');
    const second = await book('并发审查乙');
    const idA = await feedback(1, first, 'dropped', '讨厌机械降神');
    await enqueue(1, idA - 1, true);
    expect((await queue(1))?.pending_feedback_id).toBe(idA);

    const idB = await feedback(1, second, 'done', '喜欢严谨设定');
    await enqueue(1, idA, true);
    const row = await queue(1);
    expect(row?.pending_feedback_id).toBe(idB); // 两条并发反馈都还在待吸收集合里
    expect(row?.status).toBe('pending');
    // 一次「按用户」的读取就覆盖两条反馈——这是「合并吸收」的数据前提。
    // F41-F1：informative 改按 feedback id 升序（放弃 title 排序，理由见 user-data.ts 注释），
    // 因此先写入的「并发审查甲」排在前。这条断言的顺序本身是 id ASC 的可见证据。
    expect(await informative(1)).toEqual(['并发审查甲', '并发审查乙']);
  });

  it('成功吸收按候选水位推进；吸收期间新到的更高水位不会被清掉，状态退回 pending', async () => {
    const b = await book('重放审查');
    const id = await feedback(2, b, 'dropped', '文笔劝退');
    await enqueue(2, id - 1, true);
    expect((await queue(2))?.pending_feedback_id).toBe(id);

    // 吸收成功的时间点之后又来了新反馈（更高水位）。
    const newer = await feedback(2, b, 'done', '后来改口');
    await enqueue(2, id, true);
    const after = await markAbsorbed(2, id, 'applied');
    expect(after[0].pending_feedback_id).toBe(newer);
    const row = await queue(2);
    expect(row?.pending_feedback_id).toBe(newer);
    expect(row?.absorbed_feedback_id).toBe(id);
    expect(row?.status).toBe('pending');

    // 下一次吸收把最新水位一起吸收 → pending 清空、状态 applied。
    await markAbsorbed(2, newer, 'applied');
    const done = await queue(2);
    expect(done?.pending_feedback_id).toBeNull();
    expect(done?.absorbed_feedback_id).toBe(newer);
    expect(done?.status).toBe('applied');
  });

  it('失败保留 pending 可重放；attempts 与 last_error 如实记录', async () => {
    const b = await book('失败重放审查');
    const id = await feedback(3, b, 'dropped', '主角不喜欢');
    await enqueue(3, id - 1, true);
    await markFailed(3, 'failed', 'LlmError');
    const failed = await queue(3);
    expect(failed?.pending_feedback_id).toBe(id);
    expect(failed?.status).toBe('failed');
    expect(failed?.last_error).toBe('LlmError');
    expect(failed?.attempts).toBe(1);

    const after = await markAbsorbed(3, id, 'applied');
    expect(after[0].pending_feedback_id).toBeNull();
    const done = await queue(3);
    expect(done?.status).toBe('applied');
    expect(done?.last_error).toBe('');
    expect(done?.attempts).toBe(2);
  });

  it('撤回后的最新行不再进最新有效反馈，因此吸收不会复活旧偏好', async () => {
    const b = await book('撤回吸收审查');
    await feedback(4, b, 'dropped', '讨厌机械降神');
    expect(await informative(4)).toEqual(['撤回吸收审查']);
    // 用户改口（撤回）：最新一行不再 informative。
    await feedback(4, b, 'reading', '');
    expect(await informative(4)).toEqual([]);
  });

  it('队列严格按 user_id 隔离', async () => {
    const b = await book('隔离审查');
    const id = await feedback(5, b, 'dropped', '别人的雷点');
    await enqueue(5, id - 1, true);
    expect((await queue(5))?.pending_feedback_id).toBe(id);
    expect((await queue(4))?.pending_feedback_id ?? null).not.toBe(id);
  });
});
