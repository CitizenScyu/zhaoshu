import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { issueVerifyTicket, ticketSigningKey } from '@/lib/verify-ticket';
import { isRecord } from '@/lib/sanitize';
import type { VerifiedCandidate } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(), model: vi.fn(), persist: vi.fn(), verify: vi.fn(), disable: vi.fn(),
  profile: vi.fn(), saveProfile: vi.fn(), recordFeedback: vi.fn(), snapshot: vi.fn(), dispatch: vi.fn(),
  feedback: vi.fn(), withdrawn: vi.fn(),
  // F15：profile 路由重建成功后要推进反馈吸收水位，需要这两个真实现（其他用例不受影响）。
  maxFeedbackId: vi.fn(), markAbsorbed: vi.fn(),
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
  getMaxFeedbackIdForUser: mocks.maxFeedbackId, markProfileFeedbackAbsorbedForUser: mocks.markAbsorbed,
}));
vi.mock('@/lib/llm', async original => ({ ...await original<typeof import('@/lib/llm')>(), chatRobust: mocks.model }));
vi.mock('@/lib/douban', () => ({ verifyBatch: mocks.verify }));
vi.mock('@/lib/source-verification', () => ({ supplementSourceEvidence: vi.fn() }));
vi.mock('@/lib/github', () => ({ triggerDownloadWorkflow: mocks.dispatch }));
vi.mock('@/lib/shuyuan', () => ({ disableShuyuanSource: mocks.disable, enableShuyuanSource: vi.fn(), getShuyuanStats: vi.fn(), refreshShuyuan: vi.fn() }));

import { POST as find } from '@/app/api/find/route';
import { POST as download } from '@/app/api/download/route';
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
  mocks.maxFeedbackId.mockResolvedValue(0);
  mocks.markAbsorbed.mockResolvedValue(null);
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

// F15 翻转：原复现断言「反馈写入后模型失败只返回 {ok:true,profileUpdated:false}，与无需修改
// 不可区分、且没有可重放身份」。修复后写路径只做快速持久化 + 登记待吸收事件：模型完全不在
// 反馈请求里同步执行，响应带 profileStatus/pending/retryable，可区分于 unchanged 并可重放。
it('R13（翻转）: 模型不可用时反馈照常保存，响应给出可区分的待吸收状态与重放身份', async () => {
  mocks.model.mockRejectedValue(new Error('synthetic offline failure'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await feedback(request('feedback', { ...candidate, status: 'done', note: '合成读后反馈' }));
  expect(mocks.recordFeedback).toHaveBeenCalledOnce();
  expect(response.status).toBe(200);
  const body = await response.json();
  // 不再是「静默 no-op」形状：待吸收与无需修改在用户侧可区分，且明确可重放。
  expect(body).not.toEqual({ ok: true, profileUpdated: false });
  expect(body).toMatchObject({ ok: true, profileUpdated: false, profileStatus: 'pending', pending: true, retryable: true });
  // 写路径不触发模型：用户不为数分钟的模型调用同步等待（吸收由独立端点按用户合并执行）。
  expect(mocks.model).not.toHaveBeenCalled();
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
