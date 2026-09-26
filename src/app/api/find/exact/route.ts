import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess, type PersonalRequest } from '@/lib/personal-request';
import { boundedString, readJsonBody } from '@/lib/http';
import { exactLibraryBooksForUserQuery } from '@/lib/user-data';
import { normalizeBookAuthor } from '@/lib/book-identity';
import { fetchSubjectRating, searchBooks, type DoubanCandidate } from '@/lib/douban';
import { isRecord } from '@/lib/sanitize';
import {
  EXACT_DOUBAN_MISS_NOTE,
  EXACT_UNAVAILABLE_NOTE,
  type ExactBook,
  type ExactResponse,
} from '@/lib/find-exact';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// 精确找书（task-77）：按书名直搜，不是口味召回。
//
// 与 /api/find 的关系：**完全独立**。这里不调用任何 LLM，所以不用 SSE（没有阶段/进度可报），
// 也不复用 recall→verify→rerank 的预算链。鉴权、CSRF、超时预算走同一套 withFindAccess。
//
// 三步（按序）：
//   1) 本地 books 表按身份键精确命中 → 直接返回，免费即时，不打豆瓣；
//   2) 未命中 → 豆瓣 subject_suggest 检索，**返回全部候选**（同名书很多，让用户挑）；
//   3) 只给前 N 个候选抓详情页补评分（可选加分项，抓不到就留空）。
// 豆瓣对网文收录很差：未出版的网文常无条目，所以「查不到」是常见结果，不是「书不存在」。
export const maxDuration = 30;

const MAX_BODY_BYTES = 4 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 200;

// 无 LLM，预算只覆盖两次网络往返：suggest 12s（fetchWithTimeout 内部上限）
// + 一轮并发 3 的详情页 12s = 最坏 24s，留 1s 余量。
// 刻意让最坏情况落在预算内：否则用户会拿到列表却在评分阶段被截断，结果不稳定。
const EXACT_BUDGET_MS = 25_000;

// 详情页只抓前 N 个候选。N = 3 有两个理由：与 verifyBatch 的 CONCURRENCY = 3 对齐
// （豆瓣对高频不友好，一轮发完就停），以及「给同名候选一个参考分」本来就是加分项，
// 不是全量 enrich。其余候选 rating 留 null，用户可点豆瓣链接自己看。
const MAX_RATING_LOOKUPS = 3;
const DETAIL_CONCURRENCY = 3;

interface LibraryRow {
  metadata_source: string;
  id: number;
  title: string;
  author: string;
  douban_id: string | null;
  douban_rating: number | null;
  douban_rating_count: number | null;
  meta: unknown;
  on_shelf: boolean;
  author_match: boolean;
  has_txt: boolean;
  has_online_source: boolean;
}

// douban_id 进 URL 前先确认是纯数字：库里这一列由 verifyBook 写入，但它是 text 列，
// 不做校验就等于把库里的任意字符串拼进发给豆瓣的请求路径。
function doubanUrlFor(id: string | null | undefined): string | undefined {
  return typeof id === 'string' && /^\d+$/.test(id) ? `https://book.douban.com/subject/${id}/` : undefined;
}

function toLibraryItem(row: LibraryRow): ExactBook {
  const meta = isRecord(row.meta) ? row.meta : {};
  const url = doubanUrlFor(row.douban_id);
  // F10：可读性只据数据推导，不承诺。有完成 TXT → 'txt'；书库行有在线书源 URL →
  // 'online'（待确认）；否则只有元数据 → 'metadata'。文案由客户端按此渲染。
  const readAvailability = row.has_txt ? 'txt' as const
    : row.has_online_source ? 'online' as const : 'metadata' as const;
  return {
    title: row.title,
    author: row.author,
    source: 'library',
    metadataSource: row.metadata_source === 'labeled_books' ? 'labeled_books' : 'books',
    authorMatch: row.author_match === true,
    readAvailability,
    ...(url ? { doubanId: row.douban_id as string, doubanUrl: url } : {}),
    rating: typeof row.douban_rating === 'number' ? row.douban_rating : null,
    ratingCount: typeof row.douban_rating_count === 'number' ? row.douban_rating_count : null,
    ...(typeof meta.category === 'string' && meta.category ? { category: meta.category } : {}),
    ...(typeof meta.wordCount === 'string' && meta.wordCount ? { wordCount: meta.wordCount } : {}),
    ...(row.on_shelf === true ? { onShelf: true } : {}),
  };
}

// 豆瓣候选补上评分字段后的形状。刻意保留 DoubanCandidate 的必填 doubanId：
// ExactBook 里它是可选的（本地命中可能没有），在这里收窄回去，取值时不必再判空。
export type RatedCandidate = DoubanCandidate & {
  source: 'douban';
  rating: number | null;
  ratingCount: number | null;
};

// 给前 limit 个候选补评分。这一步失败**不**改变「这本书有没有条目」的结论：
// 详情页被拦 / 单次超时 / 预算耗尽都只是 rating 留空，列表照常返回。
// 预算耗尽时不再领新任务（signal.aborted），与 verifyBatch 的 worker 同一套写法。
async function withRatings(
  candidates: DoubanCandidate[],
  access: PersonalRequest,
  limit: number,
): Promise<RatedCandidate[]> {
  const items: RatedCandidate[] = candidates.map((candidate) =>
    ({ ...candidate, source: 'douban' as const, rating: null, ratingCount: null }));
  const targets = items.slice(0, limit);
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      if (access.signal.aborted) break;
      const item = targets[next++];
      try {
        const info = await access.run(() => fetchSubjectRating(item.doubanId, access.signal));
        item.rating = info.rating;
        item.ratingCount = info.ratingCount;
      } catch { /* 评分是加分项，拿不到就留空 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, targets.length) }, worker));
  return items;
}

async function handlePOST(req: NextRequest) {
  return withFindAccess(req, EXACT_BUDGET_MS, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const title = boundedString(body?.title, MAX_TITLE_LENGTH) ?? '';
    const author = boundedString(body?.author, MAX_AUTHOR_LENGTH) ?? '';
    if (!title) {
      return NextResponse.json({ error: 'missing title', code: 'MISSING_TITLE' }, { status: 400 });
    }
    const { userId } = access.principal;
    await access.run(ensureSchema);
    const sql = getSql();

    // 1) 本地书库：免费即时，命中就不再打豆瓣。
    const rows = await access.run(async () =>
      exactLibraryBooksForUserQuery(sql, userId, title, author)) as unknown as LibraryRow[];
    if (rows.length > 0) {
      const response: ExactResponse = { source: 'library', items: rows.map(toLibraryItem) };
      return NextResponse.json(response);
    }

    // 2) 豆瓣检索。失败与「没有条目」必须分开：豆瓣挂掉时说成「没这本书」是误导。
    let candidates: DoubanCandidate[];
    try {
      candidates = await access.run(() => searchBooks(title, access.signal));
    } catch {
      // 预算到期 / 客户端断开不是「豆瓣不可达」，按既有约定升级为 504/499 上抛。
      access.assertActive();
      return NextResponse.json({
        source: 'none',
        items: [],
        unavailable: true,
        note: EXACT_UNAVAILABLE_NOTE,
      } satisfies ExactResponse);
    }
    if (candidates.length === 0) {
      return NextResponse.json({
        source: 'none',
        items: [],
        note: EXACT_DOUBAN_MISS_NOTE,
      } satisfies ExactResponse);
    }

    // 3) 可选评分（只抓前 N 个）。F10：作者输入在豆瓣阶段用于**标注**（不合的保留但
    // 标 authorMatch:false），与本地阶段行为一致；不承诺可读（readAvailability 'unknown'）。
    const queryAuthor = author ? normalizeBookAuthor(author) : '';
    const items = (await withRatings(candidates, access, MAX_RATING_LOOKUPS)).map((candidate) => ({
      ...candidate,
      metadataSource: 'douban' as const,
      authorMatch: queryAuthor === '' || normalizeBookAuthor(candidate.author) === queryAuthor,
      readAvailability: 'unknown' as const,
    }));
    return NextResponse.json({ source: 'douban', items } satisfies ExactResponse);
  });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
