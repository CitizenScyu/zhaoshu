import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeSseChunk, parseJson, validateProfileContent } from './llm';

// 失败行的上游身份观测（upstreamHost / resolvedIps）走的是系统 DNS。测试里必须把它钉死：
// 真做解析既慢又不确定，而且 fake timers 下连「超时兜底」那个计时器都不会自己到点。
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

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

// 逐字钉死文案：它的作用是让运维一眼看出「预算是被思考吃掉的」，不是输入太长。
const REASONING_BUDGET_MESSAGE =
  '模型把输出预算用在了思考上（推理模型的思维链与正文共享额度），正文未产出。请重试，或改用非推理模型。';

// 生产规模的单步预算（而不是把生产缺陷钉死的 20s 压缩时钟）。凡「兜底**应当**被发起」的用例
// 都必须用这个量级的预算：兜底模型 claude-opus-5-88 实测整通 89.6s（llm_usage row 214）、
// 中位 115.8s，门槛见 llm.ts MODEL_FALLBACK_MIN_BUDGET_MS。用 20s 压缩时钟测出来的「兜底成功」
// 在生产里根本不会发生——那正是 P1-1 要把测试口径掰回来的原因。
const PROD_STEP_BUDGET_MS = 200_000;

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
    dns.lookup.mockReset();
    dns.lookup.mockResolvedValue([{ address: '203.0.113.7', family: 4 }]);
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
    await expect(client.chat('system', 'user')).resolves.toMatchObject({ content: '完整内容' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('decodes UTF-8 characters and SSE lines split at every byte boundary', async () => {
    const bytes = new TextEncoder().encode(token('中文😀') + finish('stop') + 'data: [DONE]\r\n\r\n');
    fetchMock.mockResolvedValue(response(Array.from(bytes, (byte) => new Uint8Array([byte]))));
    await expect(client.chat('system', 'user')).resolves.toMatchObject({ content: '中文😀' });
  });

  it('accepts multiline SSE data and CRLF split between chunks', async () => {
    fetchMock.mockResolvedValue(response([
      'event: message\r\ndata: {"choices":\r',
      '\ndata: [{"delta":{"content":"多行"}}]}\r\n\r',
      '\n' + finish('stop').replace(/\n/g, '\r') + 'data: [DONE]\r\r',
    ]));
    await expect(client.chat('system', 'user')).resolves.toMatchObject({ content: '多行' });
  });

  it('accepts role, reasoning and usage chunks without mistaking them for completion', async () => {
    fetchMock.mockResolvedValue(response([
      ': keepalive\n\n',
      event({ choices: [{ delta: { role: 'assistant', content: null } }] }),
      event({ choices: [{ delta: { reasoning_content: '隐藏推理' } }] }),
      token('正文'), finish('stop'), event({ choices: [], usage: { total_tokens: 8 } }),
    ]));
    await expect(client.chat('system', 'user')).resolves.toMatchObject({ content: '正文' });
  });

  it.each([
    token('看似完整的正文') + finish('length') + 'data: [DONE]\n\n',
    token('看似完整的正文') + finish('length'),
  ])('rejects length truncation even when the accumulated body looks valid %#', async (sse) => {
    fetchMock.mockResolvedValue(response([sse]));
    await expect(client.chatRobust('system', 'user')).rejects.toMatchObject({
      message: REASONING_BUDGET_MESSAGE, retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // 推理模型（上游 claude-opus-5-88）把 max_tokens 花在思维链上时，finish_reason 报
  // max_tokens；它不能落进「未以完整正文结束」的兜底分支，那会误导排查方向。
  it.each(['length', 'max_tokens'])(
    'classifies finish_reason=%s as a thinking-budget exhaustion, not a generic tail %#', async (reason) => {
      fetchMock.mockResolvedValue(response([
        event({ choices: [{ delta: { reasoning_content: '长思维链' } }] }),
        finish(reason), 'data: [DONE]\n\n',
      ]));
      await expect(client.chatRobust('system', 'user')).rejects.toMatchObject({
        message: REASONING_BUDGET_MESSAGE, retryable: false,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('does not blame the input length for a truncated reasoning model answer', async () => {
    fetchMock.mockResolvedValue(response([finish('max_tokens'), 'data: [DONE]\n\n']));
    const error = await client.chat('system', 'user').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(client.LlmError);
    const message = (error as Error).message;
    expect(message).not.toMatch(/缩短输入|输入过长|长度限制被截断|未以完整正文结束/);
    expect(message).toMatch(/思考|推理模型/);
    expect(message).not.toMatch(/deepseek|claude-opus|LLM_|https?:/);
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
    await expect(client.chat('system', 'user')).resolves.toMatchObject({ content: '正文' });
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
    const assertion = expect(client.chatRobust('system', 'user')).resolves.toMatchObject({ content: '完整新画像' });
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

  it('calls onToken per content delta as it streams, before completion is known', async () => {
    fetchMock.mockResolvedValue(response([token('开头'), token('中段'), finish('stop'), 'data: [DONE]\n\n']));
    const deltas: string[] = [];
    await client.chat('system', 'user', { onToken: (d) => deltas.push(d) });
    // 每个增量在解析时即同步回调（首字节优先），不落最后一个 [DONE]。
    expect(deltas).toEqual(['开头', '中段']);
  });

  it('does not call onToken on a retry that fails before producing content', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 503 })) // 上游错误，无任何 content
      .mockResolvedValueOnce(response([token('重试成功后正文'), finish('stop')]));
    const deltas: string[] = [];
    const pending = client.chatRobust('system', 'user', { onToken: (d) => deltas.push(d) });
    await vi.advanceTimersByTimeAsync(1500); // 第一次失败后唯一的重试等待
    await expect(pending).resolves.toMatchObject({ content: '重试成功后正文' });
    expect(deltas).toEqual(['重试成功后正文']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves non-ASCII request escaping and the default max_tokens bound', async () => {
    fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n']));
    await client.chat('系统😀', '用户中文', { maxTokens: 9_000 });
    const sent = String(fetchMock.mock.calls[0][1]?.body);
    expect([...sent].every((char) => char.charCodeAt(0) <= 127)).toBe(true);
    expect(sent).toContain('\\u');
    expect(JSON.parse(sent)).toMatchObject({
      stream: true, max_tokens: 9_000,
      messages: [{ role: 'system', content: '系统😀' }, { role: 'user', content: '用户中文' }],
    });
  });

  // 兜底模型：主模型**卡住**（网关超时、首字节/停滞上限到点）时换一个已知可用的模型，
  // 而不是让整次找书失败。两族传输层失败的治法完全不同，这里是它们的判别用例。
  describe('fallback model on stalled attempts', () => {
    const sentModel = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body)).model as string;
    const FALLBACK = 'fallback/model';
    const withFallback = (totalTimeoutMs: number) => ({ totalTimeoutMs, fallbackModel: FALLBACK });
    // 昂贵的那一族：网关自己的超时，连响应头都要等到超时才回。
    const stalledResponse = (status = 524) => new Response('', { status });

    beforeEach(() => {
      // 让主模型名可预期：库读不到时回退到 LLM_MODEL。
      vi.stubEnv('LLM_MODEL', 'primary/model');
    });

    // 回归护栏：删掉兜底分支，本用例必须失败——那时第二次调用会用主模型而不是兜底模型。
    it('主模型 524 → 用剩余预算改打兜底模型并成功', async () => {
      fetchMock
        .mockResolvedValueOnce(stalledResponse())
        .mockResolvedValueOnce(response([token('兜底正文'), finish('stop')]));
      await expect(client.chatRobust('system', 'user', withFallback(PROD_STEP_BUDGET_MS)))
        .resolves.toMatchObject({ content: '兜底正文' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentModel(0)).toBe('primary/model');
      expect(sentModel(1)).toBe(FALLBACK);
    });

    it.each([408, 524])('网关超时 HTTP %i 归到「卡住」这一族，换兜底模型', async (status) => {
      fetchMock
        .mockResolvedValueOnce(stalledResponse(status))
        .mockResolvedValueOnce(response([token('兜底正文'), finish('stop')]));
      await expect(client.chatRobust('system', 'user', withFallback(PROD_STEP_BUDGET_MS)))
        .resolves.toMatchObject({ content: '兜底正文' });
      expect(sentModel(1)).toBe(FALLBACK);
    });

    // 换模型（或原地重试）占的是同一个「第二次尝试」名额，所以上游请求次数上界不变。
    // find 的 modelStep 会调用本函数最多两次 → 单步最多 4 次上游调用。
    it('兜底也卡住时如实失败，不会叠加成第三次请求', async () => {
      fetchMock.mockResolvedValue(stalledResponse());
      await expect(client.chatRobust('system', 'user', withFallback(PROD_STEP_BUDGET_MS)))
        .rejects.toThrow(/HTTP 524/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentModel(1)).toBe(FALLBACK);
    });

    // 连接层失败是**便宜**的那一族，而且换模型也没用（本机到网关的连接问题对所有模型一视同仁），
    // 所以原地重试、不换模型。变异成「连不上也降级」时本用例必须失败。
    it('连接层失败（~10s fail-fast）原地重试主模型，不换模型', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(response([token('重试成功'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', withFallback(20_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentModel(0)).toBe('primary/model');
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toMatchObject({ content: '重试成功' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentModel(1)).toBe('primary/model');
      expect(sentModel(1)).not.toBe(FALLBACK);
    });

    it('连接层失败两次就如实失败，不降级', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const assertion = expect(client.chatRobust('system', 'user', withFallback(20_000)))
        .rejects.toThrow(/LLM 请求失败/);
      await vi.advanceTimersByTimeAsync(1_500); // 便宜那族的原地重试等待
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentModel(1)).toBe('primary/model');
      expect(sentModel(1)).not.toBe(FALLBACK);
    });

    it.each([
      ['HTTP 500', () => new Response('', { status: 500 })],
      ['HTTP 503（可能是 model_not_found，换模型更糟）', () => new Response('', { status: 503 })],
      ['HTTP 429', () => new Response('', { status: 429 })],
      ['空正文', () => response([token(''), finish('stop')])],
    ])('语义结论（%s）不换模型：第二次仍打主模型', async (_name, make) => {
      fetchMock.mockImplementationOnce(() => Promise.resolve(make()))
        .mockResolvedValueOnce(response([token('重试成功'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', withFallback(20_000));
      await vi.advanceTimersByTimeAsync(1_500); // 语义失败走的是原有的重试等待
      await expect(pending).resolves.toMatchObject({ content: '重试成功' });
      expect(sentModel(1)).toBe('primary/model');
      expect(sentModel(1)).not.toBe(FALLBACK);
    });

    // Cloudflare 安全验证是**防火墙在回话**，不是没回话：照旧失败（且不可重试），不绕过它换模型。
    it('CF 安全验证拦截不换模型，也不重试', async () => {
      fetchMock.mockResolvedValue(new Response('<title>Just a moment...</title>', {
        status: 403, headers: { 'cf-mitigated': 'challenge' },
      }));
      await expect(client.chatRobust('system', 'user', withFallback(20_000)))
        .rejects.toThrow(/安全验证拦截/);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    // deadline 不变量：两次调用共享同一个截止时间，兜底拿的是剩余预算，不重获整份。
    // ⚠️ 兜底这一路**慢但持续出字**（每 50s 一个 keepalive）：chat 的缺省空闲上限是 60s，
    // 一个完全静止的兜底会先被它掐掉（空闲超时），那就测不到 deadline 本身了。生产里兜底模型
    // 正是这种形态——思维链+正文连续流 89.6~115.8s，从不会静默 60s。
    it('兜底与主模型共享同一个截止时间，总耗时不超过预算', async () => {
      const started = Date.now();
      const encoder = new TextEncoder();
      let interval: ReturnType<typeof setInterval>;
      fetchMock
        .mockResolvedValueOnce(stalledResponse())          // 主模型：瞬时 524
        .mockResolvedValueOnce(new Response(new ReadableStream({
          start(controller) { interval = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 50_000); },
          cancel() { clearInterval(interval); },
        }), { headers: { 'Content-Type': 'text/event-stream' } })); // 兜底：慢而持续，挂到预算耗尽
      const assertion = expect(client.chatRobust('system', 'user', withFallback(PROD_STEP_BUDGET_MS)))
        .rejects.toThrow(/总超时/);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const fallbackSignal = fetchMock.mock.calls[1][1]?.signal;
      await vi.advanceTimersByTimeAsync(PROD_STEP_BUDGET_MS - 1);
      expect(fallbackSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(Date.now() - started).toBe(PROD_STEP_BUDGET_MS);
      expect(fallbackSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    // 🔴 P1-1 的生产事故复现（llm_usage row 214）：主模型卡住之后「兜底只剩 29.987s」，
    // 而兜底模型 claude-opus-5-88 一次真实兜底整通 89.6s、中位 115.8s ⇒ 这次兜底注定跑不完。
    // 正确行为 = **原样抛主模型的错误码**，不发起它：发起了只会把剩余预算烧光，并把错误渲染成
    // 误导性的「LLM 总超时（剩余预算 Xs）」，用户看到「模型太慢」，真实原因是「兜底预算不够」。
    // 判别力：把 MODEL_FALLBACK_MIN_BUDGET_MS 降回 5_000（或任何 ≤30s 的值），本用例立刻变红。
    it('剩余预算不足以跑完一次兜底时不发起，原样抛主模型错误码（生产事故复现）', async () => {
      fetchMock
        .mockResolvedValueOnce(stalledResponse())
        .mockResolvedValueOnce(response([token('不该被调用的兜底正文'), finish('stop')]));
      const error = await client.chatRobust('system', 'user', withFallback(30_000)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(client.LlmError);
      expect(error).toMatchObject({ code: 'UPSTREAM_STALLED' });
      expect((error as Error).message).toMatch(/HTTP 524/);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    // 门槛本身是生产量级的：略高于兜底模型（claude-opus-5-88）实测整通中位 115.8s。
    // 低于它 = 「发起即有大于一半的概率跑不完」；5s 那种压缩时钟下的取值正是被这条钉掉的对象。
    it('兜底门槛按生产实测取值（120s），不是压缩时钟下的 5s', () => {
      expect(client.MODEL_FALLBACK_MIN_BUDGET_MS).toBe(120_000);
    });

    it('取消信号已中止时不发起兜底', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(() => {
        controller.abort();
        return Promise.resolve(stalledResponse());
      });
      await expect(client.chatRobust('system', 'user', { ...withFallback(20_000), signal: controller.signal }))
        .rejects.toMatchObject({ message: '模型调用已取消。', retryable: false });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    // 缺省不开启：不传 fallbackModel 的既有调用点（profile / feedback）行为与加兜底前一致。
    it('没传兜底模型时卡住仍按原逻辑重试主模型', async () => {
      fetchMock
        .mockResolvedValueOnce(stalledResponse())
        .mockResolvedValueOnce(response([token('重试成功'), finish('stop')]));
      const pending = client.chatRobust('system', 'user');
      await vi.advanceTimersByTimeAsync(0);
      expect(sentModel(0)).toBe('primary/model');
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toMatchObject({ content: '重试成功' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentModel(1)).toBe('primary/model');
      expect(sentModel(1)).not.toBe(FALLBACK);
    });

    it('兜底模型可配置，缺省回落到 claude-opus-5-88', () => {
      vi.stubEnv('LLM_FALLBACK_MODEL', '');
      expect(client.configuredFallbackModel()).toBe('claude-opus-5-88');
      expect(client.DEFAULT_FALLBACK_MODEL).toBe('claude-opus-5-88');
      vi.stubEnv('LLM_FALLBACK_MODEL', 'other/model');
      expect(client.configuredFallbackModel()).toBe('other/model');
    });
  });

  // 单次尝试上限：光有「失败后降级」不够——524 一次就能把整步预算啃光，兜底永远轮不到。
  // 两种都要有：首字节（防 524 那种连响应头都不给）与流内停滞（防建流后卡住）。
  describe('single-attempt deadline (first byte + in-stream stall)', () => {
    const sentModel = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body)).model as string;
    const attempts = { idleTimeoutMs: 45_000, firstByteTimeoutMs: 45_000, fallbackModel: 'fallback/model' };

    beforeEach(() => {
      vi.stubEnv('LLM_MODEL', 'primary/model');
    });

    it('首字节上限可配置，缺省 45s', () => {
      vi.stubEnv('LLM_ATTEMPT_TIMEOUT_MS', '');
      expect(client.configuredAttemptTimeoutMs()).toBe(45_000);
      expect(client.DEFAULT_ATTEMPT_TIMEOUT_MS).toBe(45_000);
      vi.stubEnv('LLM_ATTEMPT_TIMEOUT_MS', '20000');
      expect(client.configuredAttemptTimeoutMs()).toBe(20_000);
    });

    // 回归护栏（Part 1 的核心）：首字节超时**不等于**该降级——探针实测立刻重发有 53.3% 直接
    // 拿到正文。这里第二次仍是**主模型**（不是兜底）；把重发改掉/去掉，本用例立刻变红。
    it('首字节上限到点 → 先用主模型原地重发，成功就不降级', async () => {
      const started = Date.now();
      fetchMock
        .mockImplementationOnce((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }))
        .mockResolvedValueOnce(response([token('重发成功的正文'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: 20_000, idleTimeoutMs: 45_000, firstByteTimeoutMs: 2_000, fallbackModel: 'fallback/model',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(pending).resolves.toMatchObject({ content: '重发成功的正文' });
      expect(Date.now() - started).toBe(2_000);
      expect(sentModel(1)).toBe('primary/model');
      expect(sentModel(1)).not.toBe('fallback/model');
    });

    // 🔴 项 2：重发只在「预算 > 自己那一次的首字节上限」时才有意义。chat 会把首字节上限压到
    // 总时限以内，预算 ≤ 上限时两个计时器等长 → 这次重发的结局由 total 计时器决定（报文变成
    // 误导性的「总超时」，剩余预算被整段烧光）。这三条用例把三个预算区间都钉住。
    const hang = (_url: unknown, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

    // 区间 3（≥90s）：重发是实测正收益（8 起首字节事件救回 6 起），必须保留。
    // 本用例是「防退化成无条件跳过重发」的护栏。
    it('剩余预算充裕时仍发起重发，不退回兜底', async () => {
      fetchMock.mockImplementationOnce(hang).mockResolvedValueOnce(response([token('重发成功的正文'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: 200_000, idleTimeoutMs: 45_000, firstByteTimeoutMs: 45_000, fallbackModel: 'fallback/model',
      });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(pending).resolves.toMatchObject({ content: '重发成功的正文' });
      // 第二次仍是主模型 = 重发发生了；若被跳过，这里会是兜底模型。
      expect(sentModel(1)).toBe('primary/model');
    });

    // 区间 2（45s, 90s）：剩余 35s ≤ 首字节上限 45s → **不发起重发**（判定见 llm.ts chatRobust）。
    // ⚠️ 2026-09-17 P1-1 之后这一格的结局变了：兜底门槛提到生产量级（120s）后，剩余 ≤45s 也
    // **不够开一次兜底**，所以从「直接进兜底」变成「原样抛首字节错误」。这是有意的——一次跑不完的
    // 兜底只会把预算烧光并把错误码染成「总超时」。判别力：把跳重发那道门槛改回 `remainingMs() > 0`，
    // 这里会多发一次主模型请求（fetch 变 2 次），本用例必须失败。
    it('剩余预算 ≤ 首字节上限时不发起重发，也不开注定跑不完的兜底', async () => {
      fetchMock.mockImplementationOnce(hang)
        .mockResolvedValueOnce(response([token('不该被调用的兜底正文'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: 80_000, idleTimeoutMs: 45_000, firstByteTimeoutMs: 45_000, fallbackModel: 'fallback/model',
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_FIRST_BYTE_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(45_000); // 首发吃满首字节上限
      await assertion;
      expect(fetchMock).toHaveBeenCalledOnce(); // 首发一次：没有重发，也没有兜底
    });

    // 区间 1（<45s）：首字节上限被 total 压成等长，expiredBy 落成 'total' → 码是 UPSTREAM_STALLED，
    // 重发分支（只认 UPSTREAM_FIRST_BYTE_TIMEOUT）根本不进入。行为本来就对，项 2 不得改变它。
    it('剩余 < 首字节上限（等长竞态）时报 UPSTREAM_STALLED，不进入重发分支', async () => {
      fetchMock.mockImplementation(hang);
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: 40_000, idleTimeoutMs: 45_000, firstByteTimeoutMs: 45_000, fallbackModel: 'fallback/model',
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_STALLED' });
      await vi.advanceTimersByTimeAsync(40_000);
      await assertion;
      // 首发就耗尽预算，既没有重发、也没有可开的兜底（剩余 0，低于 MODEL_FALLBACK_MIN_BUDGET_MS）。
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    // 重发仍失败才降级。上界就在这里：本函数最多 3 次上游调用（首发 + 首字节重发 + 兜底），
    // find 的 modelStep 最多调本函数 2 次 → **单步最坏 6 次**（此前 4 次，见 chatRobust 注释）。
    it('首字节超时且重发也超时 → 才降级兜底；本函数上游调用数封顶 3', async () => {
      const hang = (_url: unknown, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      fetchMock
        .mockImplementationOnce(hang)
        .mockImplementationOnce(hang)
        .mockResolvedValueOnce(response([token('兜底正文'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: PROD_STEP_BUDGET_MS, idleTimeoutMs: 45_000, firstByteTimeoutMs: 2_000, fallbackModel: 'fallback/model',
      });
      await vi.advanceTimersByTimeAsync(4_000); // 首发 2s 被截断 + 重发 2s 被截断
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await expect(pending).resolves.toMatchObject({ content: '兜底正文' });
      expect([sentModel(0), sentModel(1), sentModel(2)])
        .toEqual(['primary/model', 'primary/model', 'fallback/model']);
    });

    // 这一族是「HTTP 200 + text/event-stream 已建立，TTFB 之后不再出正文」：
    // 首字节早就到了，只有流内停滞上限拦得住。
    it('建流后停滞 → 停滞上限到点后降级', async () => {
      const encoder = new TextEncoder();
      const started = Date.now();
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(new Response(new ReadableStream({
          start(controller) { controller.enqueue(encoder.encode(': keepalive\n\n')); },
        }))))
        .mockResolvedValueOnce(response([token('兜底正文'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: PROD_STEP_BUDGET_MS, idleTimeoutMs: 3_000, firstByteTimeoutMs: 45_000, fallbackModel: 'fallback/model',
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(pending).resolves.toMatchObject({ content: '兜底正文' });
      expect(Date.now() - started).toBe(3_000);
      expect(sentModel(1)).toBe('fallback/model');
    });

    // 单次尝试上限**只压主模型那一路**：兜底是最后机会，不该被同一个停滞上限误杀
    // （兜底模型是慢的推理模型，实测单步可到 220s）。变异成「兜底也套上限」时本用例必须失败。
    // 兜底这一路「慢但持续出字」——每 50s 一个 keepalive，所以它既不会被主模型的 3s 上限掐掉，
    // 也不会触发 chat 缺省的 60s 空闲上限，唯一的结束方式就是共享 deadline。
    it('兜底不套单次尝试上限：慢而持续的兜底仍能拖到共享截止时间', async () => {
      const encoder = new TextEncoder();
      let interval: ReturnType<typeof setInterval>;
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 524 }))
        .mockImplementationOnce(() => Promise.resolve(new Response(new ReadableStream({
          start(controller) { interval = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 50_000); },
          cancel() { clearInterval(interval); },
        }), { headers: { 'Content-Type': 'text/event-stream' } })));
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: PROD_STEP_BUDGET_MS, idleTimeoutMs: 3_000, firstByteTimeoutMs: 45_000, fallbackModel: 'fallback/model',
      });
      // 远超主模型的 3s 单次上限：若兜底也被套上它，这里早已以「空闲超时（3s）」失败。
      await vi.advanceTimersByTimeAsync(100_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 兜底这一路没被单次上限掐掉：它一直挂到共享的总时限才结束。
      const assertion = expect(pending).rejects.toThrow(/总超时（剩余预算 200s）/);
      await vi.advanceTimersByTimeAsync(PROD_STEP_BUDGET_MS - 100_000);
      await assertion;
    });

    // 单次尝试上限不破坏整步 deadline：截断 + 重发 + 兜底仍以 totalTimeoutMs 为上限。
    // 预算链（Part 1 之后，生产数字是 260s / 45s）：首发 45s + 首字节重发 45s + 兜底剩余 170s；
    // 这里按生产量级缩小比例 —— 首发 2s + 重发 2s + 兜底剩余 196s = 200s。
    it('单次尝试上限不破坏整步 deadline：截断 + 重发 + 兜底仍以 totalTimeoutMs 为上限', async () => {
      const started = Date.now();
      fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      // 主模型 2s 被首字节上限截断 → 原地重发 2s 又被截断 → 兜底接着挂到剩下 196s 的共享 deadline。
      // 兜底拿的是「剩余 196s」，所以它自己的超时文案里是 196s；整步墙钟仍是 200s。
      const pending = client.chatRobust('system', 'user', {
        totalTimeoutMs: PROD_STEP_BUDGET_MS, idleTimeoutMs: 45_000, firstByteTimeoutMs: 2_000, fallbackModel: 'fallback/model',
      });
      // 断言先挂上：拒绝发生在 200s，晚于下面的 advance，否则会被 vitest 记成 unhandled rejection。
      const assertion = expect(pending).rejects.toThrow(/总超时（剩余预算 196s）/);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(Date.now() - started).toBe(3_999);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(PROD_STEP_BUDGET_MS - 4_000);
      await assertion;
      expect(Date.now() - started).toBe(PROD_STEP_BUDGET_MS);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    // 不给 firstByteTimeoutMs 时行为与加这个选项之前完全一致（只受总时限约束）。
    it('不传首字节上限时不设这个计时器，仍是总超时', async () => {
      fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const assertion = expect(client.chat('system', 'user', { totalTimeoutMs: 5_000 })).rejects.toThrow(/总超时（剩余预算 5s）/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('chatRobust 的选项接受 idleTimeoutMs 与 firstByteTimeoutMs（此前类型上就传不进来）', async () => {
      // 每次给新的 Response：同一个实例读第二次会挂住（body 已被消费）。
      fetchMock.mockImplementation(() => Promise.resolve(response([token('正文'), finish('stop')])));
      await expect(client.chatRobust('system', 'user', attempts)).resolves.toMatchObject({ content: '正文' });
      await expect(client.chatRobust('system', 'user', { ...attempts, idleTimeoutMs: 4_000 }))
        .resolves.toMatchObject({ content: '正文' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // Part 2：观测字段。没有它，Part 1 上线后线上分不清「重发有没有发生、有没有成功」——
  // 失败行的 usage_details 原本恒为 {}。这些字段落进**已存在的** jsonb，零迁移。
  describe('usage_details observation fields', () => {
    const sentModel = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body)).model as string;
    const hang = (_url: unknown, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const okWithRay = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(token('重发成功的正文') + finish('stop')));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream', 'cf-ray': 'a1b2c3-ZRH' } });
    // 生产量级预算：这条链里「重发也超时才降级」那一格需要兜底真的被发起（剩余 196s > 门槛）。
    const attempts = { idleTimeoutMs: 45_000, firstByteTimeoutMs: 2_000, totalTimeoutMs: PROD_STEP_BUDGET_MS, fallbackModel: 'fallback/model' };
    const observations = (onUsage: ReturnType<typeof vi.fn>) =>
      onUsage.mock.calls.map(([call]) => call.observation);

    beforeEach(() => {
      vi.stubEnv('LLM_MODEL', 'primary/model');
    });

    it('首字节超时的两行分别记下：失败族 / 这是第几次尝试 / 有没有重发', async () => {
      const onUsage = vi.fn();
      fetchMock.mockImplementationOnce(hang).mockResolvedValueOnce(okWithRay());
      const pending = client.chatRobust('system', 'user', { ...attempts, onUsage });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ content: '重发成功的正文' });
      expect(observations(onUsage)).toEqual([
        // 第一行：失败族 + 累计首字节超时次数 1 + 还没重发过。
        // 也是**没拿到响应头**的那一族：补记目标主机与观测时刻的 DNS 解析结果，
        // 好让线上能回答「成片失败是不是同一台/同一个 IP」。
        {
          attempts: 1, firstByteTimeouts: 1, retried: false, fallbackUsed: false,
          errorCode: 'UPSTREAM_FIRST_BYTE_TIMEOUT',
          upstreamHost: 'llm.invalid', resolvedIps: ['203.0.113.7'],
        },
        // 第二行：这是第 2 次尝试、是重发；成功所以带上 ttfbMs 与 cf-ray。
        // 失败那一次没有响应头，所以它既没有 ttfbMs 也没有 cfRay——不是编的 0。
        {
          attempts: 2, firstByteTimeouts: 1, retried: true, fallbackUsed: false,
          ttfbMs: 0, cfRay: 'a1b2c3-ZRH',
        },
      ]);
    });

    it('重发也超时才降级：第三行标出 fallbackUsed，首字节超时累计到 2', async () => {
      const onUsage = vi.fn();
      fetchMock.mockImplementationOnce(hang).mockImplementationOnce(hang)
        .mockResolvedValueOnce(response([token('兜底正文'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', { ...attempts, onUsage });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toMatchObject({ content: '兜底正文' });
      expect(sentModel(2)).toBe('fallback/model');
      expect(observations(onUsage)).toEqual([
        { attempts: 1, firstByteTimeouts: 1, retried: false, fallbackUsed: false, errorCode: 'UPSTREAM_FIRST_BYTE_TIMEOUT', upstreamHost: 'llm.invalid', resolvedIps: ['203.0.113.7'] },
        { attempts: 2, firstByteTimeouts: 2, retried: true, fallbackUsed: false, errorCode: 'UPSTREAM_FIRST_BYTE_TIMEOUT', upstreamHost: 'llm.invalid', resolvedIps: ['203.0.113.7'] },
        { attempts: 3, firstByteTimeouts: 2, retried: true, fallbackUsed: true, ttfbMs: 0 },
      ]);
    });

    // 拿不到 cf-ray 就不写这个键（不是写空字符串），拿不到响应头就更不写。
    it('没有 cf-ray 的成功行不写 cfRay 键', async () => {
      const onUsage = vi.fn();
      fetchMock.mockResolvedValue(response([token('正文'), finish('stop')]));
      await expect(client.chatRobust('system', 'user', { onUsage })).resolves.toMatchObject({ content: '正文' });
      expect(observations(onUsage)).toEqual([
        { attempts: 1, firstByteTimeouts: 0, retried: false, fallbackUsed: false, ttfbMs: 0 },
      ]);
    });

    // 连接层失败（便宜的那一族）同样要能看出族：它不降级，但会走通用重发。
    it('连接层失败记 UPSTREAM_UNREACHABLE，重发那一行标 retried', async () => {
      const onUsage = vi.fn();
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(response([token('重试成功'), finish('stop')]));
      const pending = client.chatRobust('system', 'user', { ...attempts, onUsage });
      await vi.advanceTimersByTimeAsync(1_500); // 通用重发的等待
      await expect(pending).resolves.toMatchObject({ content: '重试成功' });
      expect(observations(onUsage)).toEqual([
        { attempts: 1, firstByteTimeouts: 0, retried: false, fallbackUsed: false, errorCode: 'UPSTREAM_UNREACHABLE', upstreamHost: 'llm.invalid', resolvedIps: ['203.0.113.7'] },
        { attempts: 2, firstByteTimeouts: 0, retried: true, fallbackUsed: false, ttfbMs: 0 },
      ]);
    });

    // 🔴 2026-09-17 补：HTTP 状态类失败（524/429/5xx）是**带着 cf-ray** 回来的，那正是最该看
    // colo 的一族。此前 cfRay 被 `succeeded &&` 挡着，这些行的 colo 信息整个丢掉，线上
    // 「成片失败是不是同一个 colo」无从判定。
    // 判别力：把 observationFor 里的 `cfRay ?` 改回 `succeeded && cfRay ?`，本用例必须失败。
    it('HTTP 状态失败行也记 cfRay（但没有 ttfbMs——这次调用没成功）', async () => {
      const onUsage = vi.fn();
      fetchMock.mockResolvedValue(new Response('', { status: 524, headers: { 'cf-ray': 'a1b2c3-IAD' } }));
      await expect(client.chat('system', 'user', { onUsage }))
        .rejects.toMatchObject({ code: 'UPSTREAM_STALLED' });
      // 拿到响应头 ⇒ 不再补记 host/IP（colo 比 DNS 直接），也不该多花那一次查询。
      expect(observations(onUsage)).toEqual([{ cfRay: 'a1b2c3-IAD', errorCode: 'UPSTREAM_STALLED' }]);
      expect(dns.lookup).not.toHaveBeenCalled();
    });

    // 语义类失败（截断/空正文/内容过滤）与「连到哪个边缘」无关，记 IP 只是噪音。
    it('语义类失败不记 upstreamHost/resolvedIps', async () => {
      const onUsage = vi.fn();
      fetchMock.mockResolvedValue(response([finish('length')]));
      await expect(client.chatRobust('system', 'user', { onUsage }))
        .rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED' });
      expect(observations(onUsage)).toEqual([
        { attempts: 1, firstByteTimeouts: 0, retried: false, fallbackUsed: false, errorCode: 'OUTPUT_TRUNCATED' },
      ]);
      expect(dns.lookup).not.toHaveBeenCalled();
    });

    // DNS 也拿不到时只留主机名：观测字段宁缺毋滥，不填假值。
    it('DNS 解析失败时只记 upstreamHost', async () => {
      const onUsage = vi.fn();
      dns.lookup.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
      fetchMock.mockImplementationOnce(hang);
      const pending = client.chat('system', 'user', {
        model: 'primary/model', onUsage, firstByteTimeoutMs: 2_000, totalTimeoutMs: 20_000,
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_FIRST_BYTE_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expect(observations(onUsage)[0]).toMatchObject({ upstreamHost: 'llm.invalid' });
      expect(observations(onUsage)[0]).not.toHaveProperty('resolvedIps');
    });
  });

  // 回归护栏：推理模型的思维链与正文共享 max_tokens，缺省值回到非推理模型的量级
  // （3000）就会让正文为空，用例必须失败。
  describe('output token budget', () => {
    const sentMaxTokens = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).max_tokens as number;

    it('defaults to a reasoning-model-sized budget without an explicit option', async () => {
      expect(client.configuredMaxTokens()).toBe(16_000);
      fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n']));
      await client.chat('system', 'user');
      expect(sentMaxTokens()).toBe(16_000);
      expect(sentMaxTokens()).toBeGreaterThan(3_000);
    });

    it.each([
      ['8000', 8_000],   // 合法值
      ['20000', 20_000],
      ['999999', 999_999], // 解析层面不截断，截断发生在调用方的 Math.min
      ['0', 16_000],     // 非正数回退缺省
      ['-5', 16_000],
      ['abc', 16_000],   // 非法值回退缺省
      ['', 16_000],
      ['12abc', 12],     // parseInt 前缀语义
    ])('parses LLM_MAX_TOKENS=%j as %i', (raw, expected) => {
      vi.stubEnv('LLM_MAX_TOKENS', raw);
      expect(client.configuredMaxTokens()).toBe(expected);
    });

    it('falls back to the default when LLM_MAX_TOKENS is unset', () => {
      vi.stubEnv('LLM_MAX_TOKENS', undefined as unknown as string);
      expect(client.configuredMaxTokens()).toBe(16_000);
    });

    it('honours the configured ceiling for callers that pass no value', async () => {
      vi.stubEnv('LLM_MAX_TOKENS', '2000');
      fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n']));
      await client.chat('system', 'user');
      expect(sentMaxTokens()).toBe(2_000);
    });

    it('clamps a larger caller value down to the ceiling', async () => {
      fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n']));
      await client.chat('system', 'user', { maxTokens: 999_999 });
      expect(sentMaxTokens()).toBe(16_000);
    });

    it('clamps a larger caller value down to a lowered ceiling', async () => {
      vi.stubEnv('LLM_MAX_TOKENS', '4000');
      fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n']));
      await client.chat('system', 'user', { maxTokens: 9_000 });
      expect(sentMaxTokens()).toBe(4_000);
    });

    it('lets a smaller caller value win over the ceiling', async () => {
      fetchMock.mockResolvedValue(response([token('正文'), 'data: [DONE]\n\n']));
      await client.chat('system', 'user', { maxTokens: 512 });
      expect(sentMaxTokens()).toBe(512);
    });
  });
});

describe('profile output guard', () => {
  it('preserves ordinary Markdown and allows the documented length boundary', () => {
    expect(validateProfileContent('  ## 萌点\n- 世界观😀  ')).toBe('## 萌点\n- 世界观😀');
    expect(validateProfileContent('字'.repeat(5000))).toHaveLength(5000);
  });
});
