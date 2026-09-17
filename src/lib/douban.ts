import type { DoubanInfo } from './types';

// 豆瓣是唯一的外部验证源：低频、带浏览器 UA、失败降级为"未验证"

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

interface SuggestItem {
  title: string;
  url: string;
  author_name: string;
  id: string;
}

async function fetchWithTimeout<T>(
  url: string,
  consume: (response: Response) => Promise<T>,
  ms = 12_000,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(url, {
      signal: combined,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    // Headers do not finish a fetch: keep the timeout until JSON/text is read.
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

// 调用方预算（deadline.signal）到期应升级为失败（超时/取消），不能降级为"未验证但条目存在"。
// 具体判断直接看 signal.aborted，不带共享状态。

async function searchSuggest(title: string, signal?: AbortSignal): Promise<SuggestItem[]> {
  return fetchWithTimeout(
    `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`,
    (response) => response.json() as Promise<SuggestItem[]>,
    12_000,
    signal,
  );
}

// 精确找书（task-77）用到的检索原语。与 verifyBook 的区别是**用途**：
// verifyBook 问「用户说的这本书是不是这本」（pickMatch 单条择一），
// searchBooks 问「叫这个名字的东西有哪些」（全部返回，同名书让用户自己挑）。
export interface DoubanCandidate {
  doubanId: string;
  title: string;
  author: string;
  doubanUrl: string;
}

// 建议接口正常情况下返回个位数；截断只为兜住异常响应，语义上不丢「同名书」。
const MAX_BOOK_SEARCH_RESULTS = 10;

// subject_suggest 是外部不可信数据：id 必须是纯数字才能拼进详情页 URL
// （否则响应里的任意字符串会变成我们发出去的请求路径），标题必须有内容。
function isSuggestItem(value: unknown): value is SuggestItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<SuggestItem>;
  return typeof item.id === 'string' && /^\d+$/.test(item.id) &&
    typeof item.title === 'string' && item.title.trim().length > 0;
}

export async function searchBooks(title: string, signal?: AbortSignal): Promise<DoubanCandidate[]> {
  const raw: unknown = await searchSuggest(title, signal);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSuggestItem).slice(0, MAX_BOOK_SEARCH_RESULTS).map((item) => ({
    doubanId: item.id,
    title: item.title.trim(),
    author: typeof item.author_name === 'string' ? item.author_name.trim() : '',
    // URL 由校验过的数字 id 拼出，不用响应里给的 url（外部数据不直接进前端 href）。
    doubanUrl: `https://book.douban.com/subject/${item.id}/`,
  }));
}

// 评分标记形如 <strong ... class="rating_num " property="v:average"> 8.5 </strong>,值两侧可能有空白
export function parseRating(html: string): number | null {
  const rating = html.match(/rating_num[^>]*>\s*([\d.]+)\s*</)?.[1];
  return rating ? parseFloat(rating) : null;
}

// 人数标记形如 <span property="v:votes">2617</span>人评价(数字与文字跨标签)
export function parseVotes(html: string): number | null {
  const count = html
    .match(/property="v:votes">\s*([\d,，]+)\s*</)?.[1]
    ?.replace(/[,，]/g, '');
  return count ? parseInt(count, 10) : null;
}

// 导出给精确找书按需取评分（只抓候选详情页，不做存在性判定）。
// 注意调用方：这里抛错就是「详情页没拿到」，不代表条目不存在——判定在 verifyBook 里。
export async function fetchSubjectRating(doubanId: string, signal?: AbortSignal) {
  const html = await fetchWithTimeout(`https://book.douban.com/subject/${doubanId}/`, (response) => response.text(), 12_000, signal);
  return {
    rating: parseRating(html),
    ratingCount: parseVotes(html),
  };
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s·•《》「」『』【】()（）\[\]：:，,。.!！?？'"“”‘’_-]/g, '');
}

function pickMatch(items: SuggestItem[], title: string, author?: string): SuggestItem | null {
  if (items.length === 0) return null;
  const wantedTitle = normalize(title);
  const wantedAuthor = author ? normalize(author) : '';
  const titleOk = (it: SuggestItem) => {
    const candidate = normalize(it.title);
    return candidate === wantedTitle || candidate.startsWith(wantedTitle);
  };
  const authorOk = (it: SuggestItem) => {
    if (!wantedAuthor) return true;
    const candidate = normalize(it.author_name || '');
    return Boolean(candidate) && (candidate.includes(wantedAuthor) || wantedAuthor.includes(candidate));
  };
  // 作者已知时不能降级为“只看标题”，否则同名书会被当成已验证。
  return items.find((it) => titleOk(it) && authorOk(it)) ?? null;
}

export async function verifyBook(
  title: string,
  author?: string,
  signal?: AbortSignal,
): Promise<DoubanInfo> {
  try {
    const items = await searchSuggest(title, signal);
    const match = pickMatch(items, title, author);
    if (!match) {
      return {
        status: 'not_found',
        found: false,
        note: '豆瓣无对应条目（常见于未出版网文，不代表书不存在）',
      };
    }
    const doubanId = match.id;
    try {
      const { rating, ratingCount } = await fetchSubjectRating(doubanId, signal);
      return {
        status: 'verified',
        found: true,
        doubanId,
        rating,
        ratingCount,
        url: `https://book.douban.com/subject/${doubanId}/`,
      };
    } catch (e) {
      // 预算耗尽不是"详情页被拦"：预算到期必须停，不能降级为"已验证"继续
      if (signal?.aborted) throw e;
      // 详情页被拦（数据中心 IP 可能 403）：条目存在就算验证通过
      return {
        status: 'verified',
        found: true,
        doubanId,
        url: `https://book.douban.com/subject/${doubanId}/`,
        note: '详情页暂不可达，未取到评分',
      };
    }
  } catch (e) {
    // 调用方预算耗尽 / 用户取消不是「豆瓣接口不可达」：把**中止的原始原因**上抛
    // （signal.reason：deadline 耗尽是 DeadlineExceededError，用户取消是 AbortError），
    // 由调用方按自己的语义分类。落成 unavailable 会把「找书预算耗尽」伪装成「豆瓣挂了」，
    // 而且会把上层（内层 catch 的 throw、以及本 catch 的 throw）变成死代码。
    //
    // 判据只看**调用方的 signal**，不看 error 的名字：这里有**两个 abort 源**——
    //   ① 调用方预算（signal，经 fetchWithTimeout 的 AbortSignal.any 合并）；
    //   ② 本模块自己的 12s 单请求超时（fetchWithTimeout 内部的 controller）。
    // 两者抛的都是 AbortError，但只有 ① 是「预算耗尽/取消」；② 是真正的「豆瓣不可达」，
    // 必须继续降级为「本轮未验证」（否则一次豆瓣抖动会被误报成请求取消）。
    if (signal?.aborted) throw signal.reason ?? e;
    return { status: 'unavailable', found: false, note: '豆瓣接口不可达，本轮未验证' };
  }
}

// 并发受限地验证一批书（豆瓣对高频不友好，限制在 3）。
// 传入预算 signal：预算耗尽即停止新增探测（signal.abort 后 worker 不再领新任务）。
// ⚠️ 契约：在飞的那本若因 signal 中止而失败，verifyBook 会**上抛中止原因**（不再降级成
// 「本轮未验证」），于是本函数整体 reject——调用方据此分清「预算耗尽/已取消」与「豆瓣不可达」。
// 未领到的项不会出现在结果里（本函数的返回只对「正常跑完」有意义）。
// onProgress 每完成一本回调一次（供找书 SSE 实时上报验证进度）。
export async function verifyBatch(
  books: { title: string; author?: string }[],
  signal?: AbortSignal,
  onProgress?: (done: number) => void,
): Promise<DoubanInfo[]> {
  const results: DoubanInfo[] = new Array(books.length).fill(null).map(() => ({
    status: 'unavailable',
    found: false,
    note: '尚未验证',
  }));
  const CONCURRENCY = 3;
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < books.length) {
      if (signal?.aborted) {
        // 未探测的项绝不能当作"已恢复"；预算耗尽后停表为外部不可达（本轮未验证）
        break;
      }
      const i = next++;
      results[i] = await verifyBook(books[i].title, books[i].author, signal);
      completed += 1;
      try { onProgress?.(completed); } catch { /* 进度回调不阻断验证 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, books.length) }, worker));
  // 中止若恰好落在「两本之间」（上一本已成功、下一本还没领），worker 只 break 不抛，
  // 这里补一次同样的上抛：契约必须一致——调用方拿到「中止」还是「一批本轮未验证」，
  // 不能取决于中止落在哪一瞬间。
  if (signal?.aborted) throw signal.reason ?? new Error('豆瓣验证已中止');
  return results;
}
