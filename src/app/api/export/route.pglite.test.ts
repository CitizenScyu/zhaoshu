import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema, seedProductionMembers } from '@/lib/fixtures/production-schema';

// Only auth/connection boundaries are replaced. GET, personalExportQueries,
// request/error wrappers, production schema and all exported rows stay real.
const mocks = vi.hoisted(() => ({ getSql: vi.fn(), requirePermission: vi.fn() }));
vi.mock('@/lib/db', () => ({ getSql: mocks.getSql, ensureSchema: async () => {} }));
vi.mock('@/lib/auth', () => ({ requirePermission: mocks.requirePermission }));
import { GET } from './route';

type Row = Record<string, unknown>;
type ExportData = {
  subject: { userId: number };
  profile: Row | null;
  seeds: unknown[];
  books: Row[];
  recommendations: Row[];
  feedback: Row[];
  labeled_books: Row[];
};

const USER_A = 2;
const USER_B = 3;
const STAMP = '2026-01-02T03:04:05.000Z';
const SEEDS_A = [{ title: 'synthetic-A-seed', kind: 'love', reason: 'synthetic-A-reason' }];
const PRIVATE_B = 'synthetic-B-private-not-for-A';
const LABEL_MARKER = 'synthetic-long-label-body';
const LONG_LABELS = { synopsis: `${LABEL_MARKER}:${'synthetic paragraph '.repeat(8_000)}` };
const LIBRARY = [
  {
    id: 41, title: 'synthetic-library-high', author: 'synthetic-author-high', category: 'fantasy',
    finish_status: 'finished', source_site: 'synthetic-source-high', source_url: 'https://example.invalid/high',
    chars_labeled: 80_000, labeled_at: STAMP, primary_genre: 'fantasy', sub_tags: ['adventure', 'magic'], quality: 8.5,
  },
  {
    id: 7, title: 'synthetic-library-low', author: 'synthetic-author-low', category: 'history',
    finish_status: 'ongoing', source_site: 'synthetic-source-low', source_url: 'https://example.invalid/low',
    chars_labeled: 45_000, labeled_at: STAMP, primary_genre: 'history', sub_tags: [], quality: null,
  },
];
const EXPECTED_LIBRARY = [LIBRARY[1], LIBRARY[0]];

let pg: PGliteLike;
let sql: ReturnType<typeof createPGliteSql>;

async function seedGraph() {
  await pg.query(`INSERT INTO profile (id, seeds, content, updated_at) VALUES
    ($1, $2::jsonb, 'synthetic-A-profile', $5), ($3, '[]', $4, $5)`,
  [USER_A, JSON.stringify(SEEDS_A), USER_B, PRIVATE_B, STAMP]);
  // Intentionally non-ID insertion order. Six reference patterns, with multiple
  // recommendation/feedback rows on book 50 to expose accidental join fan-out.
  for (const [id, kind] of [
    [90, 'unreferenced'], [10, 'A-recommendation-only'], [70, 'shared-A-B'],
    [30, 'A-feedback-only'], [50, 'duplicate-references'], [60, 'B-only'],
  ] as const) {
    await pg.query('INSERT INTO books (id, title, author, meta, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)',
      [id, `synthetic-${kind}`, 'synthetic-author', JSON.stringify({ kind }), STAMP]);
  }
  await pg.query(`INSERT INTO recommendations (id, user_id, book_id, query, reason, created_at) VALUES
    (208, $2, 50, 'synthetic-B-duplicate', $3, $4),
    (203, $1, 50, 'synthetic-A-duplicate-2', 'synthetic-A-reason', $4),
    (202, $1, 10, 'synthetic-A-rec-only', 'synthetic-A-reason', $4),
    (201, $1, 50, 'synthetic-A-duplicate-1', 'synthetic-A-reason', $4),
    (204, $1, 70, 'synthetic-A-shared', 'synthetic-A-reason', $4),
    (209, $2, 60, 'synthetic-B-only', $3, $4)`, [USER_A, USER_B, PRIVATE_B, STAMP]);
  await pg.query(`INSERT INTO feedback (id, user_id, book_id, status, note, created_at) VALUES
    (306, $2, 70, 'reading', $3, $4), (302, $1, 50, 'done', 'synthetic-A-note-2', $4),
    (301, $1, 50, 'reading', 'synthetic-A-note-1', $4), (303, $1, 30, 'done', 'synthetic-A-feedback-only', $4),
    (309, $2, 60, 'done', $3, $4), (308, $2, 50, 'done', $3, $4)`, [USER_A, USER_B, PRIVATE_B, STAMP]);
  for (const row of LIBRARY) {
    await pg.query(`INSERT INTO labeled_books
      (id, title, author, category, finish_status, source_site, source_url, chars_labeled,
       labeled_at, primary_genre, sub_tags, quality, labels)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb)`,
    [row.id, row.title, row.author, row.category, row.finish_status, row.source_site, row.source_url,
      row.chars_labeled, row.labeled_at, row.primary_genre, JSON.stringify(row.sub_tags), row.quality, JSON.stringify(LONG_LABELS)]);
  }
}

async function exportA() {
  // A client-supplied B ID must not affect the authorized principal's export.
  return GET(new NextRequest(`http://localhost/api/export?userId=${USER_B}`));
}

beforeAll(async () => {
  const PGlite = await loadPGlite();
  if (!PGlite) throw new Error('PGlite is required for export row-level regression');
  pg = new PGlite();
  // PostgreSQL's timestamptz::text projection uses the session timezone.
  await pg.exec("SET TIME ZONE 'UTC'");
  sql = createPGliteSql(pg);
  await createProductionSchema(sql as never, statement => pg.exec(statement));
  await seedProductionMembers(pg, USER_B);
}, 60_000);

afterAll(async () => { await pg?.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  // Only synthetic, in-memory tables; no deployment env or database connection.
  await pg.exec('TRUNCATE recommendations, feedback, profile, books, labeled_books RESTART IDENTITY CASCADE');
  await seedGraph();
  mocks.getSql.mockReturnValue(sql);
  mocks.requirePermission.mockResolvedValue({ ok: true, principal: {
    userId: USER_A, role: 'member', canFind: true, canRead: false, canDownload: false, authMethod: 'session',
  } });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('GET /api/export with real production SQL and PGlite rows', () => {
  it('exports exactly A reference closure once per book and isolates all three private tables', async () => {
    const transaction = vi.spyOn(sql, 'transaction'); // Call-through, never canned rows.
    const response = await exportA();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment; filename="shujing-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const data = await response.json() as ExportData;
    expect(data.subject).toEqual({ userId: USER_A });
    expect(data.profile).toEqual({ id: USER_A, seeds: SEEDS_A, content: 'synthetic-A-profile', updated_at: '2026-01-02 03:04:05+00' });
    expect(data.seeds).toEqual(SEEDS_A);
    // This literal feedback-only expectation is the counterfactual mutation target.
    expect(data.books.map(book => book.id)).toEqual([10, 30, 50, 70]);
    expect(new Set(data.books.map(book => book.id)).size).toBe(data.books.length);
    expect(data.books.map(book => [book.title, book.meta])).toEqual([
      ['synthetic-A-recommendation-only', { kind: 'A-recommendation-only' }],
      ['synthetic-A-feedback-only', { kind: 'A-feedback-only' }],
      ['synthetic-duplicate-references', { kind: 'duplicate-references' }],
      ['synthetic-shared-A-B', { kind: 'shared-A-B' }],
    ]);
    expect(data.recommendations).toEqual([
      [201, 50, 'synthetic-A-duplicate-1'], [202, 10, 'synthetic-A-rec-only'],
      [203, 50, 'synthetic-A-duplicate-2'], [204, 70, 'synthetic-A-shared'],
    ].map(([id, book_id, query]) => ({
      id, user_id: USER_A, book_id, query, match_score: null, hit_likes: null,
      risks: null, reason: 'synthetic-A-reason', status: 'new', created_at: STAMP,
    })));
    expect(data.feedback).toEqual([
      [301, 50, 'reading', 'synthetic-A-note-1'], [302, 50, 'done', 'synthetic-A-note-2'],
      [303, 30, 'done', 'synthetic-A-feedback-only'],
    ].map(([id, book_id, status, note]) => ({ id, user_id: USER_A, book_id, status, note, created_at: STAMP })));
    const references = [...data.recommendations, ...data.feedback].map(row => row.book_id);
    expect([...new Set(references)].sort((a, b) => Number(a) - Number(b))).toEqual(data.books.map(book => book.id));
    expect(JSON.stringify(data)).not.toContain(PRIVATE_B);
    expect(data.labeled_books).toEqual(EXPECTED_LIBRARY);
    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {
      isolationLevel: 'RepeatableRead', readOnly: true, arrayMode: false, fullResults: false,
      fetchOptions: { signal: expect.any(AbortSignal) },
    });
  });

  it('exports empty A personal sections without suppressing a populated shared library or leaking B', async () => {
    await pg.query('DELETE FROM recommendations WHERE user_id = $1', [USER_A]);
    await pg.query('DELETE FROM feedback WHERE user_id = $1', [USER_A]);
    await pg.query('DELETE FROM profile WHERE id = $1', [USER_A]);
    const response = await exportA();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      formatVersion: 2, subject: { userId: USER_A }, profile: null, seeds: [], books: [],
      recommendations: [], feedback: [], download: null, downloadState: 'forbidden',
      sections: { personal: ['profile', 'seeds', 'books', 'recommendations', 'feedback'], shared: ['labeled_books'] },
      labeled_books: EXPECTED_LIBRARY,
    });
    expect(JSON.stringify(data)).not.toContain(PRIVATE_B);
    const { rows } = await pg.query(`SELECT
      (SELECT count(*)::int FROM profile WHERE id = $1) AS profiles,
      (SELECT count(*)::int FROM recommendations WHERE user_id = $1) AS recommendations,
      (SELECT count(*)::int FROM feedback WHERE user_id = $1) AS feedback,
      (SELECT count(*)::int FROM books) AS books`, [USER_B]);
    expect(rows).toEqual([{ profiles: 1, recommendations: 2, feedback: 3, books: 6 }]);
  });

  it('omits long labels but retains every shared metadata column and ascending ID order', async () => {
    const { rows } = await pg.query('SELECT id, length(labels::text)::int AS bytes FROM labeled_books ORDER BY id');
    expect(rows.map(row => row.id)).toEqual([7, 41]);
    expect(rows.every(row => Number(row.bytes) > 100_000)).toBe(true);
    const response = await exportA();
    expect(response.status).toBe(200);
    const text = await response.text();
    const data = JSON.parse(text) as ExportData;
    expect(data.labeled_books).toEqual(EXPECTED_LIBRARY);
    for (const row of data.labeled_books) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(LIBRARY[0]).sort());
      expect(row).not.toHaveProperty('labels');
    }
    expect(text).not.toContain(LABEL_MARKER);
    expect(text.length).toBeLessThan(20_000);
  });

  it('fails the real SQL transaction without a partial attachment or private database error text', async () => {
    const realQuery = pg.query.bind(pg);
    const marker = 'export62_synthetic_private_sql_detail';
    const completed: string[] = [];
    let databaseError: unknown;
    // Fail the final statement in PostgreSQL, after the four personal SELECTs
    // have returned real rows. No rejection or successful result is mocked.
    vi.spyOn(pg, 'query').mockImplementation(async (text, params) => {
      if (text.includes('FROM labeled_books')) {
        try { return await realQuery(`SELECT ${marker}()`); }
        catch (error) { databaseError = error; throw error; }
      }
      const result = await realQuery(text, params);
      completed.push(text);
      return result;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await exportA();
    expect(completed).toHaveLength(4);
    expect(databaseError).toMatchObject({ code: '42883', message: expect.stringContaining(marker) });
    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: '数据导出失败，请稍后重试' });
    expect(body).not.toContain(marker);
    expect(body).not.toContain('synthetic-A-profile');
    expect(body).not.toContain(PRIVATE_B);
    expect(log).toHaveBeenCalledExactlyOnceWith('data export failed');
    // A successful query proves the failed transaction was rolled back, not
    // left aborted for subsequent requests.
    expect((await realQuery('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
  });
});
