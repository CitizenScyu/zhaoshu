import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;

  try {
    await ensureSchema();
    const sql = getSql();
    // 同一份只读快照保留 books 外键关联；书库只导出元数据，避免 labels 撑大文件。
    const [profiles, books, recommendations, feedback, labeledBooks] = await sql.transaction([
      sql`SELECT id, seeds, content, updated_at FROM profile WHERE id = 1`,
      sql`SELECT * FROM books ORDER BY id`,
      sql`SELECT * FROM recommendations ORDER BY id`,
      sql`SELECT * FROM feedback ORDER BY id`,
      sql`SELECT id, title, author, category, finish_status, source_site, source_url,
                 chars_labeled, labeled_at, primary_genre, sub_tags, quality
          FROM labeled_books ORDER BY id`,
    ], { isolationLevel: 'RepeatableRead', readOnly: true, arrayMode: false, fullResults: false });
    const exportedAt = new Date().toISOString();
    const profile = profiles[0] ?? null;

    return new NextResponse(JSON.stringify({
      formatVersion: 1,
      exportedAt,
      profile,
      seeds: profile?.seeds ?? [],
      books,
      recommendations,
      feedback,
      labeled_books: labeledBooks,
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="shujing-data-${exportedAt.slice(0, 10)}.json"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    console.error('data export failed:', e);
    return NextResponse.json({ error: '数据导出失败，请稍后重试' }, { status: 500 });
  }
}
