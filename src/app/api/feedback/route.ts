import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, upsertBook, getProfile, saveProfile } from '@/lib/db';
import { chatRobust, LlmError } from '@/lib/llm';
import { profileUpdateSystem, profileUpdateUser } from '@/lib/prompts';
import type { ShelfStatus } from '@/lib/types';

export const maxDuration = 300;

const VALID: ShelfStatus[] = ['want', 'reading', 'done', 'dropped'];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { title, author, status, note } = body ?? {};
  if (!title || !VALID.includes(status)) {
    return NextResponse.json({ error: 'missing title or invalid status' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const sql = getSql();
    const bookId = await upsertBook({
      title: String(title),
      author: String(author ?? '佚名'),
      meta: {},
    });
    await sql`
      INSERT INTO feedback (book_id, status, note) VALUES (${bookId}, ${status}, ${String(note ?? '')})`;
    // 同步更新书架上这本书的推荐状态
    await sql`UPDATE recommendations SET status = ${status} WHERE book_id = ${bookId}`;

    // 有信息量的反馈 → 回写画像（失败不阻断）
    let profileUpdated = false;
    if ((status === 'done' || status === 'dropped') && note && note.trim()) {
      try {
        const { content } = await getProfile();
        if (content) {
          const updated = await chatRobust(
            profileUpdateSystem(),
            profileUpdateUser(content, JSON.stringify({ title, author, status, note })),
            { temperature: 0.3 },
          );
          await saveProfile(
            (await getProfile()).seeds,
            updated.trim(),
          );
          profileUpdated = true;
        }
      } catch (e) {
        console.error('profile update failed:', e);
      }
    }
    return NextResponse.json({ ok: true, profileUpdated });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = await sql`
      SELECT f.id, f.status, f.note, f.created_at, b.title, b.author
      FROM feedback f JOIN books b ON b.id = f.book_id
      ORDER BY f.created_at DESC LIMIT 200`;
    return NextResponse.json({ feedback: rows });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}
