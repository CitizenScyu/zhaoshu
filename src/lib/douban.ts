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

async function fetchWithTimeout(url: string, ms = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
  } finally {
    clearTimeout(timer);
  }
}

// 用书名+作者在豆瓣找对应条目（网文多为实体书条目，标题形如"诡秘之主 1"）
async function searchSuggest(title: string): Promise<SuggestItem[]> {
  const res = await fetchWithTimeout(
    `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`,
  );
  if (!res.ok) {
    throw new Error(`suggest ${res.status}`);
  }
  return (await res.json()) as SuggestItem[];
}

async function fetchSubjectRating(doubanId: string) {
  const res = await fetchWithTimeout(`https://book.douban.com/subject/${doubanId}/`);
  if (!res.ok) {
    throw new Error(`subject ${res.status}`);
  }
  const html = await res.text();
  const rating = html.match(/rating_num"[^>]*>([\d.]+)</)?.[1];
  const count = html.match(/(\d+)人评价/)?.[1];
  return {
    rating: rating ? parseFloat(rating) : null,
    ratingCount: count ? parseInt(count, 10) : null,
  };
}

function pickMatch(items: SuggestItem[], title: string, author?: string): SuggestItem | null {
  if (items.length === 0) return null;
  // 优先：标题前缀匹配（"诡秘之主 1" 匹配 "诡秘之主"）+ 作者匹配
  const authorOk = (it: SuggestItem) =>
    !author || !it.author_name || it.author_name.includes(author) || author.includes(it.author_name);
  const prefix = (it: SuggestItem) =>
    it.title === title || it.title.startsWith(title) || it.title.includes(title);
  return items.find((it) => prefix(it) && authorOk(it)) ?? items.find(prefix) ?? null;
}

export async function verifyBook(title: string, author?: string): Promise<DoubanInfo> {
  try {
    const items = await searchSuggest(title);
    const match = pickMatch(items, title, author);
    if (!match) {
      return { found: false, note: '豆瓣无对应条目（常见于未出版网文，不代表书不存在）' };
    }
    const doubanId = match.id;
    try {
      const { rating, ratingCount } = await fetchSubjectRating(doubanId);
      return {
        found: true,
        doubanId,
        rating,
        ratingCount,
        url: `https://book.douban.com/subject/${doubanId}/`,
      };
    } catch {
      // 详情页被拦（数据中心 IP 可能 403）：条目存在就算验证通过
      return { found: true, doubanId, url: `https://book.douban.com/subject/${doubanId}/`, note: '详情页暂不可达，未取到评分' };
    }
  } catch {
    return { found: false, note: '豆瓣接口不可达，本轮未验证' };
  }
}

// 并发受限地验证一批书（豆瓣对高频不友好，限制在 3）
export async function verifyBatch(
  books: { title: string; author?: string }[],
): Promise<DoubanInfo[]> {
  const results: DoubanInfo[] = new Array(books.length).fill(null).map(() => ({ found: false }));
  const CONCURRENCY = 3;
  let next = 0;
  async function worker() {
    while (next < books.length) {
      const i = next++;
      results[i] = await verifyBook(books[i].title, books[i].author);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, books.length) }, worker));
  return results;
}
