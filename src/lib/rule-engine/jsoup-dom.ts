// jsoup1028：jsoup 1.16.2 DOM 语义层（ENGINE_SYNTAX_JSOUP）。在 cheerio/domhandler 树上复现规则 JS 摸得到的
// Element 行为：text/ownText/wholeText/data/hasText、outerHtml/html 美化输出、attr/hasClass/val、导航与 remove。
// 逐条依据 jsoup 源码 Element/TextNode/Comment/DataNode/DocumentType/Entities/Attribute(s)/Tag/StringUtil/NodeTraversor。
//
// parse5 与 jsoup HtmlTreeBuilder 的树并非处处相同：能从源码看出差异的形态（NUL、CDATA、template、非空元素自闭合、
// command/device/menuitem、带 public/system id 的 doctype、head 里有内容的 noscript）整篇文档求值失败；
// 只在序列化/取文本时才显形的差异（svg/math 外来元素、scripting 下 noscript 原文、CR 被 parse5 归一成 LF、
// 无值属性与 `=""` 分不清、对象键序与 jsoup 属性序不同…）摸到才失败。口径不定一律 fatal，不猜。

import type { AnyNode, Comment, Document, Element, ProcessingInstruction, Text } from 'domhandler';
import { RuleEngineError } from './types';

export type JElement = Element | Document;

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export function jsoupFatal(message: string): never {
  throw new RuleEngineError('RULE_EVAL_FAILED', `jsoup: ${message}`);
}

// ---------------------------------------------------------------- 节点分类
export function isElement(node: AnyNode | null | undefined): node is Element {
  return node != null && (node.type === 'tag' || node.type === 'script' || node.type === 'style');
}

export function isDocument(node: AnyNode | null | undefined): node is Document {
  return node != null && node.type === 'root';
}

/** jsoup 的 Element（Document 也是 Element，tag 为 #root）。 */
export function isJElement(node: AnyNode | null | undefined): node is JElement {
  return isElement(node) || isDocument(node);
}

/** script/style 下的文本在 jsoup 里是 DataNode（HtmlTreeBuilder.isContentForTagData）。 */
function isDataParent(node: AnyNode | null): boolean {
  return isElement(node) && (normalName(node) === 'script' || normalName(node) === 'style');
}

/** jsoup TextNode（不含 DataNode）。 */
export function isTextNode(node: AnyNode | null | undefined): node is Text {
  return node != null && node.type === 'text' && !isDataParent(node.parent);
}

export function isDataNode(node: AnyNode | null | undefined): node is Text {
  return node != null && node.type === 'text' && isDataParent(node.parent);
}

export function isCommentNode(node: AnyNode | null | undefined): node is Comment {
  return node != null && node.type === 'comment';
}

function isDoctypeNode(node: AnyNode | null | undefined): node is ProcessingInstruction {
  return node != null && node.type === 'directive' && node.name.toLowerCase() === '!doctype';
}

/** jsoup Node.normalName()。 */
export function normalName(node: AnyNode): string {
  if (isDocument(node)) return '#root';
  if (isElement(node)) return node.name.toLowerCase();
  if (node.type === 'text') return isDataParent(node.parent) ? '#data' : '#text';
  if (node.type === 'comment') return '#comment';
  if (isDoctypeNode(node)) return '#doctype';
  return `#${node.type}`;
}

export function childNodes(node: AnyNode): AnyNode[] {
  return 'children' in node ? node.children : [];
}

/** jsoup Node.parent()/Element.parent()：父节点是 Element（含 Document）时返回。 */
export function parentElement(node: AnyNode): JElement | null {
  const parent = node.parent;
  return isJElement(parent) ? parent : null;
}

// ---------------------------------------------------------------- Java/jsoup 字符口径
/** StringUtil.isWhitespace：空格 \t \n \f \r（不含 nbsp）。 */
export function isJsoupWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/** StringUtil.isActuallyWhitespace：再加 nbsp。 */
function isActuallyWhitespace(code: number): boolean {
  return isJsoupWhitespace(code) || code === 160;
}

/** StringUtil.isBlank。 */
export function isBlankString(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) if (!isJsoupWhitespace(s.charCodeAt(i))) return false;
  return true;
}

/** Java Character.isWhitespace(char)。 */
export function isJavaWhitespace(code: number): boolean {
  if ((code >= 9 && code <= 13) || (code >= 0x1c && code <= 0x20)) return true;
  return code === 0x1680 || (code >= 0x2000 && code <= 0x2006) || (code >= 0x2008 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x205f || code === 0x3000;
}

/** Java String.trim()：剥两端 <= U+0020 的字符。 */
export function javaTrim(s: string): string {
  return s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
}

/** jsoup Normalizer.lowerCase（toLowerCase(Locale.ENGLISH)）。 */
export function jsoupLower(s: string): string {
  return s.toLowerCase();
}

/** jsoup Normalizer.normalize：小写 + Java trim。 */
export function jsoupNormalize(s: string): string {
  return javaTrim(s.toLowerCase());
}

function charUpper(ch: string): string {
  const u = ch.toUpperCase();
  return u.length === 1 ? u : ch;
}

function charLower(ch: string): string {
  const l = ch.toLowerCase();
  return l.length === 1 ? l : ch;
}

/** Java String.regionMatches(ignoreCase=true, …)（逐 UTF-16 单元，先比大写再比小写）。 */
export function javaRegionMatchesIgnoreCase(a: string, aStart: number, b: string, bStart: number, len: number): boolean {
  if (aStart < 0 || bStart < 0 || aStart + len > a.length || bStart + len > b.length) return false;
  for (let i = 0; i < len; i += 1) {
    const c1 = a[aStart + i];
    const c2 = b[bStart + i];
    if (c1 === c2) continue;
    const u1 = charUpper(c1);
    const u2 = charUpper(c2);
    if (u1 === u2 || charLower(u1) === charLower(u2)) continue;
    return false;
  }
  return true;
}

/** Java String.equalsIgnoreCase。 */
export function javaEqualsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && javaRegionMatchesIgnoreCase(a, 0, b, 0, a.length);
}

/** StringUtil.appendNormalisedWhitespace：空白串压成一个空格（含 nbsp），零宽空格/软连字符丢弃。 */
function appendNormalisedWhitespace(accum: string, text: string, stripLeading: boolean): string {
  let out = accum;
  let lastWasWhite = false;
  let reachedNonWhite = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isActuallyWhitespace(code)) {
      if ((stripLeading && !reachedNonWhite) || lastWasWhite) continue;
      out += ' ';
      lastWasWhite = true;
    } else if (code !== 8203 && code !== 173) {
      out += ch;
      lastWasWhite = false;
      reachedNonWhite = true;
    }
  }
  return out;
}

/** StringUtil.normaliseWhitespace。 */
export function normaliseWhitespace(s: string): string {
  return appendNormalisedWhitespace('', s, false);
}

function lastCharIsWhitespace(accum: string): boolean {
  return accum.length !== 0 && accum[accum.length - 1] === ' ';
}

// ---------------------------------------------------------------- Tag 表（jsoup 1.16.2 Tag，HTML 命名空间）
// svg/text 属 SVG 命名空间、math/mi/mo/msup/mn/mtext 属 MathML 命名空间：HTML 命名空间下同名元素是未知标签，故不列。
const BLOCK_TAGS = new Set([
  'html', 'head', 'body', 'frameset', 'script', 'noscript', 'style', 'meta', 'link', 'title', 'frame', 'noframes',
  'section', 'nav', 'aside', 'hgroup', 'header', 'footer', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre',
  'div', 'blockquote', 'hr', 'address', 'figure', 'figcaption', 'form', 'fieldset', 'ins', 'del', 'dl', 'dt', 'dd',
  'li', 'table', 'caption', 'thead', 'tfoot', 'tbody', 'colgroup', 'col', 'tr', 'th', 'td', 'video', 'audio',
  'canvas', 'details', 'menu', 'plaintext', 'template', 'article', 'main', 'center', 'dir', 'applet', 'marquee',
  'listing',
]);
const INLINE_TAGS = new Set([
  'object', 'base', 'font', 'tt', 'i', 'b', 'u', 'big', 'small', 'em', 'strong', 'dfn', 'code', 'samp', 'kbd', 'var',
  'cite', 'abbr', 'time', 'acronym', 'mark', 'ruby', 'rt', 'rp', 'rtc', 'a', 'img', 'br', 'wbr', 'map', 'q', 'sub',
  'sup', 'bdo', 'iframe', 'embed', 'span', 'input', 'select', 'textarea', 'label', 'button', 'optgroup', 'option',
  'legend', 'datalist', 'keygen', 'output', 'progress', 'meter', 'area', 'param', 'source', 'track', 'summary',
  'command', 'device', 'basefont', 'bgsound', 'menuitem', 'data', 'bdi', 's', 'strike', 'nobr', 'rb',
]);
const EMPTY_TAGS = new Set([
  'meta', 'link', 'base', 'frame', 'img', 'br', 'wbr', 'embed', 'hr', 'input', 'keygen', 'col', 'command', 'device',
  'area', 'basefont', 'bgsound', 'menuitem', 'param', 'source', 'track',
]);
const FORMAT_AS_INLINE_TAGS = new Set([
  'title', 'a', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'address', 'li', 'th', 'td', 'script', 'style', 'ins',
  'del', 's',
]);
const PRESERVE_WS_TAGS = new Set(['pre', 'plaintext', 'title', 'textarea']);

interface TagInfo {
  readonly block: boolean;
  readonly formatAsBlock: boolean;
  readonly empty: boolean;
  readonly preserveWs: boolean;
}

/** Tag.valueOf 的未知标签（含 Document 的 #root）：isBlock=false、formatAsBlock=true。 */
const UNKNOWN_TAG: TagInfo = { block: false, formatAsBlock: true, empty: false, preserveWs: false };
const TAG_CACHE = new Map<string, TagInfo>();

function tagInfoByName(name: string): TagInfo {
  const cached = TAG_CACHE.get(name);
  if (cached) return cached;
  let info = UNKNOWN_TAG;
  if (BLOCK_TAGS.has(name) || INLINE_TAGS.has(name)) {
    const block = BLOCK_TAGS.has(name);
    info = {
      block,
      formatAsBlock: block && !FORMAT_AS_INLINE_TAGS.has(name),
      empty: EMPTY_TAGS.has(name),
      preserveWs: PRESERVE_WS_TAGS.has(name),
    };
  }
  TAG_CACHE.set(name, info);
  return info;
}

/** 元素的 jsoup Tag 属性；外来命名空间（svg/math）元素的 Tag 口径不复现 → fatal。 */
function tagInfo(el: JElement): TagInfo {
  if (isDocument(el)) return UNKNOWN_TAG;
  if (el.namespace !== undefined && el.namespace !== HTML_NS) jsoupFatal('svg/math 元素的文本/序列化口径不复现');
  return tagInfoByName(normalName(el));
}

/** Element.preserveWhitespace(node)：自身及 5 层祖先内有 pre/plaintext/title/textarea。 */
function preserveWhitespace(node: AnyNode | null): boolean {
  if (!isJElement(node)) return false;
  let el: JElement | null = node;
  for (let i = 0; i < 6 && el !== null; i += 1) {
    if (tagInfo(el).preserveWs) return true;
    el = parentElement(el);
  }
  return false;
}

// ---------------------------------------------------------------- 访问预算
const VISIT_LIMIT = 2_000_000;
let visits = 0;

/** 每次沙箱求值开始时清零（jsoup-shim 会话）。 */
export function resetJsoupBudget(): void {
  visits = 0;
}

export function chargeVisits(count = 1): void {
  visits += count;
  if (visits > VISIT_LIMIT) jsoupFatal('DOM 访问预算耗尽');
}

// ---------------------------------------------------------------- 文档守卫登记
export interface DocGuard {
  readonly root: Document;
  readonly source: string;
  /** parse5 scriptingEnabled（页面文档）：noscript 内容是原文而非 jsoup 的元素。 */
  readonly scripting: boolean;
  /** Jsoup.parse 新建的文档才可 remove；页面文档在字段间共享，不可改写。 */
  readonly mutable: boolean;
  scanned: boolean;
  fatal?: string;
  /** 源码含 CR：parse5 把 CR/CRLF 归一成 LF，jsoup 保留 CR；原样输出的 LF 口径不定。 */
  crLossy: boolean;
  /** 源码里出现过无值写法的属性名：jsoup 存 null（序列化折叠），parse5 存 ""，`=""` 与无值分不清。 */
  readonly valueless: Set<string>;
}

const GUARDS = new WeakMap<object, DocGuard>();
const DETACHED = new WeakMap<object, DocGuard>();

/** 登记一篇文档的原文（createHtmlScope / Jsoup.parse 调用）；源码扫描在首次 jsoup 访问时才做。 */
export function registerDocSource(root: Document, source: string, options: { scripting: boolean; mutable: boolean }): void {
  GUARDS.set(root, {
    root, source, scripting: options.scripting, mutable: options.mutable, scanned: false, crLossy: false,
    valueless: new Set(),
  });
}

/** 节点所在文档的守卫；未登记文档、源码扫描判定口径不定的文档 → fatal。 */
export function docGuard(node: AnyNode): DocGuard {
  let top: AnyNode = node;
  while (top.parent) top = top.parent;
  const guard = GUARDS.get(top) ?? DETACHED.get(top);
  if (!guard) return jsoupFatal('节点不属于已登记的文档');
  if (!guard.scanned) scanDoc(guard);
  if (guard.fatal !== undefined) jsoupFatal(guard.fatal);
  return guard;
}

// ---------------------------------------------------------------- 源码扫描
// 按 HTML 分词规则粗扫起始标签：只求「能看出树结构差异」与「无值属性名」，宁可误判 fatal、不可漏判。
const SCAN_VOID_TAGS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const SCAN_RAW_TEXT_TAGS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'textarea', 'title']);
const BREAKOUT_TAGS = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's',
  'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);
const SVG_INTEGRATION_TAGS = new Set(['foreignobject', 'desc', 'title']);
const MATH_INTEGRATION_TAGS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);

interface ScannedTag {
  name: string;
  attrs: { name: string; hasValue: boolean }[];
  selfClosing: boolean;
  end: number;
}

function isTagSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** 从标签名起点读一个标签（HTML 分词：标签名 → 属性名 → 属性值 → 自闭合）。 */
function readTag(src: string, start: number): ScannedTag {
  const n = src.length;
  let p = start;
  while (p < n && !isTagSpace(src[p]) && src[p] !== '/' && src[p] !== '>') p += 1;
  const name = asciiLower(src.slice(start, p));
  const attrs: ScannedTag['attrs'] = [];
  let selfClosing = false;
  while (p < n) {
    while (p < n && isTagSpace(src[p])) p += 1;
    if (p >= n) break;
    if (src[p] === '>') return { name, attrs, selfClosing, end: p + 1 };
    if (src[p] === '/') {
      if (src[p + 1] === '>') return { name, attrs, selfClosing: true, end: p + 2 };
      p += 1;
      continue;
    }
    const nameStart = p;
    p += 1; // 首字符可以是 `=`
    while (p < n && !isTagSpace(src[p]) && src[p] !== '/' && src[p] !== '>' && src[p] !== '=') p += 1;
    const attrName = asciiLower(src.slice(nameStart, p));
    while (p < n && isTagSpace(src[p])) p += 1;
    let hasValue = false;
    if (src[p] === '=') {
      p += 1;
      while (p < n && isTagSpace(src[p])) p += 1;
      const q = src[p];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, p + 1);
        p = close < 0 ? n : close + 1;
        hasValue = true;
      } else {
        const valueStart = p;
        while (p < n && !isTagSpace(src[p]) && src[p] !== '>') p += 1;
        hasValue = p > valueStart;
      }
    }
    attrs.push({ name: attrName, hasValue });
  }
  selfClosing = false;
  return { name, attrs, selfClosing, end: n };
}

/** `<!--` 之后：`<!-->`、`<!--->` 立即结束，否则到 `-->` 或 `--!>`。 */
function skipComment(src: string, p: number): number {
  if (src.startsWith('>', p)) return p + 1;
  if (src.startsWith('->', p)) return p + 2;
  let q = p;
  for (;;) {
    const k = src.indexOf('--', q);
    if (k < 0) return src.length;
    if (src[k + 2] === '>') return k + 3;
    if (src[k + 2] === '!' && src[k + 3] === '>') return k + 4;
    q = k + 1;
  }
}

/** 原文元素：跳到 `</name` + 空白//>，返回该 `<` 位置。 */
function skipRawText(src: string, p: number, name: string): number {
  const lower = src.toLowerCase();
  let q = p;
  for (;;) {
    const k = lower.indexOf(`</${name}`, q);
    if (k < 0) return src.length;
    const after = src[k + 2 + name.length];
    if (after === undefined || after === '>' || after === '/' || isTagSpace(after)) return k;
    q = k + 1;
  }
}

interface ForeignFrame {
  kind: 'svg' | 'math' | 'html';
  name: string;
}

function scanSource(src: string, valueless: Set<string>): { fatal?: string; nonBlankNoscript: boolean } {
  if (src.includes('\0')) return { fatal: '源码含 NUL', nonBlankNoscript: false };
  if (src.includes('<![CDATA[')) return { fatal: '源码含 CDATA 段', nonBlankNoscript: false };
  if (/<template/i.test(src)) return { fatal: '源码含 template', nonBlankNoscript: false };
  if (/<(?:command|device|menuitem)(?=[\s/>]|$)/i.test(src)) return { fatal: '源码含 command/device/menuitem', nonBlankNoscript: false };
  const stack: ForeignFrame[] = [];
  let nonBlankNoscript = false;
  let noscriptStart = -1;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      i = skipComment(src, lt + 4);
      continue;
    }
    const c = src[lt + 1];
    if (c === '!' || c === '?') {
      if (/^<!doctype/i.test(src.slice(lt, lt + 9))) {
        const gt = src.indexOf('>', lt);
        const decl = src.slice(lt, gt < 0 ? n : gt);
        if (/\b(?:public|system)\b/i.test(decl)) return { fatal: 'doctype 带 public/system id', nonBlankNoscript };
      }
      const gt = src.indexOf('>', lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    const isEnd = c === '/';
    const nameStart = isEnd ? lt + 2 : lt + 1;
    if (!/[A-Za-z]/.test(src[nameStart] ?? '')) {
      if (isEnd) {
        const gt = src.indexOf('>', nameStart);
        i = gt < 0 ? n : gt + 1;
      } else {
        i = lt + 1;
      }
      continue;
    }
    const tag = readTag(src, nameStart);
    i = tag.end;
    const name = tag.name;
    if (isEnd) {
      if (name === 'noscript' && noscriptStart >= 0) {
        if (!isBlankString(src.slice(noscriptStart, lt))) nonBlankNoscript = true;
        noscriptStart = -1;
      }
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    for (const attr of tag.attrs) if (!attr.hasValue) valueless.add(attr.name);
    let top = stack[stack.length - 1];
    let foreign = top !== undefined && top.kind !== 'html';
    const fontBreakout = name === 'font' && tag.attrs.some((a) => a.name === 'color' || a.name === 'face' || a.name === 'size');
    if (foreign && (BREAKOUT_TAGS.has(name) || fontBreakout)) {
      while (stack.length > 0 && stack[stack.length - 1].kind !== 'html') stack.pop();
      top = stack[stack.length - 1];
      foreign = false;
    }
    if (tag.selfClosing && !foreign && !SCAN_VOID_TAGS.has(name) && name !== 'svg' && name !== 'math') {
      return { fatal: `非空元素自闭合 <${name}/>`, nonBlankNoscript };
    }
    if (tag.selfClosing) continue;
    if (!foreign && (name === 'svg' || name === 'math')) {
      stack.push({ kind: name, name });
    } else if (foreign && top !== undefined && ((top.kind === 'svg' && SVG_INTEGRATION_TAGS.has(name))
      || (top.kind === 'math' && MATH_INTEGRATION_TAGS.has(name)))) {
      stack.push({ kind: 'html', name });
    } else if (foreign && top !== undefined) {
      stack.push({ kind: top.kind, name });
    }
    if (foreign) continue;
    if (name === 'plaintext') break;
    if (SCAN_RAW_TEXT_TAGS.has(name)) i = skipRawText(src, i, name);
    else if (name === 'noscript') noscriptStart = i;
  }
  if (noscriptStart >= 0 && !isBlankString(src.slice(noscriptStart))) nonBlankNoscript = true;
  return { nonBlankNoscript };
}

function firstChildNamed(node: JElement, name: string): Element | null {
  for (const child of node.children) if (isElement(child) && normalName(child) === name) return child;
  return null;
}

function subtreeHas(node: AnyNode, name: string): boolean {
  for (const child of childNodes(node)) {
    if (isElement(child) && (normalName(child) === name || subtreeHas(child, name))) return true;
  }
  return false;
}

function scanDoc(guard: DocGuard): void {
  guard.scanned = true;
  guard.crLossy = guard.source.includes('\r');
  // legado AnalyzeByJSoup.parse：内容以 `<?xml` 开头时按 Parser.xmlParser() 解析，树与 HTML 解析不同。
  // Jsoup.parse 新建的文档（mutable）照旧是 HTML 解析器。
  if (!guard.mutable && /^<\?xml/i.test(guard.source)) {
    guard.fatal = '内容以 <?xml 开头（legado 按 XML 解析）';
    return;
  }
  const scan = scanSource(guard.source, guard.valueless);
  if (scan.fatal !== undefined) {
    guard.fatal = scan.fatal;
    return;
  }
  const html = firstChildNamed(guard.root, 'html');
  const head = html ? firstChildNamed(html, 'head') : null;
  if (scan.nonBlankNoscript && head && subtreeHas(head, 'noscript')) guard.fatal = 'head 里的 noscript 有内容';
}

// ---------------------------------------------------------------- 访问检查
export function checkCr(text: string, guard: DocGuard): void {
  if (guard.crLossy && text.includes('\n')) jsoupFatal('源码含 CR，原样输出的换行口径不定');
}

/** 文本/序列化摸到的元素：外来命名空间、scripting 下有内容的 noscript → fatal。 */
function checkElement(el: JElement, guard: DocGuard): void {
  if (isDocument(el)) return;
  if (el.namespace !== undefined && el.namespace !== HTML_NS) jsoupFatal('svg/math 元素的文本/序列化口径不复现');
  if (guard.scripting && normalName(el) === 'noscript') {
    for (const child of el.children) {
      if (!(child.type === 'text' && isBlankString(child.data))) jsoupFatal('noscript 内容口径不定');
    }
  }
}

/** 选择器遍历摸到的元素：scripting 文档里有内容的 noscript 在 jsoup 是子元素、在 parse5 是原文，子树不可比 → fatal。 */
export function checkSelectVisit(el: JElement, guard: DocGuard): void {
  if (!guard.scripting || isDocument(el) || normalName(el) !== 'noscript') return;
  for (const child of el.children) {
    if (!(child.type === 'text' && isBlankString(child.data))) jsoupFatal('noscript 内容口径不定');
  }
}

function checkComment(comment: Comment, guard: DocGuard): void {
  const data = comment.data;
  if (data.length > 1 && (data.startsWith('!') || data.startsWith('?'))) jsoupFatal('疑似 XML 声明的注释口径不定');
  checkCr(data, guard);
}

// ---------------------------------------------------------------- 遍历（NodeTraversor.traverse）
type Visit = (node: AnyNode, depth: number) => boolean | void;

/** head 返回 true 即停（NodeFilter STOP）。 */
export function traverse(root: AnyNode, head: Visit, tail?: Visit): void {
  let node: AnyNode = root;
  let depth = 0;
  for (;;) {
    chargeVisits();
    if (head(node, depth) === true) return;
    const kids = childNodes(node);
    if (kids.length > 0) {
      node = kids[0];
      depth += 1;
      continue;
    }
    while (node.next == null && depth > 0) {
      tail?.(node, depth);
      node = node.parent as AnyNode;
      depth -= 1;
    }
    tail?.(node, depth);
    if (node === root) return;
    node = node.next as AnyNode;
  }
}

// ---------------------------------------------------------------- 文本族
function appendNormalisedText(accum: string, node: Text, guard: DocGuard): string {
  const text = node.data;
  if (preserveWhitespace(node.parent)) {
    checkCr(text, guard);
    return accum + text;
  }
  return appendNormalisedWhitespace(accum, text, lastCharIsWhitespace(accum));
}

/** Element.text()。 */
export function textOf(el: JElement): string {
  const guard = docGuard(el);
  let accum = '';
  traverse(el, (node) => {
    if (isTextNode(node)) {
      accum = appendNormalisedText(accum, node, guard);
    } else if (isJElement(node)) {
      checkElement(node, guard);
      if (accum.length > 0 && (tagInfo(node).block || normalName(node) === 'br') && !lastCharIsWhitespace(accum)) accum += ' ';
    }
  }, (node) => {
    if (!isJElement(node)) return;
    const next = node.next;
    if (tagInfo(node).block && (isTextNode(next) || (isElement(next) && !tagInfo(next).formatAsBlock))
      && !lastCharIsWhitespace(accum)) accum += ' ';
  });
  return javaTrim(accum);
}

/** Element.ownText()。 */
export function ownTextOf(el: JElement): string {
  const guard = docGuard(el);
  checkElement(el, guard);
  let accum = '';
  for (const child of el.children) {
    chargeVisits();
    if (isTextNode(child)) accum = appendNormalisedText(accum, child, guard);
    else if (isElement(child) && normalName(child) === 'br' && !lastCharIsWhitespace(accum)) accum += ' ';
  }
  return javaTrim(accum);
}

function appendWholeText(node: AnyNode, accum: string, guard: DocGuard): string {
  if (isTextNode(node)) {
    checkCr(node.data, guard);
    return accum + node.data;
  }
  if (isJElement(node)) {
    checkElement(node, guard);
    if (normalName(node) === 'br') return `${accum}\n`;
  }
  return accum;
}

/** Element.wholeText()。 */
export function wholeTextOf(el: JElement): string {
  const guard = docGuard(el);
  let accum = '';
  traverse(el, (node) => {
    accum = appendWholeText(node, accum, guard);
  });
  return accum;
}

/** Element.wholeOwnText()。 */
export function wholeOwnTextOf(el: JElement): string {
  const guard = docGuard(el);
  checkElement(el, guard);
  let accum = '';
  for (const child of el.children) {
    chargeVisits();
    accum = appendWholeText(child, accum, guard);
  }
  return accum;
}

/** Element.data()：DataNode 与注释内容。 */
export function dataOf(el: JElement): string {
  const guard = docGuard(el);
  let accum = '';
  traverse(el, (node) => {
    if (isDataNode(node)) {
      checkCr(node.data, guard);
      accum += node.data;
    } else if (isCommentNode(node)) {
      checkComment(node, guard);
      accum += node.data;
    } else if (isJElement(node)) {
      checkElement(node, guard);
    }
  });
  return accum;
}

/** Element.hasText()。 */
export function hasTextOf(el: JElement): boolean {
  const guard = docGuard(el);
  let found = false;
  traverse(el, (node) => {
    if (isJElement(node)) checkElement(node, guard);
    if (isTextNode(node) && !isBlankString(node.data)) {
      found = true;
      return true;
    }
    return false;
  });
  return found;
}

// ---------------------------------------------------------------- 属性
const BOOLEAN_ATTRS = new Set([
  'allowfullscreen', 'async', 'autofocus', 'checked', 'compact', 'declare', 'default', 'defer', 'disabled',
  'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'multiple', 'muted', 'nohref', 'noresize', 'noshade',
  'novalidate', 'nowrap', 'open', 'readonly', 'required', 'reversed', 'seamless', 'selected', 'sortable', 'truespeed',
  'typemustmatch',
]);

function attribsOf(el: JElement): Record<string, string> {
  return isDocument(el) ? {} : el.attribs;
}

/** Attributes.getIgnoreCase：首个忽略大小写同名键的值，无则 undefined。 */
function getIgnoreCase(el: JElement, key: string): string | undefined {
  const attribs = attribsOf(el);
  for (const k of Object.keys(attribs)) if (javaEqualsIgnoreCase(k, key)) return attribs[k];
  return undefined;
}

function hasKeyIgnoreCase(el: JElement, key: string): boolean {
  return getIgnoreCase(el, key) !== undefined;
}

/** Node.attr(key)：`abs:` 前缀解析绝对 URL 不复现 → fatal。 */
export function attrOf(el: JElement, key: string): string {
  if (Object.keys(attribsOf(el)).length === 0) return '';
  const val = getIgnoreCase(el, key) ?? '';
  if (val.length > 0) return val;
  if (key.startsWith('abs:')) {
    if (hasKeyIgnoreCase(el, key.slice(4))) jsoupFatal('abs: 绝对 URL 口径不复现');
  }
  return '';
}

/** Node.hasAttr(key)。 */
export function hasAttrOf(el: JElement, key: string): boolean {
  if (Object.keys(attribsOf(el)).length === 0) return false;
  if (key.startsWith('abs:') && hasKeyIgnoreCase(el, key.slice(4))) jsoupFatal('abs: 绝对 URL 口径不复现');
  return hasKeyIgnoreCase(el, key);
}

/** 属性名（不计顺序的用途：AttributeStarting）。 */
export function attributeNames(el: JElement): string[] {
  return Object.keys(attribsOf(el));
}

/** 属性键列表（源码序；对象键序与 jsoup 不同的形态 → fatal）。 */
export function attributeKeys(el: JElement): string[] {
  const keys = Object.keys(attribsOf(el));
  for (const key of keys) {
    if (/^(?:0|[1-9]\d*)$/.test(key)) jsoupFatal('数字属性名的属性序口径不定');
  }
  return keys;
}

/** Element.id()。 */
export function idOf(el: JElement): string {
  return getIgnoreCase(el, 'id') ?? '';
}

/** Element.className()。 */
export function classNameOf(el: JElement): string {
  return javaTrim(attrOf(el, 'class'));
}

/** Element.hasClass(name)：忽略大小写、按 Character.isWhitespace 切分。 */
export function hasClassOf(el: JElement, className: string): boolean {
  const classAttr = getIgnoreCase(el, 'class') ?? '';
  const len = classAttr.length;
  const wantLen = className.length;
  if (len === 0 || len < wantLen) return false;
  if (len === wantLen) return javaEqualsIgnoreCase(className, classAttr);
  let inClass = false;
  let start = 0;
  for (let i = 0; i < len; i += 1) {
    if (isJavaWhitespace(classAttr.charCodeAt(i))) {
      if (inClass) {
        if (i - start === wantLen && javaRegionMatchesIgnoreCase(classAttr, start, className, 0, wantLen)) return true;
        inClass = false;
      }
    } else if (!inClass) {
      inClass = true;
      start = i;
    }
  }
  if (inClass && len - start === wantLen) return javaRegionMatchesIgnoreCase(classAttr, start, className, 0, wantLen);
  return false;
}

/** Element.val()。 */
export function valOf(el: JElement): string {
  return normalName(el) === 'textarea' ? textOf(el) : attrOf(el, 'value');
}

// ---------------------------------------------------------------- 序列化（prettyPrint、indentAmount 1、maxPaddingWidth 30、base 转义）
interface Acc {
  s: string;
}

function indent(acc: Acc, depth: number): void {
  acc.s += `\n${' '.repeat(Math.min(depth, 30))}`;
}

/** Entities.escape（UTF-8 输出、base 转义模式）。 */
function escapeHtml(text: string, inAttr: boolean, normaliseWhite: boolean, stripLeading: boolean, trimTrailing: boolean): string {
  let out = '';
  let lastWasWhite = false;
  let reachedNonWhite = false;
  let skipped = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (normaliseWhite) {
      if (isJsoupWhitespace(code)) {
        if (stripLeading && !reachedNonWhite) continue;
        if (lastWasWhite) continue;
        if (trimTrailing) {
          skipped = true;
          continue;
        }
        out += ' ';
        lastWasWhite = true;
        continue;
      }
      lastWasWhite = false;
      reachedNonWhite = true;
      if (skipped) {
        out += ' ';
        skipped = false;
      }
    }
    switch (code) {
      case 38: out += '&amp;'; break;
      case 0xa0: out += '&nbsp;'; break;
      case 60: out += inAttr ? '<' : '&lt;'; break;
      case 62: out += inAttr ? '>' : '&gt;'; break;
      case 34: out += inAttr ? '&quot;' : '"'; break;
      case 9: case 10: case 13: out += text[i]; break;
      default:
        out += code < 0x20 ? `&#x${code.toString(16)};` : text[i];
    }
  }
  return out;
}

function tagNameOut(el: Element): string {
  const name = el.name;
  if (name.toLowerCase() !== name) jsoupFatal('非 ASCII 大写标签名口径不定');
  return name;
}

function isEffectivelyFirst(node: AnyNode): boolean {
  const prev = node.prev;
  if (prev == null) return true;
  if (prev.prev == null) return isTextNode(prev) && isBlankString(prev.data);
  return false;
}

function isFormatAsBlock(el: Element): boolean {
  const parent = parentElement(el);
  return tagInfo(el).block || (parent !== null && tagInfo(parent).formatAsBlock);
}

function isInlineable(el: Element): boolean {
  if (tagInfo(el).block) return false;
  const parent = parentElement(el);
  return (parent === null || tagInfo(parent).block) && !isEffectivelyFirst(el) && normalName(el) !== 'br';
}

function shouldIndent(el: Element): boolean {
  return isFormatAsBlock(el) && !isInlineable(el) && !preserveWhitespace(el.parent);
}

function attributesHtml(acc: Acc, el: Element, guard: DocGuard): void {
  for (const key of attributeKeys(el)) {
    if (key.toLowerCase() !== key) jsoupFatal('非 ASCII 大写属性名口径不定');
    let outKey = key;
    if (!/^[^\x00-\x1f\x7f-\x9f "'/=]+$/.test(outKey)) {
      outKey = outKey.replace(/[\x00-\x1f\x7f-\x9f "'/=]/g, '');
      if (outKey === '') continue;
    }
    const val = el.attribs[key];
    acc.s += ` ${outKey}`;
    const collapse = (val === '' || javaEqualsIgnoreCase(val, outKey)) && BOOLEAN_ATTRS.has(outKey.toLowerCase());
    if (collapse) continue;
    if (val === '' && guard.valueless.has(key)) jsoupFatal(`属性 ${outKey} 无值与空值分不清`);
    checkCr(val, guard);
    acc.s += `="${escapeHtml(val, true, false, false, false)}"`;
  }
}

function textHead(acc: Acc, node: Text, depth: number): void {
  const parent = parentElement(node);
  const normaliseWhite = !preserveWhitespace(node.parent);
  const pInfo = parent ? tagInfo(parent) : null;
  const trimLikeBlock = pInfo !== null && (pInfo.block || pInfo.formatAsBlock);
  let trimLeading = false;
  let trimTrailing = false;
  if (normaliseWhite) {
    trimLeading = (trimLikeBlock && node.prev == null) || isDocument(node.parent);
    trimTrailing = trimLikeBlock && node.next == null;
    const next = node.next;
    const prev = node.prev;
    const blank = isBlankString(node.data);
    const couldSkip = (isElement(next) && shouldIndent(next))
      || (isTextNode(next) && isBlankString(next.data))
      || (isElement(prev) && (tagInfo(prev).block || normalName(prev) === 'br'));
    if (couldSkip && blank) return;
    if ((prev == null && pInfo !== null && pInfo.formatAsBlock && !blank)
      || (prev != null && normalName(prev) === 'br')) indent(acc, depth);
  }
  acc.s += escapeHtml(node.data, false, normaliseWhite, trimLeading, trimTrailing);
}

function serializeHead(acc: Acc, node: AnyNode, depth: number, guard: DocGuard): void {
  if (isElement(node)) {
    checkElement(node, guard);
    if (shouldIndent(node) && acc.s.length > 0) indent(acc, depth);
    acc.s += `<${tagNameOut(node)}`;
    attributesHtml(acc, node, guard);
    acc.s += '>';
  } else if (isTextNode(node)) {
    if (preserveWhitespace(node.parent)) checkCr(node.data, guard);
    textHead(acc, node, depth);
  } else if (isDataNode(node)) {
    const data = (node as Text).data; // isTextNode 已把 Text 收窄掉，这里显式还原
    checkCr(data, guard);
    acc.s += data;
  } else if (isCommentNode(node)) {
    checkComment(node, guard);
    const parent = parentElement(node);
    if (isEffectivelyFirst(node) && parent !== null && tagInfo(parent).formatAsBlock) indent(acc, depth);
    acc.s += `<!--${node.data}-->`;
  } else if (isDoctypeNode(node)) {
    const pi = node as ProcessingInstruction & Record<string, unknown>;
    if (pi['x-publicId'] != null || pi['x-systemId'] != null) jsoupFatal('doctype 带 public/system id');
    if (node.prev != null) acc.s += '\n';
    const name = typeof pi['x-name'] === 'string' ? pi['x-name'] : '';
    acc.s += isBlankString(name) ? '<!doctype>' : `<!doctype ${name}>`;
  } else {
    jsoupFatal(`节点类型 ${node.type} 的序列化口径不复现`);
  }
}

function serializeTail(acc: Acc, node: AnyNode, depth: number): void {
  if (!isElement(node)) return;
  const info = tagInfo(node);
  if (node.children.length === 0 && info.empty) return;
  if (node.children.length > 0 && info.formatAsBlock && !preserveWhitespace(node.parent)) indent(acc, depth);
  acc.s += `</${node.name}>`;
}

function serializeInto(acc: Acc, root: AnyNode, guard: DocGuard): void {
  traverse(root, (node, depth) => {
    serializeHead(acc, node, depth, guard);
  }, (node, depth) => {
    serializeTail(acc, node, depth);
  });
}

/** Element.html()：子节点各自从深度 0 输出到同一缓冲，Java trim。 */
export function htmlOf(el: JElement): string {
  const guard = docGuard(el);
  checkElement(el, guard);
  const acc: Acc = { s: '' };
  for (const child of el.children) serializeInto(acc, child, guard);
  return javaTrim(acc.s);
}

/** Node.outerHtml()（Document.outerHtml() = html()）。 */
export function outerHtmlOf(node: AnyNode): string {
  if (isDocument(node)) return htmlOf(node);
  const guard = docGuard(node);
  const acc: Acc = { s: '' };
  serializeInto(acc, node, guard);
  return acc.s;
}

// ---------------------------------------------------------------- 导航
export function elementChildren(el: JElement): Element[] {
  return el.children.filter(isElement);
}

/** Element.elementSiblingIndex()。 */
export function elementSiblingIndex(el: JElement): number {
  const parent = parentElement(el);
  if (parent === null) return 0;
  let index = 0;
  for (const child of parent.children) {
    if (child === el) return index;
    if (isElement(child)) index += 1;
  }
  return 0;
}

export function nextElementSibling(el: JElement): Element | null {
  if (el.parent == null) return null;
  for (let n = el.next; n != null; n = n.next) if (isElement(n)) return n;
  return null;
}

export function previousElementSibling(el: JElement): Element | null {
  if (el.parent == null) return null;
  for (let n = el.prev; n != null; n = n.prev) if (isElement(n)) return n;
  return null;
}

/** Element.siblingElements()：父的元素子节点去掉自身。 */
export function siblingElements(el: JElement): Element[] {
  const parent = parentElement(el);
  if (parent === null) return [];
  return elementChildren(parent).filter((child) => child !== el);
}

// ---------------------------------------------------------------- 改写（只限 Jsoup.parse 新建文档）
/** Node.remove()：无父节点时 jsoup 抛 Validate 异常。 */
export function removeNode(node: AnyNode): void {
  const guard = docGuard(node);
  if (!guard.mutable) jsoupFatal('页面文档不可改写');
  const parent = node.parent;
  if (parent == null) return jsoupFatal('节点无父节点，不能 remove');
  const siblings = childNodes(parent);
  const index = siblings.indexOf(node as never);
  if (index >= 0) siblings.splice(index, 1);
  if (node.prev) node.prev.next = node.next;
  if (node.next) node.next.prev = node.prev;
  node.parent = null;
  node.prev = null;
  node.next = null;
  DETACHED.set(node, guard);
}
