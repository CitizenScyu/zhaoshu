// 书源搜索键清洗（dlsearch-1026）：下载选源与在线换源的搜索词构造共用。
//
// 背景：《精灵宝钻（精装插图本）》作者「[英] J.R.R.托尔金 著，[英] 泰德·纳史密斯 图」长期
// 「暂无可用源」——书库题名带**版本注记**（（精装插图本）【全译本】(修订版)），作者串带
// **国籍前缀 + 多人协作标注**，原样发给书源搜索站全部搜不到（源站按通行书名/作者名收录）。
//
// 这里只清洗**搜索请求的词**，不动任何身份比对逻辑（sourceBookMatches / identityTitle /
// knownSourceAuthor / engineAuthorSearchPending 等另案处理）：命中后是不是「同一本书」仍由
// 详情页身份门逐字把关，清洗只是让候选能被搜出来。剥完为空一律回退原词——搜索键宁多不宁无：
// 把「有词」变成「没词」会误触发「无作者/无书名」分支。

/** 末尾成对括号段（全角/半角、圆/方/花括号可混搭开闭），内容为捕获组 1；可带尾随空白。 */
const TRAILING_BRACKET_NOTE = /[（(【[]([^（()【[\]）]*)[）)】\]]\s*$/u;

/**
 * 括号段是不是**版本注记**：出版形态/装帧/译本形态词、版次数字（2023 修订、第 2 版），
 * 或以 版/本/译/装/订/注/校 结尾的注记形词。词表刻意正向枚举而非「见括号就剥」：
 * 「三国演义（上）」的「（上）」是卷号、「多收了三五斗（农民小说选）」的括号是篇目出处，
 * 都不是版本注记，剥掉会破坏搜索与后续书名比对。
 */
const VERSION_NOTE_MARKERS
  = /精装|平装|典藏|修订|增订|全译|新译|重译|插图|纪念|珍藏|豪华|特装|普及|经典|足本|全本|未删节|青少|缩写|双语|白话|合订|重印|签名|校订|定本/i;
const isVersionNote = (content: string): boolean =>
  /\d/.test(content) || VERSION_NOTE_MARKERS.test(content) || /[版本译装订注校]$/.test(content);

/**
 * 去掉书名**末尾**的版本注记括号段（可连续多段：「书名（上）（精装版）」→「书名（上）」，
 * 卷号「（上）」不是版本注记不剥）。书名**中间**的括号内容一律不动（那是书名本体的一部分）。
 * 整串剥空（书名本身就是「（精装版）」）时返回原值 trim。
 */
export function cleanSearchTitle(title: string): string {
  const raw = title.trim();
  let value = raw;
  for (;;) {
    const match = TRAILING_BRACKET_NOTE.exec(value);
    if (!match || !isVersionNote(match[1])) break;
    value = value.slice(0, match.index).trimEnd();
  }
  return value.trim() || raw;
}

/** 国籍/地区前缀：成对括号 + 1–4 个汉字或字母（[英]（日）〔美〕[英]），后可跟空格。 */
const NATIONALITY_PREFIX = /^[（(【〔[][一-龥A-Za-z]{1,4}[）)】〕\]]\s*/u;

/** 角色词全集：独立 token 形态与附着形态共用（张三 著 / 南派三叔编著 / 泰德·纳史密斯 图）。 */
const ROLE_WORDS = '(?:等)?(?:著|编|主编|编著|编撰|选编|编译|译|译著|校注|校订|校|绘|绘图|图|注|点校|整理)';
const ROLE_TOKEN = new RegExp(`^${ROLE_WORDS}$`, 'u');
const TRAILING_ROLE = new RegExp(`${ROLE_WORDS}$`, 'u');
const TRAILING_MULTI_ROLE = /(?:等)?(?:著|主编|编著|编撰|选编|编译|译著|校注|校订|绘图|点校|整理)$/u;

/**
 * 作者搜索键：取第一个作者，剥国籍前缀与角色词。
 * - 多作者分隔：中文逗号/顿号/分号、西文逗号/分号、斜杠、空白（取第一段；段内空白再按
 *   token 细分，用于剥「[英]」「著」这类独立 token——「J.R.R.托尔金」内的点不是分隔符）。
 * - 剥完为空回退到第一段原样；整串为空返回 ''（调用方据此不做作者回退，语义不变）。
 */
export function cleanSearchAuthor(author: string): string {
  const raw = author.trim();
  if (!raw) return '';
  const first = raw.split(/[,，、;；/]/)[0].trim();
  if (!first) return raw;
  const tokens = first.split(/\s+/).filter(Boolean);
  while (tokens.length && ROLE_TOKEN.test(tokens[tokens.length - 1])) tokens.pop();
  const joined = tokens.join(' ');
  let name = joined.replace(NATIONALITY_PREFIX, '').trim();
  // 附着的角色词（无空格分隔）：多字角色词（主编/编著/校注…）与「著」（同 source-parser AUTHOR_BYLINE）照剥；其余单字角色词（编/译/图…）只在出版形态下剥
  // （有多作者分隔或国籍前缀，与 source-parser primaryPublishedAuthor 同口径），单个笔名以角色字结尾
  // （鸿蒙宏图、宏图）不削。剥完须剩 ≥2 字。
  const published = first !== raw || name !== joined;
  const stripped = name.replace(published ? TRAILING_ROLE : TRAILING_MULTI_ROLE, '').trim();
  if ([...stripped].length >= 2) name = stripped;
  return name || first || raw;
}

/** 搜索键组合：清洗后的书名与作者。下载选源、身份预检与在线换源共用同一份口径。 */
export function searchKeysOf(book: { title: string; author: string }): { title: string; author: string } {
  return { title: cleanSearchTitle(book.title), author: cleanSearchAuthor(book.author) };
}
