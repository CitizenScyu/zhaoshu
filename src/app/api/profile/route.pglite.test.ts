import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { recentInformativeFeedbackForUserQuery, withdrawnFeedbackBookTitlesForUserQuery } from '@/lib/user-data';

// 真实 PostgreSQL（WASM）+ 真实路由：F04 的 P1-2。
//
// 桩测试的 route.test.ts 直接 mock `getProfileFeedbackForUser` 的返回值——那测的是
// 「路由把 mock 返回值原样序列化」，不是「两条同书反馈、后一条撤回后 SQL 取哪条」。
// 这里**独立构造两条同书反馈行**（先 done+note，再撤回），只 mock 网络/画像读写，
// 反馈与撤回清单两条查询走真 SQL、真参数，由路由消费。

const mocks = vi.hoisted(() => ({
  getProfileForUser: vi.fn(), saveProfileForUser: vi.fn(), getFeedbackSnapshotForUser: vi.fn(),
  chatRobust: vi.fn(), getSql: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getSql: mocks.getSql,
  getProfileForUser: mocks.getProfileForUser,
  saveProfileForUser: mocks.saveProfileForUser,
  getFeedbackSnapshotForUser: mocks.getFeedbackSnapshotForUser,
  // 真 SQL：路由拿到的就是查询结果，而不是手写 fixture。
  getProfileFeedbackForUser: async (userId: number) => {
    const statement = recentInformativeFeedbackForUserQuery(mocks.getSql() as never, userId) as unknown as { text: string; params: unknown[] };
    return (await pg.query(statement.text, statement.params)).rows;
  },
  getWithdrawnFeedbackBookTitlesForUser: async (userId: number) => {
    const statement = withdrawnFeedbackBookTitlesForUserQuery(mocks.getSql() as never, userId) as unknown as { text: string; params: unknown[] };
    return (await pg.query(statement.text, statement.params)).rows.map((row) => row.title as string);
  },
  // F15：重建成功后推进反馈吸收水位——真 SQL，走真表。
  getMaxFeedbackIdForUser: async (userId: number) =>
    ((await pg.query('SELECT COALESCE(max(id), 0)::int AS max_id FROM feedback WHERE user_id = $1', [userId])).rows[0] as { max_id: number }).max_id,
  markProfileFeedbackAbsorbedForUser: async (userId: number, candidate: number) => {
    await pg.query(`UPDATE profile_feedback_queue
      SET absorbed_feedback_id = GREATEST(absorbed_feedback_id, $2),
          pending_feedback_id = CASE WHEN pending_feedback_id IS NOT NULL AND pending_feedback_id <= $2 THEN NULL ELSE pending_feedback_id END,
          updated_at = now()
      WHERE user_id = $1`, [userId, candidate]);
    return null;
  },
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: async (...args: unknown[]) => ({ content: await mocks.chatRobust(...args) }),
}));

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };
type Statement = { text: string; params: unknown[] };

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

let pg: PGliteLike;

maybe('真实 PostgreSQL：F04 撤回信号经过真实路由（P1-2）', () => {
  let imported: typeof import('./route');

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
  const tag = Object.assign(baseTag, {
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

  const seeds = [{ title: '种子书', author: '作者', kind: 'love' }];
  const version = '2026-09-15 00:00:00.123456+00';

  const book = async (title: string) =>
    ((await pg.query('INSERT INTO books (title, author) VALUES ($1, $2) RETURNING id', [title, '审查作者'])).rows[0] as { id: number }).id;
  const feedback = async (userId: number, bookId: number, status: string, note: string) =>
    pg.query('INSERT INTO feedback (user_id, book_id, status, note) VALUES ($1, $2, $3, $4)', [userId, bookId, status, note]);

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users SELECT generate_series(1, 5)');
    await initializeBusinessSchema(tag as never);
    // 书 A：历史 done+note（旧偏好），最新一行撤回（reading）。
    const withdrawn = await book('撤回书 A');
    await feedback(1, withdrawn, 'done', '过时的雷点X');
    await feedback(1, withdrawn, 'reading', '');
    // 书 B：最新一行仍有效。
    const kept = await book('有效书 B');
    await feedback(1, kept, 'dropped', '仍有效的萌点Y');
    // 书 C：从未 informative（只有 want），不算撤回。
    const plain = await book('未反馈书 C');
    await feedback(1, plain, 'want', '想读');
    // 另一用户的撤回，必须隔离。
    const other = await book('他人撤回书 D');
    await feedback(2, other, 'done', '别人的雷点Z');
    await feedback(2, other, 'reading', '');

    imported = await import('./route');
  }, 60_000);

  beforeEach(() => {
    mocks.chatRobust.mockReset();
    mocks.chatRobust.mockResolvedValue('重建后的画像');
    mocks.getSql.mockReturnValue(tag);
    mocks.getProfileForUser.mockResolvedValue({ seeds, content: '旧画像：反馈独有偏好', updatedAt: version });
    mocks.saveProfileForUser.mockResolvedValue('v2');
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 0, status: null, note: '' });
    vi.stubEnv('APP_OWNER_TOKEN', 'pglite-profile-owner');
  });

  async function generate() {
    const response = await imported.POST(new NextRequest('http://localhost/api/profile', {
      method: 'POST', headers: { Authorization: 'Bearer pglite-profile-owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt: version }),
    }));
    expect(response.status).toBe(200);
    await response.text();
    return mocks.chatRobust.mock.calls[0][1] as string;
  }

  it('两条同书反馈先 informative 后撤回：撤回书名作为信号喂入，旧 note 原文不回喂', async () => {
    const input = await generate();
    // 有效反馈仍在，且是来自真 SQL 的「最新一行」。
    expect(input).toContain('仍有效的萌点Y');
    expect(input).toContain('有效书 B');
    // 撤回信号：书名 + 撤回语义，且不含旧 note 原文。
    expect(input).toContain('撤回书 A');
    expect(input).toMatch(/已被撤回/);
    expect(input).not.toContain('过时的雷点X');
    // 从未 informative 的书不进撤回清单。
    expect(input).not.toContain('未反馈书 C');
  });

  it('跨用户隔离：他人撤回的书不出现在本用户输入', async () => {
    const input = await generate();
    expect(input).not.toContain('他人撤回书 D');
    expect(input).not.toContain('别人的雷点Z');
  });
});
