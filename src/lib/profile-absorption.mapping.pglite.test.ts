import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createProductionSchema, seedProductionMembers } from './fixtures/production-schema';
import { enqueueProfileFeedbackForUserQuery } from './user-data';
import type { PersonalWriter } from './personal-write';

const mocks = vi.hoisted(() => ({ sql: null as unknown, model: vi.fn() }));
vi.mock('@neondatabase/serverless', () => ({ neon: () => mocks.sql, neonConfig: {} }));
vi.mock('./db-quota-guard', () => ({ quotaAwareFetch: () => { throw new Error('network forbidden'); } }));
vi.mock('./llm', () => ({ chatRobust: mocks.model, validateProfileContent: (value: string) => value }));
vi.mock('./record-llm-usage', () => ({ recordUsageAfterResponse: () => () => {} }));
vi.mock('./prompts', () => ({
  profileAbsorbSystem: () => '',
  profileAbsorbUser: (_old: string, feedback: string, withdrawn: string[]) => JSON.stringify({ feedback: JSON.parse(feedback), withdrawn }),
}));

type Fragment = { queryData: { strings: readonly string[]; values: unknown[] } };
let pg: PGlite;
function parameterize(fragment: Fragment) {
  let text = '';
  const params: unknown[] = [];
  const add = ({ strings, values }: Fragment['queryData']) => strings.forEach((part, index) => {
    text += part;
    if (index >= values.length) return;
    const value = values[index];
    if (value && typeof value === 'object' && 'queryData' in value) add((value as Fragment).queryData);
    else { params.push(value); text += `$${params.length}`; }
  });
  add(fragment.queryData);
  return { text, params };
}
function tag(strings: TemplateStringsArray, ...values: unknown[]) {
  const fragment = { queryData: { strings, values } };
  let promise: Promise<unknown[]> | undefined;
  return { ...fragment, then(resolve?: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
    const query = parameterize(fragment);
    promise ??= pg.query(query.text, query.params).then(result => result.rows);
    return promise.then(resolve, reject);
  } };
}
async function transaction(build: Fragment[] | ((sql: typeof tag) => Fragment[])) {
  const queries = typeof build === 'function' ? build(tag) : build;
  await pg.exec('BEGIN');
  try {
    const rows: Record<string, unknown>[][] = [];
    for (const fragment of queries) {
      const query = parameterize(fragment);
      rows.push((await pg.query<Record<string, unknown>>(query.text, query.params)).rows);
    }
    await pg.exec('COMMIT');
    return rows;
  } catch (error) { await pg.exec('ROLLBACK'); throw error; }
}
const sql = Object.assign(tag, { transaction });
const write: PersonalWriter = builder => transaction(builder as unknown as (sql: typeof tag) => Fragment[]);
let db: typeof import('./db');
let absorb: typeof import('./profile-absorption');
beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@localhost/synthetic');
  vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
  mocks.sql = sql;
  pg = new PGlite(); await pg.waitReady;
  await createProductionSchema(sql as never, text => pg.exec(text));
  await seedProductionMembers(pg, 8);
  db = await import('./db');
  absorb = await import('./profile-absorption');
  mocks.model.mockResolvedValue({ content: '合成吸收后的画像' });
}, 30_000);
afterAll(async () => { await pg?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function addFeedback(userId: number, title: string, status = 'done', note = '合成偏好') {
  const book = (await pg.query<{ id: number }>('INSERT INTO books(title,author) VALUES($1,$2) RETURNING id', [title, '合成作者'])).rows[0].id;
  const id = (await pg.query<{ id: number }>('INSERT INTO feedback(user_id,book_id,status,note) VALUES($1,$2,$3,$4) RETURNING id', [userId, book, status, note])).rows[0].id;
  return { book, id };
}

describe('真实SQL行经db封装到反馈吸收服务', () => {
  it('60条反馈分50+10两轮推进，第三轮不重复处理', async () => {
    await pg.query("INSERT INTO profile(id,content) VALUES(2,'合成原画像')");
    const ids: number[] = [];
    for (let i = 1; i <= 60; i++) ids.push((await addFeedback(2, `合成书${i}`)).id);
    await enqueueProfileFeedbackForUserQuery(sql as never, 2, 0, true);
    const firstRows = await db.getProfileFeedbackForUser(2);
    expect(firstRows).toHaveLength(50);
    expect(firstRows[49].feedbackId).toBe(ids[49]);
    expect(firstRows[0]).not.toHaveProperty('feedback_id');
    const round = (token: string) => absorb.absorbPendingProfileFeedback({
      userId: 2, leaseToken: token, write, signal: new AbortController().signal, modelBudgetMs: 60000,
    });
    expect(await round('synthetic-first')).toMatchObject({ status: 'pending', pendingFeedbackId: ids[59] });
    expect(await db.getProfileFeedbackQueueForUser(2)).toMatchObject({ absorbedFeedbackId: ids[49], pendingFeedbackId: ids[59] });
    expect(await db.getProfileFeedbackForUser(2, ids[49])).toHaveLength(10);
    expect(await round('synthetic-second')).toMatchObject({ status: 'unchanged', pendingFeedbackId: null });
    expect(await db.getProfileFeedbackQueueForUser(2)).toMatchObject({ absorbedFeedbackId: ids[59], pendingFeedbackId: null });
    await round('synthetic-third');
    expect(mocks.model).toHaveBeenCalledTimes(2);
    const batches = mocks.model.mock.calls.map(([, user]) => JSON.parse(user).feedback as { title: string; feedbackId?: number }[]);
    expect(batches.map(batch => batch.length)).toEqual([50, 10]);
    expect(new Set(batches.flat().map(row => row.title)).size).toBe(60);
    expect(batches.flat().every(row => row.feedbackId === undefined)).toBe(true);
  });

  it('撤回查询同样在db边界映射id，模型投影不含内部水位', async () => {
    const { book } = await addFeedback(3, '合成撤回书');
    const withdrawal = (await pg.query<{ id: number }>("INSERT INTO feedback(user_id,book_id,status,note) VALUES(3,$1,'reading','') RETURNING id", [book])).rows[0].id;
    expect(await db.getWithdrawnFeedbackBookTitlesForUserRaw(3)).toEqual([{ title: '合成撤回书', feedbackId: withdrawal }]);
    expect(await db.getWithdrawnFeedbackBookTitlesForUser(3)).toEqual(['合成撤回书']);
  });

  it.each([
    { userId: 4, informative: 60, withdrawn: 1, tail: false, expected: [[50, 0], [10, 1]] },
    { userId: 5, informative: 60, withdrawn: 60, tail: false, expected: [[50, 0], [10, 50], [0, 10]] },
    { userId: 6, informative: 0, withdrawn: 60, tail: false, expected: [[0, 50], [0, 10]] },
    { userId: 7, informative: 50, withdrawn: 0, tail: true, expected: [[50, 0]] },
    { userId: 8, informative: 0, withdrawn: 50, tail: true, expected: [[0, 50]] },
  ])('混合安全前缀 $informative 条有效/$withdrawn 条撤回，尾部清理=$tail', async ({ userId, informative, withdrawn, tail, expected }) => {
    mocks.model.mockClear();
    await pg.query('INSERT INTO profile(id,content) VALUES($1,$2)', [userId, '合成原画像']);
    const events: { id: number; title: string; kind: 'feedback' | 'withdrawn' }[] = [];
    for (let i = 0; i < informative; i++) {
      const title = `用户${userId}有效${i}`;
      const { id } = await addFeedback(userId, title);
      events.push({ id, title, kind: 'feedback' });
    }
    for (let i = 0; i < withdrawn; i++) {
      const title = `用户${userId}撤回${i}`;
      const { book } = await addFeedback(userId, title);
      const id = (await pg.query<{ id: number }>("INSERT INTO feedback(user_id,book_id,status,note) VALUES($1,$2,'reading','') RETURNING id", [userId, book])).rows[0].id;
      events.push({ id, title, kind: 'withdrawn' });
    }
    if (tail) await addFeedback(userId, `用户${userId}无信息尾部`, 'want', '');
    await enqueueProfileFeedbackForUserQuery(sql as never, userId, 0, true);
    const seen = new Set<string>();
    let rounds = 0;
    while ((await db.getProfileFeedbackQueueForUser(userId))?.pendingFeedbackId != null) {
      expect(++rounds).toBeLessThanOrEqual(4);
      const beforeCalls = mocks.model.mock.calls.length;
      await absorb.absorbPendingProfileFeedback({ userId, leaseToken: `synthetic-${userId}-${rounds}`,
        write, signal: new AbortController().signal, modelBudgetMs: 60000 });
      if (mocks.model.mock.calls.length > beforeCalls) {
        const input = JSON.parse(mocks.model.mock.calls.at(-1)![1]) as { feedback: { title: string }[]; withdrawn: string[] };
        for (const title of [...input.feedback.map(row => row.title), ...input.withdrawn]) {
          expect(seen.has(title)).toBe(false);
          seen.add(title);
        }
      }
      const queue = (await db.getProfileFeedbackQueueForUser(userId))!;
      // 每轮已推进的任何当前有效事件，都必须已经真正进入模型输入。
      for (const event of events.filter(event => event.id <= queue.absorbedFeedbackId)) expect(seen.has(event.title)).toBe(true);
    }
    expect(seen.size).toBe(events.length);
    expect(mocks.model.mock.calls.map(([, user]) => {
      const input = JSON.parse(user); return [input.feedback.length, input.withdrawn.length];
    })).toEqual(expected);
    if (tail) expect(rounds).toBe(2); // 空查询尾部推进candidate，不再调用模型。
    // 重建默认全量撤回口径不被异步afterId改变；带已提交水位则没有待办撤回。
    expect(await db.getWithdrawnFeedbackBookTitlesForUserRaw(userId)).toHaveLength(Math.min(withdrawn, 50));
    expect(await db.getWithdrawnFeedbackBookTitlesForUserRaw(userId,
      (await db.getProfileFeedbackQueueForUser(userId))!.absorbedFeedbackId)).toEqual([]);
  });
});
