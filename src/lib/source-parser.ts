import { decodeHTML } from 'entities';
import { validateSourceUrl, SourcePolicyError } from './source-policy';

export interface SourceBookIdentity { title: string; author: string; alias?: string }
export interface SourceChapter { url: string; title: string }
export const MAX_SOURCE_CHAPTERS = 10_000;
export const MAX_SOURCE_CHAPTER_CHARACTERS = 32_768;

export function normalizeSourceTitle(value: string): string {
  return value.normalize('NFKC').trim().replace(/^《(.+)》$/, '$1').replace(/\s+/gu, '').toLocaleLowerCase();
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

export function parseSourceSearch(html: string, pageUrl: string, title: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attributes(match[1]).href;
    if (!href || normalizeSourceTitle(plainText(match[2])) !== normalizeSourceTitle(title)) continue;
    const url = validateSourceUrl(href, pageUrl);
    if (/^\/books\/details\d+\.html$/.test(url.pathname)) urls.add(url.href);
  }
  return [...urls];
}

// 作者搜索回退的候选收集：不看锚文本（改名书的锚文本是站点新名），只按链接形态取详情页。
// 误配防线不在这一层，而在详情页的 sourceBookMatches 身份校验（标题/别名 + 作者门）。
export function parseSourceDetailLinks(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attributes(match[1]).href;
    if (!href) continue;
    const url = validateSourceUrl(href, pageUrl);
    if (/^\/books\/details\d+\.html$/.test(url.pathname)) urls.add(url.href);
  }
  return [...urls];
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
  if (expectedTitle && heading && normalizeSourceTitle(plainText(heading)) !== normalizeSourceTitle(expectedTitle)) {
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
