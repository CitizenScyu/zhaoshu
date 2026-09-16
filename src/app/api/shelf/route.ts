import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { shelfExistsForUserQuery, addShelfForUserQueries, deleteShelfForUserQuery } from '@/lib/user-data';
import { boundedPositiveInteger, readJsonBody } from '@/lib/http';

// 书架管理：从书库(labeled_books)添加到书架，或从书架移除某条推荐
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;

export async function POST(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const labeledBookId = boundedPositiveInteger(body?.labeledBookId);
    if (labeledBookId === null) return NextResponse.json({ error: 'missing valid labeledBookId', code: 'INVALID_ID' }, { status: 400 });
    const { userId } = access.principal;
    try {
      await access.run(ensureSchema);
      const sql = getSql();
      const labeledRows = await access.run(async () => sql`
        SELECT title, author FROM labeled_books WHERE id = ${labeledBookId}`) as { title: string; author: string }[];
      if (!labeledRows.length) return NextResponse.json({ error: 'book not found', code: 'BOOK_NOT_FOUND' }, { status: 404 });
      const title = labeledRows[0].title.trim();
      const author = labeledRows[0].author.trim() || '佚名';
      if (!title) return NextResponse.json({ error: 'book has no title', code: 'INVALID_BOOK' }, { status: 400 });
      const exists = await access.run(async () => shelfExistsForUserQuery(sql, userId, title, author)) as unknown[];
      if (exists.length) return NextResponse.json({ error: '已在书架', code: 'ALREADY_ON_SHELF' }, { status: 409 });
      const rows = await access.commit((write) => write((sql) => addShelfForUserQueries(sql, userId, title, author)));
      const bookId = rows[1][0]?.book_id;
      if (bookId === undefined) return NextResponse.json({ error: '已在书架', code: 'ALREADY_ON_SHELF' }, { status: 409 });
      return NextResponse.json({ ok: true, bookId });
    } catch (error) {
      if (personalError(error).status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}

export async function DELETE(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
    const id = boundedPositiveInteger(new URL(req.url).searchParams.get('id'));
    if (id === null) return NextResponse.json({ error: 'missing valid id', code: 'INVALID_ID' }, { status: 400 });
    try {
      await access.run(ensureSchema);
      const rows = await access.commit((write) => write((sql) => [
        deleteShelfForUserQuery(sql, access.principal.userId, id),
      ]));
      if (!rows[0].length) return NextResponse.json({ error: 'recommendation not found', code: 'RECOMMENDATION_NOT_FOUND' }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (personalError(error).status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}
