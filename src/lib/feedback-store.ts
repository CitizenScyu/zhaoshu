import { getSql } from './db';
import type { FeedbackSnapshot } from './feedback';
import type { FeedbackStatus } from './types';

export async function getFeedbackSnapshot(title: string, author: string): Promise<FeedbackSnapshot> {
  const sql = getSql();
  const rows = await sql`
    SELECT f.id, f.status, f.note FROM feedback f JOIN books b ON b.id = f.book_id
    WHERE f.user_id = 1 AND lower(b.title) = lower(${title}) AND lower(b.author) = lower(${author})
    ORDER BY f.id DESC LIMIT 1` as { id: number; status: FeedbackStatus; note: string }[];
  const row = rows?.[0];
  return row ? { version: row.id, status: row.status, note: row.note } : { version: 0, status: null, note: '' };
}

export class FeedbackConflictError extends Error {}

/** The append-only feedback history is also the audit trail for status/note edits. */
export async function appendFeedback(
  bookId: number, status: FeedbackStatus, note: string, expectedVersion: number, signal: AbortSignal,
): Promise<void> {
  const sql = getSql();
  try {
    await sql.transaction([
      sql`SET LOCAL lock_timeout = '5s'`,
      sql`SET LOCAL statement_timeout = '10s'`,
      // Lock the stable book row even for the first feedback (version 0).
      // The following statement gets a fresh READ COMMITTED snapshot after the lock.
      sql`SELECT id FROM books WHERE id = ${bookId} FOR UPDATE`,
      sql`SELECT 1 / CASE WHEN COALESCE((
        SELECT max(id) FROM feedback WHERE book_id = ${bookId} AND user_id = 1
      ), 0) = ${expectedVersion} THEN 1 ELSE 0 END AS feedback_version_matches`,
      sql`INSERT INTO feedback (book_id, status, note, user_id) VALUES (${bookId}, ${status}, ${note}, 1)`,
      sql`UPDATE recommendations SET status = ${status} WHERE book_id = ${bookId} AND user_id = 1`,
    ], { isolationLevel: 'ReadCommitted', fetchOptions: { signal } });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '22012') throw new FeedbackConflictError();
    throw error;
  }
}
