import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ ensureSchema: vi.fn(), getSql: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/db', () => mocks);
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: mocks.session }));
import { GET } from './route';

let db: ReturnType<typeof mockSql>;

const FIND_ONLY = { userId: 2, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true };
const READER = { userId: 3, role: 'member', canFind: true, canRead: true, canDownload: false, authMethod: 'password', membersEnabled: true };

function memberRequest() {
  // 成员路径只在账号模式启用时走 Cookie 会话。
  vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
  return new NextRequest('http://localhost/api/library', { headers: { Cookie: 'nf-dev-session=member-a' } });
}
function ownerRequest(page?: string, query?: string, tag?: string) {
  const url = new URL('http://localhost/api/library');
  if (page !== undefined) url.searchParams.set('page', page);
  if (query !== undefined) url.searchParams.set('q', query);
  if (tag !== undefined) url.searchParams.set('tag', tag);
  return new NextRequest(url, { headers: { Authorization: 'Bearer library-test-owner' } });
}
function listQuery() {
  return db.queries.find((query) => query.text.includes('FROM labeled_books'));
}
// 只记录不执行的 tag：拿事务回调重建批内 SQL，断言「哪些语句确实在同一个批里」。
// 必需——只看 db.queries 的总条数无法区分「4 条同一事务」与「3 条在事务 + 1 条另发」
// （变异自测实证：摘掉一条 facet 后总条数仍是 4，靠条数断言不会红）。
function batchTexts(call: unknown[]) {
  const build = call[0] as (tx: unknown) => { text: string }[];
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    parts.forEach((part, index) => {
      text += part;
      if (index >= values.length) return;
      const value = values[index] as { text?: string } | null | undefined;
      text += value && typeof value === 'object' && typeof value.text === 'string' ? value.text : '?';
    });
    return { text, values: [] as unknown[] };
  };
  return build(tag).map((query) => query.text);
}

describe('GET /api/library', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db = mockSql();
    mocks.getSql.mockReturnValue(db.sql);
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_OWNER_TOKEN', 'library-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.session.mockResolvedValue(FIND_ONLY);
    db.resolve.mockImplementation((query) => {
      if (query.text.includes('SELECT id, title')) return [{
        id: 7, title: '测试书', author: '作者', category: '仙侠', primary_genre: '修仙',
        quality: 8, finish_status: '完结', chars_labeled: 30000, labels: { genre: '成长' }, labeled_at: '2026-09-14',
      }];
      if (query.text.includes('AS total')) return [{ total: 31 }];
      return [];
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before validating or querying', async () => {
    const req = ownerRequest('Infinity');
    req.headers.delete('Authorization');
    expect((await GET(req)).status).toBe(401);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it('rejects a member without find capability', async () => {
    mocks.session.mockResolvedValue({ ...FIND_ONLY, canFind: false });
    const res = await GET(memberRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', code: 'FORBIDDEN' });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('find-only 会话仍能读共享书库元数据，但拿不到完成文件定位', async () => {
    const res = await GET(memberRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).books[0]).toMatchObject({ id: 7, readTaskId: null });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });

  it('无 read 权限不查询共享任务定位，直接取 NULL', async () => {
    await GET(memberRequest());
    expect(listQuery()?.text).toContain('NULL::integer AS read_task_id');
    expect(listQuery()?.text).not.toContain('download_tasks');
  });

  it('有 read 权限才返回共享完成文件定位', async () => {
    mocks.session.mockResolvedValue(READER);
    db.resolve.mockImplementation((query) => {
      if (query.text.includes('SELECT id, title')) return [{
        id: 7, title: '测试书', author: '作者', category: '仙侠', primary_genre: '修仙',
        quality: 8, finish_status: '完结', chars_labeled: 30000, labels: { genre: '成长' },
        labeled_at: '2026-09-14', read_task_id: 90,
      }];
      if (query.text.includes('AS total')) return [{ total: 31 }];
      return [];
    });
    const res = await GET(memberRequest());
    expect((await res.json()).books[0].readTaskId).toBe(90);
    expect(listQuery()?.text).toContain('download_tasks');
    expect(listQuery()?.text).toContain("dt.status = 'done'");
    // F03：partial（残缺终态）永不可读，定位子查询不得把它当成完成文件
    expect(listQuery()?.text).not.toContain('partial');
  });

  it.each(['', '0', '-1', '1.5', '1.0', 'Infinity', 'NaN', '1e3', '0x10', ' 1', '10001', '9007199254740992'])('rejects page %s before touching the database', async (page) => {
    const res = await GET(ownerRequest(page));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'page must be an integer from 1 to 10000', code: 'INVALID_PAGE' });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it.each([
    { page: undefined, expected: 1, offset: 0 },
    { page: '2', expected: 2, offset: 30 },
    { page: '10000', expected: 10000, offset: 299970 },
  ])('accepts page $page and binds a finite offset', async ({ page, expected, offset }) => {
    const res = await GET(ownerRequest(page));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page: expected, pageSize: 30, maxPage: 10000, total: 31, books: [{ id: 7, genre: '成长' }] });
    expect(listQuery()?.values.slice(-2)).toEqual([30, offset]);
  });

  it('returns a controlled initialization failure', async () => {
    mocks.ensureSchema.mockRejectedValue(new Error('database unavailable'));
    const res = await GET(ownerRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
    expect(db.queries).toHaveLength(0);
  });

  it('四条查询合成一次只读事务往返：批内语句与顺序不变', async () => {
    const res = await GET(ownerRequest());
    expect(res.status).toBe(200);
    // 合批专属断言：退回四条独立 await 时 transaction 调用数为 0，这条变红。
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect((db.transaction.mock.calls[0] as unknown[])[1]).toEqual({ readOnly: true });
    expect(db.queries).toHaveLength(4);
    // 语句数与顺序：行 / 计数 / 分类 facet / 完结 facet，与逐条执行时完全一致。
    expect(batchTexts(db.transaction.mock.calls[0] as unknown[])).toEqual([
      expect.stringContaining('SELECT id, title'),
      expect.stringContaining('count(*)::int AS total'),
      expect.stringContaining('GROUP BY 1 ORDER BY n DESC LIMIT 20'),
      expect.stringContaining("WHERE finish_status <> '' GROUP BY finish_status"),
    ]);
  });

  it('单条查询失败时整体仍是 DB_ERROR（合批前后错误路径一致）', async () => {
    // 只有第 3 条（分类 facet）失败：合批前它也会让整个 try 走 catch 返回 500。
    db.resolve.mockImplementation((query) => {
      if (query.text.includes('GROUP BY 1 ORDER BY n DESC LIMIT 20')) throw new Error('facet boom');
      if (query.text.includes('SELECT id, title')) return [{ id: 7, title: '测试书', author: '作者', category: '仙侠', primary_genre: '修仙', quality: 8, finish_status: '完结', chars_labeled: 30000, labels: {}, labeled_at: '2026-09-14' }];
      if (query.text.includes('AS total')) return [{ total: 1 }];
      return [];
    });
    const res = await GET(ownerRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error', code: 'DB_ERROR' });
  });

  // P2-2：LIKE 通配符必须转义。判别力：摘掉 escapeLike（或 ESCAPE 子句）后，
  // 绑定值变回原始用户输入，本组断言失败。
  it.each([
    { q: '100%', expected: '%100\\%%' },
    { q: '副本_', expected: '%副本\\_%' },
    { q: 'C:\\book', expected: '%c:\\\\book%' },
  ])('q=$q 的 LIKE 模式绑定转义后的值 $expected', async ({ q, expected }) => {
    const res = await GET(ownerRequest(undefined, q));
    expect(res.status).toBe(200);
    const list = listQuery();
    expect(list?.text).toContain("LIKE ? ESCAPE '\\'");
    // 同一个转义后的模式绑定给 title/author/labels 三处（事务批内 values 顺序收集）。
    const likeValues = list?.values.filter((value) => value === expected);
    expect(likeValues).toHaveLength(3);
  });

  it('tag 的 LIKE 模式同样转义（labels->>genre/style/tone 三处）', async () => {
    const res = await GET(ownerRequest(undefined, undefined, '50%off'));
    expect(res.status).toBe(200);
    const list = listQuery();
    expect(list?.text).toContain("LIKE ? ESCAPE '\\'");
    expect(list?.values.filter((value) => value === '%50\\%off%')).toHaveLength(3);
  });

  it('普通中文/字母搜索不经转义改动，行为不变', async () => {
    const res = await GET(ownerRequest(undefined, '仙侠'));
    expect(res.status).toBe(200);
    const list = listQuery();
    expect(list?.values).toContain('%仙侠%');
  });
});
