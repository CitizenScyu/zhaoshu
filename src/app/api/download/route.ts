import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { authJson, withAuthHeaders } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { triggerDownloadWorkflow } from '@/lib/github';
import { boundedPositiveInteger, readJsonBody, RequestBodyError } from '@/lib/http';
import { DOWNLOAD_TASK_STALE_MS } from '@/lib/download-task-policy';
import { SourcePolicyError, validateSourceUrl } from '@/lib/source-policy';

// 书库下载任务:GET 查任务(最近 20 条或单条)、POST 建任务、DELETE 取消 pending/清理 failed
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;
const LIST_LIMIT = 20;

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
  };
}

async function reclaimStaleTasks(sql: ReturnType<typeof getSql>) {
  // Worker 每 60 秒独立更新心跳；长时间抓取/抽验也持续更新，与每 50 章的进度写回无关。
  await sql`
    UPDATE download_tasks
    SET status = 'failed',
        error = CONCAT(COALESCE(error, ''), ${'\nworker 中断自动回收'}),
        updated_at = now()
    WHERE status = 'running' AND updated_at < now() - (${DOWNLOAD_TASK_STALE_MS} * interval '1 millisecond')`;
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
  try {
    await ensureSchema();
    const sql = getSql();
    if (id !== null) {
      const rows = (await sql`
        SELECT id, book_id, title, author, status, chapters_total, chapters_done,
               chars_total, error, created_at::text AS created_at, updated_at::text AS updated_at
        FROM download_tasks WHERE id = ${id} AND user_id = ${auth.principal.userId}`) as unknown as TaskRow[];
      if (rows.length === 0) {
        return authJson({ error: 'task not found', code: 'TASK_NOT_FOUND' }, { status: 404 });
      }
      return authJson({ task: toTask(rows[0]) });
    }
    const rows = (await sql`
      SELECT id, book_id, title, author, status, chapters_total, chapters_done,
             chars_total, error, created_at::text AS created_at, updated_at::text AS updated_at
      FROM download_tasks WHERE user_id = ${auth.principal.userId}
      ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`) as unknown as TaskRow[];
    return authJson({ tasks: rows.map(toTask) });
  } catch (e) {
    console.error(e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission(req, 'download');
  if (!auth.ok) return withAuthHeaders(auth.response);
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
    // 直接重试也先回收，避免必须先打开详情页查询才能解除僵尸任务的防重锁。
    await reclaimStaleTasks(sql);
    // 同一用户对同一本书有进行中的任务就直接返回它，避免重复入队。
    // 活动锁粒度是 (user_id, book_id)（B2）：不同用户共享同一书源互不阻塞。
    const existing = (await sql`
      SELECT id FROM download_tasks
      WHERE user_id = ${auth.principal.userId} AND book_id = ${bookId} AND status IN ('pending', 'running')
      ORDER BY created_at DESC LIMIT 1`) as { id: number }[];
    if (existing.length > 0) {
      return authJson(
        { error: '已有进行中的任务', code: 'TASK_CONFLICT' },
        { status: 409 },
      );
    }
    const created = (await sql`
      INSERT INTO download_tasks (user_id, book_id, title, author, source_url, status)
      VALUES (${auth.principal.userId}, ${bookId}, ${book.title}, ${book.author}, ${sourceUrl}, 'pending')
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
      return authJson({ error: '已有进行中的任务', code: 'TASK_CONFLICT' }, { status: 409 });
    }
    console.error(e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requirePermission(req, 'download');
  if (!auth.ok) return withAuthHeaders(auth.response);
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
    // 按状态原子删除：取消排队中的任务或清理失败记录；本人之外与运行中 / 已完成的任务仍受保护。
    const rows = (await sql`
      DELETE FROM download_tasks
      WHERE id = ${taskId} AND user_id = ${auth.principal.userId} AND status IN ('pending', 'failed')
      RETURNING id`) as { id: number }[];
    if (rows.length === 0) {
      const visible = await sql`SELECT status FROM download_tasks WHERE id = ${taskId} AND user_id = ${auth.principal.userId}` as { status: string }[];
      if (visible.length === 0) return authJson({ error: 'task not found', code: 'TASK_NOT_FOUND' }, { status: 404 });
      return authJson({ error: '只能取消排队中的任务或清理失败任务', code: 'TASK_CONFLICT' }, { status: 409 });
    }
    return authJson({ ok: true });
  } catch (e) {
    console.error(e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}
