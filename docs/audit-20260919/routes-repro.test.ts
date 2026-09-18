import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(), model: vi.fn(), persist: vi.fn(), verify: vi.fn(), disable: vi.fn(),
  profile: vi.fn(), saveProfile: vi.fn(), recordFeedback: vi.fn(), snapshot: vi.fn(), dispatch: vi.fn(),
  feedback: vi.fn(),
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
  getProfileFeedbackForUser: mocks.feedback,
  getExcludedBookTitlesForUser: async () => [], persistRecommendationsForUser: mocks.persist,
  recordFeedbackForUser: mocks.recordFeedback, getFeedbackSnapshotForUser: mocks.snapshot,
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
function request(path: string, body: unknown, untrustedOrigin = false) {
  return new NextRequest(`https://app.example.invalid/api/${path}`, {
    method: 'POST',
    headers: untrustedOrigin
      ? { Origin: 'https://other.example.invalid', 'Content-Type': 'text/plain' }
      : { Origin: 'https://app.example.invalid', 'Content-Type': 'application/json', 'x-nf-csrf': '1' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.model.mockResolvedValue({ content: JSON.stringify({ items: [ranked] }) });
  mocks.profile.mockResolvedValue({ seeds: [{ title: '合成种子', kind: 'love' }], content: '反馈独有偏好：讨厌机械降神', updatedAt: 'v1' });
  mocks.snapshot.mockResolvedValue({ version: 0, note: '', status: null });
  mocks.feedback.mockResolvedValue([]);
  mocks.saveProfile.mockResolvedValue('v2');
  mocks.persist.mockImplementation(async (_userId: number, _query: string, items: unknown[]) => items.length);
});
afterEach(() => vi.restoreAllMocks());

it('R08: download accepts a session-authorized write with foreign Origin, text/plain and no CSRF header', async () => {
  mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
    const text = parts.join('?');
    if (text.includes('FROM labeled_books')) return [{ id: 1, ...candidate, source_url: 'https://book15.net/books/details42.html' }];
    if (text.includes('INSERT INTO download_tasks')) return [{ id: 8 }];
    return [];
  });
  const response = await download(request('download', { bookId: 1 }, true));
  expect(response.status).toBe(201);
  expect(mocks.dispatch).toHaveBeenCalledOnce();
});

it('R09: source disabling also accepts a foreign Origin without the required CSRF header', async () => {
  mocks.disable.mockResolvedValue(true);
  const response = await source(request('shuyuan', { action: 'disable', url: 'https://book15.net/' }, true));
  expect(response.status).toBe(200);
  expect(mocks.disable).toHaveBeenCalledOnce();
  // Control: the personal write wrapper rejects exactly this request class.
  expect((await find(request('find', { step: 'recall', query: '合成需求' }, true))).status).toBe(403);
});

it('R10: fabricated verification values reach persistence without any server verification', async () => {
  const response = await find(request('find', { step: 'rerank', query: '合成需求', verified: [verified] }));
  const events = await response.text();
  expect(events).toContain('"type":"result"');
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.persist.mock.calls[0][2][0].douban).toMatchObject({ rating: 10, ratingCount: 123456, doubanId: '999999' });
});

it('R11: legitimate zero-survivor rerank is retried and then reported as a model error', async () => {
  mocks.model.mockResolvedValue({ content: '{"items":[]}' });
  const response = await find(request('find', { step: 'rerank', query: '全部命中雷点的合成需求', verified: [verified] }));
  expect(await response.text()).toContain('"type":"error"');
  expect(mocks.model).toHaveBeenCalledTimes(2);
  expect(mocks.persist).not.toHaveBeenCalled();
});

// F04：翻转为「重新生成后反馈偏好仍在」。旧复现断言输入**不含**反馈独有偏好（缺陷存在）；
// 修复后默认重建必须把当前画像与本人最新有效反馈并入模型输入。
it('R12: profile regeneration preserves feedback-derived preferences in the model input', async () => {
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
