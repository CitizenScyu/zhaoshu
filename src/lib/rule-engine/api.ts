// 引擎门面（设计 §7.1）：四个函数只做「取页（context.page）+ 解释」——
// 不做身份判定、不做源循环、不做候选排序（这些留在 source-reader.ts）。
//
// 边界（§7.3）：`context.page` 是唯一取页入口；本文件无定时器、无重试、无自带请求路径。
// 结构断言（v3 E5）：本模块导出集合**恰为**门面四函数（engineSearchBook / engineFetchDetail / engineFetchToc /
// engineFetchContent）与其类型，外加正文翻页上限常量 MAX_CONTENT_PAGES（41-M1.1：阅读器正文 context 的 L1 上限复用它）；
// admissionFetch / validateAdmissionUrl 不在此（它们在 rule-engine/admission.ts 且不导出）。
import { alternateSourceHost, SourcePolicyError, upgradeSourceTemplateUrl, validateSourceUrl } from '@/lib/source-policy';
import {
  MAX_SOURCE_CHAPTERS, itempropAuthorOf, parseSourceAlias, searchTemplateNeedsJs, sourceSearchUrl, type SourceBookIdentity, type SourceChapter,
} from '@/lib/source-parser';
import type { SourceRequestContext } from '@/lib/source-reader';
import { contentHtmlToText, contentNeedsHtmlToText } from './content-html';
import { isStructuredChallengePage } from './content-challenge';
import {
  compiledUsesJs, createScope, evaluateField, evaluateFieldList, evaluateFieldStrings, fieldUsesJs, normalizeBody,
} from './evaluate';
import { enginePostSearchEnabled, engineSearchJsActive } from './compile-smoke';
import { preloadJsSandbox } from './js-sandbox';
import { buildSearchRequest, prepareSearchJs } from './search-js';
import { engineSyntaxJsBindEnabled } from './syntax-flags';
import type { CompiledRules, FieldIr, SkippedField } from './types';

export interface EngineSource {
  url: string;
  name: string;
  searchUrl: string;
  /** compile.ts 产物（带 LRU，key=sourceRevision）。 */
  compiled: CompiledRules;
  /** 书源原文的 bookSourceUrl（bind1028 `book.origin`，legado 不做归一）；缺省用 url。 */
  origin?: string;
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

/**
 * 相对→绝对化 + 过运行时 host 门（§3.2/§6.1）；不合法返回 undefined（丢弃，不猜测）。
 * 值来自页面抽出的链接（详情页 tocUrl、目录章节/翻页、正文翻页），也可能是规则里写死的
 * 绝对 URL；其中写死 `http://` 的先升 https（host/端口/路径不变，41-urlfix），再过同一把锁；
 * 因此放行的 host 集合与判据完全不变，只是不让「同 host 只是写错 scheme」白白丢候选。
 */
function absoluteUrl(value: string, base: string): string | undefined {
  if (!value) return undefined;
  try { return validateSourceUrl(upgradeSourceTemplateUrl(value), base).href; } catch { return undefined; }
}

/**
 * 页面作用域（bind1028，ENGINE_SYNTAX_JS_BIND on 才挂）：JS 的 `book.origin` = 书源地址，正文页另带当前章节名。
 * off 态不挂，JS 求值的输入与改前逐字一致。
 */
function pageScope(source: EngineSource, text: string, url: string, chapterTitle?: string): ReturnType<typeof createScope> {
  const scope = createScope(normalizeBody(text), url);
  if (engineSyntaxJsBindEnabled()) {
    scope.host = { origin: source.origin ?? source.url, ...(chapterTitle === undefined ? {} : { chapterTitle }) };
  }
  return scope;
}

/** 编译产物含 JS 链字段时先载入沙箱（jsbox1027；求值是同步的，必须在取页之前就绪）。无 JS 链零开销。 */
async function prepareJs(source: EngineSource): Promise<void> {
  if (compiledUsesJs(source.compiled)) await preloadJsSandbox();
}

/**
 * JS 链下一页（jsbox1027，legado getStringList(isUrl=true)）：逐项绝对化、去重，去掉当前页（legado 目录
 * 排除 redirectUrl、正文以 nextUrlList 起始项排除）。strict 下任一项过不了 host 门即 invalid_next_page。
 */
function chainNextUrls(ir: FieldIr, scope: ReturnType<typeof createScope>, pageUrl: string, strict: boolean): string[] {
  const urls: string[] = [];
  const keys = new Set([pageIdentity(pageUrl)]);
  for (const raw of evaluateFieldStrings(ir, scope)) {
    const url = absoluteUrl(raw, pageUrl);
    if (!url) {
      if (strict) throw new Error('invalid_next_page');
      continue;
    }
    const key = pageIdentity(url);
    if (keys.has(key)) continue;
    keys.add(key);
    urls.push(url);
  }
  return urls;
}

/** ruleSearch.bookList → 逐条 name/author/bookUrl；身份判定不在这里（§7.1）。 */
export async function engineSearchBook(
  source: EngineSource, title: string, context: SourceRequestContext,
): Promise<EngineSearchResult[]> {
  await prepareJs(source);
  // 搜索 URL 展开：flag 关时复用 sourceSearchUrl（纯 GET、utf-8，逐字不变）；
  // flag 开时经 buildSourceSearchRequest 支持 POST/body/charset/白名单头（41-postsearch）。
  let page: { url: string; text: string };
  if (enginePostSearchEnabled()) {
    // searchjs1027：旧口径构造不出、需 JS 的模板（ENGINE_SEARCH_JS 开）在沙箱里按 legado 口径求值；其余逐字走旧口径。
    const searchJs = engineSearchJsActive();
    if (searchJs && searchTemplateNeedsJs(source.searchUrl, source.url)) await prepareSearchJs();
    const request = buildSearchRequest(source.searchUrl, title, source.url, validateSourceUrl, searchJs);
    page = await context.page(request.url, {
      request: { method: request.method, body: request.body, headers: request.headers, charset: request.charset },
      // 显式非 utf-8 字符集直接用；否则 'auto' 按 Content-Type 嗅探（utf-8 站维持原状）。
      responseCharset: request.charset === 'utf-8' ? 'auto' : request.charset,
    });
  } else {
    page = await context.page(sourceSearchUrl(source.searchUrl, title, source.url));
  }
  const scope = pageScope(source, page.text, page.url);
  const list = field(source.compiled, 'ruleSearch.bookList');
  if (!list) return [];
  const items = evaluateFieldList(list, scope);
  const results: EngineSearchResult[] = [];
  const seen = new Set<string>();
  // listjs1027：`-` 前缀 = legado BookList 去重（保留首次出现）后整表反转，先收全再反转、截候选上限。
  const reverse = list.reverse === true;
  for (let index = 0; index < items.length && (reverse || results.length < MAX_SEARCH_CANDIDATES); index += 1) {
    const inner = items[index];
    const name = evaluateText(source.compiled, 'ruleSearch.name', inner);
    const bookUrl = absoluteUrl(evaluateText(source.compiled, 'ruleSearch.bookUrl', inner), page.url);
    if (!name || !bookUrl || seen.has(bookUrl)) continue;
    seen.add(bookUrl);
    results.push({ title: name, author: evaluateText(source.compiled, 'ruleSearch.author', inner), bookUrl });
  }
  return reverse ? results.reverse().slice(0, MAX_SEARCH_CANDIDATES) : results;
}

/**
 * ruleBookInfo（name/author/tocUrl）。identity 校验留给调用方（§7.2）。
 * tocUrl 不在 `SourceBookIdentity` 里，作为附加字段带出（设计注释明确其属于本环节）；
 * 缺省时调用方回退用详情页 URL 当目录页。
 * 页面自报的原书名别名一并带出；最终书名与作者身份仍由调用方核对。
 */
export async function engineFetchDetail(
  source: EngineSource, bookUrl: string, context: SourceRequestContext,
): Promise<Partial<SourceBookIdentity> & { tocUrl?: string }> {
  await prepareJs(source);
  const target = validateSourceUrl(bookUrl).href;
  const page = await context.page(target, { responseCharset: enginePostSearchEnabled() ? 'auto' : undefined });
  const scope = pageScope(source, page.text, page.url);
  const detail: Partial<SourceBookIdentity> & { tocUrl?: string } = {};
  const title = evaluateText(source.compiled, 'ruleBookInfo.name', scope);
  const author = evaluateText(source.compiled, 'ruleBookInfo.author', scope);
  const tocUrl = absoluteUrl(evaluateText(source.compiled, 'ruleBookInfo.tocUrl', scope), page.url);
  if (title) detail.title = title;
  if (tocUrl) detail.tocUrl = tocUrl;
  // 41-author：源的 ruleBookInfo.author 没命中（vikbook 写 .author@a 但页面并无该 class）时，
  // 退 schema.org 微数据作者（与 parseSourceIdentity 共用口径）；仍缺则留给调用方回落搜索候选行。
  if (author) detail.author = author;
  else {
    const fallback = itempropAuthorOf(page.text);
    if (fallback) detail.author = fallback;
  }
  // 与 builtin 复用成对括号的明确原书名标记，不把作者搜索词当作书名。
  const alias = parseSourceAlias(page.text);
  if (alias.alias) detail.alias = alias.alias;
  return detail;
}

/** ruleToc.chapterList → SourceChapter[]，含 nextTocUrl 翻页循环。 */
export async function engineFetchToc(
  source: EngineSource, tocUrl: string, context: SourceRequestContext, strict = false,
): Promise<EngineTocResult> {
  // 原始顺序（含重复）先全收，最后统一去重（41-ctocfu §5）。去重口径对齐 legado **净效果**：
  // BookChapterList.kt:114-124 先 `chapterList.reverse()` → `LinkedHashSet`（保留反转后的首次出现）
  // → 再按 `book.getReverseToc()`（默认 false，Book.kt:394）reverse 回来；同 url 的章节因此**保留
  // 最后一次出现**，位置也落在最后一次出现处。旧实现保留首次出现、位置落在首次出现处——章节数相同
  // 但顺序不同（docs/legado-semantics/E1 说的「同结果」只覆盖计数与 1 章书退化场景）。
  // 去重键是 url：BookChapter.kt:87-91 的 equals/hashCode 只比 url。
  // kxdu.net 形态（页面顶部「最新章节」9 条在目录末尾原样重列）正是靠这条把头部区块挤到末尾，
  // 让「第一章」回到首位；无重复的页面下该变换是恒等，逐字节不变。
  await prepareJs(source);
  const entries: SourceChapter[] = [];
  const seenUrls = new Set<string>(); // 唯一章节计数（页数/总量上限），与最终去重顺序无关
  const visited = new Set<string>();
  const receivedPages = new Set<string>();
  let next = absoluteUrl(tocUrl, source.url);
  // JS 链 nextTocUrl 一次给出多页时（jsbox1027，legado BookChapterList 并发分支）：逐页全抓，这些页不再取下一页。
  // 非链字段恒为空，循环与改前逐字等价。
  const fanout: string[] = [];
  for (let pageIndex = 0; (next || fanout.length > 0) && pageIndex < MAX_TOC_PAGES && seenUrls.size <= MAX_SOURCE_CHAPTERS; pageIndex += 1) {
    const fromFanout = !next;
    if (!next) next = fanout.shift()!;
    if (visited.has(next)) { if (strict) throw new Error('pagination_cycle'); break; }
    visited.add(next);
    const page = await context.page(next, { responseCharset: enginePostSearchEnabled() ? 'auto' : undefined });
    // 不同分页请求可能重定向回已读目录；不能把首部分章节作为完整目录保存。
    const receivedKey = redirectedPageIdentity(page.url);
    if (receivedPages.has(receivedKey)) {
      if (strict) throw new Error('pagination_cycle');
      throw new SourcePolicyError('书源目录分页重复返回已读取的页面，请重试或更换书源');
    }
    receivedPages.add(receivedKey);
    const scope = pageScope(source, page.text, page.url);
    let validChapters = 0;
    const list = field(source.compiled, 'ruleToc.chapterList');
    if (strict && [...source.compiled.entries()].some(([key, value]) => key.startsWith('ruleToc.') && 'skipped' in value)) throw new Error('unsupported_toc_rule');
    if (list) {
      const items = evaluateFieldList(list, scope);
      for (let index = 0; index < items.length; index += 1) {
        const inner = items[index];
        const title = evaluateText(source.compiled, 'ruleToc.chapterName', inner);
        // legado BookChapterList.kt:230-244（Jer-Chao@c2c4775 / vvb2060@5a65aa42，取证见
        // docs/legado-semantics/）：URL 类规则缺失或求值为空 → 章节 url 取当前目录页 URL
        // （baseUrl）。只有这两种情况落兜底；规则产出非空但过不了 host 门的 URL 一律丢弃
        // （absoluteUrl 返回 undefined），绝不洗成 page.url。
        // bind1028：legado 先求 chapterName 赋给 bookChapter.title，chapterUrl 的 JS 可读 chapter.title/title。
        const urlScope = inner.host ? { ...inner, host: { ...inner.host, chapterTitle: title } } : inner;
        const rawUrl = evaluateText(source.compiled, 'ruleToc.chapterUrl', urlScope);
        const chapterUrl = rawUrl.trim() ? absoluteUrl(rawUrl, page.url) : page.url;
        if (strict && (!title || title.length > MAX_TITLE_LENGTH || !chapterUrl || !rawUrl.trim())) throw new Error('invalid_chapter');
        if (!title || title.length > MAX_TITLE_LENGTH || !chapterUrl) continue;
        validChapters += 1;
        seenUrls.add(chapterUrl);
        entries.push({ url: chapterUrl, title });
        if (seenUrls.size > MAX_SOURCE_CHAPTERS) break;
      }
    }
    if (strict && validChapters === 0) throw new Error('empty_toc_page');
    // 已声明并跟随的后页缺内容，不能把前页目录作为完整成功；不改变首页/章节URL兜底语义。
    if (pageIndex > 0 && validChapters === 0) throw new SourcePolicyError('书源目录后续页未提供有效章节，请重试或更换书源');
    if (fromFanout) {
      next = undefined;
      continue;
    }
    const nextField = field(source.compiled, 'ruleToc.nextTocUrl');
    if (fieldUsesJs(nextField)) {
      // JS 链在 JSON 页上照样求值（JS 段常用来解析 JSON 拼下一页）。
      const urls = chainNextUrls(nextField, scope, page.url, strict);
      next = urls.length === 1 ? urls[0] : undefined;
      if (urls.length > 1) fanout.push(...urls.filter((url) => !visited.has(url)));
      continue;
    }
    // 只有当前页确实是 HTML 时才解析翻页 URL；否则链结束（避免对 JSON 输入跑 CSS 规则）。
    const rawNext = scope.kind === 'html' ? evaluateText(source.compiled, 'ruleToc.nextTocUrl', scope) : '';
    next = absoluteUrl(rawNext, page.url);
    if (strict && rawNext.trim() && !next) throw new Error('invalid_next_page');
  }
  if (strict && (next || fanout.length > 0 || seenUrls.size > MAX_SOURCE_CHAPTERS)) throw new Error('toc_limit');
  // listjs1027：`-` 前缀时 legado 跳过去重前的那次反转，净效果 = 全部页的条目整表反转后再走下面的去重。
  if (field(source.compiled, 'ruleToc.chapterList')?.reverse === true) entries.reverse();
  // 保留每个 url 的**最后一次**出现。最后一次出现的位置严格递增，故按原序过滤即得 legado 净顺序。
  const lastIndex = new Map<string, number>();
  entries.forEach((chapter, index) => lastIndex.set(chapter.url, index));
  return { chapters: entries.filter((chapter, index) => lastIndex.get(chapter.url) === index) };
}

/**
 * 翻页停止判据的 URL 比较口径（41-PAGEFIX）：绝对化之后去掉 fragment；查询串与尾斜杠原样保留。
 * legado NetworkUtils.getAbsoluteURL 连 fragment 都不去；fragment 不发往服务端，去掉只会把同一资源认得更准。
 * 查询串、尾斜杠可能真的区分资源（read.php?id=2 与 ?id=3），规范化会把真第 2 页误判成下一章而截断正文；
 * 漏判只是退回改前行为，误判才有害，所以只去 fragment。
 */
function pageIdentity(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

// HTTP跳转落点核对：仅合并策略明确支持的同站host，不泛化任意域名的www关系。
function redirectedPageIdentity(url: string): string {
  const parsed = new URL(pageIdentity(url));
  const alternate = alternateSourceHost(parsed.hostname);
  if (alternate && alternate < parsed.hostname) parsed.hostname = alternate;
  return parsed.href;
}

/**
 * ruleContent.content 拼接，含 nextContentUrl 翻页；多页以换行连接（§7.1）。
 * nextChapterUrl（41-PAGEFIX，legado BookContent.analyzeContent 同款判据）：「下一页」解析后等于下一章
 * ⇒ 本章结束，不请求那一页。每章一页的站点（如 cuoceng 的 #linkNext）「下一页」就是下一章，缺这条判据会一路
 * 翻进后续章节。不传时判据不生效，行为与改前逐字节相同。
 * 传数组（lblqual41）= 一组停止地址，下一页命中其中任一即停：站点「下一章」链的顺序可能与目录顺序不同
 * （cuoceng《鬼吹灯》第 0 章的下一章是目录第 3 章），只给目录里的下一章拦不住，调用方可以把整本目录都传进来。
 * 本章自身地址不参与停止判断（整本目录必然含本章；自指翻页仍按 visited/strict 的环检测处理）。
 * chapterTitle（bind1028）：本章章节名，正文两字段的 JS 读 `chapter.title`/`title` 时用；不传则读到 undefined。
 */
export async function engineFetchContent(
  source: EngineSource, chapterUrl: string, context: SourceRequestContext, strict = false,
  nextChapterUrl?: string | readonly string[], chapterTitle?: string,
): Promise<EngineContentResult> {
  await prepareJs(source);
  const parts: string[] = [];
  const visited = new Set<string>();
  const receivedPages = new Set<string>();
  const contentField = field(source.compiled, 'ruleContent.content');
  const convertContent = contentNeedsHtmlToText(contentField);
  let next = absoluteUrl(chapterUrl, source.url);
  // 下一章按本章 URL 绝对化（legado 以本章 redirectUrl 为基址）；过不了 host 门就不设判据（退回改前行为）。
  const stopKeys = new Set<string>();
  if (next) {
    for (const url of typeof nextChapterUrl === 'string' ? [nextChapterUrl] : nextChapterUrl ?? []) {
      const stopAt = url ? absoluteUrl(url, next) : undefined;
      if (stopAt) stopKeys.add(pageIdentity(stopAt));
    }
    // 只对数组剔除本章自身（整本目录必然含本章）；单个地址保持改前语义不变。
    if (typeof nextChapterUrl !== 'string') stopKeys.delete(pageIdentity(next));
  }
  const redirectStopKeys = new Set([...stopKeys].map(redirectedPageIdentity));
  // 单章目录会把本章作为单个停止地址传入；正常交付本章（含同站换host）不能被拒绝。
  if (next) redirectStopKeys.delete(redirectedPageIdentity(next));
  // 同目录的 fanout（jsbox1027，legado BookContent 并发分支）：JS 链一次给出多页时逐页全抓，这些页不再取下一页。
  const fanout: string[] = [];
  for (let pageIndex = 0; (next || fanout.length > 0) && pageIndex < MAX_CONTENT_PAGES; pageIndex += 1) {
    const fromFanout = !next;
    if (!next) next = fanout.shift()!;
    if (visited.has(next)) { if (strict) throw new Error('pagination_cycle'); break; }
    visited.add(next);
    const page = await context.page(next, { responseCharset: enginePostSearchEnabled() ? 'auto' : undefined });
    const receivedKey = redirectedPageIdentity(page.url);
    if (redirectStopKeys.has(receivedKey)) {
      throw new SourcePolicyError('书源正文跳转到了目录中的其他章节，请重试或更换书源');
    }
    // 请求别名可能重定向回已读页；按实际落点拒绝整章，不能重复拼接后写入成功缓存。
    if (receivedPages.has(receivedKey)) {
      if (strict) throw new Error('pagination_cycle');
      throw new SourcePolicyError('书源正文分页重复返回已读取的页面，请重试或更换书源');
    }
    receivedPages.add(receivedKey);
    const scope = pageScope(source, page.text, page.url, chapterTitle);
    // 首/后页同门：挑战页不能作为正文交付，也不能缓存已拼出的半章。
    if (scope.kind === 'html' && isStructuredChallengePage(scope.$)) {
      throw new SourcePolicyError('书源正文页被安全验证拦截，请重试或更换书源');
    }
    // 正文是唯一「多节点拼接」字段：@p@text 类规则靠 multi=true 把多段落拼成整章。
    // 是否做 HTML→纯文本按**规则类型**判定（41-HTMLFIX 复审）：全部候选支都是
    // text/ownText/textNodes（或不写后缀，字段层默认按 @text 求值，evaluate.ts:220）时
    // 逐字节透传；@html / JSON 路径 / 模板 / 混合 || 分支一律转换，含实体解码。
    // evaluateText 的 @html 语义不变，简介等其它字段不受影响。
    const raw = evaluateText(source.compiled, 'ruleContent.content', scope, true);
    const content = convertContent ? contentHtmlToText(raw) : raw;
    if (strict && !content.trim()) throw new Error('empty_content_page');
    // 阻止验证码/改版空后页把半章送入成功缓存；调用方据此走既有章节换源流程。
    if (pageIndex > 0 && !content.trim()) throw new SourcePolicyError('书源正文后续页内容缺失，请重试或更换书源');
    if (content) parts.push(content);
    const nextRule = source.compiled.get('ruleContent.nextContentUrl');
    if (strict && nextRule && 'skipped' in nextRule) throw new Error('unsupported_content_rule');
    if (fromFanout) {
      next = undefined;
      continue;
    }
    if (fieldUsesJs(nextRule)) {
      // 命中停止地址（下一章）的项先剔除：单项时等同 legado 顺序分支「等于下一章即停」，多项时不把下一章当本章分页抓。
      const urls = chainNextUrls(nextRule, scope, page.url, strict).filter((url) => !stopKeys.has(pageIdentity(url)));
      next = urls.length === 1 ? urls[0] : undefined;
      if (urls.length > 1) fanout.push(...urls.filter((url) => !visited.has(url)));
      continue;
    }
    const rawNext = scope.kind === 'html' ? evaluateText(source.compiled, 'ruleContent.nextContentUrl', scope) : '';
    next = absoluteUrl(rawNext, page.url);
    if (strict && rawNext.trim() && !next) throw new Error('invalid_next_page');
    // 放在 invalid_next_page 之后：命中下一章不是非法链接；置空 next 让循环后的 content_page_limit 不误报。
    if (next && stopKeys.has(pageIdentity(next))) { next = undefined; break; }
  }
  if (strict && (next || fanout.length > 0)) throw new Error('content_page_limit');
  return { text: parts.join('\n') };
}
