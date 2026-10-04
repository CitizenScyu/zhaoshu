import { NextRequest } from 'next/server';
import { guardPermissionWrite } from '@/lib/admin-http';
import { authJson } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';
import { reclaimStaleTasks } from '@/lib/download-task-reclaim';
import { DownloadRelocationError, resolveDownloadRelocation } from '@/lib/download-relocate';
import { boundedPositiveInteger, readJsonBody, RequestBodyError } from '@/lib/http';
import { SourceReaderError } from '@/lib/source-reader';
import { activeTaskFor, conflictResponse } from '../route';

export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;

async function handlePOST(req: NextRequest) {
  const guard = await guardPermissionWrite(req, 'download');
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return authJson({ error: error.message, code: error.code }, { status: 413 });
    }
    throw error;
  }
  const bookId = boundedPositiveInteger(body?.bookId);
  if (bookId === null) return authJson({ error: 'missing bookId', code: 'INVALID_ID' }, { status: 400 });

  // deadline/signal 提到 try 外（镜像 read/source 路由）：catch 里才判得到 signal.aborted；
  // 55s 预算随之从查库就开始计（maxDuration 60 仍留余量）。
  const deadline = AbortSignal.timeout(55_000);
  const signal = AbortSignal.any([req.signal, deadline]);

  try {
    await ensureSchema();
    const sql = getSql();
    const books = (await sql`
      SELECT id, title, author FROM labeled_books WHERE id = ${bookId}`) as Array<{
      id: number;
      title: string;
      author: string;
    }>;
    if (!books.length) return authJson({ error: 'book not found', code: 'BOOK_NOT_FOUND' }, { status: 404 });
    const book = books[0];

    const source = await resolveDownloadRelocation({ title: book.title, author: book.author }, signal);

    await reclaimStaleTasks(sql);
    const existing = await activeTaskFor(sql, guard.principal.userId, bookId);
    if (existing) return conflictResponse(existing);

    const created = (await sql`
      INSERT INTO download_tasks (user_id, book_id, title, author, source_url, status, requested_by, source_kind, source_id, source_revision)
      VALUES (${guard.principal.userId}, ${bookId}, ${book.title}, ${book.author}, ${source.bookUrl}, 'pending', 'user', 'engine', ${source.sourceId}, ${source.sourceRevision})
      RETURNING id`) as Array<{ id: number }>;
    return authJson({
      taskId: created[0].id,
      resolvedSource: {
        bookUrl: source.bookUrl,
        sourceUrl: source.sourceUrl,
        revision: source.sourceRevision,
        matched: source.matched,
      },
    }, { status: 201 });
  } catch (error) {
    // 整体中止/超时（req.signal 或 55s deadline，引擎循环裸抛 AbortError 上逸）先于其余错误档，
    // 归一化 504，镜像 read/source 路由 signal.aborted → 504 的形态。
    if (signal.aborted) {
      return authJson({ error: 'relocation aborted or timed out', code: 'REQUEST_ABORTED' }, { status: 504 });
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      try {
        return conflictResponse(await activeTaskFor(getSql(), guard.principal.userId, bookId));
      } catch {
        return conflictResponse(null);
      }
    }
    if (error instanceof DownloadRelocationError) {
      return authJson({
        error: error.message,
        code: error.code,
        ...(error.code === 'RELOCATION_AMBIGUOUS' ? { candidates: error.candidates ?? [] } : {}),
      }, { status: error.status });
    }
    if (error instanceof SourceReaderError) {
      return authJson({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error(error);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

export const POST = withDbQuotaGuard(handlePOST);
