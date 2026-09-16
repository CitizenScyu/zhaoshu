import type { PersonalQuery } from './personal-write';

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
