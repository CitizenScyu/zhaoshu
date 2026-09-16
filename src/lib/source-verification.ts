import { createDeadline, WRITE_BACK_RESERVE_MS, type RequestDeadline } from './deadline';
import { getReadingSources } from './shuyuan';
import { resolveSourceBook, SourceReaderError, SourceRequestContext } from './source-reader';
import type { SourceEvidence, VerifiedCandidate } from './types';

export const SOURCE_VERIFY_BUDGET_MS = 25_000;
export const SOURCE_VERIFY_REQUEST_LIMIT = 24;
const unavailable = (): SourceEvidence => ({ status: 'unavailable', note: '本轮书源补验不可用或预算不足，作品存在性仍待核验。' });

export async function supplementSourceEvidence(
  candidates: VerifiedCandidate[],
  deadline: RequestDeadline,
  parentSignal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<VerifiedCandidate[]> {
  const pending = candidates.filter((candidate) => candidate.douban.status !== 'verified' || !candidate.douban.found);
  if (!pending.length) return candidates;
  parentSignal.throwIfAborted();
  const budgetMs = Math.min(SOURCE_VERIFY_BUDGET_MS, Math.max(0, deadline.remainingMs - WRITE_BACK_RESERVE_MS));
  const result = candidates.map((candidate) => pending.includes(candidate) ? { ...candidate, sourceEvidence: unavailable() } : candidate);
  if (budgetMs <= 0) return result;
  // A single bounded supplement inside the existing verify step, never a fresh model budget.
  const budget = createDeadline(budgetMs);
  const signal = AbortSignal.any([parentSignal, deadline.signal, budget.signal]);
  const context = new SourceRequestContext(signal, SOURCE_VERIFY_REQUEST_LIMIT);
  let done = 0;
  onProgress?.(done, pending.length);
  try {
    const sources = await getReadingSources(signal);
    for (const candidate of result) {
      parentSignal.throwIfAborted();
      if (!candidate.sourceEvidence || signal.aborted || context.requests >= context.limit) continue;
      try {
        const match = await resolveSourceBook(candidate, context, { sources });
        candidate.sourceEvidence = {
          status: 'matched', sourceName: match.sourceName, url: match.bookUrl, checkedAt: new Date().toISOString(),
          note: '书名与作者匹配，书源提供章节目录；仅补充存在性证据，不代表豆瓣收录、评分或全书可用。',
        };
      } catch (error) {
        parentSignal.throwIfAborted();
        candidate.sourceEvidence = error instanceof SourceReaderError && error.code === 'SOURCE_NOT_FOUND'
          ? { status: 'not_found', note: '可查询的书源未找到匹配目录，不等于作品不存在。' } : unavailable();
      }
      onProgress?.(++done, pending.length);
    }
  } catch {
    parentSignal.throwIfAborted();
    // A source outage never destroys successful Douban results or stops reranking.
  } finally {
    budget.dispose();
  }
  return result;
}
