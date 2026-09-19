import { NextRequest } from 'next/server';
import { guardPermissionWrite } from '@/lib/admin-http';
import { authJson, withAuthHeaders } from '@/lib/auth-http';
import { requirePermission } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';
import { triggerDownloadWorkflow } from '@/lib/github';
import { boundedPositiveInteger, readJsonBody, RequestBodyError } from '@/lib/http';
import { isLeaseExpired, reclaimStaleTasks, type DownloadSql } from '@/lib/download-task-reclaim';
import { SourcePolicyError, SUPPORTED_SOURCE_HOSTS, validateSourceUrl } from '@/lib/source-policy';

// 书库下载任务:GET 查任务(最近 20 条 / 单条 / 按书查本人最新一条)、POST 建任务、
// DELETE 取消 pending/清理 failed/partial。GET 保持只读，过期租约由 POST 与 cron 回收。
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;
const LIST_LIMIT = 20;

// updated_at 以 ISO-8601 UTC 文本返回（to_char）：leaseExpired 的派生比较依赖稳定格式，
// 不同驱动的 timestamptz::text 形态不一致（空格分隔、无 Z），会解析歧义。

interface TaskRow {
  id: number;
  book_id: number;
  title: string;
  author: string;
  status: string;
  chapters_total: number;
  chapters_done: number;
  chars_total: number;
  error: string;
  created_at: string;
  updated_at: string;
}

function toTask(row: TaskRow) {
  return {
    id: row.id,
    bookId: row.book_id,
    title: row.title,
    author: row.author,
    status: row.status,
    chaptersTotal: row.chapters_total,
    chaptersDone: row.chapters_done,
    charsTotal: row.chars_total,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 派生状态，不写库：running 但心跳已过期的任务在 UI 里视为可重试。
    leaseExpired: isLeaseExpired(row.status, row.updated_at),
  };
}

interface ActiveTask {
  id: number;
  status: string;
}

// 同一用户对同一本书的活动任务（pending/running）。F03 的 partial 不在锁内：残缺终态可重下补齐。
async function activeTaskFor(sql: DownloadSql, userId: number, bookId: number): Promise<ActiveTask | null> {
  const rows = (await sql`
    SELECT id, status FROM download_tasks
    WHERE user_id = ${userId} AND book_id = ${bookId} AND status IN ('pending', 'running')
    ORDER BY created_at DESC LIMIT 1`) as ActiveTask[];
  return rows[0] ?? null;
}

// 冲突响应带上同一用户已有任务的 taskId 与状态：前端据此接续轮询，而不是只显示一句
// 「已在队列」后拿不到任务（F17）。竞争路径查不到时 taskId/status 为 null，前端回退提示。
function conflictResponse(existing: ActiveTask | null) {
  return authJson(
    {
      error: '已有进行中的任务',
      code: 'TASK_CONFLICT',
      taskId: existing?.id ?? null,
      status: existing?.status ?? null,
    },
    { status: 409 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requirePermission(req, 'download');
  if (!auth.ok) return withAuthHeaders(auth.response);
  const { searchParams } = new URL(req.url);
  const idParam = searchParams.get('id');
  const id = boundedPositiveInteger(idParam);
  if (idParam !== null && id === null) {
    return authJson({ error: 'invalid id', code: 'INVALID_ID' }, { status: 400 });
  }
  const bookIdParam = searchParams.get('bookId');
  const bookId = boundedPositiveInteger(bookIdParam);
  if (bookIdParam !== null && bookId === null) {
    return authJson({ error: 'invalid bookId', code: 'INVALID_ID' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const sql = getSql();
    if (id !== null) {
      const rows = (await sql`
        SELECT id, book_id, title, author, status, chapters_total, chapters_done,
               chars_total, error, created_at::text AS created_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM download_tasks WHERE id = ${id} AND user_id = ${auth.principal.userId}`) as unknown as TaskRow[];
      if (rows.length === 0) {
        return authJson({ error: 'task not found', code: 'TASK_NOT_FOUND' }, { status: 404 });
      }
      return authJson({ task: toTask(rows[0]) });
    }
    if (bookId !== null) {
      // 按 bookId 查本人最新任务：详情页据此显示自己的下载状态，不依赖最近 20 条列表，
      // 也不会误读别的用户在同一本书上的完成任务（F17/F18）。
      const rows = (await sql`
        SELECT id, book_id, title, author, status, chapters_total, chapters_done,
               chars_total, error, created_at::text AS created_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM download_tasks WHERE book_id = ${bookId} AND user_id = ${auth.principal.userId}
        ORDER BY created_at DESC LIMIT 1`) as unknown as TaskRow[];
      return authJson({ task: rows.length > 0 ? toTask(rows[0]) : null });
    }
    const rows = (await sql`
      SELECT id, book_id, title, author, status, chapters_total, chapters_done,
             chars_total, error, created_at::text AS created_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM download_tasks WHERE user_id = ${auth.principal.userId}
      ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`) as unknown as TaskRow[];
    return authJson({ tasks: rows.map(toTask) });
  } catch (e) {
    console.error(e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // 写校验（能力位 + 同源固定头 + JSON 类型）必须在建任务与 triggerDownloadWorkflow 之前完成。
  const guard = await guardPermissionWrite(req, 'download');
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return authJson({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const bookId = boundedPositiveInteger(body?.bookId);
  if (bookId === null) {
    return authJson({ error: 'missing bookId', code: 'INVALID_ID' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const sql = getSql();
    const books = (await sql`
      SELECT id, title, author, source_url FROM labeled_books WHERE id = ${bookId}`) as {
      id: number;
      title: string;
      author: string;
      source_url: string;
    }[];
    if (books.length === 0) {
      return authJson({ error: 'book not found', code: 'BOOK_NOT_FOUND' }, { status: 404 });
    }
    const book = books[0];
    if (!book.source_url) {
      return authJson({ error: '该书没有来源链接', code: 'MISSING_SOURCE_URL' }, { status: 400 });
    }
    let sourceUrl: string;
    try {
      // 只相信书库记录中的来源，客户端自报地址不能扩大 worker 的访问范围。
      sourceUrl = validateSourceUrl(book.source_url).href;
    } catch (error) {
      if (!(error instanceof SourcePolicyError)) throw error;
      return authJson({ error: error.message, code: 'UNSUPPORTED_SOURCE' }, { status: 400 });
    }
    // 下载能力门（M2-4）：运行时门（validateSourceUrl 读 supportedHosts）可能已并入引擎档 host
    // ——阅读侧放行，但下载 worker 只认 builtin 适配器。此处按内建 host 集合二次收窄，让引擎源
    // 「可读不可下」，避免主应用放行、worker 拒绝的半开状态稳定贡献假失败率。必须在任何写库 /
    // dispatch 之前拒绝；message 与 URL 非法报错区分，别混成同一个报错丢诊断信息。
    if (!(SUPPORTED_SOURCE_HOSTS as readonly string[]).includes(new URL(sourceUrl).hostname)) {
      return authJson({ error: '该来源暂不支持全书下载', code: 'UNSUPPORTED_SOURCE' }, { status: 400 });
    }
    // 直接重试也先回收，避免必须先打开详情页查询才能解除僵尸任务的防重锁。
    await reclaimStaleTasks(sql);
    // 同一用户对同一本书有进行中的任务就直接返回它，避免重复入队。
    // 活动锁粒度是 (user_id, book_id)（B2）：不同用户共享同一书源互不阻塞。
    const existing = await activeTaskFor(sql, guard.principal.userId, bookId);
    if (existing) return conflictResponse(existing);
    const created = (await sql`
      INSERT INTO download_tasks (user_id, book_id, title, author, source_url, status)
      VALUES (${guard.principal.userId}, ${bookId}, ${book.title}, ${book.author}, ${sourceUrl}, 'pending')
      RETURNING id`) as { id: number }[];
    // 立刻唤醒 worker,不等 cron:dispatch 失败绝不能影响建任务结果(Vercel 环境要 await,否则函数可能被提前冻结)
    try {
      await triggerDownloadWorkflow();
    } catch (e) {
      console.error('workflow dispatch failed', e);
    }
    return authJson({ taskId: created[0].id }, { status: 201 });
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === '23505') {
      // 唯一索引竞争：另一个并发请求刚插入了同一 (user,book) 的活动任务。
      // 补读本人活动任务，返回同一个 taskId，让两边页面都跟到同一任务（F17）。
      try {
        const raced = await activeTaskFor(getSql(), guard.principal.userId, bookId);
        return conflictResponse(raced);
      } catch {
        return conflictResponse(null);
      }
    }
    console.error(e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  // 与 POST 同款写校验：DELETE 删除任务前先过能力位 + 同源固定头（DELETE 无 JSON 正文要求）。
  const guard = await guardPermissionWrite(req, 'download');
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return authJson({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const taskId = boundedPositiveInteger(body?.taskId);
  if (taskId === null) {
    return authJson({ error: 'missing taskId', code: 'INVALID_ID' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const sql = getSql();
    // 按状态原子删除：取消排队中的任务、清理失败记录或残缺（partial）任务；
    // 本人之外与运行中 / 已完成的任务仍受保护。partial 不是终态完成，删除后用户可重下补齐。
    const rows = (await sql`
      DELETE FROM download_tasks
      WHERE id = ${taskId} AND user_id = ${guard.principal.userId} AND status IN ('pending', 'failed', 'partial')
      RETURNING id`) as { id: number }[];
    if (rows.length === 0) {
      const visible = await sql`SELECT status FROM download_tasks WHERE id = ${taskId} AND user_id = ${guard.principal.userId}` as { status: string }[];
      if (visible.length === 0) return authJson({ error: 'task not found', code: 'TASK_NOT_FOUND' }, { status: 404 });
      return authJson({ error: '只能取消排队中的任务或清理未完成任务', code: 'TASK_CONFLICT' }, { status: 409 });
    }
    return authJson({ ok: true });
  } catch (e) {
    console.error(e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}
