import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getProfile: vi.fn(), saveProfile: vi.fn(), chatRobust: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  ensureSchema: mocks.ensureSchema, getProfile: mocks.getProfile, saveProfile: mocks.saveProfile,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: mocks.chatRobust,
}));
import { LlmError } from '@/lib/llm';
import { POST, PUT } from './route';

const seeds = [{ title: '测试书', author: '作者', kind: 'love' }];
function request(method = 'POST', body?: unknown, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/profile', {
    method, signal, headers: { Authorization: 'Bearer profile-test-owner', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('/api/profile writes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'profile-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfile.mockResolvedValue({ seeds, content: '原画像', updatedAt: 'previous-version' });
    mocks.saveProfile.mockResolvedValue(true);
    mocks.chatRobust.mockResolvedValue('  有效画像😀\n喜欢严谨设定  ');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('saves valid generated markdown and passes cancellation to the model', async () => {
    const req = request();
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: '有效画像😀\n喜欢严谨设定' });
    expect(mocks.saveProfile).toHaveBeenCalledWith(seeds, '有效画像😀\n喜欢严谨设定');
    expect(mocks.chatRobust.mock.calls[0][2].signal).toBe(req.signal);
  });

  it.each(['', ' \n ', null, false, '字'.repeat(5_001), 'bad' + String.fromCharCode(0), '\ud800', '\udc00'])(
    'returns 502 without saving invalid model profile %#', async (content) => {
      mocks.chatRobust.mockResolvedValue(content);
      const res = await POST(request());
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/画像为空、过长或含非法字符/);
      expect(mocks.saveProfile).not.toHaveBeenCalled();
    },
  );

  it.each(['长度截断', '上游错误', '坏 SSE 事件', '无终止标记 EOF', '调用已取消'])(
    'returns 502 without saving after %s', async (message) => {
      mocks.chatRobust.mockRejectedValue(new LlmError(message, false));
      const res = await POST(request());
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: message });
      expect(mocks.saveProfile).not.toHaveBeenCalled();
    },
  );

  it('does not save if cancellation arrives as the model returns', async () => {
    const controller = new AbortController();
    mocks.chatRobust.mockImplementation(async () => {
      controller.abort();
      return '有效画像';
    });
    expect((await POST(request('POST', undefined, controller.signal))).status).toBe(502);
    expect(mocks.saveProfile).not.toHaveBeenCalled();
  });

  it.each(['bad' + String.fromCharCode(0), '\ud800', '\udc00'])(
    'rejects illegal manual body text before touching the database %#', async (content) => {
      const res = await PUT(request('PUT', { seeds, content }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'content contains invalid characters' });
      expect(mocks.ensureSchema).not.toHaveBeenCalled();
      expect(mocks.saveProfile).not.toHaveBeenCalled();
    },
  );

  it('retains the manual empty-profile contract', async () => {
    expect((await PUT(request('PUT', { seeds, content: '' }))).status).toBe(200);
    expect(mocks.saveProfile).toHaveBeenCalledWith(seeds, '');
  });
});
