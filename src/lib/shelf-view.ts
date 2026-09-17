/**
 * 书架视图的纯逻辑：同书折叠、按书名/作者过滤、两段式确认。
 * 抽成不依赖 DOM 的模块，才能在 node 环境直接测——本仓 vitest 只收 *.test.ts 且没有 jsdom。
 */
import { canonicalBookKey, normalizeBookAuthor } from './book-identity.ts';

/**
 * 书架单次最多返回的书数。与 user-data.ts 里 recommendationsForUserQuery 的
 * `LIMIT 300` 是同一个数——那一条按仓库约定写成字面量（写成参数会让
 * recommendations/route.test.ts 的 `query.values` 断言多出一个占位符），
 * 两边的一致性由 shelf-view.test.ts 的源码断言钉住。
 *
 * 注意 LIMIT 作用在 `DISTINCT ON (r.book_id)` 之后，所以单位是「本」不是「条」。
 */
export const SHELF_ROW_LIMIT = 300;

export interface ShelfRowLike {
  id: number;
  query: string;
  status: string | null;
  match_score: number | null;
  created_at: string;
  title: string;
  author: string;
}

export interface ShelfCard<T extends ShelfRowLike> {
  /** 主卡：同一本书里最新的一条推荐。 */
  master: T;
  /** 去重后的查询词，主卡在前。长度 > 1 时界面标「来自 N 次查询」。 */
  queries: string[];
}

function rowTime(row: ShelfRowLike): number {
  const time = new Date(row.created_at).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * 新旧比较：created_at 倒序 → match_score 倒序 → id 倒序。三级 tie-break 与后端
 * `DISTINCT ON (r.book_id) ... ORDER BY r.created_at DESC, r.match_score DESC, r.id DESC`
 * 同序，保证前端选出的主卡就是后端选中的那一条；否则同一份数据在两处会给出不同状态。
 */
function compareRecency(a: ShelfRowLike, b: ShelfRowLike): number {
  const byTime = rowTime(b) - rowTime(a);
  if (byTime !== 0) return byTime;
  const byScore = (b.match_score ?? 0) - (a.match_score ?? 0);
  return byScore !== 0 ? byScore : b.id - a.id;
}

function distinctQueries(rows: ShelfRowLike[]): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const row of rows) {
    const query = row.query.trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
  }
  return queries;
}

/**
 * 按书折叠：同一本书的多条推荐合成一张卡，主卡取最新一条，其余只贡献查询词。
 * 折叠键用与 books 生成列同一套归一（NFKC + btrim + 剥一层《》 + 小写），否则
 * `《X》` 与 `X` 这类历史变体会被当成两本书各占一张卡——那正是「同书重复展示」的来源。
 */
export function foldShelfItems<T extends ShelfRowLike>(rows: T[]): ShelfCard<T>[] {
  const byBook = new Map<string, T[]>();
  for (const row of rows) {
    const key = canonicalBookKey(row.title, row.author);
    const bucket = byBook.get(key);
    if (bucket) bucket.push(row);
    else byBook.set(key, [row]);
  }
  const cards: ShelfCard<T>[] = [];
  for (const bucket of byBook.values()) {
    const sorted = [...bucket].sort(compareRecency);
    cards.push({ master: sorted[0], queries: distinctQueries(sorted) });
  }
  // 卡片之间同样按新旧排，避免折叠后顺序随 Map 插入序漂移。
  return cards.sort((a, b) => compareRecency(a.master, b.master));
}

/**
 * 搜索用的宽松书名键：在 NFKC + btrim + 小写之外，再无条件剥掉首尾的《与》。
 *
 * canonicalBookKey 只剥**成对**的一层书名号，这对书籍身份是对的（《《x》》 不能多剥），
 * 但对搜索词不成立：用户敲的常常只有半边——「《红楼」「红楼梦》」都指《红楼梦》。
 * 所以匹配时两侧都过这一个函数，而不是只处理「书名自带书名号」那一种形态。
 */
function looseSearchKey(value: string): string {
  return normalizeBookAuthor(value).replace(/^《+/, '').replace(/》+$/, '');
}

/**
 * 命中书名或作者其一即可。空关键词返回全部。
 * 书名与关键词都过 looseSearchKey，两侧同一套归一才有对称性。
 */
function matchTargets(row: ShelfRowLike): string[] {
  return [looseSearchKey(row.title), normalizeBookAuthor(row.author)];
}

export function filterShelfCards<T extends ShelfRowLike>(cards: ShelfCard<T>[], keyword: string): ShelfCard<T>[] {
  // 只有书名号的词（如「《」）宽松归一后是空串，此时退回字面匹配，别把它当成空搜索。
  const needle = looseSearchKey(keyword) || normalizeBookAuthor(keyword);
  if (!needle) return cards;
  return cards.filter((card) => matchTargets(card.master).some((target) => target.includes(needle)));
}

export const CLEAR_NEW_TARGET = 'clear:new';

export function removeTarget(id: number): string {
  return `remove:${id}`;
}

export interface ConfirmStep {
  armed: string | null;
  fire: boolean;
}

/** 两段式确认：同一目标再点一次才放行；换目标只重新武装，不放行。 */
export function nextConfirm(armed: string | null, target: string): ConfirmStep {
  return armed === target ? { armed: null, fire: true } : { armed: target, fire: false };
}
