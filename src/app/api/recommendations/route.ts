import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { requireApiOwner } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  try {
    await ensureSchema();
    const sql = getSql();
    // 最新反馈（包含空 note）代表当前原因，清除后不能回退到更早的非空记录。
    const rows = await sql`
      SELECT DISTINCT ON (r.book_id)
             r.id, r.query, r.match_score, r.hit_likes, r.risks, r.reason,
             r.status, r.created_at,
             b.title, b.author, b.douban_id, b.douban_rating, b.douban_rating_count,
             b.meta,
             (SELECT dt.id FROM download_tasks dt
              WHERE lower(btrim(dt.title)) = lower(btrim(b.title))
                AND lower(COALESCE(NULLIF(btrim(dt.author), ''), '佚名'))
                  = lower(COALESCE(NULLIF(btrim(b.author), ''), '佚名'))
                AND dt.status = 'done'
              ORDER BY dt.id DESC LIMIT 1) AS read_task_id,
             COALESCE((
               SELECT f.note FROM feedback f WHERE f.book_id = r.book_id AND f.user_id = r.user_id
               ORDER BY f.id DESC LIMIT 1
             ), '') AS note,
             COALESCE((
               SELECT f.id FROM feedback f WHERE f.book_id = r.book_id AND f.user_id = r.user_id
               ORDER BY f.id DESC LIMIT 1
             ), 0) AS feedback_id
      FROM recommendations r JOIN books b ON b.id = r.book_id
      WHERE r.user_id = 1
      ORDER BY r.book_id, r.created_at DESC, r.match_score DESC
      LIMIT 300` as Record<string, unknown>[];
    const recommendations = [...rows].sort((a, b) =>
      new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
    return NextResponse.json({ recommendations });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}
