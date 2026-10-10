import { SourcePolicyError, validateSourceUrl } from './source-policy';
import { resolveSourceBook, SourceReaderError, SourceRequestContext, type SourceSearchStat } from './source-reader';
import { getEngineSources } from './shuyuan';

export interface DownloadRelocationCandidate {
  title: string;
  author: string;
  bookUrl: string;
}

export class DownloadRelocationError extends Error {
  constructor(
    message: string,
    readonly code: 'RELOCATION_NO_CANDIDATES' | 'RELOCATION_AMBIGUOUS' | 'RELOCATION_IDENTITY_MISMATCH',
    readonly status: 404 | 422,
    readonly candidates?: DownloadRelocationCandidate[],
  ) {
    super(message);
    this.name = 'DownloadRelocationError';
  }
}

function displayCandidates(error: SourceReaderError): DownloadRelocationCandidate[] {
  const candidates = (error as SourceReaderError & { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.title !== 'string' || typeof value.author !== 'string' || typeof value.bookUrl !== 'string') return [];
    return [{ title: value.title, author: value.author, bookUrl: value.bookUrl }];
  });
}

export async function resolveDownloadRelocation(
  book: { title: string; author: string },
  signal: AbortSignal,
) {
  const searchStats: SourceSearchStat[] = [];
  try {
    // The pool is the capability boundary. The historical labeled_books.source_url
    // is deliberately not accepted by this adapter and therefore cannot be requested.
    const pool = await getEngineSources(signal);
    const catalog = await resolveSourceBook(book, new SourceRequestContext(signal), { sources: pool, searchStats });
    const bookUrl = validateSourceUrl(catalog.bookUrl).href;
    return {
      bookUrl,
      sourceUrl: catalog.sourceUrl,
      sourceId: catalog.sourceId,
      sourceRevision: catalog.sourceRevision,
      matched: { title: catalog.title, author: catalog.author },
    };
  } catch (error) {
    if (error instanceof SourceReaderError) {
      if (error.code === 'SOURCE_NOT_FOUND') {
        const sawCandidates = searchStats.some((stat) => stat.candidates > 0 || stat.fallbackCandidates > 0);
        throw new DownloadRelocationError(
          error.message,
          sawCandidates ? 'RELOCATION_IDENTITY_MISMATCH' : 'RELOCATION_NO_CANDIDATES',
          sawCandidates ? 422 : 404,
        );
      }
      if (error.code === 'SOURCE_AMBIGUOUS') {
        throw new DownloadRelocationError(error.message, 'RELOCATION_AMBIGUOUS', 422, displayCandidates(error));
      }
      if (error.code === 'SOURCE_SIMILAR') {
        // 相似但非精确命中不携带展示候选：第四参省略（参数属性会把它固化成
        // 值为 undefined 的自有属性，消费方仅按“值是否数组”读，见 route.ts）。
        throw new DownloadRelocationError(error.message, 'RELOCATION_IDENTITY_MISMATCH', 422);
      }
      // Availability, rate-limit and budget errors retain the reader contract,
      // including their existing 503/504 status.
      throw error;
    }
    if (error instanceof SourcePolicyError) {
      throw new DownloadRelocationError(error.message, 'RELOCATION_IDENTITY_MISMATCH', 422);
    }
    throw error;
  }
}
