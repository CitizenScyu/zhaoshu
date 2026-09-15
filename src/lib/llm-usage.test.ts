import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLlmUsage } from './llm-usage';
import { consumeSseChunk } from './llm';

const rawUsage = {
  prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
  prompt_tokens_details: { cached_tokens: 50 }, cache_creation_input_tokens: 12,
};
const usage = {
  promptTokens: 120, completionTokens: 30, totalTokens: 150,
  cacheTokens: 50, usageMissing: false, rawUsage,
};
const missingUsage = {
  promptTokens: 0, completionTokens: 0, totalTokens: 0,
  cacheTokens: 0, usageMissing: true, rawUsage: null,
};
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const token = (content: string) => event({ choices: [{ delta: { content } }] });
const finish = event({ choices: [{ delta: {}, finish_reason: 'stop' }] });
const completion = (reportedUsage: unknown = rawUsage) => ({
  id: 'completion-123', model: 'reported-model', usage: reportedUsage,
  choices: [{ index: 0, message: { content: '完整正文😀' }, finish_reason: 'stop' }],
});
const stream = (reportedUsage: unknown = rawUsage) => token('完整正文😀') + finish
  + event({ id: 'completion-123', model: 'reported-model', choices: [], usage: reportedUsage }) + 'data: [DONE]\n\n';

describe('token usage normalization', () => {
  it('preserves reported counts and all cache details without double counting the cache', () => {
    expect(parseLlmUsage(rawUsage)).toEqual(usage);
  });

  it.each([undefined, null, false, 'bad'])('marks absent or malformed usage %j as missing, without estimating', (value) => {
    expect(parseLlmUsage(value)).toEqual(missingUsage);
  });

  it('distinguishes explicit zero usage from missing or partial usage', () => {
    expect(parseLlmUsage({ prompt_tokens: 0, completion_tokens: 0 })).toMatchObject({ totalTokens: 0, usageMissing: false });
    expect(parseLlmUsage({ total_tokens: 9 })).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 9, usageMissing: true });
    expect(parseLlmUsage({})).toMatchObject({ totalTokens: 0, usageMissing: true });
  });

  it('adds known input/output counts only when upstream omits total_tokens', () => {
    expect(parseLlmUsage({ prompt_tokens: 12, completion_tokens: 3 }).totalTokens).toBe(15);
    expect(parseLlmUsage({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 19 }).totalTokens).toBe(19);
  });

  it.each([
    { input_tokens_details: { cached_tokens: 4 } },
    { prompt_cache_hit_tokens: 4 }, { cache_read_input_tokens: 4 }, { cached_tokens: 4 }, { cache_tokens: 4 },
    { prompt_tokens_details: { cached_tokens: 4 }, prompt_cache_hit_tokens: 4, cache_read_input_tokens: 4 },
  ])('recognizes compatible cache counters without adding aliases together %#', (cache) => {
    expect(parseLlmUsage({ prompt_tokens: 10, completion_tokens: 2, ...cache })).toMatchObject({ cacheTokens: 4, totalTokens: 12 });
  });

  it.each([-1, '12', true, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('does not treat invalid counter %j as usage', (value) => {
    expect(parseLlmUsage({ prompt_tokens: value, completion_tokens: 3 })).toMatchObject({ promptTokens: 0, totalTokens: 3, usageMissing: true });
  });

  it('exposes usage-only SSE blocks, including partial lines across chunks', () => {
    const source = event({ choices: [], usage: rawUsage });
    const first = consumeSseChunk(source.slice(0, 31), false);
    expect(first.usage).toBeUndefined();
    const rest = consumeSseChunk(first.rest + source.slice(31), false);
    expect(rest).toMatchObject({ content: '', done: false, finished: false, usage });
  });
});

describe('actual LLM response usage', () => {
  let client: typeof import('./llm');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    vi.stubEnv('LLM_API_KEY', 'usage-test-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.invalid/v1');
    vi.stubEnv('LLM_MODEL', 'configured-model');
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '5000');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    client = await import('./llm');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([true, false])('returns usage, model and request id for stream=%s', async (isStream) => {
    fetchMock.mockResolvedValue(new Response(isStream ? stream() : JSON.stringify(completion()), {
      headers: { 'Content-Type': isStream ? 'text/event-stream' : 'application/json', 'x-request-id': 'request-header-id' },
    }));
    const onUsage = vi.fn();
    expect(await client.chatRobust('系统😀', '用户', { stream: isStream, onUsage })).toEqual({
      content: '完整正文😀', usage, model: 'reported-model', requestId: 'request-header-id',
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      usage, model: 'reported-model', requestId: 'request-header-id', createdAt: '2026-09-15T00:00:00.000Z',
    });
    const body = String(fetchMock.mock.calls[0][1]?.body);
    expect([...body].every((char) => char.charCodeAt(0) <= 127)).toBe(true);
    expect(JSON.parse(body).stream).toBe(isStream);
    expect(JSON.parse(body).stream_options).toEqual(isStream ? { include_usage: true } : undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('returns zero/missing usage for stream=%s when upstream supplies none', async (isStream) => {
    fetchMock.mockResolvedValue(new Response(isStream ? stream(null) : JSON.stringify(completion(null))));
    const onUsage = vi.fn();
    expect(await client.chat('system', 'user', { stream: isStream, onUsage })).toMatchObject({ usage: missingUsage });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: missingUsage }));
  });

  it('accepts an upstream JSON response to a streaming request and retains its usage', async () => {
    fetchMock.mockResolvedValue(Response.json(completion()));
    expect(await client.chatRobust('system', 'user')).toEqual({ content: '完整正文😀', usage, model: 'reported-model', requestId: 'completion-123' });
  });

  it('reads a usage block split at every UTF-8 byte and accepts a clean EOF after stop', async () => {
    const bytes = new TextEncoder().encode(stream().replace('data: [DONE]\n\n', ''));
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    })));
    expect(await client.chat('system', 'user')).toMatchObject({ usage, content: '完整正文😀' });
  });

  it('keeps the final cumulative usage once, ignoring null usage on later chunks', async () => {
    const initial = { prompt_tokens: 120, completion_tokens: 1, total_tokens: 121 };
    fetchMock.mockResolvedValue(new Response(token('正文') + event({ choices: [], usage: initial }) + finish
      + event({ choices: [], usage: rawUsage }) + event({ choices: [], usage: rawUsage })
      + event({ choices: [], usage: null }) + 'data: [DONE]\n\n'));
    const onUsage = vi.fn();
    expect(await client.chat('system', 'user', { onUsage })).toMatchObject({ usage });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('retains usage from a rejected response without relaxing EOF validation', async () => {
    fetchMock.mockResolvedValue(new Response(token('部分正文') + event({ choices: [], usage: rawUsage })));
    const onUsage = vi.fn();
    await expect(client.chat('system', 'user', { onUsage })).rejects.toThrow(/结束标记之前中断/);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage }));
  });

  it('records usage before rejecting a length-truncated response in the same SSE event', async () => {
    fetchMock.mockResolvedValue(new Response(token('部分正文') + event({
      choices: [{ delta: {}, finish_reason: 'length' }], usage: rawUsage,
    })));
    const onUsage = vi.fn();
    await expect(client.chatRobust('system', 'user', { onUsage })).rejects.toMatchObject({ retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage }));
  });

  it('reports both attempts of a retry instead of dropping or double-counting the first', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(stream()));
    const onUsage = vi.fn();
    const pending = client.chatRobust('system', 'user', { onUsage });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toMatchObject({ usage });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls.map(([call]) => call.usage)).toEqual([missingUsage, usage]);
  });

  it('preserves reported usage of a failed first attempt and returns only the successful content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(token('丢弃的半份') + event({ choices: [], usage: rawUsage })))
      .mockResolvedValueOnce(new Response(stream()));
    const onUsage = vi.fn();
    const pending = client.chatRobust('system', 'user', { onUsage });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toMatchObject({ content: '完整正文😀' });
    expect(onUsage.mock.calls.map(([call]) => call.usage)).toEqual([usage, usage]);
  });

  it('does not let an instrumentation callback failure trigger a retry or lose content', async () => {
    fetchMock.mockResolvedValue(new Response(stream()));
    const onUsage = vi.fn(() => { throw new Error('recorder unavailable'); });
    expect(await client.chatRobust('system', 'user', { onUsage })).toMatchObject({ content: '完整正文😀' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith('LLM usage callback failed:', expect.any(Error));
  });

  it.each(['length', 'content_filter', 'tool_calls', 'unknown'])('retains completion protection for non-stream finish_reason=%s', async (reason) => {
    const body = completion();
    body.choices[0].finish_reason = reason;
    fetchMock.mockResolvedValue(Response.json(body));
    const onUsage = vi.fn();
    await expect(client.chatRobust('system', 'user', { stream: false, onUsage })).rejects.toMatchObject({ retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage }));
  });

  it.each(['', 'bad\u0000', '字'.repeat(64 * 1024 + 1)])('rejects invalid complete non-stream content %#', async (content) => {
    const body = completion();
    body.choices[0].message.content = content;
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(client.chat('system', 'user', { stream: false })).rejects.toThrow(/空正文或非法字符|输出过长/);
  });

  it.each(['cancel', 'timeout'])('bounds a non-stream response whose reader ignores AbortSignal: %s', async (action) => {
    const cancel = vi.fn();
    const controller = new AbortController();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const onUsage = vi.fn();
    const pending = client.chat('system', 'user', { stream: false, signal: controller.signal, totalTimeoutMs: 100, onUsage });
    const assertion = expect(pending).rejects.toThrow(action === 'cancel' ? /已取消/ : /总超时/);
    await vi.advanceTimersByTimeAsync(1);
    if (action === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(99);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: missingUsage }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not record a request that was cancelled before reaching the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const onUsage = vi.fn();
    await expect(client.chatRobust('system', 'user', { signal: controller.signal, onUsage })).rejects.toThrow(/已取消/);
    expect(onUsage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
