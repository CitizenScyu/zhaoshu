import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { boundedString, readJsonBody } from '@/lib/http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';
import { DEFAULT_POLICY_VERSION } from '@/lib/importer-enqueue';
import { bumpAuthRateLimit, decideRateLimit, rateLimitKeyHash } from '@/lib/auth-rate-limit';
import { getAuthSecuritySecret } from '@/lib/auth-session';

// 精确找书的「下载全书」（finddl1113）：找书结果（本地或豆瓣命中）不必等批次打标入库，
// 用户点击即落库 + 建系统下载任务，worker 按书名扫源池下载（实测中位数约 7 分钟）。
//
// 与 POST /api/download 的关系：那条路径以 labeledBookId 为入口（要求书已在书库），
// 找书候选没有这个 id；这里把「落库 + 建任务」写成**一条 CTE**放进 access.commit 的
// 授权围栏事务（写前重校验 + FOR SHARE 锁 + statement_timeout），不是第二套入库路径。
//
// 数据安全（审查 blocker 2）：已有书的行不做字段更新——ON CONFLICT DO UPDATE SET
// id = labeled_books.id 是无操作写（只为 RETURNING 已有行），labels/finish_status/
// primary_genre 等打标数据绝不被占位值覆盖；下载任务的 source_url 用**已有行**的
// 真实 source_url（新书才是 book15 占位）。
//
// 幂等与重试（审查 major 5）：enqueue_key 传 NULL——事件唯一索引是 partial
// (WHERE enqueue_key IS NOT NULL)，NULL 不受约束；重复点击由 system_active_book_idx
// 的 (book_id) WHERE pending/running 活动互斥吸收，失败终态后可再次入列重试。
export const maxDuration = 30;

const MAX_BODY_BYTES = 4 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 200;
/** 搜索种子 URL：builtin host 的规范 origin（supported-sources 识别集合内）。 */
const SEARCH_SEED_URL = 'https://book15.net/';
/** 滥用闸（审查 major 4）：每用户每窗口最多提交次数；超限 429 带重试秒数。 */
const DOWNLOAD_RATE_LIMIT = { scope: 'finddl-user', limit: 10, windowSeconds: 3600 } as const;

// 23505 竞争补读：按身份键找书 + 其当前活动系统任务（与 findLabeledBookId 同款身份键表达式）。
async function findRacedActiveTask(sql: ReturnType<typeof getSql>, title: string, author: string): Promise<{ bookId: number; taskId: number } | null> {
  const rows = (await sql`
    SELECT b.id AS book_id, t.id AS task_id
    FROM labeled_books b
    JOIN download_tasks t ON t.book_id = b.id AND t.requested_by = 'system'
      AND t.status IN ('pending', 'running')
    WHERE b.title_key = lower(btrim(regexp_replace(btrim(normalize(${title}, NFKC)), '^《(.+)》$', '\\1')))
      AND b.author_key = lower(btrim(normalize(${author}, NFKC)))
    ORDER BY t.id
    LIMIT 1`) as { book_id: number; task_id: number }[];
  const row = rows[0];
  if (!row || !Number.isSafeInteger(Number(row.book_id)) || !Number.isSafeInteger(Number(row.task_id))) return null;
  return { bookId: Number(row.book_id), taskId: Number(row.task_id) };
}

async function handlePOST(req: NextRequest) {
  return withFindAccess(req, 25_000, async (access) => {
    // 能力位前置：建下载任务与 POST /api/download 同档（审查 major 3），无 canDownload 的
    // find/read 成员在这里被拒，不会走到任何读写。
    if (!access.principal.canDownload) {
      return NextResponse.json({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 });
    }
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const title = boundedString(body?.title, MAX_TITLE_LENGTH) ?? '';
    // 与 shelf 路由同款 author 边界（authval42）：非字符串/超长显式 400，缺失/空串走佚名。
    const rawAuthor = body?.author ?? '';
    if (boundedString(rawAuthor, MAX_AUTHOR_LENGTH) === null) {
      return NextResponse.json({ error: 'invalid author', code: 'INVALID_AUTHOR' }, { status: 400 });
    }
    const author = boundedString(rawAuthor, MAX_AUTHOR_LENGTH) || '佚名';
    if (!title) {
      return NextResponse.json({ error: 'missing title', code: 'MISSING_TITLE' }, { status: 400 });
    }
    try {
      await access.run(ensureSchema);
      // 滥用闸：复用 auth_rate_limits 的原子滑动窗口，键是 secret 对 userId 的 HMAC
      //（数据库不存裸用户 id）。先 bump 再判定，超限直接 429，不进入写事务。
      const secret = getAuthSecuritySecret();
      if (secret) {
        const bump = await access.run(() => bumpAuthRateLimit(getSql(), DOWNLOAD_RATE_LIMIT,
          rateLimitKeyHash(secret, DOWNLOAD_RATE_LIMIT.scope, String(access.principal.userId))));
        const decision = decideRateLimit(bump, DOWNLOAD_RATE_LIMIT.limit);
        if (!decision.allowed) {
          return NextResponse.json(
            { error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds },
            { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
          );
        }
      }
      // 单条 CTE（审查 blocker 1）：整条语句作为 PersonalBatch 放进 access.commit——
      // 写前 revalidatePermission + 事务内两次 authorizationFence + statement_timeout
      // 全部生效。enqueue_key 传 NULL 绕开事件唯一索引，互斥靠活动任务部分索引。
      const rows = await access.commit((write) => write((tx) => [
        tx`
        WITH upserted AS (
          INSERT INTO labeled_books
            (title, author, category, finish_status, source_site, source_url,
             chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality)
          VALUES (${title}, ${author}, '', '', '书源池搜索', ${SEARCH_SEED_URL},
                  0, '[]'::jsonb, now(), '', '[]'::jsonb, NULL)
          ON CONFLICT (title_key, author_key) DO UPDATE SET
            id = labeled_books.id
          RETURNING id, title, author, source_url
        ), artifact_done AS (
          SELECT u.id FROM upserted u
          WHERE EXISTS (
            SELECT 1 FROM book_artifacts a
            WHERE a.labeled_book_id = u.id
              AND a.quality_status = 'published'
              AND a.chapters_total > 0
              AND a.chapters_done >= a.chapters_total
          )
        ), inserted AS (
          INSERT INTO download_tasks
            (user_id, book_id, title, author, source_url, status, requested_by,
             source_kind, source_id, source_revision, policy_version, enqueue_key)
          SELECT NULL, u.id, u.title, u.author, u.source_url, 'pending', 'system',
                 'builtin', NULL, 'finddl-1113', ${DEFAULT_POLICY_VERSION}, NULL
          FROM upserted u
          WHERE NOT EXISTS (SELECT 1 FROM artifact_done d WHERE d.id = u.id)
            AND NOT EXISTS (
              SELECT 1 FROM download_tasks t
              WHERE t.requested_by = 'system' AND t.book_id = u.id
                AND t.status IN ('pending', 'running')
            )
          RETURNING id
        ), existing_task AS (
          SELECT t.id FROM download_tasks t
          JOIN upserted u ON t.book_id = u.id
          WHERE t.requested_by = 'system'
            AND t.status IN ('pending', 'running')
            AND NOT EXISTS (SELECT 1 FROM inserted)
          ORDER BY t.id
          LIMIT 1
        )
        SELECT (SELECT id FROM upserted)             AS labeled_book_id,
               (SELECT id FROM inserted)             AS created_task_id,
               (SELECT id FROM existing_task)        AS existing_task_id,
               (SELECT id FROM artifact_done)        AS artifact_book_id`,
      ]));
      const row = (rows[0] ?? {}) as Record<string, unknown>;
      const bookId = Number(row.labeled_book_id);
      const created = Number(row.created_task_id);
      const existing = Number(row.existing_task_id);
      const artifactBook = Number(row.artifact_book_id);
      if (!Number.isSafeInteger(bookId) || bookId < 1) {
        return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
      }
      let taskOutcome: 'created' | 'existing' | 'artifact_exists';
      let taskId: number | null;
      if (Number.isSafeInteger(created) && created > 0) {
        taskOutcome = 'created'; taskId = created;
      } else if (Number.isSafeInteger(existing) && existing > 0) {
        taskOutcome = 'existing'; taskId = existing;
      } else if (Number.isSafeInteger(artifactBook) && artifactBook > 0) {
        taskOutcome = 'artifact_exists'; taskId = null;
      } else {
        // 没插进任务、没有活动任务、也没有产物 ⇒ enqueue_key 竞争以外的不可解状态。
        return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
      }
      return NextResponse.json({
        ok: true,
        bookId,
        taskId,
        taskOutcome,
        // 201 与 POST /api/download 同语义：请求被接受且下载任务已在队列中
        //（含 existing/artifact_exists——对用户都是「任务在，等完成」）。
      }, { status: 201 });
    } catch (error) {
      // 并发双击/双标签页撞 system_active_book_idx（23505）：书库行和对方的任务都已提交，
      // 这里补读活动任务返回 existing——与 POST /api/download 的 409→同 taskId 同语义。
      if (error && typeof error === 'object' && 'code' in error
        && ((error as { code?: unknown }).code === '23505'
          || (error as { cause?: { code?: unknown } }).cause?.code === '23505')) {
        const raced = await access.run(() => findRacedActiveTask(getSql(), title, author));
        if (raced !== null) {
          return NextResponse.json({ ok: true, bookId: raced.bookId, taskId: raced.taskId, taskOutcome: 'existing' }, { status: 201 });
        }
      }
      const mapped = personalError(error);
      if (mapped.status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
