import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql, type RecordedQuery } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  searchBooks: vi.fn(),
  fetchSubjectRating: vi.fn(),
  chatRobust: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema: mocks.ensureSchema, getSql: mocks.getSql }));
// 只替换两个外部调用；user-data 的查询构造器用真实现，好让「身份键口径」这条断言
// 落在真正的 SQL 文本/参数上，而不是落在一个被 mock 掉的壳上。
vi.mock('@/lib/douban', () => ({
  searchBooks: mocks.searchBooks,
  fetchSubjectRating: mocks.fetchSubjectRating,
}));
// 精确找书必须**不碰模型**（这是它与 /api/find 的核心差异，也是预算能压到 25s 的前提）。
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: mocks.chatRobust,
}));
import { POST } from './route';

const CANDIDATES = [
  { doubanId: '1', title: '同名书', author: '作者甲', doubanUrl: 'https://book.douban.com/subject/1/' },
  { doubanId: '2', title: '同名书', author: '作者乙', doubanUrl: 'https://book.douban.com/subject/2/' },
];

let db: ReturnType<typeof mockSql>;
let sql: ReturnType<typeof mockSql>['resolve'];

function request(body: unknown) {
  return new NextRequest('http://localhost/api/find/exact', {
    method: 'POST',
    headers: { Authorization: 'Bearer exact-test-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function libraryRows(rows: Record<string, unknown>[]) {
  sql.mockImplementation((query) => (query.text.includes('FROM books') ? rows : []));
}

describe('POST /api/find/exact', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'exact-test-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    db = mockSql();
    sql = db.resolve;
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getSql.mockReturnValue(db.sql);
    mocks.searchBooks.mockResolvedValue([]);
    mocks.fetchSubjectRating.mockResolvedValue({ rating: 8.5, ratingCount: 1_000 });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before touching the library or douban', async () => {
    const req = request({ title: '诡秘之主' });
    req.headers.delete('Authorization');
    expect((await POST(req)).status).toBe(401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.searchBooks).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '   ', 42, ['书'], { title: '书' }])(
    'rejects a missing or non-string title %j',
    async (title) => {
      const res = await POST(request({ title }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'missing title', code: 'MISSING_TITLE' });
      expect(mocks.ensureSchema).not.toHaveBeenCalled();
      expect(mocks.searchBooks).not.toHaveBeenCalled();
    },
  );

  // 判别力：把 title_key 换回 lower(title) = lower(...) 后，含《》的输入不再命中同一行
  // （下面那条 values 断言会失败）；把归一去掉则 values 里会出现带书名号的原串。
  it('matches the local library through the shared identity key and skips douban', async () => {
    libraryRows([{
      id: 7, title: '诡秘之主', author: '爱潜水的乌贼', douban_id: '1081275',
      douban_rating: 8.7, douban_rating_count: 1234,
      meta: { category: '西幻', wordCount: '400万字' }, on_shelf: true,
    }]);
    const res = await POST(request({ title: '《 诡秘之主 》' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('library');
    expect(body.items).toEqual([{
      title: '诡秘之主', author: '爱潜水的乌贼', source: 'library',
      doubanId: '1081275', doubanUrl: 'https://book.douban.com/subject/1081275/',
      rating: 8.7, ratingCount: 1234, category: '西幻', wordCount: '400万字', onShelf: true,
    }]);
    // 本地命中是免费路径：不再打豆瓣，也不再打模型。
    expect(mocks.searchBooks).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();

    const libraryQuery = db.queries.find((query: RecordedQuery) => query.text.includes('FROM books'));
    expect(libraryQuery?.text).toContain('b.title_key = ?');
    expect(libraryQuery?.values).toContain('诡秘之主');
    expect(libraryQuery?.values).not.toContain('《 诡秘之主 》');
    // 没给作者就不按作者过滤（同名不同作者的书要一起列出来给用户挑）。
    expect(libraryQuery?.text).not.toContain('author_key');
  });

  it('filters by the normalized author when one is given', async () => {
    libraryRows([]);
    await POST(request({ title: '诡秘之主', author: '爱潜水的乌贼' }));
    const libraryQuery = db.queries.find((query: RecordedQuery) => query.text.includes('FROM books'));
    expect(libraryQuery?.text).toContain('b.author_key = ?');
    expect(libraryQuery?.values).toContain('爱潜水的乌贼');
  });

  it('returns every douban candidate so same-title books can be told apart', async () => {
    mocks.searchBooks.mockResolvedValue(CANDIDATES);
    const res = await POST(request({ title: '同名书' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe('douban');
    expect(body.items.map((item: { author: string }) => item.author)).toEqual(['作者甲', '作者乙']);
    expect(body.items[0]).toMatchObject({ source: 'douban', rating: 8.5, ratingCount: 1_000 });
    expect(mocks.searchBooks).toHaveBeenCalledWith('同名书', expect.any(AbortSignal));
  });

  // 候选列表不截断（同名书要全给），只截断**详情页抓取**：豆瓣对高频不友好，
  // 与 verifyBatch 的 CONCURRENCY = 3 对齐，一轮发完就停。
  // 判别力：把 MAX_RATING_LOOKUPS 改成 6 或删掉 slice，调用次数断言即失败。
  it('only fetches ratings for the first three candidates and keeps the rest', async () => {
    mocks.searchBooks.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({
      doubanId: String(i + 1), title: `书${i}`, author: '作者甲',
      doubanUrl: `https://book.douban.com/subject/${i + 1}/`,
    })));
    const body = await (await POST(request({ title: '书' }))).json();

    expect(body.items).toHaveLength(6);
    expect(mocks.fetchSubjectRating).toHaveBeenCalledTimes(3);
    expect(body.items.map((item: { rating: number | null }) => item.rating)).toEqual([8.5, 8.5, 8.5, null, null, null]);
  });

  // 🔴 关键区分：豆瓣挂掉 ≠ 没有这本书。静默合并这两者就是本模式最糟的失败形态。
  it('reports douban as unavailable instead of claiming the book does not exist', async () => {
    mocks.searchBooks.mockRejectedValue(new Error('HTTP 403'));
    const res = await POST(request({ title: '某本网文' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ source: 'none', items: [], unavailable: true });
    expect(body.note).toContain('不代表书不存在');
  });

  it('separates "douban has no entry" from "douban was unreachable"', async () => {
    mocks.searchBooks.mockResolvedValue([]);
    const body = await (await POST(request({ title: '某本网文' }))).json();
    expect(body).toMatchObject({ source: 'none', items: [] });
    expect(body.unavailable).toBeUndefined();
    expect(body.note).toContain('未出版');
  });

  it('keeps the candidate list when a detail page fails', async () => {
    mocks.searchBooks.mockResolvedValue(CANDIDATES);
    mocks.fetchSubjectRating.mockRejectedValue(new Error('HTTP 403'));
    const body = await (await POST(request({ title: '同名书' }))).json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((item: { rating: number | null }) => item.rating)).toEqual([null, null]);
  });

  // 预算到期不是「豆瓣不可达」：按既有约定升级为 504，不能降级成 source: 'none'。
  // 判别力：把 access.assertActive() 那行删掉，本用例会拿到 200 + source: 'none'。
  it('fails the request on budget expiry instead of degrading to "no entry"', async () => {
    vi.useFakeTimers();
    try {
      mocks.ensureSchema.mockReturnValue(new Promise(() => {})); // 卡在读库之前
      const pending = POST(request({ title: '某本书' })).then((res) => res.json());
      await vi.advanceTimersByTimeAsync(25_000);
      const body = await pending;
      expect(body.code).toBe('DEADLINE_EXCEEDED');
      expect(mocks.searchBooks).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
