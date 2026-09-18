import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ProfileSnapshot, SeedBook } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getProfileForUser: vi.fn(), saveProfileForUser: vi.fn(), chatRobust: vi.fn(),
  getSql: vi.fn(), sql: vi.fn(), transaction: vi.fn(), getFeedbackSnapshotForUser: vi.fn(),
  getProfileFeedbackForUser: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  recordFeedbackForUser: async (userId: number, book: { title: string; author: string }, status: string, note: string, expectedVersion: number) => {
    const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    await actual.recordFeedbackForUser(userId, book, status, note, expectedVersion, async (batch) => {
      await mocks.transaction(batch(mocks.sql as never));
      return [];
    });
  },
  ensureSchema: mocks.ensureSchema, getProfileForUser: mocks.getProfileForUser, saveProfileForUser: mocks.saveProfileForUser,
  getSql: mocks.getSql, getFeedbackSnapshotForUser: mocks.getFeedbackSnapshotForUser,
  getProfileFeedbackForUser: mocks.getProfileFeedbackForUser,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: async (...args: unknown[]) => ({ content: await mocks.chatRobust(...args) }),
}));
import { LlmError } from '@/lib/llm';
import { GET, POST, PUT } from './route';
import { POST as saveFeedback } from '../feedback/route';

const seeds: SeedBook[] = [{ title: '测试书', author: '作者', kind: 'love' }];
const previousVersion = '2026-09-15 00:00:00.123456+00';
const nextVersion = '2026-09-15 00:00:00.123457+00';
function request(method = 'POST', body: unknown = { updatedAt: previousVersion }, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/profile', {
    method, signal, headers: { Authorization: 'Bearer profile-test-owner', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// 生成路由的下行是真 SSE：从流式响应收集事件，事件为 `data: <json>\n\n`。
async function consumeSSE(res: Response): Promise<Record<string, unknown>[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  const text = await res.text();
  const events: Record<string, unknown>[] = [];
  for (const chunk of text.split('\n\n')) {
    const m = chunk.match(/^data: (.+)$/m);
    if (m) events.push(JSON.parse(m[1]));
  }
  return events;
}

function lastEvent<R extends Record<string, unknown>>(events: Record<string, unknown>[], type: string): R {
  const event = [...events].reverse().find((e) => e.type === type);
  if (!event) throw new Error(`expected SSE event ${type}, got ${JSON.stringify(events)}`);
  return event as R;
}

describe('/api/profile writes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'profile-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfileForUser.mockResolvedValue({ seeds, content: '原画像', updatedAt: previousVersion });
    mocks.saveProfileForUser.mockResolvedValue(nextVersion);
    mocks.chatRobust.mockResolvedValue('  有效画像😀\n喜欢严谨设定  ');
    mocks.getSql.mockReturnValue(Object.assign(mocks.sql, { transaction: mocks.transaction }));
    mocks.transaction.mockResolvedValue([]);
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 0, status: null, note: '' });
    mocks.getProfileFeedbackForUser.mockResolvedValue([]);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('saves valid generated markdown as a stream ending in a done event, passing cancellation to the model', async () => {
    const req = request();
    const res = await POST(req);
    const events = await consumeSSE(res);
    // 结束帧带完整结果（真正的 onToken 逐字首字节由 stream.test 用真实 llm 覆盖）。
    expect(lastEvent(events, 'done')).toEqual({ type: 'done', seeds, content: '有效画像😀\n喜欢严谨设定', updatedAt: nextVersion, feedbackCount: 0, resetFromSeeds: false });
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, seeds, '有效画像😀\n喜欢严谨设定', previousVersion, expect.any(Function));
    expect(mocks.chatRobust.mock.calls[0][2].signal.aborted).toBe(req.signal.aborted);
  });

  it.each(['', ' \n ', null, false, '字'.repeat(5_001), 'bad' + String.fromCharCode(0), '\ud800', '\udc00'])(
    'returns an error event without saving invalid model profile %#', async (content) => {
      mocks.chatRobust.mockResolvedValue(content);
      const events = await consumeSSE(await POST(request()));
      expect(lastEvent(events, 'error')).toMatchObject({ type: 'error' });
      expect(String(lastEvent(events, 'error').message)).toMatch(/画像为空、过长或含非法字符/);
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    },
  );

  it.each(['长度截断', '上游错误', '坏 SSE 事件', '无终止标记 EOF', '调用已取消'])(
    'returns an error event without saving after %s', async (message) => {
      mocks.chatRobust.mockRejectedValue(new LlmError(message, false));
      const events = await consumeSSE(await POST(request()));
      expect(lastEvent<{ type: string; message: string }>(events, 'error').message).toBe(message);
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    },
  );

  it('does not save if cancellation arrives as the model returns', async () => {
    const controller = new AbortController();
    mocks.chatRobust.mockImplementation(async () => {
      controller.abort();
      return '有效画像';
    });
    const res = await POST(request('POST', undefined, controller.signal));
    expect(res.status).toBe(200);
    // 请求已取消：流式响应被客户端撤掉，cancel() 会读取已中止的 signal 而抛错，属预期。
    await res.body?.cancel().catch(() => {});
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });

  it.each(['bad' + String.fromCharCode(0), '\ud800', '\udc00'])(
    'rejects illegal manual body text before touching the database %#', async (content) => {
      const res = await PUT(request('PUT', { seeds, content, updatedAt: previousVersion }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'content contains invalid characters' });
      expect(mocks.ensureSchema).not.toHaveBeenCalled();
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    },
  );

  it('retains the manual empty-profile contract', async () => {
    expect((await PUT(request('PUT', { seeds, content: '', updatedAt: previousVersion }))).status).toBe(200);
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, seeds, '', previousVersion, expect.any(Function));
  });

  it('requires explicit confirmation before removing a seed, returning the missing title and retained draft', async () => {
    const res = await PUT(request('PUT', { seeds: [], updatedAt: previousVersion }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PROFILE_SEEDS_CONFIRM_REQUIRED', removedTitles: ['测试书'], draft: { seeds: [] } });
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });

  it('allows a confirmed reduction but never lets confirmation bypass the version check', async () => {
    const res = await PUT(request('PUT', { seeds: [], updatedAt: previousVersion, confirmSeedRemoval: true }));
    expect(res.status).toBe(200);
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, [], '原画像', previousVersion, expect.any(Function));
    mocks.saveProfileForUser.mockClear();
    const stale = await PUT(request('PUT', { seeds: [], updatedAt: 'stale', confirmSeedRemoval: true }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('PROFILE_CONFLICT');
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });

  it('leaves the profile untouched when the atomic audit/save fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.saveProfileForUser.mockRejectedValue(new Error('audit unavailable'));
    expect((await PUT(request('PUT', { seeds: [], updatedAt: previousVersion, confirmSeedRemoval: true }))).status).toBe(500);
    expect(mocks.saveProfileForUser).toHaveBeenCalledOnce();
  });

  it('returns the raw database version on GET without losing microseconds', async () => {
    const res = await GET(new NextRequest('http://localhost/api/profile', {
      headers: { Authorization: 'Bearer profile-test-owner' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seeds, content: '原画像', updatedAt: previousVersion });
  });

  it.each([undefined, null, false, 42, '', ' ', 'v'.repeat(129), 'bad\u0000', '\ud800'])(
    'rejects a missing or invalid version before database/model access %#', async (updatedAt) => {
      for (const method of ['PUT', 'POST']) {
        const res = await (method === 'PUT' ? PUT : POST)(request(method, { seeds, updatedAt }));
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('PROFILE_VERSION_REQUIRED');
      }
      expect(mocks.ensureSchema).not.toHaveBeenCalled();
      expect(mocks.getProfileForUser).not.toHaveBeenCalled();
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
      expect(mocks.chatRobust).not.toHaveBeenCalled();
    },
  );

  it('requires a body for generation and bounds it before any database access', async () => {
    const headers = { Authorization: 'Bearer profile-test-owner' };
    const noBody = await POST(new NextRequest('http://localhost/api/profile', { method: 'POST', headers }));
    expect(noBody.status).toBe(400);
    const oversized = await POST(new NextRequest('http://localhost/api/profile', {
      method: 'POST', headers, body: 'x'.repeat(64 * 1024 + 1),
    }));
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).code).toBe('BODY_TOO_LARGE');
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
  });

  it('saves sanitized seeds with the previously read content and returns the new version', async () => {
    const res = await PUT(request('PUT', {
      seeds: [{ title: ' 测试书 ', author: ' 作者 ', kind: 'love' }], updatedAt: previousVersion,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seeds, content: '原画像', updatedAt: nextVersion });
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, seeds, '原画像', previousVersion, expect.any(Function));
  });

  it.each(['PUT', 'POST'])('rejects an already stale %s without writing or calling the model', async (method) => {
    const latest = { seeds: [{ title: '新书', kind: 'drop' }], content: '他人的更新', updatedAt: nextVersion };
    mocks.getProfileForUser.mockResolvedValue(latest);
    // 两人同时写、读取时已落后：都在调用模型前就暴露 409，POST 生成以 JSON 409 回（流尚未启动）。
    const res = await (method === 'PUT' ? PUT : POST)(request(method, {
      seeds, content: '我的修订', updatedAt: previousVersion,
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.any(String), code: 'PROFILE_CONFLICT', profile: latest,
      ...(method === 'PUT' ? { draft: { seeds, content: '我的修订' } } : {}),
    });
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  it('allows only one of two saves based on the same version', async () => {
    let current: ProfileSnapshot = { seeds, content: '原画像', updatedAt: previousVersion };
    mocks.getProfileForUser.mockImplementation(async () => structuredClone(current));
    mocks.saveProfileForUser.mockImplementation(async (_userId, nextSeeds, content, expected) => {
      if (current.updatedAt !== expected) return null;
      current = { seeds: nextSeeds, content, updatedAt: nextVersion };
      return nextVersion;
    });
    const responses = await Promise.all(['窗口 A', '窗口 B'].map((content) =>
      PUT(request('PUT', { seeds, content, updatedAt: previousVersion }))));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const success = await responses.find((res) => res.status === 200)!.json();
    const rejected = await responses.find((res) => res.status === 409)!.json();
    expect(success).toEqual({ ok: true, ...current });
    expect(rejected.profile).toEqual(current);
    expect(rejected.draft.content).not.toBe(current.content);
    expect(mocks.saveProfileForUser).toHaveBeenCalledTimes(2);
    expect(mocks.saveProfileForUser.mock.calls.every((call) => call[0] === 1 && call[3] === previousVersion)).toBe(true);
  });

  it.each(['manual', 'feedback'])('preserves a %s update made while generation is waiting', async (writer) => {
    let current: ProfileSnapshot = { seeds, content: '原画像', updatedAt: previousVersion };
    mocks.getProfileForUser.mockImplementation(async () => structuredClone(current));
    mocks.saveProfileForUser.mockImplementation(async (_userId, nextSeeds, content, expected) => {
      if (current.updatedAt !== expected) return null;
      current = { seeds: nextSeeds, content, updatedAt: nextVersion };
      return nextVersion;
    });
    let finishGeneration!: (value: string) => void;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.chatRobust.mockImplementationOnce(() => {
      started();
      return new Promise<string>((resolve) => { finishGeneration = resolve; });
    });
    const generation = POST(request());
    await modelStarted;
    const newSeeds = [{ title: '新种子', kind: 'drop' }];
    const saved = writer === 'manual'
      ? await PUT(request('PUT', { seeds: newSeeds, content: '人工新画像', updatedAt: previousVersion, confirmSeedRemoval: true }))
      : await saveFeedback(new NextRequest('http://localhost/api/feedback', {
        method: 'POST', headers: { Authorization: 'Bearer profile-test-owner' },
        body: JSON.stringify({ title: '反馈书', status: 'done', note: '喜欢严谨设定' }),
      }));
    expect(saved.status).toBe(200);
    const winner = structuredClone(current);
    finishGeneration('本次生成稿');
    const events = await consumeSSE(await generation);
    const conflict = lastEvent(events, 'conflict');
    expect(conflict.code).toBe('PROFILE_CONFLICT');
    expect(conflict.profile).toEqual(winner);
    expect(conflict.draft).toEqual({ seeds, content: '本次生成稿' });
    expect(current).toEqual(winner);
    expect(current.seeds).toEqual(writer === 'manual' ? newSeeds : seeds);
    expect(mocks.chatRobust).toHaveBeenCalledTimes(writer === 'manual' ? 1 : 2);
    expect(mocks.saveProfileForUser.mock.calls.every((call) => call[0] === 1 && call[3] === previousVersion)).toBe(true);
  });

  it('still returns a recoverable generated draft when reloading a conflict fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getProfileForUser.mockResolvedValueOnce({ seeds, content: '原画像', updatedAt: previousVersion })
      .mockRejectedValueOnce(new Error('temporary database error'));
    mocks.saveProfileForUser.mockResolvedValue(null);
    const events = await consumeSSE(await POST(request()));
    const conflict = lastEvent(events, 'conflict');
    expect(conflict.code).toBe('PROFILE_CONFLICT');
    expect(conflict.profile).toBeNull();
    expect(conflict.draft).toEqual({ seeds, content: '有效画像😀\n喜欢严谨设定' });
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
    expect(mocks.saveProfileForUser).toHaveBeenCalledOnce();
  });

  it('returns a recognizable timeout event when the budget expires before the read finishes', async () => {
    vi.useFakeTimers();
    try {
      mocks.ensureSchema.mockReturnValue(new Promise(() => {})); // block before model/save
      const resPromise = POST(request()).then((res) => res.text());
      await vi.advanceTimersByTimeAsync(285_000);
      const body = await resPromise;
      expect(body).toMatch(/DEADLINE_EXCEEDED/);
      expect(body).toMatch(/请求预算已耗尽/);
      expect(mocks.chatRobust).not.toHaveBeenCalled();
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // 同 find：ceiling 就是 chatRobust 的总时限，220s 对推理模型的长思考流太紧。
  it('hands profile generation the full 260s ceiling, not the old 220s', async () => {
    await consumeSSE(await POST(request()));
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
    const { totalTimeoutMs } = mocks.chatRobust.mock.calls[0][2];
    expect(totalTimeoutMs).toBe(260_000);
    expect(totalTimeoutMs).toBeGreaterThan(220_000);
    expect(totalTimeoutMs + 12_000).toBeLessThan(295_000);
  });

  // F04：默认重新生成不得丢掉反馈积累的偏好。
  it('merges the current profile and this user\'s latest feedback into the default regeneration input', async () => {
    mocks.getProfileForUser.mockResolvedValue({ seeds, content: '反馈独有偏好：讨厌机械降神', updatedAt: previousVersion });
    mocks.getProfileFeedbackForUser.mockResolvedValue([
      { title: '反馈书', author: '作者', status: 'dropped', note: '讨厌机械降神' },
    ]);
    const events = await consumeSSE(await POST(request()));
    const input = mocks.chatRobust.mock.calls[0][1] as string;
    expect(input).toContain('讨厌机械降神'); // 旧 content 里的积累偏好进了模型输入
    expect(input).toContain('反馈书'); // 最新反馈的 note 也进了
    expect(input).toContain('测试书'); // 种子仍在
    expect(lastEvent(events, 'done')).toMatchObject({ feedbackCount: 1, resetFromSeeds: false });
    expect(mocks.getProfileFeedbackForUser).toHaveBeenCalledWith(1); // 只读本人（owner）反馈
  });

  it('resetFromSeeds:true keeps the legacy seed-only input and flags the override in the response', async () => {
    mocks.getProfileForUser.mockResolvedValue({ seeds, content: '反馈独有偏好：讨厌机械降神', updatedAt: previousVersion });
    const events = await consumeSSE(await POST(request('POST', { updatedAt: previousVersion, resetFromSeeds: true })));
    const input = mocks.chatRobust.mock.calls[0][1] as string;
    expect(input).not.toContain('讨厌机械降神'); // 旧行为：只按种子重写，会覆盖反馈积累
    expect(input).toContain('测试书');
    expect(mocks.getProfileFeedbackForUser).not.toHaveBeenCalled(); // reset 模式不读反馈
    expect(lastEvent(events, 'done')).toMatchObject({ resetFromSeeds: true, feedbackCount: 0 });
  });

  it('does not resurrect a withdrawn preference: only the latest effective feedback the database returns is fed in', async () => {
    // 撤回/更改后，DB 侧查询只会返回该书的「最新一行且仍具信息量」的状态；旧的那条
    // done+note（讨厌机械降神）不在返回里，路由不得把它补回来。
    mocks.getProfileForUser.mockResolvedValue({ seeds, content: '', updatedAt: previousVersion });
    mocks.getProfileFeedbackForUser.mockResolvedValue([
      { title: '反馈书', author: '作者', status: 'reading', note: '停更，先观望' },
    ]);
    await consumeSSE(await POST(request()));
    const input = mocks.chatRobust.mock.calls[0][1] as string;
    expect(input).toContain('停更，先观望');
    expect(input).not.toContain('讨厌机械降神');
  });

  it.each([0, 1, 'true', null])('rejects a non-boolean resetFromSeeds before any database access %#', async (value) => {
    const res = await POST(request('POST', { updatedAt: previousVersion, resetFromSeeds: value }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'resetFromSeeds must be a boolean' });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.getProfileForUser).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });
});
