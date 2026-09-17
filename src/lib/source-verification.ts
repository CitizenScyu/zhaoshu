import { createDeadline, WRITE_BACK_RESERVE_MS, type RequestDeadline } from './deadline';
import { getReadingSources } from './shuyuan';
import { resolveSourceBook, SourceReaderError, SourceRequestContext } from './source-reader';
import type { SourceEvidence, SourceEvidenceCode, VerifiedCandidate } from './types';

export const SOURCE_VERIFY_BUDGET_MS = 25_000;
export const SOURCE_VERIFY_REQUEST_LIMIT = 24;
// 候选之间的有限并发。选 3 的理由：
// 1) 下游是外部书源站，并发上限必须小且固定；source-reader 的 350ms 时间槽节流保证
//    「请求起始间隔」不因并发缩短，所以并发只用来重叠响应等待，不放大对源站的请求速率；
// 2) 单本补验通常 1 次搜索 + 最多 4 次详情，3 路并发足以把 25s 预算内的候选吞吐抬到
//    串行的近 3 倍，又不会把共享的 24 次请求额度瞬间打空。
export const SOURCE_VERIFY_CONCURRENCY = 3;

const NOTES: Record<SourceEvidenceCode, string> = {
  SOURCE_NOT_FOUND: '可查询的书源未找到匹配目录，不等于作品不存在。',
  SOURCE_AMBIGUOUS: '书源里存在多部同名作品，未补全作者无法确认，不等于作品不存在。',
  SOURCE_UNAVAILABLE: '书源本轮未能提供这本书（源站暂时故障或结果不完整），不等于作品不存在。',
  SOURCE_BUDGET_EXCEEDED: '本轮书源查询额度已用完，作品存在性仍待核验。',
  SOURCE_VERIFY_TIMEOUT: '书源补验超时或已取消，作品存在性仍待核验。',
  SOURCE_VERIFY_ERROR: '书源补验遇到网络或解析错误，作品存在性仍待核验。',
  SOURCE_VERIFY_SKIPPED: '本轮书源补验未执行（预算不足或已超时），作品存在性仍待核验。',
};

// 按 code 分档，而不是一律压成同一个 unavailable：前端与下游才能区分「站点没有」和「站点挂了」。
function evidence(code: SourceEvidenceCode): SourceEvidence {
  return { status: code === 'SOURCE_NOT_FOUND' ? 'not_found' : 'unavailable', code, note: NOTES[code] };
}

const knownCode = (code: string): code is SourceEvidenceCode => Object.prototype.hasOwnProperty.call(NOTES, code);

function failureEvidence(error: unknown, aborted: boolean): SourceEvidence {
  if (error instanceof SourceReaderError) {
    return evidence(knownCode(error.code) ? error.code : 'SOURCE_UNAVAILABLE');
  }
  return evidence(aborted ? 'SOURCE_VERIFY_TIMEOUT' : 'SOURCE_VERIFY_ERROR');
}

export async function supplementSourceEvidence(
  candidates: VerifiedCandidate[],
  deadline: RequestDeadline,
  parentSignal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<VerifiedCandidate[]> {
  const pendingIndexes: number[] = [];
  candidates.forEach((candidate, index) => {
    if (candidate.douban.status !== 'verified' || !candidate.douban.found) pendingIndexes.push(index);
  });
  if (!pendingIndexes.length) return candidates;
  parentSignal.throwIfAborted();
  const budgetMs = Math.min(SOURCE_VERIFY_BUDGET_MS, Math.max(0, deadline.remainingMs - WRITE_BACK_RESERVE_MS));
  const result = candidates.map((candidate, index) => pendingIndexes.includes(index)
    ? { ...candidate, sourceEvidence: evidence('SOURCE_VERIFY_SKIPPED') } : candidate);
  if (budgetMs <= 0) return result;
  // A single bounded supplement inside the existing verify step, never a fresh model budget.
  const budget = createDeadline(budgetMs);
  const signal = AbortSignal.any([parentSignal, deadline.signal, budget.signal]);
  const context = new SourceRequestContext(signal, SOURCE_VERIFY_REQUEST_LIMIT);
  let done = 0;
  let next = 0;
  onProgress?.(done, pendingIndexes.length);
  try {
    const sources = await getReadingSources(signal);
    // 有限并发的取号器：每本书的失败/超时互不影响，共享同一份请求额度与信号。
    const worker = async (): Promise<void> => {
      for (;;) {
        parentSignal.throwIfAborted();
        // 预算/额度耗尽后不再启动新候选；在飞的候选由各自 signal 终止。
        if (signal.aborted || context.requests >= context.limit) return;
        const index = next++;
        if (index >= pendingIndexes.length) return;
        const candidate = result[pendingIndexes[index]];
        try {
          const match = await resolveSourceBook(candidate, context, { sources });
          candidate.sourceEvidence = {
            status: 'matched', sourceName: match.sourceName, url: match.bookUrl, checkedAt: new Date().toISOString(),
            note: '书名与作者匹配，书源提供章节目录；仅补充存在性证据，不代表豆瓣收录、评分或全书可用。',
          };
        } catch (error) {
          parentSignal.throwIfAborted();
          candidate.sourceEvidence = failureEvidence(error, signal.aborted);
        }
        onProgress?.(++done, pendingIndexes.length);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(SOURCE_VERIFY_CONCURRENCY, pendingIndexes.length) },
      worker,
    ));
  } catch (error) {
    parentSignal.throwIfAborted();
    // A source outage never destroys successful Douban results or stops reranking — but it must leave a trace.
    for (const index of pendingIndexes) {
      if (result[index].sourceEvidence?.code === 'SOURCE_VERIFY_SKIPPED') {
        result[index].sourceEvidence = evidence('SOURCE_VERIFY_ERROR');
      }
    }
    console.error('source supplement failed', error instanceof Error ? error.message : error);
  } finally {
    budget.dispose();
  }
  return result;
}
