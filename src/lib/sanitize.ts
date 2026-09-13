import { boundedString } from './http';
import type { Candidate, RerankedItem, SeedBook, VerifiedCandidate } from './types';

// 从 LLM / 客户端回传的不可信数据里清洗出结构化的值。
// 这些函数是纯函数(无 IO),单独成模块以便测试。

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function cleanString(value: unknown, maxLength = 500): string {
  return boundedString(value, maxLength) ?? '';
}

// 与 db.ts canonicalBookKey 保持一致:NFKC + trim + 小写,NUL 分隔
const BOOK_KEY_SEP = String.fromCharCode(0);
export function bookKey(title: string, author: string): string {
  return `${title.normalize('NFKC').trim().toLocaleLowerCase()}${BOOK_KEY_SEP}${author.normalize('NFKC').trim().toLocaleLowerCase()}`;
}

export function sanitizeCandidates(value: unknown): Candidate[] {
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

export function sanitizeVerified(value: unknown): VerifiedCandidate[] {
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

export function sanitizeRerankedItems(value: unknown): RerankedItem[] {
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

export function sanitizeSeeds(seeds: unknown): SeedBook[] {
  if (!Array.isArray(seeds)) return [];
  return seeds
    .filter((seed): seed is Record<string, unknown> =>
      typeof seed === 'object' && seed !== null &&
      Boolean(boundedString(seed.title, 200)))
    .map((seed) => ({
      title: boundedString(seed.title, 200) as string,
      author: boundedString(seed.author, 200) || undefined,
      kind: seed.kind === 'drop' ? 'drop' : 'love',
      reason: boundedString(seed.reason, 1_000) || undefined,
    }));
}
