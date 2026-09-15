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

async function fetchSubjectRating(doubanId: string, signal?: AbortSignal) {
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
  } catch {
    return { status: 'unavailable', found: false, note: '豆瓣接口不可达，本轮未验证' };
  }
}

// 并发受限地验证一批书（豆瓣对高频不友好，限制在 3）。
// 传入预算 signal：预算耗尽即停止新增探测（signal.abort 后 worker 不再领新任务）。
export async function verifyBatch(
  books: { title: string; author?: string }[],
  signal?: AbortSignal,
): Promise<DoubanInfo[]> {
  const results: DoubanInfo[] = new Array(books.length).fill(null).map(() => ({
    status: 'unavailable',
    found: false,
    note: '尚未验证',
  }));
  const CONCURRENCY = 3;
  let next = 0;
  async function worker() {
    while (next < books.length) {
      if (signal?.aborted) {
        // 未探测的项绝不能当作"已恢复"；预算耗尽后停表为外部不可达（本轮未验证）
        break;
      }
      const i = next++;
      results[i] = await verifyBook(books[i].title, books[i].author, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, books.length) }, worker));
  return results;
}
