import { decodeHTML } from 'entities';
import { alternateSourceHost, checkSourceUrl, upgradeSourceTemplateUrl, validateSourceUrl, SourcePolicyError } from './source-policy';
import { encodeQueryComponent, normalizeCharset, percentEncodeChars, type SourceCharset } from './source-charset';
import { foldTraditional } from './zh-variant-fold';
import { gsonAsString, gsonPlainInteger, gsonPrettyJson, parseGsonLenient, type GsonValue } from './gson-lenient';
import { engineSearchOptionsEnabled, engineSearchWebViewEnabled } from './rule-engine/syntax-flags';

export interface SourceBookIdentity { title: string; author: string; alias?: string }
export interface SourceChapter { url: string; title: string }
export const MAX_SOURCE_CHAPTERS = 10_000;
export const MAX_SOURCE_CHAPTER_CHARACTERS = 32_768;

export function normalizeSourceTitle(value: string): string {
  return value.normalize('NFKC').trim().replace(/^《(.+)》$/, '$1').replace(/\s+/gu, '').toLocaleLowerCase();
}

// ---- 章节标题对齐(换源与正文校验共用) ----
// 章节标题比书名更易漂移:同一本书在别的书源上常被写成「第1章」/「第 1 章」/「第一章」,
// 站点也可能改写尾部标点或省略章号。折叠层只吸收这些**同义写法**,底限不变:完全无关的章不得匹配。
const CHAPTER_MARKER = /^第([零〇一二三四五六七八九十百千万两\d]+)([章节回卷篇部集])/u;
const CHAPTER_TAIL = /[.。、,;:;:!！??·…~—-]+$/u;
const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「第N章」纯序数标题的最长归一化长度(两位数,如「第12章」);短于此长度的标题不做包含档。 */
const ORDINAL_ONLY_LENGTH = '第12章'.length;

/** 章号量级的中文数字→阿拉伯数字(支持「十/十二/二十三/一百零五/两千」);非章号写法返回 null。 */
function chapterNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of value) {
    const digit = CN_DIGITS[char];
    if (digit !== undefined) { current = digit; continue; }
    if (char === '十') { section += (current || 1) * 10; current = 0; continue; }
    if (char === '百') { section += (current || 1) * 100; current = 0; continue; }
    if (char === '千') { section += (current || 1) * 1000; current = 0; continue; }
    if (char === '万') { total += (section + current || 1) * 10_000; section = 0; current = 0; continue; }
    return null;
  }
  return total + section + current;
}

interface ChapterKey {
  /** 折叠章号写法后的比较键:「第一章」与「第1章」同为「第1章」。 */
  key: string;
  /** 显式章号(「第N章」的 N);无章号写法时为 null。 */
  number: number | null;
  /** 去掉章号标记后的标题主体(「第1章 风起」→「风起」)。 */
  rest: string;
}

function chapterKey(value: string): ChapterKey {
  const normalized = normalizeSourceTitle(value).replace(CHAPTER_TAIL, '');
  const matched = CHAPTER_MARKER.exec(normalized);
  if (!matched) return { key: normalized, number: null, rest: normalized };
  const number = chapterNumber(matched[1]);
  if (number === null) return { key: normalized, number: null, rest: normalized };
  const rest = normalized.slice(matched[0].length).replace(CHAPTER_TAIL, '');
  return { key: `第${number}${matched[2]}${rest}`, number, rest };
}

/** 章节标题归一化:标题归一化 + 章号写法折叠(「第一章」=「第1章」)+ 去尾部标点。 */
export function normalizeChapterTitle(value: string): string {
  return chapterKey(value).key;
}

/**
 * 相似档位,越小越优;Infinity = 不相似(负对照锚点:完全无关的章必须落这里)。
 * 底线:章号/主体都对不上时,只有归一化标题**互相包含且公共部分够长**才放行 ——
 * 「第一章」与「第三章」这类无公共主体的标题永远落 Infinity。
 */
function chapterTier(expected: ChapterKey, actual: ChapterKey): number {
  if (actual.key === expected.key) return 0;
  if (expected.number !== null && actual.number !== null && expected.number === actual.number) {
    if (actual.rest === expected.rest) return 1;
    // 一侧只写了章号、另一侧还带主体(「第1章」/「第1章 风起」):同章号即成立。
    if (!expected.rest || !actual.rest) return 2;
    // 同章号 + 主体互相包含(「风起」/「风起了」):章号已对齐,主体只需近似。
    if (containable(expected.rest, actual.rest, 2)) return 3;
  }
  // 键内包含:主体已参与比较(「第1章 风起」/「第一章 风起与云涌」),公共部分取 4 字下限;
  // 纯序数标题短于该下限 ⇒ 不适用(3 字标题的包含在中文里太容易凑巧)。
  return containable(expected.key, actual.key, ORDINAL_ONLY_LENGTH < expected.key.length ? 4 : 5)
    ? 4 : Number.POSITIVE_INFINITY;
}

function containable(a: string, b: string, min: number): boolean {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= min && longer.includes(shorter);
}

/** 目录里某章是否就是期望的章(标题层判据;完全无关的章为 false)。 */
export function chapterTitlesMatch(expectedTitle: string, actualTitle: string): boolean {
  return chapterTier(chapterKey(expectedTitle), chapterKey(actualTitle)) !== Number.POSITIVE_INFINITY;
}

/**
 * 在备用目录里定位期望的章,返回其下标;找不到返回 null(调用方 503)。
 * 档位:键相等 → 同章号且主体相等 → 同章号一方带主体 → 同章号且主体包含 → 键互相包含。
 * 同档多命中(重名章)不再直接失败,而是取**序号最接近** preferredIndex 的那一条。
 */
export function matchSourceChapter(chapters: SourceChapter[], expectedTitle: string, preferredIndex?: number): number | null {
  const expected = chapterKey(expectedTitle);
  const distance = (index: number) => preferredIndex === undefined ? 0 : Math.abs(index - preferredIndex);
  let bestIndex = -1;
  let bestTier = Number.POSITIVE_INFINITY;
  for (let index = 0; index < chapters.length; index++) {
    const tier = chapterTier(expected, chapterKey(chapters[index].title));
    if (tier === Number.POSITIVE_INFINITY) continue;
    if (tier < bestTier || (tier === bestTier && distance(index) < distance(bestIndex))) { bestIndex = index; bestTier = tier; }
  }
  // **不做「按目录序号兜底交付」**:备用目录里没有标题证据时,序号不构成「这是同一章」的证明,
  // 静默交付另一章比 503 更糟(用户可能读完才发现串章,且无从重试)。宁可 503 ——
  // 与「完全无关的章不得匹配」这条底线同源。
  return bestIndex >= 0 ? bestIndex : null;
}

// 作者字段里站点加的**字段外**修饰（41-swq 实测）：biquge7.xyz 详情页作者整串是「作者：木苏里」、QQ 阅读搜索行是
// 「火龙果大亨 著」、noveltri 搜索行是「@木蘇里」。只剥这几种已知形态，且剥完必须还剩名字本体——「作者」二字本身、
// 「著」单字不剥（剥成空串会把「有作者」变成「作者未知」，作者门就被绕开了）。不带冒号的「作者X」不剥：真名以「作者」
// 开头的笔名存在，冒号才是「字段标签」的证据。
const AUTHOR_LABEL = /^(?:作者:|@)(?=.)/u;
const AUTHOR_BYLINE = /^(.{2,}?)\/?著$/u;

// pubmeta1026：出版物元数据形态的作者串（打标库/QQ 书城：「[英]J.R.R.托尔金 著，[英]克里斯托弗·托尔金 编」）。
// 网文站只写笔名，比对与作者回退搜索都只能用第一作者本体。只在出现「出版形态证据」——开头国籍括注或多作者
// 分隔——时才剥 编/译/绘/图 等角色词：单个笔名以这些字结尾（「宏图」）的不动，避免把真名削短。
// 国籍括注限 1–6 个汉字（NFKC 后全角括号已折成半角）；分隔符含「著/编…」紧跟下一个国籍括注的无标点写法。
const AUTHOR_NATIONALITY = /^[[(〔【][一-鿿]{1,6}[\])〕】]/u;
const AUTHOR_SEPARATOR = /[,，、;；/&]|(?<=[著编译绘图撰])(?=[[(〔【][一-鿿]{1,6}[\])〕】])/u;
const AUTHOR_ROLE = /^(.{2,}?)(?:原著|编著|主编|编译|译著|著|编|译|绘|图|撰)$/u;

/** 出版形态作者串取第一作者本体；不是出版形态（无国籍括注、无多作者分隔）原样返回。 */
function primaryPublishedAuthor(value: string): string {
  const segments = value.split(AUTHOR_SEPARATOR).filter(Boolean);
  if (segments.length < 2 && !AUTHOR_NATIONALITY.test(value)) return value;
  const first = (segments[0] ?? value).replace(AUTHOR_NATIONALITY, '');
  const body = first.replace(AUTHOR_ROLE, '$1');
  return body || value;
}

export function knownSourceAuthor(value: string): string {
  const normalized = primaryPublishedAuthor(value.normalize('NFKC').trim().replace(/\s+/gu, '').toLocaleLowerCase()
    .replace(AUTHOR_LABEL, ''))
    .replace(AUTHOR_BYLINE, '$1');
  return ['', '佚名', '未知', '未知作者'].includes(normalized) ? '' : normalized;
}

// 书名两侧的**状态标记**（【完结】书名、书名(连载中)）不是书名本体，身份比对前剥掉。只收状态词：
// 「番外」「全集」「精品」这类可能指向另一部作品/合集的词不在其列（那是模糊层 TITLE_DECORATION 的事，留给用户确认）。
// 剥完为空（书名本身就是「【完结】」）则保留原样，空串不得与任何东西判等。
const IDENTITY_TITLE_STATUS = /[[【(](?:已?完结|全本|完本|连载中?|新书|首发|独家|免费|无删减|txt)[\]】)]/gu;
// pubmeta1026：书名尾部的**版本注记**（「精灵宝钻（精装插图本）」「百年孤独(典藏版)」「X【全译本】」）同属出版元数据，
// 不是书名本体。只剥尾部一个、以「版/本」收尾、不超过 12 字的括注。注记暗示**内容不同**时不剥：分册/续作
// （第/部/卷/册/集/上中下）、删改本（精品/精选/节选/缩写/简本/青少/少儿/改编）、换媒介（绘本/漫画/有声/剧本）、
// 番外/外传——与 IDENTITY_TITLE_STATUS 同一原则，那些交给模糊层由用户确认。
const IDENTITY_TITLE_EDITION = /[[【(]([^[\]【】()]{1,12}[版本])[\]】)]$/u;
const EDITION_VOLUME_HINT = /[第部卷册集上中下选节缩续]|精品|简本|简写|青少|少儿|儿童|改编|绘本|漫画|有声|剧本|番外|外传/u;

function stripEditionNote(title: string): string {
  const match = IDENTITY_TITLE_EDITION.exec(title);
  if (!match || EDITION_VOLUME_HINT.test(match[1])) return title;
  return title.slice(0, match.index) || title;
}

/**
 * 书源身份比对用的书名键（41-swq）：normalizeSourceTitle → 剥状态标记 → 剥尾部版本注记（pubmeta1026）→ 繁→简字形折叠。
 * 只用于「是不是同一本书」的判等，不改存储值、不进 DB 身份键（book-identity.ts 与 SQL 权威键逐字对齐）。
 */
function identityTitle(value: string): string {
  const normalized = normalizeSourceTitle(value);
  const stripped = stripEditionNote(normalized.replace(IDENTITY_TITLE_STATUS, ''));
  return foldTraditional(stripped || normalized);
}

// 复合题名「书名-作者」（41-suffix，2026-10-14）：打标书库里存在「三体Ⅲ-刘慈欣」「盗墓笔记-南派三叔」这类
// 「本体名+连字符+作者」的题名，而源站只列本体名「三体Ⅲ」。这不是两本书，两档从严降级（只在精确相等失败后）：
//   A 后缀 = expected.author（三体Ⅲ-刘慈欣/作者刘慈欣）：剥后缀比本体；
//   B 后缀 = actual.author（盗墓笔记-南派三叔，DB 作者是打标人「稻博、盗墓博物馆」）：后缀即作者证据。
// A/B 都不得与作者门冲突：源站作者在场且与任务作者、后缀都不同（作者冲突）⇒ 不放宽。A 档在源站
// 作者缺失（vikbook 形态 og:novel:author 不存在）时也放行——后缀=任务作者是显式作者证据；
// B 档在源站作者缺失时**不放行**：后缀与任务作者不一致且无第三方核对（副题反例排除不了）。
// 后缀两档都对不上（「楚留香新传1-借尸还魂」的「借尸还魂」是副题不是作者）不剥，按原严格口径。
const SUFFIX_AUTHOR_SEPARATOR = /[-—－–]/;

function splitAuthorSuffix(rawTitle: string): { body: string; suffix: string } {
  const parts = rawTitle.split(SUFFIX_AUTHOR_SEPARATOR);
  if (parts.length < 2) return { body: rawTitle, suffix: '' };
  return { body: parts.slice(0, -1).join('-'), suffix: parts[parts.length - 1].trim() };
}

export function sourceBookMatches(expected: SourceBookIdentity, actual: SourceBookIdentity): boolean {
  const author = foldTraditional(knownSourceAuthor(expected.author));
  const title = identityTitle(expected.title);
  // 站点可能把书上架为新名而在简介里自报原名（【原书名：X】）；标题或别名任一相等即过。
  const actualTitles = [actual.title, ...(actual.alias ? [actual.alias] : [])].map(identityTitle);
  // 作者门：两侧同一套归一（字段修饰剥离 + 一对一繁简折叠），只吸收「同一个名字的不同写法」，不同名字仍判不符。
  const actualAuthor = foldTraditional(knownSourceAuthor(actual.author));
  if (title && actualTitles.includes(title)) return !author || author === actualAuthor;
  if (!title) return false;
  // 41-suffix 降级：精确相等失败后，expected 是「书名-作者」复合题名时剥后缀比本体（两档从严判据见函数头）。
  const { body: rawBody, suffix } = splitAuthorSuffix(expected.title);
  const suffixKey = suffix ? foldTraditional(normalizeSourceTitle(suffix)) : '';
  const body = rawBody === expected.title ? '' : identityTitle(rawBody);
  if (suffixKey === '' || !body || body === title || !actualTitles.includes(body)) return false;
  // 作者门未冲突才能走降级（本体名对上后，唯一的排除证据就是作者冲突）：
  // 源站作者在场且 ≠ 任务作者 ⇒ 同名异书嫌疑，不放宽（副题后缀「借尸还魂」正落这里）。
  // 源站作者缺失（vikbook 无 og:novel:author）：任务作者未知「佚名」或 ≠ 后缀时，后缀提供了
  // 任务/源站都没给作者名时的唯一作者证据，本体对上即过；源站作者在场则须后缀与之一致（A/B 档）。
  if (author && actualAuthor && actualAuthor !== author && actualAuthor !== suffixKey) return false;
  if (suffixKey === author) return true;  // A：后缀即任务作者，源站作者缺失/一致都已过冲突门——后缀显式自证作者
  return suffixKey === actualAuthor; // B：后缀即源站作者。源站作者缺失不放行：后缀与任务作者都不足以单独证作者（副题反例无法排除）
}

// 组合键分隔符：NUL 不出现在归一化后的书名/作者里，避免 'a,b'+'c' 与 'a'+'b,c' 撞键。
const IDENTITY_KEY_SEPARATOR = '\u0000';

/**
 * 书源身份键（41-srcmem，「按书记住上次成功的源」用）：书名走 identityTitle（状态标记剥离 + 繁简折叠），
 * 作者走 knownSourceAuthor + 繁简折叠 —— 与 sourceBookMatches 判等**逐字同一套口径**（裁定 #3：不另起一套）。
 * 只做浏览器端记忆的稳定键，不进 DB 身份键（那条与 SQL 权威键对齐，见 book-identity.ts）。
 */
export function sourceBookIdentityKey(title: string, author: string): string {
  return `${identityTitle(title)}${IDENTITY_KEY_SEPARATOR}${foldTraditional(knownSourceAuthor(author))}`;
}

// ---- 模糊降级层（L3）的相似度判据 ----
// 从宽但有底线：完全无关的书（共享字符太少、既不包含也不近似）不得进入候选。
// 分值越小越靠前；Number.POSITIVE_INFINITY 表示「不相似，淘汰」。
const MIN_CONTAINMENT_LENGTH = 4;
const MAX_EDIT_DISTANCE = 2;
// 编辑距离档的最短书名门（R1）：2-3 字书名（活着/边城/三体）在距离 ≤2 内的近邻太多，
// 全是无关书；两侧都达到该长度才允许用距离判相似，短名只走相等/去修饰/包含档。
const MIN_EDIT_DISTANCE_TITLE_LENGTH = 4;

// 去副标题/书名号等修饰后再比较：「书名（精品版）」「书名：修订版」→「书名」。
function stripTitleDecorations(value: string): string {
  return value.replace(/[（(][^（()）]*[）)]/gu, '').replace(/[:：].*$/u, '').replace(/[·\s]/gu, '');
}
// 「修饰」= 站点加在书名**之外**的状态标记（【完结】书名、书名(全本)），不是书名的一部分。
// 只剥**已知修饰词**的成对包裹。**不能**见成对符号就剥：那样会把书名本体吃掉，或把不同书剥成
// 同一串（`[全本]余生` 与 `[典藏]余生` 都成 `余生`），造出假的「档位 1 = 书名直接对上」，
// 进而在 parseSourceDetailLinks 里把无关详情页提权进 MAX_DETAIL_CANDIDATES 切片（40 任审查 B）。
// 与上面的副标题剥离同属「书名字面之外的修饰」这一层语义。
// 开闭字符类含 ASCII 方括号(`[全本]测试书`):`normalizeSourceTitle` 先做 NFKC,全角 `[]`(U+FF3B/U+FF3D)
// 已折成 ASCII,故此处只需 ASCII `[` `]` 即可一并覆盖全角写法。
const TITLE_DECORATION = /[[【《〈「(](?:完结|全本|完本|全集|精品|推荐|热门|连载|新书|免费|首发|独家|番外|无删减|已完结|txt|TXT)[\]】》〉」)]/gu;
function stripTitleWrappers(value: string): string {
  return value.replace(TITLE_DECORATION, '');
}
// 书名**本体**就是修饰词、或修饰词被外层括号再包一层时(【全集】、`【[全本]】`),
// `stripTitleWrappers` 剥完会只剩空串或**纯括号残壳**(`【】`)。空串/纯括号都不是「书名本体」,
// 二者相等只说明「都没剩下东西」,不是「书名对上」。此时退回「只去括号、保留词本体」的形态:
//   【全集】→「全集」、`【[全本]】`→「全本」、`【】`→「」(真无内容,仍不匹配)。
// 这样《全集》↔【全集】、【[全本]】↔全本仍判档位 1,而【全集】↔【番外】、【[全本]】↔【[完结]】不判。
const TITLE_BRACKETS = /[\]\[【】《》〈〉「」()]/gu;
function stripTitleBrackets(value: string): string {
  return value.replace(TITLE_BRACKETS, '');
}
/** 档位 1 比较用的「书名本体」:剥完修饰后,空串或纯括号残壳一律退回剥括号的形态。 */
function titleBody(value: string): string {
  const stripped = stripTitleWrappers(stripTitleDecorations(value));
  return stripped !== '' && stripTitleBrackets(stripped) !== '' ? stripped : stripTitleBrackets(value);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * 期望书名 vs 候选（书名或别名任一）的相似档位。
 * 0 = 精确相等（含别名）；1 = 去副标题/书名号后相等；2 = 归一化互相包含；
 * 3 = 编辑距离 ≤2（两侧均 ≥4 字才启用）；Infinity = 不相似（负对照锚点：完全无关的书必须落这里）。
 */
export function sourceTitleSimilarity(expectedTitle: string, candidate: SourceBookIdentity): number {
  // 繁简字形折叠（41-swq）：与 sourceBookMatches 同一张表，繁体站上的同名书在模糊层同样按「书名相等」排档。
  const foldTitle = (value: string) => foldTraditional(normalizeSourceTitle(value));
  const expected = foldTitle(expectedTitle);
  if (!expected) return Number.POSITIVE_INFINITY;
  const candidates = [candidate.title, ...(candidate.alias ? [candidate.alias] : [])].map(foldTitle);
  let best = Number.POSITIVE_INFINITY;
  for (const actual of candidates) {
    if (!actual) continue;
    if (actual === expected) best = Math.min(best, 0);
    // 档位 1 比较「书名本体」:剥完修饰与括号残壳后的主体相等才算「书名对上」。空/纯括号残壳不进档位 1。
    const bodyActual = titleBody(actual);
    const bodyExpected = titleBody(expected);
    if (bodyActual !== '' && bodyActual === bodyExpected) best = Math.min(best, 1);
    const shorter = actual.length < expected.length ? actual : expected;
    const longer = actual.length < expected.length ? expected : actual;
    if (shorter.length >= MIN_CONTAINMENT_LENGTH && longer.includes(shorter)) best = Math.min(best, 2);
    if (actual.length >= MIN_EDIT_DISTANCE_TITLE_LENGTH && expected.length >= MIN_EDIT_DISTANCE_TITLE_LENGTH
      && editDistance(actual, expected) <= MAX_EDIT_DISTANCE) best = Math.min(best, 3);
  }
  return best;
}

function plainText(html: string): string {
  return decodeHTML(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]+>/g, ''))
    .replace(/\u0000/g, '').trim();
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
    .map((match) => [match[1].toLowerCase(), decodeHTML(match[3])]));
}

export function parseSourceIdentity(html: string): SourceBookIdentity {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs.property && attrs.content) meta.set(attrs.property.toLowerCase(), attrs.content.trim());
  }
  const title = meta.get('og:novel:book_name') ?? plainText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
  const author = meta.get('og:novel:author') || itempropAuthorOf(html) || '';
  return { title, author, ...parseSourceAlias(html) };
}

// schema.org 微数据作者（vikbook 形态：itemprop 在外层 span 上，链接文本才是署名）。
// 匹配顺序：1) a 自身带 itemprop；2) itemprop=author 元素块内第一个 <a> 文本（400 字符窗口防误收）；
// 3) itemprop=author 元素自身的 title 属性（「作者：X」）。标签前缀「作者：」留给 knownSourceAuthor 比对时剥。
export function itempropAuthorOf(html: string): string {
  return (plainText(/<a\b[^>]*itemprop=["']author["'][^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1] ?? ''))
    || (plainText(/<[^>]*itemprop=["']author["'][^>]*>[\s\S]{0,400}?<a\b[^>]*>([^<]*)<\/a>/i.exec(html)?.[1] ?? ''))
    || (/<[^>]*itemprop=["']author["'][^>]*title=["']([^"']*)["']/i.exec(html)?.[1] ?? '');
}

// 站点在简介里自报的改名标记（book15 实测：「小说简介:【原书名：我有一座恐怖屋】…」）。
// 只认成对括号包裹的「原书名」，容错全半角括号/冒号/空白；X 归一化后作为别名存储。
const ALIAS_PATTERN = /[【[(]\s*原书名\s*[:：]\s*([^【\][()（）\n]{1,200}?)[】\])）]/;

export function parseSourceAlias(html: string): Pick<SourceBookIdentity, 'alias'> {
  const matched = ALIAS_PATTERN.exec(plainText(html));
  const alias = matched ? normalizeSourceTitle(matched[1]) : '';
  return alias ? { alias } : {};
}

/**
 * 搜索请求的 host 门校验器：与 checkSourceUrl 同签名（validateSourceUrl=运行时白名单门，
 * validateAdmissionUrl=准入声明门，allowAnyHost=候选阶段放开 host 白名单但仍守 https/端口/userinfo/IP 红线）。
 */
export type SourceUrlValidator = (value: unknown, base?: string) => URL;

export function sourceSearchUrl(
  template: unknown, title: string, base: string | undefined, validate: SourceUrlValidator = validateSourceUrl,
): string {
  if (typeof template !== 'string' || template.length > 2048 || !/\{\{key\}\}/.test(template)) {
    throw new SourcePolicyError('书源缺少支持的搜索模板');
  }
  // Only plain GET URLs are supported. Never evaluate Legado JavaScript or headers.
  const expanded = template.replace(/\{\{key\}\}/g, encodeURIComponent(title)).replace(/\{\{page\}\}/g, '1');
  if (/[{}]|@js:|<js>|,\s*\[/i.test(expanded)) throw new SourcePolicyError('不支持该书源的动态搜索规则');
  // 写死 http:// 的模板（站点同 host 有 https）升级后再过锁；host/端口/路径逐字不变（41-urlfix）。
  return validate(upgradeSourceTemplateUrl(expanded), base).href;
}

/** 候选/准入阶段用：放开 host 白名单，但仍守 https/端口/userinfo/IP 红线（41-admpost F1）。
 *  写成 function 声明而非 module-scope 箭头常量：Turbopack 16.3.5 会因「模块顶层箭头常量体里
 *  调用 import 进来的函数」而把本模块误判进浏览器 chunking、在 `next build` 处 panic
 *  （Failed to write app endpoint /page：does not support external modules node:async_hooks）。
 *  语义与箭头常量完全一致，仅规避该 codegen 缺陷（41-mergeap 实测）。 */
function allowAnyHost(value: unknown, base?: string): URL {
  return checkSourceUrl(value, base, { hostAllowed: () => true });
}

// ---- legado searchUrl `url,{options}` 选项支持（41-postsearch，仅在 ENGINE_POST_SEARCH 开时走） ----
export type SourceSearchMethod = 'GET' | 'POST';
export interface SourceSearchRequest {
  url: string;
  method: SourceSearchMethod;
  /** POST body（已按 charset 展开 {{key}}；GBK 字节化在发请求层做）。 */
  body?: string;
  /** 白名单请求头（Content-Type / Referer / User-Agent）。 */
  headers?: Record<string, string>;
  /** 归一后的请求/响应字符集，缺省 utf-8。 */
  charset: SourceCharset;
}

const SEARCH_OPTION_KEYS = new Set(['method', 'body', 'charset', 'headers']);
// 仅允许的安全请求头（小写匹配）；其余静默丢弃，绝不透传 Cookie/Authorization 等。
const ALLOWED_REQUEST_HEADERS = new Set(['content-type', 'referer', 'user-agent']);

/** 受限容错 JSON：先严格解析，失败再把单引号整体换双引号重试；仍失败返回 null（判不支持，不崩）。 */
function parseSearchOptions(raw: string): Record<string, unknown> | null {
  for (const candidate of [raw, raw.replace(/'/g, '"')]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* 试下一形态 */ }
  }
  return null;
}

// 禁 JS：@js:/<js>/java.* 一律拒（本引擎从不 eval）。
function rejectJs(text: string): void {
  if (/@js:|<js>|\bjava\./i.test(text)) throw new SourcePolicyError('不支持该书源的动态搜索规则（禁 JS）');
}
// 展开后仍残留 {{ / }} = 未支持的模板变量（如 {{(page-1)*10}}、{{java.xxx}}）→ 拒，不 eval。
function rejectUnexpanded(text: string): void {
  if (/\{\{|\}\}/.test(text)) throw new SourcePolicyError('不支持该书源的搜索模板变量');
}

// JSON body（以 { 或 [ 起）里 {{key}} 原样替换（整体在发请求层按 charset 字节化）；
// 表单 body 与 URL 里的 {{key}} 按 charset 百分号编码。{{page}} 恒替为 1（不支持翻页表达式）。
function expandField(text: string, title: string, charset: SourceCharset, jsonBody: boolean): string {
  const key = jsonBody ? title : encodeQueryComponent(title, charset);
  return text.replace(/\{\{key\}\}/g, key).replace(/\{\{page\}\}/g, '1');
}

/**
 * 把 searchUrl 解析为结构化搜索请求（GET/POST + body + 白名单头 + charset）。
 * 无 `,{options}` 时等价于 sourceSearchUrl（纯 GET）。红线：不 eval JS；最终 URL 过同一把
 * validateSourceUrl（host 白名单 / https / 非 IP / 无 userinfo / 443），POST 不放宽 host 门；
 * 设备指纹字段（imei/udid 等字面量）原样当模板文本发送，不生成、不伪造。
 */
export function buildSourceSearchRequest(
  template: unknown, title: string, base: string | undefined, validate: SourceUrlValidator = validateSourceUrl,
  optionParity = searchOptionsActive(),
): SourceSearchRequest {
  try {
    return buildDeclaredSearchRequest(template, title, base, validate);
  } catch (error) {
    if (!optionParity || !(error instanceof SourcePolicyError) || typeof template !== 'string'
      || !legacyOptionParityApplies(template)) throw error;
    // searchopt1028：旧口径因选项被拒 → 按 legado UrlOption 口径重读选项，其余流程（展开/红线/白名单头）与旧口径同一段代码。
    // legado 先替换 {{key}}/{{page}} 再解析选项：书名以私用区占位进 GSON（裸串里与常见书名同为字面字符），读完还原。
    const optMatch = /,\s*\{/.exec(template)!;
    const optionText = template.slice(optMatch.index + 1).replace(/\{\{key\}\}/g, OPTION_KEY_MARK).replace(/\{\{page\}\}/g, '1');
    return searchRequestFromOptions(
      template.slice(0, optMatch.index), legadoUrlOption(optionText, OPTION_KEY_MARK), title, base, validate,
    );
  }
}

/** searchopt1028 实际生效：与 compile-smoke engineSearchOptionsActive 同口径（须 ENGINE_POST_SEARCH 同开）。 */
function searchOptionsActive(): boolean {
  const postSearch = process.env.ENGINE_POST_SEARCH;
  return (postSearch === '1' || postSearch === 'true') && engineSearchOptionsEnabled();
}

function buildDeclaredSearchRequest(
  template: unknown, title: string, base: string | undefined, validate: SourceUrlValidator,
): SourceSearchRequest {
  if (typeof template !== 'string' || template.length > 2048 || !/\{\{key\}\}/.test(template)) {
    throw new SourcePolicyError('书源缺少支持的搜索模板');
  }
  const head = template.split('##')[0];
  const optMatch = /,\s*\{/.exec(head);
  if (!optMatch) return { url: sourceSearchUrl(template, title, base, validate), method: 'GET', charset: 'utf-8' };

  const urlPart = head.slice(0, optMatch.index);
  const options = parseSearchOptions(head.slice(optMatch.index + 1));
  if (!options) throw new SourcePolicyError('不支持该书源的搜索选项（非法 JSON）');
  for (const key of Object.keys(options)) {
    if (!SEARCH_OPTION_KEYS.has(key)) throw new SourcePolicyError(`不支持该书源的搜索选项：${key}`);
  }
  return searchRequestFromOptions(urlPart, options, title, base, validate);
}

/** 旧口径 `url,{选项}` 的展开与校验（选项已解析成对象、键已过白名单）。 */
function searchRequestFromOptions(
  urlPart: string, options: Record<string, unknown>, title: string, base: string | undefined, validate: SourceUrlValidator,
): SourceSearchRequest {
  let charset: SourceCharset = 'utf-8';
  if (options.charset != null) {
    const normalized = normalizeCharset(options.charset);
    if (!normalized) throw new SourcePolicyError('不支持该书源的搜索字符集');
    charset = normalized;
  }
  const method = String(options.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new SourcePolicyError(`不支持该书源的搜索方法：${method}`);

  rejectJs(urlPart);
  const url = expandField(urlPart, title, charset, false);
  rejectUnexpanded(url);
  const finalUrl = validate(upgradeSourceTemplateUrl(url), base).href;
  const request: SourceSearchRequest = { url: finalUrl, method: method as SourceSearchMethod, charset };

  let jsonBody = false;
  if (options.body != null) {
    if (typeof options.body !== 'string') throw new SourcePolicyError('不支持该书源的搜索 body');
    rejectJs(options.body);
    jsonBody = /^\s*[{[]/.test(options.body);
    const body = expandField(options.body, title, charset, jsonBody);
    rejectUnexpanded(body);
    request.body = body;
  }
  if (options.headers != null) {
    if (typeof options.headers !== 'object' || Array.isArray(options.headers)) {
      throw new SourcePolicyError('不支持该书源的搜索 headers');
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.headers as Record<string, unknown>)) {
      if (typeof v !== 'string' || !ALLOWED_REQUEST_HEADERS.has(k.toLowerCase())) continue; // 非白名单头丢弃
      rejectJs(v);
      headers[k] = v.replace(/\{\{key\}\}/g, encodeQueryComponent(title, charset)).replace(/\{\{page\}\}/g, '1');
    }
    if (Object.keys(headers).length) request.headers = headers;
  }
  applyDefaultContentType(request, options.charset, jsonBody);
  return request;
}

/**
 * POST 有 body 却没声明 Content-Type 时补默认头（postct42）。body 以字节发出，fetch 不会自动加 CT，
 * 站点（多为 PHP）拿不到 `$_POST`、当空搜索返回无结果页；legado 客户端会自己补，DB 里的源普遍不声明。
 * 表单 body → `application/x-www-form-urlencoded`，JSON body（以 { 或 [ 起，与 expandField 同判据）→
 * `application/json`；源声明了 charset 就带 `; charset=<声明值>`（声明值已过 normalizeCharset，只可能是已知别名）。
 * 源显式声明的 CT（任何大小写）一律不覆盖；GET、无 body 的 POST 不加。准入与运行时都经 buildSourceSearchRequest，一处生效。
 */
function applyDefaultContentType(request: SourceSearchRequest, declaredCharset: unknown, jsonBody: boolean): void {
  if (request.method !== 'POST' || !request.body) return;
  if (request.headers && Object.keys(request.headers).some((k) => k.toLowerCase() === 'content-type')) return;
  const type = jsonBody ? 'application/json' : 'application/x-www-form-urlencoded';
  const charset = typeof declaredCharset === 'string' ? `; charset=${declaredCharset.trim()}` : '';
  request.headers = { ...request.headers, 'Content-Type': `${type}${charset}` };
}

/**
 * 候选/准入口径（41-admpost F1）：该 searchUrl 能否构造出搜索请求。判据与运行时 `buildSourceSearchRequest`
 * **完全同源**（同一函数、同样的展开/rejectUnexpanded/类型校验/红线），只把 host 白名单放开为 allow-any——
 * 候选阶段运行时 host 白名单尚未就绪，host 检查交给准入滤网2（validateAdmissionUrl）与运行时门（validateSourceUrl）。
 * 用占位书名判「模板能否展开」（{{cookie}} 等展不开一律 false），故与真实书名无关。仅在 ENGINE_POST_SEARCH 开时用于
 * selectCandidates 的放开分支；关时候选仍走 searchIsPureGet（默认行为逐字不变）。
 */
const CANDIDATE_PROBE_TITLE = '书';
export function searchOptionsConstructible(template: unknown, base: string): boolean {
  try {
    buildSourceSearchRequest(template, CANDIDATE_PROBE_TITLE, base, allowAnyHost);
    return true;
  } catch (error) {
    if (error instanceof SourcePolicyError) return false;
    throw error;
  }
}

// ---- searchopt1028：legado AnalyzeUrl.UrlOption 口径的选项（仅 ENGINE_SEARCH_OPTIONS 开、且旧口径因选项被拒时用） ----

/** 选项文本里 {{key}} 的占位（私用区字符；模板本身含它则不走新口径）。 */
const OPTION_KEY_MARK = '\uE000';
const LEGADO_INT_FIELDS = ['retry', 'webViewDelayTime'] as const;
const LEGADO_REJECT_FIELDS = ['js', 'type', 'serverID'] as const;

/** 旧口径（parseSearchOptions + 键白名单 + 逐项类型校验）会因选项本身拒掉这段选项文本。 */
function legacyOptionsRejected(raw: string): boolean {
  const options = parseSearchOptions(raw);
  if (!options) return true;
  if (Object.keys(options).some((key) => !SEARCH_OPTION_KEYS.has(key))) return true;
  if (options.charset === '') return true;
  const method = String(options.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return true;
  if (options.headers != null && (typeof options.headers !== 'object' || Array.isArray(options.headers))) return true;
  return options.body != null && typeof options.body !== 'string';
}

/** 旧口径模板（无 JS/页码表达式/`##`）且其 `,{选项}` 被旧口径拒：新口径接手的全部条件。 */
function legacyOptionParityApplies(template: string): boolean {
  if (template.length > 2048 || !/\{\{key\}\}/.test(template)) return false;
  if (template.includes('##') || template.includes(OPTION_KEY_MARK)) return false;
  if (SEARCH_JS_MARKER.test(template) || /<.*?>/.test(template)) return false;
  const optMatch = /,\s*\{/.exec(template);
  return optMatch !== null && legacyOptionsRejected(template.slice(optMatch.index + 1));
}

/**
 * 该 searchUrl 是否会因 ENGINE_SEARCH_OPTIONS 而换请求口径（语义版本位与闸门共用，纯静态）：旧口径模板的选项被旧口径拒，
 * 或 JS 模板（searchTemplateNeedsJs）的静态选项文本被旧口径拒（求值后的选项多半同形；宁宽勿漏，只多翻 revision）。
 */
export function searchOptionsNeedParity(template: unknown, base: string): boolean {
  if (typeof template !== 'string') return false;
  if (legacyOptionParityApplies(template)) return true;
  if (!searchTemplateNeedsJs(template, base)) return false;
  const split = LEGADO_OPTION_SPLIT.exec(template);
  return split !== null && legacyOptionsRejected(template.slice(split.index + split[0].length));
}

/**
 * searchwv1028：searchOptionsNeedParity 为真的模板，其选项是否可能让 webView 为真（语义版本位用，纯静态）。
 * 旧口径模板按 GSON 宽松读顶层 webView（headers 等嵌套里的同名键不算）；JS 模板看不到求值结果，只有每处 `webView`
 * 都是字面假值（false/"false"/""/null）才判否（宁宽勿漏，只多翻 revision）。
 */
export function searchOptionsMayUseWebView(template: unknown): boolean {
  if (typeof template !== 'string') return false;
  if (legacyOptionParityApplies(template)) {
    const optMatch = /,\s*\{/.exec(template)!;
    const optionText = template.slice(optMatch.index + 1).replace(/\{\{key\}\}/g, OPTION_KEY_MARK).replace(/\{\{page\}\}/g, '1');
    const parsed = parseGsonLenient(optionText);
    if (!parsed || parsed.kind !== 'object') return false;
    const webView = gsonAsString(parsed.entries.get('webView'));
    return webView !== null && webView !== '' && webView !== 'false';
  }
  const total = template.match(/webView(?!DelayTime)/g)?.length ?? 0;
  const falsy = template.match(/webView['"]?\s*:\s*(?:false|null|'false'|"false"|''|"")\s*[,}]/g)?.length ?? 0;
  return total > falsy;
}

/**
 * legado UrlOption 口径读选项文本，归一成两条旧管线都认的形状（method 仅 POST / charset 串 / headers 串值对象 / body 串）：
 * GSON 宽松读不出或不是对象 → 选项整段忽略（legado 按 GET 请求 url 部分）；未知键、origin/webJs 忽略；
 * method 只认 POST（不分大小写）；空 charset 视同未声明；headers 为对象或 JSON 串（值走 toString）；
 * POST 的对象/数组 body 按 GSON pretty 序列化。webView 为真（ENGINE_SEARCH_WEBVIEW 开时改为仅配非空 webJs 才拒）、
 * js/type/serverID 非 null、整数字段非整数（legado 整段读失败）、重复键、白名单头的值不是串/整数/布尔、口径不定的 body 一律拒。
 * keyMark：选项文本里代替 {{key}} 的占位，读完还原。
 */
function legadoUrlOption(raw: string, keyMark?: string): Record<string, unknown> {
  const parsed = parseGsonLenient(raw);
  if (!parsed || parsed.kind !== 'object') return {};
  if (parsed.duplicate) throw new SourcePolicyError('不支持该书源的搜索选项（重复键）');
  const restore = (text: string): string => (keyMark ? text.split(keyMark).join('{{key}}') : text);
  const field = (key: string): GsonValue | undefined => parsed.entries.get(key);
  for (const key of LEGADO_REJECT_FIELDS) {
    if (gsonAsString(field(key)) !== null) throw new SourcePolicyError(`不支持该书源的搜索选项：${key}`);
  }
  const webView = gsonAsString(field('webView'));
  if (webView !== null && webView !== '' && webView !== 'false') {
    // searchwv1028：开关开时 webView 当普通请求（webJs 会在页面里执行、取到的结果不同，仍拒）。
    if (!engineSearchWebViewEnabled()) throw new SourcePolicyError('不支持该书源的搜索选项：webView');
    const webJs = gsonAsString(field('webJs'));
    if (webJs !== null && webJs.trim() !== '') throw new SourcePolicyError('不支持该书源的搜索选项：webJs');
  }
  for (const key of LEGADO_INT_FIELDS) {
    const v = field(key);
    if (v === undefined || v.kind === 'null') continue;
    const ok = v.kind === 'number' ? gsonPlainInteger(v) && Math.abs(Number(v.raw)) <= 0x7fffffff
      : v.kind === 'string' && /^-?\d{1,9}$/.test(v.value);
    if (!ok) throw new SourcePolicyError(`不支持该书源的搜索选项：${key}`);
  }

  const options: Record<string, unknown> = {};
  const method = gsonAsString(field('method'));
  if (method !== null && method.toUpperCase() === 'POST') options.method = 'POST';
  const charset = gsonAsString(field('charset'));
  if (charset !== null && charset !== '') {
    if (charset === 'escape') throw new SourcePolicyError('不支持该书源的搜索字符集');
    options.charset = charset;
  }

  let headerValue = field('headers');
  if (headerValue?.kind === 'string') {
    headerValue = parseGsonLenient(headerValue.value) ?? undefined;
    if (headerValue?.kind === 'object' && headerValue.duplicate) throw new SourcePolicyError('不支持该书源的搜索 headers');
  }
  if (headerValue?.kind === 'object') {
    const headers: Record<string, string> = {};
    for (const [rawName, v] of headerValue.entries) {
      const name = restore(rawName);
      const allowed = ALLOWED_REQUEST_HEADERS.has(name.toLowerCase());
      let text: string | null = null;
      if (v.kind === 'string') text = v.value;
      else if (v.kind === 'boolean') text = String(v.value);
      else if (v.kind === 'number' && gsonPlainInteger(v)) text = v.raw;
      if (text === null) {
        if (allowed) throw new SourcePolicyError('不支持该书源的搜索 headers');
        continue;
      }
      if (allowed) headers[name] = restore(text);
    }
    if (Object.keys(headers).length) options.headers = headers;
  }

  const body = field('body');
  if (options.method === 'POST' && body !== undefined && body.kind !== 'null') {
    if (body.kind === 'string') {
      options.body = restore(body.value);
    } else if (body.kind === 'object' || body.kind === 'array') {
      const json = gsonPrettyJson(body);
      if (json === null) throw new SourcePolicyError('不支持该书源的搜索 body');
      options.body = restore(json);
    } else {
      throw new SourcePolicyError('不支持该书源的搜索 body');
    }
  }
  return options;
}

// ---- searchjs1027：legado AnalyzeUrl 口径的搜索模板（仅 ENGINE_SEARCH_JS 开时经 rule-engine/search-js.ts 走） ----
// 这里只放纯函数（本模块进客户端包）：JS 求值在服务端 search-js.ts，求值后的 ruleUrl 交给 buildLegadoSearchRequest。

/** 新路径接收的 searchUrl 上限（JS 模板比纯 URL 长，与规则 JS 上限同量级）。 */
export const MAX_SEARCH_JS_TEMPLATE_LENGTH = 8192;
const SEARCH_JS_MARKER = /@js:|<js>|\{\{(?!(?:key|page)\}\})/i;

/**
 * 该 searchUrl 是否要走 legado JS 求值路径：旧口径（buildSourceSearchRequest）构造不出请求，且模板里有 `@js:`/`<js>`
 * 或 `{{key}}`/`{{page}}` 以外的 `{{表达式}}`。纯静态判断（不执行 JS），供语义版本位与新路径闸门共用——
 * 旧口径能构造的模板永远不进新路径，开关开时这些源的请求逐字不变。
 */
export function searchTemplateNeedsJs(template: unknown, base: string): boolean {
  if (typeof template !== 'string' || template.length > MAX_SEARCH_JS_TEMPLATE_LENGTH) return false;
  if (!SEARCH_JS_MARKER.test(template)) return false;
  return !searchOptionsConstructible(template, base);
}

// legado NetworkUtils.notNeedEncodingQuery / notNeedEncodingForm 与 AnalyzeUrl.queryEncoder
// （RFC3986.UNRESERVED + `!$%&()*+,/:;=?@[\]^\`{|}`；`%` 安全，已有的 %XX 不重编）。
const LEGADO_QUERY_PLAIN = /[A-Za-z0-9!$&()*+,\-./:;=?@[\\\]^_`{|}~]/;
const LEGADO_FORM_PLAIN = /[A-Za-z0-9*\-._]/;
const LEGADO_QUERY_ENCODER_SAFE = /[A-Za-z0-9\-._~!$%&()*+,/:;=?@[\\\]^`{|}]/;
const HEX = /[0-9A-Fa-f]/;
const LEGADO_OPTION_SPLIT = /\s*,\s*(?=\{)/;

/** legado encodedQuery/encodedForm：只含安全字符与合法 %XX 即视为已编码（`i + 2 < length` 的边界照抄）。 */
function legadoAlreadyEncoded(text: string, plain: RegExp): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (plain.test(c)) continue;
    if (c === '%' && i + 2 < text.length && HEX.test(text[i + 1]) && HEX.test(text[i + 2])) {
      i += 2;
      continue;
    }
    return false;
  }
  return true;
}

/** legado AnalyzeUrl.encodeParams(isQuery=false)：按 & / = 切，逐段未编码（或声明了 charset）则 URLEncoder.encode。 */
function legadoEncodeForm(body: string, charset: SourceCharset, checkEncoded: boolean): string {
  const encode = (part: string) => (checkEncoded && legadoAlreadyEncoded(part, LEGADO_FORM_PLAIN)
    ? part : percentEncodeChars(part, charset, (ch) => LEGADO_FORM_PLAIN.test(ch), true));
  const out: string[] = [];
  let pos = 0;
  while (pos <= body.length) {
    let amp = body.indexOf('&', pos);
    if (amp === -1) amp = body.length;
    const eq = body.indexOf('=', pos);
    out.push(eq === -1 || eq > amp
      ? encode(body.slice(pos, amp))
      : `${encode(body.slice(pos, eq))}=${encode(body.slice(eq + 1, amp))}`);
    pos = amp + 1;
  }
  return out.join('&');
}

const legadoIsJson = (text: string): boolean => {
  const t = text.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
};
const legadoIsXml = (text: string): boolean => {
  const t = text.trim();
  return t.startsWith('<') && t.endsWith('>');
};

/**
 * 已完成 JS/`{{…}}`/页码替换的 legado ruleUrl → 结构化搜索请求（legado AnalyzeUrl.analyzeUrl 口径）：
 * 在首个 `\s*,\s*(?=\{)` 处切选项；选项键白名单与旧口径相同（webView/js/webJs 等照旧拒；optionParity 时改按 legadoUrlOption 重读）；method 仅 POST（不分大小写）
 * 为 POST、其余字符串记 GET；空白 charset 视同未声明。GET 查询串未编码时按 queryEncoder 编码（已有 %XX 保留）；
 * POST 表单 body（非 JSON/XML 且未声明 `Content-Type` 头）逐段 URLEncoder 编码，未声明 charset 时已编码段原样。
 * 最终 URL 过同一把 validate（https/端口/userinfo/IP 红线不变）。
 */
export function buildLegadoSearchRequest(
  ruleUrl: string, base: string | undefined, validate: SourceUrlValidator = validateSourceUrl, optionParity = false,
): SourceSearchRequest {
  if (ruleUrl.length > MAX_SEARCH_JS_TEMPLATE_LENGTH) throw new SourcePolicyError('书源搜索地址过长');
  const split = LEGADO_OPTION_SPLIT.exec(ruleUrl);
  const urlPart = (split ? ruleUrl.slice(0, split.index) : ruleUrl).trim();
  rejectUnexpanded(urlPart);
  const optionText = split ? ruleUrl.slice(split.index + split[0].length) : undefined;
  try {
    return legadoRequestFromOptions(urlPart, declaredLegadoOptions(optionText), base, validate);
  } catch (error) {
    // searchopt1028：旧选项口径拒了 → 按 legado UrlOption 口径重读（调用方只在 searchOptionsNeedParity 的源上开）。
    if (!optionParity || optionText === undefined || !(error instanceof SourcePolicyError)) throw error;
    return legadoRequestFromOptions(urlPart, legadoUrlOption(optionText), base, validate);
  }
}

function declaredLegadoOptions(optionText: string | undefined): Record<string, unknown> {
  let options: Record<string, unknown> = {};
  if (optionText !== undefined) {
    const parsed = parseSearchOptions(optionText);
    if (!parsed) throw new SourcePolicyError('不支持该书源的搜索选项（非法 JSON）');
    options = parsed;
  }
  for (const key of Object.keys(options)) {
    if (!SEARCH_OPTION_KEYS.has(key)) throw new SourcePolicyError(`不支持该书源的搜索选项：${key}`);
  }
  return options;
}

function legadoRequestFromOptions(
  ruleUrlPart: string, options: Record<string, unknown>, base: string | undefined, validate: SourceUrlValidator,
): SourceSearchRequest {
  let urlPart = ruleUrlPart;
  let declaredCharset: string | undefined;
  if (options.charset != null) {
    if (typeof options.charset !== 'string') throw new SourcePolicyError('不支持该书源的搜索字符集');
    if (options.charset.trim()) declaredCharset = options.charset;
  }
  let charset: SourceCharset = 'utf-8';
  if (declaredCharset !== undefined) {
    const normalized = normalizeCharset(declaredCharset);
    if (!normalized) throw new SourcePolicyError('不支持该书源的搜索字符集');
    charset = normalized;
  }
  if (options.method != null && typeof options.method !== 'string') throw new SourcePolicyError('不支持该书源的搜索方法');
  const method: SourceSearchMethod = typeof options.method === 'string' && options.method.toUpperCase() === 'POST' ? 'POST' : 'GET';
  let rawHeaders: Record<string, unknown> | undefined;
  if (options.headers != null) {
    if (typeof options.headers !== 'object' || Array.isArray(options.headers)) {
      throw new SourcePolicyError('不支持该书源的搜索 headers');
    }
    rawHeaders = options.headers as Record<string, unknown>;
  }

  if (method === 'GET') {
    const q = urlPart.indexOf('?');
    if (q !== -1) {
      const query = urlPart.slice(q + 1);
      if (!legadoAlreadyEncoded(query, LEGADO_QUERY_PLAIN)) {
        urlPart = urlPart.slice(0, q + 1) + percentEncodeChars(query, charset, (ch) => LEGADO_QUERY_ENCODER_SAFE.test(ch));
      }
    }
  }
  const finalUrl = validate(upgradeSourceTemplateUrl(urlPart), base).href;
  const request: SourceSearchRequest = { url: finalUrl, method, charset };

  let jsonBody = false;
  if (method === 'POST' && options.body != null) {
    if (typeof options.body !== 'string') throw new SourcePolicyError('不支持该书源的搜索 body');
    let body = options.body;
    rejectUnexpanded(body);
    jsonBody = legadoIsJson(body);
    const declaredType = rawHeaders !== undefined && typeof rawHeaders['Content-Type'] === 'string' && rawHeaders['Content-Type'] !== '';
    if (body.trim() && !jsonBody && !legadoIsXml(body) && !declaredType) {
      body = legadoEncodeForm(body, charset, declaredCharset === undefined);
    }
    if (body.trim()) request.body = body;
  }
  if (rawHeaders) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v !== 'string' || !ALLOWED_REQUEST_HEADERS.has(k.toLowerCase())) continue; // 非白名单头丢弃
      // OkHttp 拒非 ASCII/控制字符的头值（legado 同样发不出去），{{key}} 原样展开进头的 CJK 书名在此拒。
      if (/[^\x20-\x7e\t]/.test(v)) throw new SourcePolicyError('不支持该书源的搜索 headers');
      headers[k] = v;
    }
    if (Object.keys(headers).length) request.headers = headers;
  }
  applyDefaultContentType(request, declaredCharset, jsonBody);
  return request;
}

/** 详情页链接形态:book15 的 `/books/details<数字>.html`。候选收集的两条路径共用同一 grammar。 */
const DETAIL_PATH = /^\/books\/details\d+\.html$/;

/**
 * 链接必须落在同一站点根内(同 origin,或同站备用 host 的 origin)。
 * 判定走 URL 解析后的 origin,而不是 raw href 字符串 —— 站点改版把绝对 URL 写全即
 * `https://book15.net/books/details1.html` 时,形态不变但 href 不再以 `/` 开头。
 * 这是**收窄**而非放宽:book15 三类页面上实测的跨站链接只有百度与自家 m.* 手机站,
 * 全部被拦;真正的 host 白名单仍是 validateSourceUrl。
 */
function sameSite(url: URL, pageUrl: string): boolean {
  let base: URL;
  try { base = new URL(pageUrl); } catch { return false; }
  if (url.origin === base.origin) return true;
  const alternate = alternateSourceHost(base.hostname.toLowerCase());
  return alternate !== null && url.origin === `https://${alternate}`;
}

export function parseSourceSearch(html: string, pageUrl: string, title: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attributes(match[1]).href;
    if (!href || normalizeSourceTitle(plainText(match[2])) !== normalizeSourceTitle(title)) continue;
    // 与 parseSourceDetailLinks 同口径:单个解析不下来/跨站的锚点只跳过,不把整源打死。
    let url: URL;
    try { url = validateSourceUrl(href, pageUrl); } catch { continue; }
    if (!sameSite(url, pageUrl) || !DETAIL_PATH.test(url.pathname)) continue;
    urls.add(url.href);
  }
  return [...urls];
}

// 详情页候选收集(标题搜索 0 命中时的同页兜底 + 作者搜索回退):只按链接形态取详情页(同站 + 详情 URL 形态)。
// 误配防线不在这一层,而在详情页的 sourceBookMatches 身份校验(标题/别名 + 作者门)。
//
// 两道过滤缺一不可:
// 1) 单个解析不下来的锚点只跳过、不抛。book15 每张页面上都有 11-13 个 `javascript:`
//    与跨站(百度 / 自家 m.* 手机站)链接;基线实现会在第一个这样的锚点上抛
//    SourcePolicyError,把整条候选收集打死 —— 这正是「搜索页有结果却 0 候选」的机制之一。
// 2) 同站(同 origin 或同站备用 host)才算数。
// 排序:锚文本/title/alt 能对上期望书名的排在前(按相似档位升序,同档保持文档序)—— 站点把
// 「图片链接 + 标题链接 + 阅读小说链接」三份重复指向同一详情页,标题链接常排在整页中后段;
// 这个顺序保证上游 inspect 的 MAX_DETAIL_CANDIDATES 切片够得到真正相关的那些。
// 排序只是顺序,不是过滤器:站点改版 / 锚文本带修饰时对不上的那些按文档序接在后面,
// 仍走同一套详情页身份校验(常见的「带修饰」形态落档位 1,与精确相等同属最相关一档)。
// 上限 MAX_SOURCE_DETAIL_LINKS:站点在大页面上吐出几十条链接时不得把预算摊薄。
export const MAX_SOURCE_DETAIL_LINKS = 24;

export function parseSourceDetailLinks(html: string, pageUrl: string, expectedTitle?: string): string[] {
  const expected = expectedTitle ? normalizeSourceTitle(expectedTitle) : '';
  const ranked: { href: string; rank: number; order: number }[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = attributes(match[1]);
    const href = tag.href;
    if (!href) continue;
    // 单个锚点解析不下来 ≠ 整页没有候选:javascript: 与跨站链接(book15 每页 11-13 个)只跳过。
    let url: URL;
    try { url = validateSourceUrl(href, pageUrl); } catch { continue; }
    if (!DETAIL_PATH.test(url.pathname) || !sameSite(url, pageUrl) || seen.has(url.href)) continue;
    seen.add(url.href);
    // 书名的出处有三处:锚文本、title 属性、图片 alt(图片链接的锚文本为空)。三者**分别**判,
    // 取最相关的一档 —— 拼成一个串再比会把「锚文本与 title 都是书名」变成「测试书测试书」而全丢。
    // 判据出处:模糊降级层(L3)的 sourceTitleSimilarity —— 精确相等/别名 = 0,去副标题与书名号 = 1。
    // 这两档才算「标题直接对上」;包含/编辑距离档(2/3)不足以说明「这一页就是这本书」,不提前。
    const anchors = [plainText(match[2]), tag.title ?? '', tag.alt ?? ''].filter(Boolean);
    let rank = 2;
    for (const anchor of anchors) {
      if (!expected) { rank = 0; break; }
      rank = Math.min(rank, sourceTitleSimilarity(expected, { title: anchor, author: '' }));
      if (rank === 0) break;
    }
    ranked.push({ href: url.href, rank: Math.min(rank, 2), order: ranked.length });
  }
  return ranked.sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_SOURCE_DETAIL_LINKS)
    .map((entry) => entry.href);
}

export function parseSourceChapters(html: string, pageUrl: string): SourceChapter[] {
  const bookId = /^\/books\/details(\d+)\.html$/.exec(validateSourceUrl(pageUrl).pathname)?.[1];
  if (!bookId) throw new SourcePolicyError('不支持的书籍详情地址');
  const chapters: SourceChapter[] = [];
  const seen = new Set<string>();
  // Same <dd> directory / chapter URL grammar as the download worker.
  for (const match of html.matchAll(/<dd\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attributes(match[1]).href;
    if (!href) continue;
    const url = validateSourceUrl(href, pageUrl);
    const chapterBookId = /^\/chapter\/index(\d+)-\d+\.html$/.exec(url.pathname)?.[1];
    if (!chapterBookId) continue;
    if (chapterBookId !== bookId) throw new SourcePolicyError('目录包含其他书籍的章节');
    const title = plainText(match[2]);
    if (!title || title.length > 200 || seen.has(url.href)) continue;
    seen.add(url.href);
    chapters.push({ url: url.href, title });
    if (chapters.length > MAX_SOURCE_CHAPTERS) throw new SourcePolicyError('章节目录过大');
  }
  return chapters;
}

export function parseSourceChapterText(html: string, expectedTitle?: string): string {
  // Anchor to the actual content <li>, excluding menus, ads and navigation.
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  // 与目录对齐同用一套折叠判据(「第1章」=「第一章」);完全无关的标题仍然拒绝。
  if (expectedTitle && heading && !chapterTitlesMatch(expectedTitle, plainText(heading))) {
    throw new SourcePolicyError('章节标题与目录不符');
  }
  const segment = [...html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)]
    .find((match) => attributes(match[1]).class?.split(/\s+/).includes('chapter-content'))?.[2];
  if (!segment) throw new SourcePolicyError('未找到章节正文容器');
  const paragraphs = [...segment.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => plainText(match[1]).replace(/[(（]本章完[)）]\s*$/, '').trim())
    .filter((text) => text && !/^.{2,12}完整目录$|^请记住本书首发域名|^\d{6,}\.?$/.test(text));
  const text = paragraphs.join('\n');
  if (!text || /章节错误|请联系管理员|最新章节请到/.test(text)) throw new SourcePolicyError('书源未提供有效正文');
  if (text.length > MAX_SOURCE_CHAPTER_CHARACTERS) throw new SourcePolicyError('单章过长，请尝试下载全书');
  return text;
}
