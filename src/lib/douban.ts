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

// 豆瓣条目标题是不是「同一本书」的完整标题：形如《书名:副标题》。副标题（《人类简史：从动物到上帝》）
// 属于同一本书的全名；而《X2》《X · 外传》《X 前传》是另一本书，靠分隔符区分——
// 只有显式的书名号分隔（半/全角冒号）才认，裸拼接和「·」都不认。
// 注意 rawTitle 是规范化前的原文：normalize 会把分隔符抹掉，抹掉后就再也分不清这两类了。
function isFullTitleOf(rawTitle: string, wantedTitle: string): boolean {
  const segments = rawTitle.split(/[:：]/);
  return segments.length > 1 && normalize(segments[0]) === wantedTitle;
}

function pickMatch(items: SuggestItem[], title: string, author?: string): SuggestItem | null {
  if (items.length === 0) return null;
  const wantedTitle = normalize(title);
  const wantedAuthor = author ? normalize(author) : '';
  const authorOk = (it: SuggestItem) => {
    if (!wantedAuthor) return true;
    const candidate = normalize(it.author_name || '');
    return Boolean(candidate) && (candidate.includes(wantedAuthor) || wantedAuthor.includes(candidate));
  };
  // 作者已知时不能降级为“只看标题”，否则同名书会被当成已验证。
  // 两档都要求标题**完整**落在候选上，不给续篇留口子：
  //   1) 规范化后完全相等；2) 候选是「书名:副标题」的全名。
  // 不用 candidate.startsWith(wantedTitle)：那会把《诡秘之主2》《诡秘之主 · 外传》
  // 判成《诡秘之主》已验证，把另一本书的评分和链接挂到用户书上。
  // 精确档优先于副标题档，避免正条目被「书名 1」这类衍生条目抢先命中。
  const exactTitle = (it: SuggestItem) => normalize(it.title) === wantedTitle;
  const fullTitle = (it: SuggestItem) => isFullTitleOf(it.title, wantedTitle);
  return (
    items.find((it) => exactTitle(it) && authorOk(it)) ??
    items.find((it) => fullTitle(it) && authorOk(it)) ??
    null
  );
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
  } catch {
    return { status: 'unavailable', found: false, note: '豆瓣接口不可达，本轮未验证' };
  }
}

// 并发受限地验证一批书（豆瓣对高频不友好，限制在 3）。
// 传入预算 signal：预算耗尽即停止新增探测（signal.abort 后 worker 不再领新任务）。
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
  return results;
}
