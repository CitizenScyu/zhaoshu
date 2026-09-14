import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeSseChunk, parseJson, validateProfileContent } from './llm';

describe('parseJson', () => {
  it('parses bare JSON object', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a ```json fenced block', () => {
    const text = '```json\n{"candidates":[]}\n```';
    expect(parseJson(text)).toEqual({ candidates: [] });
  });

  it('parses a bare ``` fenced block', () => {
    const text = '```\n[1,2,3]\n```';
    expect(parseJson(text)).toEqual([1, 2, 3]);
  });

  it('extracts JSON surrounded by prose', () => {
    const text = '好的,这是结果:\n{"items":[{"title":"X"}]}\n希望有帮助!';
    expect(parseJson(text)).toEqual({ items: [{ title: 'X' }] });
  });

  it('extracts a top-level array surrounded by prose', () => {
    const text = 'result: [{"a":1},{"a":2}] done';
    expect(parseJson(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseJson('没有 JSON 在这里')).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => parseJson('   ')).toThrow();
  });
});

describe('consumeSseChunk', () => {
  const evt = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;

  it('accumulates content from complete lines and keeps the partial line as rest', () => {
    const buf = evt('你好') + evt('世界') + 'data: {"choices":[{"delta":{"con';
    const out = consumeSseChunk(buf, false);
    expect(out.content).toBe('你好世界');
    expect(out.rest).toBe('data: {"choices":[{"delta":{"con');
    expect(out.done).toBe(false);
  });

  it('stops at [DONE] and reports done', () => {
    const out = consumeSseChunk(evt('hi') + 'data: [DONE]\n' + evt('ignored'), false);
    expect(out.content).toBe('hi');
    expect(out.done).toBe(true);
  });

  it('rejects malformed data events instead of accepting the remaining text', () => {
    expect(() => consumeSseChunk('data: {not json\n\n' + evt('ok'), false)).toThrow(/无效.*SSE/);
  });

  it('ignores non-data lines and comment lines', () => {
    const out = consumeSseChunk('\n: keepalive\n' + evt('x'), false);
    expect(out.content).toBe('x');
  });

  it('rejects an incomplete JSON event at EOF', () => {
    expect(() => consumeSseChunk('data: {"choices":[{"delta":{"content":"par', true)).toThrow(/无效.*SSE/);
  });

  it('handles an event with a missing content delta', () => {
    const out = consumeSseChunk(
      'data: {"choices":[{"delta":{}}]}\n' + evt('after'),
      false,
    );
    expect(out.content).toBe('after');
  });
});

const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const token = (content: unknown) => event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = (reason: string) => event({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

function response(parts: (string | Uint8Array)[], keepOpen = false, cancel = vi.fn()) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
      if (!keepOpen) controller.close();
    },
    cancel,
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('stream completion and shared call budget', () => {
  let client: typeof import('./llm');
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    vi.stubEnv('LLM_API_KEY', 'test-only-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.invalid/v1');
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

  it.each([
    token('完整内容') + 'data: [DONE]\n\n',
    token('完整内容') + 'data: [DONE]',
    token('完整内容') + finish('stop'),
    token('完整内容') + finish('stop') + event({ choices: [], usage: { total_tokens: 9 } }) + 'data: [DONE]\n\n',
  ])('accepts explicitly completed compatible stream %#', async (sse) => {
    fetchMock.mockResolvedValue(response([sse]));
    await expect(client.chat('system', 'user')).resolves.toBe('完整内容');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('decodes UTF-8 characters and SSE lines split at every byte boundary', async () => {
    const bytes = new TextEncoder().encode(token('中文😀') + finish('stop') + 'data: [DONE]\r\n\r\n');
    fetchMock.mockResolvedValue(response(Array.from(bytes, (byte) => new Uint8Array([byte]))));
    await expect(client.chat('system', 'user')).resolves.toBe('中文😀');
  });

  it('accepts multiline SSE data and CRLF split between chunks', async () => {
    fetchMock.mockResolvedValue(response([
      'event: message\r\ndata: {"choices":\r',
      '\ndata: [{"delta":{"content":"多行"}}]}\r\n\r',
      '\n' + finish('stop').replace(/\n/g, '\r') + 'data: [DONE]\r\r',
    ]));
    await expect(client.chat('system', 'user')).resolves.toBe('多行');
  });

  it('accepts role, reasoning and usage chunks without mistaking them for completion', async () => {
    fetchMock.mockResolvedValue(response([
      ': keepalive\n\n',
      event({ choices: [{ delta: { role: 'assistant', content: null } }] }),
      event({ choices: [{ delta: { reasoning_content: '隐藏推理' } }] }),
      token('正文'), finish('stop'), event({ choices: [], usage: { total_tokens: 8 } }),
    ]));
    await expect(client.chat('system', 'user')).resolves.toBe('正文');
  });

  it.each([
    token('看似完整的正文') + finish('length') + 'data: [DONE]\n\n',
    token('看似完整的正文') + finish('length'),
  ])('rejects length truncation even when the accumulated body looks valid %#', async (sse) => {
    fetchMock.mockResolvedValue(response([sse]));
    await expect(client.chatRobust('system', 'user')).rejects.toMatchObject({
      message: expect.stringContaining('长度限制被截断'), retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    event({ error: { message: 'secret-upstream-detail' } }),
    'event: error\ndata: {"message":"secret-upstream-detail"}\n\n',
    event({ type: 'error', message: 'secret-upstream-detail' }),
    event({ choices: [{ error: 'secret-upstream-detail' }] }),
  ])('rejects upstream error events without leaking their contents %#', async (sse) => {
    fetchMock.mockResolvedValue(response([token('部分正文'), sse, 'data: [DONE]\n\n']));
    await expect(client.chat('system', 'user')).rejects.toMatchObject({
      message: '模型服务返回了错误事件，请重试。',
    });
  });

  it.each([
    'data: {broken json\n\n',
    'data: {"choices":',
    event(null),
    event([]),
    event({}),
    event({ choices: 'bad' }),
    event({ choices: [null] }),
    event({ choices: [{ delta: { content: false } }] }),
    event({ choices: [{ delta: { content: {} } }] }),
    event({ choices: [{ delta: [] }] }),
    event({ choices: [{ index: 1, delta: { content: 'wrong choice' } }] }),
  ])('does not silently discard malformed SSE %#', async (bad) => {
    fetchMock.mockResolvedValue(response([token('部分正文'), bad]));
    await expect(client.chat('system', 'user')).rejects.toThrow(/无效.*SSE/);
  });

  it.each(['tool_calls', 'function_call', 'content_filter', 'unknown'])(
    'does not accept finish_reason=%s as complete text', async (reason) => {
      fetchMock.mockResolvedValue(response([token('部分正文'), finish(reason), 'data: [DONE]\n\n']));
      await expect(client.chatRobust('system', 'user')).rejects.toMatchObject({ retryable: false });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('rejects tool deltas even if a relay ends with only DONE', async () => {
    fetchMock.mockResolvedValue(response([
      token('部分正文'), event({ choices: [{ delta: { tool_calls: [{ id: 'tool' }] } }] }), 'data: [DONE]\n\n',
    ]));
    await expect(client.chat('system', 'user')).rejects.toThrow(/工具调用/);
  });

  it.each([
    token('看似完整的 Markdown'),
    token('{"candidates":[]}'),
    token('部分正文') + event({ choices: [], usage: { total_tokens: 4 } }),
  ])('rejects EOF without an explicit completion marker %#', async (sse) => {
    fetchMock.mockResolvedValue(response([sse]));
    await expect(client.chat('system', 'user')).rejects.toThrow(/结束标记之前中断/);
  });

  it('does not accept a damaged or contradictory tail after finish_reason=stop', async () => {
    for (const tail of ['data: {', token('意外的新正文'), event({ error: 'late failure' }), finish('length')]) {
      fetchMock.mockResolvedValue(response([token('正文'), finish('stop'), tail]));
      await expect(client.chat('system', 'user')).rejects.toBeInstanceOf(client.LlmError);
    }
  });

  it.each(['', ' \n ', 'bad' + String.fromCharCode(0), '\ud800', '\udc00'])(
    'rejects empty or database-illegal completed content %#', async (content) => {
      fetchMock.mockResolvedValue(response([token(content), 'data: [DONE]\n\n']));
      await expect(client.chat('system', 'user')).rejects.toThrow(/空正文或非法字符/);
    },
  );

  it('rejects invalid UTF-8 instead of saving replacement characters', async () => {
    fetchMock.mockResolvedValue(response([new Uint8Array([0xff]), 'data: [DONE]\n\n']));
    await expect(client.chat('system', 'user')).rejects.toBeInstanceOf(client.LlmError);
  });

  it('cancels the upstream reader after DONE without waiting for its socket to close', async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n'], true, cancel));
    await expect(client.chat('system', 'user')).resolves.toBe('正文');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not fetch or retry when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client.chatRobust('system', 'user', { signal: controller.signal }))
      .rejects.toMatchObject({ message: '模型调用已取消。', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a stalled reader immediately and never retries cancellation', async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    fetchMock.mockResolvedValue(response([token('部分正文')], true, cancel));
    const pending = client.chatRobust('system', 'user', { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ message: '模型调用已取消。', retryable: false });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces idle timeout even on an upstream reader that ignores AbortSignal', async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(response([], true, cancel));
    const assertion = expect(client.chat('system', 'user', { idleTimeoutMs: 100, totalTimeoutMs: 1000 }))
      .rejects.toThrow(/空闲超时/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continuous keepalives cannot extend the total budget', async () => {
    const encoder = new TextEncoder();
    let interval: ReturnType<typeof setInterval>;
    const cancel = vi.fn(() => clearInterval(interval));
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { interval = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 20); },
      cancel,
    })));
    const assertion = expect(client.chat('system', 'user', { idleTimeoutMs: 50, totalTimeoutMs: 200 }))
      .rejects.toThrow(/总超时/);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one budget across the first request, retry delay and stalled retry', async () => {
    const started = Date.now();
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(new Response('', { status: 503 })), 1000)))
      .mockResolvedValueOnce(response([], true));
    const assertion = expect(client.chatRobust('system', 'user')).rejects.toThrow(/总超时/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retrySignal = fetchMock.mock.calls[1][1]?.signal;
    await vi.advanceTimersByTimeAsync(2499);
    expect(retrySignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(Date.now() - started).toBe(5000);
    expect(retrySignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry after the total budget has expired during retry scheduling', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    const assertion = expect(client.chatRobust('system', 'user')).rejects.toThrow(/HTTP 503/);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date(Date.now() + 5000));
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cancels during retry delay without starting a second request', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    const assertion = expect(client.chatRobust('system', 'user', { signal: controller.signal }))
      .rejects.toThrow(/已取消/);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries incomplete EOF once and returns only the complete second response', async () => {
    fetchMock
      .mockResolvedValueOnce(response([token('丢弃的半份画像')]))
      .mockResolvedValueOnce(response([token('完整新画像'), 'data: [DONE]\n\n']));
    const assertion = expect(client.chatRobust('system', 'user')).resolves.toBe('完整新画像');
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps an oversized configured budget below the 295-second model route limit', async () => {
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '999999');
    const started = Date.now();
    const encoder = new TextEncoder();
    let interval: ReturnType<typeof setInterval>;
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { interval = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 20000); },
      cancel() { clearInterval(interval); },
    })));
    const assertion = expect(client.chatRobust('system', 'user')).rejects.toThrow(/总超时/);
    await vi.advanceTimersByTimeAsync(285000);
    await assertion;
    expect(Date.now() - started).toBe(285000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves non-ASCII request escaping and bounded max_tokens', async () => {
    fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n']));
    await client.chat('系统😀', '用户中文', { maxTokens: 9000 });
    const sent = String(fetchMock.mock.calls[0][1]?.body);
    expect([...sent].every((char) => char.charCodeAt(0) <= 127)).toBe(true);
    expect(sent).toContain('\\u');
    expect(JSON.parse(sent)).toMatchObject({
      stream: true, max_tokens: 3000,
      messages: [{ role: 'system', content: '系统😀' }, { role: 'user', content: '用户中文' }],
    });
  });
});

describe('profile output guard', () => {
  it('preserves ordinary Markdown and allows the documented length boundary', () => {
    expect(validateProfileContent('  ## 萌点\n- 世界观😀  ')).toBe('## 萌点\n- 世界观😀');
    expect(validateProfileContent('字'.repeat(5000))).toHaveLength(5000);
  });
});
