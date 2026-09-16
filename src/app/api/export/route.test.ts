import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, sql, transaction, session } = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray) => strings.join('')),
  transaction: vi.fn(), session: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: session }));
import { GET } from './route';

function request(token?: string) {
  return new NextRequest('http://localhost/api/export', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe('GET /api/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'export-test-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(Object.assign(sql, { transaction }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, 'wrong-token'])('rejects %s credentials before accessing data', async (token) => {
    const res = await GET(request(token));

    expect(res.status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(getSql).not.toHaveBeenCalled();
  });

  it('fails closed when owner authentication is not configured', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');

    expect((await GET(request('export-test-owner'))).status).toBe(503);
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('downloads all requested data and book references as a dated JSON attachment', async () => {
    const seeds = [{ title: '种子书', kind: 'love', reason: '节奏好' }];
    const profile = { id: 1, content: '口味画像', seeds, updated_at: '2026-09-14T00:00:00Z' };
    const books = [{ id: 7, title: '测试书', author: '作者', meta: { category: '仙侠' } }];
    const recommendations = [{ id: 1, book_id: 7, status: 'done', query: '找书' }];
    const feedback = [{ id: 2, book_id: 7, status: 'done', note: '节奏好' }];
    const labeledBooks = [{ id: 5, title: '书库书', quality: 8, sub_tags: ['修仙'] }];
    transaction.mockResolvedValue([[profile], books, recommendations, feedback, labeledBooks]);

    const res = await GET(request('export-test-owner'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="shujing-data-${data.exportedAt.slice(0, 10)}.json"`,
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(data).toEqual({
      formatVersion: 2, subject: { userId: 1 },
      sections: { personal: ['profile', 'seeds', 'books', 'recommendations', 'feedback'], shared: ['labeled_books'] },
      download: null, downloadState: 'not_ready', exportedAt: expect.any(String), profile, seeds, books,
      recommendations, feedback, labeled_books: labeledBooks,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: 'RepeatableRead', readOnly: true, arrayMode: false, fullResults: false, fetchOptions: { signal: expect.any(AbortSignal) },
    });
    const libraryQuery = sql.mock.results.map((result) => String(result.value))
      .find((query) => query.includes('FROM labeled_books'));
    expect(libraryQuery).toBeDefined();
    expect(libraryQuery).not.toMatch(/\blabels\b|SELECT\s+\*/);
  });

  it('exports an empty account without dropping any dataset', async () => {
    transaction.mockResolvedValue([[], [], [], [], []]);

    const res = await GET(request('export-test-owner'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      profile: null, seeds: [], books: [], recommendations: [], feedback: [], labeled_books: [],
    });
  });

  it('returns an error instead of downloading a partial export when a query fails', async () => {
    transaction.mockRejectedValue(new Error('private database details'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(request('export-test-owner'));

    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(await res.json()).toEqual({ error: '数据导出失败，请稍后重试' });
  });
  it.each([2, 3])('用户 %s 的导出只取本人及被本人引用的书，下载分区不全局读取', async (userId) => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    session.mockResolvedValue({ userId, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true });
    transaction.mockResolvedValue([[], [], [], [], []]);
    const res = await GET(new NextRequest('http://localhost/api/export?userId=1', { headers: { Cookie: 'nf-dev-session=member' } }));
    const data = await res.json(); expect(data.subject.userId).toBe(userId);
    expect(data.download).toBeNull(); expect(data.downloadState).toBe('forbidden');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
    for (const [parts, ...values] of sql.mock.calls) {
      const text = parts.join('');
      expect(text).not.toMatch(/FROM (users|sessions|auth_rate_limits|download_tasks)/);
      if (text.includes('FROM labeled_books')) continue;
      expect(values.length).toBeGreaterThan(0); expect(values.every((value) => value === userId)).toBe(true);
      if (text.includes('FROM books b')) {
        expect(text).toContain('r.user_id ='); expect(text).toContain('f.user_id =');
      } else expect(text).toMatch(/WHERE (?:user_id|id) =/);
    }
  });

});
