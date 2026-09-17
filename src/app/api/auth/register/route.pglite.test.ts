import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeAuthSchema } from '@/lib/auth-store';
import { hashInviteCode } from '@/lib/invite-codes';
import { buildRegistrationStatement } from '@/lib/register-statement';

// 真实 PostgreSQL（WASM）离线用例：把 auth schema v6 真建出来，再真跑注册语句。
//
// 为什么必须有这一条：本目录的 route.test.ts 全是桩，`claimed: 1` 是 mock 喂的，永远看不见
// 「registration_invites 的 CHECK ((used_by IS NULL) = (used_at IS NULL)) 不可延迟」这类
// 真库语义。2026-09-17 真库验收抓到：claim 只置 used_at、靠第二条语句回填 used_by 的写法
// 会让整条注册语句抛 23514，邀请码注册 100% 失败，而全部桩测试都是绿的。
//
// PGlite 不在 package.json 依赖里（本仓先例见 ../.t62-pglite 的 scratch 工程）。
// 解析不到时本文件显式 skip，不假装通过——跳过会打印原因。

type PGliteLike = {
  exec(sql: string): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
};

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => { text: string; params: unknown[] };

const CANDIDATES = [
  '@electric-sql/pglite',
  ...['.t62-pglite', '.t78-pglite'].map((dir) =>
    pathToFileURL(resolve(process.cwd(), '..', dir, 'node_modules/@electric-sql/pglite/dist/index.js')).href),
];

let PGliteCtor: (new () => PGliteLike) | null = null;
let skippedBecause = '';
for (const candidate of CANDIDATES) {
  if (candidate.startsWith('file:') && !existsSync(new URL(candidate))) continue;
  try {
    const mod = await import(/* @vite-ignore */ candidate) as { PGlite: new () => PGliteLike };
    PGliteCtor = mod.PGlite;
    break;
  } catch (error) {
    skippedBecause = error instanceof Error ? error.message : String(error);
  }
}
if (!PGliteCtor) {
  console.warn(`[register.pglite] 跳过真实数据库用例：解析不到 @electric-sql/pglite（${skippedBecause}）`);
}

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
    expect(version.rows[0].version).toBe(6);
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
});
