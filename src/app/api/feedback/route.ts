import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql, recordFeedbackForUser, getProfileForUser, saveProfileForUser } from '@/lib/db';
import { chatRobust, configuredTotalTimeoutMs, validateProfileContent } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import { profileUpdateSystem, profileUpdateUser } from '@/lib/prompts';
import type { ShelfStatus } from '@/lib/types';
import { boundedString, readJsonBody } from '@/lib/http';
import { withFindAccess } from '@/lib/personal-request';
import { DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS } from '@/lib/deadline';

export const maxDuration = 295;

const MAX_BODY_BYTES = 8 * 1024;
// 反馈回写画像的模型子预算：在内部预算里预留写回
const MODEL_CEILING_MS = 220_000;

const VALID: ShelfStatus[] = ['want', 'reading', 'done', 'dropped'];

export async function POST(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
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
    const { userId } = access.principal;
    await access.run(ensureSchema);
    await access.commit((write) => recordFeedbackForUser(userId,
      { title: cleanTitle, author: cleanAuthor }, shelfStatus, safeNote, write));
    let profileUpdated = false;
    let updatedAt: string | null = null;
    if ((shelfStatus === 'done' || shelfStatus === 'dropped') && safeNote && !access.deadline.expired) {
      try {
        const profile = await access.run(() => getProfileForUser(userId));
        if (profile.content) {
          const budgetMs = Math.min(access.deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
          if (budgetMs <= 0) throw new DeadlineExceededError(MODEL_ROUTE_INTERNAL_BUDGET_MS);
          const { content: updated } = await access.run(() => chatRobust(
            profileUpdateSystem(), profileUpdateUser(profile.content, JSON.stringify({
              title: cleanTitle, author: cleanAuthor, status: shelfStatus, note: safeNote,
            })),
            { temperature: 0.3, signal: access.signal, onUsage: recordUsageAfterResponse('feedback'), totalTimeoutMs: budgetMs },
          ));
          const content = validateProfileContent(updated);
          updatedAt = await access.commit((write) => saveProfileForUser(userId, profile.seeds, content, profile.updatedAt, write));
          profileUpdated = updatedAt !== null;
        }
      } catch {
        // 已保存的反馈保留；授权改变、冲突、模型或预算错误都不再写画像。
      }
    }
    return NextResponse.json({ ok: true, profileUpdated, ...(updatedAt ? { updatedAt } : {}) });
  });
}

export async function GET(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    await access.run(ensureSchema);
    const sql = getSql();
    const rows = await access.run(async () => sql`
      SELECT f.id, f.status, f.note, f.created_at, b.title, b.author
      FROM feedback f JOIN books b ON b.id = f.book_id
      WHERE f.user_id = ${access.principal.userId}
      ORDER BY f.created_at DESC LIMIT 200`);
    return NextResponse.json({ feedback: rows });
  });
}
