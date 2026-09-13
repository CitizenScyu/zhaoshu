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
import { requireApiOwner } from '@/lib/auth';
import {
  recallSystem,
  recallUser,
  rerankSystem,
  rerankUser,
} from '@/lib/prompts';
import type { Candidate, VerifiedCandidate, RerankedItem } from '@/lib/types';

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
      return NextResponse.json({ error: e.message }, { status: 413 });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cleanString(value: unknown, maxLength = 500): string {
  return boundedString(value, maxLength) ?? '';
}

// 与 db.ts canonicalBookKey 保持一致：NFKC + trim + 小写，NUL 分隔
function bookKey(title: string, author: string): string {
  return `${title.normalize('NFKC').trim().toLocaleLowerCase()}\u0000${author.normalize('NFKC').trim().toLocaleLowerCase()}`;
}

function sanitizeCandidates(value: unknown): Candidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const title = cleanString(candidate.title, 200);
    const author = cleanString(candidate.author, 200);
    if (!title || !author) return [];
    return [{
      title,
      author,
      category: cleanString(candidate.category),
      wordCount: cleanString(candidate.wordCount),
      why: cleanString(candidate.why),
      source: 'llm' as const,
    }];
  });
}

function sanitizeVerified(value: unknown): VerifiedCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((candidate) => {
    const [clean] = sanitizeCandidates([candidate]);
    if (!clean || !isRecord(candidate) || !isRecord(candidate.douban)) return [];
    const douban = candidate.douban;
    return [{
      ...clean,
      douban: {
        status: douban.status === 'verified' || douban.status === 'not_found'
          ? douban.status : 'unavailable',
        found: douban.status === 'verified' && douban.found === true,
        doubanId: cleanString(douban.doubanId) || undefined,
        rating: typeof douban.rating === 'number' && Number.isFinite(douban.rating)
          ? douban.rating : null,
        ratingCount: typeof douban.ratingCount === 'number' && Number.isFinite(douban.ratingCount)
          ? douban.ratingCount : null,
        url: cleanString(douban.url) || undefined,
        note: cleanString(douban.note) || undefined,
      },
    }];
  });
}

function sanitizeRerankedItems(value: unknown): RerankedItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const title = cleanString(item.title, 200);
    const author = cleanString(item.author, 200);
    const matchScore = typeof item.matchScore === 'number' ? item.matchScore : Number(item.matchScore);
    if (!title || !author || !Number.isFinite(matchScore)) return [];
    return [{
      title,
      author,
      category: cleanString(item.category),
      wordCount: cleanString(item.wordCount),
      matchScore: Math.max(0, Math.min(100, Math.round(matchScore))),
      hitLikes: Array.isArray(item.hitLikes)
        ? item.hitLikes.map((like) => cleanString(like)).filter(Boolean)
        : [],
      risks: cleanString(item.risks),
      reason: cleanString(item.reason),
      why: cleanString(item.why),
      ...(item.hallucinationRisk === true ? { hallucinationRisk: true } : {}),
    }];
  });
}
