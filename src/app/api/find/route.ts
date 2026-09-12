import { NextRequest, NextResponse } from 'next/server';
import { chatRobust, parseJson, LlmError } from '@/lib/llm';
import { verifyBatch } from '@/lib/douban';
import { getProfile, upsertBook, ensureSchema } from '@/lib/db';
import {
  recallSystem,
  recallUser,
  rerankSystem,
  rerankUser,
} from '@/lib/prompts';
import type { Candidate, VerifiedCandidate, RerankedItem } from '@/lib/types';

export const maxDuration = 300;

// 三步流水线由前端分步调用：recall → verify → rerank
// 每步都独立控制在函数时限内，前端可以展示进度

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.step) {
    return NextResponse.json({ error: 'missing step' }, { status: 400 });
  }
  const step = body.step as string;

  try {
    if (step === 'recall') {
      const query = (body.query as string)?.trim();
      if (!query) {
        return NextResponse.json({ error: 'missing query' }, { status: 400 });
      }
      const { content: profile } = await getProfile().catch(() => ({ content: '' }));
      const raw = await chatRobust(
        recallSystem(),
        recallUser(profile, query),
        { temperature: 0.8 },
      );
      const parsed = parseJson<{ candidates: Candidate[] }>(raw);
      const candidates = (parsed.candidates ?? []).slice(0, 12);
      if (candidates.length === 0) {
        return NextResponse.json({ error: '召回结果为空，换个说法试试' }, { status: 502 });
      }
      return NextResponse.json({ candidates });
    }

    if (step === 'verify') {
      const candidates = (body.candidates as Candidate[]) ?? [];
      if (candidates.length === 0) {
        return NextResponse.json({ error: 'missing candidates' }, { status: 400 });
      }
      const infos = await verifyBatch(candidates);
      const verified: VerifiedCandidate[] = candidates.map((c, i) => ({
        ...c,
        douban: infos[i],
      }));
      return NextResponse.json({ verified });
    }

    if (step === 'rerank') {
      const query = (body.query as string)?.trim();
      const verified = (body.verified as VerifiedCandidate[]) ?? [];
      if (!query || verified.length === 0) {
        return NextResponse.json({ error: 'missing query or verified' }, { status: 400 });
      }
      const { content: profile } = await getProfile().catch(() => ({ content: '' }));
      const raw = await chatRobust(
        rerankSystem(),
        rerankUser(profile, query, JSON.stringify(verified)),
        { temperature: 0.3 },
      );
      const parsed = parseJson<{ items: RerankedItem[] }>(raw);
      // 把豆瓣信息从 verified 里回填（重排输出里没有）
      const byTitle = new Map(verified.map((v) => [v.title, v]));
      const items = (parsed.items ?? []).map((it) => ({
        ...it,
        douban: byTitle.get(it.title)?.douban,
      }));

      // 持久化：books + recommendations
      try {
        await ensureSchema();
        for (const it of items) {
          const bookId = await upsertBook({
            title: it.title,
            author: it.author,
            doubanId: it.douban?.doubanId ?? null,
            doubanRating: it.douban?.rating ?? null,
            doubanRatingCount: it.douban?.ratingCount ?? null,
            meta: { category: it.category, wordCount: it.wordCount },
          });
          const { getSql } = await import('@/lib/db');
          const sql = getSql();
          // 同一本书对同一 query 不重复记录
          await sql`
            INSERT INTO recommendations (book_id, query, match_score, hit_likes, risks, reason)
            SELECT ${bookId}, ${query}, ${it.matchScore}, ${JSON.stringify(it.hitLikes)}::jsonb,
                   ${it.risks}, ${it.reason}
            WHERE NOT EXISTS (
              SELECT 1 FROM recommendations r WHERE r.book_id = ${bookId} AND r.query = ${query}
            )`;
        }
      } catch (e) {
        // 持久化失败不阻断返回，结果照常展示
        console.error('persist failed:', e);
      }
      return NextResponse.json({ items });
    }

    return NextResponse.json({ error: `unknown step: ${step}` }, { status: 400 });
  } catch (e) {
    if (e instanceof LlmError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
