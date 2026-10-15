// authbridge42：作者名回退轮的候选整形与身份门（选源器 / 身份预检 / 下载腿三处共用一份，保证同源同判）。
//
// 为什么需要它：QQ 系书在免费镜像站按**通行书名**收录（队列名「少年羽皇」vs 站名「帝临鸿蒙」），
// 书名搜索天然失配 —— 这是下载队列 0 候选率 96.6% 的结构性根因。作者名是可靠桥接键（qqmirror42
// 出网实测作者名搜索 5/6 命中），但同作者往往多本书，命中后不能凭搜索结果认领。
//
// B′ 门（主会话 2026-10-15 裁定）：**作者门逐字对上** 且 **作者轮候选按 bookUrl 去重后恰好 1 条**。
// - 唯一性是排除「同作者多本」的唯一结构性约束：shidaxiaoshuo 搜「魏风华」返回 3 本诡事录系列，
//   没有书名证据时无法区分认哪一本，错配一本比 0 命中坏得多。
// - 唯一候选但详情页作者门也过不了 ⇒ 直接判不命中，不放行。
// - 不放宽 sourceBookMatches/identityMatches（下载器、预检、浏览器端共用）：这里只判作者，
//   书名对不上的问题由唯一性约束兜住。

import { knownSourceAuthor, normalizeSourceTitle } from './source-parser';
import { foldTraditional } from './zh-variant-fold';

/** 与 sourceBookMatches 作者门同一套归一：字段修饰剥离 + 一对一繁简折叠，只吸收「同一个名字的不同写法」。 */
function authorKey(value: string | null | undefined): string {
  return foldTraditional(knownSourceAuthor(value ?? ''));
}

/**
 * 作者名回退轮的**搜索键**。归一后为空（作者缺失/佚名/未知）时返回 ''，调用方据此不触发；
 * 作者与书名归一后同键时同样返回 '' —— 否则等于把同一个搜索原样再发一遍，白花一次出网。
 * 与阅读侧 source-reader 的 engineAuthorSearchPending 同判据；选源器、预检、下载腿共用这一份。
 */
export function authorSearchKey(title: string, author: string | null | undefined): string {
  const key = authorKey(author);
  return key && key !== foldTraditional(normalizeSourceTitle(title)) ? key : '';
}

/**
 * 作者轮候选按 bookUrl 去重：搜索返回**条目数**含无关条目与同一本书的重复链接（镜像站常把一本书挂
 * 书名/图片/阅读三条），那是噪声口径；bookUrl 去重才是结构口径（主会话 2026-10-15 裁定）。
 * 保持搜索原序，畸形条目（无 bookUrl）直接丢。
 */
export function authorBridgeCandidates<T extends { bookUrl?: string }>(hits: T[] | null | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const hit of hits ?? []) {
    const url = hit?.bookUrl;
    if (typeof url !== 'string' || !url || seen.has(url)) continue;
    seen.add(url);
    out.push(hit);
  }
  return out;
}

/** 作者门：详情页作者与任务作者归一后逐字相等；任务作者归一后为空（缺失/佚名/未知）时恒不过。 */
export function authorBridgeMatches(detail: { author?: string } | null | undefined, task: { author?: string }): boolean {
  const expected = authorKey(task?.author);
  return !!expected && authorKey(detail?.author) === expected;
}

/** B′ 门整体：候选去重后恰好 1 条，且该候选详情页作者门逐字对上。 */
export function authorBridgeAccepts<T extends { bookUrl?: string }>(
  candidates: T[], detail: { author?: string } | null | undefined, task: { author?: string },
): boolean {
  return candidates.length === 1 && authorBridgeMatches(detail, task);
}
