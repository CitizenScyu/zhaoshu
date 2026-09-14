import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// 只 mock 数据库和网络：实际经过 chatRobust → SSE 解析 → 画像/反馈路由。
const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getProfile: vi.fn(), saveProfile: vi.fn(), upsertBook: vi.fn(),
  getSql: vi.fn(), sql: vi.fn(), transaction: vi.fn(),
}));
vi.mock('@/lib/db', () => mocks);

const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const token = (content: string) => event({ choices: [{ delta: { content } }] });
const finish = (reason: string) => event({ choices: [{ delta: {}, finish_reason: reason }] });
const fetchMock = vi.fn<typeof fetch>();
const seeds = [{ title: '测试书', kind: 'love' }];

function request(route: string, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/' + route, {
    method: 'POST', signal,
    headers: { Authorization: 'Bearer stream-test-owner', 'Content-Type': 'application/json' },
    ...(route === 'feedback' ? { body: JSON.stringify({
      title: '测试书', author: '作者', status: 'done', note: '喜欢世界观',
    }) } : {}),
  });
}

describe('actual SSE failure cannot overwrite a profile', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'stream-test-owner');
    vi.stubEnv('LLM_API_KEY', 'stream-test-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.invalid/v1');
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '500'); // 小于重试等待；异常应直接返回。
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfile.mockResolvedValue({ seeds, content: '原画像', updatedAt: 'original-version' });
    mocks.saveProfile.mockResolvedValue(true);
    mocks.upsertBook.mockResolvedValue(42);
    mocks.getSql.mockReturnValue(Object.assign(mocks.sql, { transaction: mocks.transaction }));
    mocks.transaction.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { name: 'length truncation', sse: token('半份画像') + finish('length') + 'data: [DONE]\n\n' },
    { name: 'upstream error', sse: token('半份画像') + event({ error: { message: 'test error' } }) },
    { name: 'malformed event', sse: token('半份画像') + 'data: {bad json\n\n' },
    { name: 'incomplete EOF', sse: token('看似完整但未结束的画像') },
    { name: 'NUL content', sse: token('画像' + String.fromCharCode(0)) + 'data: [DONE]\n\n' },
    { name: 'oversized profile', sse: token('字'.repeat(5001)) + 'data: [DONE]\n\n' },
  ])('rejects $name in both generation and feedback', async ({ sse }) => {
    fetchMock.mockImplementation(async () => new Response(sse));
    const profile = await import('./route');
    const feedback = await import('../feedback/route');
    const generated = await profile.POST(request('profile'));
    expect(generated.status).toBe(502);
    expect((await generated.json()).error).toMatch(/模型/);
    expect(mocks.saveProfile).not.toHaveBeenCalled();
    const updated = await feedback.POST(request('feedback'));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ok: true, profileUpdated: false });
    expect(mocks.transaction).toHaveBeenCalledOnce(); // 反馈仍被保存
    expect(mocks.saveProfile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps both normal completion forms working through the real routes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(token('完整生成画像') + 'data: [DONE]\n\n'))
      .mockResolvedValueOnce(new Response(token('完整更新画像') + finish('stop')));
    const profile = await import('./route');
    const feedback = await import('../feedback/route');
    expect(await (await profile.POST(request('profile'))).json()).toEqual({ content: '完整生成画像' });
    expect(await (await feedback.POST(request('feedback'))).json()).toEqual({ ok: true, profileUpdated: true });
    expect(mocks.saveProfile.mock.calls).toEqual([
      [seeds, '完整生成画像'], [seeds, '完整更新画像', 'original-version'],
    ]);
  });

  it('cancels an actual partial response without saving the profile', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    fetchMock.mockImplementation(async () => {
      queueMicrotask(() => controller.abort());
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode(token('半份画像'))); },
        cancel,
      }));
    });
    const profile = await import('./route');
    const res = await profile.POST(request('profile', controller.signal));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: '模型调用已取消。' });
    expect(mocks.saveProfile).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
