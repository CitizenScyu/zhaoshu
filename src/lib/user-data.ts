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

// 批量清掉「未处理」堆：只删 status='new' 的推荐行。
//
// 刻意不按「书架返回的那批 id」删：recommendationsForUserQuery 是
// `DISTINCT ON (r.book_id)`，一本书只返回最新那一条，而 status 更新
// （feedbackForUserQueries）是整本书所有行一起改的——一本书完全可能同时有
// 一条新的非 new 行和一条新的 new 行，按返回 id 删会漏掉后者。
//
// 也刻意不按「最新一条是 new 的书」删：那样一部分 new 行会留下成为孤儿。
// 直接删全部 new 行是唯一与「清空未处理」字面一致的语义；被删行所属的书若
// 还有非 new 行，书架卡不会消失，只会回到它真实的状态分组里。
export function clearNewShelfForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`DELETE FROM recommendations WHERE user_id = ${userId} AND status = ${'new'} RETURNING id`;
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

// 召回排除集合（task-56 T56-1）：除了有反馈记录的书，还要排除**已在书架**的书，
// 否则同一本书会被后续每个 query 重新召回一次。
//
// 「已在书架」的口径是 recommendations.status <> 'new'：'new' 是 find 自动落库、用户
// 尚未处理的推荐；want/reading/done/dropped 都来自用户显式动作（书架添加写 'want'，
// 反馈写对应状态）。刻意**不**排除仅有 status = 'new' 历史推荐的书——那会让用户重搜
// 同一题材时永远看不到这些书，相似书也被整片屏蔽。
// books 没有 user 归属，user 维度只能由 recommendations/feedback 提供。
export function excludedBooksForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT b.title, b.author FROM books b WHERE
    EXISTS (SELECT 1 FROM recommendations r
      WHERE r.book_id = b.id AND r.user_id = ${userId} AND r.status <> 'new')
    OR EXISTS (SELECT 1 FROM feedback f WHERE f.book_id = b.id AND f.user_id = ${userId})`;
}

export function persistRecommendationsForUserQueries(s: PersonalQuery, userId: number, query: string, items: RerankedItem[]) {
  requireUserId(userId);

  // 写库前先按身份键归一：阻止新的《》/全半角/大小写变体继续在 books 里派生新行。
  // 两条语句必须用同一份归一后的值——第二条靠身份键找回刚写的那行。
  // 批量形态（P2-4）：原先每本两条语句（2N 条进同一事务批，10 本 = 20 条），现在
  // 恒定两条：books 批量 upsert + recommendations 批量落库，身份经 jsonb 参数传入，
  // 与 shuyuan.ts 的 jsonb_to_recordset 批插同一模式。j.title/j.author 是**归一后的
  // 身份值**，与 books 的生成列 title_key/author_key 同源（book-identity.ts 对齐
  // migrations/0002 的 SQL 表达式），因此 recommendations 侧的回查从旧的
  // lower(title)=lower(...) 改为键等值比较——对已归一输入语义不变（见
  // user-data.identity.test.ts 与 route.pglite.test.ts 的真库回归）。
  const rows = items.map((item) => {
    const book = identityOf(item.title, item.author);
    return {
      title: book.title,
      author: book.author,
      douban_id: item.douban?.doubanId ?? null,
      rating: item.douban?.rating ?? null,
      rating_count: item.douban?.ratingCount ?? null,
      meta: { category: item.category, wordCount: item.wordCount },
      match_score: item.matchScore,
      hit_likes: item.hitLikes,
      risks: item.risks,
      reason: item.reason,
    };
  });
  return [
    s`
    INSERT INTO books (title, author, douban_id, douban_rating, douban_rating_count, meta)
    SELECT title, author, douban_id, rating, rating_count, meta
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS j(title text, author text, douban_id text, rating float8, rating_count int, meta jsonb, match_score float8, hit_likes jsonb, risks text, reason text)
    ON CONFLICT (title_key, author_key) DO UPDATE
      SET douban_id = COALESCE(EXCLUDED.douban_id, books.douban_id),
          douban_rating = COALESCE(EXCLUDED.douban_rating, books.douban_rating),
          douban_rating_count = COALESCE(EXCLUDED.douban_rating_count, books.douban_rating_count),
          meta = books.meta || EXCLUDED.meta`,
    s`
    INSERT INTO recommendations (user_id, book_id, query, match_score, hit_likes, risks, reason)
    SELECT ${userId}, b.id, ${query}, j.match_score, j.hit_likes, j.risks, j.reason
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS j(title text, author text, match_score float8, hit_likes jsonb, risks text, reason text)
    JOIN books b ON b.title_key = j.title AND b.author_key = j.author
    ON CONFLICT (user_id, book_id, query) DO UPDATE
      SET match_score = EXCLUDED.match_score,
          hit_likes = EXCLUDED.hit_likes,
          risks = EXCLUDED.risks,
          reason = EXCLUDED.reason,
          created_at = now()`,
  ];
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
    // 路线 B（task-82）：书库的书只在 labeled_books 里，books 没有行——而后 4 条语句全靠
    // books 定位（feedback.book_id NOT NULL FK→books，写不进去就是 404 BOOK_NOT_FOUND）。
    // 所以在同一事务最前面补一行 books，后面 4 条语句一个字都不用改，它们会自动找到这行。
    //
    // 拼写优先取 labeled_books 那一行（与 addShelfForUserQueries:52 同式，DO NOTHING 是
    // 同一个 books_identity_idx 唯一索引）；取不到（find-only 的书）才回落客户端归一值，
    // 与加书架路径一致。这样新建行的身份键 == 书库那一行的身份键，两张表真"对上"。
    //
    // 🔴 两条不变量：
    //   ① 刻意**不建 recommendations 行**：'new' 之外的状态会经 excludedBooksForUserQuery
    //      把书永久移出召回，只有"真的提交了反馈"才该触发那条排除。这里只补身份行，
    //      召回排除仍由本函数最后一条 UPDATE（反馈真的写成功时）负责。
    //   ② 插入的是 btrim 过的拼写，不是 labeled_books 原值：后面 4 条语句比的是
    //      lower(title) = lower(book.title)（不带 btrim），若把带首尾空格的拼写原样写进
    //      books，就会"行建出来了却仍定位不到"→ 依旧 404。生产实测首尾空白 0 行，
    //      这里是把它钉死，不依赖数据恰好干净。
    sql`INSERT INTO books (title, author, meta)
      SELECT title, author, '{}'::jsonb FROM (
        SELECT btrim(title) AS title, btrim(author) AS author, 0 AS pref FROM labeled_books
         WHERE lower(btrim(title)) = lower(${book.title})
           AND lower(btrim(author)) = lower(${book.author})
        UNION ALL
        SELECT ${book.title}, ${book.author}, 1
      ) c ORDER BY pref LIMIT 1
      ON CONFLICT (title_key, author_key) DO NOTHING`,
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

// 精确找书（task-77）的本地命中查询：按身份键在 books 里精确找，命中即返回、不打豆瓣。
//
// 查询条件是**生成列** title_key / author_key（migrations/0002_identity_key.sql），
// 与写侧的 ON CONFLICT (title_key, author_key) 指向同一套键。这里刻意不再用
// lower(title) = lower(...)：那套比较绕过了《》/全角归一，`《红楼》` 与 `红楼` 会查不到同一行。
//
// 输入只归一一次（identityOf），与所有其他 books 身份查询同源。
// 不传作者时可能命中同名不同作者的多行——那是要展示给用户挑的，所以不是 LIMIT 1。
const MAX_EXACT_LIBRARY_HITS = 5;

export function exactLibraryBooksForUserQuery(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  // on_shelf 只影响「加入书架」按钮的初始态；books 没有 user 归属，user 维度由
  // recommendations 提供（与 excludedBooksForUserQuery 同源）。这里**不**限定 status：
  // 书架上任何状态都算「已在书架」，与 shelfExistsForUserQuery 的口径一致。
  const columns = sql`SELECT b.id, b.title, b.author, b.douban_id, b.douban_rating, b.douban_rating_count, b.meta,
      EXISTS (SELECT 1 FROM recommendations r WHERE r.book_id = b.id AND r.user_id = ${userId}) AS on_shelf
    FROM books b`;
  return book.author
    ? sql`${columns} WHERE b.title_key = ${book.title} AND b.author_key = ${book.author}
        ORDER BY b.id LIMIT ${MAX_EXACT_LIBRARY_HITS}`
    : sql`${columns} WHERE b.title_key = ${book.title}
        ORDER BY b.id LIMIT ${MAX_EXACT_LIBRARY_HITS}`;
}
