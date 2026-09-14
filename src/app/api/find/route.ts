import { NextRequest, NextResponse } from 'next/server';
import { chatRobust, parseJson, LlmError } from '@/lib/llm';
import { verifyBatch } from '@/lib/douban';
import {
  ensureSchema,
  getExcludedBookKeys,
  getExcludedBookTitles,
  getProfile,
  persistRecommendations,
} from '@/lib/db';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import {
  bookKey,
  sanitizeCandidates,
  sanitizeRerankedItems,
  sanitizeVerified,
} from '@/lib/sanitize';
import { requireApiOwner } from '@/lib/auth';
import {
  recallSystem,
  recallUser,
  rerankSystem,
  rerankUser,
} from '@/lib/prompts';
import type { VerifiedCandidate } from '@/lib/types';

export const maxDuration = 295;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 1_000;

// 三步流水线由前端分步调用：recall → verify → rerank
// 每步都独立控制在函数时限内，前端可以展示进度

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
  if (!body?.step) {
    return NextResponse.json({ error: 'missing step' }, { status: 400 });
  }
  const step = body.step as string;

  try {
    await ensureSchema();
    if (step === 'recall') {
      const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
      if (!query) {
        return NextResponse.json({ error: 'missing query' }, { status: 400 });
      }
      const profile = await getProfile();
      const excludedKeys = new Set([
        ...profile.seeds.map((seed) => bookKey(seed.title, seed.author ?? '')),
        ...(await getExcludedBookKeys()),
      ]);
      // 已读/弃书列表传给提示词做软约束，后端 filter 做硬约束
      const excludedBooks = [
        ...profile.seeds.map((seed) => ({ title: seed.title, author: seed.author ?? '' })),
        ...(await getExcludedBookTitles()),
      ];
      const raw = await chatRobust(
        recallSystem(),
        recallUser(profile.content, query, excludedBooks),
        { temperature: 0.8 },
      );
      const parsed = parseJson<{ candidates: unknown }>(raw);
      const candidates = sanitizeCandidates(parsed.candidates)
        .filter((candidate) => !excludedKeys.has(bookKey(candidate.title, candidate.author)));
      if (candidates.length === 0) {
        return NextResponse.json({ error: '召回结果为空，换个说法试试' }, { status: 502 });
      }
      return NextResponse.json({ candidates });
    }

    if (step === 'verify') {
      const candidates = sanitizeCandidates(body.candidates);
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
      const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
      const verified = sanitizeVerified(body.verified);
      if (!query || verified.length === 0) {
        return NextResponse.json({ error: 'missing query or verified' }, { status: 400 });
      }
      const { content: profile } = await getProfile();
      const raw = await chatRobust(
        rerankSystem(),
        rerankUser(profile, query, JSON.stringify(verified)),
        { temperature: 0.3 },
      );
      const parsed = parseJson<{ items: unknown }>(raw);
      // 用书名+作者关联，避免同名作品回填到错误的豆瓣条目。
      const byBook = new Map(verified.map((v) => [bookKey(v.title, v.author), v]));
      const items = sanitizeRerankedItems(parsed.items)
        .filter((it) => byBook.has(bookKey(it.title, it.author)))
        .map((it) => {
          const source = byBook.get(bookKey(it.title, it.author));
          return {
            ...it,
            // why/元数据以召回阶段的原始输出为准，不信重排的转述
            why: source?.why || it.why,
            category: source?.category || it.category,
            wordCount: source?.wordCount || it.wordCount,
            douban: source?.douban,
          };
        })
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 10);
      if (items.length === 0) {
        return NextResponse.json({ error: '重排结果为空，换个说法试试' }, { status: 502 });
      }

      // 持久化：books + recommendations
      let persisted = true;
      try {
        await persistRecommendations(query, items);
      } catch (e) {
        persisted = false;
        console.error('persist failed:', e);
      }
      return NextResponse.json({ items, persisted });
    }

    return NextResponse.json({ error: `unknown step: ${step}` }, { status: 400 });
  } catch (e) {
    if (e instanceof LlmError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    if (e instanceof Error && e.message === 'DATABASE_URL is not set') {
      return NextResponse.json({ error: '数据库未配置（DATABASE_URL）' }, { status: 503 });
    }
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
