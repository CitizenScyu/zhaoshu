// jsoup1028：规则 JS 直连 jsoup DOM 的沙箱桥（ENGINE_SYNTAX_JSOUP）。legado 跑在 Rhino 上，规则 JS 拿到的是 Java 对象：
// Element/Elements（NativeJavaObject/NativeJavaList）、Java String（typeof object、`.length` 是方法）、Object[]（NativeJavaArray）。
// 这里在 QuickJS 里用 Proxy 复现这些包装的可见行为，DOM 语义交宿主 jsoup-dom/jsoup-select（jsoup 1.16.2 口径）。
//
// 宿主只暴露一个隐藏对象 `__jsoup`（prelude 取走后删掉全局）：call(op, 目标 id, 实参) 一律字符串进出，节点按会话内 id 传递。
// 口径不定的用法（未知成员、改写页面文档、Rhino 不稳定排序的并列项、Error 文案…）经 bad() 记进 host.failure，JS 里 catch 也算失败。
// 不 import js-sandbox（它 import 这里，免成环）；上限常量本地定义。

import { load, type CheerioAPI } from 'cheerio';
import type { Document } from 'domhandler';
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';
import type { JsListItem } from './js-sandbox';
import {
  attrOf, checkCr, classNameOf, dataOf, docGuard, elementChildren, elementSiblingIndex, hasAttrOf, hasClassOf, hasTextOf,
  htmlOf, idOf, isDocument, isJElement, type JElement, jsoupFatal, nextElementSibling, outerHtmlOf, ownTextOf, parentElement,
  previousElementSibling, registerDocSource, removeNode, resetJsoupBudget, siblingElements, textOf, valOf, wholeTextOf,
} from './jsoup-dom';
import { getElementById, getElementsByClass, getElementsByTag, select, selectFirst, selectRoots } from './jsoup-select';
import { RuleEngineError } from './types';

/** 单次宿主调用 / 导出的字符上限（同 js-sandbox MAX_JS_OUTPUT_CHARS）。 */
const MAX_OUTPUT_CHARS = 2 << 20;
/** 一次求值里 Jsoup.parse 累计解析的字符上限。 */
const MAX_PARSE_CHARS = 4 << 20;
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// ---------------------------------------------------------------- 文档登记
const DOC_APIS = new WeakMap<Document, CheerioAPI>();

/** 页面文档（createHtmlScope）：parse5 scripting 开、字段间共享不可改写。只登记，源码扫描等首次 jsoup 访问再做。 */
export function registerHtmlDoc(root: Document, $: CheerioAPI, html: string): void {
  registerDocSource(root, html, { scripting: true, mutable: false });
  DOC_APIS.set(root, $);
}

/** 节点所在文档的 cheerio 实例（列表 JS 返回 Element 时建条目作用域用）。 */
export function docApi(node: JElement): CheerioAPI {
  return DOC_APIS.get(docGuard(node).root) ?? jsoupFatal('节点所在文档没有选择器上下文');
}

// ---------------------------------------------------------------- 会话（一次沙箱求值）
export type JsoupMode = 'final' | 'mid' | 'midjs';

/** 列表 JS 的条目：在 JsListItem 之外多一种 Element 项（legado getElements 直接拿它当条目内容）。 */
export type JsoupListItem = JsListItem | { readonly jsoupNode: JElement };

export interface JsoupInit {
  /** JS 的 `result`：条目级首段是该 Element，列表链首段规则之后是 Elements。缺省 = 用普通绑定。 */
  readonly result?: JElement | readonly JElement[];
  /** JS 的 `src`：条目级是该 Element。缺省 = 用普通绑定。 */
  readonly src?: JElement;
  /** bookvar1028：沙箱 `book` 带 `getVariable`（得 Java 空串；字段挂了 FieldIr.bookVars 才给）。缺 `book` 时补一个空对象。 */
  readonly bookVariables?: boolean;
}

export class JsoupSession {
  private readonly nodes: JElement[] = [];
  private readonly ids = new Map<JElement, number>();
  private parsed = 0;
  /** installJsoupHost 写入：导出阶段的失败也要查。 */
  host: { failure?: unknown } | undefined;

  constructor(private readonly getElements?: (rule: string) => readonly JElement[]) {
    resetJsoupBudget();
  }

  id(node: JElement): string {
    let id = this.ids.get(node);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push(node);
      this.ids.set(node, id);
    }
    return String(id);
  }

  node(id: string): JElement {
    const node = /^(?:0|[1-9]\d*)$/.test(id) ? this.nodes[Number(id)] : undefined;
    return node ?? jsoupFatal('无效的节点句柄');
  }

  init(value: JElement | readonly JElement[] | undefined): string {
    if (value === undefined) return '';
    return isJElement(value as JElement) ? `E,${this.id(value as JElement)}` : `L,${this.idList(value as readonly JElement[])}`;
  }

  call(op: string, target: string, arg: string): string {
    const out = this.dispatch(op, target, arg);
    if (out.length > MAX_OUTPUT_CHARS) jsoupFatal('输出过大');
    return out;
  }

  private idList(nodes: readonly JElement[]): string {
    return nodes.map((node) => this.id(node)).join(',');
  }

  private list(ids: string): JElement[] {
    return ids === '' ? [] : ids.split(',').map((id) => this.node(id));
  }

  private elementOut(node: JElement | null): string {
    return node === null ? '' : this.id(node);
  }

  private dispatch(op: string, target: string, arg: string): string {
    if (op === 'P') return this.parse(arg);
    if (op === 'G') {
      if (!this.getElements) return jsoupFatal('java.getElements 不可用');
      return this.idList(this.getElements(arg));
    }
    if (op.startsWith('L')) return this.listOp(op, this.list(target), arg);
    const el = this.node(target);
    const guard = docGuard(el);
    const plain = (text: string) => {
      checkCr(text, guard);
      return text;
    };
    switch (op) {
      case 'text': return textOf(el);
      case 'ownText': return ownTextOf(el);
      case 'wholeText': return wholeTextOf(el);
      case 'data': return dataOf(el);
      case 'html': return htmlOf(el);
      case 'outerHtml': return outerHtmlOf(el);
      case 'id': return plain(idOf(el));
      case 'className': return plain(classNameOf(el));
      case 'val': return plain(valOf(el));
      case 'attr': return plain(attrOf(el, arg));
      case 'tagName': return tagName(el, '#root');
      case 'nodeName': return tagName(el, '#document');
      case 'hasAttr': return hasAttrOf(el, arg) ? '1' : '0';
      case 'hasClass': return hasClassOf(el, arg) ? '1' : '0';
      case 'hasText': return hasTextOf(el) ? '1' : '0';
      case 'childrenSize': return String(elementChildren(el).length);
      case 'elementSiblingIndex': return String(elementSiblingIndex(el));
      case 'selectFirst': return this.elementOut(selectFirst(arg, el));
      case 'getElementById': return this.elementOut(getElementById(el, arg));
      case 'parent': return this.elementOut(parentElement(el));
      case 'nextElementSibling': return this.elementOut(nextElementSibling(el));
      case 'previousElementSibling': return this.elementOut(previousElementSibling(el));
      case 'child': {
        const child = elementChildren(el)[Number(arg)];
        return child === undefined ? jsoupFatal('Element.child 越界') : this.id(child);
      }
      case 'select': return this.idList(select(arg, el));
      case 'getElementsByTag': return this.idList(getElementsByTag(el, arg));
      case 'getElementsByClass': return this.idList(getElementsByClass(el, arg));
      case 'children': return this.idList(elementChildren(el));
      case 'siblingElements': return this.idList(siblingElements(el));
      case 'remove':
        removeNode(el);
        return '';
      default:
        return jsoupFatal(`未知操作 ${op}`);
    }
  }

  /** jsoup Elements 的聚合方法。 */
  private listOp(op: string, els: JElement[], arg: string): string {
    const joined = (sep: string, part: (el: JElement) => string) => {
      let out = '';
      for (const el of els) {
        if (out.length > 0) out += sep;
        out += part(el);
        if (out.length > MAX_OUTPUT_CHARS) jsoupFatal('输出过大');
      }
      return out;
    };
    switch (op) {
      case 'Ltext': return joined(' ', textOf);
      case 'Lhtml': return joined('\n', htmlOf);
      case 'LouterHtml': return joined('\n', outerHtmlOf);
      case 'Lattr': {
        const hit = els.find((el) => hasAttrOf(el, arg));
        return hit === undefined ? '' : this.dispatch('attr', this.id(hit), arg);
      }
      case 'LhasAttr': return els.some((el) => hasAttrOf(el, arg)) ? '1' : '0';
      case 'LhasClass': return els.some((el) => hasClassOf(el, arg)) ? '1' : '0';
      case 'LhasText': return els.some((el) => hasTextOf(el)) ? '1' : '0';
      case 'Lselect': return this.idList(selectRoots(arg, els));
      case 'Lremove':
        for (const el of els) removeNode(el);
        return '';
      default:
        return jsoupFatal(`未知操作 ${op}`);
    }
  }

  /** Jsoup.parse(html)：HTML 解析器、scripting 关（jsoup 不跑脚本，noscript 内容是元素），新文档可改写。 */
  private parse(html: string): string {
    this.parsed += html.length;
    if (this.parsed > MAX_PARSE_CHARS) jsoupFatal('Jsoup.parse 输入过大');
    const $ = load(html, { scriptingEnabled: false });
    const root = $.root()[0] as unknown as Document;
    registerDocSource(root, html, { scripting: false, mutable: true });
    DOC_APIS.set(root, $);
    return this.id(root);
  }
}

/** Element.tagName()/nodeName()：Document 分别是 #root/#document；外来命名空间（parse5 保留 svg 驼峰名）口径不定。 */
function tagName(el: JElement, documentName: string): string {
  if (isDocument(el)) return documentName;
  if (el.namespace !== undefined && el.namespace !== HTML_NS) return jsoupFatal('svg/math 元素的标签名口径不复现');
  if (el.name.toLowerCase() !== el.name) return jsoupFatal('非 ASCII 大写标签名口径不定');
  return el.name;
}

// ---------------------------------------------------------------- 宿主注入
/** 装 `__jsoup`（JSOUP_PRELUDE 取走）：宿主失败记进 host.failure，与 getter 回调一样致命。 */
export function installJsoupHost(
  context: QuickJSContext, session: JsoupSession, host: { failure?: unknown }, init: JsoupInit | undefined,
): void {
  session.host = host;
  const api = context.newObject();
  const add = (name: string, impl: (args: string[]) => string) => {
    const fn = context.newFunction(name, (...args) => {
      try {
        return context.newString(impl(args.map((arg) => context.getString(arg))));
      } catch (error) {
        host.failure ??= error;
        throw error;
      }
    });
    context.setProp(api, name, fn);
    fn.dispose();
  };
  add('call', ([op = '', target = '', arg = '']) => session.call(op, target, arg));
  add('bad', ([what = '']) => jsoupFatal(what));
  for (const [key, value] of [['r', session.init(init?.result)], ['s', session.init(init?.src)]] as const) {
    const handle = context.newString(value);
    context.setProp(api, key, handle);
    handle.dispose();
  }
  if (init?.bookVariables) context.setProp(api, 'bv', context.true);
  context.setProp(context.global, '__jsoup', api);
  api.dispose();
}

// ---------------------------------------------------------------- 沙箱 prelude
// 排在 UTIL_PRELUDE 之后、PRELUDE 之前（PRELUDE 末尾冻结 java）。内建方法在规则代码跑之前捕获，规则改原型不影响包装。
// 包装每次取值都新建（Rhino 的 wrap 也是每次新建，`el.parent() === el.parent()` 为 false）。
// 模板字面量里不写反斜杠（`\d` 之类会被吞掉），正则只用字符类。
export const JSOUP_PRELUDE = `(function(){
  var J = globalThis.__jsoup, j = globalThis.java;
  delete globalThis.__jsoup;
  var call = J.call, bad = J.bad, initR = J.r, initS = J.s, bookVars = J.bv === true;
  var P = Proxy, S = String, N = Number, OC = Object.create, freeze = Object.freeze, defProp = Object.defineProperty;
  var getProto = Object.getPrototypeOf, ownDesc = Object.getOwnPropertyDescriptor, ownNames = Object.getOwnPropertyNames;
  var stringify = JSON.stringify, RA = Reflect.apply, RG = Reflect.get, RH = Reflect.has, isArr = Array.isArray;
  var AP = Array.prototype, SP = String.prototype, OP = Object.prototype, TP = Symbol.toPrimitive, ICS = Symbol.isConcatSpreadable;
  var bindFn = Function.prototype.bind, callFn = Function.prototype.call;
  function u(f) { return RA(bindFn, callFn, [f]); }
  var wmGet = u(WeakMap.prototype.get), wmSet = u(WeakMap.prototype.set);
  var mGet = u(Map.prototype.get), mSet = u(Map.prototype.set), mClear = u(Map.prototype.clear);
  var push = u(AP.push), join = u(AP.join), aslice = u(AP.slice);
  var split = u(SP.split), slice = u(SP.slice), sIndexOf = u(SP.indexOf), sLastIndexOf = u(SP.lastIndexOf);
  var cca = u(SP.charCodeAt), lower = u(SP.toLowerCase), upper = u(SP.toUpperCase), sReplace = u(SP.replace);
  var reTest = u(RegExp.prototype.test), fromCC = S.fromCharCode, trunc = Math.trunc;
  var IDX = /^(?:0|[1-9][0-9]*)$/, META = '^$.|?*+()[]{}' + fromCC(92);
  var kinds = new WeakMap(), memo = new Map();

  function kindOf(v) { return (typeof v === 'object' || typeof v === 'function') && v !== null ? wmGet(kinds, v) : undefined; }
  function hc(op, t, a) {
    var key = op + ':' + t + ':' + a, r = mGet(memo, key);
    if (r === undefined) { r = call(op, t, a); mSet(memo, key, r); }
    return r;
  }
  function mut(op, t) { mClear(memo); call(op, t, ''); }
  function idList(r) { return r === '' ? [] : split(r, ','); }
  function arity(n, lo, hi, name) { if (n < lo || n > hi) bad(name + ' 的参数个数不对'); }
  function sArg(v, what) {
    if (typeof v === 'string') return v;
    var k = kindOf(v);
    if (k !== undefined && k.k === 'S') return k.v;
    return bad(what + ' 的实参不是字符串');
  }
  function iArg(v, what) {
    if (typeof v !== 'number' || trunc(v) !== v || v < -2147483648 || v > 2147483647) bad(what + ' 的实参不是 int');
    return S(v);
  }
  function denyWrite(what) { return function(){ return bad(what + ' 不可改写'); }; }
  function denyProbe(what) { return function(){ return bad(what + ' 的属性枚举口径不复现'); }; }
  function noProto() { return null; }

  // ---- Java String
  var stT = new WeakMap();
  function JS(v) {
    var t = OC(null), rec = { k: 'S', v: v }, p = new P(t, SH);
    wmSet(stT, t, rec); wmSet(kinds, p, rec);
    return p;
  }
  function badPrim() { return bad('Java 方法对象参与运算（Java 字符串的 length 是方法）'); }
  function noSurrogate(v, what) {
    for (var i = 0; i < v.length; i++) { var c = cca(v, i); if (c >= 0xD800 && c <= 0xDFFF) bad(what + ' 含代理项'); }
  }
  function caseMap(v, up) {
    var js = up ? upper(v) : lower(v);
    var ascii = sReplace(v, up ? /[a-z]/g : /[A-Z]/g, function(c){ return fromCC(cca(c, 0) + (up ? -32 : 32)); });
    if (js !== ascii) bad('非 ASCII 字符的大小写转换口径不定');
    return JS(js);
  }
  var SM = OC(null);
  SM.length = function(v){
    var f = function(){ arity(arguments.length, 0, 0, 'String.length'); return v.length; };
    defProp(f, TP, { value: badPrim });
    return f;
  };
  SM.trim = function(v){ return function(){
    arity(arguments.length, 0, 0, 'String.trim');
    var a = 0, b = v.length;
    while (a < b && cca(v, a) <= 32) a++;
    while (b > a && cca(v, b - 1) <= 32) b--;
    return JS(slice(v, a, b));
  }; };
  SM.indexOf = function(v){ return function(s, from){
    var n = arguments.length; arity(n, 1, 2, 'String.indexOf');
    s = sArg(s, 'String.indexOf');
    return n === 2 ? sIndexOf(v, s, N(iArg(from, 'String.indexOf'))) : sIndexOf(v, s);
  }; };
  SM.lastIndexOf = function(v){ return function(s, from){
    var n = arguments.length; arity(n, 1, 2, 'String.lastIndexOf');
    s = sArg(s, 'String.lastIndexOf');
    if (n === 1) return sLastIndexOf(v, s);
    var f = N(iArg(from, 'String.lastIndexOf'));
    if (f < 0) bad('String.lastIndexOf 的负起点口径不定');
    return sLastIndexOf(v, s, f);
  }; };
  SM.startsWith = function(v){ return function(s, off){
    var n = arguments.length; arity(n, 1, 2, 'String.startsWith');
    s = sArg(s, 'String.startsWith');
    var o = n === 2 ? N(iArg(off, 'String.startsWith')) : 0;
    if (o < 0 || o > v.length - s.length) return false;
    return slice(v, o, o + s.length) === s;
  }; };
  SM.endsWith = function(v){ return function(s){
    arity(arguments.length, 1, 1, 'String.endsWith');
    s = sArg(s, 'String.endsWith');
    var o = v.length - s.length;
    return o >= 0 && slice(v, o) === s;
  }; };
  SM.contains = function(v){ return function(s){
    arity(arguments.length, 1, 1, 'String.contains');
    return sIndexOf(v, sArg(s, 'String.contains')) >= 0;
  }; };
  SM.equals = function(v){ return function(s){
    arity(arguments.length, 1, 1, 'String.equals');
    return v === sArg(s, 'String.equals');
  }; };
  SM.isEmpty = function(v){ return function(){ arity(arguments.length, 0, 0, 'String.isEmpty'); return v.length === 0; }; };
  SM.toString = function(v){ return function(){ arity(arguments.length, 0, 0, 'String.toString'); return JS(v); }; };
  SM.concat = function(v){ return function(s){ arity(arguments.length, 1, 1, 'String.concat'); return JS(v + sArg(s, 'String.concat')); }; };
  SM.toLowerCase = function(v){ return function(){ arity(arguments.length, 0, 0, 'String.toLowerCase'); return caseMap(v, false); }; };
  SM.toUpperCase = function(v){ return function(){ arity(arguments.length, 0, 0, 'String.toUpperCase'); return caseMap(v, true); }; };
  SM.split = function(v){ return function(sep){
    arity(arguments.length, 1, 1, 'String.split');
    sep = sArg(sep, 'String.split');
    if (sep === '') bad('String.split 的空分隔符口径不定');
    for (var i = 0; i < sep.length; i++) if (sIndexOf(META, sep[i]) >= 0) bad('String.split 的正则分隔符口径不复现');
    var parts = split(v, sep), items = [];
    if (parts.length > 1) while (parts.length > 0 && parts[parts.length - 1] === '') parts.length--;
    for (var k = 0; k < parts.length; k++) push(items, JS(parts[k]));
    return JA(items);
  }; };
  SM.replace = function(v){ return function(a, b){
    arity(arguments.length, 2, 2, 'String.replace');
    a = sArg(a, 'String.replace'); b = sArg(b, 'String.replace');
    if (a !== '') return JS(join(split(v, a), b));
    if (v === '') return JS(b);
    noSurrogate(v, 'String.replace 的空目标');
    return JS(b + join(split(v, ''), b) + b);
  }; };
  SM.substring = function(v){ return function(b, e){
    var n = arguments.length; arity(n, 1, 2, 'String.substring');
    b = N(iArg(b, 'String.substring'));
    e = n === 2 ? N(iArg(e, 'String.substring')) : v.length;
    if (b < 0 || e > v.length || b > e) bad('String.substring 越界');
    return JS(slice(v, b, e));
  }; };
  // Java String 没有的名字落到 String.prototype（Rhino 给 Java String 的原型就是它），返回 JS 值。
  var FW = OC(null);
  var fwNames = ['match', 'search', 'slice', 'substr', 'includes', 'padStart', 'padEnd', 'charCodeAt', 'normalize',
    'trimStart', 'trimEnd', 'trimLeft', 'trimRight'];
  for (var fi = 0; fi < fwNames.length; fi++) FW[fwNames[fi]] = SP[fwNames[fi]];
  var SH = {
    get: function(t, p){
      var v = wmGet(stT, t).v;
      if (typeof p === 'symbol') {
        if (p === TP) return function(){ return v; };
        if (p === ICS) return undefined;
        return bad('Java 字符串的 ' + S(p) + ' 不支持');
      }
      var m = SM[p];
      if (m !== undefined) return m(v);
      var f = FW[p];
      if (f !== undefined) return function(){ return RA(f, v, arguments); };
      return bad('Java 字符串的 ' + p + ' 不支持');
    },
    has: denyProbe('Java 字符串'), ownKeys: denyProbe('Java 字符串'), getOwnPropertyDescriptor: denyProbe('Java 字符串'),
    set: denyWrite('Java 字符串'), defineProperty: denyWrite('Java 字符串'), deleteProperty: denyWrite('Java 字符串'),
    preventExtensions: denyWrite('Java 字符串'), getPrototypeOf: function(){ return SP; },
  };

  // ---- Element（含 Document）
  var elT = new WeakMap();
  function E(id) {
    if (id === '') return null;
    var t = OC(null), rec = { k: 'E', id: id }, p = new P(t, EH);
    wmSet(elT, t, rec); wmSet(kinds, p, rec);
    return p;
  }
  // 名 → [宿主操作, 实参（'' 无 / 's' 字符串 / 'i' int）, 返回（S 字符串 B 布尔 N 数 E 元素 L 列表 V 无）]
  var EM = OC(null);
  function em(names, op, args, ret) { for (var i = 0; i < names.length; i++) EM[names[i]] = [op, args, ret]; }
  em(['text'], 'text', '', 'S'); em(['ownText'], 'ownText', '', 'S'); em(['wholeText'], 'wholeText', '', 'S');
  em(['data'], 'data', '', 'S'); em(['html'], 'html', '', 'S'); em(['outerHtml'], 'outerHtml', '', 'S');
  em(['id'], 'id', '', 'S'); em(['className'], 'className', '', 'S'); em(['val'], 'val', '', 'S');
  em(['tagName'], 'tagName', '', 'S'); em(['nodeName'], 'nodeName', '', 'S'); em(['attr'], 'attr', 's', 'S');
  em(['hasAttr'], 'hasAttr', 's', 'B'); em(['hasClass'], 'hasClass', 's', 'B'); em(['hasText'], 'hasText', '', 'B');
  em(['childrenSize'], 'childrenSize', '', 'N'); em(['elementSiblingIndex'], 'elementSiblingIndex', '', 'N');
  em(['selectFirst'], 'selectFirst', 's', 'E'); em(['getElementById'], 'getElementById', 's', 'E');
  em(['parent', 'parentNode'], 'parent', '', 'E'); em(['nextElementSibling'], 'nextElementSibling', '', 'E');
  em(['previousElementSibling'], 'previousElementSibling', '', 'E'); em(['child'], 'child', 'i', 'E');
  em(['select'], 'select', 's', 'L'); em(['getElementsByTag'], 'getElementsByTag', 's', 'L');
  em(['getElementsByClass'], 'getElementsByClass', 's', 'L'); em(['children'], 'children', '', 'L');
  em(['siblingElements'], 'siblingElements', '', 'L'); em(['remove'], 'remove', '', 'V');
  function conv(ret, r) {
    if (ret === 'S') return JS(r);
    if (ret === 'B') return r === '1';
    if (ret === 'N') return N(r);
    if (ret === 'E') return E(r);
    return L(idList(r));
  }
  function encodeArgs(spec, a, name) {
    if (a.length !== spec.length) bad(name + ' 的参数个数不对');
    if (spec === '') return '';
    return spec === 's' ? sArg(a[0], name) : iArg(a[0], name);
  }
  var EH = {
    get: function(t, p){
      var id = wmGet(elT, t).id;
      if (typeof p === 'symbol') {
        if (p === TP) return function(){ return hc('outerHtml', id, ''); };
        if (p === ICS) return undefined;
        return bad('Element 的 ' + S(p) + ' 不支持');
      }
      if (p === 'toString') return function(){ arity(arguments.length, 0, 0, 'Element.toString'); return JS(hc('outerHtml', id, '')); };
      var m = EM[p];
      if (m === undefined) return bad('Element.' + p + ' 不支持');
      var name = 'Element.' + p;
      return function(){
        var a = encodeArgs(m[1], arguments, name);
        if (m[2] === 'V') { mut(m[0], id); return undefined; }
        return conv(m[2], hc(m[0], id, a));
      };
    },
    has: denyProbe('Element'), ownKeys: denyProbe('Element'), getOwnPropertyDescriptor: denyProbe('Element'),
    set: denyWrite('Element'), defineProperty: denyWrite('Element'), deleteProperty: denyWrite('Element'),
    preventExtensions: denyWrite('Element'), getPrototypeOf: noProto,
  };

  // ---- Elements（NativeJavaList：length/下标/for-in 下标，没有 JS 数组方法）
  var lsT = new WeakMap();
  function L(ids) {
    var t = OC(null), rec = { k: 'L', ids: ids }, p = new P(t, LH);
    wmSet(lsT, t, rec); wmSet(kinds, p, rec);
    return p;
  }
  function jn(rec) { return join(rec.ids, ','); }
  function msort(a, c) {
    var n = a.length;
    if (n < 2) return a;
    var mid = n >> 1, l = msort(aslice(a, 0, mid), c), r = msort(aslice(a, mid), c), out = [], i = 0, k = 0;
    while (i < l.length && k < r.length) { if (c(l[i], r[k]) <= 0) push(out, l[i++]); else push(out, r[k++]); }
    while (i < l.length) push(out, l[i++]);
    while (k < r.length) push(out, r[k++]);
    return out;
  }
  var LM = OC(null);
  function lstr(name, op) {
    LM[name] = function(rec){ return function(){ arity(arguments.length, 0, 0, 'Elements.' + name); return JS(hc(op, jn(rec), '')); }; };
  }
  lstr('text', 'Ltext'); lstr('html', 'Lhtml'); lstr('outerHtml', 'LouterHtml'); lstr('toString', 'LouterHtml');
  LM.attr = function(rec){ return function(k){
    arity(arguments.length, 1, 1, 'Elements.attr');
    return JS(hc('Lattr', jn(rec), sArg(k, 'Elements.attr')));
  }; };
  LM.hasAttr = function(rec){ return function(k){
    arity(arguments.length, 1, 1, 'Elements.hasAttr');
    return hc('LhasAttr', jn(rec), sArg(k, 'Elements.hasAttr')) === '1';
  }; };
  LM.hasClass = function(rec){ return function(k){
    arity(arguments.length, 1, 1, 'Elements.hasClass');
    return hc('LhasClass', jn(rec), sArg(k, 'Elements.hasClass')) === '1';
  }; };
  LM.hasText = function(rec){ return function(){ arity(arguments.length, 0, 0, 'Elements.hasText'); return hc('LhasText', jn(rec), '') === '1'; }; };
  LM.select = function(rec){ return function(q){
    arity(arguments.length, 1, 1, 'Elements.select');
    return L(idList(hc('Lselect', jn(rec), sArg(q, 'Elements.select'))));
  }; };
  LM.remove = function(rec, self){ return function(){ arity(arguments.length, 0, 0, 'Elements.remove'); mut('Lremove', jn(rec)); return self; }; };
  LM.first = function(rec){ return function(){ arity(arguments.length, 0, 0, 'Elements.first'); return rec.ids.length ? E(rec.ids[0]) : null; }; };
  LM.last = function(rec){ return function(){
    arity(arguments.length, 0, 0, 'Elements.last');
    return rec.ids.length ? E(rec.ids[rec.ids.length - 1]) : null;
  }; };
  LM.get = function(rec){ return function(i){
    arity(arguments.length, 1, 1, 'Elements.get');
    i = N(iArg(i, 'Elements.get'));
    if (i < 0 || i >= rec.ids.length) bad('Elements.get 越界');
    return E(rec.ids[i]);
  }; };
  LM.size = function(rec){ return function(){ arity(arguments.length, 0, 0, 'Elements.size'); return rec.ids.length; }; };
  LM.isEmpty = function(rec){ return function(){ arity(arguments.length, 0, 0, 'Elements.isEmpty'); return rec.ids.length === 0; }; };
  LM.toArray = function(rec){ return function(){
    arity(arguments.length, 0, 0, 'Elements.toArray');
    var a = [];
    for (var i = 0; i < rec.ids.length; i++) push(a, E(rec.ids[i]));
    return JA(a);
  }; };
  LM.forEach = function(rec){ return function(fn){
    arity(arguments.length, 1, 1, 'Elements.forEach');
    if (typeof fn !== 'function') bad('Elements.forEach 的实参不是函数');
    var ids = aslice(rec.ids);
    for (var i = 0; i < ids.length; i++) fn(E(ids[i]));
  }; };
  // Java List.sort：TimSort 稳定；比较结果按 Rhino jsToJava(int) 转换（NaN/Infinity/越界/非数字报错，小数截断）。
  LM.sort = function(rec){ return function(cmp){
    arity(arguments.length, 1, 1, 'Elements.sort');
    if (typeof cmp !== 'function') bad('Elements.sort 的实参不是函数');
    var items = [], i;
    for (i = 0; i < rec.ids.length; i++) push(items, { id: rec.ids[i], e: E(rec.ids[i]) });
    function c(a, b) {
      var r = cmp(a.e, b.e), k = kindOf(r);
      if (typeof r === 'string') r = N(r);
      else if (k !== undefined && k.k === 'S') r = N(k.v);
      else if (typeof r !== 'number') bad('Elements.sort 的比较结果不是数字');
      if (r !== r || r === Infinity || r === -Infinity) bad('Elements.sort 的比较结果不是有限数');
      r = trunc(r);
      if (r < -2147483648 || r > 2147483647) bad('Elements.sort 的比较结果超出 int');
      return r;
    }
    items = msort(items, c);
    for (i = 1; i < items.length; i++) if (c(items[i - 1], items[i]) > 0) bad('Elements.sort 的比较器前后不一致');
    var out = [];
    for (i = 0; i < items.length; i++) push(out, items[i].id);
    rec.ids = out;
  }; };
  var LH = {
    get: function(t, p, self){
      var rec = wmGet(lsT, t);
      if (typeof p === 'symbol') {
        if (p === TP) return function(){ return hc('LouterHtml', jn(rec), ''); };
        if (p === ICS) return undefined;
        return bad('Elements 的 ' + S(p) + ' 不支持');
      }
      if (p === 'length') return rec.ids.length;
      if (reTest(IDX, p)) { var i = N(p); return i < rec.ids.length ? E(rec.ids[i]) : undefined; }
      var m = LM[p];
      if (m === undefined) return bad('Elements.' + p + ' 不支持');
      return m(rec, self);
    },
    has: function(t, p){
      var rec = wmGet(lsT, t);
      if (typeof p === 'symbol') return false;
      if (p === 'length') return true;
      if (reTest(IDX, p)) return N(p) < rec.ids.length;
      return LM[p] !== undefined;
    },
    ownKeys: function(t){
      var rec = wmGet(lsT, t), keys = [];
      for (var i = 0; i < rec.ids.length; i++) push(keys, S(i));
      return keys;
    },
    getOwnPropertyDescriptor: function(t, p){
      var rec = wmGet(lsT, t);
      if (typeof p === 'string' && reTest(IDX, p) && N(p) < rec.ids.length) {
        return { value: E(rec.ids[N(p)]), writable: false, enumerable: true, configurable: true };
      }
      if (p === 'length') return { value: rec.ids.length, writable: false, enumerable: false, configurable: true };
      return undefined;
    },
    set: denyWrite('Elements'), defineProperty: denyWrite('Elements'), deleteProperty: denyWrite('Elements'),
    preventExtensions: denyWrite('Elements'), getPrototypeOf: noProto,
  };

  // ---- Object[]（NativeJavaArray：原型 Array.prototype、Array.isArray 为 false、concat 不展开、定长）
  var JAVA_MEMBERS = OC(null);
  JAVA_MEMBERS.toString = 1; JAVA_MEMBERS.toLocaleString = 1; JAVA_MEMBERS.equals = 1; JAVA_MEMBERS.hashCode = 1;
  JAVA_MEMBERS.getClass = 1; JAVA_MEMBERS.toJSON = 1;
  function JA(items) {
    var p = new P(items, AH);
    wmSet(kinds, p, { k: 'A' });
    return p;
  }
  var AH = {
    get: function(t, p, r){
      if (typeof p === 'symbol') {
        if (p === ICS) return false;
        return bad('Java 数组的 ' + S(p) + ' 不支持');
      }
      if (p === 'length' || reTest(IDX, p)) return RG(t, p, r);
      if (JAVA_MEMBERS[p] !== undefined || !RH(AP, p)) return bad('Java 数组的 ' + p + ' 不支持');
      return RG(t, p, r);
    },
    set: function(t, p, v){
      if (typeof p !== 'string' || !reTest(IDX, p) || N(p) >= t.length) return bad('Java 数组只能按下标改写');
      var k = kindOf(v);
      if (typeof v === 'string') v = JS(v);
      else if (!(v === null || (k !== undefined && (k.k === 'S' || k.k === 'E')))) return bad('Java 数组只能存字符串/Element/null');
      t[N(p)] = v;
      return true;
    },
    defineProperty: denyWrite('Java 数组'), deleteProperty: denyWrite('Java 数组'), preventExtensions: denyWrite('Java 数组'),
  };
  defProp(Array, 'isArray', { value: function isArray(v){
    var k = kindOf(v);
    return k !== undefined && k.k === 'A' ? false : isArr(v);
  }, writable: true, enumerable: false, configurable: true });

  // ---- Array.prototype.sort（Rhino：不稳定、NaN 当相等、undefined 排最后、默认按 ToString 比）
  // 稳定排序后逐对复核：比较器前后不一致，或并列项不是同一个值（Rhino 的次序不复现）→ 失败。
  function sameItem(a, b) {
    if (a === b) return true;
    var ka = kindOf(a), kb = kindOf(b);
    return ka !== undefined && kb !== undefined && ka.k === kb.k && ka.k !== 'A' && S(a) === S(b);
  }
  defProp(AP, 'sort', { value: function sort(cmp){
    if (cmp !== undefined && typeof cmp !== 'function') bad('Array.sort 的比较器不是函数');
    var o = Object(this), len = N(o.length), items = [], undef = 0, i;
    len = len > 0 ? trunc(len) : 0;
    for (i = 0; i < len; i++) {
      if (!(i in o)) continue;
      var x = o[i];
      if (x === undefined) undef++; else push(items, x);
    }
    var c = cmp === undefined
      ? function(a, b){ var x = S(a), y = S(b); return x < y ? -1 : x > y ? 1 : 0; }
      : function(a, b){ var r = +cmp(a, b); return r !== r ? 0 : r; };
    items = msort(items, c);
    for (i = 1; i < items.length; i++) {
      var d = c(items[i - 1], items[i]);
      if (d > 0) bad('Array.sort 的比较器前后不一致');
      if (d === 0 && !sameItem(items[i - 1], items[i])) bad('Array.sort 有并列项，Rhino 不稳定排序的次序不复现');
    }
    var n = 0;
    for (; n < items.length; n++) o[n] = items[n];
    for (i = 0; i < undef; i++) o[n++] = undefined;
    for (; n < len; n++) delete o[n];
    return o;
  }, writable: true, enumerable: false, configurable: true });

  // Rhino 的错误文案与 QuickJS 不同：拼进结果即不可复现。
  defProp(Error.prototype, 'toString', { value: function toString(){ return bad('Error 的文案口径不复现'); },
    writable: true, enumerable: false, configurable: true });

  // ---- 入口：java.getElement(s)、java.getString 返回 Java 字符串、org.jsoup.Jsoup.parse
  function getElements(rule){
    arity(arguments.length, 1, 1, 'java.getElements');
    return L(idList(hc('G', '', sArg(rule, 'java.getElements'))));
  }
  j.getElement = getElements; j.getElements = getElements;
  if (typeof j.getString === 'function') {
    var gs = j.getString;
    j.getString = function(){ var r = RA(gs, j, arguments); return typeof r === 'string' ? JS(r) : r; };
  }
  // netjs1029：搜索模板联网 JS 才有 ajax 回调（search-js.ts）：只收一个字符串/Java 字符串实参（legado 收 List 取首项，这里不收），
  // 返回 Java 字符串（legado getStrResponse().body）；另给搜索包装一个 Java 字符串拆/装口（__jstr，不可改写）。没有联网回调的
  // 求值不装、逐字不变。
  // connectnet1029：connect 回调（ENGINE_SEARCH_CONNECT_JS）返回 [最终地址, body]，包成 legado StrResponse 的子集：
  // raw().request().url() 得 okhttp HttpUrl（转字符串 = 最终地址，toString() 得 Java 字符串），url()/body() 得 Java 字符串。
  // 其余成员（code/headers/message…）、StrResponse/Response/Request 转字符串（Rhino 是 okhttp 的 toString）、不调用就拿方法
  // 参与运算一律失败。这几种对象不登记进 kinds：导出/条目口径按普通对象走（HttpUrl 转串得地址，其余转串失败）。
  var netT = new WeakMap(), netKinds = new WeakMap();
  function NO(name, v, members) {
    var t = OC(null), rec = { n: name, v: v, m: members }, p = new P(t, NH);
    wmSet(netT, t, rec); wmSet(netKinds, p, rec);
    return p;
  }
  function badMethodPrim() { return bad('Java 方法对象参与运算'); }
  var NH = {
    get: function(t, p){
      var rec = wmGet(netT, t);
      if (p === TP && rec.m === UM) return function(){ return rec.v; };
      if (typeof p === 'symbol') return bad(rec.n + ' 的 ' + S(p) + ' 不支持');
      var m = rec.m[p];
      if (m === undefined) return bad(rec.n + '.' + p + ' 不支持');
      var f = function(){ arity(arguments.length, 0, 0, rec.n + '.' + p); return m(rec.v); };
      defProp(f, TP, { value: badMethodPrim });
      return f;
    },
    has: denyProbe('Java 对象'), ownKeys: denyProbe('Java 对象'), getOwnPropertyDescriptor: denyProbe('Java 对象'),
    set: denyWrite('Java 对象'), defineProperty: denyWrite('Java 对象'), deleteProperty: denyWrite('Java 对象'),
    preventExtensions: denyWrite('Java 对象'), getPrototypeOf: noProto,
  };
  var UM = OC(null), TM = OC(null), QM = OC(null), RM = OC(null);
  UM.toString = function(v){ return JS(v); };
  TM.url = function(v){ return NO('HttpUrl', v, UM); };
  QM.request = function(v){ return NO('Request', v, TM); };
  RM.raw = function(v){ return NO('Response', v[0], QM); };
  RM.url = function(v){ return JS(v[0]); };
  RM.body = function(v){ return JS(v[1]); };
  function unUrl(v) {
    if (typeof v !== 'object' || v === null) return undefined;
    var rec = wmGet(netKinds, v);
    return rec !== undefined && rec.m === UM ? rec.v : undefined;
  }
  if (typeof j.ajax === 'function') {
    var aj = j.ajax;
    j.ajax = function ajax(url){
      arity(arguments.length, 1, 1, 'java.ajax');
      return JS(aj(sArg(url, 'java.ajax')));
    };
  }
  if (typeof j.connect === 'function') {
    var cn = j.connect;
    j.connect = function connect(url){
      arity(arguments.length, 1, 1, 'java.connect');
      var u = unUrl(url), r = cn(u !== undefined ? u : sArg(url, 'java.connect'));
      return NO('StrResponse', [S(r[0]), S(r[1])], RM);
    };
  }
  if (typeof j.ajax === 'function' || typeof j.connect === 'function') {
    defProp(globalThis, '__jstr', { value: freeze({
      un: function(v){ var k = kindOf(v); return k !== undefined && k.k === 'S' ? k.v : unUrl(v); },
      of: function(v){ return JS(S(v)); }
    }), writable: false, enumerable: false, configurable: false });
  }
  function parse(html){
    arity(arguments.length, 1, 1, 'Jsoup.parse');
    var k = kindOf(html), s;
    if (typeof html === 'string') s = html;
    else if (k !== undefined && k.k !== 'A') s = S(html);
    else return bad('Jsoup.parse 的实参不是字符串');
    return E(call('P', '', s));
  }
  // pkgalias1029：nodes.Document/Element 只给占位对象——编译期已核别名定义后不再使用。
  var ns = freeze({ jsoup: freeze({ Jsoup: freeze({ parse: parse }),
    nodes: freeze({ Document: freeze({}), Element: freeze({}) }) }) });
  globalThis.org = ns;
  globalThis.Packages = freeze({ org: ns });
  function initVal(spec) { var rest = slice(spec, 2); return slice(spec, 0, 1) === 'E' ? E(rest) : L(idList(rest)); }
  if (initR !== '') globalThis.result = initVal(initR);
  if (initS !== '') globalThis.src = initVal(initS);
  // bookvar1028：编译期已核键是字面量、源内没有往书籍变量放它的写法，legado BaseBook.getVariable 落空得 ""（Java String）。
  if (bookVars) {
    var bk = globalThis.book;
    if (typeof bk !== 'object' || bk === null) { bk = {}; globalThis.book = bk; }
    bk.getVariable = function getVariable(key){
      arity(arguments.length, 1, 1, 'book.getVariable');
      sArg(key, 'book.getVariable');
      return JS('');
    };
  }

  // ---- 导出（宿主调用；只用上面捕获的内建）
  function expStr(v) { return stringify({ s: v }); }
  function expVal(v, mode) {
    if (v === undefined || v === null) return 'null';
    var k = kindOf(v), out = [], i;
    if (k !== undefined) {
      if (k.k === 'S') {
        if (mode === 'midjs') bad('JS 段之间传递 Java 字符串的口径不复现');
        return expStr(k.v);
      }
      if (k.k === 'A') return bad('JS 返回了 Java 数组（legado 取字符串不支持）');
      if (mode !== 'final') return bad('Element 传给下一段的口径不复现');
      if (k.k === 'E') return expStr(hc('outerHtml', k.id, ''));
      for (i = 0; i < k.ids.length; i++) push(out, hc('outerHtml', k.ids[i], ''));
      return stringify({ a: out });
    }
    if (isArr(v)) {
      var len = v.length;
      for (i = 0; i < len; i++) {
        var it = v[i], ik = kindOf(it);
        if (it === undefined || it === null) push(out, '');
        else if (ik === undefined) push(out, S(it));
        else if (ik.k === 'S') push(out, ik.v);
        else if (ik.k === 'A' || mode !== 'final') return bad('数组里的 Java 对象传给下一段的口径不复现');
        else push(out, S(it));
      }
      return stringify({ a: out });
    }
    return expStr(S(v));
  }
  function expItems(v) {
    if (v === undefined || v === null) return 'null';
    var k = kindOf(v), out = [], i;
    if (k !== undefined) {
      if (k.k !== 'L') return k.k === 'S' ? '"string"' : '"other"';
      for (i = 0; i < k.ids.length; i++) push(out, [k.ids[i]]);
      return stringify(out);
    }
    if (typeof v === 'string') return '"string"';
    if (!isArr(v)) return '"other"';
    var len = v.length;
    for (i = 0; i < len; i++) {
      var it = v[i], ik = kindOf(it);
      if (typeof it === 'string') { push(out, it); continue; }
      if (ik !== undefined) {
        if (ik.k === 'S') push(out, ik.v);
        else if (ik.k === 'E') push(out, [ik.id]);
        else if (ik.k === 'L') push(out, S(it));
        else return '"item"';
        continue;
      }
      if (it === null || typeof it !== 'object' || isArr(it)) return '"item"';
      var proto = getProto(it);
      if (proto !== OP && proto !== null) return '"item"';
      var o = OC(null), keys = ownNames(it);
      for (var n = 0; n < keys.length; n++) {
        var d = ownDesc(it, keys[n]), x = d.value, xk = kindOf(x);
        if (d.get || d.set) o[keys[n]] = 0;
        else if (typeof x === 'string') o[keys[n]] = x;
        else if (xk !== undefined) o[keys[n]] = xk.k === 'S' ? xk.v : xk.k === 'A' ? 0 : S(x);
        else if (typeof x === 'boolean') o[keys[n]] = x ? 'true' : 'false';
        else if (x !== null && x !== undefined) o[keys[n]] = 0;
      }
      push(out, o);
    }
    return stringify(out);
  }
  // initjsoup1028：init 的返回（legado setContent）：字符串（含 Java 字符串）原样、普通对象按条目口径成键值表；Element/Elements/
  // Java 数组记 node，数组、数字等记 other（宿主判失败）。
  function expInit(v) {
    if (v === undefined || v === null) return 'null';
    var k = kindOf(v);
    if (k !== undefined) return k.k === 'S' ? expStr(k.v) : '"node"';
    if (typeof v === 'string') return expStr(v);
    if (typeof v !== 'object' || isArr(v)) return '"other"';
    return expItems([v]);
  }
  defProp(globalThis, '__jsoupExport', { value: function(v, mode){
    return mode === 'items' ? expItems(v) : mode === 'init' ? expInit(v) : expVal(v, mode);
  },
    writable: false, enumerable: false, configurable: false });
})();
`;

// ---------------------------------------------------------------- 导出解码（不信任沙箱产出，逐项校验）
/** 调沙箱里的 `__jsoupExport` 取 JSON 文本；导出阶段的宿主失败（bad）照旧致命。 */
export function exportJsoup(
  context: QuickJSContext, handle: QuickJSHandle, session: JsoupSession, mode: JsoupMode | 'items' | 'init',
): string {
  const fn = context.getProp(context.global, '__jsoupExport');
  const modeHandle = context.newString(mode);
  try {
    const called = context.callFunction(fn, context.undefined, handle, modeHandle);
    const failure = session.host?.failure;
    if (failure !== undefined) {
      (called.error ?? called.value).dispose();
      throw failure instanceof RuleEngineError ? failure : new RuleEngineError('RULE_EVAL_FAILED', 'jsoup: 结果导出失败');
    }
    if (called.error) {
      called.error.dispose();
      return jsoupFatal('JS 结果无法读取');
    }
    try {
      if (context.typeof(called.value) !== 'string') return jsoupFatal('JS 结果异常');
      const text = context.getString(called.value);
      return text.length > MAX_OUTPUT_CHARS * 2 ? jsoupFatal('JS 输出过大') : text;
    } finally {
      called.value.dispose();
    }
  } finally {
    modeHandle.dispose();
    fn.dispose();
  }
}

function parseExport(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return jsoupFatal('JS 结果异常');
  }
}

/** 字符串链的值：null / 字符串 / 字符串数组（同 runJs 的 JsValue）。 */
export function decodeJsoupValue(text: string): string | string[] | null {
  const parsed = parseExport(text);
  if (parsed === null) return null;
  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    const { s, a } = parsed as { s?: unknown; a?: unknown };
    if (typeof s === 'string') return s.length > MAX_OUTPUT_CHARS ? jsoupFatal('JS 输出过大') : s;
    if (Array.isArray(a) && a.every((item) => typeof item === 'string')) {
      const items = a as string[];
      return items.reduce((sum, item) => sum + item.length, 0) > MAX_OUTPUT_CHARS ? jsoupFatal('JS 输出过大') : items;
    }
  }
  return jsoupFatal('JS 结果异常');
}

/** 列表 JS 的条目（legado getElements 的 Js 模式）：Elements 逐个成为 Element 条目；数组项口径同 runJsItems，另收 Element。 */
export function decodeJsoupItems(text: string, session: JsoupSession): JsoupListItem[] | null {
  const parsed = parseExport(text);
  if (parsed === null) return null;
  if (parsed === 'string') return jsoupFatal('列表 JS 返回了字符串（legado getElements 强转 List 失败）');
  if (parsed === 'other') return jsoupFatal('列表 JS 返回的不是数组/Elements（legado getElements 口径不复现）');
  if (parsed === 'item') return jsoupFatal('列表 JS 数组含字符串/普通对象/Element 以外的项');
  if (!Array.isArray(parsed)) return jsoupFatal('列表 JS 结果异常');
  return parsed.map((item: unknown): JsoupListItem => {
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) {
      if (item.length !== 1 || typeof item[0] !== 'string') return jsoupFatal('列表 JS 结果异常');
      return { jsoupNode: session.node(item[0]) };
    }
    if (item === null || typeof item !== 'object') return jsoupFatal('列表 JS 结果异常');
    const entries = new Map<string, string | null>();
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'string') entries.set(key, value);
      else if (value === 0) entries.set(key, null);
      else return jsoupFatal('列表 JS 结果异常');
    }
    return entries;
  });
}

/**
 * 详情页 JS init 的返回（initjsoup1028）：字符串，或单个普通对象的键值表（口径同 decodeJsoupItems 的对象项）。返回 Element/Elements
 * （legado setContent 拿节点续解析，这里不复现）、数组、数字等一律失败；null 交调用方判。
 */
export function decodeJsoupInit(text: string, session: JsoupSession): string | ReadonlyMap<string, string | null> | null {
  const parsed = parseExport(text);
  if (parsed === null) return null;
  if (parsed === 'node') return jsoupFatal('init JS 返回了 Element/Elements/Java 数组（legado setContent 口径不复现）');
  if (parsed === 'other' || parsed === 'item') return jsoupFatal('init JS 返回的不是字符串/普通对象');
  if (!Array.isArray(parsed)) {
    const s = typeof parsed === 'object' ? (parsed as { s?: unknown }).s : undefined;
    if (typeof s !== 'string') return jsoupFatal('init JS 结果异常');
    return s.length > MAX_OUTPUT_CHARS ? jsoupFatal('JS 输出过大') : s;
  }
  const items = decodeJsoupItems(text, session);
  const item = items?.[0];
  if (items?.length !== 1 || item === undefined || typeof item === 'string' || 'jsoupNode' in item) return jsoupFatal('init JS 结果异常');
  return item;
}
