import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, upsertBook } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';
import { requireApiOwner } from '@/lib/auth';

// 书架管理：从书库(labeled_books)添加到书架，或从书架移除某条推荐
export const maxDuration = 60;

// 新加的初始状态必须是 ShelfStatus 里的合法值，且映射到书架「想读」分组
const DEFAULT_STATUS = 'want' as const;
const SHELF_QUERY = '书库添加';

export async function POST(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;

  let body: Record<string, unknown> | null;
  try {
    body = await req.json().catch(() => null);
  } catch {
    body = null;
  }
  const rawId = isRecord(body) ? body.labeledBookId : undefined;
  const labeledBookId = Number(rawId);
  if (!Number.isInteger(labeledBookId) || labeledBookId <= 0) {
    return NextResponse.json({ error: 'missing valid labeledBookId' }, { status: 400 });
  }

  try {
    await ensureSchema();
    const sql = getSql();

    const labeledRows = (await sql`
      SELECT title, author FROM labeled_books WHERE id = ${labeledBookId}`) as { title: string; author: string }[];
    if (labeledRows.length === 0) {
      return NextResponse.json({ error: 'book not found' }, { status: 404 });
    }
    const { title, author } = labeledRows[0];
    const cleanTitle = title.trim();
    const cleanAuthor = author.trim() || '佚名';
    if (!cleanTitle) {
      return NextResponse.json({ error: 'book has no title' }, { status: 400 });
    }

    const bookId = await upsertBook({ title: cleanTitle, author: cleanAuthor, meta: {} });

    const exists = (await sql`
      SELECT 1 FROM recommendations WHERE book_id = ${bookId} LIMIT 1`) as { 1?: number }[];
    if (exists.length > 0) {
      return NextResponse.json({ error: '已在书架' }, { status: 409 });
    }

    await sql`
      INSERT INTO recommendations (book_id, query, status)
      VALUES (${bookId}, ${SHELF_QUERY}, ${DEFAULT_STATUS})`;
    return NextResponse.json({ ok: true, bookId });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'missing valid id' }, { status: 400 });
  }

  try {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      DELETE FROM recommendations WHERE id = ${id} RETURNING id`) as { id: number }[];
    if (rows.length === 0) {
      return NextResponse.json({ error: 'recommendation not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}