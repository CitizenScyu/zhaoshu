// 引擎门面（设计 §7.1）：四个函数只做「取页（context.page）+ 解释」——
// 不做身份判定、不做源循环、不做候选排序（这些留在 source-reader.ts）。
//
// 边界（§7.3）：`context.page` 是唯一取页入口；本文件无定时器、无重试、无自带请求路径。
// 结构断言（v3 E5）：本模块导出集合**恰为**门面四函数（engineSearchBook / engineFetchDetail / engineFetchToc /
// engineFetchContent）与其类型，外加正文翻页上限常量 MAX_CONTENT_PAGES（41-M1.1：阅读器正文 context 的 L1 上限复用它）；
// admissionFetch / validateAdmissionUrl 不在此（它们在 rule-engine/admission.ts 且不导出）。
import { validateSourceUrl } from '@/lib/source-policy';
import {
  MAX_SOURCE_CHAPTERS, sourceSearchUrl, type SourceBookIdentity, type SourceChapter,
} from '@/lib/source-parser';
import type { SourceRequestContext } from '@/lib/source-reader';
import { contentHtmlToText, contentNeedsHtmlToText } from './content-html';
import { createScope, evaluateField, evaluateFieldNodes, insideNode, normalizeBody } from './evaluate';
import type { CompiledRules, FieldIr, SkippedField } from './types';

export interface EngineSource {
  url: string;
  name: string;
  searchUrl: string;
  /** compile.ts 产物（带 LRU，key=sourceRevision）。 */
  compiled: CompiledRules;
}
export interface EngineSearchResult { title: string; author: string; bookUrl: string }
export interface EngineTocResult { chapters: SourceChapter[] }
export interface EngineContentResult { text: string }

/** 翻页安全上限（引擎无定时器，靠页数/章节数上限终止，§7.3）。 */
const MAX_TOC_PAGES = 20;
export const MAX_CONTENT_PAGES = 20; // E5 导出例外（41-M1.1）：阅读器正文 context 的 L1 上限复用此值，不另写数字
const MAX_SEARCH_CANDIDATES = 50;
const MAX_TITLE_LENGTH = 200;

function field(compiled: CompiledRules, name: string): FieldIr | undefined {
  const found: FieldIr | SkippedField | undefined = compiled.get(name);
  return found && !('skipped' in found) ? found : undefined;
}

// 单值字段默认取首命中（applyTerminal multi=false）；仅正文拼接多段落。
function evaluateText(
  compiled: CompiledRules, name: string, scope: ReturnType<typeof createScope>, multi = false,
): string {
  const ir = field(compiled, name);
  return ir ? evaluateField(ir, scope, multi) : '';
}

/** 相对→绝对化 + 过运行时 host 门（§3.2/§6.1）；不合法返回 undefined（丢弃，不猜测）。 */
function absoluteUrl(value: string, base: string): string | undefined {
  if (!value) return undefined;
  try { return validateSourceUrl(value, base).href; } catch { return undefined; }
}

/** ruleSearch.bookList → 逐条 name/author/bookUrl；身份判定不在这里（§7.1）。 */
export async function engineSearchBook(
  source: EngineSource, title: string, context: SourceRequestContext,
): Promise<EngineSearchResult[]> {
  // 搜索 URL 展开复用 sourceSearchUrl（纯 GET、{{key}}/{{page}} 口径与初筛一致，§7.1）。
  const page = await context.page(sourceSearchUrl(source.searchUrl, title, source.url));
  const scope = createScope(normalizeBody(page.text), page.url);
  const list = field(source.compiled, 'ruleSearch.bookList');
  if (!list || scope.kind !== 'html') return [];
  const nodes = evaluateFieldNodes(list, scope);
  const results: EngineSearchResult[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < nodes.length && results.length < MAX_SEARCH_CANDIDATES; index += 1) {
    const inner = insideNode(scope, nodes[index]);
    const name = evaluateText(source.compiled, 'ruleSearch.name', inner);
    const bookUrl = absoluteUrl(evaluateText(source.compiled, 'ruleSearch.bookUrl', inner), page.url);
    if (!name || !bookUrl || seen.has(bookUrl)) continue;
    seen.add(bookUrl);
    results.push({ title: name, author: evaluateText(source.compiled, 'ruleSearch.author', inner), bookUrl });
  }
  return results;
}

/**
 * ruleBookInfo（name/author/tocUrl）。identity 校验留给调用方（§7.2）。
 * tocUrl 不在 `SourceBookIdentity` 里，作为附加字段带出（设计注释明确其属于本环节）；
 * 缺省时调用方回退用详情页 URL 当目录页。
 */
export async function engineFetchDetail(
  source: EngineSource, bookUrl: string, context: SourceRequestContext,
): Promise<Partial<SourceBookIdentity> & { tocUrl?: string }> {
  const target = validateSourceUrl(bookUrl).href;
  const page = await context.page(target);
  const scope = createScope(normalizeBody(page.text), page.url);
  const detail: Partial<SourceBookIdentity> & { tocUrl?: string } = {};
  const title = evaluateText(source.compiled, 'ruleBookInfo.name', scope);
  const author = evaluateText(source.compiled, 'ruleBookInfo.author', scope);
  const tocUrl = absoluteUrl(evaluateText(source.compiled, 'ruleBookInfo.tocUrl', scope), page.url);
  if (title) detail.title = title;
  if (author) detail.author = author;
  if (tocUrl) detail.tocUrl = tocUrl;
  return detail;
}

/** ruleToc.chapterList → SourceChapter[]，含 nextTocUrl 翻页循环。 */
export async function engineFetchToc(
  source: EngineSource, tocUrl: string, context: SourceRequestContext, strict = false,
): Promise<EngineTocResult> {
  const chapters: SourceChapter[] = [];
  const seenUrls = new Set<string>();
  const visited = new Set<string>();
  let next = absoluteUrl(tocUrl, source.url);
  for (let pageIndex = 0; next && pageIndex < MAX_TOC_PAGES && chapters.length <= MAX_SOURCE_CHAPTERS; pageIndex += 1) {
    if (visited.has(next)) { if (strict) throw new Error('pagination_cycle'); break; }
    visited.add(next);
    const page = await context.page(next);
    const scope = createScope(normalizeBody(page.text), page.url);
    let validChapters = 0;
    const list = field(source.compiled, 'ruleToc.chapterList');
    if (strict && [...source.compiled.entries()].some(([key, value]) => key.startsWith('ruleToc.') && 'skipped' in value)) throw new Error('unsupported_toc_rule');
    if (list && scope.kind === 'html') {
      const nodes = evaluateFieldNodes(list, scope);
      for (let index = 0; index < nodes.length; index += 1) {
        const inner = insideNode(scope, nodes[index]);
        const title = evaluateText(source.compiled, 'ruleToc.chapterName', inner);
        // legado BookChapterList.kt:230-244（Jer-Chao@c2c4775 / vvb2060@5a65aa42，取证见
        // docs/legado-semantics/）：URL 类规则缺失或求值为空 → 章节 url 取当前目录页 URL
        // （baseUrl）。只有这两种情况落兜底；规则产出非空但过不了 host 门的 URL 一律丢弃
        // （absoluteUrl 返回 undefined），绝不洗成 page.url。
        const rawUrl = evaluateText(source.compiled, 'ruleToc.chapterUrl', inner);
        const chapterUrl = rawUrl.trim() ? absoluteUrl(rawUrl, page.url) : page.url;
        if (strict && (!title || title.length > MAX_TITLE_LENGTH || !chapterUrl || !rawUrl.trim())) throw new Error('invalid_chapter');
        if (!title || title.length > MAX_TITLE_LENGTH || !chapterUrl) continue;
        validChapters += 1;
        if (seenUrls.has(chapterUrl)) continue;
        seenUrls.add(chapterUrl);
        chapters.push({ url: chapterUrl, title });
        if (chapters.length > MAX_SOURCE_CHAPTERS) break;
      }
    }
    if (strict && validChapters === 0) throw new Error('empty_toc_page');
    // 只有当前页确实是 HTML 时才解析翻页 URL；否则链结束（避免对 JSON 输入跑 CSS 规则）。
    const rawNext = scope.kind === 'html' ? evaluateText(source.compiled, 'ruleToc.nextTocUrl', scope) : '';
    next = absoluteUrl(rawNext, page.url);
    if (strict && rawNext.trim() && !next) throw new Error('invalid_next_page');
  }
  if (strict && (next || chapters.length > MAX_SOURCE_CHAPTERS)) throw new Error('toc_limit');
  return { chapters };
}

/** ruleContent.content 拼接，含 nextContentUrl 翻页；多页以换行连接（§7.1）。 */
export async function engineFetchContent(
  source: EngineSource, chapterUrl: string, context: SourceRequestContext, strict = false,
): Promise<EngineContentResult> {
  const parts: string[] = [];
  const visited = new Set<string>();
  const contentField = field(source.compiled, 'ruleContent.content');
  const convertContent = contentNeedsHtmlToText(contentField);
  let next = absoluteUrl(chapterUrl, source.url);
  for (let pageIndex = 0; next && pageIndex < MAX_CONTENT_PAGES; pageIndex += 1) {
    if (visited.has(next)) { if (strict) throw new Error('pagination_cycle'); break; }
    visited.add(next);
    const page = await context.page(next);
    const scope = createScope(normalizeBody(page.text), page.url);
    // 正文是唯一「多节点拼接」字段：@p@text 类规则靠 multi=true 把多段落拼成整章。
    // 是否做 HTML→纯文本按**规则类型**判定（41-HTMLFIX 复审）：全部候选支都是
    // text/ownText/textNodes（或不写后缀，字段层默认按 @text 求值，evaluate.ts:220）时
    // 逐字节透传；@html / JSON 路径 / 模板 / 混合 || 分支一律转换，含实体解码。
    // evaluateText 的 @html 语义不变，简介等其它字段不受影响。
    const raw = evaluateText(source.compiled, 'ruleContent.content', scope, true);
    const content = convertContent ? contentHtmlToText(raw) : raw;
    if (strict && !content.trim()) throw new Error('empty_content_page');
    if (content) parts.push(content);
    const nextRule = source.compiled.get('ruleContent.nextContentUrl');
    if (strict && nextRule && 'skipped' in nextRule) throw new Error('unsupported_content_rule');
    const rawNext = scope.kind === 'html' ? evaluateText(source.compiled, 'ruleContent.nextContentUrl', scope) : '';
    next = absoluteUrl(rawNext, page.url);
    if (strict && rawNext.trim() && !next) throw new Error('invalid_next_page');
  }
  if (strict && next) throw new Error('content_page_limit');
  return { text: parts.join('\n') };
}
