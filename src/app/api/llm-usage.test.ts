import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LLM_USAGE_PHASES, type LlmUsagePhase } from '@/lib/llm-usage';

// 真实路由 → chatRobust → SSE/JSON → after → 真实用量写库函数，只 mock 网络与业务数据。
const mocks = vi.hoisted(() => ({
  after: vi.fn(), pending: [] as (() => Promise<void>)[],
  ensureSchema: vi.fn(), getProfileForUser: vi.fn(), saveProfileForUser: vi.fn(),
  getSql: vi.fn(), businessSql: vi.fn(), transaction: vi.fn(),
  getExcludedBookTitlesForUser: vi.fn(), persistRecommendationsForUser: vi.fn(),
  neon: vi.fn(), usageSql: vi.fn(), verifyBatch: vi.fn(), getFeedbackSnapshotForUser: vi.fn(),
}));
vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(), after: mocks.after,
}));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/db')>(),
  recordFeedbackForUser: async (userId: number, book: { title: string; author: string }, status: string, note: string, expectedVersion: number) => {
    const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    await actual.recordFeedbackForUser(userId, book, status, note, expectedVersion, async (batch) => {
      await mocks.transaction(batch(mocks.businessSql as never));
      return [];
    });
  },
  ensureSchema: mocks.ensureSchema, getProfileForUser: mocks.getProfileForUser, saveProfileForUser: mocks.saveProfileForUser,
  getSql: mocks.getSql,
  getFeedbackSnapshotForUser: mocks.getFeedbackSnapshotForUser,
  getExcludedBookTitlesForUser: mocks.getExcludedBookTitlesForUser,
  persistRecommendationsForUser: mocks.persistRecommendationsForUser,
}));
vi.mock('@/lib/douban', () => ({ verifyBatch: mocks.verifyBatch }));

// 失败行会补记目标主机 + DNS 解析结果（见 llm.ts 的 resolveUpstreamIps）。这个文件跑的是真路由、
// 真 chatRobust、真传输层失败，不钉死就会**真的去查 DNS**（最坏路径那个用例实测 6 次，
// host=llm.invalid）——单元测试不该有网络依赖，fake timers 下真实解析的回调还不会按时到达。
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const candidate = { title: '测试书', author: '作者', category: '仙侠', wordCount: '100万字', why: '设定严谨' };
const verified = { ...candidate, douban: { status: 'verified', found: true, rating: 8, doubanId: '123' } };
const item = { ...candidate, matchScore: 88, hitLikes: ['设定'], reason: '值得读', risks: '' };
const rawUsage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 50 } };
const fetchMock = vi.fn<typeof fetch>();

function contentFor(phase: LlmUsagePhase): string {
  return phase === 'find_recall' ? JSON.stringify({ candidates: [candidate] })
    : phase === 'find_rerank' ? JSON.stringify({ items: [item] }) : '完整画像😀';
}

function sse(content: string, usage: unknown = rawUsage): string {
  return event({ choices: [{ delta: { content } }] })
    + event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    + event({ id: 'completion-id', model: 'reported-model', choices: [], usage }) + 'data: [DONE]\n\n';
}

function request(path: string, body: unknown, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/' + path, {
    method: 'POST', signal, body: JSON.stringify(body),
    headers: { Authorization: 'Bearer usage-owner', 'Content-Type': 'application/json' },
  });
}

async function invoke(phase: LlmUsagePhase, signal?: AbortSignal) {
  if (phase === 'find_recall' || phase === 'find_rerank') {
    const { POST } = await import('./find/route');
    return POST(request('find', { step: phase === 'find_recall' ? 'recall' : 'rerank', query: '找书', verified: [verified] }, signal));
  }
  if (phase === 'profile') {
    const { POST } = await import('./profile/route');
    return POST(request('profile', { updatedAt: 'v1' }, signal));
  }
  const { POST } = await import('./feedback/route');
  return POST(request('feedback', { title: '测试书', status: 'done', note: '喜欢严谨设定' }, signal));
}

async function finishResponse() {
  for (const task of mocks.pending.splice(0)) await task();
}

// profile 与 find 的三步路由下行都是真 SSE；feedback 仍是 JSON。消费响应到结束以触发 onUsage/after。
async function finishRequest(phase: LlmUsagePhase, response: Response): Promise<Response> {
  if (phase === 'profile' || phase === 'find_recall' || phase === 'find_rerank') {
    expect(response.status).toBe(200);
    await response.text(); // 把流读完，start() 里的 chatRobust/写回与 after 埋点随之完成
    return response;
  }
  await response.json();
  return response;
}

// 找书与画像生成路由都发 SSE；把 SSE 响应以事件数组读出。
async function sseOf(response: Response): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for (const chunk of (await response.text()).split('\n\n')) {
    const m = chunk.match(/^data: (.+)$/m);
    if (m) events.push(JSON.parse(m[1]));
  }
  return events;
}

// Part 2 观测字段：成功且**没有**重试/降级的那一行。假时钟冻结，所以 ttfbMs 是 0。
// 这些值落在同一个 usage_details jsonb 里（零迁移），所以断言的是它的完整内容。
const observedFirstAttempt = {
  attempts: 1, firstByteTimeouts: 0, retried: false, fallbackUsed: false, ttfbMs: 0,
};

function inserts() {
  return mocks.usageSql.mock.calls
    .filter(([parts]) => (parts as TemplateStringsArray).join('').includes('INSERT INTO llm_usage'))
    .map((call) => call.slice(1));
}

describe('usage instrumentation through all model routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    vi.stubEnv('APP_OWNER_TOKEN', 'usage-owner');
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@database.invalid/test');
    vi.stubEnv('LLM_API_KEY', 'usage-test-key');
    vi.stubEnv('LLM_MODEL', 'configured-model');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.invalid/v1');
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '500');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    dns.lookup.mockReset();
    dns.lookup.mockResolvedValue([{ address: '203.0.113.7', family: 4 }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.pending.length = 0;
    mocks.after.mockImplementation((task: () => Promise<void>) => { mocks.pending.push(task); });
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfileForUser.mockResolvedValue({ seeds: [{ title: '种子书', kind: 'love' }], content: '原画像', updatedAt: 'v1' });
    mocks.saveProfileForUser.mockResolvedValue('v2');
    mocks.getExcludedBookTitlesForUser.mockResolvedValue([]);
    mocks.persistRecommendationsForUser.mockResolvedValue(undefined);
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 0, status: null, note: '' });
    mocks.getSql.mockReturnValue(Object.assign(mocks.businessSql, { transaction: mocks.transaction }));
    mocks.transaction.mockResolvedValue([]);
    mocks.verifyBatch.mockResolvedValue([verified.douban]);
    mocks.neon.mockReturnValue(mocks.usageSql);
    mocks.usageSql.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(LLM_USAGE_PHASES)('records %s after the response, including model/request metadata and cache details', async (phase) => {
    fetchMock.mockResolvedValue(new Response(sse(contentFor(phase))));
    const response = await invoke(phase);
    expect(response.status).toBe(200);
    await finishRequest(phase, response);
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.usageSql).not.toHaveBeenCalled();
    await finishResponse();
    expect(inserts()).toEqual([[
      '2026-09-15T00:00:00.000Z', phase, 'reported-model', 120, 30, 150, 50, false, 'completion-id',
      JSON.stringify({ ...rawUsage, ...observedFirstAttempt }),
    ]]);
  });

  it.each(LLM_USAGE_PHASES)('records a missing-usage call for %s without guessing from its content', async (phase) => {
    fetchMock.mockResolvedValue(new Response(sse(contentFor(phase), null)));
    const response = await invoke(phase);
    expect(response.status).toBe(200);
    await finishRequest(phase, response); // 消费流结束触发 after 埋点
    await finishResponse();
    expect(inserts()).toEqual([[
      '2026-09-15T00:00:00.000Z', phase, 'reported-model', 0, 0, 0, 0, true, 'completion-id',
      JSON.stringify(observedFirstAttempt),
    ]]);
  });

  it.each(LLM_USAGE_PHASES)('leaves %s successful when usage DDL or writes are unavailable', async (phase) => {
    fetchMock.mockResolvedValue(new Response(sse(contentFor(phase))));
    mocks.usageSql.mockRejectedValue(new Error('usage unavailable'));
    const response = await invoke(phase);
    expect(response.status).toBe(200);
    await finishRequest(phase, response);
    expect(mocks.usageSql).not.toHaveBeenCalled();
    await expect(finishResponse()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('LLM usage write failed:', expect.objectContaining({ phase }));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('usage unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not initialize or write usage storage while the find SSE is still producing content', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start(controller) { upstream = controller; } })));
    const pending = invoke('find_recall');
    await vi.advanceTimersByTimeAsync(0);
    upstream.enqueue(encoder.encode(event({ choices: [{ delta: { content: contentFor('find_recall') } }] })));
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.usageSql).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    upstream.enqueue(encoder.encode(event({ choices: [], usage: rawUsage }) + 'data: [DONE]\n\n'));
    upstream.close();
    const res = await pending;
    expect(res.status).toBe(200);
    await res.text(); // 消费流结束触发 after 埋点
    expect(mocks.usageSql).not.toHaveBeenCalled();
    await finishResponse();
    expect(inserts()).toHaveLength(1);
  });

  it('still records actual usage when model JSON fails the find output contract', async () => {
    fetchMock.mockResolvedValue(new Response(sse('not JSON')));
    const events = await sseOf(await invoke('find_recall'));
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
    expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
    await finishResponse();
    expect(inserts()[0].slice(1, 8)).toEqual(['find_recall', 'reported-model', 120, 30, 150, 50, false]);
  });

  it('records a generated draft even if another writer wins the profile version check', async () => {
    fetchMock.mockResolvedValue(new Response(sse(contentFor('profile'))));
    mocks.saveProfileForUser.mockResolvedValue(null);
    const response = await invoke('profile');
    expect(response.status).toBe(200);
    await response.text(); // 冲突以 `conflict` 事件落到流里，仍记录本次用量（含失败前已产生的生成）
    await finishResponse();
    expect(inserts()).toHaveLength(1);
  });

  it('records non-stream JSON usage returned by a compatible relay through a real route', async () => {
    fetchMock.mockResolvedValue(Response.json({
      model: 'json-model', usage: rawUsage,
      choices: [{ message: { content: '完整画像' }, finish_reason: 'stop' }],
    }));
    const response = await invoke('profile');
    expect(response.status).toBe(200);
    await response.text();
    await finishResponse();
    expect(inserts()[0].slice(1, 9)).toEqual(['profile', 'json-model', 120, 30, 150, 50, false, null]);
  });

  it('records both attempts of a successful find retry after the response', async () => {
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '5000');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(sse(contentFor('find_recall'))));
    // 完成路由模块加载后再推进重试时钟。
    const { POST } = await import('./find/route');
    const pending = POST(request('find', { step: 'recall', query: '找书' }));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).status).toBe(200);
    expect(mocks.usageSql).not.toHaveBeenCalled();
    await finishResponse();
    expect(inserts().map((values) => values.slice(3, 8))).toEqual([[0, 0, 0, 0, true], [120, 30, 150, 50, false]]);
    expect(inserts().every((values) => values[1] === 'find_recall')).toBe(true);
    // Part 2：两行都要能看出「这是同一次调用的第几次尝试」——失败行记失败族，重试行记重试。
    // HTTP 503 这条失败路径没有 code（语义结论，不是传输层族），所以第一行只有四个计数；
    // 成功的那一行还叠着上游原始 usage，所以这里用子集匹配。
    expect(inserts().map((values) => JSON.parse(values[9] as string))).toMatchObject([
      { attempts: 1, firstByteTimeouts: 0, retried: false, fallbackUsed: false },
      { attempts: 2, firstByteTimeouts: 0, retried: true, fallbackUsed: false, ttfbMs: 0 },
    ]);
  });

  it('records an interrupted invocation as missing while preserving cancellation behavior', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: '半份画像' } }] }))); },
    })));
    const pending = invoke('profile', controller.signal);
    await vi.advanceTimersByTimeAsync(10); // 让流 start() 开始读上游半份流
    controller.abort(); // 请求取消发生在模型调用中
    // 取消链路应让路由干净收尾（error 事件后关闭流），并回调缺失用量埋点。
    const body = await (await pending).text();
    expect(body).toMatch(/取消/);
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    await finishResponse();
    // 被取消的部分调用不写成一次成功生成：只有缺失用量（0 tokens）可落，绝不冒充成功。
    const all = inserts();
    if (all.length > 0) {
      expect(all[0].slice(3, 8)).toEqual([0, 0, 0, 0, true]);
    }
  });

  // Part 1 的上界就在这里：首字节超时改成「先原地重发一次再降级」之后，单次 chatRobust 最多
  // 3 次上游调用（首发 + 首字节重发 + 兜底），find 的 modelStep 最多调它 2 次 → **单步最坏 6 次**
  // （此前 4 次）。本用例把两次 chatRobust 都逼到最坏路径，钉死这个数字。
  it('首字节超时的最坏路径：单步上游调用数封顶 6（chatRobust 3 × modelStep 2）', async () => {
    // 预算必须用生产量级（260s）：兜底门槛是 120s（llm.ts MODEL_FALLBACK_MIN_BUDGET_MS），
    // 用 20s 压缩时钟的话兜底根本不会被发起，这一格就测不到「3 次」了。
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '260000');
    vi.stubEnv('LLM_ATTEMPT_TIMEOUT_MS', '1000');
    const hang = (_url: unknown, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    // 每 3 次一组：第 1、2 次是主模型（首发 + 首字节重发，都挂到 1s 的单次上限被截断），
    // 第 3 次是兜底（立刻回 524）。这样每次 chatRobust 都用满 3 次调用，且只花 2s 预算，
    // 于是 modelStep 还剩 258s（≥ MIN_SECOND_ATTEMPT_MS）会再调一次。
    let call = 0;
    fetchMock.mockImplementation((input, init) => {
      call += 1;
      return call % 3 === 0 ? Promise.resolve(new Response('', { status: 524 })) : hang(input, init);
    });
    const { POST } = await import('./find/route');
    const pending = POST(request('find', { step: 'recall', query: '找书' }));
    // 两轮最坏路径各花 2s 模拟时间（1s 首发截断 + 1s 重发截断 + 兜底即时 524），留足调度余量。
    await vi.advanceTimersByTimeAsync(6_000);
    const events = await sseOf(await pending);
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // 6 次失败（4 次挂到首字节上限 + 2 次无 cf-ray 的 524）都会去补记上游身份 —— 全部走 mock，
    // 一次真实 DNS 查询都不发生。计数同时钉住「观测只在失败路径付」：没有多出来的第 7 次。
    expect(dns.lookup).toHaveBeenCalledTimes(6);
    expect(dns.lookup.mock.calls.every(([host]) => host === 'llm.invalid')).toBe(true);
    // 端到端自证「0 次真实查询」：mock 的返回值确实落进了 usage_details——这条路径完全由
    // mock 供给，真实的 node:dns/promises 一次都没被这条链路碰到。
    await finishResponse();
    const details = inserts().map((row) => String(row[9]));
    expect(details.some((json) =>
      json.includes('"upstreamHost":"llm.invalid"') && json.includes('"resolvedIps":["203.0.113.7"]'))).toBe(true);
    // 主模型那 4 次都是同一个模型，兜底那 2 次是另一个——「换连接重发」没有变成「多换几次模型」。
    const sentModels = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model as string);
    expect(new Set(sentModels).size).toBe(2);
    expect(sentModels.filter((m) => m === sentModels[0])).toHaveLength(4);
    // 上游调用次数与错误文案都不该暴露内部模型名。
    expect(events.map((e) => JSON.stringify(e)).join(' ')).not.toContain('configured-model');
  });

  it('does not record verify or feedback operations that never invoke a model', async () => {
    const find = await import('./find/route');
    const feedback = await import('./feedback/route');
    expect((await find.POST(request('find', { step: 'verify', candidates: [candidate] }))).status).toBe(200);
    expect((await feedback.POST(request('feedback', { title: '测试书', status: 'want', note: '' }))).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.usageSql).not.toHaveBeenCalled();
  });
});
