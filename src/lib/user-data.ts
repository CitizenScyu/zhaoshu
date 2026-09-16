import type { PersonalQuery } from './personal-write';
import type { RerankedItem } from './types';

export function requireUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2_147_483_647) throw new Error('explicit userId is required');
}

// 只构造 SQL，供路由和隔离库验收共用；不读取任何连接配置或客户端身份字段。
export function recommendationsForUserQuery(sql: PersonalQuery, userId: number, canRead: boolean) {
  requireUserId(userId);
  const readTask = canRead ? sql`(SELECT dt.id FROM download_tasks dt
    WHERE lower(btrim(dt.title)) = lower(btrim(b.title))
      AND lower(COALESCE(NULLIF(btrim(dt.author), ''), '佚名')) = lower(COALESCE(NULLIF(btrim(b.author), ''), '佚名'))
      AND dt.status = 'done' ORDER BY dt.id DESC LIMIT 1)` : sql`NULL::integer`;
  return sql`SELECT DISTINCT ON (r.book_id)
      r.id, r.query, r.match_score, r.hit_likes, r.risks, r.reason, r.status, r.created_at,
      b.title, b.author, b.douban_id, b.douban_rating, b.douban_rating_count, b.meta,
      ${readTask} AS read_task_id,
      COALESCE((SELECT f.note FROM feedback f WHERE f.book_id = r.book_id AND f.user_id = ${userId}
        ORDER BY f.created_at DESC, f.id DESC LIMIT 1), '') AS note
    FROM recommendations r JOIN books b ON b.id = r.book_id
    WHERE r.user_id = ${userId}
    ORDER BY r.book_id, r.created_at DESC, r.match_score DESC, r.id DESC LIMIT 300`;
}

export function shelfExistsForUserQuery(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  return sql`SELECT 1 FROM recommendations r JOIN books b ON b.id = r.book_id
    WHERE r.user_id = ${userId} AND lower(b.title) = lower(${title}) AND lower(b.author) = lower(${author}) LIMIT 1`;
}

export function addShelfForUserQueries(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  return [
    sql`INSERT INTO books (title, author, meta) VALUES (${title}, ${author}, '{}'::jsonb)
      ON CONFLICT (lower(title), lower(author)) DO NOTHING`,
    sql`INSERT INTO recommendations (user_id, book_id, query, status)
      SELECT ${userId}, b.id, ${'书库添加'}, ${'want'} FROM books b
      WHERE lower(b.title) = lower(${title}) AND lower(b.author) = lower(${author})
        AND NOT EXISTS (SELECT 1 FROM recommendations r WHERE r.book_id = b.id AND r.user_id = ${userId})
      ON CONFLICT (user_id, book_id, query) DO NOTHING RETURNING book_id`,
  ];
}

export function deleteShelfForUserQuery(sql: PersonalQuery, userId: number, id: number) {
  requireUserId(userId);
  return sql`DELETE FROM recommendations WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
}

export function findStatsForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT count(DISTINCT query)::int AS queries, count(*)::int AS recommendations
    FROM recommendations WHERE user_id = ${userId} AND query <> ${'书库添加'}`;
}

export function shelfStatsForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT status AS name, count(*)::int AS count FROM recommendations
    WHERE user_id = ${userId} GROUP BY status ORDER BY count DESC`;
}

export function personalExportQueries(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return [
    sql`SELECT id, seeds, content, updated_at::text AS updated_at FROM profile WHERE id = ${userId}`,
    sql`SELECT b.* FROM books b WHERE
      EXISTS (SELECT 1 FROM recommendations r WHERE r.book_id = b.id AND r.user_id = ${userId})
      OR EXISTS (SELECT 1 FROM feedback f WHERE f.book_id = b.id AND f.user_id = ${userId}) ORDER BY b.id`,
    sql`SELECT id, user_id, book_id, query, match_score, hit_likes, risks, reason, status, created_at
      FROM recommendations WHERE user_id = ${userId} ORDER BY id`,
    sql`SELECT id, user_id, book_id, status, note, created_at FROM feedback WHERE user_id = ${userId} ORDER BY id`,
    sql`SELECT id, title, author, category, finish_status, source_site, source_url,
      chars_labeled, labeled_at, primary_genre, sub_tags, quality FROM labeled_books ORDER BY id`,
  ];
}

export function profileForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT seeds, content, updated_at::text AS updated_at FROM profile WHERE id = ${userId}`;
}

export function saveProfileForUserQuery(sql: PersonalQuery, userId: number, seeds: unknown, content: string, expectedUpdatedAt: string) {
  requireUserId(userId);
  return sql`UPDATE profile
    SET seeds = ${JSON.stringify(seeds)}::jsonb, content = ${content},
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE id = ${userId} AND updated_at::text = ${expectedUpdatedAt}
    RETURNING updated_at::text AS updated_at`;
}

export function excludedBooksForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT b.title, b.author FROM books b WHERE EXISTS (
    SELECT 1 FROM feedback f WHERE f.book_id = b.id AND f.user_id = ${userId} AND f.status IN ('done', 'dropped'))`;
}

export function persistRecommendationsForUserQueries(s: PersonalQuery, userId: number, query: string, items: RerankedItem[]) {
  requireUserId(userId);

  const bookQueries = items.map((item) => s`
    INSERT INTO books (title, author, douban_id, douban_rating, douban_rating_count, meta)
    VALUES (${item.title}, ${item.author}, ${item.douban?.doubanId ?? null},
            ${item.douban?.rating ?? null}, ${item.douban?.ratingCount ?? null},
            ${JSON.stringify({ category: item.category, wordCount: item.wordCount })}::jsonb)
    ON CONFLICT (lower(title), lower(author)) DO UPDATE
      SET douban_id = COALESCE(EXCLUDED.douban_id, books.douban_id),
          douban_rating = COALESCE(EXCLUDED.douban_rating, books.douban_rating),
          douban_rating_count = COALESCE(EXCLUDED.douban_rating_count, books.douban_rating_count),
          meta = books.meta || EXCLUDED.meta`);
  const recommendationQueries = items.map((item) => s`
    INSERT INTO recommendations (user_id, book_id, query, match_score, hit_likes, risks, reason)
    SELECT ${userId}, id, ${query}, ${item.matchScore}, ${JSON.stringify(item.hitLikes)}::jsonb,
           ${item.risks}, ${item.reason}
    FROM books
    WHERE lower(title) = lower(${item.title}) AND lower(author) = lower(${item.author})
    ON CONFLICT (user_id, book_id, query) DO UPDATE
      SET match_score = EXCLUDED.match_score,
          hit_likes = EXCLUDED.hit_likes,
          risks = EXCLUDED.risks,
          reason = EXCLUDED.reason,
          created_at = now()`);
  return [...bookQueries, ...recommendationQueries];
}

export function feedbackForUserQueries(sql: PersonalQuery, userId: number, book: { title: string; author: string }, status: string, note: string) {
  requireUserId(userId);
  return [

    sql`INSERT INTO books (title, author, meta) VALUES (${book.title}, ${book.author}, '{}'::jsonb)
        ON CONFLICT (lower(title), lower(author)) DO NOTHING`,
    sql`INSERT INTO feedback (user_id, book_id, status, note)
        SELECT ${userId}, id, ${status}, ${note} FROM books
        WHERE lower(title) = lower(${book.title}) AND lower(author) = lower(${book.author})`,
    sql`UPDATE recommendations SET status = ${status}
        WHERE user_id = ${userId} AND book_id IN (
          SELECT id FROM books WHERE lower(title) = lower(${book.title}) AND lower(author) = lower(${book.author}))`,
  ];
}
