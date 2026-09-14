import { boundedString } from './http';
import type { Candidate, RerankedItem, SeedBook, VerifiedCandidate } from './types';

// 从 LLM / 客户端回传的不可信数据里清洗出结构化的值。
// 这些函数是纯函数(无 IO),单独成模块以便测试。

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MAX_CANDIDATES = 12;
export const MAX_RERANKED_ITEMS = 10;
const MAX_HIT_LIKES = 10;

// PostgreSQL text/jsonb 不接受 NUL 或孤立 UTF-16 代理项；有效的 emoji 代理对保留。
export function hasInvalidDatabaseCharacters(value: string): boolean {
  return value.includes(String.fromCharCode(0)) ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}

export function cleanString(value: unknown, maxLength = 500): string {
  if (typeof value === 'string' && hasInvalidDatabaseCharacters(value)) return '';
  return boundedString(value, maxLength) ?? '';
}

// 只接受数值或非空十进制数值字符串，避免 Number(null / '' / false) 变成 0。
export function finiteScore(value: unknown): number | null {
  if (typeof value !== 'number' &&
      (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) {
    return null;
  }
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function hasInvalidText(record: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) =>
    typeof record[field] === 'string' && hasInvalidDatabaseCharacters(record[field]));
}

function uniqueBooks<T extends { title: string; author: string }>(books: T[]): T[] {
  const seen = new Set<string>();
  return books.filter((book) => {
    const key = bookKey(book.title, book.author);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 与 db.ts canonicalBookKey 保持一致:NFKC + trim + 小写,NUL 分隔
const BOOK_KEY_SEP = String.fromCharCode(0);
export function bookKey(title: string, author: string): string {
  return `${title.normalize('NFKC').trim().toLocaleLowerCase()}${BOOK_KEY_SEP}${author.normalize('NFKC').trim().toLocaleLowerCase()}`;
}

export function sanitizeCandidates(value: unknown): Candidate[] {
  if (!Array.isArray(value)) return [];
  return uniqueBooks(value.slice(0, MAX_CANDIDATES).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (hasInvalidText(candidate, ['title', 'author', 'category', 'wordCount', 'why'])) return [];
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
  }));
}

export function sanitizeVerified(value: unknown): VerifiedCandidate[] {
  if (!Array.isArray(value)) return [];
  return uniqueBooks<VerifiedCandidate>(value.slice(0, MAX_CANDIDATES).flatMap((candidate) => {
    const [clean] = sanitizeCandidates([candidate]);
    if (!clean || !isRecord(candidate) || !isRecord(candidate.douban)) return [];
    const douban = candidate.douban;
    if (hasInvalidText(douban, ['doubanId', 'url', 'note'])) return [];
    return [{
      ...clean,
      douban: {
        status: douban.status === 'verified' || douban.status === 'not_found'
          ? douban.status : 'unavailable',
        found: douban.status === 'verified' && douban.found === true,
        doubanId: cleanString(douban.doubanId) || undefined,
        rating: typeof douban.rating === 'number' && Number.isFinite(douban.rating) &&
          douban.rating >= 0 && douban.rating <= 10
          ? douban.rating : null,
        ratingCount: typeof douban.ratingCount === 'number' && Number.isSafeInteger(douban.ratingCount) &&
          douban.ratingCount >= 0
          ? douban.ratingCount : null,
        url: cleanString(douban.url) || undefined,
        note: cleanString(douban.note) || undefined,
      },
    }];
  }));
}

export function sanitizeRerankedItems(value: unknown): RerankedItem[] {
  if (!Array.isArray(value)) return [];
  return uniqueBooks(value.slice(0, MAX_RERANKED_ITEMS).flatMap((item) => {
    if (!isRecord(item)) return [];
    if (hasInvalidText(item, ['title', 'author', 'category', 'wordCount', 'risks', 'reason', 'why']) ||
        (Array.isArray(item.hitLikes) && item.hitLikes.some((like) =>
          typeof like === 'string' && hasInvalidDatabaseCharacters(like)))) return [];
    const title = cleanString(item.title, 200);
    const author = cleanString(item.author, 200);
    const matchScore = finiteScore(item.matchScore);
    if (!title || !author || matchScore === null) return [];
    return [{
      title,
      author,
      category: cleanString(item.category),
      wordCount: cleanString(item.wordCount),
      matchScore: Math.max(0, Math.min(100, Math.round(matchScore))),
      hitLikes: Array.isArray(item.hitLikes)
        ? item.hitLikes.slice(0, MAX_HIT_LIKES).map((like) => cleanString(like)).filter(Boolean)
        : [],
      risks: cleanString(item.risks),
      reason: cleanString(item.reason),
      why: cleanString(item.why),
      ...(item.hallucinationRisk === true ? { hallucinationRisk: true } : {}),
    }];
  }));
}

export function sanitizeSeeds(seeds: unknown): SeedBook[] {
  if (!Array.isArray(seeds)) return [];
  return seeds
    .filter((seed): seed is Record<string, unknown> =>
      isRecord(seed) && !hasInvalidText(seed, ['title', 'author', 'reason']) &&
      Boolean(cleanString(seed.title, 200)))
    .map((seed) => ({
      title: cleanString(seed.title, 200),
      author: cleanString(seed.author, 200) || undefined,
      kind: seed.kind === 'drop' ? 'drop' : 'love',
      reason: cleanString(seed.reason, 1_000) || undefined,
    }));
}
