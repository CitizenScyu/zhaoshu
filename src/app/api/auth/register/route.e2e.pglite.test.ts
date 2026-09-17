import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 端到端真库用例：真的 POST 到路由处理器，SQL 真的打到 PostgreSQL（WASM）上。
//
// 与 route.pglite.test.ts 的分工：
//  - route.pglite.test.ts 直接跑 buildRegistrationStatement，钉住「单语句同时置两列」的 SQL 语义。
//  - 本文件跑完整的 POST（限速 / 校验 / 事务 / 结果解包 / 错误码映射 / Cookie），
//    用来抓桩测试永远抓不到的东西——尤其是**真实的约束名**：
//    「重名 → 409 USERNAME_TAKEN」依赖 error.constraint === 'users_username_key'，
//    这个名字是 PostgreSQL 从 `username text NOT NULL UNIQUE` 生成的，桩里写什么都行，
//    只有真库能证明它没写错。
//
// PGlite 不在 package.json 依赖里（先例见 ../.t62-pglite）。解析不到时显式 skip 并打印原因。

type PGliteLike = {
  exec(sql: string): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
};

type QueryLike = { text: string; params: unknown[]; then: (a: unknown, b: unknown) => Promise<unknown> };

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
  console.warn(`[register.e2e.pglite] 跳过端到端真库用例：解析不到 @electric-sql/pglite（${skippedBecause}）`);
}

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  ensureAuthSchema: vi.fn(),
  cleanupExpiredAuthRows: vi.fn(),
  hashPassword: vi.fn(),
}));

vi.mock('@/lib/db', async (original) => ({
  ...await original<typeof import('@/lib/db')>(),
  getSql: mocks.getSql,
}));
vi.mock('@/lib/auth-session', async (original) => ({
  ...await original<typeof import('@/lib/auth-session')>(),
  ensureAuthSchema: mocks.ensureAuthSchema,
  cleanupExpiredAuthRows: mocks.cleanupExpiredAuthRows,
}));
vi.mock('@/lib/password', async (original) => ({
  ...await original<typeof import('@/lib/password')>(),
  hashPassword: mocks.hashPassword,
}));

import { hashInviteCode } from '@/lib/invite-codes';
import { initializeAuthSchema } from '@/lib/auth-store';
import { hashSessionToken } from '@/lib/auth-session';
import { POST } from './route';

const SECRET = 'register-e2e-secret-0123456789abcdef';
const GOOD_PASSWORD = 'correct horse battery';

type SqlTagLike = ((parts: TemplateStringsArray, ...values: unknown[]) => QueryLike) & {
  transaction: (builder: (tag: SqlTagLike) => QueryLike[]) => Promise<Record<string, unknown>[][]>;
};

// 与 Neon 的 sql 同形：标签模板既能在事务构造器里当查询描述对象读出 .text/.params，
// 也能直接被 await（惰性 thenable，await 时才真正执行）。mock-sql.ts 用的是同一种形状。
function adapt(pg: PGliteLike): SqlTagLike {
  const tag = (parts: TemplateStringsArray, ...values: unknown[]): QueryLike => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return {
      text,
      params,
      then: (a: (rows: Record<string, unknown>[]) => unknown, b: (error: unknown) => unknown) =>
        pg.query(text, params).then((r) => r.rows).then(a, b),
    } as unknown as QueryLike;
  };
  const transaction = async (builder: (t: SqlTagLike) => QueryLike[]) => {
    const statements = builder(tag as SqlTagLike);
    await pg.exec('BEGIN');
    try {
      const results: Record<string, unknown>[][] = [];
      for (const statement of statements) results.push(await (statement as unknown as Promise<Record<string, unknown>[]>));
      await pg.exec('COMMIT');
      return results;
    } catch (error) {
      await pg.exec('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  return Object.assign(tag, { transaction }) as unknown as SqlTagLike;
}

const maybe = PGliteCtor ? describe : describe.skip;
let pg: PGliteLike;
let sql: ReturnType<typeof adapt>;
let requestSeq = 0;

function post(body: unknown) {
  // 每个请求给一个不同的来源 IP：REGISTER_SOURCE_RATE_LIMIT 是同一来源 5 次/小时，
  // 用例数量会撞上它，撞上就变成「测限速」而不是「测注册」。
  requestSeq += 1;
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-nf-csrf': '1',
      origin: 'http://localhost',
      'x-forwarded-for': `203.0.113.${requestSeq}`,
    },
    body: JSON.stringify(body),
  });
}

async function seedInvite(mode = 'invite') {
  await pg.query('UPDATE auth_settings SET members_enabled = true, registration_mode = $1 WHERE id = 1', [mode]);
  const code = `nf-${Math.random().toString(36).slice(2)}`;
  await pg.query(
    `INSERT INTO registration_invites (code_hash, code_hint, created_by, expires_at)
     VALUES ($1, $2, 1, now() + interval '7 days')`, [hashInviteCode(code), code.slice(-4)],
  );
  return code;
}

maybe('端到端：真库上的 POST /api/auth/register', () => {
  beforeAll(async () => {
    pg = new PGliteCtor!();
    sql = adapt(pg);
    await initializeAuthSchema(sql as never);
  }, 60_000);

  afterAll(async () => { await pg?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
    vi.stubEnv('NODE_ENV', 'test');
    mocks.getSql.mockReturnValue(sql);
    mocks.ensureAuthSchema.mockImplementation(async () => { await initializeAuthSchema(sql as never); });
    mocks.cleanupExpiredAuthRows.mockResolvedValue(undefined);
    mocks.hashPassword.mockResolvedValue('scrypt$1$stub');
  });

  it('invite + 有效码 → 201，且邀请码真的被消费（used_at/used_by 同时置位）', async () => {
    const code = await seedInvite();
    const res = await POST(post({ username: 'e2e_reader', password: GOOD_PASSWORD, inviteCode: code }));
    expect(res.status).toBe(201);
    const payload = await res.json() as { user: { id: number; username: string; role: string } };
    expect(payload.user).toMatchObject({ username: 'e2e_reader', role: 'member' });
    expect(res.headers.get('set-cookie')).toContain('nf-dev-session=');

    const invite = await pg.query(
      'SELECT used_at, used_by FROM registration_invites WHERE code_hash = $1', [hashInviteCode(code)]);
    expect(invite.rows[0].used_at).not.toBeNull();
    expect(invite.rows[0].used_by).toBe(payload.user.id);

    const user = await pg.query('SELECT created_via_invite_id FROM users WHERE id = $1', [payload.user.id]);
    expect(user.rows[0].created_via_invite_id).not.toBeNull();
  });

  it('同一邀请码再用 → 403 INVITATION_INVALID（不是 409 用户名占用），且不产生第二个用户', async () => {
    const code = await seedInvite();
    expect((await POST(post({ username: 'e2e_twice_a', password: GOOD_PASSWORD, inviteCode: code }))).status).toBe(201);
    const second = await POST(post({ username: 'e2e_twice_b', password: GOOD_PASSWORD, inviteCode: code }));
    expect(second.status).toBe(403);
    expect((await second.json()).code).toBe('INVITATION_INVALID');
    const count = await pg.query('SELECT count(*)::int AS n FROM users WHERE username = $1', ['e2e_twice_b']);
    expect(count.rows[0].n).toBe(0);
  });

  it('无效邀请码 → 403 INVITATION_INVALID，且报的不是 USERNAME_TAKEN', async () => {
    await seedInvite();
    const res = await POST(post({ username: 'e2e_bad_code', password: GOOD_PASSWORD, inviteCode: 'nf-does-not-exist' }));
    expect(res.status).toBe(403);
    const payload = await res.json() as { code: string };
    expect(payload.code).toBe('INVITATION_INVALID');
    expect(payload.code).not.toBe('USERNAME_TAKEN');
  });

  it('open 模式重名 → 409 USERNAME_TAKEN（证明真实约束名确实是 users_username_key）', async () => {
    await pg.query("UPDATE auth_settings SET members_enabled = true, registration_mode = 'open' WHERE id = 1");
    expect((await POST(post({ username: 'e2e_dup', password: GOOD_PASSWORD }))).status).toBe(201);
    const dup = await POST(post({ username: 'e2e_dup', password: GOOD_PASSWORD }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('USERNAME_TAKEN');
    // 用户名冲突不该留下第二个用户，也不该消费任何邀请码。
    const count = await pg.query('SELECT count(*)::int AS n FROM users WHERE username = $1', ['e2e_dup']);
    expect(count.rows[0].n).toBe(1);
  });

  it('open 模式 → 201，created_via_invite_id 为空且 session 真落库', async () => {
    await pg.query("UPDATE auth_settings SET members_enabled = true, registration_mode = 'open' WHERE id = 1");
    const res = await POST(post({ username: 'e2e_open', password: GOOD_PASSWORD }));
    expect(res.status).toBe(201);
    const payload = await res.json() as { user: { id: number } };
    const user = await pg.query('SELECT created_via_invite_id FROM users WHERE id = $1', [payload.user.id]);
    expect(user.rows[0].created_via_invite_id).toBeNull();
    const sessions = await pg.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [payload.user.id]);
    expect(sessions.rows[0].n).toBe(1);
    // 会话 token 只以摘要形式落库。
    const raw = res.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    const byHash = await pg.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1', [hashSessionToken(raw)]);
    expect(byHash.rows[0].n).toBe(1);
  });
});
