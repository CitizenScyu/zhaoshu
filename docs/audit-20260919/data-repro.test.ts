import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { initializeBusinessSchema } from '@/lib/business-schema';
import {
  addShelfForUserQueries, deleteShelfForUserQuery, exactLibraryBooksForUserQuery,
  feedbackForUserQueries, persistRecommendationsForUserQueries, recommendationsForUserQuery,
  shelfStatsForUserQuery,
} from '@/lib/user-data';
import { catalogPrefixKey, parseReadingProgress } from '@/lib/reader-preferences';
import type { ReaderIndex } from '@/lib/reader-types';

type Statement = { text: string; params: unknown[] };
const pg = new PGlite();
function tag(parts: TemplateStringsArray, ...values: unknown[]): Statement {
  const result: Statement = { text: '', params: [] };
  parts.forEach((part, index) => {
    result.text += part;
    if (index >= values.length) return;
    const value = values[index];
    if (value && typeof value === 'object' && 'text' in value && 'params' in value) {
      const child = value as Statement;
      const offset = result.params.length;
      result.text += child.text.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + offset}`);
      result.params.push(...child.params);
    } else {
      result.params.push(value);
      result.text += `$${result.params.length}`;
    }
  });
  return result;
}
async function run(statement: unknown) {
  const { text, params } = statement as Statement;
  return (await pg.query(text, params)).rows as Record<string, unknown>[];
}
async function batch(statements: unknown[]) {
  await pg.exec('BEGIN');
  try {
    const result = [];
    for (const statement of statements) result.push(await run(statement));
    await pg.exec('COMMIT');
    return result;
  } catch (error) { await pg.exec('ROLLBACK'); throw error; }
}
const sql = Object.assign(tag, {
  transaction: (builder: (sql: typeof tag) => unknown[]) => batch(builder(tag)),
});
const queryTag = sql as never;
const item = (title: string) => ({ title, author: '审查作者', category: '', wordCount: '', matchScore: 80, hitLikes: [], risks: '', reason: '', why: '' });

beforeAll(async () => {
  await pg.exec('CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users SELECT generate_series(1, 10)');
  await initializeBusinessSchema(sql as never);
  await pg.exec(`ALTER TABLE books ADD COLUMN title_key text GENERATED ALWAYS AS
    (lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\\1')))) STORED;
    ALTER TABLE books ADD COLUMN author_key text GENERATED ALWAYS AS (lower(btrim(normalize(author, NFKC)))) STORED;
    CREATE UNIQUE INDEX books_identity_idx ON books(title_key, author_key)`);
}, 60_000);
afterAll(() => pg.close());

it('R01: removing the displayed recommendation reveals an older recommendation of the same book', async () => {
  await batch(persistRecommendationsForUserQueries(queryTag, 1, '需求A', [item('审查删除')]) as unknown[]);
  await batch(persistRecommendationsForUserQueries(queryTag, 1, '需求B', [item('审查删除')]) as unknown[]);
  const before = await run(recommendationsForUserQuery(queryTag, 1, false));
  expect(before).toHaveLength(1);
  await run(deleteShelfForUserQuery(queryTag, 1, before[0].id as number));
  const after = await run(recommendationsForUserQuery(queryTag, 1, false));
  expect(after).toHaveLength(1);
  expect(after[0].title).toBe(before[0].title);
  expect(after[0].id).not.toBe(before[0].id);
});

it('R02: 301st book is absent even though it is the most recently added book', async () => {
  await pg.exec(`INSERT INTO books(title, author) SELECT '容量审查' || n, '审查作者' FROM generate_series(1,301) n;
    INSERT INTO recommendations(user_id, book_id, query, created_at)
    SELECT 2, id, '容量审查', '2026-01-01'::timestamptz + id * interval '1 second'
    FROM books WHERE title LIKE '容量审查%'`);
  const visible = await run(recommendationsForUserQuery(queryTag, 2, false));
  expect(visible).toHaveLength(300);
  expect(visible.some(row => row.title === '容量审查301')).toBe(false);
  const newest = await pg.query(`SELECT b.title FROM recommendations r JOIN books b ON b.id=r.book_id
    WHERE r.user_id=2 ORDER BY r.created_at DESC LIMIT 1`);
  expect(newest.rows[0]).toEqual({ title: '容量审查301' });
});

it('R03: one book in two recommendation queries counts twice in shelf statistics', async () => {
  await batch(persistRecommendationsForUserQueries(queryTag, 3, '需求A', [item('统计审查')]) as unknown[]);
  await batch(persistRecommendationsForUserQueries(queryTag, 3, '需求B', [item('统计审查')]) as unknown[]);
  expect(await run(recommendationsForUserQuery(queryTag, 3, false))).toHaveLength(1);
  expect(await run(shelfStatsForUserQuery(queryTag, 3))).toEqual([{ name: 'new', count: 2 }]);
});

it('R04: re-adding a previously completed book sets shelf status to want while feedback remains done', async () => {
  await batch(feedbackForUserQueries(queryTag, 4, item('状态审查'), 'done', '已读完', 0) as unknown[]);
  await batch(addShelfForUserQueries(queryTag, 4, '状态审查', '审查作者') as unknown[]);
  const rows = await run(recommendationsForUserQuery(queryTag, 4, false));
  expect(rows[0]).toMatchObject({ status: 'want', note: '已读完' });
  const feedback = await pg.query('SELECT status FROM feedback WHERE user_id=4');
  expect(feedback.rows[0]).toEqual({ status: 'done' });
});

it('R05: exact local search misses a book present only in labeled_books', async () => {
  await pg.exec("INSERT INTO labeled_books(title,author) VALUES ('书库独有审查','审查作者')");
  expect(await run(exactLibraryBooksForUserQuery(queryTag, 5, '书库独有审查', '审查作者'))).toEqual([]);
});

it('R06: nested book brackets are normalized twice across insert and generated column, losing the recommendation', async () => {
  await batch(persistRecommendationsForUserQueries(queryTag, 6, '嵌套身份审查', [item('《《嵌套审查》》')]) as unknown[]);
  expect(await run(recommendationsForUserQuery(queryTag, 6, false))).toHaveLength(0);
  const stored = await pg.query("SELECT title,title_key FROM books WHERE title_key='嵌套审查'");
  expect(stored.rows).toEqual([{ title: '《嵌套审查》', title_key: '嵌套审查' }]);
});

it('R07: appending a chapter keeps an otherwise valid online reading position', () => {
  const index: ReaderIndex = {
    taskId: null, title: '连载审查', author: '审查作者', totalBytes: 0, version: 'old-catalog',
    source: { id: 'stable-book', name: '合成书源', url: 'https://example.invalid/book', session: 'old-catalog' },
    chapters: [0, 1].map(i => ({ index: i, title: `第${i+1}章`, startByte: 0, endByte: 0, partCount: 1 })),
  };
  // F11 修复后的进度带稳定章节键与前缀指纹（旧格式缺这两个字段时下面负例仍会失效）。
  const progress = JSON.stringify({
    schema: 1, version: index.version, chapterIndex: 1, partIndex: 0, ratio: 0.6,
    chapterTitle: '第2章', catalogPrefix: catalogPrefixKey(index, 1), updatedAt: 1,
  });
  expect(parseReadingProgress(progress, index)?.chapterIndex).toBe(1);
  // 追加一章后 version 必然变化，但「第2章」在新目录里位置与标题都未变 → 续读回同一章。
  const updated = { ...index, version: 'new-catalog', chapters: [...index.chapters, { index: 2, title: '第三章', startByte: 0, endByte: 0, partCount: 1 }] };
  const resumed = parseReadingProgress(progress, updated);
  expect(resumed?.chapterIndex).toBe(1);
  expect(resumed?.version).toBe('new-catalog');
  // 负例：真正被替换/乱序（原章位置标题不再一致）时不得猜测，必须失效回退。
  const rewritten = { ...index, version: 'rewritten', chapters: [{ index: 0, title: '第1章', startByte: 0, endByte: 0, partCount: 1 }, { index: 1, title: '换过的第2章', startByte: 0, endByte: 0, partCount: 1 }] };
  expect(parseReadingProgress(progress, rewritten)).toBeNull();
});
