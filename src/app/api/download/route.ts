import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';
import { triggerDownloadWorkflow } from '@/lib/github';
import { boundedPositiveInteger, readJsonBody, RequestBodyError } from '@/lib/http';

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
  // Actions worker 单实例运行且每章更新心跳；超过 30 分钟无更新的 running 视为中断。
  await sql`
    UPDATE download_tasks
    SET status = 'failed',
        error = CONCAT(COALESCE(error, ''), ${'\nworker 中断自动回收'}),
        updated_at = now()
    WHERE status = 'running' AND updated_at < now() - interval '30 minutes'`;
}

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  const { searchParams } = new URL(req.url);
  const idParam = searchParams.get('id');
  const id = boundedPositiveInteger(idParam);
  if (idParam !== null && id === null) {
    return NextResponse.json({ error: 'invalid id', code: 'INVALID_ID' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const sql = getSql();
    await reclaimStaleTasks(sql);
    if (id !== null) {
      const rows = (await sql`
        SELECT id, book_id, title, author, status, chapters_total, chapters_done,
               chars_total, error, created_at::text AS created_at, updated_at::text AS updated_at
        FROM download_tasks WHERE id = ${id}`) as unknown as TaskRow[];
      if (rows.length === 0) {
        return NextResponse.json({ error: 'task not found', code: 'TASK_NOT_FOUND' }, { status: 404 });
      }
      return NextResponse.json({ task: toTask(rows[0]) });
    }
    const rows = (await sql`
      SELECT id, book_id, title, author, status, chapters_total, chapters_done,
             chars_total, error, created_at::text AS created_at, updated_at::text AS updated_at
      FROM download_tasks ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`) as unknown as TaskRow[];
    return NextResponse.json({ tasks: rows.map(toTask) });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const bookId = boundedPositiveInteger(body?.bookId);
  if (bookId === null) {
    return NextResponse.json({ error: 'missing bookId', code: 'INVALID_ID' }, { status: 400 });
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
      return NextResponse.json({ error: 'book not found', code: 'BOOK_NOT_FOUND' }, { status: 404 });
    }
    const book = books[0];
    if (!book.source_url) {
      return NextResponse.json({ error: '该书没有来源链接', code: 'MISSING_SOURCE_URL' }, { status: 400 });
    }
    // 直接重试也先回收，避免必须先打开详情页查询才能解除僵尸任务的防重锁。
    await reclaimStaleTasks(sql);
    // 同一本书有进行中的任务就直接返回它,避免重复入队
    const existing = (await sql`
      SELECT id FROM download_tasks
      WHERE book_id = ${bookId} AND status IN ('pending', 'running')
      ORDER BY created_at DESC LIMIT 1`) as { id: number }[];
    if (existing.length > 0) {
      return NextResponse.json(
        { error: '已有进行中的任务', code: 'TASK_CONFLICT', taskId: existing[0].id },
        { status: 409 },
      );
    }
    const created = (await sql`
      INSERT INTO download_tasks (book_id, title, author, source_url, status)
      VALUES (${bookId}, ${book.title}, ${book.author}, ${book.source_url}, 'pending')
      RETURNING id`) as { id: number }[];
    // 立刻唤醒 worker,不等 cron:dispatch 失败绝不能影响建任务结果(Vercel 环境要 await,否则函数可能被提前冻结)
    try {
      await triggerDownloadWorkflow();
    } catch (e) {
      console.error('workflow dispatch failed', e);
    }
    return NextResponse.json({ taskId: created[0].id }, { status: 201 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const taskId = boundedPositiveInteger(body?.taskId);
  if (taskId === null) {
    return NextResponse.json({ error: 'missing taskId', code: 'INVALID_ID' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const sql = getSql();
    // 按状态原子删除，取消排队或清理失败记录；已被 worker 领取和已完成的任务仍受保护。
    const rows = (await sql`
      DELETE FROM download_tasks
      WHERE id = ${taskId} AND status IN ('pending', 'failed')
      RETURNING id`) as { id: number }[];
    if (rows.length === 0) {
      return NextResponse.json({ error: '只能取消排队中的任务或清理失败任务', code: 'TASK_CONFLICT' }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}
