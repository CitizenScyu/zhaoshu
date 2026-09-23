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
//
// F09：返回值是**身份键**，不是展示名。写库时原始 title/author 原样进 title/author 列
// （生成列再归一一次得到同一把键），这里的归一结果只作为比较参数 / 冲突目标出现。
// 若把本函数结果写回展示列，生成列会对《《x》》再剥一层，键与参数分叉 → 静默漏写。
// 返回值刻意叫 title/author：SQL 模板里仍然写 ${book.title} / ${book.author}，
// scripts/check-feedback-cas.mjs 会抽取模板并按这个字面量白名单替换参数。
function identityOf(title: string, author: string): { title: string; author: string } {
  return { title: normalizeBookTitle(title), author: normalizeBookAuthor(author) };
}

// 书架分页默认与上限（本也是原 LIMIT 300 的字面量；SHELF_ROW_LIMIT 由 shelf-view 导出，
// 两边一致性由 shelf-view.test.ts 的源码断言钉住）。
const SHELF_PAGE_LIMIT = 300;

export interface ShelfQueryOptions {
  /** 服务端搜索词，按 title/author 子串过滤（空串 = 不过滤）。 */
  q?: string;
  /** 单页本数，1..300。 */
  limit?: number;
  /** 跳过本数，>= 0。 */
  offset?: number;
}

// LIKE 通配符转义（与 library/route.ts 同式）：未转义的 %/_ 会变成通配符。
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return SHELF_PAGE_LIMIT;
  return Math.min(value as number, SHELF_PAGE_LIMIT);
}

function boundedOffset(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

// 只构造 SQL，供路由和隔离库验收共用；不读取任何连接配置或客户端身份字段。
//
// F06：内层 DISTINCT ON (r.book_id) 取每本书的代表行（同一套「最新优先」三级 tie-break），
// **外层**才按 created_at DESC, id DESC 排序并分页。旧写法把 LIMIT 300 压在内层
// `ORDER BY r.book_id` 上，等于按 book_id 砍尾巴，第 301 本新书被时间排序救不回来。
export function recommendationsForUserQuery(
  sql: PersonalQuery, userId: number, canRead: boolean, options: ShelfQueryOptions = {},
) {
  requireUserId(userId);
  const limit = boundedLimit(options.limit);
  const offset = boundedOffset(options.offset);
  const keyword = (options.q ?? '').trim().slice(0, 100);
  const search = keyword
    ? sql`AND (b.title ILIKE ${`%${escapeLike(keyword)}%`} ESCAPE '\\' OR b.author ILIKE ${`%${escapeLike(keyword)}%`} ESCAPE '\\')`
    : sql``;
  const readTask = canRead ? sql`(SELECT dt.id FROM download_tasks dt
    WHERE lower(btrim(dt.title)) = lower(btrim(b.title))
      AND lower(COALESCE(NULLIF(btrim(dt.author), ''), '佚名')) = lower(COALESCE(NULLIF(btrim(b.author), ''), '佚名'))
      AND dt.status = 'done' ORDER BY dt.id DESC LIMIT 1)` : sql`NULL::integer`;
  return sql`SELECT * FROM (
      SELECT DISTINCT ON (r.book_id)
        r.id, r.book_id, r.query, r.match_score, r.hit_likes, r.risks, r.reason, r.status, r.created_at,
        b.title, b.author, b.douban_id, b.douban_rating, b.douban_rating_count, b.meta,
        ${readTask} AS read_task_id,
        COALESCE((SELECT f.note FROM feedback f WHERE f.book_id = r.book_id AND f.user_id = ${userId}
          ORDER BY f.id DESC LIMIT 1), '') AS note,
        COALESCE((SELECT f.id FROM feedback f WHERE f.book_id = r.book_id AND f.user_id = ${userId}
          ORDER BY f.id DESC LIMIT 1), 0) AS feedback_id
      FROM recommendations r JOIN books b ON b.id = r.book_id
      WHERE r.user_id = ${userId} ${search}
      ORDER BY r.book_id, r.created_at DESC, r.match_score DESC, r.id DESC
    ) rep
    ORDER BY rep.created_at DESC, rep.id DESC
    LIMIT ${limit} OFFSET ${offset}`;
}

export function shelfExistsForUserQuery(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  return sql`SELECT 1 FROM recommendations r JOIN books b ON b.id = r.book_id
    WHERE r.user_id = ${userId} AND b.title_key = ${book.title} AND b.author_key = ${book.author} LIMIT 1`;
}

export function addShelfForUserQueries(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  return [
    // F09：展示列存原始拼写；身份键由生成列从原始值归一得到，与 ${book.*} 比较参数同源。
    sql`INSERT INTO books (title, author, meta) VALUES (${title}, ${author}, '{}'::jsonb)
      ON CONFLICT (title_key, author_key) DO NOTHING`,
    // F08：加书架只改变「是否收藏」，**不隐式重置阅读状态**——status 取该用户该书最新
    // 有效 feedback；没有 feedback 才 want。移除后重新加入同样保持原读后状态。
    sql`INSERT INTO recommendations (user_id, book_id, query, status)
      SELECT ${userId}, b.id, ${'书库添加'},
        COALESCE((SELECT f.status FROM feedback f
          WHERE f.book_id = b.id AND f.user_id = ${userId}
          ORDER BY f.id DESC LIMIT 1), ${'want'})
      FROM books b
      WHERE b.title_key = ${book.title} AND b.author_key = ${book.author}
        AND NOT EXISTS (SELECT 1 FROM recommendations r WHERE r.book_id = b.id AND r.user_id = ${userId})
      ON CONFLICT (user_id, book_id, query) DO NOTHING RETURNING book_id`,
  ];
}

// F05：移除语义按 (user_id, book_id) —— 列表按书展示（DISTINCT ON book_id），删除也必须
// 按书删除，否则同一本书的另一条 query 行会残留、刷新重现。**只删推荐行，feedback 保留**
// （读后状态不属书架归属）。bookId 由调用方从列表行带回；不接受 recommendation id，
// 避免「删错一本书的某一条」再次发生。
export function deleteShelfForUserQuery(sql: PersonalQuery, userId: number, bookId: number) {
  requireUserId(userId);
  return sql`DELETE FROM recommendations WHERE user_id = ${userId} AND book_id = ${bookId} RETURNING id`;
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

// v7 系统请求没有 user_id；个人统计显式限定 user 身份和当前用户。
// 章数与字数只累加已完成任务：failed/中断任务的部分进度不是「战果」，与 tile 主数的 done 口径一致。
export function downloadStatsForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = ${'done'})::int AS done,
      COALESCE(sum(chapters_done) FILTER (WHERE status = ${'done'}), 0)::int AS chapters,
      COALESCE(sum(chars_total) FILTER (WHERE status = ${'done'}), 0)::int AS chars
    FROM download_tasks WHERE requested_by = 'user' AND user_id = ${userId}`;
}

// F07：统计与列表同口径——先按 (user_id, book_id) 取代表行（与 recommendationsForUserQuery
// 同一套 DISTINCT ON + 三级 tie-break），再 GROUP BY status 计数。状态是整本书所有推荐行
// 一起改的（feedbackForUserQueries），取代表行的 status 即该书的书架状态。
// 验收：同书多次推荐不增本数；各分类之和 = 可分页列出的作品总数。
export function shelfStatsForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT status AS name, count(*)::int AS count FROM (
      SELECT DISTINCT ON (r.book_id) r.book_id, r.status, r.created_at, r.match_score, r.id
      FROM recommendations r WHERE r.user_id = ${userId}
      ORDER BY r.book_id, r.created_at DESC, r.match_score DESC, r.id DESC
    ) rep GROUP BY status ORDER BY count DESC`;
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

  // F09：books 的 title/author 存**原始展示名**，身份归一**只发生在生成列与比较参数**。
  // 归一结果（identityOf）作为 title_key/author_key 参数随行传入，仅用于：
  //   ① books 的 ON CONFLICT (title_key, author_key)（生成列从原始值算键，与参数同源）；
  //   ② recommendations 用 j.title_key/j.author_key 回查 books。
  // 旧写法把归一结果写进 books.title，生成列再剥一层《》→ 键与参数分叉，
  // `《《x》》` 这类输入 0 条推荐且事务成功（R06）。
  // 批量形态（P2-4）：恒定两条语句：books 批量 upsert + recommendations 批量落库。
  const rows = items.map((item) => {
    const book = identityOf(item.title, item.author);
    return {
      title: item.title,
      author: item.author,
      title_key: book.title,
      author_key: book.author,
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
      AS j(title text, author text, douban_id text, rating float8, rating_count int, meta jsonb, match_score float8, hit_likes jsonb, risks text, reason text, title_key text, author_key text)
    ON CONFLICT (title_key, author_key) DO UPDATE
      SET douban_id = COALESCE(EXCLUDED.douban_id, books.douban_id),
          douban_rating = COALESCE(EXCLUDED.douban_rating, books.douban_rating),
          douban_rating_count = COALESCE(EXCLUDED.douban_rating_count, books.douban_rating_count),
          meta = books.meta || EXCLUDED.meta`,
    // RETURNING b.id：调用方据实际写入行数与期望本数比对，数量不符不得回报 persisted=true。
    s`
    INSERT INTO recommendations (user_id, book_id, query, match_score, hit_likes, risks, reason)
    SELECT ${userId}, b.id, ${query}, j.match_score, j.hit_likes, j.risks, j.reason
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS j(title_key text, author_key text, match_score float8, hit_likes jsonb, risks text, reason text)
    JOIN books b ON b.title_key = j.title_key AND b.author_key = j.author_key
    ON CONFLICT (user_id, book_id, query) DO UPDATE
      SET match_score = EXCLUDED.match_score,
          hit_likes = EXCLUDED.hit_likes,
          risks = EXCLUDED.risks,
          reason = EXCLUDED.reason,
          created_at = now()
    RETURNING book_id`,
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
    //   ② 插入的是 btrim 过的拼写，不是 labeled_books 原值：后续语句按 title_key 键等值
    //      定位，若把带首尾空格的拼写原样写进 books，生成列就与参数键分叉 →
    //      "行建出来了却仍定位不到" → 依旧 404。生产实测首尾空白 0 行，这里是把它
    //      钉死，不依赖数据恰好干净。
    sql`INSERT INTO books (title, author, meta)
      SELECT title, author, '{}'::jsonb FROM (
        SELECT btrim(title) AS title, btrim(author) AS author, 0 AS pref FROM labeled_books
         WHERE title_key = ${book.title}
           AND author_key = ${book.author}
        UNION ALL
        SELECT ${book.title}, ${book.author}, 1
      ) c ORDER BY pref LIMIT 1
      ON CONFLICT (title_key, author_key) DO NOTHING`,
    sql`SELECT id FROM books WHERE title_key = ${book.title} AND author_key = ${book.author} FOR UPDATE`,
    sql`SELECT id FROM books WHERE title_key = ${book.title} AND author_key = ${book.author}`,
    sql`SELECT 1 / CASE WHEN COALESCE((
      SELECT max(f.id) FROM feedback f JOIN books b ON b.id = f.book_id
      WHERE f.user_id = ${userId} AND b.title_key = ${book.title} AND b.author_key = ${book.author}
    ), 0) = ${expectedVersion} THEN 1 ELSE 0 END AS feedback_version_matches`,
    sql`INSERT INTO feedback (user_id, book_id, status, note)
        SELECT ${userId}, id, ${status}, ${note} FROM books
        WHERE title_key = ${book.title} AND author_key = ${book.author}
        RETURNING id`,
    sql`UPDATE recommendations SET status = ${status}
        WHERE user_id = ${userId} AND book_id IN (
          SELECT id FROM books WHERE title_key = ${book.title} AND author_key = ${book.author})`,
  ];
}

// F15：反馈写事务的第二步——登记「该用户有反馈待吸收」。与反馈 INSERT 同一事务，反馈落库
// 即事件落库（要么都有、要么都没有）。吸收侧按用户合并执行，写路径绝不调用模型。
//
// 为什么用「单值水位 + GREATEST」而不是每本书一行：并发写两本书的反馈时，两条事务都只把水位
// 抬到各自（或更高的）反馈 id，互不覆盖；吸收侧按用户一次性读取全部最新有效反馈，于是两条
// 反馈必然被同一次吸收覆盖，不存在「一个 CAS 成功、另一个永久不被吸收」。
//
// 🔴 F41-F1 不变量（异步吸收水位不越过已喂行）三条腿之一：pending_feedback_id 记的是
// **全表** max(id)，不是「已喂上界」。吸收侧因此绝不能拿它当推进候选——必须取本轮实喂
// 上界（见 recentInformativeFeedbackForUserQuery 的 afterId + ORDER BY feedback_id ASC，
// 以及 user-data.absorb-watermark-invariant.pglite.test.ts）。这里的 HAVING 只保证
// 「不制造幻影高位」，不保证「高位 = 已喂」，两者别混。
// HAVING max(id) > expectedVersion：只有本次真的追加了新反馈行才登记。route B 之后
// 「定位不到 books」几乎不可达，但一旦 INSERT 写 0 行，max(id) 仍等于旧版本，HAVING 落空 →
// 不产生队列事件（404 路径不留脏 pending）。
// queued=false（want/reading 且此前也非 informative）时 SELECT 无行，不登记——只有
// 「有信息量的反馈」或「撤回先前的 informative 反馈」才需要吸收。
// 退避曲线（F15 残留②）：连续第 n 次失败 → base × 4^(n-1)，封顶 cap。
// 30s → 2m → 8m → 32m → 1h（封顶）。曲线在这里算好（可单测），SQL 只落数值——
// 失败写入与退避设置在同一 UPDATE 里原子完成。
export const PROFILE_FEEDBACK_BACKOFF_BASE_MS = 30_000;
export const PROFILE_FEEDBACK_BACKOFF_CAP_MS = 3_600_000;

export function profileFeedbackBackoffMs(consecutiveFailures: number): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1) return 0;
  return Math.min(PROFILE_FEEDBACK_BACKOFF_BASE_MS * 4 ** (consecutiveFailures - 1), PROFILE_FEEDBACK_BACKOFF_CAP_MS);
}

export function enqueueProfileFeedbackForUserQuery(sql: PersonalQuery, userId: number, expectedVersion: number, queued: boolean) {
  requireUserId(userId);
  // 新反馈登记时**不动**租约与退避列：若吸收正持有租约进行中，这次 GREATEST 抬高 pending
  // 即可，完成后 markAbsorbed 的「pending 仍更高 → 退回 pending」分支会让它被下一次领取；
  // 若此前在退避中，新反馈也不解除退避（吸收本就要合并全部 pending，晚一个退避周期
  // 再一并吸收，语义正确且避免「每写一条反馈就重置退避」的打模型风暴）。
  return sql`INSERT INTO profile_feedback_queue (user_id, pending_feedback_id, status, updated_at)
    SELECT ${userId}, max(id), ${'pending'}, now() FROM feedback
    WHERE user_id = ${userId} AND ${queued}
    HAVING max(id) > ${expectedVersion}
    ON CONFLICT (user_id) DO UPDATE SET
      pending_feedback_id = GREATEST(COALESCE(profile_feedback_queue.pending_feedback_id, 0), EXCLUDED.pending_feedback_id),
      status = ${'pending'},
      updated_at = now()`;
}

export function profileFeedbackQueueForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT pending_feedback_id, absorbed_feedback_id, status, attempts, last_error, updated_at::text AS updated_at,
    next_eligible_at::text AS next_eligible_at
    FROM profile_feedback_queue WHERE user_id = ${userId}`;
}

// 领取谓词（租约 + 退避共用）。一行可被领取当且仅当：
//   - 有 pending 待吸收（pending_feedback_id 非空）；
//   - 无人持有效租约（lease_token 为空或 lease_expires_at 已过）；
//   - 退避已到期（next_eligible_at 为空或已过）。
// 三个条件都是列值判断，进同一 WHERE，供下面两条查询/UPDATE 共用（保持两处谓词
// 逐字一致，避免「领取用的谓词与扫描用的谓词分叉」这一类静默漏单）。
// 返回类型是单个 sql`` 表达式（模板调用结果），用 unknown 收窄避免与带 .transaction
// 属性的完整 tag 类型混淆。
export function leaseEligiblePredicate(sql: PersonalQuery): PersonalQuery {
  return sql`pending_feedback_id IS NOT NULL
    AND (lease_token = '' OR lease_expires_at IS NULL OR lease_expires_at < now())
    AND (next_eligible_at IS NULL OR next_eligible_at <= now())` as unknown as PersonalQuery;
}

// 排他领取（原子 CAS）：UPDATE ... WHERE 领取谓词，拿到行的执行者独占处理。
// PG 单条 UPDATE 对同一行天然串行：两个并发执行者只有先到者能把 lease_token 从
// ''/过期值改成自己的新 token（后到者的 WHERE 已不匹配，0 行），这就是「只有一个拿到」
// 的判定——不依赖 ReadCommitted 下的 SELECT FOR UPDATE 轮询。
// leaseMs 由调用方传（毫秒），写成参数而不是 interval 字面量，便于测试注入不同时长。
export function claimProfileFeedbackForUserQuery(sql: PersonalQuery, userId: number, leaseToken: string, leaseMs: number) {
  requireUserId(userId);
  const eligible = leaseEligiblePredicate(sql);
  return sql`UPDATE profile_feedback_queue
    SET lease_token = ${leaseToken},
        lease_expires_at = now() + (${leaseMs} * interval '1 millisecond')
    WHERE user_id = ${userId} AND ${eligible}
    RETURNING pending_feedback_id AS candidate`;
}

// drain 扫描：找出所有「有 pending 且可领取」的用户（与上面的单用户谓词同一来源）。
// 只选 id 不带行锁：真正的排他仍由后续对每个用户的 claim UPDATE 决定——扫描与领取之间
// 若浏览器先领走，claim 落 0 行，drain 跳过该用户即可，不产生双跑。
// F2 公平排序：updated_at ASC（最久未被动过的行优先），固定 user_id ASC 会让最低 id 的
// 慢性失败用户每天独占 drain 窗口、其后所有 pending 用户永无兜底。updated_at 被
// enqueue/成功/失败三类写入触碰：慢性失败用户每次 markFailed 都把自己推到队尾，自然
// 轮转。零 schema 变更——updated_at 是建表即有的 NOT NULL 列；user_id 只作同刻破平。
export function drainableProfileFeedbackUsersQuery(sql: PersonalQuery, limit: number) {
  const eligible = leaseEligiblePredicate(sql);
  return sql`SELECT user_id FROM profile_feedback_queue WHERE ${eligible} ORDER BY updated_at ASC, user_id ASC LIMIT ${limit}`;
}

// 一次吸收成功（applied/unchanged）后的水位推进：absorbed 取 GREATEST，pending 只在
// 「水位不高于本次候选」时清空——若吸收期间又有新反馈把 pending 抬得更高，保留它，并把
// 状态退回 pending（SET 里所有 RHS 都读旧值，所以这里的比较是推进前的 pending）。
// F15 租约配套：完成时校验 lease_token 未变才提交（WHERE 带 token），防租约过期后被
// 第二执行者重领、第一个迟到提交双写。成功即释放租约（lease_token=''、expires=NULL）
// 并清零退避（fail_count=0、next_eligible_at=NULL）——下次失败从曲线第一档重新开始。
export function markProfileFeedbackAbsorbedForUserQuery(sql: PersonalQuery, userId: number, candidate: number, status: string, leaseToken: string) {
  requireUserId(userId);
  return sql`UPDATE profile_feedback_queue
    SET absorbed_feedback_id = GREATEST(absorbed_feedback_id, ${candidate}),
        pending_feedback_id = CASE WHEN pending_feedback_id IS NOT NULL AND pending_feedback_id <= ${candidate}
          THEN NULL ELSE pending_feedback_id END,
        status = CASE WHEN pending_feedback_id IS NOT NULL AND pending_feedback_id > ${candidate}
          THEN ${'pending'} ELSE ${status} END,
        attempts = attempts + 1,
        last_error = '',
        lease_token = '',
        lease_expires_at = NULL,
        fail_count = 0,
        next_eligible_at = NULL,
        updated_at = now()
    WHERE user_id = ${userId} AND lease_token = ${leaseToken}
    RETURNING pending_feedback_id`;
}

// 无租约版水位推进（/api/profile 重建成功后推水位走这里）：调用方不持租约，不能带
// lease_token 校验（否则永远 0 行）。清 fail_count/next_eligible_at 保留——重建成功
// 等价于一次成功吸收，退避重置语义一致。
export function markProfileFeedbackAbsorbedUncheckedForUserQuery(sql: PersonalQuery, userId: number, candidate: number, status: string) {
  requireUserId(userId);
  return sql`UPDATE profile_feedback_queue
    SET absorbed_feedback_id = GREATEST(absorbed_feedback_id, ${candidate}),
        pending_feedback_id = CASE WHEN pending_feedback_id IS NOT NULL AND pending_feedback_id <= ${candidate}
          THEN NULL ELSE pending_feedback_id END,
        status = CASE WHEN pending_feedback_id IS NOT NULL AND pending_feedback_id > ${candidate}
          THEN ${'pending'} ELSE ${status} END,
        attempts = attempts + 1,
        last_error = '',
        fail_count = 0,
        next_eligible_at = NULL,
        updated_at = now()
    WHERE user_id = ${userId}
    RETURNING pending_feedback_id`;
}

// R3：画像正文与队列水位原子提交。先锁租约行，再锁匹配版本的画像；失配不会进入写 CTE。
// 吸收不修改 seeds，因此不需要种子审计；保留原内容未变化时不推进 updated_at 的 CAS 语义。
// completed 依赖 updated，画像 CAS 失败时绝不推进水位；任一写入报错会整条语句回滚。
export function completeProfileFeedbackForUserQuery(
  sql: PersonalQuery, userId: number, candidate: number, status: string,
  leaseToken: string, content: string, expectedUpdatedAt: string,
) {
  requireUserId(userId);
  return sql`WITH lease AS MATERIALIZED (
      SELECT user_id FROM profile_feedback_queue
      WHERE user_id = ${userId} AND lease_token = ${leaseToken} FOR UPDATE
    ), previous AS MATERIALIZED (
      SELECT id, content, updated_at FROM profile
      WHERE id = ${userId} AND updated_at::text = ${expectedUpdatedAt}
        AND EXISTS (SELECT 1 FROM lease) FOR UPDATE
    ), updated AS (
      UPDATE profile SET content = ${content},
        updated_at = CASE WHEN previous.content IS DISTINCT FROM ${content}
          THEN GREATEST(clock_timestamp(), profile.updated_at + interval '1 microsecond')
          ELSE profile.updated_at END
      FROM previous
      WHERE profile.id = previous.id AND profile.updated_at = previous.updated_at
      RETURNING profile.updated_at::text AS updated_at
    ), completed AS (
      UPDATE profile_feedback_queue SET
        absorbed_feedback_id = GREATEST(absorbed_feedback_id, ${candidate}),
        pending_feedback_id = CASE WHEN pending_feedback_id IS NOT NULL AND pending_feedback_id <= ${candidate}
          THEN NULL ELSE pending_feedback_id END,
        status = CASE WHEN pending_feedback_id IS NOT NULL AND pending_feedback_id > ${candidate}
          THEN ${'pending'} ELSE ${status} END,
        attempts = attempts + 1, last_error = '', lease_token = '', lease_expires_at = NULL,
        fail_count = 0, next_eligible_at = NULL, updated_at = now()
      WHERE user_id = ${userId} AND lease_token = ${leaseToken}
        AND EXISTS (SELECT 1 FROM updated)
      RETURNING pending_feedback_id
    ) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM lease) THEN 'lostLease'
        WHEN NOT EXISTS (SELECT 1 FROM updated) THEN 'profileConflict'
        ELSE 'matched' END AS outcome,
      (SELECT updated_at FROM updated) AS updated_at,
      (SELECT pending_feedback_id FROM completed) AS pending_feedback_id`;
}

// 退避档位读取：markProfileFeedbackFailedForUser 在 TS 侧算曲线（可测），SQL 只落数值。
// race 说明：读 fail_count 与写失败之间若有人并发改写（同租约串行），最多差一档退避，
// 不破坏「失败必有退避、成功清零」两个不变量。
export function profileFeedbackFailCountForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT fail_count FROM profile_feedback_queue WHERE user_id = ${userId}`;
}

// 吸收失败（failed/conflict）：保留 pending_feedback_id 不清，下次机会重放。last_error 只存
// 错误类别（error.name / code），绝不落模型或数据库原文。
// F15 退避配套：fail_count+1，next_eligible_at = now() + backoffMs（曲线由 TS 侧
// profileFeedbackBackoffMs 计算：30s → 2m → 8m → 32m → 1h 封顶）。领取谓词在退避到期前
// 不匹配，浏览器刷新不会立刻重打模型。失败同时释放租约（token=''）：退避到期后该行可被
// 任何人重领，不与租约互相卡死。leaseToken：只有持租约者能记失败（租约过期被重领后，
// 迟到者的失败记录写 0 行，不会把新主的退避档位打乱）。
export function markProfileFeedbackFailedForUserQuery(sql: PersonalQuery, userId: number, status: string, error: string, leaseToken: string, backoffMs: number) {
  requireUserId(userId);
  return sql`UPDATE profile_feedback_queue
    SET status = ${status}, attempts = attempts + 1, last_error = ${error},
        lease_token = '',
        lease_expires_at = NULL,
        fail_count = fail_count + 1,
        next_eligible_at = now() + (${backoffMs} * interval '1 millisecond'),
        updated_at = now()
    WHERE user_id = ${userId} AND lease_token = ${leaseToken}
    RETURNING user_id`;
}

// 重建画像成功后用它把队列水位推到「重建时已看到的反馈上界」：重建本身已经把最新有效反馈
// 并入新画像，因此这些反馈无需再吸收一次。候选值必须在读取反馈之前取（否则会漏掉重建期间
// 新写入、却未被并入的反馈）。
export function maxFeedbackIdForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`SELECT COALESCE(max(id), 0)::int AS max_id FROM feedback WHERE user_id = ${userId}`;
}

// 空画像起步（F15 ③）：用户还没有 profile 行时，反馈吸收需要先建一行占位（seeds 为空），
// 才能带着有效 updated_at 走既有的 CAS 保存。ON CONFLICT DO NOTHING 幂等，绝不覆盖已有画像。
export function ensureProfileForUserQuery(sql: PersonalQuery, userId: number) {
  requireUserId(userId);
  return sql`INSERT INTO profile (id) VALUES (${userId})
    ON CONFLICT (id) DO NOTHING
    RETURNING updated_at::text AS updated_at`;
}

// 重新生成画像时的「本人最新有效反馈」（F04）：feedback 是追加式历史，每本书只认最新一行// （id DESC）；只有最新状态仍具信息量（done/dropped 且 note 非空）才作为偏好证据喂给模型。
//
// 🔴 先取最新、再判是否有信息量，顺序不能反：若先过滤 done/dropped+note，用户把某本书
// 的反馈改成 want/reading 或清空 note（撤回）之后，那条历史 done+note 仍会被选中，
// 等于靠旧数据永久保留已失效偏好。按 book_id 取最新一行即可让撤回如实生效。
//
// 只按 user_id 过滤，书中身份经 books join 取当前拼写；绝不跨用户读取。
const MAX_PROFILE_FEEDBACK = 50;

export function recentInformativeFeedbackForUserQuery(sql: PersonalQuery, userId: number, limit = MAX_PROFILE_FEEDBACK, afterId = 0) {
  requireUserId(userId);
  // F41-F1：ORDER BY f.id ASC（旧实现按 title, author）。理由有二：
  //  ① **水位可安全推进**：id 升序取前 LIMIT 条 ⇒ 「id ≤ 返回集最大 id 的该类行必然都已
  //     在这 LIMIT 条里」。按 title 排序时未喂行的 id 散布任意位置，无法从返回值推出上界。
  //  ② 反馈是追加式历史，id 升序 = 最早写入的偏好先进画像，最坏情况也只是新偏好晚一轮，
  //     不会像 title 排序那样把某条反馈永久排在 50 名外。
  // 同书多条反馈可能跨批（本轮只喂 50 条里的一部分），可接受：下一轮会补上，且不会漏。
  // 🔴 F41-F1 不变量（异步吸收水位不越过已喂行）三条腿之一，改本函数前先读完 user-data.ts
  // 顶部 absorb-watermark-invariant.pglite.test.ts 的说明：
  //   (a) afterId（= 上一次的实喂上界）排除已喂过的行。没有它，每轮都重读同一批 LIMIT 50，
  //       实喂上界永远停在第一批——第 51+ 行既进不了画像，队列也永不排空；
  //   (b) ORDER BY feedback_id ASC ⇒ 未喂行的 id 必然大于返回集最大 id（水位可安全推进）；
  //   (c) LIMIT 仍在——推进候选取 min(两类实喂 max)，不是 claim 返回的全表 pending 上界。
  // feedback_id 进投影只用于「本轮实喂上界」计算（见 db.ts 的 absorbedWatermarkFor），
  // 绝不进模型输入——提示词输入经 feedbackForPrompt 剥掉它。
  return sql`SELECT title, author, status, note, feedback_id FROM (
      SELECT DISTINCT ON (f.book_id) b.title, b.author, f.status, f.note, f.book_id, f.id AS feedback_id
      FROM feedback f JOIN books b ON b.id = f.book_id
      WHERE f.user_id = ${userId}
      ORDER BY f.book_id, f.id DESC
    ) latest
    WHERE latest.status IN (${'done'}, ${'dropped'}) AND btrim(latest.note) <> ''
      AND feedback_id > ${afterId}
    ORDER BY feedback_id ASC LIMIT ${limit}`;
}

// F04 撤回标记：曾有过 informative 反馈行（done/dropped + note 非空）、但**最新一行已非
// informative** 的书。这些书的偏好很可能已经写进 profile.content，而上面的查询不会再返回
// 它们——若不额外告诉模型「这些书的反馈已被撤回」，模型看到旧画像里那句「讨厌机械降神」
// 只会照着「仍有效者请保留」留下它，等于靠旧画像永久保留已撤回偏好。
//
// 只回传**书名**（不回传旧 note 原文）：喂旧 note 会把要删除的偏好又当证据送进输入，
// 与「不得作为既定事实保留」相悖。判定只看本人反馈，绝不跨用户。
// F41-F1：ORDER BY latest.id ASC + 投影 feedback_id，与上面的 informative 查询同构——水位
// 取两类实喂上界的 min，两类都必须能推出「id ≤ X 的全部都在返回集里」。
// 撤回书目**不加 afterId 过滤**：它是「旧画像里可能残留的偏好清单」而不是待办队列——
// 已撤回的书名每轮都要重新告知模型，直到用户重新给出 informative 反馈（那时该书自然
// 不再是 withdrawn）。给它加 afterId 会让撤回信号只生效一轮，旧偏好又留在画像里。
export function withdrawnFeedbackBookTitlesForUserQuery(sql: PersonalQuery, userId: number, limit = MAX_PROFILE_FEEDBACK) {
  requireUserId(userId);
  return sql`SELECT latest.title, latest.id AS feedback_id FROM (
      SELECT DISTINCT ON (f.book_id) b.title, f.status, f.note, f.book_id, f.id
      FROM feedback f JOIN books b ON b.id = f.book_id
      WHERE f.user_id = ${userId}
      ORDER BY f.book_id, f.id DESC
    ) latest
    WHERE NOT (latest.status IN (${'done'}, ${'dropped'}) AND btrim(latest.note) <> '')
      AND EXISTS (
        SELECT 1 FROM feedback h
        WHERE h.user_id = ${userId} AND h.book_id = latest.book_id
          AND h.status IN (${'done'}, ${'dropped'}) AND btrim(h.note) <> ''
      )
    ORDER BY latest.id ASC LIMIT ${limit}`;
}

export function feedbackSnapshotForUserQuery(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  return sql`SELECT f.id, f.status, f.note FROM feedback f JOIN books b ON b.id = f.book_id
    WHERE f.user_id = ${userId} AND b.title_key = ${book.title} AND b.author_key = ${book.author}
    ORDER BY f.id DESC LIMIT 1`;
}

// 精确找书（task-77）的本地命中查询：按身份键在 books 与书库主表 labeled_books 里精确找，
// 命中即返回、不打豆瓣。
//
// 查询条件是**生成列** title_key / author_key（migrations/0002_identity_key.sql），
// 与写侧的 ON CONFLICT 指向同一套键（books 与 labeled_books 各自一列，表达式逐字相同）。
// 这里刻意不再用 lower(title) = lower(...)：那套比较绕过了《》/全角归一。
//
// F10：只查 books 会漏掉只存在于 labeled_books（书库主表）的书；两张表都查、按同一把
// 规范化身份键匹配，并用 metadata_source 区分命中来源。
//
// F10/A：给了作者也**不**硬过滤（同名不同作者要一起列给用户挑，与豆瓣阶段行为一致），
// 只计算 author_match：作者不符的保留但标 false。
// F10/B：has_txt（有完成 TXT）与 has_online_source（书库行有在线书源 URL）都从数据推导，
// 调用方据此给「已有 TXT / 在线书源待确认 / 找到记录」——**不得**对无正文记录承诺可读。
//
// 输入只归一一次（identityOf），与所有其他 books 身份查询同源。
const MAX_EXACT_LIBRARY_HITS = 5;

export function exactLibraryBooksForUserQuery(sql: PersonalQuery, userId: number, title: string, author: string) {
  requireUserId(userId);
  const book = identityOf(title, author);
  // on_shelf 只影响「加入书架」按钮的初始态；books 没有 user 归属，user 维度由
  // recommendations 提供（与 excludedBooksForUserQuery 同源），labeled_books 经身份键
  // 关联到对应 books 行后再查推荐。这里**不**限定 status：书架上任何状态都算「已在书架」，
  // 与 shelfExistsForUserQuery 的口径一致。
  return sql`SELECT metadata_source, id, title, author, douban_id, douban_rating, douban_rating_count, meta,
      on_shelf, author_match, has_txt, has_online_source
    FROM (
      SELECT 'books'::text AS metadata_source, 1 AS source_rank,
        b.id, b.title, b.author, b.douban_id, b.douban_rating, b.douban_rating_count, b.meta,
        EXISTS (SELECT 1 FROM recommendations r WHERE r.book_id = b.id AND r.user_id = ${userId}) AS on_shelf,
        (${book.author} = '' OR b.author_key = ${book.author}) AS author_match,
        EXISTS (SELECT 1 FROM download_tasks dt
          WHERE lower(btrim(dt.title)) = lower(btrim(b.title))
            AND lower(COALESCE(NULLIF(btrim(dt.author), ''), '佚名')) = lower(COALESCE(NULLIF(btrim(b.author), ''), '佚名'))
            AND dt.status = 'done') AS has_txt,
        EXISTS (SELECT 1 FROM labeled_books lb
          WHERE lb.title_key = b.title_key AND lb.author_key = b.author_key AND lb.source_url <> '') AS has_online_source
      FROM books b WHERE b.title_key = ${book.title}
      UNION ALL
      SELECT 'labeled_books'::text, 0,
        lb.id, lb.title, lb.author, NULL::text, NULL::float8, NULL::int, '{}'::jsonb,
        EXISTS (SELECT 1 FROM recommendations r JOIN books b2 ON b2.id = r.book_id
          WHERE b2.title_key = lb.title_key AND b2.author_key = lb.author_key AND r.user_id = ${userId}),
        (${book.author} = '' OR lb.author_key = ${book.author}),
        EXISTS (SELECT 1 FROM download_tasks dt WHERE dt.book_id = lb.id AND dt.status = 'done'),
        (lb.source_url <> '')
      -- 同一身份只出一条：两表都有时以 books 行（带豆瓣元数据）为准，labeled_books
      -- 只补 on_shelf/has_txt/has_online_source；只有 labeled_books 的书才会走这一支。
      FROM labeled_books lb WHERE lb.title_key = ${book.title}
        AND NOT EXISTS (SELECT 1 FROM books b3
          WHERE b3.title_key = lb.title_key AND b3.author_key = lb.author_key)
    ) hits
    ORDER BY author_match DESC, source_rank ASC, id ASC
    LIMIT ${MAX_EXACT_LIBRARY_HITS}`;
}
