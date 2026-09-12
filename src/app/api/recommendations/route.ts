import { NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';

export async function GET() {
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = await sql`
      SELECT r.id, r.query, r.match_score, r.hit_likes, r.risks, r.reason,
             r.status, r.created_at,
             b.title, b.author, b.douban_id, b.douban_rating, b.douban_rating_count,
             b.meta
      FROM recommendations r JOIN books b ON b.id = r.book_id
      ORDER BY r.created_at DESC, r.match_score DESC
      LIMIT 300`;
    return NextResponse.json({ recommendations: rows });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}
