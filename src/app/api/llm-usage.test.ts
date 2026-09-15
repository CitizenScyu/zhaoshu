import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LLM_USAGE_PHASES, type LlmUsagePhase } from '@/lib/llm-usage';

// 真实路由 → chatRobust → SSE/JSON → after → 真实用量写库函数，只 mock 网络与业务数据。
const mocks = vi.hoisted(() => ({
  after: vi.fn(), pending: [] as (() => Promise<void>)[],
  ensureSchema: vi.fn(), getProfile: vi.fn(), saveProfile: vi.fn(), upsertBook: vi.fn(),
  getSql: vi.fn(), businessSql: vi.fn(), transaction: vi.fn(),
  getExcludedBookKeys: vi.fn(), getExcludedBookTitles: vi.fn(), persistRecommendations: vi.fn(),
  neon: vi.fn(), usageSql: vi.fn(), verifyBatch: vi.fn(),
}));
vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(), after: mocks.after,
}));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/db')>(),
  ensureSchema: mocks.ensureSchema, getProfile: mocks.getProfile, saveProfile: mocks.saveProfile,
  getSql: mocks.getSql, upsertBook: mocks.upsertBook,
  getExcludedBookKeys: mocks.getExcludedBookKeys, getExcludedBookTitles: mocks.getExcludedBookTitles,
  persistRecommendations: mocks.persistRecommendations,
}));
vi.mock('@/lib/douban', () => ({ verifyBatch: mocks.verifyBatch }));

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
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.pending.length = 0;
    mocks.after.mockImplementation((task: () => Promise<void>) => { mocks.pending.push(task); });
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfile.mockResolvedValue({ seeds: [{ title: '种子书', kind: 'love' }], content: '原画像', updatedAt: 'v1' });
    mocks.saveProfile.mockResolvedValue('v2');
    mocks.upsertBook.mockResolvedValue(42);
    mocks.getExcludedBookKeys.mockResolvedValue([]);
    mocks.getExcludedBookTitles.mockResolvedValue([]);
    mocks.persistRecommendations.mockResolvedValue(undefined);
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
    await response.json();
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.usageSql).not.toHaveBeenCalled();
    await finishResponse();
    expect(inserts()).toEqual([[
      '2026-09-15T00:00:00.000Z', phase, 'reported-model', 120, 30, 150, 50, false, 'completion-id', JSON.stringify(rawUsage),
    ]]);
  });

  it.each(LLM_USAGE_PHASES)('records a missing-usage call for %s without guessing from its content', async (phase) => {
    fetchMock.mockResolvedValue(new Response(sse(contentFor(phase), null)));
    expect((await invoke(phase)).status).toBe(200);
    await finishResponse();
    expect(inserts()).toEqual([[
      '2026-09-15T00:00:00.000Z', phase, 'reported-model', 0, 0, 0, 0, true, 'completion-id', '{}',
    ]]);
  });

  it.each(LLM_USAGE_PHASES)('leaves %s successful when usage DDL or writes are unavailable', async (phase) => {
    fetchMock.mockResolvedValue(new Response(sse(contentFor(phase))));
    mocks.usageSql.mockRejectedValue(new Error('usage unavailable'));
    const response = await invoke(phase);
    expect(response.status).toBe(200);
    expect(mocks.usageSql).not.toHaveBeenCalled();
    await expect(finishResponse()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('LLM usage write failed:', expect.objectContaining({ phase }), expect.any(Error));
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
    expect((await pending).status).toBe(200);
    expect(mocks.usageSql).not.toHaveBeenCalled();
    await finishResponse();
    expect(inserts()).toHaveLength(1);
  });

  it('still records actual usage when model JSON fails the find output contract', async () => {
    fetchMock.mockResolvedValue(new Response(sse('not JSON')));
    expect((await invoke('find_recall')).status).toBe(502);
    expect(mocks.persistRecommendations).not.toHaveBeenCalled();
    await finishResponse();
    expect(inserts()[0].slice(1, 8)).toEqual(['find_recall', 'reported-model', 120, 30, 150, 50, false]);
  });

  it('records a generated draft even if another writer wins the profile version check', async () => {
    fetchMock.mockResolvedValue(new Response(sse(contentFor('profile'))));
    mocks.saveProfile.mockResolvedValue(null);
    expect((await invoke('profile')).status).toBe(409);
    await finishResponse();
    expect(inserts()).toHaveLength(1);
  });

  it('records non-stream JSON usage returned by a compatible relay through a real route', async () => {
    fetchMock.mockResolvedValue(Response.json({
      model: 'json-model', usage: rawUsage,
      choices: [{ message: { content: '完整画像' }, finish_reason: 'stop' }],
    }));
    expect((await invoke('profile')).status).toBe(200);
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
  });

  it('records an interrupted invocation as missing while preserving cancellation behavior', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    fetchMock.mockImplementation(async () => {
      queueMicrotask(() => controller.abort());
      return new Response(new ReadableStream({ cancel }));
    });
    expect((await invoke('profile', controller.signal)).status).toBe(502);
    expect(mocks.saveProfile).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await finishResponse();
    expect(inserts()[0].slice(3, 8)).toEqual([0, 0, 0, 0, true]);
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
