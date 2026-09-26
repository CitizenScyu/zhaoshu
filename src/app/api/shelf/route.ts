import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { shelfExistsForUserQuery, addShelfForUserQueries, deleteShelfForUserQuery } from '@/lib/user-data';
import { boundedPositiveInteger, readJsonBody } from '@/lib/http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// 书架管理：从书库(labeled_books)添加到书架，或从书架移除某条推荐
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;

async function handlePOST(req: NextRequest) {
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
      // title 原样往下传：身份归一（NFKC + btrim + 剥《》）只在 user-data.ts 的查询
      // 构造器里做一次——那里是 books 身份的唯一边界，重复归一会被《《x》》多剥一层。
      const title = labeledRows[0].title;
      const author = labeledRows[0].author.trim() || '佚名';
      if (!title.trim()) return NextResponse.json({ error: 'book has no title', code: 'INVALID_BOOK' }, { status: 400 });
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

async function handleDELETE(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
    // F05：按 (user_id, book_id) 移除——传 bookId，而不是某一条 recommendation 的 id。
    // 同一本书可能有多条 query 行，按单行 id 删会残留、刷新重现。
    const bookId = boundedPositiveInteger(new URL(req.url).searchParams.get('bookId'));
    if (bookId === null) return NextResponse.json({ error: 'missing valid bookId', code: 'INVALID_ID' }, { status: 400 });
    try {
      await access.run(ensureSchema);
      const rows = await access.commit((write) => write((sql) => [
        deleteShelfForUserQuery(sql, access.principal.userId, bookId),
      ]));
      if (!rows[0].length) return NextResponse.json({ error: 'recommendation not found', code: 'RECOMMENDATION_NOT_FOUND' }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (personalError(error).status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
export const DELETE = withDbQuotaGuard(handleDELETE);
