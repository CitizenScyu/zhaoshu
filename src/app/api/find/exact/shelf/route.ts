import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { addShelfForUserQueries, shelfExistsForUserQuery } from '@/lib/user-data';
import { boundedString, readJsonBody } from '@/lib/http';

// 精确找书的「加入书架」（task-77）。
//
// 为什么不是复用 POST /api/shelf：那条路径以 labeledBookId 为入口（书库 = labeled_books），
// 而精确找书的候选来自豆瓣检索，**没有 labeled_books 行**，拿不到那个 id，复用会 404。
// 这里直接复用 user-data.ts 里既有的 addShelfForUserQueries(title, author, ...)——
// 它的签名本来就是通用的 (title, author)，身份归一仍在 user-data.ts 那一个边界里做，
// 不新增第二套归一。状态码与返回形状与 /api/shelf 保持一致（409 = 已在书架）。
export const maxDuration = 30;

const MAX_BODY_BYTES = 4 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 200;

export async function POST(req: NextRequest) {
  return withFindAccess(req, 25_000, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const title = boundedString(body?.title, MAX_TITLE_LENGTH) ?? '';
    // 与 /api/shelf 同款兜底：缺作者的书在 books 里按「佚名」建身份。
    const author = boundedString(body?.author, MAX_AUTHOR_LENGTH) || '佚名';
    if (!title) {
      return NextResponse.json({ error: 'missing title', code: 'MISSING_TITLE' }, { status: 400 });
    }
    const { userId } = access.principal;
    try {
      await access.run(ensureSchema);
      const sql = getSql();
      // title 原样往下传：归一只在 user-data.ts 的查询构造器里做一次，重复归一会被
      // 《《x》》多剥一层（与 /api/shelf 的注释同一条约束）。
      const exists = await access.run(async () =>
        shelfExistsForUserQuery(sql, userId, title, author)) as unknown[];
      if (exists.length > 0) {
        return NextResponse.json({ error: '已在书架', code: 'ALREADY_ON_SHELF' }, { status: 409 });
      }
      const rows = await access.commit((write) =>
        write((sql) => addShelfForUserQueries(sql, userId, title, author)));
      const bookId = rows[1][0]?.book_id;
      // INSERT ... SELECT 匹配 0 行时不报错，只会静默成功——显式转成 409。
      if (bookId === undefined) {
        return NextResponse.json({ error: '已在书架', code: 'ALREADY_ON_SHELF' }, { status: 409 });
      }
      return NextResponse.json({ ok: true, bookId });
    } catch (error) {
      if (personalError(error).status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}
