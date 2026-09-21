import { decodeHTML } from 'entities';
import { alternateSourceHost, validateSourceUrl, SourcePolicyError } from './source-policy';

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

export function knownSourceAuthor(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, '').toLocaleLowerCase();
  return ['', '佚名', '未知', '未知作者'].includes(normalized) ? '' : normalized;
}

export function sourceBookMatches(expected: SourceBookIdentity, actual: SourceBookIdentity): boolean {
  const title = normalizeSourceTitle(expected.title);
  // 站点可能把书上架为新名而在简介里自报原名（【原书名：X】）；标题或别名任一相等即过。
  const actualTitles = [actual.title, ...(actual.alias ? [actual.alias] : [])].map(normalizeSourceTitle);
  const author = knownSourceAuthor(expected.author);
  return Boolean(title && actualTitles.includes(title)
    && (!author || author === knownSourceAuthor(actual.author)));
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
  const expected = normalizeSourceTitle(expectedTitle);
  if (!expected) return Number.POSITIVE_INFINITY;
  const candidates = [candidate.title, ...(candidate.alias ? [candidate.alias] : [])].map(normalizeSourceTitle);
  let best = Number.POSITIVE_INFINITY;
  for (const actual of candidates) {
    if (!actual) continue;
    if (actual === expected) best = Math.min(best, 0);
    if (stripTitleDecorations(actual) === stripTitleDecorations(expected)) best = Math.min(best, 1);
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
  const author = meta.get('og:novel:author') ?? '';
  return { title, author, ...parseSourceAlias(html) };
}

// 站点在简介里自报的改名标记（book15 实测：「小说简介:【原书名：我有一座恐怖屋】…」）。
// 只认成对括号包裹的「原书名」，容错全半角括号/冒号/空白；X 归一化后作为别名存储。
const ALIAS_PATTERN = /[【[(]\s*原书名\s*[:：]\s*([^【\][()（）\n]{1,200}?)[】\])）]/;

export function parseSourceAlias(html: string): Pick<SourceBookIdentity, 'alias'> {
  const matched = ALIAS_PATTERN.exec(plainText(html));
  const alias = matched ? normalizeSourceTitle(matched[1]) : '';
  return alias ? { alias } : {};
}

export function sourceSearchUrl(template: unknown, title: string, base: string): string {
  if (typeof template !== 'string' || template.length > 2048 || !/\{\{key\}\}/.test(template)) {
    throw new SourcePolicyError('书源缺少支持的搜索模板');
  }
  // Only plain GET URLs are supported. Never evaluate Legado JavaScript or headers.
  const expanded = template.replace(/\{\{key\}\}/g, encodeURIComponent(title)).replace(/\{\{page\}\}/g, '1');
  if (/[{}]|@js:|<js>|,\s*\[/i.test(expanded)) throw new SourcePolicyError('不支持该书源的动态搜索规则');
  return validateSourceUrl(expanded, base).href;
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
    const url = validateSourceUrl(href, pageUrl);
    if (DETAIL_PATH.test(url.pathname)) urls.add(url.href);
  }
  return [...urls];
}

// 详情页候选收集(标题搜索 0 命中时的同页兜底 + 作者搜索回退):只按链接形态取详情页,不看锚文本相等。
// 误配防线不在这一层,而在详情页的 sourceBookMatches 身份校验(标题/别名 + 作者门)。
export const MAX_SOURCE_DETAIL_LINKS = 24;
// 三道过滤缺一不可:
// 1) 单个解析不下来的锚点只跳过、不抛。book15 每张页面上都有 11-13 个 `javascript:`
//    与跨站(百度 / 自家 m.* 手机站)链接;基线实现会在第一个这样的锚点上抛
//    SourcePolicyError,把整条候选收集打死 —— 这正是「搜索页有结果却 0 候选」的机制之一。
// 2) 锚文本/title/alt 里出现过期望书名的链接排在前。站点把「图片链接 + 标题链接 + 阅读小说链接」
//    三份重复指向同一详情页,标题链接常排在整页中后段;这个顺序保证上游 inspect 的
//    MAX_DETAIL_CANDIDATES 切片够得到真正相关的那些。比较用 sourceTitleSimilarity(与上游
//    模糊层同源判据)而不是子串测试:短书名做子串测试会把无关的近邻误判进来。
// 3) 其余同站详情页按文档序接在后(站点改版 / 锚文本带修饰时的最后一道兜底)。
// 上限 MAX_SOURCE_DETAIL_LINKS:站点在大页面上吐出几十条链接时不得把预算摊薄。

export function parseSourceDetailLinks(html: string, pageUrl: string, expectedTitle?: string): string[] {
  const expected = expectedTitle ? normalizeSourceTitle(expectedTitle) : '';
  const titleMatches: string[] = [];
  const others: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = attributes(match[1]);
    const href = tag.href;
    if (!href) continue;
    const url = validateSourceUrl(href, pageUrl);
    if (!DETAIL_PATH.test(url.pathname) || !sameSite(url, pageUrl) || seen.has(url.href)) continue;
    seen.add(url.href);
    // 锚文本里的书名可能只写在 title/alt 属性里(图片链接的锚文本为空),三者都喂给判据。
    const anchor = `${plainText(match[2])} ${tag.title ?? ''} ${tag.alt ?? ''}`.trim();
    if (expected && sourceTitleSimilarity(expected, { title: anchor, author: '' }) === 0) titleMatches.push(url.href);
    else others.push(url.href);
  }
  return [...titleMatches, ...others].slice(0, MAX_SOURCE_DETAIL_LINKS);
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
