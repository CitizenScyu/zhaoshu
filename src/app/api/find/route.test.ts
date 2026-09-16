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

  it.each(['recall', 'rerank'])('returns an error event for invalid %s JSON and root shapes', async (step) => {
    for (const raw of ['null', '[]', '"text"', '42', 'false', '{bad json', '{"items":']) {
      mocks.chatRobust.mockResolvedValue(raw);
      const res = await POST(request({ step, query: '找书', verified: [verified] }));
      const events = await consumeSSE(res);
      expect(lastEvent<{ type: string; code: string; message: string }>(events, 'error').message).toMatch(/模型.*JSON/);
      expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
    }
  });

  it.each([
    { step: 'recall', field: 'candidates', max: 12 },
    { step: 'rerank', field: 'items', max: 10 },
  ])('validates the $field field and count as an error event', async ({ step, field, max }) => {
    for (const list of [undefined, null, false, {}, 'wrong', [], Array.from({ length: max + 1 }, () => item)]) {
      mocks.chatRobust.mockResolvedValue(JSON.stringify({ [field]: list }));
      const events = await consumeSSE(await POST(request({ step, query: '找书', verified: [verified] })));
      expect(lastEvent<{ type: string; message: string }>(events, 'error').message).toMatch(/字段或数量/);
      expect(mocks.persistRecommendationsForUser).not.toHaveBeenCalled();
    }
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
});
