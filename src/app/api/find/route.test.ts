import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { bookKey } from '@/lib/sanitize';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getProfile: vi.fn(),
  getExcludedBookKeys: vi.fn(),
  getExcludedBookTitles: vi.fn(),
  persistRecommendations: vi.fn(),
  chatRobust: vi.fn(),
  verifyBatch: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  ensureSchema: mocks.ensureSchema,
  getProfile: mocks.getProfile,
  getExcludedBookKeys: mocks.getExcludedBookKeys,
  getExcludedBookTitles: mocks.getExcludedBookTitles,
  persistRecommendations: mocks.persistRecommendations,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: async (...args: unknown[]) => ({ content: await mocks.chatRobust(...args) }),
}));
vi.mock('@/lib/douban', () => ({ verifyBatch: mocks.verifyBatch }));
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

describe('POST /api/find output contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'find-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getProfile.mockResolvedValue({ seeds: [], content: '画像' });
    mocks.getExcludedBookKeys.mockResolvedValue([]);
    mocks.getExcludedBookTitles.mockResolvedValue([]);
    mocks.persistRecommendations.mockResolvedValue(undefined);
    mocks.verifyBatch.mockImplementation(async (candidates: unknown[]) => candidates.map(() => douban));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before accessing data or the model', async () => {
    const req = request({ step: 'recall', query: '找书' });
    req.headers.delete('Authorization');
    expect((await POST(req)).status).toBe(401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  it.each(['recall', 'rerank'])('returns a clear 502 for invalid %s JSON and root shapes', async (step) => {
    for (const raw of ['null', '[]', '"text"', '42', 'false', '{bad json', '{"items":']) {
      mocks.chatRobust.mockResolvedValue(raw);
      const res = await POST(request({ step, query: '找书', verified: [verified] }));
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/模型.*JSON/);
      expect(mocks.persistRecommendations).not.toHaveBeenCalled();
    }
  });

  it.each([
    { step: 'recall', field: 'candidates', max: 12 },
    { step: 'rerank', field: 'items', max: 10 },
  ])('validates the $field field and count', async ({ step, field, max }) => {
    for (const list of [undefined, null, false, {}, 'wrong', [], Array.from({ length: max + 1 }, () => item)]) {
      mocks.chatRobust.mockResolvedValue(JSON.stringify({ [field]: list }));
      const res = await POST(request({ step, query: '找书', verified: [verified] }));
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/字段或数量/);
      expect(mocks.persistRecommendations).not.toHaveBeenCalled();
    }
  });

  it('deduplicates recalled equivalents without dropping a different author', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [
      { ...candidate, title: 'ＡＢＣ', author: 'Ｘ' },
      { ...candidate, title: ' abc ', author: 'x' },
      { ...candidate, title: 'abc', author: 'y' },
    ] }));
    const res = await POST(request({ step: 'recall', query: '找书' }));
    expect(res.status).toBe(200);
    expect((await res.json()).candidates.map((c: typeof candidate) => [c.title, c.author]))
      .toEqual([['ＡＢＣ', 'Ｘ'], ['abc', 'y']]);
  });

  it('passes one-off conditions separately without changing the stored profile', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    const res = await POST(request({ step: 'recall', query: '找书', conditions: '这次轻松一点' }));
    expect(res.status).toBe(200);
    expect(mocks.chatRobust.mock.calls[0][1]).toContain('# 用户口味画像\n\n画像');
    expect(mocks.chatRobust.mock.calls[0][1]).toContain('# 仅本次生效的条件\n\n这次轻松一点');
    expect(mocks.persistRecommendations).not.toHaveBeenCalled();
  });

  it('does not retain one-off conditions after the client clears them', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [candidate] }));
    await POST(request({ step: 'recall', query: '找书', conditions: '这次轻松一点' }));
    await POST(request({ step: 'recall', query: '找书', conditions: '' }));
    expect(mocks.chatRobust.mock.calls[1][1]).toContain('# 仅本次生效的条件\n\n（无）');
    expect(mocks.chatRobust.mock.calls[1][1]).not.toContain('这次轻松一点');
  });

  it.each([undefined, '', '  '])('excludes exact seed titles with absent author %j and keeps sequels', async (author) => {
    mocks.getProfile.mockResolvedValue({ seeds: [{ title: 'ＡＢＣ', author, kind: 'love' }], content: '画像' });
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [
      { ...candidate, title: 'abc', author: '作者甲' },
      { ...candidate, title: ' abc ', author: '作者乙' },
      { ...candidate, title: 'ABC 2', author: '作者甲' },
    ] }));
    const res = await POST(request({ step: 'recall', query: '找书' }));
    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toEqual([{ ...candidate, title: 'ABC 2', source: 'llm' }]);
  });

  it('uses title + author for authored seeds and read/dropped records', async () => {
    mocks.getProfile.mockResolvedValue({ seeds: [{ ...candidate, kind: 'drop' }], content: '画像' });
    mocks.getExcludedBookKeys.mockResolvedValue([bookKey('已读书', '作者甲')]);
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ candidates: [
      candidate,
      { ...candidate, author: '作者乙' },
      { ...candidate, title: '已读书' },
      { ...candidate, title: '已读书', author: '作者乙' },
      { ...candidate, title: '测试书续篇' },
    ] }));
    const res = await POST(request({ step: 'recall', query: '找书' }));
    expect(res.status).toBe(200);
    expect((await res.json()).candidates.map((c: typeof candidate) => [c.title, c.author])).toEqual([
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
    expect(res.status).toBe(200);
    expect(mocks.verifyBatch).toHaveBeenCalledOnce();
    const sent = mocks.verifyBatch.mock.calls[0][0];
    expect(sent.map((c: typeof candidate) => [c.title, c.author])).toEqual([['ＡＢＣ', 'Ｘ'], ['abc', 'y']]);
    expect((await res.json()).verified).toEqual([
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
    const data = await res.json();
    expect(data.persisted).toBe(true);
    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({ title: 'abc', author: 'y', matchScore: 90, douban: { doubanId: '456' } });
    expect(data.items[1]).toMatchObject({
      title: 'ＡＢＣ', author: 'Ｘ', matchScore: 80, why: '原始理由', category: '仙侠', douban: { doubanId: '123' },
    });
    expect(mocks.chatRobust.mock.calls[0][1]).not.toContain('"why":"重复"');
    expect(mocks.persistRecommendations).toHaveBeenCalledWith('找书', data.items);
  });

  it.each([null, '', false, true])('does not persist an invalid score %j', async (matchScore) => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [{ ...item, matchScore }] }));
    expect((await POST(request({ step: 'rerank', query: '找书', verified: [verified] }))).status).toBe(502);
    expect(mocks.persistRecommendations).not.toHaveBeenCalled();
  });

  it('does not persist an item containing database-illegal body text', async () => {
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [{ ...item, reason: 'bad' + String.fromCharCode(0) }] }));
    expect((await POST(request({ step: 'rerank', query: '找书', verified: [verified] }))).status).toBe(502);
    expect(mocks.persistRecommendations).not.toHaveBeenCalled();
  });

  it('reports persistence failure without discarding valid recommendations', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.chatRobust.mockResolvedValue(JSON.stringify({ items: [item] }));
    mocks.persistRecommendations.mockRejectedValue(new Error('offline database'));
    const res = await POST(request({ step: 'rerank', query: '找书', verified: [verified] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ persisted: false, items: [item] });
  });
});
