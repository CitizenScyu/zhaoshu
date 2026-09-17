import type { PersonalQuery } from './personal-write';
import type { RerankedItem } from './types';
// 显式带 .ts 扩展名：本文件被 scripts/*.mjs 用 node --experimental-strip-types 直接
// 加载（见 personal-db-cases.mjs），Node 的 ESM 解析器不做扩展名补全。
import { normalizeBookAuthor, normalizeBookTitle } from './book-identity.ts';

export function requireUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2_147_483_647) throw new Error('explicit userId is required');
}

// books 的身份边界：凡是把 (title, author) 变成 books 身份查询的地方，都先过这一对
// 归一函数（task-49）。写和查必须用同一个函数，否则同一本书会写成两行、或查不到
// 已写的那一行。归一在这里做且只做一次——函数对书名号不幂等（《《x》》会被剥两层），
// 所以调用方（find/shelf 路由）传原值，不要预先归一。
// 返回值刻意叫 title/author：SQL 模板里仍然写 ${book.title} / ${book.author}，
// scripts/check-feedback-cas.mjs 会抽取模板并按这个字面量白名单替换参数。
function identityOf(title: string, author: string): { title: string; author: string } {
  return { title: normalizeBookTitle(title), author: normalizeBookAuthor(author) };
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
        ORDER BY f.id DESC LIMIT 1), '') AS note,
      COALESCE((SELECT f.id FROM feedback f WHERE f.book_id = r.book_id AND f.user_id = ${userId}
        ORDER BY f.id DESC LIMIT 1), 0) AS feedback_id
    FROM recommendations r JOIN books b ON b.id = r.book_id
    WHERE r.user_id = ${userId}
    ORDER BY r.book_id, r.created_at DESC, r.match_score DESC, r.id DESC LIMIT 300`;
}

export function shelfExistsForUserQuery(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  return sql`SELECT 1 FROM recommendations r JOIN books b ON b.id = r.book_id
    WHERE r.user_id = ${userId} AND lower(b.title) = lower(${book.title}) AND lower(b.author) = lower(${book.author}) LIMIT 1`;
}

export function addShelfForUserQueries(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  return [
    sql`INSERT INTO books (title, author, meta) VALUES (${book.title}, ${book.author}, '{}'::jsonb)
      ON CONFLICT (title_key, author_key) DO NOTHING`,
    sql`INSERT INTO recommendations (user_id, book_id, query, status)
      SELECT ${userId}, b.id, ${'书库添加'}, ${'want'} FROM books b
      WHERE lower(b.title) = lower(${book.title}) AND lower(b.author) = lower(${book.author})
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

// 下载任务自 auth schema v5 起有 NOT NULL 的 user_id（历史行归到用户 1），归属可信。
// 章数与字数只累加已完成任务：failed/中断任务的部分进度不是「战果」，与 tile 主数的 done 口径一致。
export function downloadStatsForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = ${'done'})::int AS done,
      COALESCE(sum(chapters_done) FILTER (WHERE status = ${'done'}), 0)::int AS chapters,
      COALESCE(sum(chars_total) FILTER (WHERE status = ${'done'}), 0)::int AS chars
    FROM download_tasks WHERE user_id = ${userId}`;
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
  // Lock and compare before replacing. Audit and CAS commit together: an audit
  // failure rolls back the save, and a stale writer creates neither change.
  // updated_at 是乐观锁版本号，只在种子或正文真的变了时推进：否则一次内容
  // 不变的写入（模型原样返回画像）也会让所有持有旧版本的草稿提交时误撞冲突。
  return sql`WITH input AS (
      SELECT ${JSON.stringify(seeds)}::jsonb AS seeds, ${content}::text AS content
    ), previous AS MATERIALIZED (
      SELECT id, seeds, content, updated_at FROM profile
      WHERE id = ${userId} AND updated_at::text = ${expectedUpdatedAt} FOR UPDATE
    ), updated AS (
      UPDATE profile
      SET seeds = input.seeds, content = input.content,
          updated_at = CASE WHEN previous.seeds IS DISTINCT FROM input.seeds
                              OR previous.content IS DISTINCT FROM input.content
            THEN GREATEST(clock_timestamp(), profile.updated_at + interval '1 microsecond')
            ELSE profile.updated_at END
      FROM previous, input
      WHERE profile.id = previous.id AND profile.updated_at = previous.updated_at
      RETURNING profile.updated_at::text AS updated_at
    ), audit AS (
      INSERT INTO profile_seed_audit
        (user_id, previous_version, saved_version, added_titles, removed_titles, previous_seeds, saved_seeds)
      SELECT previous.id, previous.updated_at::text, updated.updated_at,
        COALESCE((SELECT jsonb_agg(added.title) FROM (
          SELECT n->>'title' AS title, COALESCE(n->>'author', '') AS author FROM jsonb_array_elements(input.seeds) n
          EXCEPT ALL
          SELECT p->>'title', COALESCE(p->>'author', '') FROM jsonb_array_elements(previous.seeds) p
        ) added), '[]'::jsonb),
        COALESCE((SELECT jsonb_agg(removed.title) FROM (
          SELECT p->>'title' AS title, COALESCE(p->>'author', '') AS author FROM jsonb_array_elements(previous.seeds) p
          EXCEPT ALL
          SELECT n->>'title', COALESCE(n->>'author', '') FROM jsonb_array_elements(input.seeds) n
        ) removed), '[]'::jsonb),
        previous.seeds, input.seeds
      FROM previous, input, updated WHERE previous.seeds IS DISTINCT FROM input.seeds
      RETURNING id
    ) SELECT updated_at FROM updated`;
}

export function excludedBooksForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT b.title, b.author FROM books b WHERE EXISTS (
    SELECT 1 FROM feedback f WHERE f.book_id = b.id AND f.user_id = ${userId} AND f.status IN ('done', 'dropped'))`;
}

export function persistRecommendationsForUserQueries(s: PersonalQuery, userId: number, query: string, items: RerankedItem[]) {
  requireUserId(userId);

  // 写库前先按身份键归一：阻止新的《》/全半角/大小写变体继续在 books 里派生新行。
  // 下面两条语句必须用同一份归一后的值——第二条靠 lower(title)=lower(...) 找回刚写的那行。
  const identities = items.map((item) => identityOf(item.title, item.author));
  const bookQueries = items.map((item, i) => {
    const book = identities[i];
    return s`
    INSERT INTO books (title, author, douban_id, douban_rating, douban_rating_count, meta)
    VALUES (${book.title}, ${book.author}, ${item.douban?.doubanId ?? null},
            ${item.douban?.rating ?? null}, ${item.douban?.ratingCount ?? null},
            ${JSON.stringify({ category: item.category, wordCount: item.wordCount })}::jsonb)
    ON CONFLICT (title_key, author_key) DO UPDATE
      SET douban_id = COALESCE(EXCLUDED.douban_id, books.douban_id),
          douban_rating = COALESCE(EXCLUDED.douban_rating, books.douban_rating),
          douban_rating_count = COALESCE(EXCLUDED.douban_rating_count, books.douban_rating_count),
          meta = books.meta || EXCLUDED.meta`;
  });
  const recommendationQueries = items.map((item, i) => {
    const book = identities[i];
    return s`
    INSERT INTO recommendations (user_id, book_id, query, match_score, hit_likes, risks, reason)
    SELECT ${userId}, id, ${query}, ${item.matchScore}, ${JSON.stringify(item.hitLikes)}::jsonb,
           ${item.risks}, ${item.reason}
    FROM books
    WHERE lower(title) = lower(${book.title}) AND lower(author) = lower(${book.author})
    ON CONFLICT (user_id, book_id, query) DO UPDATE
      SET match_score = EXCLUDED.match_score,
          hit_likes = EXCLUDED.hit_likes,
          risks = EXCLUDED.risks,
          reason = EXCLUDED.reason,
          created_at = now()`;
  });
  return [...bookQueries, ...recommendationQueries];
}

// 追加式反馈历史同时是状态/note 编辑的审计记录。锁书籍行后比较最新反馈 id：
// 缺版本只允许首次创建；旧版本不能覆盖已有反馈（22012 → FeedbackConflictError 由调用方转译）。
export function feedbackForUserQueries(sql: PersonalQuery, userId: number, raw: { title: string; author: string }, status: string, note: string, expectedVersion = 0) {
  requireUserId(userId);
  // 客户端回传的是召回阶段的原始拼写（find 结果原样显示），写库时已归一，
  // 这里必须过同一个函数才能找回那一行；否则含《》/全半角的书名一律 404。
  // 参数名 raw、局部名 book：SQL 模板里的 ${book.title}/${book.author} 是
  // scripts/check-feedback-cas.mjs 抽取模板时依赖的字面量，别改。
  const book = identityOf(raw.title, raw.author);
  return [
    sql`SELECT id FROM books WHERE lower(title) = lower(${book.title}) AND lower(author) = lower(${book.author}) FOR UPDATE`,
    sql`SELECT id FROM books WHERE lower(title) = lower(${book.title}) AND lower(author) = lower(${book.author})`,
    sql`SELECT 1 / CASE WHEN COALESCE((
      SELECT max(f.id) FROM feedback f JOIN books b ON b.id = f.book_id
      WHERE f.user_id = ${userId} AND lower(b.title) = lower(${book.title}) AND lower(b.author) = lower(${book.author})
    ), 0) = ${expectedVersion} THEN 1 ELSE 0 END AS feedback_version_matches`,
    sql`INSERT INTO feedback (user_id, book_id, status, note)
        SELECT ${userId}, id, ${status}, ${note} FROM books
        WHERE lower(title) = lower(${book.title}) AND lower(author) = lower(${book.author})
        RETURNING id`,
    sql`UPDATE recommendations SET status = ${status}
        WHERE user_id = ${userId} AND book_id IN (
          SELECT id FROM books WHERE lower(title) = lower(${book.title}) AND lower(author) = lower(${book.author}))`,
  ];
}

export function feedbackSnapshotForUserQuery(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  return sql`SELECT f.id, f.status, f.note FROM feedback f JOIN books b ON b.id = f.book_id
    WHERE f.user_id = ${userId} AND lower(b.title) = lower(${book.title}) AND lower(b.author) = lower(${book.author})
    ORDER BY f.id DESC LIMIT 1`;
}
