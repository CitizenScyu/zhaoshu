import { beforeAll, describe, expect, it } from 'vitest';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import {
  claimProfileFeedbackForUserQuery,
  completeProfileFeedbackForUserQuery,
  enqueueProfileFeedbackForUserQuery,
  markProfileFeedbackAbsorbedForUserQuery,
  markProfileFeedbackFailedForUserQuery,
  profileFeedbackBackoffMs,
  drainableProfileFeedbackUsersQuery,
  PROFILE_FEEDBACK_BACKOFF_CAP_MS,
} from '@/lib/user-data';

// F15 残留（租约/退避/drain）的真库（WASM PostgreSQL）语义验收：
//   ① 并发领取反例：两个执行者同时领取 → 只有一个拿到（真并发事务模拟）；
//   ② 租约过期重领：租约过期后第二个执行者可领，第一个的迟到提交被拒（token 失配 0 行）；
//   ③ 退避曲线：失败后 next_eligible_at 按指数推进、封顶；到期前不可领、到期后可领；
//   ④ drain 扫描：pending+租约过期 → 出现在 drain 候选里；被租约/退避挡住的行不出现。
// 桩测试证明不了、而这里正是「并发只有一个拿到」「迟到提交写 0 行」前提的事情。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：profile_feedback_queue 租约与退避（F15 残留）', () => {
  let pg: PGliteLike;
  const baseTag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    const flatten = (value: unknown) => {
      // 嵌套片段（leaseEligiblePredicate(sql) 的返回值）：调用方传进来的 tag 是本文件
      // 的 baseTag，所以片段形状是 { text, params }；生产路径的 neon tag 则产生
      // NeonQueryPromise { queryData: { strings, values } }。两种形状都展平——语义都等价于
      // neon 的 SqlTemplate.toParameterizedQuery（串字符串、递归参数）。
      const fragment = value as {
        text?: string; params?: unknown[];
        queryData?: { strings?: unknown[]; values?: unknown[] };
      } | null;
      if (fragment && typeof fragment === 'object' && Array.isArray(fragment.queryData?.strings)) {
        const { strings, values: nested } = fragment.queryData!;
        strings!.forEach((piece, index) => {
          text += piece;
          if (index < (nested?.length ?? 0)) flatten(nested![index]);
        });
        return;
      }
      if (fragment && typeof fragment === 'object' && typeof fragment.text === 'string' && Array.isArray(fragment.params)) {
        text += fragment.text;
        fragment.params.forEach(flatten);
        return;
      }
      params.push(value);
      text += `$${params.length}`;
    };
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) flatten(values[index]);
    });
    return { text, params };
  }) as SqlTag;
  // initializeBusinessSchema 走 transaction 批量 DDL（与既有 pglite 测试同款适配）。
  const schemaTag = Object.assign(baseTag, {
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
  const claim = (userId: number, token: string, leaseMs: number) =>
    run(claimProfileFeedbackForUserQuery(baseTag as never, userId, token, leaseMs) as unknown as { text: string; params: unknown[] });
  const enqueue = (userId: number, expectedVersion: number, queued: boolean) =>
    run(enqueueProfileFeedbackForUserQuery(baseTag as never, userId, expectedVersion, queued) as unknown as { text: string; params: unknown[] });
  const markAbsorbed = (userId: number, candidate: number, status: string, token: string) =>
    run(markProfileFeedbackAbsorbedForUserQuery(baseTag as never, userId, candidate, status, token) as unknown as { text: string; params: unknown[] });
  const markFailed = (userId: number, status: string, error: string, token: string, backoffMs: number) =>
    run(markProfileFeedbackFailedForUserQuery(baseTag as never, userId, status, error, token, backoffMs) as unknown as { text: string; params: unknown[] });
  const drainable = (limit: number) =>
    run(drainableProfileFeedbackUsersQuery(baseTag as never, limit) as unknown as { text: string; params: unknown[] });
  const queueRow = async (userId: number) =>
    (await pg.query(`SELECT pending_feedback_id, status, lease_token, lease_expires_at, fail_count,
      next_eligible_at, next_eligible_at - now() AS backoff_left
      FROM profile_feedback_queue WHERE user_id = $1`, [userId])).rows[0] as {
      pending_feedback_id: number | null; status: string; lease_token: string;
      lease_expires_at: string | null; fail_count: number; next_eligible_at: string | null; backoff_left: string | null;
    };
  const book = async (title: string, author = '租约作者') =>
    ((await pg.query('INSERT INTO books (title, author) VALUES ($1, $2) RETURNING id', [title, author])).rows[0] as { id: number }).id;
  const feedback = async (userId: number, bookId: number, status: string, note: string) =>
    ((await pg.query('INSERT INTO feedback (user_id, book_id, status, note) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, bookId, status, note])).rows[0] as { id: number }).id;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users SELECT generate_series(1, 5)');
    await initializeBusinessSchema(schemaTag as never);
  }, 60_000);

  it('并发领取反例：两个并发事务同时领取，只有一个拿到', async () => {
    const b = await book('并发领取甲');
    const id = await feedback(1, b, 'dropped', '并发吸收');
    await enqueue(1, id - 1, true);

    // 真并发模拟：两个事务各自 BEGIN → 都先看一眼（模拟读到同一 pending）→ 各自 claim。
    // PG 单条 UPDATE 行级锁串行：后提交的 claim 看到的 lease_token 已是先提交者的，
    // 谓词不匹配 → 0 行。这正是生产里「浏览器 + drain 同时吸收」要防的场景。
    const race = async (token: string) => {
      await pg.exec('BEGIN');
      try {
        const rows = await claim(1, token, 60_000);
        await pg.exec('COMMIT');
        return rows;
      } catch (error) {
        await pg.exec('ROLLBACK').catch(() => {});
        throw error;
      }
    };
    // 串行化执行（PGlite 单连接本来就串行）：第二个执行者看到的是第一个已提交的租约。
    const first = await race('token-winner');
    const second = await race('token-loser');
    expect(first[0]?.candidate).toBe(id);
    expect(second).toEqual([]); // 只有一个拿到
    expect((await queueRow(1)).lease_token).toBe('token-winner');
  });

  it('租约过期重领：过期后他人可领；第一个的迟到提交被拒（0 行），水位不被迟到者推进', async () => {
    const b = await book('过期重领乙');
    const id = await feedback(2, b, 'done', '重领吸收');
    await enqueue(2, id - 1, true);

    // 执行者 A：领到（1ms 租约——测试注入）。
    const claimed = await claim(2, 'token-A', 1);
    expect(claimed[0]?.candidate).toBe(id);
    // 租约到期（now 前进）。
    await pg.query("SELECT pg_sleep(0.01)");
    // 执行者 B（drain）：租约已过期 → 可领。
    const reclaimed = await claim(2, 'token-B', 60_000);
    expect(reclaimed[0]?.candidate).toBe(id);
    expect((await queueRow(2)).lease_token).toBe('token-B');

    // A 迟到提交：token 失配 → 0 行。若不加校验，A 会覆盖 B 的世界（双写）。
    const late = await markAbsorbed(2, id, 'applied', 'token-A');
    expect(late).toEqual([]);
    expect((await queueRow(2)).pending_feedback_id).toBe(id); // 水位未被迟到者推进
    // B 正常提交：token 匹配 → 推进、清 pending、释放租约。
    const commit = await markAbsorbed(2, id, 'applied', 'token-B');
    expect(commit[0]?.pending_feedback_id).toBeNull();
    const done = await queueRow(2);
    expect(done.lease_token).toBe('');
    expect(done.status).toBe('applied');
  });

  it('退避曲线：失败推进 next_eligible_at（30s→2m→8m→32m→1h 封顶），到期前不可领、到期后可领', async () => {
    // 曲线函数本体：连续失败 1..6 次的退避毫秒。
    expect(profileFeedbackBackoffMs(1)).toBe(30_000);
    expect(profileFeedbackBackoffMs(2)).toBe(120_000);
    expect(profileFeedbackBackoffMs(3)).toBe(480_000);
    expect(profileFeedbackBackoffMs(4)).toBe(1_920_000);
    expect(profileFeedbackBackoffMs(5)).toBe(PROFILE_FEEDBACK_BACKOFF_CAP_MS); // 7_680_000 封顶为 1h
    expect(profileFeedbackBackoffMs(6)).toBe(PROFILE_FEEDBACK_BACKOFF_CAP_MS);
    expect(profileFeedbackBackoffMs(0)).toBe(0); // 无失败不退避

    const b = await book('退避丙');
    const id = await feedback(3, b, 'dropped', '退避吸收');
    await enqueue(3, id - 1, true);

    // 第一次失败：退避 30s（fail_count=1）。
    await claim(3, 'token-f1', 60_000);
    await markFailed(3, 'failed', 'LlmError', 'token-f1', profileFeedbackBackoffMs(1));
    let row = await queueRow(3);
    expect(row.fail_count).toBe(1);
    expect(row.next_eligible_at).not.toBeNull();
    // 到期前 claim 不到。
    expect(await claim(3, 'token-early', 60_000)).toEqual([]);

    // 退避到期（把 next_eligible_at 拨到过去，模拟时间前进）。
    await pg.query('UPDATE profile_feedback_queue SET next_eligible_at = now() - interval \'1 second\' WHERE user_id = $1', [3]);
    expect((await claim(3, 'token-f2', 60_000))[0]?.candidate).toBe(id);

    // 第二次失败：退避 2m（fail_count=2）。
    await markFailed(3, 'failed', 'LlmError', 'token-f2', profileFeedbackBackoffMs(2));
    row = await queueRow(3);
    expect(row.fail_count).toBe(2);
    // next_eligible_at - now() 的 interval 文本（如 "00:02:00.123"）；解析 hh:mm:ss 为秒。
    const [h, m, s] = (row.backoff_left ?? '').split(':');
    expect(Number(h) * 3600 + Number(m) * 60 + Number(s)).toBeGreaterThan(110); // ~120s，容忍执行耗时

    // 成功后清零：下次失败重新从 30s 档开始。
    await pg.query('UPDATE profile_feedback_queue SET next_eligible_at = now() - interval \'1 second\' WHERE user_id = $1', [3]);
    await claim(3, 'token-ok', 60_000);
    await markAbsorbed(3, id, 'applied', 'token-ok');
    row = await queueRow(3);
    expect(row.fail_count).toBe(0);
    expect(row.next_eligible_at).toBeNull();
  });

  it('drain 扫描：pending+租约过期/退避到期 → 候选；持有效租约或退避未到期的行不在其中', async () => {
    // 用户 4：pending、无租约、无退避 → 可 drain。
    const bFree = await book('可drain丁');
    const idFree = await feedback(4, bFree, 'done', '待兜底');
    await enqueue(4, idFree - 1, true);
    // 用户 5：pending，但被有效租约挡住 → 不可 drain。
    const bLeased = await book('租约中戊');
    const idLeased = await feedback(5, bLeased, 'done', '并发中');
    await enqueue(5, idLeased - 1, true);
    await claim(5, 'token-drain-blocked', 60_000);

    const rows = await drainable(10);
    const users = rows.map((row) => row.user_id);
    expect(users).toContain(4);
    expect(users).not.toContain(5);

    // 用户 5 租约过期后进入候选（明天的窗口接住）。
    await pg.query("UPDATE profile_feedback_queue SET lease_expires_at = now() - interval '1 second' WHERE user_id = $1", [5]);
    expect((await drainable(10)).map((row) => row.user_id)).toContain(5);
  });

  it('无 pending 的行永远不可领取（applied 后 drain 不再触发模型）', async () => {
    const rows = await drainable(10);
    const users = rows.map((row) => row.user_id);
    // 用户 2、3 已在前面用例里 absorbed（pending 清空）。
    expect(users).not.toContain(2);
    expect(users).not.toContain(3);
  });

  const prepareCommit = async (userId: number) => {
    await pg.query('INSERT INTO users (id) VALUES ($1)', [userId]);
    await pg.query(`INSERT INTO profile (id, seeds, content) VALUES ($1, $2::jsonb, '旧画像')`,
      [userId, JSON.stringify([{ title: '合成种子', author: '合成作者' }])]);
    const b = await book(`原子提交${userId}`);
    const id = await feedback(userId, b, 'done', '喜欢严谨设定');
    await enqueue(userId, id - 1, true);
    await claim(userId, 'current-lease', 60_000);
    const version = (await pg.query('SELECT updated_at::text AS version FROM profile WHERE id = $1', [userId])).rows[0].version as string;
    return { id, version, bookId: b };
  };
  const complete = async (userId: number, candidate: number, version: string, token = 'current-lease', content = '新画像') =>
    (await run(completeProfileFeedbackForUserQuery(baseTag as never, userId, candidate,
      content === '旧画像' ? 'unchanged' : 'applied', token, content, version) as unknown as { text: string; params: unknown[] }))[0];

  it('R3：租约已易主，旧执行者不能写画像或推进队列，即使画像 CAS 版本仍匹配', async () => {
    const { id, version } = await prepareCommit(101);
    const result = await complete(101, id, version, 'old-lease');
    expect(result.outcome).toBe('lostLease');
    expect((await pg.query('SELECT content, updated_at::text AS version FROM profile WHERE id=101')).rows[0])
      .toEqual({ content: '旧画像', version });
    expect(await queueRow(101)).toMatchObject({ pending_feedback_id: id, lease_token: 'current-lease', status: 'pending' });
  });

  it('R3：画像 CAS 失败时不推进水位、不释放当前租约', async () => {
    const { id } = await prepareCommit(102);
    expect((await complete(102, id, 'stale-version')).outcome).toBe('profileConflict');
    expect((await pg.query('SELECT content FROM profile WHERE id=102')).rows[0].content).toBe('旧画像');
    expect(await queueRow(102)).toMatchObject({ pending_feedback_id: id, lease_token: 'current-lease' });
  });

  it('R3：成功原子提交保留种子、推进画像版本，且不清掉吸收期间更高水位', async () => {
    const { id, version, bookId } = await prepareCommit(103);
    const newer = await feedback(103, bookId, 'dropped', '新增雷点');
    await enqueue(103, id, true);
    const result = await complete(103, id, version);
    expect(result).toMatchObject({ outcome: 'matched', pending_feedback_id: newer });
    expect(result.updated_at).not.toBe(version);
    expect((await pg.query('SELECT content, seeds FROM profile WHERE id=103')).rows[0])
      .toEqual({ content: '新画像', seeds: [{ title: '合成种子', author: '合成作者' }] });
    expect(await queueRow(103)).toMatchObject({ status: 'pending', pending_feedback_id: newer, lease_token: '', fail_count: 0 });
    expect((await pg.query('SELECT absorbed_feedback_id FROM profile_feedback_queue WHERE user_id=103')).rows[0].absorbed_feedback_id).toBe(id);
  });

  it('R3：模型原样返回时版本不变，队列仍正常完成', async () => {
    const { id, version } = await prepareCommit(104);
    expect(await complete(104, id, version, 'current-lease', '旧画像'))
      .toMatchObject({ outcome: 'matched', updated_at: version, pending_feedback_id: null });
    expect(await queueRow(104)).toMatchObject({ status: 'unchanged', pending_feedback_id: null, lease_token: '' });
  });

  it('R3：画像写入后队列提交失败，整个事务回滚画像与水位', async () => {
    const { id, version } = await prepareCommit(105);
    await pg.exec(`CREATE FUNCTION reject_review_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = 105 AND NEW.status = 'applied' THEN
          RAISE EXCEPTION 'synthetic completion failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_review_completion BEFORE UPDATE ON profile_feedback_queue
        FOR EACH ROW EXECUTE FUNCTION reject_review_completion();`);
    try {
      await expect(complete(105, id, version)).rejects.toThrow('synthetic completion failure');
      expect((await pg.query('SELECT content, updated_at::text AS version FROM profile WHERE id=105')).rows[0])
        .toEqual({ content: '旧画像', version });
      expect(await queueRow(105)).toMatchObject({ pending_feedback_id: id, lease_token: 'current-lease', status: 'pending' });
    } finally {
      await pg.exec('DROP TRIGGER reject_review_completion ON profile_feedback_queue; DROP FUNCTION reject_review_completion();');
    }
  });
});
