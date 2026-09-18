import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// F15：画像吸收是独立的模型路由。本文件用隔离的 db/llm 替身覆盖状态机与可恢复性：
//   pending → applied / unchanged / failed / conflict，失败保留 pending 可重放；
//   按用户合并（一次模型调用覆盖多条反馈）；空画像起步能建立；撤回信号进入模型输入。
const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getProfileFeedbackQueueForUser: vi.fn(),
  getProfileForUser: vi.fn(),
  getProfileFeedbackForUser: vi.fn(),
  getWithdrawnFeedbackBookTitlesForUser: vi.fn(),
  saveProfileForUser: vi.fn(),
  markProfileFeedbackAbsorbedForUser: vi.fn(),
  markProfileFeedbackFailedForUser: vi.fn(),
  ensureProfileForUser: vi.fn(),
  chatRobust: vi.fn(),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/db')>(),
  getProfileFeedbackQueueForUser: mocks.getProfileFeedbackQueueForUser,
  getProfileForUser: mocks.getProfileForUser,
  getProfileFeedbackForUser: mocks.getProfileFeedbackForUser,
  getWithdrawnFeedbackBookTitlesForUser: mocks.getWithdrawnFeedbackBookTitlesForUser,
  saveProfileForUser: mocks.saveProfileForUser,
  markProfileFeedbackAbsorbedForUser: mocks.markProfileFeedbackAbsorbedForUser,
  markProfileFeedbackFailedForUser: mocks.markProfileFeedbackFailedForUser,
  ensureProfileForUser: mocks.ensureProfileForUser,
  ensureSchema: mocks.ensureSchema,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: mocks.chatRobust,
}));

import { POST, GET } from './route';

function request(method: 'POST' | 'GET', body?: unknown) {
  return new NextRequest('http://localhost/api/profile/absorb', {
    method,
    headers: { Authorization: 'Bearer absorb-test-owner', 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}

const pendingQueue = { pendingFeedbackId: 7, absorbedFeedbackId: 3, status: 'pending', attempts: 1, lastError: '', updatedAt: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_OWNER_TOKEN', 'absorb-test-owner');
  mocks.ensureSchema.mockResolvedValue(undefined);
  mocks.getProfileFeedbackQueueForUser.mockResolvedValue(pendingQueue);
  mocks.getProfileForUser.mockResolvedValue({ seeds: [], content: '旧画像', updatedAt: 'v1' });
  mocks.getProfileFeedbackForUser.mockResolvedValue([{ title: '书甲', author: '作者', status: 'dropped', note: '讨厌机械降神' }]);
  mocks.getWithdrawnFeedbackBookTitlesForUser.mockResolvedValue([]);
  mocks.chatRobust.mockResolvedValue({ content: '合并后的画像' });
  mocks.saveProfileForUser.mockResolvedValue('v2');
  mocks.markProfileFeedbackAbsorbedForUser.mockResolvedValue(null);
  mocks.markProfileFeedbackFailedForUser.mockResolvedValue(undefined);
  mocks.ensureProfileForUser.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/profile/absorb (F15 state machine)', () => {
  it('returns unchanged without a model call when nothing is pending', async () => {
    mocks.getProfileFeedbackQueueForUser.mockResolvedValue({ ...pendingQueue, pendingFeedbackId: null, status: 'applied' });

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ ok: true, status: 'applied', pendingFeedbackId: null });
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  it('merges every pending feedback into a single model call and reports applied', async () => {
    mocks.getProfileFeedbackForUser.mockResolvedValue([
      { title: '书甲', author: '作者', status: 'dropped', note: '讨厌机械降神' },
      { title: '书乙', author: '作者', status: 'done', note: '喜欢严谨设定' },
    ]);

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ status: 'applied', pendingFeedbackId: null, updatedAt: 'v2' });
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
    const prompt = mocks.chatRobust.mock.calls[0][1] as string;
    expect(prompt).toContain('讨厌机械降神');
    expect(prompt).toContain('喜欢严谨设定');
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, [], '合并后的画像', 'v1', expect.any(Function));
    expect(mocks.markProfileFeedbackAbsorbedForUser).toHaveBeenCalledWith(1, 7, 'applied', expect.any(Function));
  });

  it('keeps pending and reports failed when the model fails, then applies on a successful replay', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.chatRobust.mockRejectedValueOnce(new Error('synthetic offline failure'));

    const failed = await POST(request('POST'));
    expect(await failed.json()).toMatchObject({ status: 'failed', pendingFeedbackId: 7 });
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    expect(mocks.markProfileFeedbackFailedForUser).toHaveBeenCalledWith(1, 'failed', 'Error', expect.any(Function));

    // 下一次机会：同步 pending 仍在，模型恢复 → 最终 applied，水位推进。
    const replay = await POST(request('POST'));
    expect(await replay.json()).toMatchObject({ status: 'applied', pendingFeedbackId: null });
    expect(mocks.markProfileFeedbackAbsorbedForUser).toHaveBeenLastCalledWith(1, 7, 'applied', expect.any(Function));
  });

  it('reports unchanged when the model returns the profile byte-for-byte, still advancing the watermark', async () => {
    mocks.chatRobust.mockResolvedValue({ content: '旧画像' });
    mocks.saveProfileForUser.mockResolvedValue('v1');

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ status: 'unchanged', pendingFeedbackId: null });
    expect(mocks.markProfileFeedbackAbsorbedForUser).toHaveBeenCalledWith(1, 7, 'unchanged', expect.any(Function));
  });

  it('reports conflict and keeps pending when another writer wins the profile CAS', async () => {
    mocks.saveProfileForUser.mockResolvedValue(null);

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ status: 'conflict', pendingFeedbackId: 7 });
    expect(mocks.markProfileFeedbackFailedForUser).toHaveBeenCalledWith(1, 'conflict', 'ProfileConflict', expect.any(Function));
    expect(mocks.markProfileFeedbackAbsorbedForUser).not.toHaveBeenCalled();
  });

  it('builds a profile from feedback alone when the user has no profile row yet', async () => {
    mocks.getProfileForUser
      .mockResolvedValueOnce({ seeds: [], content: '', updatedAt: '' })
      .mockResolvedValue({ seeds: [], content: '', updatedAt: 'v0' });

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ status: 'applied' });
    expect(mocks.ensureProfileForUser).toHaveBeenCalledWith(1, expect.any(Function));
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, [], '合并后的画像', 'v0', expect.any(Function));
  });

  it('feeds withdrawn titles to the model so old preferences are not revived', async () => {
    mocks.getProfileFeedbackForUser.mockResolvedValue([]);
    mocks.getWithdrawnFeedbackBookTitlesForUser.mockResolvedValue(['撤回书']);

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ status: 'applied' });
    const prompt = mocks.chatRobust.mock.calls[0][1] as string;
    expect(prompt).toContain('撤回书');
    expect(prompt).toContain('已被撤回');
  });

  it('reports failed (keeping pending) when the model output is not a valid profile', async () => {
    mocks.chatRobust.mockResolvedValue({ content: '' });

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ status: 'failed', pendingFeedbackId: 7 });
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });

  it('does not call the model when there is no informative feedback and no withdrawal', async () => {
    mocks.getProfileFeedbackForUser.mockResolvedValue([]);
    mocks.getWithdrawnFeedbackBookTitlesForUser.mockResolvedValue([]);

    const res = await POST(request('POST'));

    expect(await res.json()).toMatchObject({ status: 'unchanged' });
    expect(mocks.chatRobust).not.toHaveBeenCalled();
    expect(mocks.markProfileFeedbackAbsorbedForUser).toHaveBeenCalledWith(1, 7, 'unchanged', expect.any(Function));
  });
});

describe('GET /api/profile/absorb', () => {
  it('exposes the queue status without invoking the model', async () => {
    const res = await GET(request('GET'));
    expect(await res.json()).toMatchObject({ ok: true, status: 'pending', pending: true, attempts: 1 });
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });
});
