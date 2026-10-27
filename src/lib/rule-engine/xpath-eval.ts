// xpatheval1027：JsoupXpath 语义的 XPath 求值器（ENGINE_SYNTAX_XPATH_EVAL，默认关）。
// 只接 xpath-subset.ts 翻不成 CSS 的 XPath 段：translate 子集照旧走 CSS，本文件只扩不改。
// 口径 = legado 依赖的 JsoupXpath（XpathProcessor/Scope/AxisSelector/NodeTest/Function 逐个对照源码），
// 包括它的怪癖：作用域栈、`//` 递归标记挂在作用域上、谓词里 [n] 按「父节点下同名且在上下文中」计位次、
// 函数参数里 position() 恒为 1、`*` 乘法右结合、`=` 两侧异型按字符串比较等。
// 唯一有意偏离：`=`/`!=` 两侧都是数字时按数值比（JsoupXpath 里 Integer 与 Double 异型、按 "1" vs "1.0"
// 比字符串，`[position()=1]` 恒假——那是缺陷，照抄只会让规则在两边都失效）。
// 编译期拒绝 JsoupXpath 会抛错或产出垃圾的构件（未知函数/轴/节点类型、filterExpr 后接路径、非末步取值、
// qName、node()、comment() 等），由调用方转 unsupported_xpath。求值有节点访问预算，超限 RULE_EVAL_FAILED。
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Document, Element } from 'domhandler';
import { absolutizeUrl } from './dom-ops';
import { RuleEngineError } from './types';

/** 编译期语法错误（调用方转 RULE_UNSUPPORTED / unsupported_xpath）。 */
export class XPathSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XPathSyntaxError';
  }
}

/** 单次求值的节点访问预算（遍历/谓词逐元素/轴产出都计数）。 */
export const MAX_XPATH_VISITS = 2_000_000;
/** 表达式嵌套深度上限（括号/谓词/函数参数）。 */
const MAX_XPATH_DEPTH = 32;

// ---------------------------------------------------------------- AST
export type XExpr =
  | { t: 'or' | 'and'; items: XExpr[] }
  | { t: 'cmp'; op: string; l: XExpr; r: XExpr }
  | { t: 'add'; first: XExpr; rest: { op: '+' | '-'; e: XExpr }[] }
  | { t: 'mul'; op: '*' | 'div' | 'mod'; l: XExpr; r: XExpr }
  | { t: 'neg'; e: XExpr }
  | { t: 'union'; l: XExpr; r: XExpr }
  | { t: 'path'; abs: '/' | '//' | null; steps: XStep[]; seps: ('/' | '//')[] }
  | { t: 'filter'; primary: XExpr }
  | { t: 'lit'; v: string }
  | { t: 'num'; v: number }
  | { t: 'call'; name: string; args: XExpr[] };

export type XStep =
  | { t: 'self' }
  | { t: 'parent' }
  | { t: 'step'; axis: string | null; attr: boolean; name: string | null; nodeType: string | null; preds: XExpr[] };

export interface XPathProgram {
  readonly expr: XExpr;
  /** 结果恒为文本（末步 @attr / text() / allText() / num()，或标量表达式）：正文无需 HTML→文本转换。 */
  readonly plainText: boolean;
  /** 末步是 @href / @src：值按页 URL 绝对化（与 CSS 路径 URL_OPS 同口径）。 */
  readonly urlAttr: boolean;
}

// ---------------------------------------------------------------- 词法
type Tok = { k: 'op'; v: string } | { k: 'name'; v: string } | { k: 'lit'; v: string } | { k: 'num'; v: number };

const MULTI_OPS = ['//', '::', '..', '!=', '<=', '>=', '^=', '$=', '*=', '~=', '!~'];
const SINGLE_OPS = new Set(['/', '|', '[', ']', '(', ')', ',', '@', '.', '*', '+', '-', '=', '<', '>']);
const NAME_START = /[A-Za-z_\u00C0-\uFFFF]/;
const NAME_REST = /^[A-Za-z_\u00C0-\uFFFF][\w.\-\u00B7\u00C0-\uFFFF]*/;
const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new XPathSyntaxError('XPath 字符串未闭合');
      toks.push({ k: 'lit', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = NUMBER_RE.exec(src.slice(i))!;
      toks.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (NAME_START.test(ch)) {
      const m = NAME_REST.exec(src.slice(i))!;
      toks.push({ k: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) { toks.push({ k: 'op', v: two }); i += 2; continue; }
    if (SINGLE_OPS.has(ch)) { toks.push({ k: 'op', v: ch }); i += 1; continue; }
    throw new XPathSyntaxError(`XPath 含非法字符 ${JSON.stringify(ch)}`);
  }
  return toks;
}

// ---------------------------------------------------------------- 语法（对照 JsoupXpath Xpath.g4）
const NODE_TYPES = new Set(['text', 'allText', 'html', 'outerHtml', 'num']);
/** JsoupXpath 注册了但这里不收的节点类型：node() 对有自身文本的元素会 new Element("") 抛错；comment/PI 无实现。 */
const REJECTED_NODE_TYPES = new Set(['node', 'comment', 'processing-instruction']);
const AXES = new Set([
  'ancestor', 'ancestor-or-self', 'child', 'descendant', 'descendant-or-self', 'following', 'following-sibling',
  'following-sibling-one', 'parent', 'preceding', 'preceding-sibling', 'self',
]);
/** 函数名 → 最少参数个数（not 恰好 1）。JsoupXpath 只注册了这些。 */
const FUNCTIONS: ReadonlyMap<string, number> = new Map([
  ['concat', 0], ['contains', 2], ['count', 0], ['first', 0], ['last', 0], ['not', 1], ['position', 0],
  ['starts-with', 2], ['string-length', 0], ['substring', 3], ['substring-after', 2], ['substring-after-last', 2],
  ['substring-before', 2], ['substring-before-last', 2],
]);
const REL_OPS = new Set(['<', '<=', '>', '>=', '^=', '$=', '*=', '~=', '!~']);

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): XExpr {
    const expr = this.expr();
    if (this.pos < this.toks.length) throw new XPathSyntaxError(`XPath 多余的记号 ${JSON.stringify(this.describe(this.peek()))}`);
    return expr;
  }

  private describe(tok: Tok | undefined): string {
    return tok === undefined ? '<end>' : String(tok.v);
  }

  private peek(offset = 0): Tok | undefined {
    return this.toks[this.pos + offset];
  }

  private isOp(v: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok !== undefined && tok.k === 'op' && tok.v === v;
  }

  private isName(v: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.k === 'name' && tok.v === v;
  }

  private expect(v: string): void {
    if (!this.isOp(v)) throw new XPathSyntaxError(`XPath 期望 ${v}，实际 ${this.describe(this.peek())}`);
    this.pos += 1;
  }

  private expr(): XExpr {
    this.depth += 1;
    if (this.depth > MAX_XPATH_DEPTH) throw new XPathSyntaxError('XPath 嵌套过深');
    const e = this.orExpr();
    this.depth -= 1;
    return e;
  }

  private orExpr(): XExpr {
    const items = [this.andExpr()];
    while (this.isName('or')) { this.pos += 1; items.push(this.andExpr()); }
    return items.length === 1 ? items[0] : { t: 'or', items };
  }

  private andExpr(): XExpr {
    const items = [this.eqExpr()];
    while (this.isName('and')) { this.pos += 1; items.push(this.eqExpr()); }
    return items.length === 1 ? items[0] : { t: 'and', items };
  }

  private eqExpr(): XExpr {
    const l = this.relExpr();
    if (this.isOp('=') || this.isOp('!=')) {
      const op = (this.toks[this.pos++] as { v: string }).v;
      return { t: 'cmp', op, l, r: this.relExpr() };
    }
    return l;
  }

  private relExpr(): XExpr {
    const l = this.addExpr();
    const tok = this.peek();
    if (tok?.k === 'op' && REL_OPS.has(tok.v)) {
      this.pos += 1;
      return { t: 'cmp', op: tok.v, l, r: this.addExpr() };
    }
    return l;
  }

  private addExpr(): XExpr {
    const first = this.mulExpr();
    const rest: { op: '+' | '-'; e: XExpr }[] = [];
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.isOp('+') ? '+' : '-';
      this.pos += 1;
      rest.push({ op, e: this.mulExpr() });
    }
    return rest.length === 0 ? first : { t: 'add', first, rest };
  }

  // multiplicativeExpr: unaryExpr (op multiplicativeExpr)? —— 右递归，a div b div c = a/(b/c)。
  private mulExpr(): XExpr {
    const l = this.unaryExpr();
    let op: '*' | 'div' | 'mod' | null = null;
    if (this.isOp('*')) op = '*';
    else if (this.isName('div')) op = 'div';
    else if (this.isName('mod')) op = 'mod';
    if (op === null) return l;
    this.pos += 1;
    return { t: 'mul', op, l, r: this.mulExpr() };
  }

  private unaryExpr(): XExpr {
    if (this.isOp('-')) {
      this.pos += 1;
      return { t: 'neg', e: this.unionExpr() };
    }
    return this.unionExpr();
  }

  private unionExpr(): XExpr {
    const l = this.pathExpr();
    if (!this.isOp('|')) return l;
    this.pos += 1;
    return { t: 'union', l, r: this.unionExpr() };
  }

  private pathExpr(): XExpr {
    const tok = this.peek();
    const isCall = tok?.k === 'name' && this.isOp('(', 1) && !NODE_TYPES.has(tok.v) && !REJECTED_NODE_TYPES.has(tok.v);
    if (tok !== undefined && (tok.k === 'lit' || tok.k === 'num' || (tok.k === 'op' && tok.v === '(') || isCall)) {
      const primary = this.primary();
      // filterExpr 的谓词 JsoupXpath 不求值（visitFilterExpr 只访问 primaryExpr），照样解析、不保留。
      while (this.isOp('[')) this.predicate();
      if (this.isOp('/') || this.isOp('//')) throw new XPathSyntaxError('XPath filterExpr 后接路径（JsoupXpath 丢弃前值）');
      return { t: 'filter', primary };
    }
    return this.locationPath();
  }

  private primary(): XExpr {
    const tok = this.peek()!;
    if (tok.k === 'lit') { this.pos += 1; return { t: 'lit', v: tok.v }; }
    if (tok.k === 'num') { this.pos += 1; return { t: 'num', v: tok.v }; }
    if (tok.k === 'op') {
      this.expect('(');
      const e = this.expr();
      this.expect(')');
      return e;
    }
    const name = tok.v;
    const min = FUNCTIONS.get(name);
    if (min === undefined) throw new XPathSyntaxError(`XPath 不支持的函数 ${name}()`);
    this.pos += 1;
    this.expect('(');
    const args: XExpr[] = [];
    if (!this.isOp(')')) {
      args.push(this.expr());
      while (this.isOp(',')) { this.pos += 1; args.push(this.expr()); }
    }
    this.expect(')');
    if (args.length < min || (name === 'not' && args.length !== 1)) {
      throw new XPathSyntaxError(`XPath 函数 ${name}() 参数个数不对`);
    }
    return { t: 'call', name, args };
  }

  private predicate(): XExpr {
    this.expect('[');
    const e = this.expr();
    this.expect(']');
    return e;
  }

  private locationPath(): XExpr {
    let abs: '/' | '//' | null = null;
    if (this.isOp('/') || this.isOp('//')) {
      abs = this.isOp('/') ? '/' : '//';
      this.pos += 1;
    }
    const steps = [this.step()];
    const seps: ('/' | '//')[] = [];
    while (this.isOp('/') || this.isOp('//')) {
      seps.push(this.isOp('/') ? '/' : '//');
      this.pos += 1;
      steps.push(this.step());
    }
    // relativeLocationPath 里非末步若返回非节点集（@attr、allText()…），JsoupXpath 不更新上下文、继续用旧上下文
    // 走后续步——结果是垃圾，legado 侧同样不可用，编译期拒。
    for (const step of steps.slice(0, -1)) {
      if (step.t === 'step' && (step.attr || step.nodeType !== null)) throw new XPathSyntaxError('XPath 非末步取值');
    }
    return { t: 'path', abs, steps, seps };
  }

  private step(): XStep {
    if (this.isOp('..')) { this.pos += 1; return { t: 'parent' }; }
    if (this.isOp('.')) { this.pos += 1; return { t: 'self' }; }
    let axis: string | null = null;
    let attr = false;
    if (this.isOp('@')) {
      attr = true;
      this.pos += 1;
    } else {
      const tok = this.peek();
      if (tok?.k === 'name' && this.isOp('::', 1)) {
        if (!AXES.has(tok.v)) throw new XPathSyntaxError(`XPath 不支持的轴 ${tok.v}::`);
        axis = tok.v;
        this.pos += 2;
      }
    }
    let name: string | null = null;
    let nodeType: string | null = null;
    const tok = this.peek();
    if (tok?.k === 'op' && tok.v === '*') {
      if (attr) throw new XPathSyntaxError('XPath 不支持 @*');
      name = '*';
      this.pos += 1;
    } else if (tok?.k === 'name') {
      if (this.isOp('(', 1)) {
        if (!NODE_TYPES.has(tok.v)) throw new XPathSyntaxError(`XPath 不支持的节点类型 ${tok.v}()`);
        if (attr) throw new XPathSyntaxError('XPath @ 后只能接属性名');
        nodeType = tok.v;
        this.pos += 1;
        this.expect('(');
        this.expect(')');
      } else {
        if (this.isOp(':', 1)) throw new XPathSyntaxError('XPath 不支持 qName');
        name = tok.v;
        this.pos += 1;
      }
    } else {
      throw new XPathSyntaxError(`XPath 期望步，实际 ${this.describe(tok)}`);
    }
    const preds: XExpr[] = [];
    while (this.isOp('[')) preds.push(this.predicate());
    return { t: 'step', axis, attr, name, nodeType, preds };
  }
}

function lastStepOf(expr: XExpr): XStep | null {
  return expr.t === 'path' ? expr.steps[expr.steps.length - 1] : null;
}

function plainTextOf(expr: XExpr): boolean {
  if (expr.t === 'union') return plainTextOf(expr.l) && plainTextOf(expr.r);
  if (expr.t === 'filter') return plainTextOf(expr.primary);
  if (expr.t !== 'path') return true;
  const step = lastStepOf(expr)!;
  return step.t === 'step' && (step.attr || step.nodeType === 'text' || step.nodeType === 'allText' || step.nodeType === 'num');
}

function urlAttrOf(expr: XExpr): boolean {
  if (expr.t === 'union') return urlAttrOf(expr.l) && urlAttrOf(expr.r);
  if (expr.t === 'filter') return urlAttrOf(expr.primary);
  const step = lastStepOf(expr);
  if (step === null || step.t !== 'step' || !step.attr) return false;
  const name = step.name!.toLowerCase();
  return name === 'href' || name === 'src';
}

/** 编译一条 XPath（已去 `@XPath:` 前缀）。语法外/JsoupXpath 不支持的构件抛 XPathSyntaxError。 */
export function compileXPath(text: string): XPathProgram {
  const toks = tokenize(text);
  if (toks.length === 0) throw new XPathSyntaxError('空 XPath');
  const expr = new Parser(toks).parse();
  return { expr, plainText: plainTextOf(expr), urlAttr: urlAttrOf(expr) };
}

// ---------------------------------------------------------------- 节点模型
type DomNode = Element | Document;

/** JsoupXpath 造出来的「伪元素」：text() 的 JX_TEXT、following-sibling 的文本节点 `text`、并集里标量的 `V`。 */
class Pseudo {
  constructor(
    readonly tag: 'JX_TEXT' | 'text' | 'V',
    readonly raw: string,
    readonly parent: DomNode | null,
    readonly index = 0,
    public count = 0,
  ) {}
}

type XNode = DomNode | Pseudo;

function isElementNode(node: AnyNode | null | undefined): node is Element {
  return node != null && (node.type === 'tag' || node.type === 'script' || node.type === 'style');
}

function isDomNode(node: AnyNode | null | undefined): node is DomNode {
  return node != null && (node.type === 'root' || isElementNode(node));
}

function tagOf(node: XNode): string {
  if (node instanceof Pseudo) return node.tag;
  return node.type === 'root' ? '#root' : node.name;
}

function elementChildren(node: XNode): Element[] {
  if (node instanceof Pseudo) return [];
  return node.children.filter(isElementNode);
}

function parentOf(node: XNode): DomNode | null {
  if (node instanceof Pseudo) return node.parent;
  const parent = node.parent;
  return isDomNode(parent) ? parent : null;
}

/** jsoup Element.parents()：由近到远，不含 Document。 */
function ancestorsOf(node: XNode): DomNode[] {
  const out: DomNode[] = [];
  for (let p = parentOf(node); p !== null && p.type !== 'root'; p = parentOf(p)) out.push(p);
  return out;
}

function attrOf(node: XNode, name: string): string | undefined {
  if (node instanceof Pseudo || node.type === 'root') return undefined;
  return node.attribs[name] ?? node.attribs[name.toLowerCase()];
}

/** script/style 的子文本在 jsoup 里是 DataNode：不算 text()/ownText/text()。 */
function isDataParent(node: XNode): boolean {
  return !(node instanceof Pseudo) && (node.type === 'script' || node.type === 'style');
}

function dataOf(node: XNode): string {
  if (node instanceof Pseudo) return node.raw;
  let out = '';
  for (const child of node.children) if (child.type === 'text') out += child.data;
  return out;
}

const BLOCK_TAGS = new Set([
  'html', 'head', 'body', 'frameset', 'script', 'noscript', 'style', 'meta', 'link', 'title', 'frame', 'noframes',
  'section', 'nav', 'aside', 'hgroup', 'header', 'footer', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre',
  'div', 'blockquote', 'hr', 'address', 'figure', 'figcaption', 'form', 'fieldset', 'ins', 'del', 'dl', 'dt', 'dd',
  'li', 'table', 'caption', 'thead', 'tfoot', 'tbody', 'colgroup', 'col', 'tr', 'th', 'td', 'video', 'audio',
  'canvas', 'details', 'menu', 'plaintext', 'template', 'article', 'main', 'svg', 'math', 'center', 'dir', 'applet',
  'marquee', 'listing',
]);
const PRESERVE_WS_TAGS = new Set(['pre', 'plaintext', 'title', 'textarea', 'listing']);

function isJsoupWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r' || ch === '\u00A0';
}

/** StringUtil.appendNormalisedWhitespace：空白串压成一个空格，零宽空格/软连字符丢弃。 */
function appendNormalised(accum: string, text: string, stripLeading: boolean): string {
  let out = accum;
  let lastWasWhite = false;
  let reachedNonWhite = false;
  for (const ch of text) {
    if (isJsoupWhitespace(ch)) {
      if ((stripLeading && !reachedNonWhite) || lastWasWhite) continue;
      out += ' ';
      lastWasWhite = true;
    } else if (ch !== '\u200B' && ch !== '\u00AD') {
      out += ch;
      lastWasWhite = false;
      reachedNonWhite = true;
    }
  }
  return out;
}

/** Java String.trim()：剥两端 <= U+0020 的字符。 */
function javaTrim(s: string): string {
  return s.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
}

function endsWithSpace(s: string): boolean {
  return s.length > 0 && s[s.length - 1] === ' ';
}

/** jsoup Element.preserveWhitespace：自身及 5 层祖先内有 pre/textarea/title… */
function preservesWhitespace(node: DomNode | null): boolean {
  let el: DomNode | null = node;
  for (let i = 0; i < 6 && el !== null && el.type !== 'root'; i += 1) {
    if (PRESERVE_WS_TAGS.has(el.name)) return true;
    el = parentOf(el);
  }
  return false;
}

function appendTextNode(accum: string, data: string, parent: DomNode | null): string {
  return preservesWhitespace(parent) ? accum + data : appendNormalised(accum, data, endsWithSpace(accum));
}

/** jsoup Element.ownText()。 */
function ownTextOf(node: XNode): string {
  if (node instanceof Pseudo) return javaTrim(appendNormalised('', node.raw, false));
  if (isDataParent(node)) return '';
  let accum = '';
  for (const child of node.children) {
    if (child.type === 'text') accum = appendTextNode(accum, child.data, node);
    else if (isElementNode(child) && child.name === 'br' && !endsWithSpace(accum)) accum += ' ';
  }
  return javaTrim(accum);
}

// ---------------------------------------------------------------- 值
type XValue =
  | { t: 'els'; v: XNode[] }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number; int: boolean }
  | { t: 'bool'; v: boolean }
  | { t: 'list'; v: string[] }
  | { t: 'null' };

const NULL_VALUE: XValue = { t: 'null' };

function evalFailed(message: string): never {
  throw new RuleEngineError('RULE_EVAL_FAILED', message);
}

/** Java String.valueOf(double)。 */
function javaDouble(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(v);
  if (abs >= 1e-3 && abs < 1e7) return Number.isInteger(v) ? `${v}.0` : String(v);
  const [mantissa, exponent] = v.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

class Scope {
  recursion = false;
  constructor(public context: XNode[], readonly parent: Scope | null) {}
}

/** 一次求值的状态：作用域栈 + 预算 + position()/last() 的按上下文缓存。 */
class Evaluator {
  private visits = 0;
  private readonly stack: Scope[];
  private readonly rootScope: Scope;
  private readonly siblingIndexCache = new WeakMap<XNode[], Map<DomNode, Map<XNode, number> & { totals?: Map<string, number> }>>();
  private readonly subtreeCountCache = new WeakMap<XNode[], Map<DomNode, Map<string, number>>>();

  constructor(private readonly $: CheerioAPI, roots: XNode[]) {
    this.rootScope = new Scope(roots, null);
    this.stack = [new Scope(roots, this.rootScope)];
  }

  private charge(n = 1): void {
    this.visits += n;
    if (this.visits > MAX_XPATH_VISITS) evalFailed('XPath 求值超出节点访问预算');
  }

  private get cur(): Scope {
    return this.stack[this.stack.length - 1];
  }

  private inScope<T>(scope: Scope, run: () => T): T {
    this.stack.push(scope);
    try {
      return run();
    } finally {
      this.stack.pop();
    }
  }

  // ---- 遍历
  /** 自身 + 全部后代元素（文档序；jsoup getAllElements，Document 也算元素）。 */
  private allElements(root: XNode): XNode[] {
    if (root instanceof Pseudo) return [root];
    const out: XNode[] = [];
    const walk = (node: DomNode) => {
      this.charge();
      out.push(node);
      for (const child of node.children) if (isElementNode(child)) walk(child);
    };
    walk(root);
    return out;
  }

  /** Elements.select(tag)：自身 + 后代，跨根去重，标签大小写不敏感。 */
  private selectTag(context: XNode[], tag: string): XNode[] {
    const want = tag.toLowerCase();
    const seen = new Set<XNode>();
    const out: XNode[] = [];
    for (const root of context) {
      for (const el of this.allElements(root)) {
        if (seen.has(el)) continue;
        if (want === '*' || tagOf(el).toLowerCase() === want) {
          seen.add(el);
          out.push(el);
        }
      }
    }
    return out;
  }

  /** jsoup Element.text()：块级元素边界与 br 补空格。 */
  private jsoupText(node: XNode): string {
    if (node instanceof Pseudo) return javaTrim(appendNormalised('', node.raw, false));
    let accum = '';
    const walk = (parent: DomNode) => {
      for (const child of parent.children) {
        this.charge();
        if (child.type === 'text') {
          if (!isDataParent(parent)) accum = appendTextNode(accum, child.data, parent);
        } else if (isElementNode(child)) {
          if (accum.length > 0 && (BLOCK_TAGS.has(child.name) || child.name === 'br') && !endsWithSpace(accum)) accum += ' ';
          walk(child);
          if (BLOCK_TAGS.has(child.name) && child.next?.type === 'text' && !endsWithSpace(accum)) accum += ' ';
        }
      }
    };
    walk(node);
    return javaTrim(accum);
  }

  // ---- 值转换（XValue.asString/asBoolean/asDouble/asLong）
  private asString(v: XValue): string {
    switch (v.t) {
      case 'els': return v.v.map(ownTextOf).join('');
      case 'list': return v.v.join(',');
      case 'str': return javaTrim(v.v);
      case 'num': return v.int ? String(Math.trunc(v.v)) : javaDouble(v.v);
      case 'bool': return String(v.v);
      default: return 'null';
    }
  }

  private asBoolean(v: XValue): boolean {
    if (v.t === 'bool') return v.v;
    if (v.t === 'null') return false;
    return !isBlank(this.asString(v));
  }

  private asDouble(v: XValue): number {
    if (v.t === 'num') return v.v;
    if (v.t === 'str') {
      const s = javaTrim(v.v);
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) evalFailed('XPath 数值转换失败');
      return Number(s);
    }
    return evalFailed('XPath 数值转换失败');
  }

  private asLong(v: XValue): number {
    if (v.t === 'num') return Number.isNaN(v.v) ? 0 : Math.trunc(v.v);
    if (v.t === 'str') {
      const d = this.asDouble(v);
      return Math.sign(d) * Math.floor(Math.abs(d) + 0.5); // BigDecimal HALF_UP
    }
    return evalFailed('XPath 整数转换失败');
  }

  private sameValue(l: XValue, r: XValue): boolean {
    switch (l.t) {
      case 'els': {
        const rv = (r as { v: XNode[] }).v;
        return l.v.length === rv.length && l.v.every((n, i) => n === rv[i]);
      }
      case 'list': {
        const rv = (r as { v: string[] }).v;
        return l.v.length === rv.length && l.v.every((s, i) => s === rv[i]);
      }
      case 'num': return l.v === (r as { v: number }).v && l.int === (r as { int: boolean }).int;
      case 'null': return true;
      default: return l.v === (r as { v: unknown }).v;
    }
  }

  private equals(l: XValue, r: XValue): boolean {
    if (l.t === 'num' && r.t === 'num') return l.v === r.v; // 有意偏离：数值比较（见文件头）
    if (l.t === r.t) return this.sameValue(l, r);
    return this.asString(l) === this.asString(r);
  }

  /** XValue.compareTo。 */
  private compare(l: XValue, r: XValue): number {
    if (l.t === r.t && this.sameValue(l, r)) return 0;
    if (r.t === 'null') return 1;
    if (l.t === 'null') return -1;
    if (l.t === 'str') {
      const a = this.asString(l);
      const b = this.asString(r);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (l.t === 'num') {
      const a = this.asDouble(l);
      const b = this.asDouble(r);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return evalFailed('XPath 比较的左值不可比');
  }

  private javaMatches(text: string, pattern: string): boolean {
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      return evalFailed('XPath 正则不合法');
    }
    return re.test(text);
  }

  // ---- 表达式
  evaluate(expr: XExpr): XValue {
    switch (expr.t) {
      case 'or':
      case 'and': {
        // JsoupXpath 用 | / & 逐项求值，不短路。
        let acc = this.asBoolean(this.evaluate(expr.items[0]));
        for (const item of expr.items.slice(1)) {
          const b = this.asBoolean(this.evaluate(item));
          acc = expr.t === 'or' ? acc || b : acc && b;
        }
        return { t: 'bool', v: acc };
      }
      case 'cmp': {
        const l = this.evaluate(expr.l);
        const r = this.evaluate(expr.r);
        switch (expr.op) {
          case '=': return { t: 'bool', v: this.equals(l, r) };
          case '!=': return { t: 'bool', v: !this.equals(l, r) };
          case '<': return { t: 'bool', v: this.compare(l, r) < 0 };
          case '<=': return { t: 'bool', v: this.compare(l, r) <= 0 };
          case '>': return { t: 'bool', v: this.compare(l, r) > 0 };
          case '>=': return { t: 'bool', v: this.compare(l, r) >= 0 };
          case '^=': return { t: 'bool', v: this.asString(l).startsWith(this.asString(r)) };
          case '$=': return { t: 'bool', v: this.asString(l).endsWith(this.asString(r)) };
          case '*=': return { t: 'bool', v: this.asString(l).includes(this.asString(r)) };
          case '~=': return { t: 'bool', v: this.javaMatches(this.asString(l), this.asString(r)) };
          default: return { t: 'bool', v: !this.javaMatches(this.asString(l), this.asString(r)) };
        }
      }
      case 'add': {
        let acc = this.asDouble(this.evaluate(expr.first));
        for (const { op, e } of expr.rest) {
          const d = this.asDouble(this.evaluate(e));
          acc = op === '+' ? acc + d : acc - d;
        }
        return { t: 'num', v: acc, int: false };
      }
      case 'mul': {
        const a = this.asDouble(this.evaluate(expr.l));
        const b = this.asDouble(this.evaluate(expr.r));
        const v = expr.op === '*' ? a * b : expr.op === 'div' ? a / b : a % b;
        return { t: 'num', v, int: false };
      }
      case 'neg':
        return { t: 'num', v: -this.asDouble(this.evaluate(expr.e)), int: false };
      case 'union':
        return this.union(expr);
      case 'path':
        return this.path(expr);
      case 'filter':
        return this.evaluate(expr.primary);
      case 'lit':
        return { t: 'str', v: expr.v };
      case 'num':
        return { t: 'num', v: expr.v, int: false };
      default:
        return this.call(expr.name, expr.args);
    }
  }

  private union(expr: { l: XExpr; r: XExpr }): XValue {
    const l = this.evaluate(expr.l);
    const parent = this.cur.parent!;
    const r = this.inScope(new Scope(parent.context, parent), () => this.evaluate(expr.r));
    const asPseudo = (v: XValue) => new Pseudo('V', this.asString(v), null);
    if (l.t === 'els' && r.t === 'els') return { t: 'els', v: [...l.v, ...r.v] };
    if (l.t === 'els') return { t: 'els', v: [...l.v, asPseudo(r)] };
    if (r.t === 'els' && l.t === 'str') return { t: 'els', v: [...r.v, asPseudo(l)] };
    if (l.t === 'str' && r.t === 'str') return { t: 'str', v: l.v + r.v };
    if (l.t === 'bool' && r.t === 'bool') return { t: 'bool', v: l.v || r.v };
    if ((l.t === 'bool' || l.t === 'num') && r.t === 'str') return { t: 'str', v: this.asString(l) + r.v };
    const parts = [this.asString(l), this.asString(r)].filter((s) => !isBlank(s));
    return { t: 'str', v: parts.join(',') };
  }

  private path(expr: { abs: '/' | '//' | null; steps: XStep[]; seps: ('/' | '//')[] }): XValue {
    if (expr.abs === null) return this.relative(expr.steps, expr.seps);
    const scope = new Scope(this.rootScope.context, this.cur);
    if (expr.abs === '//') scope.recursion = true;
    return this.inScope(scope, () => this.relative(expr.steps, expr.seps));
  }

  private relative(steps: XStep[], seps: ('/' | '//')[]): XValue {
    let value: XValue = NULL_VALUE;
    steps.forEach((step, i) => {
      if (i > 0) this.cur.recursion = seps[i - 1] === '//';
      value = this.step(step);
      if (value.t === 'els') this.cur.context = value.v;
    });
    return value;
  }

  private step(step: XStep): XValue {
    const scope = this.cur;
    if (step.t === 'self') return { t: 'els', v: scope.context };
    if (step.t === 'parent') {
      const parents = new Set<XNode>();
      for (const el of scope.context) {
        const p = parentOf(el);
        if (p !== null) parents.add(p);
      }
      return { t: 'els', v: [...parents] };
    }
    let axisOk = false;
    if (step.attr) {
      axisOk = true;
    } else if (step.axis !== null) {
      axisOk = true;
      scope.context = this.axis(step.axis, scope.context);
    }
    if (step.attr) {
      const name = step.name!;
      const context = scope.context;
      if (scope.recursion) {
        const values: string[] = [];
        for (const root of context) {
          for (const el of this.allElements(root)) {
            const v = attrOf(el, name);
            if (v !== undefined) values.push(v);
          }
        }
        return { t: 'list', v: values };
      }
      if (context.length === 1) return { t: 'str', v: attrOf(context[0], name) ?? '' };
      return { t: 'list', v: context.map((el) => attrOf(el, name) ?? '') };
    }
    if (step.name !== null) {
      const tag = step.name;
      if (scope.recursion) {
        scope.context = this.selectTag(scope.context, tag);
      } else {
        const next: XNode[] = [];
        for (const el of scope.context) {
          const candidates = axisOk ? [el] : elementChildren(el);
          this.charge(candidates.length);
          for (const c of candidates) if (tag === '*' || tagOf(c) === tag) next.push(c);
        }
        scope.context = next;
      }
    } else {
      const v = this.nodeType(step.nodeType!, scope);
      if (v.t !== 'els') return v;
      scope.context = v.v;
    }
    for (const pred of step.preds) scope.context = this.predicate(pred, scope);
    return { t: 'els', v: scope.context };
  }

  private predicate(pred: XExpr, scope: Scope): XNode[] {
    const context = scope.context;
    const contextSet = new Set(context);
    // CommonUtil.preComputePredicateIndices：按父节点、只数在上下文里的同名子元素。
    const indexMap = new Map<XNode, number>();
    const countMap = new Map<XNode, number>();
    const parents = new Set<DomNode>();
    for (const el of context) {
      const p = el instanceof Pseudo ? null : parentOf(el);
      if (p !== null) parents.add(p);
    }
    for (const parent of parents) {
      const totals = new Map<string, number>();
      const kids = elementChildren(parent);
      this.charge(kids.length);
      for (const child of kids) if (contextSet.has(child)) totals.set(child.name, (totals.get(child.name) ?? 0) + 1);
      const counters = new Map<string, number>();
      for (const child of kids) {
        if (!contextSet.has(child)) continue;
        const idx = (counters.get(child.name) ?? 0) + 1;
        counters.set(child.name, idx);
        indexMap.set(child, idx);
        countMap.set(child, totals.get(child.name)!);
      }
    }
    const kept: XNode[] = [];
    for (const el of context) {
      this.charge();
      const v = this.inScope(new Scope([el], scope), () => this.evaluate(pred));
      switch (v.t) {
        case 'num': {
          let index = this.asLong(v);
          const jxText = el instanceof Pseudo && el.tag === 'JX_TEXT';
          if (index < 0) {
            const count = jxText ? (el as Pseudo).count : countMap.get(el);
            if (count === undefined) evalFailed('XPath 位次谓词作用于无父节点的元素');
            index = count + index + 1;
            if (index < 0) index = 1;
          }
          if (jxText) {
            if (index === (el as Pseudo).index) kept.push(el);
          } else {
            const elIndex = indexMap.get(el);
            if (elIndex === undefined) evalFailed('XPath 位次谓词作用于无父节点的元素');
            if (index === elIndex) kept.push(el);
          }
          break;
        }
        case 'bool':
          if (v.v) kept.push(el);
          break;
        case 'str':
          if (!isBlank(v.v)) kept.push(el);
          break;
        case 'els':
        case 'list':
          if (v.v.length > 0) kept.push(el);
          break;
        default:
          evalFailed('XPath 谓词结果为空值');
      }
    }
    return kept;
  }

  // ---- 轴（AxisSelector 各实现）
  private axis(name: string, context: XNode[]): XNode[] {
    const out: XNode[] = [];
    const push = (nodes: XNode[]) => {
      this.charge(nodes.length);
      for (const n of nodes) out.push(n);
    };
    const siblings = (el: XNode, forward: boolean, elementsOnly: boolean): XNode[] => {
      if (el instanceof Pseudo) return [];
      const res: XNode[] = [];
      for (let s = forward ? el.next : el.prev; s; s = forward ? s.next : s.prev) {
        if (isElementNode(s)) res.push(s);
        else if (!elementsOnly && s.type === 'text') res.push(new Pseudo('text', appendNormalised('', s.data, false), null));
      }
      return res;
    };
    switch (name) {
      case 'ancestor':
        for (const el of context) push(ancestorsOf(el));
        return out;
      case 'ancestor-or-self':
        for (const el of context) push([...ancestorsOf(el), el]);
        return out;
      case 'child':
        for (const el of context) push(elementChildren(el));
        return out;
      case 'descendant':
      case 'descendant-or-self': {
        const seen = new Set<XNode>();
        for (const el of context) {
          for (const d of this.allElements(el)) {
            if ((name === 'descendant' && d === el) || seen.has(d)) continue;
            seen.add(d);
            out.push(d);
          }
        }
        return out;
      }
      case 'following':
        for (const el of context) {
          for (const p of ancestorsOf(el)) for (const s of siblings(p, true, true)) push(this.allElements(s));
          for (const s of siblings(el, true, true)) push(this.allElements(s));
        }
        return out;
      case 'following-sibling':
        for (const el of context) push(siblings(el, true, false));
        return out;
      case 'following-sibling-one':
        for (const el of context) push(siblings(el, true, true).slice(0, 1));
        return out;
      case 'parent':
        for (const el of context) {
          const p = parentOf(el);
          if (p !== null) push([p]);
        }
        return out;
      case 'preceding':
        for (const el of context) {
          for (const p of ancestorsOf(el)) push(siblings(p, false, true));
          push(siblings(el, false, true));
        }
        return out;
      case 'preceding-sibling':
        for (const el of context) push(siblings(el, false, false));
        return out;
      default: // self
        return context;
    }
  }

  // ---- 节点类型（NodeTest 各实现）
  private nodeType(name: string, scope: Scope): XValue {
    const context = scope.context;
    switch (name) {
      case 'text':
        return { t: 'els', v: scope.recursion ? this.textRecursive(context) : this.textDirect(context) };
      case 'allText':
        return { t: 'list', v: context.map((el) => (tagOf(el) === 'script' ? dataOf(el) : this.jsoupText(el))) };
      case 'html':
        return { t: 'list', v: context.map((el) => (el instanceof Pseudo ? escapeHtml(el.raw) : this.$(el).html() ?? '')) };
      case 'outerHtml':
        return { t: 'list', v: context.map((el) => (el instanceof Pseudo ? escapeHtml(el.raw) : this.$.html(el) ?? '')) };
      default: { // num
        const joined = context.map((el) => (tagOf(el) === 'script' ? dataOf(el) : this.jsoupText(el))).join('');
        const m = /\d*\.?\d+/.exec(joined);
        if (!m) return NULL_VALUE;
        return { t: 'num', v: Number(m[0]), int: !m[0].includes('.') };
      }
    }
  }

  private textDirect(context: XNode[]): XNode[] {
    const out: XNode[] = [];
    for (const el of context) {
      if (tagOf(el) === 'script') {
        out.push(new Pseudo('JX_TEXT', dataOf(el), null, 1, 1));
        continue;
      }
      let texts: string[];
      if (el instanceof Pseudo) texts = [el.raw];
      else if (isDataParent(el)) texts = [];
      else texts = el.children.flatMap((c) => (c.type === 'text' ? [c.data] : []));
      this.charge(texts.length);
      texts.forEach((t, i) => out.push(new Pseudo('JX_TEXT', t, null, i + 1, texts.length)));
    }
    return out;
  }

  private textRecursive(context: XNode[]): XNode[] {
    const out: Pseudo[] = [];
    const keys: string[] = [];
    const counter = new Map<string, number>();
    const ids = new Map<XNode, number>();
    const idOf = (node: XNode) => {
      let id = ids.get(node);
      if (id === undefined) { id = ids.size + 1; ids.set(node, id); }
      return id;
    };
    const emit = (raw: string, parent: XNode, depth: number) => {
      const key = `${depth}_${idOf(parent)}`;
      const idx = (counter.get(key) ?? 0) + 1;
      counter.set(key, idx);
      out.push(new Pseudo('JX_TEXT', raw, parent instanceof Pseudo ? null : parent, idx, 0));
      keys.push(key);
    };
    for (const root of context) {
      if (root instanceof Pseudo) { emit(root.raw, root, 1); continue; }
      const walk = (node: DomNode, depth: number) => {
        for (const child of node.children) {
          this.charge();
          if (child.type === 'text') {
            if (!isDataParent(node)) emit(child.data, node, depth + 1);
          } else if (isElementNode(child)) {
            walk(child, depth + 1);
          }
        }
      };
      walk(root, 0);
    }
    out.forEach((p, i) => { p.count = counter.get(keys[i])!; });
    return out;
  }

  // ---- 函数（Function 各实现）
  private call(name: string, args: XExpr[]): XValue {
    const scope = this.cur;
    const params = args.map((a) => this.inScope(new Scope(scope.context, scope), () => this.evaluate(a)));
    const str = (i: number) => this.asString(params[i]);
    switch (name) {
      case 'concat':
        return { t: 'str', v: params.map((p) => this.asString(p)).join('') };
      case 'contains':
        return { t: 'bool', v: str(0).includes(str(1)) };
      case 'count': {
        if (params.length === 0) return { t: 'num', v: 0, int: true };
        const p = params[0];
        if (p.t !== 'els') return evalFailed('XPath count() 参数不是节点集');
        return { t: 'num', v: p.v.length, int: true };
      }
      case 'first':
        return { t: 'num', v: 1, int: true };
      case 'last':
        return { t: 'num', v: this.lastOf(scope), int: true };
      case 'not':
        return { t: 'bool', v: !this.asBoolean(params[0]) };
      case 'position':
        return { t: 'num', v: this.positionOf(scope), int: true };
      case 'starts-with':
        return { t: 'bool', v: str(0).startsWith(str(1)) };
      case 'string-length':
        return { t: 'num', v: params.length === 0 ? 0 : str(0).length, int: true };
      case 'substring': {
        const s = str(0);
        const start = Math.max(this.asLong(params[1]) - 1, 0);
        const end = Math.min(start + this.asLong(params[2]), s.length);
        return { t: 'str', v: end < start ? '' : s.slice(start, end) };
      }
      case 'substring-after': {
        const s = str(0);
        const sep = str(1);
        if (s === '') return { t: 'str', v: s };
        const pos = s.indexOf(sep);
        return { t: 'str', v: pos < 0 ? '' : s.slice(pos + sep.length) };
      }
      case 'substring-after-last': {
        const s = str(0);
        const sep = str(1);
        if (s === '' || sep === '') return { t: 'str', v: '' };
        const pos = s.lastIndexOf(sep);
        return { t: 'str', v: pos < 0 || pos === s.length - sep.length ? '' : s.slice(pos + sep.length) };
      }
      case 'substring-before': {
        const s = str(0);
        const sep = str(1);
        if (s === '') return { t: 'str', v: s };
        if (sep === '') return { t: 'str', v: '' };
        const pos = s.indexOf(sep);
        return { t: 'str', v: pos < 0 ? s : s.slice(0, pos) };
      }
      default: { // substring-before-last
        const s = str(0);
        const sep = str(1);
        if (s === '' || sep === '') return { t: 'str', v: s };
        const pos = s.lastIndexOf(sep);
        return { t: 'str', v: pos < 0 ? s : s.slice(0, pos) };
      }
    }
  }

  private singleEl(scope: Scope): XNode {
    if (scope.context.length !== 1) evalFailed('XPath 位次函数要求单元素上下文');
    return scope.context[0];
  }

  /** CommonUtil.getElIndexInSameTags(e, scope.getParent())：父节点子元素里同名且在父作用域上下文中的位次。 */
  private positionOf(scope: Scope): number {
    const el = this.singleEl(scope);
    const parentScope = scope.parent!;
    const parent = parentOf(el);
    if (parent === null) evalFailed('XPath position() 作用于无父节点的元素');
    let byParent = this.siblingIndexCache.get(parentScope.context);
    if (!byParent) { byParent = new Map(); this.siblingIndexCache.set(parentScope.context, byParent); }
    let ranks = byParent.get(parent);
    if (!ranks) {
      const ctxSet = new Set(parentScope.context);
      const counters = new Map<string, number>();
      const built: Map<XNode, number> & { totals?: Map<string, number> } = new Map();
      const kids = elementChildren(parent);
      this.charge(kids.length);
      for (const child of kids) {
        if (!ctxSet.has(child)) continue;
        const idx = (counters.get(child.name) ?? 0) + 1;
        counters.set(child.name, idx);
        built.set(child, idx);
      }
      built.totals = counters;
      ranks = built;
      byParent.set(parent, ranks);
    }
    return ranks.get(el) ?? (ranks.totals!.get(tagOf(el)) ?? 0) + 1;
  }

  /** CommonUtil.sameTagElNums(e, scope.getParent())：父节点子树（含父自身）里同名且在父作用域上下文中的个数。 */
  private lastOf(scope: Scope): number {
    const el = this.singleEl(scope);
    const parentScope = scope.parent!;
    const parent = parentOf(el);
    if (parent === null) evalFailed('XPath last() 作用于无父节点的元素');
    const tag = tagOf(el).toLowerCase();
    let byParent = this.subtreeCountCache.get(parentScope.context);
    if (!byParent) { byParent = new Map(); this.subtreeCountCache.set(parentScope.context, byParent); }
    let byTag = byParent.get(parent);
    if (!byTag) { byTag = new Map(); byParent.set(parent, byTag); }
    let count = byTag.get(tag);
    if (count === undefined) {
      const ctxSet = new Set(parentScope.context);
      count = 0;
      for (const node of this.allElements(parent)) if (tagOf(node).toLowerCase() === tag && ctxSet.has(node)) count += 1;
      byTag.set(tag, count);
    }
    return count;
  }

  /** 最终输出：全是真元素 → 节点；否则逐项文本（JX_TEXT 取 ownText，legado JXNode.asString 口径）。 */
  output(value: XValue, multi: boolean): XPathOutput {
    switch (value.t) {
      case 'els': {
        if (value.v.every((n) => !(n instanceof Pseudo))) return { kind: 'nodes', nodes: value.v as DomNode[] };
        return {
          kind: 'values',
          values: value.v.map((n) => {
            if (n instanceof Pseudo) return ownTextOf(n);
            return multi ? this.$.html(n) ?? '' : this.$(n).text().trim();
          }),
        };
      }
      case 'list':
        return { kind: 'values', values: value.v };
      case 'null':
        return { kind: 'values', values: [] };
      case 'str':
        return { kind: 'values', values: [value.v] };
      default:
        return { kind: 'values', values: [this.asString(value)] };
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type XPathOutput = { kind: 'nodes'; nodes: AnyNode[] } | { kind: 'values'; values: string[] };

/**
 * 在 HTML 作用域上求值。`roots` 为作用域节点：文档根按 JsoupXpath（JXDocument 上下文 = doc.children()）
 * 换成其元素子节点，条目作用域就是该元素本身。urlAttr 的值逐个绝对化，失败的丢弃。
 */
export function evaluateXPath(program: XPathProgram, $: CheerioAPI, roots: AnyNode[], pageUrl: string, multi = false): XPathOutput {
  const context: XNode[] = [];
  for (const node of roots) {
    if (node.type === 'root') context.push(...node.children.filter(isElementNode));
    else if (isElementNode(node)) context.push(node);
  }
  const evaluator = new Evaluator($, context);
  const out = evaluator.output(evaluator.evaluate(program.expr), multi);
  if (out.kind === 'values' && program.urlAttr) {
    return { kind: 'values', values: out.values.flatMap((v) => absolutizeUrl(v, pageUrl) ?? []) };
  }
  return out;
}
