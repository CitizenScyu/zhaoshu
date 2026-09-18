import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { issueVerifyTicket, ticketSigningKey } from '@/lib/verify-ticket';
import { isRecord } from '@/lib/sanitize';
import type { VerifiedCandidate } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(), model: vi.fn(), persist: vi.fn(), verify: vi.fn(), disable: vi.fn(),
  profile: vi.fn(), saveProfile: vi.fn(), recordFeedback: vi.fn(), snapshot: vi.fn(), dispatch: vi.fn(),
  feedback: vi.fn(), withdrawn: vi.fn(),
}));
const principal = { userId: 7, role: 'member', canFind: true, canRead: true, canDownload: true, authMethod: 'session' };
vi.mock('@/lib/auth', () => ({
  requirePermission: async () => ({ ok: true, principal }),
  revalidatePermission: async () => ({ ok: true, principal }),
}));
vi.mock('@/lib/db', async original => ({
  ...await original<typeof import('@/lib/db')>(),
  ensureSchema: async () => {}, getSql: () => mocks.sql,
  getProfileForUser: mocks.profile, saveProfileForUser: mocks.saveProfile,
  getProfileFeedbackForUser: mocks.feedback, getWithdrawnFeedbackBookTitlesForUser: mocks.withdrawn,
  getExcludedBookTitlesForUser: async () => [], persistRecommendationsForUser: mocks.persist,
  recordFeedbackForUser: mocks.recordFeedback, getFeedbackSnapshotForUser: mocks.snapshot,
}));
vi.mock('@/lib/llm', async original => ({ ...await original<typeof import('@/lib/llm')>(), chatRobust: mocks.model }));
vi.mock('@/lib/douban', () => ({ verifyBatch: mocks.verify }));
vi.mock('@/lib/source-verification', () => ({ supplementSourceEvidence: vi.fn() }));
vi.mock('@/lib/github', () => ({ triggerDownloadWorkflow: mocks.dispatch }));
vi.mock('@/lib/shuyuan', () => ({ disableShuyuanSource: mocks.disable, enableShuyuanSource: vi.fn(), getShuyuanStats: vi.fn(), refreshShuyuan: vi.fn() }));

import { POST as find } from '@/app/api/find/route';
import { GET as downloadGet, POST as download } from '@/app/api/download/route';
import { POST as source } from '@/app/api/shuyuan/route';
import { POST as profile } from '@/app/api/profile/route';
import { POST as feedback } from '@/app/api/feedback/route';

const candidate = { title: '合成审查作品', author: '审查作者', category: '', wordCount: '', why: '' };
const ranked = { ...candidate, matchScore: 90, hitLikes: [], risks: '', reason: '合成判断' };
const verified = { ...candidate, douban: { status: 'verified', found: true, doubanId: '999999', rating: 10, ratingCount: 123456 } };
const TEST_SECRET = 'audit-fake-security-secret-0123456789abcd';

// F01：rerank 现在只认服务端签发的验证票据；除 R10（验证伪造被拒）外，其余 rerank 用例
// 自动补一张合法票据，继续测它们原本关心的行为。
function withTicket(body: unknown): unknown {
  if (!isRecord(body) || body.step !== 'rerank' || body.ticket !== undefined) return body;
  if (!Array.isArray(body.verified)) return body;
  const key = ticketSigningKey();
  if (!key) return body;
  return {
    ...body,
    ticket: issueVerifyTicket(key, {
      userId: principal.userId,
      query: typeof body.query === 'string' ? body.query : '',
      conditions: typeof body.conditions === 'string' ? body.conditions : '',
      verified: body.verified as unknown as VerifiedCandidate[],
    }),
  };
}
function request(path: string, body: unknown, untrustedOrigin = false, autoTicket = true) {
  return new NextRequest(`https://app.example.invalid/api/${path}`, {
    method: 'POST',
    headers: untrustedOrigin
      ? { Origin: 'https://other.example.invalid', 'Content-Type': 'text/plain' }
      : { Origin: 'https://app.example.invalid', 'Content-Type': 'application/json', 'x-nf-csrf': '1' },
    body: JSON.stringify(autoTicket ? withTicket(body) : body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AUTH_SECURITY_SECRET', TEST_SECRET);
  mocks.model.mockResolvedValue({ content: JSON.stringify({ items: [ranked] }) });
  mocks.profile.mockResolvedValue({ seeds: [{ title: '合成种子', kind: 'love' }], content: '反馈独有偏好：讨厌机械降神', updatedAt: 'v1' });
  mocks.snapshot.mockResolvedValue({ version: 0, note: '', status: null });
  mocks.feedback.mockResolvedValue([]);
  mocks.withdrawn.mockResolvedValue([]);
  mocks.saveProfile.mockResolvedValue('v2');
  mocks.persist.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// 语义翻转（F02 修复后）：原复现断言「异源 Origin + text/plain + 缺 CSRF 头的 session 写请求被接受」，
// 证明 /api/download 与 /api/shuyuan 缺少统一写校验。现改为断言同款请求被拒绝——通过即表示漏洞已堵。
it('R08（翻转）: download 拒绝携异源 Origin、text/plain、缺 CSRF 头的 session 写请求', async () => {
  const response = await download(request('download', { bookId: 1 }, true));
  expect(response.status).toBe(403);
  expect((await response.json()).code).toBe('CSRF_HEADER_REQUIRED');
  // 拒绝必须发生在建任务与 workflow dispatch 之前。
  expect(mocks.sql).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it('R09（翻转）: shuyuan 拒绝缺 CSRF 头、异源 Origin 的禁用请求', async () => {
  mocks.disable.mockResolvedValue(true);
  const response = await source(request('shuyuan', { action: 'disable', url: 'https://book15.net/' }, true));
  expect(response.status).toBe(403);
  expect((await response.json()).code).toBe('CSRF_HEADER_REQUIRED');
  // 拒绝时不得发生写库（disableShuyuanSource）。
  expect(mocks.disable).not.toHaveBeenCalled();
  // Control: the personal write wrapper rejects exactly this request class.
  expect((await find(request('find', { step: 'recall', query: '合成需求' }, true))).status).toBe(403);
});

// F01 翻转：原断言「伪造 verified 无服务端核验也能落库」记录的是漏洞；修复后必须有服务端
// HMAC 票据才放行，否则 403 且完全不触达模型/写库。
it('R10: fabricated verification values are rejected without a server-signed ticket', async () => {
  const response = await find(request('find', { step: 'rerank', query: '合成需求', verified: [verified] }, false, false));
  expect(response.status).toBe(403);
  expect(await response.text()).toContain('VERIFY_TICKET_INVALID');
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.model).not.toHaveBeenCalled();
});

it('R11: legitimate zero-survivor rerank is retried and then reported as a model error', async () => {
  mocks.model.mockResolvedValue({ content: '{"items":[]}' });
  const response = await find(request('find', { step: 'rerank', query: '全部命中雷点的合成需求', verified: [verified] }));
  expect(await response.text()).toContain('"type":"error"');
  expect(mocks.model).toHaveBeenCalledTimes(2);
  expect(mocks.persist).not.toHaveBeenCalled();
});

// F04 翻转：重新生成画像必须把「当前画像 + 本人最新有效反馈」并入模型输入，且不得丢反馈积累。
// 旧复现断言输入**不含**反馈独有偏好（缺陷存在）；现改为断言偏好仍在。
it('R12（翻转）: profile regeneration preserves feedback-derived preferences in the model input', async () => {
  mocks.model.mockResolvedValue({ content: '基于积累的合成画像' });
  mocks.feedback.mockResolvedValue([
    { title: '合成反馈书', author: '审查作者', status: 'dropped', note: '讨厌机械降神' },
  ]);
  const response = await profile(request('profile', { updatedAt: 'v1' }));
  expect(await response.text()).toContain('"type":"done"');
  expect(mocks.model.mock.calls[0][1]).toContain('讨厌机械降神');
  expect(mocks.feedback).toHaveBeenCalledWith(7); // 只读当前 principal 的反馈
  expect(mocks.saveProfile.mock.calls[0][2]).toBe('基于积累的合成画像');
});

it('R13: failed feedback profile update returns the same user-facing state as a no-op and offers no retry identity', async () => {
  mocks.model.mockRejectedValue(new Error('synthetic offline failure'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await feedback(request('feedback', { ...candidate, status: 'done', note: '合成读后反馈' }));
  expect(mocks.recordFeedback).toHaveBeenCalledOnce();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, profileUpdated: false });
});

it('R14: temporary conditions still reach recommendation query persistence verbatim', async () => {
  const query = '仅本次生效的合成需求';
  const response = await find(request('find', { step: 'rerank', query, conditions: query, verified: [verified] }));
  await response.text();
  expect(mocks.persist.mock.calls[0][1]).toBe(query);
});

it('R15: successful source verification is not provided to the reranking model', async () => {
  const sourceEvidence = { status: 'matched', sourceName: '合成补验源', url: 'https://book15.net/books/details42.html', checkedAt: '2026-09-19T00:00:00.000Z', note: '身份匹配' };
  const response = await find(request('find', { step: 'rerank', query: '合成需求', verified: [{ ...verified, sourceEvidence }] }));
  const events = await response.text();
  expect(events).toContain('合成补验源');
  expect(mocks.model.mock.calls[0][1]).not.toContain('合成补验源');
  expect(mocks.model.mock.calls[0][1]).not.toContain('sourceEvidence');
});

// 本文件原只有 R08–R15，没有 R16–R18。F16/F17 的等价用例补在这里（download 路由的 mock
// 够用）；F18 走 library 的合批只读事务，本文件的 getSql mock 不支持，等价用例放在
// src/app/api/library/route.test.ts（见「F18：两用户同书」）。

it('R16（补，翻转）: 已有活动任务的冲突响应返回同一用户的 taskId 与状态，而不是只有 error/code', async () => {
  mocks.sql
    .mockResolvedValueOnce([{ id: 7, title: '合成书', author: '审查作者', source_url: 'https://book15.net/books/details7.html' }])
    .mockResolvedValueOnce([]) // 回收
    .mockResolvedValueOnce([{ id: 42, status: 'running' }]);
  const response = await download(request('download', { bookId: 7 }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'TASK_CONFLICT', taskId: 42, status: 'running' });
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it('R17（补，翻转）: GET 保持只读、派生 leaseExpired，过期回收不再依赖 POST', async () => {
  mocks.sql.mockResolvedValueOnce([{
    id: 42, book_id: 7, title: '合成书', author: '审查作者', status: 'running',
    chapters_total: 100, chapters_done: 12, chars_total: 0, error: '',
    created_at: '2026-09-14T00:00:00Z',
    updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
  }]);
  const response = await downloadGet(new NextRequest('https://app.example.invalid/api/download?id=42'));
  expect(response.status).toBe(200);
  expect((await response.json()).task).toMatchObject({ status: 'running', leaseExpired: true });
  // 只读：GET 只发一条 SELECT，不写回收。
  expect(mocks.sql).toHaveBeenCalledOnce();
  expect(mocks.sql.mock.calls[0][0].join(' ')).toMatch(/^\s*SELECT /);
});
