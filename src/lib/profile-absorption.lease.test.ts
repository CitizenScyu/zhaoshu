import { afterEach, expect, it, vi } from 'vitest';

// 固化审查中的零行反例：保留实际 db 完成结果映射，只隔离模型、读库和旧保存接口。
vi.mock('./db', async (original) => ({
  ...await original<typeof import('./db')>(),
  claimProfileFeedbackForUser: vi.fn(async () => 7),
  getProfileForUser: vi.fn(async () => ({ seeds: [], content: '旧画像', updatedAt: 'v1' })),
  getProfileFeedbackForUser: vi.fn(async () => [{ title: '合成书', author: '合成作者', status: 'done', note: '喜欢严谨设定', feedbackId: 5 }]),
  getWithdrawnFeedbackBookTitlesForUserRaw: vi.fn(async () => []),
  saveProfileForUser: vi.fn(async () => 'v2'),
  markProfileFeedbackFailedForUser: vi.fn(async () => {}),
}));
vi.mock('./llm', () => ({
  chatRobust: vi.fn(async () => ({ content: '新画像' })),
  validateProfileContent: (content: string) => content,
}));
vi.mock('./record-llm-usage', () => ({ recordUsageAfterResponse: () => () => {} }));

import { absorbPendingProfileFeedback } from './profile-absorption';
import { getProfileFeedbackForUser, getProfileForUser, markProfileFeedbackAbsorbedForUser, markProfileFeedbackFailedForUser } from './db';

afterEach(() => vi.clearAllMocks());

it('R3：实际数据库映射不能把零行完成更新当作 pending 已清空', async () => {
  expect(await markProfileFeedbackAbsorbedForUser(1, 7, 'applied', async () => [[]], 'old-lease'))
    .toEqual({ matched: false });
});

it('R3：租约失配零行提交返回 conflict，不能声称 applied', async () => {
  const result = await absorbPendingProfileFeedback({
    userId: 1, leaseToken: 'old-lease', write: async () => [[]],
    signal: new AbortController().signal, modelBudgetMs: 1000,
  });
  expect(result).toEqual({ status: 'conflict', pendingFeedbackId: 7 });
});

it('R3：无有效反馈的零行完成更新也返回 conflict', async () => {
  vi.mocked(getProfileFeedbackForUser).mockResolvedValueOnce([]);
  const result = await absorbPendingProfileFeedback({
    userId: 1, leaseToken: 'old-lease', write: async () => [[]],
    signal: new AbortController().signal, modelBudgetMs: 1000,
  });
  expect(result).toEqual({ status: 'conflict', pendingFeedbackId: 7 });
});

it.each([null, 9])('R3：匹配成功明确保留 pending=%s', async (pending) => {
  expect(await markProfileFeedbackAbsorbedForUser(1, 7, 'applied', async () => [[{ pending_feedback_id: pending }]], 'lease'))
    .toEqual({ matched: true, pendingFeedbackId: pending });
});

// F2 附带修：claim 成功之后的读库此前在 try 之外——连接失败/约束错误会裸抛，租约已领走却
// 不走 markFailed，漏记 attempts、不设退避，租约要等 8 分钟自然过期。挪进 try 后必须与
// 模型阶段失败同语义（清租约 + 退避 + attempts）。
it('F2：claim 后读库抛错也记失败退避，租约不裸悬', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(getProfileForUser).mockRejectedValueOnce(new Error('synthetic read failure'));

  const result = await absorbPendingProfileFeedback({
    userId: 1, leaseToken: 'lease-read-fail', write: async () => [[]],
    signal: new AbortController().signal, modelBudgetMs: 1000,
  });

  expect(result).toEqual({ status: 'failed', pendingFeedbackId: 7 });
  expect(markProfileFeedbackFailedForUser).toHaveBeenCalledWith(
    1, 'failed', 'Error', expect.any(Function), 'lease-read-fail',
  );
});
