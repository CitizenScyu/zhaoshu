import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { requireApiOwner } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = await sql`
      SELECT DISTINCT ON (r.book_id)
             r.id, r.query, r.match_score, r.hit_likes, r.risks, r.reason,
             r.status, r.created_at,
             b.title, b.author, b.douban_id, b.douban_rating, b.douban_rating_count,
             b.meta
      FROM recommendations r JOIN books b ON b.id = r.book_id
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
