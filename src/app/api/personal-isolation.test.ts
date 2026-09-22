import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionRecord } from '@/lib/auth-session';
import type { ProfileSnapshot } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), session: vi.fn(),
  getProfileForUser: vi.fn(), saveProfileForUser: vi.fn(), recordFeedbackForUser: vi.fn(), getFeedbackSnapshotForUser: vi.fn(),
  getProfileFeedbackForUser: vi.fn(), getWithdrawnFeedbackBookTitlesForUserRaw: vi.fn(),
  getMaxFeedbackIdForUser: vi.fn(), markProfileFeedbackAbsorbedForUser: vi.fn(),
  // F41-F1：重建路径的两个纯函数（实喂上界 min 收敛 + 提示词投影）走真实现——
  // 水位语义正是这些隔离用例顺带覆盖的东西，替身掉就等于把 route 里的调用点变成 undefined。
  absorbedWatermarkFor: (actual: { feedbackId: number }[], withdrawn: { feedbackId: number }[]) => {
    const bound = (rows: { feedbackId: number }[]) => rows.length ? Math.max(...rows.map((r) => r.feedbackId)) : null;
    const a = bound(actual); const b = bound(withdrawn);
    if (a == null) return b ?? 0;
    if (b == null) return a;
    return Math.min(a, b);
  },
  feedbackForPrompt: (rows: { title: string; author: string; status: string; note: string }[]) =>
    rows.map(({ title, author, status, note }) => ({ title, author, status, note })),
  getExcludedBookTitlesForUser: vi.fn(), persistRecommendationsForUser: vi.fn(),
  chat: vi.fn(), verify: vi.fn(),
}));
vi.mock('@/lib/db', () => mocks);
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: mocks.session }));
vi.mock('@/lib/llm', async (original) => ({ ...await original<typeof import('@/lib/llm')>(), chatRobust: mocks.chat }));
vi.mock('@/lib/douban', () => ({ verifyBatch: mocks.verify }));
import * as profile from './profile/route';
import * as find from './find/route';
import * as feedback from './feedback/route';
import { issueVerifyTicket, ticketSigningKey } from '@/lib/verify-ticket';
import type { VerifiedCandidate } from '@/lib/types';

const sessions = new Map<string, SessionRecord>();
const profiles = new Map<number, ProfileSnapshot>();
const candidate = { title: '同一本书', author: '同一作者', why: '原始理由' };
const item = { ...candidate, matchScore: 80, hitLikes: ['设定'], reason: '符合口味', risks: '' };
function member(userId: number): SessionRecord {
  return { userId, username: `member${userId}`, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', ownerCredentialTag: null, membersEnabled: true };
}
function request(route: string, method = 'GET', body?: unknown, token = 'session-a') {
  return new NextRequest(`http://localhost/api/${route}?userId=999`, {
    method, headers: { Cookie: `nf-dev-session=${token}`, Origin: 'http://localhost', 'X-NF-CSRF': '1', 'Content-Type': 'application/json', 'X-User-Id': '999' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function events(response: Response) {
  expect(response.headers.get('Cache-Control')).toContain('private, no-store');
  expect(response.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  return (await response.text()).split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)));
}

describe('32.1 真实权限入口与可信用户绑定（数据库状态为夹具）', () => {
  beforeEach(() => {
    vi.resetAllMocks(); sessions.clear(); profiles.clear();
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true'); vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_OWNER_TOKEN', 'fixture-owner'); vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '280000');
    vi.stubEnv('AUTH_SECURITY_SECRET', 'fixture-security-secret-0123456789abcdef');
    sessions.set('session-a', member(2)); sessions.set('session-b', member(3));
    profiles.set(1, { seeds: [], content: 'OWNER-PRIVATE', updatedAt: 'v1' });
    for (const id of [2, 3]) profiles.set(id, { seeds: [{ title: `用户${id}种子`, kind: 'love' }], content: `USER-${id}-PRIVATE`, updatedAt: 'v1' });
    mocks.getSql.mockReturnValue(vi.fn());
    mocks.session.mockImplementation(async (_sql, token: string) => sessions.get(token) ?? null);
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfileForUser.mockImplementation(async (id: number) => structuredClone(profiles.get(id) ?? { seeds: [], content: '', updatedAt: '' }));
    mocks.saveProfileForUser.mockImplementation(async (id: number, seeds, content: string, version: string) => {
      if (profiles.get(id)?.updatedAt !== version) return null;
      profiles.set(id, { seeds, content, updatedAt: 'v2' }); return 'v2';
    });
    mocks.recordFeedbackForUser.mockResolvedValue(undefined);
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 0, status: null, note: '' });
    mocks.getProfileFeedbackForUser.mockResolvedValue([]);
    mocks.getWithdrawnFeedbackBookTitlesForUserRaw.mockResolvedValue([]);
    mocks.getMaxFeedbackIdForUser.mockResolvedValue(0);
    mocks.markProfileFeedbackAbsorbedForUser.mockResolvedValue(null);
    mocks.getExcludedBookTitlesForUser.mockResolvedValue([]);
    mocks.persistRecommendationsForUser.mockResolvedValue(undefined);
    mocks.chat.mockResolvedValue({ content: '有效生成稿' });
    mocks.verify.mockResolvedValue([{ status: 'not_found', found: false }]);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it.each([
    ['profile', 'GET', profile.GET], ['profile', 'PUT', profile.PUT], ['profile', 'POST', profile.POST],
    ['find', 'POST', find.POST], ['feedback', 'GET', feedback.GET], ['feedback', 'POST', feedback.POST],
  ] as const)('%s %s 在匿名或无 find 能力时先拒绝，不访问业务数据', async (route, method, handler) => {
    for (const token of ['missing', 'session-a']) {
      sessions.set('session-a', { ...member(2), canFind: false });
      const res = await handler(request(route, method, method === 'GET' ? undefined : {}, token));
      expect(res.status).toBe(token === 'missing' ? 401 : 403);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(mocks.ensureSchema).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.recordFeedbackForUser).not.toHaveBeenCalled(); expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });
  it('B 画像缺失时返回空画像，不读取 owner', async () => {
    profiles.delete(3);
    const res = await profile.GET(request('profile', 'GET', undefined, 'session-b'));
    expect(await res.json()).toEqual({ seeds: [], content: '', updatedAt: '' });
    expect(mocks.getProfileForUser).toHaveBeenCalledExactlyOnceWith(3);
  });
  it('正文、query、header 的 userId 均不能替代可信用户；相同版本的 A/B CAS 各自生效', async () => {
    const a = await profile.PUT(request('profile', 'PUT', { userId: 3, seeds: [], content: 'A-only', updatedAt: 'v1', confirmSeedRemoval: true }));
    const b = await profile.PUT(request('profile', 'PUT', { userId: 2, seeds: [], content: 'B-only', updatedAt: 'v1', confirmSeedRemoval: true }, 'session-b'));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(profiles.get(2)?.content).toBe('A-only'); expect(profiles.get(3)?.content).toBe('B-only');
    expect(profiles.get(1)?.content).toBe('OWNER-PRIVATE');
    expect(mocks.saveProfileForUser.mock.calls.map((c) => c[0])).toEqual([2, 3]);
    const stale = await profile.PUT(request('profile', 'PUT', { userId: 3, seeds: [], content: 'A-draft', updatedAt: 'v1', confirmSeedRemoval: true }));
    const conflict = await stale.json();
    expect(stale.status).toBe(409); expect(conflict.profile.content).toBe('A-only'); expect(conflict.draft.content).toBe('A-draft');
  });
  it('召回画像和排除项均带同一用户，重排只给该用户持久化', async () => {
    mocks.chat.mockResolvedValueOnce({ content: JSON.stringify({ candidates: [candidate] }) });
    await events(await find.POST(request('find', 'POST', { step: 'recall', query: '找书', userId: 3 })));
    expect(mocks.getProfileForUser).toHaveBeenCalledWith(2);
    // P2-1 后排除集合只发一条查询（keys 从其结果在内存派生）。
    expect(mocks.getExcludedBookTitlesForUser).toHaveBeenCalledWith(2);
    expect(mocks.getExcludedBookTitlesForUser).toHaveBeenCalledTimes(1);
    expect(mocks.chat.mock.calls[0][1]).toContain('USER-2-PRIVATE');
    expect(mocks.chat.mock.calls[0][1]).not.toMatch(/OWNER-PRIVATE|USER-3-PRIVATE/);
    mocks.chat.mockResolvedValueOnce({ content: JSON.stringify({ items: [item] }) });
    // F01：rerank 只认服务端签发的验证票据，测试按可信用户 2 签一张（query/conditions 必须匹配）。
    const rerankVerified = { ...candidate, douban: { found: false, status: 'not_found' } };
    const ticket = issueVerifyTicket(ticketSigningKey()!, {
      userId: 2, query: '找书', conditions: '', verified: [rerankVerified] as unknown as VerifiedCandidate[],
    });
    await events(await find.POST(request('find', 'POST', { step: 'rerank', query: '找书', ticket, userId: 3 })));
    expect(mocks.persistRecommendationsForUser).toHaveBeenCalledWith(2, '找书', expect.any(Array), expect.any(Function));
  });
  // P1-1：账号模式下 secret 不可用时，成员会话（请求期不复核 secret）仍必须 fail-closed——
  // 路由不得回退 APP_OWNER_TOKEN 签名。这里刻意用 owner 口令当 key 伪造一张**签名有效**的票，
  // 修复后必须仍被 503 挡下（不放行回退 key 签出的任何票）。
  it('账号模式缺 secret 时成员 rerank 返回 503，不回退 owner 口令', async () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', '');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    const ownerSigned = issueVerifyTicket(process.env.APP_OWNER_TOKEN!, {
      userId: 2, query: '找书', conditions: '',
      verified: [{ ...candidate, douban: { found: false, status: 'not_found' } }] as unknown as VerifiedCandidate[],
    });
    const response = await find.POST(request('find', 'POST', { step: 'rerank', query: '找书', ticket: ownerSigned }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('VERIFY_TICKET_UNAVAILABLE');
    expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it.each(['logout', 'disable', 'downgrade'])('模型等待时 %s，重新查询原会话后拒绝写回', async (change) => {
    let finish!: (value: { content: string }) => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    mocks.chat.mockImplementation(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
    const response = await profile.POST(request('profile', 'POST', { updatedAt: 'v1' }));
    await begun;
    if (change === 'downgrade') sessions.set('session-a', { ...member(2), canFind: false });
    else sessions.delete('session-a'); // 实际会话查询也会排除 disabled_at 非空的用户。
    finish({ content: '迟到生成稿' });
    const frames = await events(response);
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'AUTHORIZATION_CHANGED' });
    expect(mocks.session).toHaveBeenCalledTimes(2); // 未复用 WeakMap 缓存。
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });
  it('撤掉下行流会取消实际传给模型的 signal，迟到结果不能写回', async () => {
    let finish!: (value: { content: string }) => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    mocks.chat.mockImplementation(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
    const response = await profile.POST(request('profile', 'POST', { updatedAt: 'v1' }));
    await begun; await response.body!.cancel();
    expect(mocks.chat.mock.calls[0][2].signal.aborted).toBe(true);
    finish({ content: '迟到生成稿' }); await Promise.resolve(); await Promise.resolve();
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });
  it('A 的反馈和画像回写始终绑定 A，不使用客户端传入的 B', async () => {
    const res = await feedback.POST(request('feedback', 'POST', { ...candidate, userId: 3, status: 'done', note: '喜欢设定' }));
    expect(res.status).toBe(200);
    expect(mocks.recordFeedbackForUser).toHaveBeenCalledWith(2, { title: candidate.title, author: candidate.author }, 'done', '喜欢设定', expect.any(Number), expect.any(Function), true);
    // F15：反馈写路径不再同步回写画像（吸收走独立的 /api/profile/absorb），所以这里既不发生
    // 画像写库，客户端传入的 userId=3 也绝不会被动到。
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    expect(profiles.get(3)?.content).toBe('USER-3-PRIVATE');
  });
  it('Cookie 写请求检查 CSRF、Origin 与 JSON 类型', async () => {
    for (const [header, status] of [['X-NF-CSRF', 403], ['Origin', 403], ['Content-Type', 415]] as const) {
      const req = request('profile', 'PUT', { seeds: [], updatedAt: 'v1' }); req.headers.delete(header);
      expect((await profile.PUT(req)).status).toBe(status);
    }
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
  });
  it('入口鉴权消耗模型预算，最终复核耗尽剩余预算时不能保存', async () => {
    vi.useFakeTimers();
    mocks.session.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(member(2)), 100_000)))
      .mockImplementationOnce(() => new Promise(() => {}));
    const pending = profile.POST(request('profile', 'POST', { updatedAt: 'v1' }));
    await vi.advanceTimersByTimeAsync(100_000);
    const response = await pending;
    expect(mocks.chat.mock.calls[0][2].totalTimeoutMs).toBe(173_000);
    await vi.advanceTimersByTimeAsync(185_000);
    expect((await events(response)).at(-1)).toMatchObject({ type: 'error', code: 'DEADLINE_EXCEEDED' });
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });
  it('关闭账号模式的 owner 仍显式查询 userId=1', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    const res = await profile.GET(new NextRequest('http://localhost/api/profile', { headers: { 'X-Owner-Token': 'fixture-owner' } }));
    expect(res.status).toBe(200); expect(mocks.getProfileForUser).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it('取消鉴权中的请求会传给本次认证查询，且不开始业务读取', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    mocks.session.mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    const pending = profile.GET(new NextRequest(request('profile'), { signal: controller.signal }));
    await begun; controller.abort();
    expect((await pending).status).toBe(499);
    expect(mocks.session.mock.calls[0][2].aborted).toBe(true);
    expect(mocks.ensureSchema).not.toHaveBeenCalled(); expect(mocks.getProfileForUser).not.toHaveBeenCalled();
  });
});
