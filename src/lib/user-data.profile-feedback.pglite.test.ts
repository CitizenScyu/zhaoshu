import { beforeAll, describe, expect, it } from 'vitest';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { recentInformativeFeedbackForUserQuery, withdrawnFeedbackBookTitlesForUserQuery } from '@/lib/user-data';

// 真实 PostgreSQL（WASM）：F04 的「本人最新有效反馈」查询语义。
//
// 桩测试证明不了三件事，而它们正是默认重建不丢/不复活偏好的前提：
//   ① 每本书只认最新一行——用户把反馈改成 want/reading 或清空 note（撤回）后，
//      更早那条 done+note 不得再被选中；
//   ② 只有最新状态仍具信息量（done/dropped 且 note 非空）才喂给模型；
//   ③ 严格按 user_id 隔离，另一用户的反馈绝不进入本用户结果；
//   ④ 撤回标记查询（withdrawnFeedbackBookTitlesForUserQuery）只列出「曾 informative、最新已非
//      informative」的书，且只回传书名（不含旧 note）。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：recentInformativeFeedbackForUserQuery（F04 最新有效反馈）', () => {
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
  // initializeBusinessSchema 走 s.transaction((tx) => [...])：需要真执行的事务形参。
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

  const rowsFor = async (userId: number) => {
    const statement = recentInformativeFeedbackForUserQuery(tag as never, userId) as unknown as { text: string; params: unknown[] };
    return (await pg.query(statement.text, statement.params)).rows;
  };
  const withdrawnFor = async (userId: number) => {
    const statement = withdrawnFeedbackBookTitlesForUserQuery(tag as never, userId) as unknown as { text: string; params: unknown[] };
    return (await pg.query(statement.text, statement.params)).rows.map((row) => row.title);
  };
  const book = async (title: string, author = '审查作者') =>
    ((await pg.query('INSERT INTO books (title, author) VALUES ($1, $2) RETURNING id', [title, author])).rows[0] as { id: number }).id;
  const feedback = async (userId: number, bookId: number, status: string, note: string) =>
    pg.query('INSERT INTO feedback (user_id, book_id, status, note) VALUES ($1, $2, $3, $4)', [userId, bookId, status, note]);

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users SELECT generate_series(1, 5)');
    await initializeBusinessSchema(tag as never);
  }, 60_000);

  it('撤回/更改反馈取最新状态：最新一行非 done/dropped 或 note 空时，历史那条不再入选', async () => {
    const withdrawn = await book('撤回审查');
    await feedback(1, withdrawn, 'done', '讨厌机械降神');
    await feedback(1, withdrawn, 'reading', ''); // 用户改口：撤回读后反馈
    expect(await rowsFor(1)).toEqual([]);

    const cleared = await book('清空原因审查');
    await feedback(1, cleared, 'dropped', '文笔劝退');
    await feedback(1, cleared, 'dropped', ''); // 状态不变但清空了原因
    expect(await rowsFor(1)).toEqual([]);
  });

  it('保留仍有效的反馈：最新一行 done/dropped 且 note 非空', async () => {
    const kept = await book('有效反馈审查');
    await feedback(1, kept, 'dropped', '讨厌机械降神');
    await feedback(1, kept, 'dropped', '讨厌机械降神'); // 重复提交同一状态仍是有效
    expect(await rowsFor(1)).toEqual([{ title: '有效反馈审查', author: '审查作者', status: 'dropped', note: '讨厌机械降神' }]);
  });

  it('严格按 user_id 隔离：另一用户的反馈不进入本用户结果', async () => {
    const other = await book('他人偏好审查');
    await feedback(2, other, 'done', '别人的萌点');
    expect((await rowsFor(1)).some((row) => row.title === '他人偏好审查')).toBe(false);
    expect((await rowsFor(2)).some((row) => row.title === '有效反馈审查')).toBe(false);
    expect(await rowsFor(2)).toEqual([{ title: '他人偏好审查', author: '审查作者', status: 'done', note: '别人的萌点' }]);
  });

  it('撤回标记：只列「曾 informative、最新已非 informative」的书，且只回传书名', async () => {
    // 上面的夹具已构造：撤回审查（done→reading）、清空原因审查（dropped→空 note）。
    // 二者都应出现在 user 1 的撤回清单，且清单里只有 title（旧 note 原文不回传）。
    expect(await withdrawnFor(1)).toEqual(['撤回审查', '清空原因审查']);
    // 仍有效的反馈、以及从未 informative 的书不进撤回清单。
    const plain = await book('从未反馈审查');
    await feedback(1, plain, 'want', '想读');
    expect(await withdrawnFor(1)).not.toContain('从未反馈审查');
    expect(await withdrawnFor(1)).not.toContain('有效反馈审查');
  });

  it('撤回标记严格按 user_id 隔离', async () => {
    const mine = await book('我的撤回审查');
    await feedback(3, mine, 'done', '我的雷点');
    await feedback(3, mine, 'reading', '');
    const others = await book('他人的撤回审查');
    await feedback(4, others, 'done', '别人的雷点');
    await feedback(4, others, 'reading', '');
    expect(await withdrawnFor(3)).toContain('我的撤回审查');
    expect(await withdrawnFor(3)).not.toContain('他人的撤回审查');
    expect(await withdrawnFor(4)).not.toContain('我的撤回审查');
  });
});
