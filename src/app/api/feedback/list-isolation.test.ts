import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionRecord } from '@/lib/auth-session';

// feedback-list-contract53：无 title 反馈列表 GET 的可信用户隔离契约（护栏，非已发现漏洞）。
// 与旧覆盖的区别：personal-isolation.test.ts 已钉「匿名/无 find 能力先拒绝」与按书 title 查询；
// route.test.ts 已钉按书 GET 的 author 校验。这里钉的是**成功列表路径**的 SQL 用户绑定：
//   ① 两个不同可信 session 用户各拿各的列表——SQL 的 user_id 绑定值必须是各自可信 ID，
//      请求里伪造的 query userId / X-User-Id header 一概不能替代；
//   ② LIMIT 200 与 ORDER BY id DESC 的形状契约；
//   ③ 反例变体：mock 数据库按「伪造 userId / 任意固定 ID」回数据时测试必须真实失败，
//      证明断言绑定了 SQL 参数而非只比对一次模拟返回对象。
// 身份入口走真实 requirePermission（合成 session 记录拦截 findSessionByToken，
// 与 personal-isolation.test.ts 同款模式），不把权限入口 mock 成无条件放行。
const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  session: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join('?'), values })),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/db')>(),
  ensureSchema: mocks.ensureSchema,
  getSql: mocks.getSql,
  getFeedbackSnapshotForUser: vi.fn(),
  recordFeedbackForUser: vi.fn(),
}));
vi.mock('@/lib/auth-session', async (original) => ({
  ...await original<typeof import('@/lib/auth-session')>(),
  findSessionByToken: mocks.session,
}));

import { GET } from './route';

// 合成双用户：member(2) / member(3)，都带 canFind；伪造身份载体一律指向 userId 999。
function member(userId: number): SessionRecord {
  return {
    userId, username: `member${userId}`, role: 'member', canFind: true, canRead: false, canDownload: false,
    authMethod: 'password', ownerCredentialTag: null, membersEnabled: true,
  };
}
const sessions = new Map<string, SessionRecord>();
// 每用户各自的反馈行（形状 = route SELECT 的投影：f.id/f.status/f.note/f.created_at + b.title/b.author）。
const feedbackRows = new Map<number, { id: number; status: string; note: string; created_at: string; title: string; author: string }[]>();
// 捕获 route 发出的每次列表 SQL（text + values），供逐次绑定断言。
const listQueries: { text: string; values: unknown[] }[] = [];

function listRequest(token: string) {
  return new NextRequest('http://localhost/api/feedback?userId=999', {
    method: 'GET',
    headers: { Cookie: `nf-dev-session=${token}`, 'X-User-Id': '999' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  sessions.clear();
  feedbackRows.clear();
  listQueries.length = 0;
  vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('AUTH_SECURITY_SECRET', 'fixture-security-secret-0123456789abcdef');
  vi.stubEnv('APP_OWNER_TOKEN', 'fixture-owner');
  sessions.set('session-a', member(2));
  sessions.set('session-b', member(3));
  feedbackRows.set(2, [
    { id: 21, status: 'want', note: '用户2的反馈', created_at: '2026-09-01T00:00:00Z', title: '书甲', author: '作者甲' },
  ]);
  feedbackRows.set(3, [
    { id: 33, status: 'read', note: '用户3的反馈', created_at: '2026-09-02T00:00:00Z', title: '书乙', author: '作者乙' },
  ]);
  mocks.session.mockImplementation(async (_sql, token: string) => sessions.get(token) ?? null);
  mocks.ensureSchema.mockResolvedValue(undefined);
  // getSql 返回带 transaction 的 sql 模板函数；route 列表路径直接 await sql`` 不走 transaction，
  // 但 findSessionByToken 无 signal 时也直接 await query——两者共用这个 sql。
  const sql = mocks.sql as unknown as ReturnType<typeof vi.fn>;
  mocks.getSql.mockReturnValue(sql);
  // 默认数据库行为：按 SQL 绑定的 user_id 回该用户的行（模拟真实隔离）。
  sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join('?'), values };
    if (query.text.includes('FROM feedback f JOIN books b')) {
      listQueries.push(query);
      const boundUserId = values[0] as number;
      return feedbackRows.get(boundUserId) ?? [];
    }
    return [];
  });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('无 title 反馈列表 GET 的可信用户隔离（契约护栏）', () => {
  it('两个可信用户各拿各的列表：两次 SQL user_id 逐次绑定 [2]/[3]，伪造 query/header 不生效', async () => {
    const a = await GET(listRequest('session-a'));
    const bodyA = await a.json();
    expect(a.status).toBe(200);
    expect(bodyA.feedback).toHaveLength(1);
    expect(bodyA.feedback[0]).toMatchObject({ id: 21, note: '用户2的反馈' });
    expect(a.headers.get('Cache-Control')).toBe('private, no-store');

    const b = await GET(listRequest('session-b'));
    const bodyB = await b.json();
    expect(b.status).toBe(200);
    expect(bodyB.feedback).toHaveLength(1);
    expect(bodyB.feedback[0]).toMatchObject({ id: 33, note: '用户3的反馈' });

    // 逐次断言两次列表查询的绑定值：各自的可信 ID，绝不是请求里的 999。
    expect(listQueries).toHaveLength(2);
    expect(listQueries[0].values).toEqual([2]);
    expect(listQueries[1].values).toEqual([3]);
    for (const query of listQueries) {
      expect(query.text).toContain('WHERE f.user_id =');
      expect(query.values).not.toContain(999);
    }
  });

  it('LIMIT 200 与降序契约在 SQL 形状里', async () => {
    await GET(listRequest('session-a'));
    expect(listQueries).toHaveLength(1);
    expect(listQueries[0].text).toContain('ORDER BY f.id DESC');
    expect(listQueries[0].text).toContain('LIMIT 200');
    expect(listQueries[0].text).toContain('FROM feedback f JOIN books b ON b.id = f.book_id');
  });

  it('可信用户拿到自己的多行时按投影原样返回（行内容来自绑定用户，不读 owner）', async () => {
    feedbackRows.set(2, [
      { id: 22, status: 'read', note: '用户2第二条', created_at: '2026-09-03T00:00:00Z', title: '书丙', author: '作者丙' },
      { id: 21, status: 'want', note: '用户2第一条', created_at: '2026-09-01T00:00:00Z', title: '书甲', author: '作者甲' },
    ]);
    const a = await GET(listRequest('session-a'));
    const body = await a.json();
    expect(a.status).toBe(200);
    // 行集原样来自绑定用户的返回（顺序由 SQL 保证，mock 按库行序回）——owner(1) 的行不在其中。
    expect(body.feedback).toEqual(feedbackRows.get(2));
    expect(listQueries[0].values).toEqual([2]);
  });
});
