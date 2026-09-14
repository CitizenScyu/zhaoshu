import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, upsertBook, getProfile, saveProfile } from '@/lib/db';
import { chatRobust } from '@/lib/llm';
import { profileUpdateSystem, profileUpdateUser } from '@/lib/prompts';
import type { ShelfStatus } from '@/lib/types';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import { requireApiOwner } from '@/lib/auth';

export const maxDuration = 295;

const MAX_BODY_BYTES = 8 * 1024;

const VALID: ShelfStatus[] = ['want', 'reading', 'done', 'dropped'];

export async function POST(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const { title, author, status, note } = body ?? {};
  const cleanTitle = boundedString(title, 200) ?? '';
  const cleanAuthor = boundedString(author, 200) || '佚名';
  const cleanNote = boundedString(note ?? '', 1_000);
  if (!cleanTitle || cleanNote === null ||
      typeof status !== 'string' || !VALID.includes(status as ShelfStatus)) {
    return NextResponse.json({ error: 'missing title, invalid status, or note too long' }, { status: 400 });
  }
  const safeNote = cleanNote;
  const shelfStatus = status as ShelfStatus;
  try {
    await ensureSchema();
    const sql = getSql();
    const bookId = await upsertBook({
      title: cleanTitle,
      author: cleanAuthor,
      meta: {},
    });
    await sql.transaction([
      sql`INSERT INTO feedback (book_id, status, note)
          VALUES (${bookId}, ${shelfStatus}, ${safeNote})`,
      sql`UPDATE recommendations SET status = ${shelfStatus} WHERE book_id = ${bookId}`,
    ]);

    // 有信息量的反馈 → 回写画像（失败不阻断）
    let profileUpdated = false;
    if ((shelfStatus === 'done' || shelfStatus === 'dropped') && safeNote) {
      try {
        const profile = await getProfile();
        if (profile.content) {
          const updated = await chatRobust(
            profileUpdateSystem(),
            profileUpdateUser(profile.content, JSON.stringify({
              title: cleanTitle,
              author: cleanAuthor,
              status: shelfStatus,
              note: safeNote,
            })),
            { temperature: 0.3 },
          );
          profileUpdated = await saveProfile(profile.seeds, updated.trim(), profile.updatedAt);
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

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
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
