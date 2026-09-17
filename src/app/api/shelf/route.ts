import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { shelfExistsForUserQuery, addShelfForUserQueries, deleteShelfForUserQuery, clearNewShelfForUserQuery } from '@/lib/user-data';
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

// DELETE 有两种形态，靠查询参数区分：
//   ?id=N           移除单条推荐（原有语义）
//   ?status=new     批量清空本人全部「未处理」推荐
// id 一旦出现（即使非法）就绝不走批量分支：否则一个漏掉 id 的前端 bug、
// 或 `?id=typo&status=new` 这种 URL，会变成一次静默的大范围删除。
export async function DELETE(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
    const params = new URL(req.url).searchParams;
    const hasId = params.has('id');
    const id = hasId ? boundedPositiveInteger(params.get('id')) : null;
    if (!hasId && params.get('status') !== 'new') {
      return NextResponse.json({ error: 'missing valid id', code: 'INVALID_ID' }, { status: 400 });
    }
    if (hasId && id === null) {
      return NextResponse.json({ error: 'missing valid id', code: 'INVALID_ID' }, { status: 400 });
    }
    const { userId } = access.principal;
    try {
      await access.run(ensureSchema);
      if (id === null) {
        const rows = await access.commit((write) => write((sql) => [clearNewShelfForUserQuery(sql, userId)]));
        return NextResponse.json({ ok: true, cleared: rows[0].length });
      }
      const rows = await access.commit((write) => write((sql) => [
        deleteShelfForUserQuery(sql, userId, id),
      ]));
      if (!rows[0].length) return NextResponse.json({ error: 'recommendation not found', code: 'RECOMMENDATION_NOT_FOUND' }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (personalError(error).status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}
