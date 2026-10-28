// jsoup1028：jsoup 1.16.2 CSS 选择器（ENGINE_SYNTAX_JSOUP）。逐条移植 TokenQueue / QueryParser / Evaluator /
// StructuralEvaluator / CombiningEvaluator / Collector / Selector：同样的解析树、同样的按 cost 稳定排序求值顺序，
// 使我们只在 jsoup 也会求值到的位置才 fatal。正则类（:matches*、[k~=re]、:matchText）、非 ASCII 数字下标、
// 大小写映射改变长度的文本等口径不定的形态一律 fatal；jsoup 抛 SelectorParseException 的输入也 fatal（规则 JS 可能
// catch 它走别的分支，不猜）。

import {
  chargeVisits, checkSelectVisit, dataOf, docGuard, elementChildren, elementSiblingIndex, hasAttrOf,
  attrOf, attributeNames, hasClassOf, idOf, isBlankString, isCommentNode, isDocument, isElement, isJElement,
  isJsoupWhitespace, isTextNode, javaEqualsIgnoreCase, javaRegionMatchesIgnoreCase, javaTrim, jsoupFatal,
  nextElementSibling, normalName, normaliseWhitespace, ownTextOf, parentElement, previousElementSibling,
  siblingElements, textOf, traverse, wholeOwnTextOf, wholeTextOf, type DocGuard, type JElement,
} from './jsoup-dom';

// ---------------------------------------------------------------- Java 口径小工具
/** Normalizer.lowerCase（Locale.ENGLISH）：会改变长度的映射（İ）与希腊大写 Σ（词尾形各实现不一）口径不定 → fatal。 */
function lower(s: string): string {
  const out = s.toLowerCase();
  if (out.length !== s.length || s.includes('Σ')) jsoupFatal('大小写映射口径不定');
  return out;
}

/** Normalizer.normalize：lowerCase + Java trim。 */
function normalize(s: string): string {
  return javaTrim(lower(s));
}

/** Validate.notEmpty。 */
function notEmpty(s: string, what: string): void {
  if (s.length === 0) jsoupFatal(`选择器 ${what} 为空`);
}

const INT_MAX = 2147483647;

/** Integer.parseInt（只收 ASCII 数字；溢出或其他形态 jsoup 抛异常 → fatal）。 */
function javaParseInt(s: string): number {
  if (!/^[+-]?[0-9]+$/.test(s)) return jsoupFatal(`数字 ${JSON.stringify(s)} 解析失败`);
  const n = Number(s);
  if (n > INT_MAX || n < -INT_MAX - 1) return jsoupFatal('数字溢出');
  return n;
}

/** Character.isLetterOrDigit(char)（逐 UTF-16 单元；代理项不算）。 */
function isLetterOrDigitUnit(ch: string): boolean {
  return /^[\p{L}\p{Nd}]$/u.test(ch);
}

// ---------------------------------------------------------------- TokenQueue
const ESC = '\\';

class TokenQueue {
  private pos = 0;

  constructor(private readonly queue: string) {}

  isEmpty(): boolean {
    return this.queue.length - this.pos === 0;
  }

  private remainingLength(): number {
    return this.queue.length - this.pos;
  }

  matches(seq: string): boolean {
    return javaRegionMatchesIgnoreCase(this.queue, this.pos, seq, 0, seq.length);
  }

  matchesAnyString(seqs: readonly string[]): boolean {
    for (const s of seqs) if (this.matches(s)) return true;
    return false;
  }

  matchesAnyChar(chars: readonly string[]): boolean {
    if (this.isEmpty()) return false;
    const c = this.queue[this.pos];
    return chars.includes(c);
  }

  matchChomp(seq: string): boolean {
    if (!this.matches(seq)) return false;
    this.pos += seq.length;
    return true;
  }

  matchesWhitespace(): boolean {
    return !this.isEmpty() && isJsoupWhitespace(this.queue.charCodeAt(this.pos));
  }

  matchesWord(): boolean {
    return !this.isEmpty() && isLetterOrDigitUnit(this.queue[this.pos]);
  }

  consume(): string {
    if (this.isEmpty()) return jsoupFatal('选择器意外结束');
    const c = this.queue[this.pos];
    this.pos += 1;
    return c;
  }

  consumeToAny(seqs: readonly string[]): string {
    const start = this.pos;
    while (!this.isEmpty() && !this.matchesAnyString(seqs)) this.pos += 1;
    return this.queue.slice(start, this.pos);
  }

  chompBalanced(open: string, close: string): string {
    let start = -1;
    let end = -1;
    let depth = 0;
    let last = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inRegexQE = false;
    do {
      if (this.isEmpty()) break;
      const c = this.consume();
      if (last !== ESC) {
        if (c === "'" && c !== open && !inDoubleQuote) inSingleQuote = !inSingleQuote;
        else if (c === '"' && c !== open && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
        if (inSingleQuote || inDoubleQuote || inRegexQE) {
          last = c;
          continue;
        }
        if (c === open) {
          depth += 1;
          if (start === -1) start = this.pos;
        } else if (c === close) {
          depth -= 1;
        }
      } else if (c === 'Q') {
        inRegexQE = true;
      } else if (c === 'E') {
        inRegexQE = false;
      }
      if (depth > 0 && last !== '') end = this.pos;
      last = c;
    } while (depth > 0);
    const out = end >= 0 ? this.queue.slice(start, end) : '';
    if (depth > 0) jsoupFatal('选择器括号不配对');
    return out;
  }

  consumeWhitespace(): boolean {
    let seen = false;
    while (this.matchesWhitespace()) {
      this.pos += 1;
      seen = true;
    }
    return seen;
  }

  consumeElementSelector(): string {
    return this.consumeEscapedCssIdentifier(['*|', '|', '_', '-']);
  }

  consumeCssIdentifier(): string {
    return this.consumeEscapedCssIdentifier(['-', '_']);
  }

  private consumeEscapedCssIdentifier(matches: readonly string[]): string {
    const start = this.pos;
    let escaped = false;
    while (!this.isEmpty()) {
      if (this.queue[this.pos] === ESC && this.remainingLength() > 1) {
        escaped = true;
        this.pos += 2;
      } else if (this.matchesWord() || this.matchesAnyString(matches)) {
        this.pos += 1;
      } else {
        break;
      }
    }
    const consumed = this.queue.slice(start, this.pos);
    return escaped ? unescape(consumed) : consumed;
  }

  remainder(): string {
    const rest = this.queue.slice(this.pos);
    this.pos = this.queue.length;
    return rest;
  }
}

/** TokenQueue.unescape：`\\` → `\`，单个 `\` 丢弃。 */
function unescape(input: string): string {
  let out = '';
  let last = '';
  for (let c of input) {
    // 逐 UTF-16 单元（Java toCharArray）
    if (c.length > 1) {
      out += c;
      last = c[c.length - 1];
      continue;
    }
    if (c === ESC) {
      if (last === ESC) {
        out += c;
        c = '\0';
      }
    } else {
      out += c;
    }
    last = c;
  }
  return out;
}

// ---------------------------------------------------------------- Evaluator
type Root = JElement;

abstract class Evaluator {
  abstract matches(root: Root, el: JElement): boolean;

  cost(): number {
    return 5;
  }

  reset(): void {}
}

class TagEval extends Evaluator {
  constructor(private readonly tagName: string) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return normalName(el) === this.tagName;
  }

  override cost(): number {
    return 1;
  }
}

class TagEndsWith extends Evaluator {
  constructor(private readonly tagName: string) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return normalName(el).endsWith(this.tagName);
  }
}

class IdEval extends Evaluator {
  constructor(private readonly id: string) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return this.id === idOf(el);
  }

  override cost(): number {
    return 2;
  }
}

class ClassEval extends Evaluator {
  constructor(private readonly className: string) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return hasClassOf(el, this.className);
  }

  override cost(): number {
    return 6;
  }
}

class AttributeEval extends Evaluator {
  constructor(private readonly key: string) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return hasAttrOf(el, this.key);
  }

  override cost(): number {
    return 2;
  }
}

class AttributeStarting extends Evaluator {
  private readonly keyPrefix: string;

  constructor(keyPrefix: string) {
    super();
    notEmpty(keyPrefix, '属性前缀');
    this.keyPrefix = lower(keyPrefix);
  }

  matches(_root: Root, el: JElement): boolean {
    for (const key of attributeNames(el)) if (lower(key).startsWith(this.keyPrefix)) return true;
    return false;
  }

  override cost(): number {
    return 6;
  }
}

/** AttributeKeyPair：key normalize；值去一层引号；trimValue 时 normalize，否则字面量只小写。 */
abstract class AttributeKeyPair extends Evaluator {
  protected readonly key: string;
  protected readonly value: string;

  constructor(key: string, value: string, trimValue = true) {
    super();
    notEmpty(key, '属性名');
    notEmpty(value, '属性值');
    this.key = normalize(key);
    let v = value;
    const isStringLiteral = (v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'));
    if (isStringLiteral) v = v.slice(1, v.length - 1);
    this.value = trimValue ? normalize(v) : (isStringLiteral ? lower(v) : normalize(v));
  }
}

class AttributeWithValue extends AttributeKeyPair {
  matches(_root: Root, el: JElement): boolean {
    return hasAttrOf(el, this.key) && javaEqualsIgnoreCase(this.value, javaTrim(attrOf(el, this.key)));
  }

  override cost(): number {
    return 3;
  }
}

class AttributeWithValueNot extends AttributeKeyPair {
  matches(_root: Root, el: JElement): boolean {
    return !javaEqualsIgnoreCase(this.value, attrOf(el, this.key));
  }

  override cost(): number {
    return 3;
  }
}

class AttributeWithValueStarting extends AttributeKeyPair {
  constructor(key: string, value: string) {
    super(key, value, false);
  }

  matches(_root: Root, el: JElement): boolean {
    return hasAttrOf(el, this.key) && lower(attrOf(el, this.key)).startsWith(this.value);
  }

  override cost(): number {
    return 4;
  }
}

class AttributeWithValueEnding extends AttributeKeyPair {
  constructor(key: string, value: string) {
    super(key, value, false);
  }

  matches(_root: Root, el: JElement): boolean {
    return hasAttrOf(el, this.key) && lower(attrOf(el, this.key)).endsWith(this.value);
  }

  override cost(): number {
    return 4;
  }
}

class AttributeWithValueContaining extends AttributeKeyPair {
  matches(_root: Root, el: JElement): boolean {
    return hasAttrOf(el, this.key) && lower(attrOf(el, this.key)).includes(this.value);
  }

  override cost(): number {
    return 6;
  }
}

class AllElements extends Evaluator {
  matches(): boolean {
    return true;
  }

  override cost(): number {
    return 10;
  }
}

class IndexLessThan extends Evaluator {
  constructor(private readonly index: number) {
    super();
  }

  matches(root: Root, el: JElement): boolean {
    return root !== el && elementSiblingIndex(el) < this.index;
  }
}

class IndexGreaterThan extends Evaluator {
  constructor(private readonly index: number) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return elementSiblingIndex(el) > this.index;
  }
}

class IndexEquals extends Evaluator {
  constructor(private readonly index: number) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return elementSiblingIndex(el) === this.index;
  }
}

function firstElementChild(el: JElement): JElement | null {
  for (const child of el.children) if (isElement(child)) return child;
  return null;
}

function lastElementChild(el: JElement): JElement | null {
  for (let i = el.children.length - 1; i >= 0; i -= 1) {
    const child = el.children[i];
    if (isElement(child)) return child;
  }
  return null;
}

class IsLastChild extends Evaluator {
  matches(_root: Root, el: JElement): boolean {
    const p = parentElement(el);
    return p !== null && !isDocument(p) && el === lastElementChild(p);
  }
}

class IsFirstChild extends Evaluator {
  matches(_root: Root, el: JElement): boolean {
    const p = parentElement(el);
    return p !== null && !isDocument(p) && el === firstElementChild(p);
  }
}

type NthKind = 'child' | 'last-child' | 'of-type' | 'last-of-type';

/** CssNthEvaluator（Java int 运算）。 */
class CssNth extends Evaluator {
  constructor(private readonly kind: NthKind, private readonly a: number, private readonly b: number) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    const p = parentElement(el);
    if (p === null || isDocument(p)) return false;
    const pos = this.position(el, p);
    if (this.a === 0) return pos === this.b;
    const d = (pos - this.b) | 0;
    return Math.imul(d, this.a) >= 0 && d % this.a === 0;
  }

  private position(el: JElement, parent: JElement): number {
    switch (this.kind) {
      case 'child':
        return elementSiblingIndex(el) + 1;
      case 'last-child':
        return elementChildren(parent).length - elementSiblingIndex(el);
      case 'of-type': {
        let pos = 0;
        const name = normalName(el);
        for (const node of parent.children) {
          if (normalName(node) === name) pos += 1;
          if (node === el) break;
        }
        return pos;
      }
      default: {
        let pos = 0;
        const name = normalName(el);
        for (let next: JElement | null = el; next !== null; next = nextElementSibling(next)) {
          if (normalName(next) === name) pos += 1;
        }
        return pos;
      }
    }
  }
}

class IsRoot extends Evaluator {
  matches(root: Root, el: JElement): boolean {
    const r = isDocument(root) ? firstElementChild(root) : root;
    return el === r;
  }

  override cost(): number {
    return 1;
  }
}

class IsOnlyChild extends Evaluator {
  matches(_root: Root, el: JElement): boolean {
    const p = parentElement(el);
    return p !== null && !isDocument(p) && siblingElements(el).length === 0;
  }
}

class IsOnlyOfType extends Evaluator {
  matches(_root: Root, el: JElement): boolean {
    const p = parentElement(el);
    if (p === null || isDocument(p)) return false;
    let pos = 0;
    const name = normalName(el);
    for (let next = firstElementChild(p); next !== null; next = nextElementSibling(next)) {
      if (normalName(next) === name) pos += 1;
      if (pos > 1) break;
    }
    return pos === 1;
  }
}

class IsEmpty extends Evaluator {
  matches(_root: Root, el: JElement): boolean {
    for (const n of el.children) {
      if (isTextNode(n)) return isBlankString(n.data);
      if (!(isCommentNode(n) || (n.type === 'directive'))) return false;
    }
    return true;
  }
}

class ContainsText extends Evaluator {
  private readonly searchText: string;

  constructor(searchText: string) {
    super();
    this.searchText = lower(normaliseWhitespace(searchText));
  }

  matches(_root: Root, el: JElement): boolean {
    return lower(textOf(el)).includes(this.searchText);
  }

  override cost(): number {
    return 10;
  }
}

class ContainsWholeText extends Evaluator {
  constructor(private readonly searchText: string) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return wholeTextOf(el).includes(this.searchText);
  }

  override cost(): number {
    return 10;
  }
}

class ContainsWholeOwnText extends Evaluator {
  constructor(private readonly searchText: string) {
    super();
  }

  matches(_root: Root, el: JElement): boolean {
    return wholeOwnTextOf(el).includes(this.searchText);
  }
}

class ContainsData extends Evaluator {
  private readonly searchText: string;

  constructor(searchText: string) {
    super();
    this.searchText = lower(searchText);
  }

  matches(_root: Root, el: JElement): boolean {
    return lower(dataOf(el)).includes(this.searchText);
  }
}

class ContainsOwnText extends Evaluator {
  private readonly searchText: string;

  constructor(searchText: string) {
    super();
    this.searchText = lower(normaliseWhitespace(searchText));
  }

  matches(_root: Root, el: JElement): boolean {
    return lower(ownTextOf(el)).includes(this.searchText);
  }
}

// ---------------------------------------------------------------- StructuralEvaluator
abstract class StructuralEvaluator extends Evaluator {
  private memo = new Map<JElement, Map<JElement, boolean>>();

  constructor(protected readonly evaluator: Evaluator) {
    super();
  }

  protected memoMatches(root: Root, el: JElement): boolean {
    let byRoot = this.memo.get(root);
    if (!byRoot) {
      byRoot = new Map();
      this.memo.set(root, byRoot);
    }
    let hit = byRoot.get(el);
    if (hit === undefined) {
      hit = this.evaluator.matches(root, el);
      byRoot.set(el, hit);
    }
    return hit;
  }

  override reset(): void {
    this.memo = new Map();
  }
}

class RootEval extends Evaluator {
  matches(root: Root, el: JElement): boolean {
    return root === el;
  }

  override cost(): number {
    return 1;
  }
}

class Has extends StructuralEvaluator {
  matches(_root: Root, el: JElement): boolean {
    for (const node of el.children) {
      if (isElement(node) && findFrom(this.evaluator, el, node) !== null) return true;
    }
    return false;
  }

  override cost(): number {
    return 10 * this.evaluator.cost();
  }
}

class Not extends StructuralEvaluator {
  matches(root: Root, el: JElement): boolean {
    return !this.memoMatches(root, el);
  }

  override cost(): number {
    return 2 + this.evaluator.cost();
  }
}

class ParentEval extends StructuralEvaluator {
  matches(root: Root, el: JElement): boolean {
    if (root === el) return false;
    let parent = parentElement(el);
    while (parent !== null) {
      chargeVisits();
      if (this.memoMatches(root, parent)) return true;
      if (parent === root) break;
      parent = parentElement(parent);
    }
    return false;
  }

  override cost(): number {
    return 2 * this.evaluator.cost();
  }
}

class ImmediateParentRun extends Evaluator {
  readonly evaluators: Evaluator[] = [];
  private runCost = 2;

  constructor(evaluator: Evaluator) {
    super();
    this.add(evaluator);
  }

  add(evaluator: Evaluator): void {
    this.evaluators.push(evaluator);
    this.runCost += evaluator.cost();
  }

  matches(root: Root, element: JElement): boolean {
    let el: JElement | null = element;
    for (let i = this.evaluators.length - 1; i >= 0; i -= 1) {
      if (el === null) return false;
      if (!this.evaluators[i].matches(root, el)) return false;
      el = parentElement(el);
    }
    return true;
  }

  override cost(): number {
    return this.runCost;
  }
  // jsoup 的 ImmediateParentRun 不覆写 reset：内层结构求值的缓存不随 collect 清空（按 root 分桶，DOM 不变时等价）。
}

class PreviousSibling extends StructuralEvaluator {
  matches(root: Root, el: JElement): boolean {
    if (root === el) return false;
    const parent = parentElement(el);
    let sibling: JElement | null = parent ? firstElementChild(parent) : el;
    while (sibling !== null) {
      chargeVisits();
      if (sibling === el) break;
      if (this.memoMatches(root, sibling)) return true;
      sibling = nextElementSibling(sibling);
    }
    return false;
  }

  override cost(): number {
    return 3 * this.evaluator.cost();
  }
}

class ImmediatePreviousSibling extends StructuralEvaluator {
  matches(root: Root, el: JElement): boolean {
    if (root === el) return false;
    const prev = previousElementSibling(el);
    return prev !== null && this.memoMatches(root, prev);
  }

  override cost(): number {
    return 2 + this.evaluator.cost();
  }
}

// ---------------------------------------------------------------- CombiningEvaluator
abstract class CombiningEvaluator extends Evaluator {
  readonly evaluators: Evaluator[] = [];
  protected sorted: Evaluator[] = [];
  protected num = 0;
  private combinedCost = 0;

  override reset(): void {
    for (const e of this.evaluators) e.reset();
  }

  override cost(): number {
    return this.combinedCost;
  }

  rightMostEvaluator(): Evaluator | null {
    return this.num > 0 ? this.evaluators[this.num - 1] : null;
  }

  replaceRightMostEvaluator(replacement: Evaluator): void {
    this.evaluators[this.num - 1] = replacement;
    this.updateEvaluators();
  }

  protected updateEvaluators(): void {
    this.num = this.evaluators.length;
    let cost = 0;
    for (const e of this.evaluators) cost = (cost + e.cost()) | 0;
    this.combinedCost = cost;
    // Collections.sort 是稳定排序；Array.prototype.sort 同样稳定
    this.sorted = [...this.evaluators].sort((x, y) => (x.cost() - y.cost()) | 0);
  }
}

class And extends CombiningEvaluator {
  constructor(evaluators: readonly Evaluator[]) {
    super();
    this.evaluators.push(...evaluators);
    this.updateEvaluators();
  }

  matches(root: Root, el: JElement): boolean {
    for (let i = 0; i < this.num; i += 1) if (!this.sorted[i].matches(root, el)) return false;
    return true;
  }
}

class Or extends CombiningEvaluator {
  constructor(evaluators: readonly Evaluator[] = []) {
    super();
    // jsoup Or(Collection) 里 num 恒为 0：总是逐个加入
    this.evaluators.push(...evaluators);
    this.updateEvaluators();
  }

  add(e: Evaluator): void {
    this.evaluators.push(e);
    this.updateEvaluators();
  }

  matches(root: Root, el: JElement): boolean {
    for (let i = 0; i < this.num; i += 1) if (this.sorted[i].matches(root, el)) return true;
    return false;
  }
}

// ---------------------------------------------------------------- QueryParser
const COMBINATORS = [',', '>', '+', '~', ' '];
const ATTRIBUTE_EVALS = ['=', '!=', '^=', '$=', '*=', '~='];
const SPACE = '[ \\t\\n\\x0B\\f\\r]';
const NTH_AB = new RegExp(`^(([+-])?(\\d+)?)n(${SPACE}*([+-])?${SPACE}*\\d+)?$`, 'i');
const NTH_B = /^([+-])?(\d+)$/;

class QueryParser {
  private readonly tq: TokenQueue;
  private readonly query: string;
  private readonly evals: Evaluator[] = [];

  constructor(query: string) {
    notEmpty(query, '查询');
    this.query = javaTrim(query);
    this.tq = new TokenQueue(this.query);
  }

  static parse(query: string): Evaluator {
    return new QueryParser(query).parse();
  }

  parse(): Evaluator {
    const tq = this.tq;
    tq.consumeWhitespace();
    if (tq.matchesAnyChar(COMBINATORS)) {
      this.evals.push(new RootEval());
      this.combinator(tq.consume());
    } else {
      this.evals.push(this.consumeEvaluator());
    }
    while (!tq.isEmpty()) {
      const seenWhite = tq.consumeWhitespace();
      if (tq.matchesAnyChar(COMBINATORS)) this.combinator(tq.consume());
      else if (seenWhite) this.combinator(' ');
      else this.evals.push(this.consumeEvaluator());
    }
    if (this.evals.length === 1) return this.evals[0];
    return new And(this.evals);
  }

  private combinator(combinator: string): void {
    this.tq.consumeWhitespace();
    const subQuery = this.consumeSubQuery();
    const newEval = QueryParser.parse(subQuery);
    let rootEval: Evaluator;
    let currentEval: Evaluator;
    let replaceRightMost = false;
    if (this.evals.length === 1) {
      rootEval = this.evals[0];
      currentEval = rootEval;
      if (rootEval instanceof Or && combinator !== ',') {
        currentEval = rootEval.rightMostEvaluator() as Evaluator;
        replaceRightMost = true;
      }
    } else {
      rootEval = new And(this.evals);
      currentEval = rootEval;
    }
    this.evals.length = 0;
    switch (combinator) {
      case '>': {
        const run = currentEval instanceof ImmediateParentRun ? currentEval : new ImmediateParentRun(currentEval);
        run.add(newEval);
        currentEval = run;
        break;
      }
      case ' ':
        currentEval = new And([new ParentEval(currentEval), newEval]);
        break;
      case '+':
        currentEval = new And([new ImmediatePreviousSibling(currentEval), newEval]);
        break;
      case '~':
        currentEval = new And([new PreviousSibling(currentEval), newEval]);
        break;
      case ',': {
        let or: Or;
        if (currentEval instanceof Or) {
          or = currentEval;
        } else {
          or = new Or();
          or.add(currentEval);
        }
        or.add(newEval);
        currentEval = or;
        break;
      }
      default:
        jsoupFatal(`未知组合符 ${combinator}`);
    }
    if (replaceRightMost) (rootEval as Or).replaceRightMostEvaluator(currentEval);
    else rootEval = currentEval;
    this.evals.push(rootEval);
  }

  private consumeSubQuery(): string {
    const tq = this.tq;
    let sq = '';
    while (!tq.isEmpty()) {
      if (tq.matches('(')) sq += `(${tq.chompBalanced('(', ')')})`;
      else if (tq.matches('[')) sq += `[${tq.chompBalanced('[', ']')}]`;
      else if (tq.matchesAnyChar(COMBINATORS)) {
        if (sq.length > 0) break;
        tq.consume();
      } else sq += tq.consume();
    }
    return sq;
  }

  private consumeEvaluator(): Evaluator {
    const tq = this.tq;
    if (tq.matchChomp('#')) return this.byId();
    if (tq.matchChomp('.')) return this.byClass();
    if (tq.matchesWord() || tq.matches('*|')) return this.byTag();
    if (tq.matches('[')) return this.byAttribute();
    if (tq.matchChomp('*')) return new AllElements();
    if (tq.matchChomp(':')) return this.parsePseudoSelector();
    return jsoupFatal(`选择器 ${JSON.stringify(this.query)} 无法解析`);
  }

  private parsePseudoSelector(): Evaluator {
    const pseudo = this.tq.consumeCssIdentifier();
    switch (pseudo) {
      case 'lt': return new IndexLessThan(this.consumeIndex());
      case 'gt': return new IndexGreaterThan(this.consumeIndex());
      case 'eq': return new IndexEquals(this.consumeIndex());
      case 'has': return this.has();
      case 'contains': return new ContainsText(this.consumeText(':contains'));
      case 'containsOwn': return new ContainsOwnText(this.consumeText(':containsOwn'));
      case 'containsWholeText': return new ContainsWholeText(this.consumeText(':containsWholeText'));
      case 'containsWholeOwnText': return new ContainsWholeOwnText(this.consumeText(':containsWholeOwnText'));
      case 'containsData': return new ContainsData(this.consumeText(':containsData'));
      case 'not': return this.not();
      case 'nth-child': return this.cssNthChild('child');
      case 'nth-last-child': return this.cssNthChild('last-child');
      case 'nth-of-type': return this.cssNthChild('of-type');
      case 'nth-last-of-type': return this.cssNthChild('last-of-type');
      case 'first-child': return new IsFirstChild();
      case 'last-child': return new IsLastChild();
      case 'first-of-type': return new CssNth('of-type', 0, 1);
      case 'last-of-type': return new CssNth('last-of-type', 0, 1);
      case 'only-child': return new IsOnlyChild();
      case 'only-of-type': return new IsOnlyOfType();
      case 'empty': return new IsEmpty();
      case 'root': return new IsRoot();
      case 'matches': case 'matchesOwn': case 'matchesWholeText': case 'matchesWholeOwnText': case 'matchText':
        return jsoupFatal(`:${pseudo} 正则口径不复现`);
      default:
        return jsoupFatal(`选择器 ${JSON.stringify(this.query)} 无法解析`);
    }
  }

  private byId(): Evaluator {
    const id = this.tq.consumeCssIdentifier();
    notEmpty(id, 'id');
    return new IdEval(id);
  }

  private byClass(): Evaluator {
    const className = this.tq.consumeCssIdentifier();
    notEmpty(className, 'class');
    return new ClassEval(javaTrim(className));
  }

  private byTag(): Evaluator {
    let tagName = normalize(this.tq.consumeElementSelector());
    notEmpty(tagName, '标签');
    if (tagName.startsWith('*|')) {
      return new Or([new TagEval(tagName.slice(2)), new TagEndsWith(tagName.replaceAll('*|', ':'))]);
    }
    if (tagName.includes('|')) tagName = tagName.replaceAll('|', ':');
    return new TagEval(tagName);
  }

  private byAttribute(): Evaluator {
    const cq = new TokenQueue(this.tq.chompBalanced('[', ']'));
    const key = cq.consumeToAny(ATTRIBUTE_EVALS);
    notEmpty(key, '属性名');
    cq.consumeWhitespace();
    if (cq.isEmpty()) {
      if (key.startsWith('^')) return new AttributeStarting(key.slice(1));
      return new AttributeEval(key);
    }
    if (cq.matchChomp('=')) return new AttributeWithValue(key, cq.remainder());
    if (cq.matchChomp('!=')) return new AttributeWithValueNot(key, cq.remainder());
    if (cq.matchChomp('^=')) return new AttributeWithValueStarting(key, cq.remainder());
    if (cq.matchChomp('$=')) return new AttributeWithValueEnding(key, cq.remainder());
    if (cq.matchChomp('*=')) return new AttributeWithValueContaining(key, cq.remainder());
    if (cq.matchChomp('~=')) return jsoupFatal('[k~=正则] 口径不复现');
    return jsoupFatal(`属性选择器 ${JSON.stringify(this.query)} 无法解析`);
  }

  private cssNthChild(kind: NthKind): Evaluator {
    const arg = normalize(this.tq.chompBalanced('(', ')'));
    let a: number;
    let b: number;
    const mAB = NTH_AB.exec(arg);
    const mB = NTH_B.exec(arg);
    if (arg === 'odd') {
      a = 2;
      b = 1;
    } else if (arg === 'even') {
      a = 2;
      b = 0;
    } else if (mAB) {
      a = mAB[3] !== undefined ? javaParseInt(mAB[1].replace(/^\+/, '')) : 1;
      b = mAB[4] !== undefined ? javaParseInt(mAB[4].replace(/^\+/, '')) : 0;
    } else if (mB) {
      a = 0;
      b = javaParseInt(mB[0].replace(/^\+/, ''));
    } else {
      return jsoupFatal(`nth 参数 ${JSON.stringify(arg)} 无法解析`);
    }
    return new CssNth(kind, a, b);
  }

  private consumeIndex(): number {
    const index = javaTrim(this.tq.chompBalanced('(', ')'));
    if (!/^[0-9]+$/.test(index)) return jsoupFatal('下标须为数字');
    return javaParseInt(index);
  }

  private has(): Evaluator {
    const subQuery = this.tq.chompBalanced('(', ')');
    notEmpty(subQuery, ':has');
    return new Has(QueryParser.parse(subQuery));
  }

  private consumeText(what: string): string {
    const searchText = unescape(this.tq.chompBalanced('(', ')'));
    notEmpty(searchText, what);
    return searchText;
  }

  private not(): Evaluator {
    const subQuery = this.tq.chompBalanced('(', ')');
    notEmpty(subQuery, ':not');
    return new Not(QueryParser.parse(subQuery));
  }
}

// ---------------------------------------------------------------- Collector / Selector
/** FirstFinder.find(evalRoot, start)：从 start 先序遍历，首个命中即停。 */
function findFrom(evaluator: Evaluator, evalRoot: JElement, start: JElement): JElement | null {
  const guard = docGuard(start);
  let match: JElement | null = null;
  traverse(start, (node) => {
    if (!isJElement(node)) return false;
    checkSelectVisit(node, guard);
    if (evaluator.matches(evalRoot, node)) {
      match = node;
      return true;
    }
    return false;
  });
  return match;
}

/** Collector.collect：reset 后从 root（含自身）先序遍历。 */
function collect(evaluator: Evaluator, root: JElement): JElement[] {
  evaluator.reset();
  const guard: DocGuard = docGuard(root);
  const out: JElement[] = [];
  traverse(root, (node) => {
    if (!isJElement(node)) return;
    checkSelectVisit(node, guard);
    if (evaluator.matches(root, node)) out.push(node);
  });
  return out;
}

/** Element.select(cssQuery)。 */
export function select(query: string, root: JElement): JElement[] {
  notEmpty(query, '查询');
  return collect(QueryParser.parse(query), root);
}

/** Elements.select(cssQuery)：只解析一次，各根结果按身份去重、保持出现顺序。 */
export function selectRoots(query: string, roots: readonly JElement[]): JElement[] {
  notEmpty(query, '查询');
  const evaluator = QueryParser.parse(query);
  const seen = new Set<JElement>();
  const out: JElement[] = [];
  for (const root of roots) {
    for (const el of collect(evaluator, root)) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

/** Element.selectFirst(cssQuery)。 */
export function selectFirst(query: string, root: JElement): JElement | null {
  notEmpty(query, '查询');
  const evaluator = QueryParser.parse(query);
  evaluator.reset();
  return findFrom(evaluator, root, root);
}

/** Element.getElementsByTag。 */
export function getElementsByTag(root: JElement, tagName: string): JElement[] {
  notEmpty(tagName, '标签');
  return collect(new TagEval(normalize(tagName)), root);
}

/** Element.getElementById。 */
export function getElementById(root: JElement, id: string): JElement | null {
  notEmpty(id, 'id');
  return collect(new IdEval(id), root)[0] ?? null;
}

/** Element.getElementsByClass。 */
export function getElementsByClass(root: JElement, className: string): JElement[] {
  notEmpty(className, 'class');
  return collect(new ClassEval(className), root);
}
