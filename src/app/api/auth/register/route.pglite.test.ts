import { beforeAll, describe, expect, it } from 'vitest';
import { initializeAuthSchema } from '@/lib/auth-store';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { hashInviteCode } from '@/lib/invite-codes';
import { buildRegistrationStatement } from '@/lib/register-statement';

// 真实 PostgreSQL（WASM）离线用例：把当前 auth schema 真建出来，再真跑注册语句。
//
// 为什么必须有这一条：本目录的 route.test.ts 全是桩，`claimed: 1` 是 mock 喂的，永远看不见
// 「registration_invites 的 CHECK ((used_by IS NULL) = (used_at IS NULL)) 不可延迟」这类
// 真库语义。2026-09-17 真库验收抓到：claim 只置 used_at、靠第二条语句回填 used_by 的写法
// 会让整条注册语句抛 23514，邀请码注册 100% 失败，而全部桩测试都是绿的。
//
// PGlite 是 devDependency（package.json 钉死 ^0.5.8）；缺依赖由 loadPGlite 抛错硬失败，
// 只有在显式设了 NF_PGLITE_OPTIONAL=1 时才会走到 describe.skip。见 lib/fixtures/pglite.ts。

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

// 标签模板 → ($n, params)；并把 transaction 包成真事务，形状与 Neon 的非交互事务一致。
function adapt(pg: PGliteLike) {
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return { text, params };
  }) as SqlTag;
  const transaction = async (builder: (tag: SqlTag) => { text: string; params: unknown[] }[]) => {
    const statements = builder(tag);
    await pg.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push((await pg.query(statement.text, statement.params)).rows);
      await pg.exec('COMMIT');
      return results;
    } catch (error) {
      await pg.exec('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  return Object.assign(tag, { transaction }) as unknown as SqlTag & { transaction: typeof transaction };
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('真实 PostgreSQL：注册语句与 registration_invites 的 CHECK', () => {
  let pg: PGliteLike;
  let sql: ReturnType<typeof adapt>;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    sql = adapt(pg);
    // 真的跑迁移，不是为了这条用例手抄一份 DDL。
    await initializeAuthSchema(sql as never);
    const version = await pg.query('SELECT max(version)::int AS version FROM auth_schema_migrations');
    expect(version.rows[0].version).toBe(7);
  }, 60_000);

  async function seedInvite(mode = 'invite') {
    await pg.query('UPDATE auth_settings SET members_enabled = true, registration_mode = $1 WHERE id = 1', [mode]);
    const code = `nf-${Math.random().toString(36).slice(2)}`;
    const hash = hashInviteCode(code);
    await pg.query(
      `INSERT INTO registration_invites (code_hash, code_hint, created_by, expires_at)
       VALUES ($1, $2, 1, now() + interval '7 days')`, [hash, code.slice(-4)],
    );
    return { code, hash };
  }

  it('迁移建出的 registration_invites 真的带着那条不可延迟的 CHECK', async () => {
    const constraint = await pg.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'registration_invites'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%used_by%used_at%'`);
    expect(constraint.rows.map((row) => row.def)).toEqual(['CHECK (((used_by IS NULL) = (used_at IS NULL)))']);
  });

  it('invite 模式：一条语句同时置 used_at 与 used_by，用户/画像/会话一起落库', async () => {
    const { hash } = await seedInvite();
    const results = await sql.transaction((tx) => [buildRegistrationStatement(tx, {
      useInvite: true, codeHash: hash, username: 'reader_one',
      passwordHash: 'scrypt$1$stub', tokenHash: 'a'.repeat(64), ttlSeconds: 3600,
    }) as never]);
    const row = results[0][0] as Record<string, unknown>;
    expect(row.username).toBe('reader_one');
    expect(row.claimed).toBe(1);
    expect(row.can_read).toBe(false);

    const invite = await pg.query('SELECT used_at, used_by, revoked_at FROM registration_invites WHERE code_hash = $1', [hash]);
    expect(invite.rows[0].used_at).not.toBeNull();
    expect(invite.rows[0].used_by).toBe(row.id);

    const user = await pg.query('SELECT id, role, created_via_invite_id, can_find, can_read, can_download FROM users WHERE id = $1', [row.id]);
    expect(user.rows[0]).toMatchObject({ role: 'member', can_find: true, can_read: false, can_download: false });
    const profile = await pg.query('SELECT id FROM profile WHERE id = $1', [row.id]);
    expect(profile.rows).toHaveLength(1);
    const session = await pg.query('SELECT user_id FROM sessions WHERE token_hash = $1', ['a'.repeat(64)]);
    expect(session.rows[0].user_id).toBe(row.id);
  });

  it('同一邀请码第二次注册失败，且不留下第二个用户（权威判定在 claim）', async () => {
    const { hash } = await seedInvite();
    const statement = (tx: SqlTag) => buildRegistrationStatement(tx, {
      useInvite: true, codeHash: hash, username: 'reader_two',
      passwordHash: 'scrypt$1$stub', tokenHash: 'b'.repeat(64), ttlSeconds: 3600,
    }) as never;
    await sql.transaction((tx) => [statement(tx)]);
    const second = await sql.transaction((tx) => [statement(tx)]);
    const row = second[0][0] as Record<string, unknown>;
    expect(row.id).toBeNull();
    expect(row.claimed).toBe(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM users WHERE username = $1', ['reader_two'])).rows[0].n).toBe(1);
  });

  it('open 模式不需要邀请码也能注册（新用户 created_via_invite_id 为空）', async () => {
    await pg.query("UPDATE auth_settings SET members_enabled = true, registration_mode = 'open' WHERE id = 1");
    const results = await sql.transaction((tx) => [buildRegistrationStatement(tx, {
      useInvite: false, codeHash: null, username: 'reader_open',
      passwordHash: 'scrypt$1$stub', tokenHash: 'c'.repeat(64), ttlSeconds: 3600,
    }) as never]);
    const row = results[0][0] as Record<string, unknown>;
    expect(row.username).toBe('reader_open');
    expect(row.claimed).toBe(0);
    const user = await pg.query('SELECT created_via_invite_id FROM users WHERE id = $1', [row.id]);
    expect(user.rows[0].created_via_invite_id).toBeNull();
  });

  it('关闭模式下不带码、带码都注册不了，也不消耗邀请码', async () => {
    const { hash } = await seedInvite('closed');
    const results = await sql.transaction((tx) => [buildRegistrationStatement(tx, {
      useInvite: true, codeHash: hash, username: 'reader_closed',
      passwordHash: 'scrypt$1$stub', tokenHash: 'd'.repeat(64), ttlSeconds: 3600,
    }) as never]);
    const row = results[0][0] as Record<string, unknown>;
    expect(row.id).toBeNull();
    expect(row.claimed).toBe(0);
    expect(row.registration_mode).toBe('closed');
    const invite = await pg.query('SELECT used_at FROM registration_invites WHERE code_hash = $1', [hash]);
    expect(invite.rows[0].used_at).toBeNull();
  });

  it('正对照：把两列拆回两条语句，CHECK 立刻拒绝（这就是线上 100% 失败的原因）', async () => {
    const { hash } = await seedInvite();
    await pg.exec('BEGIN');
    await expect((async () => {
      await pg.query('UPDATE registration_invites SET used_at = now() WHERE code_hash = $1', [hash]);
      await pg.query('SELECT 1'); // 语句边界：CHECK 在第一条语句结束时就已判定
    })()).rejects.toMatchObject({ code: '23514' });
    await pg.exec('ROLLBACK');
    // 回滚后邀请码仍可用：失败不会半消费。
    const invite = await pg.query('SELECT used_at, used_by FROM registration_invites WHERE code_hash = $1', [hash]);
    expect(invite.rows[0]).toMatchObject({ used_at: null, used_by: null });
  });

  // 设计 §4.3「同码并发最多一人成功」的结构性前提。
  //
  // 为什么不测真并发：PGlite 是**单个 WASM Postgres + 单连接**，没有第二个连接就没有行锁竞争。
  // 实测（2026-09-17，见 task-78-hardening-report.md）：两个 PGlite 实例指向同一个 dataDir 时
  // 各自加载成**互不可见的独立库**——B 写入 42 后 A 查到 `[]`；B 关闭落盘后把 A 的写入整个覆盖，
  // 新实例只看到 B 的数据。也就是说实例之间既不共享缓冲区也不共享锁管理器，dataDir 是「最后落盘者赢」。
  // 因此 PGlite 上**造不出**有意义的并发用例，硬凑只会得到一个假并发。
  //
  // 能严格验证的是使并发安全的**结构**：整条注册是**一条**语句 ⇒ PostgreSQL 不会在「消费」与
  // 「插用户」之间给别的会话留出插入点；消费（UPDATE ... RETURNING）在文本上先于插用户；
  // 两列在同一次 UPDATE 内置位，且 claim 与 INSERT 用的是**同一个**预分配 userId。
  // 并发下第二个事务会阻塞在邀请码行锁上，解锁后看到 used_at IS NOT NULL ⇒ claim 零行 ⇒
  // INSERT 被 EXISTS (SELECT 1 FROM claim) 挡掉。真并发下的行为只能由 Neon 上的验收覆盖。
  it('并发安全的结构性前提：单语句、消费先于插用户、claim 与 INSERT 共用同一个 userId', () => {
    const recorded: { text: string; params: unknown[] }[] = [];
    const recordingTag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      let text = '';
      const params: unknown[] = [];
      parts.forEach((part, index) => {
        text += part;
        if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
      });
      const query = { text, params };
      recorded.push(query);
      return query;
    }) as SqlTag;
    buildRegistrationStatement(recordingTag, {
      useInvite: true, codeHash: 'hash-of-some-code', username: 'reader_conc',
      passwordHash: 'scrypt$1$stub', tokenHash: 'e'.repeat(64), ttlSeconds: 3600,
    });

    // 1) 只有一条语句：中间态不对其它会话可见，这是「同码并发最多一人成功」的前提。
    expect(recorded).toHaveLength(1);
    const { text, params } = recorded[0];

    // 2) 两列由同一次 UPDATE 同时置位，且 used_by 直接取预分配的 new_id（不是事后回填）。
    expect(text).toContain('SET used_at = now(), used_by = (SELECT id FROM new_id)');
    // 3) 消费在文本上先于插用户；消费就是权威判定。
    expect(text.indexOf('UPDATE registration_invites')).toBeGreaterThan(-1);
    expect(text.indexOf('UPDATE registration_invites')).toBeLessThan(text.indexOf('INSERT INTO users'));
    // 4) 插用户用**同一个** new_id，且邀请码列取 claim 的返回行——两张表不允许各自判资格。
    expect(text).toContain('INSERT INTO users (id, username, password_hash, role, created_via_invite_id)');
    expect(text).toContain('SELECT (SELECT id FROM new_id)');
    expect(text).toContain('(SELECT id FROM claim)');
    // 5) 并发下第二个事务拿到零行 claim 时，INSERT 必须被挡住（invite 模式的唯一放行条件）。
    expect(text).toContain("AND ((SELECT registration_mode FROM cfg) = 'open' OR EXISTS (SELECT 1 FROM claim))");
    // 6) claim 必须挂在 gate 上，并且 new_id 为空时不允许消费（避免消费了却没有用户）。
    expect(text).toContain('AND EXISTS (SELECT 1 FROM gate)');
    expect(text).toContain('AND (SELECT id FROM new_id) IS NOT NULL');
    // useInvite 作为参数化布尔下发，true 时才可能消费。
    expect(params).toContain(true);
  });

  it('串行交错下的行为：第二次用同一码注册被 claim 挡在插用户之前（真并发见上一条注释）', async () => {
    const { hash } = await seedInvite();
    const first = await sql.transaction((tx) => [buildRegistrationStatement(tx, {
      useInvite: true, codeHash: hash, username: 'conc_first',
      passwordHash: 'scrypt$1$stub', tokenHash: 'f'.repeat(64), ttlSeconds: 3600,
    }) as never]);
    expect((first[0][0] as Record<string, unknown>).claimed).toBe(1);

    const second = await sql.transaction((tx) => [buildRegistrationStatement(tx, {
      useInvite: true, codeHash: hash, username: 'conc_second',
      passwordHash: 'scrypt$1$stub', tokenHash: 'g'.repeat(64), ttlSeconds: 3600,
    }) as never]);
    const row = second[0][0] as Record<string, unknown>;
    // claim 零行 ⇒ id 为空，且第二个用户、会话一个都没落库。
    expect(row.claimed).toBe(0);
    expect(row.id).toBeNull();
    expect((await pg.query("SELECT count(*)::int AS n FROM users WHERE username = 'conc_second'")).rows[0].n).toBe(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1', ['g'.repeat(64)])).rows[0].n).toBe(0);
  });
});
