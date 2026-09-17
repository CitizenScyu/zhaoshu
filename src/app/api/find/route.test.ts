import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { bookKey } from '@/lib/sanitize';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getProfileForUser: vi.fn(),
  getExcludedBookKeysForUser: vi.fn(),
  getExcludedBookTitlesForUser: vi.fn(),
  persistRecommendationsForUser: vi.fn(),
  chatRobust: vi.fn(),
  verifyBatch: vi.fn(),
  supplementSourceEvidence: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  ensureSchema: mocks.ensureSchema,
  getProfileForUser: mocks.getProfileForUser,
  getExcludedBookKeysForUser: mocks.getExcludedBookKeysForUser,
  getExcludedBookTitlesForUser: mocks.getExcludedBookTitlesForUser,
  persistRecommendationsForUser: mocks.persistRecommendationsForUser,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: async (...args: unknown[]) => ({ content: await mocks.chatRobust(...args) }),
}));
vi.mock('@/lib/douban', () => ({ verifyBatch: mocks.verifyBatch }));
vi.mock('@/lib/source-verification', () => ({ supplementSourceEvidence: mocks.supplementSourceEvidence }));
import { LlmError } from '@/lib/llm';
import { POST } from './route';

const candidate = {
  title: '测试书', author: '作者甲', category: '仙侠', wordCount: '100万字', why: '原始理由',
};
const douban = { status: 'verified', found: true, rating: 8, doubanId: '123' };
const verified = { ...candidate, douban };
const item = { ...candidate, matchScore: 88, hitLikes: ['设定'], reason: '值得读', risks: '' };

function request(body: unknown) {
  return new NextRequest('http://localhost/api/find', {
    method: 'POST',
    headers: { Authorization: 'Bearer find-test-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 找书路由的下行是真 SSE：事件 `data: <json>\n\n`；错误以 `error` 事件结算（HTTP 仍是 200）。
async function sseEvents(body: string): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for (const chunk of body.split('\n\n')) {
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

async function consumeSSE(res: Response): Promise<Record<string, unknown>[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  return sseEvents(await res.text());
}

describe('POST /api/find output contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'find-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfileForUser.mockResolvedValue({ seeds: [], content: '画像' });
    mocks.getExcludedBookKeysForUser.mockResolvedValue([]);
    mocks.getExcludedBookTitlesForUser.mockResolvedValue([]);
    mocks.persistRecommendationsForUser.mockResolvedValue(undefined);
    mocks.verifyBatch.mockImplementation(async (candidates: unknown[]) => candidates.map(() => douban));
    mocks.supplementSourceEvidence.mockImplementation(async (candidates) => candidates);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before accessing data or the model', async () => {
    const req = request({ step: 'recall', query: '找书' });
    req.headers.delete('Authorization');
    expect((await POST(req)).status).toBe(401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  // 根**不是**对象也不是数组（含解析失败）→ 仍是格式错误。空数组根不在这里：
  // 它算「书单为空」，报的是字段/数量那条（见下面「尽力收容」用例）。
  it.each(['recall', 'rerank'])('returns an error event for invalid %s JSON and root shapes', async (step) => {
    for (const raw of ['null', '"text"', '42', 'false', '{bad json', '{"items":']) {
      mocks.chatRobust.mockResolvedValue(raw);
      const res = await POST(request({ step, query: '找书', verified: [verified] }));
      const events = await consumeSSE(res);
      expect(lastEvent<{ type: string; code: string; message: string }>(events, 'error').message).toMatch(/模型.*JSON/);
      expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
    }
  });

  it.each([
    { step: 'recall', field: 'candidates' },
    { step: 'rerank', field: 'items' },
  ])('validates the $field field as an error event', async ({ step, field }) => {
    // 数量超限**不再**报错：modelList 截断、下游 sanitize 本来就会 slice（见「尽力收容」用例）。
    for (const list of [undefined, null, false, {}, 'wrong', []]) {
      mocks.chatRobust.mockResolvedValue(JSON.stringify({ [field]: list }));
      const events = await consumeSSE(await POST(request({ step, query: '找书', verified: [verified] })));
      expect(lastEvent<{ type: string; message: string }>(events, 'error').message).toMatch(/字段或数量/);
      expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
    }
  });

  // 🔴 项 1：根直接是数组（不同模型族常见的「少包一层」）不再丢掉整份输出。
  // 2026-09-17 那次线上失败就是「兜底模型交了完整正文，modelList 的形状校验把它整份丢掉
  // 并触发重跑整步」。判别力：把 modelList 改回 `!isRecord(parsed)` 即抛，本用例必须失败。
  it('salvages a root-level array instead of discarding the whole answer', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify([candidate]));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ candidates: unknown[] }>(events, 'result').candidates).toEqual([{ ...candidate, source: 'llm' }]);
    // 关键护栏：收容成功 = 不再白烧剩余预算重跑整步。
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  it('salvages a root-level array for rerank too', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify([{ ...item, matchScore: 80 }]));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    expect(lastEvent<{ items: unknown[] }>(events, 'result').items).toHaveLength(1);
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  // 数量超限：截断而不是抛。下游 sanitizeCandidates / sanitizeRerankedItems 第一行就是
  // slice(0, MAX_CANDIDATES / MAX_RERANKED_ITEMS)，所以这里再抛一次是重复且更严格的校验。
  // 判别力：把 `list.length > max` 改回抛错，本用例必须失败（会变成 LLM_ERROR + 调用 2 次）。
  it('truncates an over-long candidates list to 12 instead of throwing it away', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({
      candidates: Array.from({ length: 13 }, (_, i) => ({ ...candidate, title: `书${i}` })),
    }));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ candidates: unknown[] }>(events, 'result').candidates).toHaveLength(12);
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  it('truncates an over-long items list to 10 instead of throwing it away', async () => {
    // rerank 的输出要能按书名+作者关联回输入集合，所以这里造 11 本互不相同的已验证作品。
    const books = Array.from({ length: 11 }, (_, i) => ({ ...verified, title: `书${i}` }));
    mocks.chatRobust.mockResolvedValue(JSON.stringify({
      items: books.map((book) => ({ ...item, title: book.title })),
    }));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: books })));
    expect(lastEvent<{ items: unknown[] }>(events, 'result').items).toHaveLength(10);
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  // 收容也有底线：空数组不是「可收容」的形状，仍报字段/数量错。
  it('still rejects an empty root array (empty is not a salvageable shape)', async () => {
    mocks.chatRobust.mockResolvedValue('[]');
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ code: string; message: string }>(events, 'error').message).toMatch(/字段或数量/);
  });

  // 项 1b（已批准、收窄）：字段**缺失**且对象里恰好只有一个非空数组属性 → 认它是书单。
  // 覆盖「兜底模型用了别的字段名」这一族（task-50 推断的两个候选之一）。
  it('salvages a differently-named field when it is the only non-empty array', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ books: [candidate] }));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ candidates: unknown[] }>(events, 'result').candidates).toEqual([{ ...candidate, source: 'llm' }]);
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  it('salvages a differently-named field for rerank too', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ ranking: [{ ...item, matchScore: 80 }] }));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    expect(lastEvent<{ items: unknown[] }>(events, 'result').items).toHaveLength(1);
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  // 收窄条件必须钉住：**恰好一个**才收容。两个数组属性时无法判断哪个是书单，猜错会把无关
  // 数据当成候选，所以照旧抛错。（这条用例是「不要放宽成『随便挑一个数组』」的护栏。）
  it('does not guess when more than one non-empty array property exists', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ books: [candidate], notes: ['无关'] }));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ code: string; message: string }>(events, 'error').message).toMatch(/字段或数量/);
  });

  it('deduplicates recalled equivalents without dropping a different author', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [
      { ...candidate, title: 'ＡＢＣ', author: 'Ｘ' },
      { ...candidate, title: ' abc ', author: 'x' },
      { ...candidate, title: 'abc', author: 'y' },
    ] }));
    const res = await POST(request({ step: 'recall', query: '找书' }));
    const events = await consumeSSE(res);
    expect(lastEvent<{ type: string; candidates: typeof candidate[] }>(events, 'result').candidates.map((c) => [c.title, c.author]))
      .toEqual([['ＡＢＣ', 'Ｘ'], ['abc', 'y']]);
    // 阶段帧先于结果帧
    expect(events.findIndex((e) => e.type === 'phase')).toBeLessThan(events.findIndex((e) => e.type === 'result'));
  });

  it('passes one-off conditions separately without changing the stored profile', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书', conditions: '这次轻松一点' })));
    const candidates = lastEvent<{ type: string; candidates: typeof candidate[] }>(events, 'result').candidates;
    expect(candidates).toEqual([{ ...candidate, source: 'llm' }]);
    expect(mocks.chatRobust.mock.calls[0][1]).toContain('# 用户口味画像\n\n画像');
    expect(mocks.chatRobust.mock.calls[0][1]).toContain('# 仅本次生效的条件\n\n这次轻松一点');
    expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
  });

  it('does not retain one-off conditions after the client clears them', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    await consumeSSE(await POST(request({ step: 'recall', query: '找书', conditions: '这次轻松一点' })));
    await consumeSSE(await POST(request({ step: 'recall', query: '找书', conditions: '' })));
    expect(mocks.chatRobust.mock.calls[1][1]).toContain('# 仅本次生效的条件\n\n（无）');
    expect(mocks.chatRobust.mock.calls[1][1]).not.toContain('这次轻松一点');
  });

  it.each([undefined, '', '  '])('excludes exact seed titles with absent author %j and keeps sequels', async (author) => {
    mocks.getProfileForUser.mockResolvedValue({ seeds: [{ title: 'ＡＢＣ', author, kind: 'love' }], content: '画像' });
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [
      { ...candidate, title: 'abc', author: '作者甲' },
      { ...candidate, title: ' abc ', author: '作者乙' },
      { ...candidate, title: 'ABC 2', author: '作者甲' },
    ] }));
    const res = await POST(request({ step: 'recall', query: '找书' }));
    const events = await consumeSSE(res);
    expect(lastEvent<{ type: string; candidates: typeof candidate[] }>(events, 'result').candidates).toEqual([{ ...candidate, title: 'ABC 2', source: 'llm' }]);
  });

  it('uses title + author for authored seeds and read/dropped records', async () => {
    mocks.getProfileForUser.mockResolvedValue({ seeds: [{ ...candidate, kind: 'drop' }], content: '画像' });
    mocks.getExcludedBookKeysForUser.mockResolvedValue([bookKey('已读书', '作者甲')]);
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [
      candidate,
      { ...candidate, author: '作者乙' },
      { ...candidate, title: '已读书' },
      { ...candidate, title: '已读书', author: '作者乙' },
      { ...candidate, title: '测试书续篇' },
    ] }));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ type: string; candidates: typeof candidate[] }>(events, 'result').candidates.map((c) => [c.title, c.author])).toEqual([
      ['测试书', '作者乙'], ['已读书', '作者乙'], ['测试书续篇', '作者甲'],
    ]);
  });

  it('verifies each canonical pair only once and keeps response metadata aligned', async () => {
    mocks.verifyBatch.mockResolvedValue([douban, { status: 'not_found', found: false }]);
    const res = await POST(request({ step: 'verify', candidates: [
      { ...candidate, title: 'ＡＢＣ', author: 'Ｘ' },
      { ...candidate, title: 'abc', author: 'x' },
      { ...candidate, title: 'abc', author: 'y' },
    ] }));
    const events = await consumeSSE(res); // 先消费流，让 start() 里的 verifyBatch 完成
    expect(res.status).toBe(200);
    expect(mocks.verifyBatch).toHaveBeenCalledOnce();
    const sent = mocks.verifyBatch.mock.calls[0][0];
    expect(sent.map((c: typeof candidate) => [c.title, c.author])).toEqual([['ＡＢＣ', 'Ｘ'], ['abc', 'y']]);
    expect(lastEvent<{ type: string; verified: typeof verified[] }>(events, 'result').verified).toEqual([
      { ...sent[0], douban }, { ...sent[1], douban: { status: 'not_found', found: false } },
    ]);
  });

  it('deduplicates the rerank input and output, preserves source identity, and excludes invented books', async () => {
    const first = { ...verified, title: 'ＡＢＣ', author: 'Ｘ' };
    const same = { ...verified, title: 'abc', author: 'x', why: '重复' };
    const other = { ...verified, title: 'abc', author: 'y', why: '另一作者', douban: { ...douban, doubanId: '456' } };
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [
      { ...item, title: 'abc', author: 'x', why: '篡改理由', category: '篡改分类', matchScore: 80 },
      { ...item, title: 'ＡＢＣ', author: 'Ｘ', matchScore: 100 },
      { ...item, title: 'abc', author: 'y', matchScore: 90 },
      { ...item, title: '输入集合之外', matchScore: 99 },
    ] }));
    const res = await POST(request({ step: 'rerank', query: '找书', verified: [first, same, other] }));
    expect(res.status).toBe(200);
    const data = lastEvent<{ type: string; items: typeof item[]; persisted: boolean }>(await consumeSSE(res), 'result');
    expect(data.persisted).toBe(true);
    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({ title: 'abc', author: 'y', matchScore: 90, douban: { doubanId: '456' } });
    expect(data.items[1]).toMatchObject({
      title: 'ＡＢＣ', author: 'Ｘ', matchScore: 80, why: '原始理由', category: '仙侠', douban: { doubanId: '123' },
    });
    expect(mocks.chatRobust.mock.calls[0][1]).not.toContain('"why":"重复"');
    expect(mocks.persistRecommendationsForUser).toHaveBeenCalledWith(1, '找书', data.items, expect.any(Function));
  });

  it.each([null, '', false, true])('does not persist an invalid score %j', async (matchScore) => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [{ ...item, matchScore }] }));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    expect(lastEvent(events, 'error')).toBeTruthy();
    expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
  });

  it('does not persist an item containing database-illegal body text', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [{ ...item, reason: 'bad' + String.fromCharCode(0) }] }));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    expect(lastEvent(events, 'error')).toBeTruthy();
    expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
  });

  it('reports persistence failure without discarding valid recommendations', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [item] }));
    mocks.persistRecommendationsForUser.mockRejectedValue(new Error('offline database'));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    const result = lastEvent<{ type: string; persisted: boolean; items: typeof item[] }>(events, 'result');
    expect(result.persisted).toBe(false);
    expect(result.items[0]).toMatchObject({ ...item, why: verified.why, douban: verified.douban });
  });

  it('settles the request with a recognizable timeout event when the budget expires before the read finishes', async () => {
    vi.useFakeTimers();
    try {
      mocks.ensureSchema.mockReturnValue(new Promise(() => {})); // block before the model call
      const resPromise = POST(request({ step: 'recall', query: '找书' })).then((res) => res.text());
      await vi.advanceTimersByTimeAsync(285_000);
      const body = await resPromise;
      expect(body).toMatch(/DEADLINE_EXCEEDED/);
      expect(body).toMatch(/请求预算已耗尽/);
      expect(mocks.chatRobust).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the request deadline signal into douban verification instead of a shared client', async () => {
    mocks.verifyBatch.mockResolvedValue([douban]);
    await POST(request({ step: 'verify', candidates: [candidate] })).then((r) => r.text());
    const signal = mocks.verifyBatch.mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);
    // 请求级发射，独立于 req.signal 与共享 abort
    const req = request({ step: 'verify', candidates: [candidate] });
    expect(signal).not.toBe(req.signal);
  });

  it('emits verify progress frames updated per completed douban probe', async () => {
    mocks.verifyBatch.mockImplementation(async (_candidates, _signal, onProgress) => {
      onProgress?.(1);
      onProgress?.(2);
      return [douban, douban];
    });
    const events = await consumeSSE(await POST(request({ step: 'verify', candidates: [candidate, { ...candidate, title: '书二' }] })));
    const progress = events.filter((e) => e.type === 'progress');
    expect(progress[0]).toEqual({ type: 'progress', step: 'verify', done: 1, total: 2 });
    expect(progress[1]).toEqual({ type: 'progress', step: 'verify', done: 2, total: 2 });
  });

  it('adds independent source evidence inside verify and carries it through rerank', async () => {
    const missing = { status: 'not_found', found: false };
    const evidence = { status: 'matched', sourceName: '测试书源', url: 'https://book15.net/books/details42.html', checkedAt: '2026-09-16T00:00:00Z', note: '匹配目录，仅补充存在性' };
    mocks.verifyBatch.mockResolvedValue([missing]);
    mocks.supplementSourceEvidence.mockImplementation(async (candidates, _deadline, signal, progress) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      progress(1, 1);
      return candidates.map((entry: object) => ({ ...entry, sourceEvidence: evidence }));
    });
    const events = await consumeSSE(await POST(request({ step: 'verify', candidates: [candidate] })));
    const result = lastEvent<{ type: string; verified: unknown[] }>(events, 'result');
    expect(result.verified[0]).toMatchObject({ douban: missing, sourceEvidence: evidence });
    expect(events.some((event) => event.step === 'verify' && event.provider === 'source')).toBe(true);
    expect(events.every((event) => event.step === 'verify')).toBe(true);
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [{ ...item, sourceEvidence: { status: 'forged' } }] }));
    const reranked = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: result.verified })));
    expect(lastEvent<{ type: string; items: unknown[] }>(reranked, 'result').items[0]).toMatchObject({ sourceEvidence: evidence, douban: missing });
    expect(mocks.chatRobust.mock.calls[0][1]).toContain('仅补充存在性');
  });

  // 单步模型预算是硬上限：调用方传给 chatRobust 的 totalTimeoutMs 来自它。第一次尝试拿满
  // 整步预算，不预切——上游推理模型「正常但慢」更常见，预切会把能成功的 190s 调用硬切掉。
  // 可用额 285s − 12s 写回预留 = 273s，ceiling 取 260s。
  it('hands the first model attempt the full 260s ceiling, not a pre-cut share', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
    const { totalTimeoutMs } = mocks.chatRobust.mock.calls[0][2];
    expect(totalTimeoutMs).toBe(260_000);
    // 旧的 220s ceiling 会在 190s 级的调用上提前截断。
    expect(totalTimeoutMs).toBeGreaterThan(220_000);
  });

  // 兜底模型：找书的两个模型步骤都必须显式带上它（删掉传参本用例必须失败）。换上的快模型
  // 有约 22% 的传输层失败率，不兜底就是「换了速度、赔上可用性」。其它调用点刻意不传。
  it('hands both recall and rerank the configured fallback model', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(mocks.chatRobust.mock.calls[0][2]).toMatchObject({ fallbackModel: 'claude-opus-5-88' });

    mocks.chatRobust.mockReset();
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [{ ...item, matchScore: 80 }] }));
    await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    expect(mocks.chatRobust.mock.calls[0][2]).toMatchObject({ fallbackModel: 'claude-opus-5-88' });
  });

  it('uses LLM_FALLBACK_MODEL when it is configured', async () => {
    vi.stubEnv('LLM_FALLBACK_MODEL', 'other/model');
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(mocks.chatRobust.mock.calls[0][2]).toMatchObject({ fallbackModel: 'other/model' });
    vi.unstubAllEnvs();
  });

  // 单次尝试上限：光有「失败后降级」不够——524 实测要吃满 ~126s，一次就能把整步预算啃光，
  // 兜底永远轮不到。首字节与流内停滞两个上限都必须在（删掉一个本用例即失败）。
  it('hands the model calls a single-attempt cap (first byte + in-stream stall)', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    const opts = mocks.chatRobust.mock.calls[0][2] as { idleTimeoutMs: number; firstByteTimeoutMs: number };
    expect(opts.firstByteTimeoutMs).toBe(45_000);
    expect(opts.idleTimeoutMs).toBe(45_000);
    // 必须远小于整步天花板，否则截断之后没预算留给兜底。
    expect(opts.firstByteTimeoutMs).toBeLessThan(260_000 / 2);
  });

  it('uses LLM_ATTEMPT_TIMEOUT_MS when it is configured', async () => {
    vi.stubEnv('LLM_ATTEMPT_TIMEOUT_MS', '20000');
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(mocks.chatRobust.mock.calls[0][2]).toMatchObject({ firstByteTimeoutMs: 20_000, idleTimeoutMs: 20_000 });
    vi.unstubAllEnvs();
  });

  // 回归护栏：第一次「超时」不能白白扔掉剩余预算。模型调用抛可重试错误、但剩下时间够时，
  // 必须让恢复路径接住它，而不是直接上抛。
  it('recovers when the first attempt times out and budget remains', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mocks.chatRobust
      .mockImplementationOnce(async () => {
        clock += 100_000; // 第一次尝试超时前已经花掉 100s
        throw new LlmError('LLM 总超时（260s）');
      })
      .mockImplementationOnce(async () => JSON.stringify({ candidates: [candidate] }));

    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));

    expect(lastEvent<{ candidates: unknown[] }>(events, 'result').candidates).toHaveLength(1);
    expect(mocks.chatRobust).toHaveBeenCalledTimes(2);
    const budgets = mocks.chatRobust.mock.calls.map((call) => (call[2] as { totalTimeoutMs: number }).totalTimeoutMs);
    expect(budgets[0]).toBe(260_000);
    expect(budgets[1]).toBe(160_000); // 260s − 已用 100s，不重获整份
    expect(100_000 + budgets[1]).toBeLessThanOrEqual(260_000);
  });

  it('rethrows a first-attempt timeout once no budget is left to retry', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mocks.chatRobust.mockImplementation(async () => {
      clock += 260_000; // 第一次就用完整步预算
      throw new LlmError('LLM 总超时（260s）');
    });

    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));

    expect(lastEvent<{ code: string }>(events, 'error').code).toBe('LLM_ERROR');
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  it('does not retry a non-retryable model failure even with budget left', async () => {
    mocks.chatRobust.mockRejectedValue(new LlmError('模型调用已取消。', false));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ code: string }>(events, 'error').code).toBe('LLM_ERROR');
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  // parseJson / modelList 的失败发生在 chatRobust 之外，不重试就永远拉不回来。
  it('retries once inside the same step when the first answer is not JSON', async () => {
    mocks.chatRobust
      .mockResolvedValueOnce('抱歉，我先解释一下我的选书思路，不输出 JSON。')
      .mockResolvedValueOnce(JSON.stringify({ candidates: [candidate] }));
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ candidates: unknown[] }>(events, 'result').candidates).toEqual([{ ...candidate, source: 'llm' }]);
    expect(mocks.chatRobust).toHaveBeenCalledTimes(2);
  });

  it('recovers a rerank step whose first answer is not JSON', async () => {
    mocks.chatRobust
      .mockResolvedValueOnce('这里是我的分析（非 JSON）。')
      .mockResolvedValueOnce(JSON.stringify({ items: [item] }));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    expect(lastEvent<{ items: unknown[] }>(events, 'result').items).toHaveLength(1);
    expect(mocks.chatRobust).toHaveBeenCalledTimes(2);
  });

  // 两次尝试共享一个单步截止时间：第二次只拿剩余预算，不重获整份（deadline 不变量）。
  it('gives the retry only the remaining step budget, never a fresh one', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mocks.chatRobust
      .mockImplementationOnce(async () => {
        clock += 150_000; // 第一次尝试实际花掉 150s
        return '不是 JSON';
      })
      .mockImplementationOnce(async () => JSON.stringify({ candidates: [candidate] }));

    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));

    expect(lastEvent<{ candidates: unknown[] }>(events, 'result').candidates).toHaveLength(1);
    expect(mocks.chatRobust).toHaveBeenCalledTimes(2);
    const budgets = mocks.chatRobust.mock.calls.map((call) => (call[2] as { totalTimeoutMs: number }).totalTimeoutMs);
    expect(budgets[0]).toBe(260_000);
    expect(budgets[1]).toBe(110_000); // 260s − 已用 150s，不是又一份 260s
    expect(150_000 + budgets[1]).toBeLessThanOrEqual(260_000);
  });

  it('does not start a second attempt once the step budget is spent', async () => {
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '1000'); // 整步只剩 1s，剩余远低于重试下限
    mocks.chatRobust.mockResolvedValue('不是 JSON');
    const events = await consumeSSE(await POST(request({ step: 'recall', query: '找书' })));
    expect(lastEvent<{ code: string }>(events, 'error').code).toBe('LLM_ERROR');
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  it('reports LLM_ERROR when both attempts fail to produce JSON', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ wrong: [] }));
    const events = await consumeSSE(await POST(request({ step: 'rerank', query: '找书', verified: [verified] })));
    expect(lastEvent<{ code: string; message: string }>(events, 'error')).toMatchObject({
      code: 'LLM_ERROR', message: expect.stringMatching(/书单字段或数量/),
    });
    expect(mocks.chatRobust).toHaveBeenCalledTimes(2);
    expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
  });
});
