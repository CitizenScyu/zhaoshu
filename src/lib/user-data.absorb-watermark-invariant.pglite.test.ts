import { beforeAll, describe, expect, it } from 'vitest';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema, seedProductionMembers } from '@/lib/fixtures/production-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import {
  claimProfileFeedbackForUserQuery,
  enqueueProfileFeedbackForUserQuery,
  markProfileFeedbackAbsorbedForUserQuery,
  profileFeedbackQueueForUserQuery,
  recentInformativeFeedbackForUserQuery,
  withdrawnFeedbackBookTitlesForUserQuery,
} from '@/lib/user-data';
import { absorbedWatermarkFor } from '@/lib/db';

// F41-F1 的不变量验收（真 PostgreSQL）：**异步吸收路径的水位绝不越过已喂行**。
//
// 本文件是「异步路径为什么不用 candidate 推进」这一决定的防线。任务书定的核心不变量：
//   **任何反馈行除非真喂给模型，不得标记已消费。多保留（下轮重喂）可接受，多推进（漏行）禁止。**
//
// 为什么单独一个文件：profile-absorption.ts 的租约/candidate 逻辑在桩测试里全是替身，
// 唯一能证明这条不变量的地方是**真库 + 真 SQL**。三条不变量分别钉：
//   ① 一轮吸收后，未被喂进去的 informative 行仍留在 pending，不被候选值清掉；
//   ② 多轮吸收最终把全部 informative 行喂完并清空 pending——既不漏行也不卡死；
//      （② 是①的另一半：只钉①会留下「队列永不排空」的静默退化，那与旧 bug 同症状。）
//   ③ enqueue 的 HAVING 只在真有新反馈时抬 pending，不会造出「幻影高位」把未喂行吞掉。
//
// 🔴 改动警告（写给未来）：下面三条同时成立，异步路径才安全——
//   (a) informative 查询按 feedback id 升序 + LIMIT 50 + `feedback_id > afterId`：
//       未喂行的 id 必然大于返回集最大 id（水位可安全推进），且 afterId 让每轮都往前赶，
//       否则每轮重读同一批 LIMIT 行，水位永远停在第一批，第 51+ 行既进不了画像、
//       队列也永不排空；
//   (b) 推进候选取本轮实喂上界（absorbedWatermarkFor(..., 'max')），**不是** claim 返回的
//       pending_feedback_id（那个是 enqueue 用 max(id) 记的全表上界）；
//   (c) withdrawn 查询**不**带 afterId：它是「当前全部已撤回书目」清单，必须每轮重新告知，
//      否则撤回信号只生效一轮，旧偏好又留在画像里。
// 动到 recentInformativeFeedbackForUserQuery / withdrawnFeedbackBookTitlesForUserQuery /
// enqueueProfileFeedbackForUserQuery 的排序、LIMIT、afterId 或 HAVING 之前，先看这里。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };
type Statement = { text: string; params: unknown[] };

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：异步吸收水位不越过已喂行（F41-F1 不变量）', () => {
  let pg: PGliteLike;
  const baseTag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const result: Statement = { text: '', params: [] };
    const flatten = (value: unknown) => {
      // claim 查询内嵌 leaseEligiblePredicate(sql) 的返回值：pglite 路径是 {text, params}，
      //  neon 路径是 {queryData:{strings,values}}。两种都展平，否则嵌套片段会被当参数绑定。
      const fragment = value as { text?: string; params?: unknown[]; queryData?: { strings?: unknown[]; values?: unknown[] } } | null;
      if (fragment && typeof fragment === 'object' && Array.isArray(fragment.queryData?.strings)) {
        const { strings, values: nested } = fragment.queryData!;
        strings!.forEach((piece, index) => {
          result.text += piece;
          if (index < (nested?.length ?? 0)) flatten(nested![index]);
        });
        return;
      }
      if (fragment && typeof fragment === 'object' && typeof fragment.text === 'string' && Array.isArray(fragment.params)) {
        result.text += fragment.text;
        fragment.params.forEach(flatten);
        return;
      }
      result.params.push(value);
      result.text += `$${result.params.length}`;
    };
    parts.forEach((part, index) => {
      result.text += part;
      if (index < values.length) flatten(values[index]);
    });
    return result;
  }) as SqlTag;
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
  const claim = (userId: number, token: string, leaseMs = 60_000) =>
    run(claimProfileFeedbackForUserQuery(baseTag as never, userId, token, leaseMs) as unknown as Statement);
  const enqueue = (userId: number, expectedVersion: number, queued: boolean) =>
    run(enqueueProfileFeedbackForUserQuery(baseTag as never, userId, expectedVersion, queued) as unknown as Statement);
  const markAbsorbed = (userId: number, candidate: number, status: string, token: string) =>
    run(markProfileFeedbackAbsorbedForUserQuery(baseTag as never, userId, candidate, status, token) as unknown as Statement);
  const queue = async (userId: number) =>
    (await run(profileFeedbackQueueForUserQuery(baseTag as never, userId) as unknown as Statement))[0] as
      | { pending_feedback_id: number | null; absorbed_feedback_id: number; status: string; lease_token: string }
      | undefined;
  const informative = async (userId: number, afterId = 0) =>
    (await run(recentInformativeFeedbackForUserQuery(baseTag as never, userId, 50, afterId) as unknown as Statement)) as
      { title: string; note: string; feedback_id: number }[];
  const withdrawn = async (userId: number) =>
    (await run(withdrawnFeedbackBookTitlesForUserQuery(baseTag as never, userId) as unknown as Statement)) as
      { title: string; feedback_id: number }[];
  const book = async (index: number) =>
    ((await pg.query('INSERT INTO books (title, author) VALUES ($1, $2) RETURNING id',
      [`水位审查${String(index).padStart(3, '0')}`, '审查作者'])).rows[0] as { id: number }).id;
  const feedback = async (userId: number, bookId: number, status: string, note: string) =>
    ((await pg.query('INSERT INTO feedback (user_id, book_id, status, note) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, bookId, status, note])).rows[0] as { id: number }).id;

  /** 与 absorbPendingProfileFeedback 同一段推进逻辑（租约 → 读 → 阈值 → 提交）。 */
  const absorbRound = async (userId: number, token: string) => {
    const claimed = await claim(userId, token) as { candidate: number }[];
    if (!claimed.length) return null;
    const row = await queue(userId);
    const absorbed = row?.absorbed_feedback_id ?? 0;
    const fed = await informative(userId, absorbed);
    const withdrawnRows = await withdrawn(userId);
    const watermark = absorbedWatermarkFor(
      fed.map((row) => ({ feedbackId: row.feedback_id })),
      withdrawnRows.map((row) => ({ feedbackId: row.feedback_id })),
      'max',
    );
    const advanceTo = watermark > 0 ? watermark : claimed[0].candidate;
    await markAbsorbed(userId, advanceTo, 'applied', token);
    return { candidate: claimed[0].candidate, advanceTo, fed, withdrawnRows };
  };

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
    await seedProductionMembers(pg, 5);
  }, 60_000);

  it('不变量①：一轮吸收后，未喂进模型的 informative 行仍留在 pending（水位不越过已喂行）', async () => {
    // 用户 1：60 条 informative（数量 > LIMIT 50），enqueue 把 pending 记成全表 max(id)。
    for (let i = 1; i <= 60; i += 1) await feedback(1, await book(i), 'dropped', `雷点${i}`);
    await enqueue(1, 0, true);
    const pending = (await queue(1))?.pending_feedback_id ?? 0;
    expect(pending).toBeGreaterThan(0);

    const round = await absorbRound(1, 'lease-inv-1');
    expect(round).not.toBeNull();
    // 只喂了 50 条 ⇒ 实喂上界必然小于 pending（全表上界）。
    expect(round!.fed).toHaveLength(50);
    expect(round!.advanceTo).toBeLessThan(pending);
    // 水位没有越过已喂行 ⇒ pending 保留，第 51+ 条的偏好没被标记成「已吸收」。
    const after = await queue(1);
    expect(after?.pending_feedback_id).toBe(pending);
    expect(after?.absorbed_feedback_id).toBe(round!.advanceTo);
    expect(after?.status).toBe('pending');
  });

  it('不变量②：下一轮吸收读到的是「下一批」而不是同一批，且最终把剩余行喂完并清空 pending', async () => {
    // 沿用用户 1 的夹具：①已把水位推到前 50 条。重新 enqueue（模拟用户又写了反馈），
    // 然后断言**下一轮**读到的是第 51..60 条——不是重读 1..50。
    // 🔴 删掉 afterId 过滤这条就红：每轮都返回同一批 50 行，seen 永远收不齐 60 条。
    await enqueue(1, 0, true);
    const pending = (await queue(1))?.pending_feedback_id ?? 0;
    expect(pending).toBeGreaterThan(0);

    const second = await absorbRound(1, 'lease-inv-2');
    expect(second).not.toBeNull();
    expect(second!.fed).toHaveLength(10); // 正好是剩下的 10 条，不是重读的 50
    const notes = second!.fed.map((row) => row.note);
    for (let i = 51; i <= 60; i += 1) expect(notes).toContain(`雷点${i}`);
    for (let i = 1; i <= 50; i += 1) expect(notes).not.toContain(`雷点${i}`); // 已喂过的不重读
    // 水位推到全表上界 ⇒ pending 清空、队列排空（不是「永远 pending、每天空烧一次模型」）。
    expect(second!.advanceTo).toBe(pending);
    const done = await queue(1);
    expect(done?.pending_feedback_id).toBeNull();
    expect(done?.status).toBe('applied');
  });

  it('不变量③：enqueue 只在真有新反馈时抬 pending，不制造越过已喂行的幻影高位', async () => {
    // 用户 2：一条 informative + 之后全是无信息量的 want。
    const b1 = await book(1000);
    const id1 = await feedback(2, b1, 'dropped', '唯一雷点');
    await enqueue(2, 0, true);
    expect((await queue(2))?.pending_feedback_id).toBe(id1);

    // 一次吸收把它清干净。
    await absorbRound(2, 'lease-inv-3a');
    expect((await queue(2))?.pending_feedback_id).toBeNull();

    // 没有新反馈时再 enqueue：HAVING max(id) > expectedVersion 落空 ⇒ 0 行，pending 保持 NULL。
    await enqueue(2, id1, true);
    expect((await queue(2))?.pending_feedback_id).toBeNull();

    // 新反馈到来才抬 pending，且抬到的是那条新行自己的 id（不是幻影高位）。
    const id2 = await feedback(2, b1, 'done', '改口后的萌点');
    await enqueue(2, id1, true);
    expect((await queue(2))?.pending_feedback_id).toBe(id2);
  });
});
