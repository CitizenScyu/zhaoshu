import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// 只 mock 数据库和网络：实际经过 chatRobust → SSE 解析 → 画像/反馈路由。
const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getProfileForUser: vi.fn(), saveProfileForUser: vi.fn(),
  getSql: vi.fn(), sql: vi.fn(), transaction: vi.fn(), getFeedbackSnapshotForUser: vi.fn(),
}));
vi.mock('@/lib/db', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/db')>(), ...mocks, recordFeedbackForUser: async (userId: number, book: { title: string; author: string }, status: string, note: string, expectedVersion: number) => {
    const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    await actual.recordFeedbackForUser(userId, book, status, note, expectedVersion, async (batch) => {
      await mocks.transaction(batch(mocks.sql as never));
      return [];
    });
  },
  }));

const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const token = (content: string) => event({ choices: [{ delta: { content } }] });
const finish = (reason: string) => event({ choices: [{ delta: {}, finish_reason: reason }] });
const fetchMock = vi.fn<typeof fetch>();
const seeds = [{ title: '测试书', kind: 'love' }];
const previousVersion = '2026-09-15 00:00:00.123456+00';
const nextVersion = '2026-09-15 00:00:00.123457+00';

function request(route: string, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/' + route, {
    method: 'POST', signal,
    headers: { Authorization: 'Bearer stream-test-owner', 'Content-Type': 'application/json' },
    ...(route === 'feedback' ? { body: JSON.stringify({
      title: '测试书', author: '作者', status: 'done', note: '喜欢世界观',
    }) } : { body: JSON.stringify({ updatedAt: previousVersion }) }),
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
    mocks.getProfileForUser.mockResolvedValue({ seeds, content: '原画像', updatedAt: previousVersion });
    mocks.saveProfileForUser.mockResolvedValue(nextVersion);
    mocks.getSql.mockReturnValue(Object.assign(mocks.sql, { transaction: mocks.transaction }));
    mocks.transaction.mockResolvedValue([]);
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 0, status: null, note: '' });
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
  ])('rejects $name as a stream error event in generation, saving nothing; feedback still saves', async ({ sse }) => {
    fetchMock.mockImplementation(async () => new Response(sse));
    const profile = await import('./route');
    const feedback = await import('../feedback/route');
    // 生成路由：下行是真 SSE，最严苛错误落到 `event:error`，正常 stream 结束时结算。
    const events = await consumeSSE(await profile.POST(request('profile')));
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(String(error?.message)).toMatch(/模型|画像|无效|超时|截断|正文/);
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    const updated = await feedback.POST(request('feedback'));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ok: true, profileUpdated: false });
    expect(mocks.transaction).toHaveBeenCalledOnce(); // 反馈仍被保存
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps both normal completion forms working through the real routes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(token('完整生成画像') + 'data: [DONE]\n\n'))
      .mockResolvedValueOnce(new Response(token('完整更新画像') + finish('stop')));
    const profile = await import('./route');
    const feedback = await import('../feedback/route');
    expect((await consumeSSE(await profile.POST(request('profile')))).find((e) => e.type === 'done'))
      .toEqual({ type: 'done', seeds, content: '完整生成画像', updatedAt: nextVersion });
    expect(await (await feedback.POST(request('feedback'))).json()).toEqual({ ok: true, profileUpdated: true, updatedAt: nextVersion });
    expect(mocks.saveProfileForUser.mock.calls).toEqual([
      [1, seeds, '完整生成画像', previousVersion, expect.any(Function)], [1, seeds, '完整更新画像', previousVersion, expect.any(Function)],
    ]);
  });

  it('emits the first token frame before the full profile is complete (first byte arrives early)', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(token('开') + token('头') + token('正文') + 'data: [DONE]\n\n'));
    const profile = await import('./route');
    const events = await consumeSSE(await profile.POST(request('profile')));
    const bodies = events.filter((e) => e.type === 'token');
    expect(bodies.length).toBeGreaterThan(0);
    // 首个 token 帧在 done 之前到达，且逐字首字节可独立消费。
    const doneIndex = events.findIndex((e) => e.type === 'done');
    expect(bodies.every((e) => events.indexOf(e) < doneIndex)).toBe(true);
    expect(bodies.map((e) => e.content).join('')).toBe('开头正文');
  });

  it('cancels an actual partial response without saving or retrying the profile', async () => {
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
    // 请求侧已取消：路由 dispose deadline 并尝试干净关闭；客户端撤流，绝不能落库/重试。
    await res.body?.cancel().catch(() => {});
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce(); // 取消后不再发起后续调用（无重试）
  });
});

// 生成路由的下行解析：从 SSE 响应体收集事件。
async function consumeSSE(res: Response): Promise<Record<string, unknown>[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const text = await res.text();
  const events: Record<string, unknown>[] = [];
  for (const chunk of text.split('\n\n')) {
    const m = chunk.match(/^data: (.+)$/m);
    if (m) events.push(JSON.parse(m[1]));
  }
  return events;
}
