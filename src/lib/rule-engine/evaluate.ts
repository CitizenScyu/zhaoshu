// 求值层：IR × (DOM | JSON) → 字符串/节点集；##正则替换##；字段后处理与失败隔离。
// 设计依据：m1-engine-design.md v3 §3.1（输入归一化）/ §3.2（DOM 求值）/ §3.3（正则与后处理）
// / §3.4（失败隔离）。引擎零网络：本文件不引入任何请求路径，页 URL 由调用方经 scope 传入。

import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Document } from 'domhandler';
import { decodeHTML, decodeHTMLStrict } from 'entities';
import {
  type ChainStage, type CompiledRules, type FieldIr, type JsonPathIr, type JsTemplatePart, MAX_REGEX_PATTERN_LENGTH, RuleEngineError,
  type RuleIr, type RegexSub, type SkippedField, type TemplatePart,
} from './types';
import { aioListCode } from './aio-syntax';
import {
  type JsBindings, type JsListItem, type JsValue, runJs, runJsInit, runJsItems, runJsoup, runJsoupInit, runJsoupItems,
} from './js-sandbox';
import { isDocument, isJElement, type JElement } from './jsoup-dom';
import { docApi, registerHtmlDoc } from './jsoup-shim';
import { evalJsonPath, evalJsonPathList, isDefinitePath, parseJsonPath } from './jsonpath';
import { defaultSyntaxSource } from './parse';
import { evaluateXPath } from './xpath-eval';
import {
  applyTerminal,
  type CheerioNodes,
  evaluateCssChain,
  MULTI_JOIN,
} from './dom-ops';

// ---------------------------------------------------------------- 输入归一化（§3.1）
// 判定响应是 JSON 还是 HTML，并处理引擎侧包装。两个引擎侧包装里，gzip 由运行时 fetch
// （undici）自动解压、无需代码；本层只负责 `inte_base64:` 前缀解一层（新笔趣阁2 实测形态）。

/** 新笔趣阁2 一类的正文包裹前缀：`inte_base64:<base64>`。 */
export const INTE_BASE64_PREFIX = 'inte_base64:';

/** 解一层 base64 后的最大字节数（2MB，与 source-fetch 的响应上限同量级，防解压炸弹）。 */
export const MAX_DECODED_BYTES = 2 * 1024 * 1024;

export type NormalizedBody =
  | { kind: 'html'; text: string }
  | { kind: 'json'; text: string; json: unknown };

/**
 * 归一化一段响应体（§3.1）：
 * 1) `inte_base64:` 前缀 → 本地解一层 base64（失败则保持原文）；
 * 2) content-type 含 json，或文本 lstrip 以 `{`/`[` 开头且 JSON.parse 成功 → JSON 输入；
 * 3) 否则 HTML 输入（cheerio.load）。
 */
export function normalizeBody(input: string, contentType?: string): NormalizedBody {
  const text = typeof input === 'string' ? input : '';
  const decoded = text.startsWith(INTE_BASE64_PREFIX) ? decodeBase64Layer(text.slice(INTE_BASE64_PREFIX.length)) : text;
  const lstrip = decoded.replace(/^[\s﻿]+/u, '');
  const declaredJson = typeof contentType === 'string' && /json/i.test(contentType);
  if (declaredJson || lstrip.startsWith('{') || lstrip.startsWith('[')) {
    const parsed = tryParseJson(lstrip);
    if (parsed.ok) return { kind: 'json', text: decoded, json: parsed.value };
  }
  return { kind: 'html', text: decoded };
}

/**
 * `inte_base64:` 一层解包。严格校验；任一不通过 → 返回原文，交给上层按 HTML 处理。
 *
 * Node 的 `Buffer.from(x, 'base64')` 是**宽容解码**（丢弃非法字符、不抛异常），
 * 单靠 try/catch 无法识别非法输入。故这里额外做字符集 + 长度 + 往返重编码比对 +
 * UTF-8 有效性四道校验，避免把乱码当成功（如 `inte_base64:!!!not-base64!!!`
 * 或误伤以该前缀开头的正常正文）。
 */
export function decodeBase64Layer(payload: string): string {
  const compact = payload.replace(/\s+/gu, '');
  if (compact === '') return payload;
  // 先按长度粗筛，避免为大体积输入分配解码缓冲。
  if (Math.floor((compact.length * 3) / 4) > MAX_DECODED_BYTES) return payload;
  // 字符集 + 结构校验：base64 只含 A-Za-z0-9+/，尾部至多两个 =；长度 %4 不可能余 1。
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return payload;
  const bytes = Buffer.from(compact, 'base64');
  // 往返校验：宽容解码会丢弃非法字符，重编码后与原串不等；此步是识别非法输入的关键。
  // 要求「规范 base64（填充位为零）」：如 `YR==`（Node 宽容解成 `a`）会因重编码为 `YQ==` 被拒。
  if (bytes.toString('base64').replace(/=+$/u, '') !== compact.replace(/=+$/u, '')) return payload;
  const decoded = bytes.toString('utf8');
  // UTF-8 有效性：空结果，或「解码 → 重编码」字节不等（非法字节被折叠成了 U+FFFD）。
  // 用字节往返而非扫 U+FFFD，避免把原文本就含替换字符的**合法** UTF-8 误判为非法。
  if (decoded === '' || !Buffer.from(decoded, 'utf8').equals(bytes)) return payload;
  return decoded;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------- 作用域
/**
 * legado evalJS 的宿主只读绑定（bind1028，ENGINE_SYNTAX_JS_BIND）：门面按 legado 口径注入，未注入的不进沙箱。
 * `origin` = `book.origin`（书源地址）；`chapterTitle` = `chapter.title` 与 `title`（目录条目的章节名 / 正文所属章节）。
 */
export interface ScopeHost {
  origin?: string;
  chapterTitle?: string;
  /**
   * 本书变量袋（varbag1028，ENGINE_SYNTAX_VARS_BAG）：详情页 put 填、目录页 get 读。挂上时沙箱多装 `java.put(k, v)` /
   * `java.get(k)`，`@get:{k}` makeUp 片段从这里取；没挂时读袋的字段求值失败。
   */
  vars?: Map<string, string>;
  /**
   * 本书已求出的书籍成员（book1028，ENGINE_SYNTAX_BOOK_FIELDS）：name/author/bookUrl/tocUrl，随阶段递增（见 parse.ts
   * bookStageMembers）。沙箱 `book` 上与 origin 一并给出；挂了 FieldIr.bookMembers 的字段缺成员或成员为空即求值失败。
   */
  book?: Readonly<Record<string, string>>;
}

/** HTML 输入的作用域。`nodes` 是求值起点：整篇文档（`$.root()`）或 bookList 的某一条。 */
export interface HtmlScope {
  kind: 'html';
  $: CheerioAPI;
  nodes: CheerioNodes;
  pageUrl: string;
  /** 页面原文（jsbox1027：JS 链首段的 result 与 `src`）。只有整页作用域有，收窄到条目后为 undefined。 */
  source?: string;
  /**
   * legado content 不是字符串时的 `content.toString()`（init1028：init 取出的 Elements 按行拼 outerHtml）。只供正则-only 规则；
   * JS 链首段在 legado 拿到的是 Elements 对象，不复现（source 留空，首段 JS 求值失败）。
   */
  contentText?: string;
  /** 宿主绑定（bind1028）；列表条目作用域沿用页面作用域的。 */
  host?: ScopeHost;
}

/** JSON 输入的作用域（jsonpath / tpl_jsonpath 规则用）。 */
export interface JsonScope {
  kind: 'json';
  json: unknown;
  pageUrl: string;
  /** 同 HtmlScope.source。 */
  source?: string;
  /** 同 HtmlScope.host。 */
  host?: ScopeHost;
  /** AllInOne 条目（aio1027）：legado `[group0..groupN]`，下标即 `$N`（group0 不回传，占位空串）；json 恒为 undefined。 */
  groups?: readonly string[];
  /** 列表 JS 返回的对象条目（listjs1027，legado NativeObject）：条目字段按 FieldIr.objectKey 键值直取；json 恒为 undefined。 */
  object?: ReadonlyMap<string, string | null>;
}

export type EvalScope = HtmlScope | JsonScope;

export type EvalResult = { kind: 'text'; value: string } | { kind: 'nodes'; nodes: CheerioNodes };

/** 载入 HTML 建立文档级作用域。文档登记给 jsoup 直连（jsoup1028）：只记原文与 cheerio 实例，首次 jsoup 访问才扫描。 */
export function createHtmlScope(html: string, pageUrl: string): HtmlScope {
  const $ = load(html);
  registerHtmlDoc($.root()[0] as unknown as Document, $, html);
  return { kind: 'html', $, nodes: $.root() as unknown as CheerioNodes, pageUrl };
}

/** 建立 JSON 作用域。 */
export function createJsonScope(json: unknown, pageUrl: string): JsonScope {
  return { kind: 'json', json, pageUrl };
}

/** 按归一化结果建立作用域（§3.1 的分流点）。 */
export function createScope(body: NormalizedBody, pageUrl: string): EvalScope {
  const scope = body.kind === 'json' ? createJsonScope(body.json, pageUrl) : createHtmlScope(body.text, pageUrl);
  scope.source = body.text;
  return scope;
}

/** 链中段把上一段结果重新当页面解析（同 pageUrl），宿主绑定（bind1028）随作用域带下去。 */
function rescope(text: string, from: EvalScope): EvalScope {
  const scope = createScope(normalizeBody(text), from.pageUrl);
  if (from.host) scope.host = from.host;
  return scope;
}

/** 收窄作用域到某个节点（列表字段逐条求值用，如 bookList → 每条的 name/author/bookUrl）。 */
export function insideNode(scope: HtmlScope, node: unknown): HtmlScope {
  return { ...scope, nodes: scope.$(node as never), source: undefined, contentText: undefined };
}

// ---------------------------------------------------------------- 单规则求值
export function evaluateRule(ir: RuleIr, scope: EvalScope, multi = false): EvalResult {
  switch (ir.kind) {
    case 'css': {
      if (scope.kind !== 'html') {
        // 默认语法规则在 JSON 输入上走 legado Json 模式（见 parse.ts defaultSyntaxSource）；
        // 显式 @css: 仍是 CSS，照旧拒绝。
        if (defaultSyntaxSource(ir) === undefined) return evalFailed('HTML 选择器规则不能对 JSON 输入求值');
        return { kind: 'text', value: jsonModeString(ir, scope.json) };
      }
      const result = evaluateCssChain(scope.$, scope.nodes, ir.chain, ir.terminal, scope.pageUrl, multi);
      return typeof result === 'string' ? { kind: 'text', value: result } : { kind: 'nodes', nodes: result };
    }
    case 'jsonpath': {
      if (scope.kind !== 'json') return evalFailed('JSONPath 规则不能对 HTML 输入求值');
      return { kind: 'text', value: jsonValuesToString(evalJsonPath(ir.path, scope.json)) };
    }
    case 'template':
      return { kind: 'text', value: renderTemplate(ir.parts, scope) };
    case 'text':
      // JSON 输入上字面量里的 `{$.x}` 内嵌规则就地替换（如 `http://h/b/{$.id}.html`）。一处都没替换成功时
      // 对齐 legado：innerRule 返回 "" 后整条规则交 Jayway 读，URL 字面量读不到、异常被吞 ⇒ 空串，
      // 不回退原文（原文是带 `{$.x}` 的垃圾 URL）。URL 字段的 baseUrl 回退在调用方（api.ts chapterUrl、
      // source-reader 的 tocUrl）。不含 `{$.` 的字面量照旧原样返回。
      if (scope.kind === 'json' && ir.literal.includes(INNER_JSON_RULE_OPEN)) {
        return { kind: 'text', value: jsonRuleString(ir.literal, scope.json) };
      }
      return { kind: 'text', value: ir.literal };
    case 'or':
      // P1a || 组合（空值短路）。列表上下文（evaluateFieldNodes）不走这里——
      // 它按「首个非空节点集」逐支取，见 evaluateFieldNodes 的 or 分支。
      return evaluateOr(ir, scope, multi);
    case 'and':
      return evaluateAnd(ir, scope, multi);
    case 'xpath':
      return evaluateXPathRule(ir, scope, multi);
    case 'self':
      return { kind: 'text', value: selfText(scope) };
    case 'groupRef': {
      // legado makeUpRule：捕获组越界（含 `$N` 大于组数）插空串；代换后整体 trim。
      if (scope.kind !== 'json' || scope.groups === undefined) return evalFailed('$N 捕获组引用只能在 AllInOne 条目上求值');
      const groups = scope.groups;
      const value = ir.parts.map((part) => (part.kind === 'literal' ? part.text : groups[part.index] ?? '')).join('');
      return { kind: 'text', value: value.trim() };
    }
    case 'regexList':
      return evalFailed('AllInOne 列表规则只能按列表求值');
    default:
      return evalFailed('未知的规则 IR');
  }
}

/**
 * legado `content.toString()`（regex1027 正则-only 规则的输入）：整页作用域取页面原文（AnalyzeRule 的 content 是响应体
 * 字符串）；HTML 条目取元素 outerHtml，多个按行拼（jsoup Elements.toString）。jsoup 会带缩进美化输出，cheerio 原样序列化
 * ——跨块元素的 `.` 匹配在这里可能比 legado 宽松，准入实测把关。JSON 条目在 legado 是 Map.toString（`{k=v}`），不模拟。
 */
function selfText(scope: EvalScope): string {
  if (scope.source !== undefined) return scope.source;
  if (scope.kind !== 'html') return evalFailed('正则-only 规则不能对 JSON 条目求值');
  if (scope.contentText !== undefined) return scope.contentText;
  return scope.nodes.toArray().map((node) => scope.$.html(node as never) ?? '').join(MULTI_JOIN);
}

/**
 * JsoupXpath 语义求值（xpatheval1027）。JSON 输入上对齐 legado SourceRule：`/` 开头的段在 JSON 内容上走 Json 模式
 * （jsonRuleString），只有 `@XPath:` 前缀强制 XPath（对 JSON 无意义，按失败处理）。
 * 结果全是真元素 → 节点集（字段层照常转文本/列表）；content（multi）口径下元素取 outerHtml 逐行拼接（legado
 * JXNode.asString），交 content-html 转换；值结果单值取首个非空（与 dom-ops 单值口径一致），multi 逐行拼接。
 */
function evaluateXPathRule(
  ir: Extract<RuleIr, { kind: 'xpath' }>, scope: EvalScope, multi: boolean,
): EvalResult {
  if (scope.kind !== 'html') {
    if (ir.forced) return evalFailed('@XPath: 规则不能对 JSON 输入求值');
    return { kind: 'text', value: jsonRuleString(ir.source, scope.json) };
  }
  if (!ir.program) return evalFailed('规则在 HTML 输入上不是合法 XPath');
  const out = evaluateXPath(ir.program, scope.$, scope.nodes.toArray(), scope.pageUrl, multi);
  if (out.kind === 'nodes') {
    if (multi) return { kind: 'text', value: out.nodes.map((node) => scope.$.html(node as never) ?? '').join(MULTI_JOIN) };
    return { kind: 'nodes', nodes: scope.$(out.nodes as never) };
  }
  return { kind: 'text', value: multi ? out.values.join(MULTI_JOIN) : (out.values.find((v) => v.trim() !== '') ?? '') };
}

/**
 * || 组合求值（P1a，设计 §3.7「逐支求值，首个非空即停止」+ §7 P1a「节点与标量结果
 * 不压扁」）。字符串字段口径：
 * - 标量支（text/jsonpath/template/带 terminal 的 css）：值 trim 后非空即胜出，原样返回；
 * - 节点支（无 terminal 的 css）：以**文本视图**（@text + multi 口径，与字段层转换同款）
 *   判空——非空即胜出并返回该文本视图。空壳节点集（命中但文本全空，如 `<a><img></a>`）
 *   视为空，继续试下一支（legado getStringEach 的「首个非空」按字符串口径）。
 * 求值异常（选择器坏/作用域不匹配/超限）**不吞**：直接上抛（§5.1「非法规则及资源超限
 * 不得吞掉」），空值短路只对「求值成功但结果为空」生效。
 * 全部支皆空 → 空文本（字段层按「未命中」处理）。
 */
function evaluateOr(ir: { kind: 'or'; branches: RuleIr[] }, scope: EvalScope, multi: boolean): EvalResult {
  for (const branch of ir.branches) {
    const result = evaluateRule(branch, scope, multi);
    if (result.kind === 'text') {
      if (result.value.trim() !== '') return result;
      continue;
    }
    if (scope.kind !== 'html') {
      // css 支在 JSON 作用域已在 evaluateRule 内抛错，此处防御不可达路径。
      continue;
    }
    const textValue = applyTerminal(scope.$, result.nodes, { op: 'text' }, scope.pageUrl, multi);
    if (textValue.trim() !== '') return { kind: 'text', value: textValue };
  }
  return { kind: 'text', value: '' };
}

/**
 * && 合并求值（and1027，字符串口径）。legado AnalyzeByJSoup.getString / AnalyzeByJSonPath.getString：每支都求值，
 * 非空支按行拼接；节点支按字段层同款文本视图（@text，multi 口径随字段）。
 * `first`（URL 字段）：HTML 上对齐 getString0 取首个非空支；JSON 上 legado 不分 URL 照样按行拼——多支命中时
 * 拼出的是坏 URL，这里求值失败而不是另选一支（不替 legado 猜），只有一支命中时两者一致。
 */
function evaluateAnd(ir: Extract<RuleIr, { kind: 'and' }>, scope: EvalScope, multi: boolean): EvalResult {
  const values: string[] = [];
  for (const branch of ir.branches) {
    const result = evaluateRule(branch, scope, multi);
    const value = result.kind === 'text'
      ? result.value
      : scope.kind === 'html' ? applyTerminal(scope.$, result.nodes, { op: 'text' }, scope.pageUrl, multi) : '';
    if (value.trim() === '') continue;
    if (ir.first && scope.kind === 'html') return { kind: 'text', value };
    values.push(value);
  }
  if (ir.first && values.length > 1) return evalFailed('JSON 输入上 && URL 字段多支命中（legado 按行拼成坏 URL）');
  return { kind: 'text', value: values.join(MULTI_JOIN) };
}

/**
 * 模板渲染：字面段原样；`{{baseUrl}}`（TemplatePart kind='var'）取 scope.pageUrl；
 * `{{$.x}}` 取 jsonpath 首个命中（多值取首，避免把 URL 类字段拼坏）。
 *
 * html scope：只允许 literal + var（`{{baseUrl}}`）两类段——这正是 `ruleBookInfo.tocUrl =
 * "{{baseUrl}}##/detail/##/chapter/"` 这类「拿当前页 URL 改写」规则的形态；含 jsonpath 段的
 * 模板在 html scope 仍 evalFailed（jsonpath 是 JSON 输入的构件，口径不变）。
 * json scope：var 段同样取 pageUrl（legado 里 baseUrl 就是当前页 URL，与输入类型无关），
 * jsonpath 段照旧走 evalJsonPath。
 */
function renderTemplate(parts: TemplatePart[], scope: EvalScope): string {
  let out = '';
  for (const part of parts) {
    if (part.kind === 'literal') {
      out += part.text;
      continue;
    }
    if (part.kind === 'var') {
      out += scope.pageUrl;
      continue;
    }
    if (scope.kind !== 'json') return evalFailed('模板规则不能对 HTML 输入求值');
    const values = evalJsonPath(part.path, scope.json);
    out += values.length > 0 ? jsonValueToString(values[0]) : '';
  }
  return out;
}

/** JSON 值 → 字符串。对象/数组按 JSON 文本输出（legado 的 JSONPath 取值同为字符串化）。 */
export function jsonValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function jsonValuesToString(values: unknown[]): string {
  return values.map(jsonValueToString).join(MULTI_JOIN);
}

// ---------------------------------------------------------------- JSON 模式（legado Mode.Json）
// 对齐 legado AnalyzeByJSonPath.getString：先替换内嵌 `{$.x}` 规则；一处都没替换成功时，
// 整条规则交 Jayway 读取——不以 `$`/`@` 开头的路径补 `$.` 前缀。Jayway 解析/读取失败被
// legado 吞掉返回空串，这里同样返回空串、不抛错。

const INNER_JSON_RULE_OPEN = '{$.';

/** 默认语法规则重解释成的 JSONPath（按 IR 缓存；null=无法解释，求值恒空）。 */
const reinterpretedPaths = new WeakMap<RuleIr, JsonPathIr | null>();

function reinterpretedPath(ir: RuleIr): JsonPathIr | null {
  const cached = reinterpretedPaths.get(ir);
  if (cached !== undefined) return cached;
  const source = defaultSyntaxSource(ir);
  const path = source === undefined ? null : jaywayPath(source);
  reinterpretedPaths.set(ir, path);
  return path;
}

/**
 * 一条规则按 Jayway `JsonPath.read` 的口径编译成本引擎 JSONPath；非法或超出子集 → null（legado 吞异常得空）。
 * - `$` 开头原样；
 * - `@` 开头：`readContextToken` 要求 `@` 后紧跟 `.`/`[`，否则非法（如 `@text`）。顶层读取时
 *   `JsonPath.read` 以文档同时作 document 与 rootDocument（CompiledPath.evaluate → RootPathToken 以 document
 *   求值），所以 `@.x`/`@[n]` 与 `$.x`/`$[n]` 等价；
 * - 其余补前缀，见 jaywayJsonPath。
 */
function jaywayPath(rule: string): JsonPathIr | null {
  const source = rule.trim();
  let path: string;
  if (source.startsWith('$')) path = source;
  else if (source.startsWith('@')) {
    if (source.length > 1 && source[1] !== '.' && source[1] !== '[') return null;
    path = `$${source.slice(1)}`;
  } else path = jaywayJsonPath(source);
  try { return parseJsonPath(path); } catch { return null; }
}

/**
 * Jayway `PathCompiler.compile`（json-path 主仓 `internal/path/PathCompiler.java`，legado 经
 * `libs.json.path` 原样使用）的前缀规则：首字符不是 `$`/`@` 时**字面拼接** `"$." + path`，
 * 没有「以 `.` 开头视为相对当前节点」这一分支。故各形态的上游语义是：
 * - `x`    → `$.x`（子字段）；
 * - `.x`   → `$..x`（**递归下降**，非 `$.x`）。这与 `.bookList[*]` → `$..bookList[*]` 同源——
 *          复审报告把前者判为偏差、后者判为正确，两者其实是同一条规则，此处按上游原样保留；
 * - `..x`  → `$...x`（递归扫描后紧跟 `.`，Jayway `readDotToken` 对第二个 `.` 抛
 *          `Character '.' ... is not valid`）⇒ 上游抛错被吞成空串，这里 parse 失败同样得空；
 * - `[0]`  → `$.[0]`。Jayway 接受（`readDotToken` 后直接进 `readNextToken` 的 `[` 分支）且语义
 *          等于「根上的下标」`$[0]`；本引擎子集解析器不接受 `$.[0]`（`.` 后缺字段名），
 *          故回写为等价且可解析的 `$[0]`——这是本次唯一真正会改变取值结果的修正。
 * - `.[0]` → `$..[0]`（扫描 token 后接数组下标 token），子集解析器按 Jayway ScanPathToken 语义收下，
 *          见 jsonpath.ts 的 arrayScan 段。
 */
function jaywayJsonPath(source: string): string {
  return source.startsWith('[') ? `$${source}` : `$.${source}`;
}

/**
 * legado AnalyzeByJSonPath.getString 的单条规则分支（AnalyzeByJSonPath.kt:37-54，不含 `&&`/`||` 切分）：
 * 先替换内嵌 `{$.`，一处都没替换成功再把整条规则交 Jayway 读。
 */
function jsonRuleString(rule: string, json: unknown): string {
  const inner = rule.includes(INNER_JSON_RULE_OPEN) ? replaceInnerJsonRules(rule, json) : undefined;
  if (inner !== undefined) return inner;
  const path = jaywayPath(rule);
  return path ? jsonValuesToString(evalJsonPath(path, json)) : '';
}

/** 默认语法规则在 JSON 输入上的取值：jsonRuleString 的同款流程，Jayway 路径按 IR 缓存。 */
function jsonModeString(ir: RuleIr, json: unknown): string {
  const source = defaultSyntaxSource(ir) ?? '';
  const inner = source.includes(INNER_JSON_RULE_OPEN) ? replaceInnerJsonRules(source, json) : undefined;
  if (inner !== undefined) return inner;
  const path = reinterpretedPath(ir);
  return path ? jsonValuesToString(evalJsonPath(path, json)) : '';
}

/**
 * legado RuleAnalyzer.innerRule("{$.")：逐个找 `{$.`、按花括号配平取出内嵌规则并求值，
 * 求值非空才替换；一处都没替换成功返回 undefined（legado 此时返回空串，交由调用方决定回退）。
 * 内嵌规则的求值函数与 legado 一样是完整的 getString（AnalyzeByJSonPath.kt:41 `innerRule("{$.") { getString(it) }`），
 * 所以 `{$.a{$.x}}` 先替换内层，外层得到替换后的字串 `$.a<x>`（非空即采用，不再当路径读）。
 *
 * **失败时不中止**：legado 的循环体在「求值为空」或「花括号不配平」时走 `pos += inner.length`
 * 继续扫描（RuleAnalyzer.kt:326「拉出字段不平衡，inner 只是个普通字串，跳到此 inner 后继续匹配」），
 * 没有 break——所以内嵌规则一处失败不影响后续 `{$.` 被替换。续扫起点对齐该实现：
 * - 求值为空：chompCodeBalanced 已把 pos 推到 `}` 之后 ⇒ 起点 = close + 1；
 * - 花括号不配平：pos 仍停在 `{` ⇒ 起点 = at；
 * 两种情况再各 +inner.length（=3）。因此紧贴失败项 `}` 之后（余量 < 3 字符）的 `{$.` 会被跳过。
 */
function replaceInnerJsonRules(text: string, json: unknown): string | undefined {
  let out = '';
  let last = 0;
  let replaced = false;
  let at = text.indexOf(INNER_JSON_RULE_OPEN);
  while (at >= 0) {
    const close = matchingBrace(text, at);
    let value = '';
    if (close > at) value = jsonRuleString(text.slice(at + 1, close), json);
    if (value !== '') {
      out += text.slice(last, at) + value;
      last = close + 1;
      replaced = true;
      at = text.indexOf(INNER_JSON_RULE_OPEN, last);
    } else {
      // 不配平时 matchingBrace 返回 -1，close + 1 <= at，故 max() 退回 at；配平但求值为空时取 close + 1。
      at = text.indexOf(INNER_JSON_RULE_OPEN, Math.max(at, close + 1) + INNER_JSON_RULE_OPEN.length);
    }
  }
  return replaced ? out + text.slice(last) : undefined;
}

/**
 * `open` 处的 `{` 对应的 `}` 下标；不配平返回 -1。逐行对齐 legado RuleAnalyzer.chompCodeBalanced('{', '}')
 * （RuleAnalyzer.kt:91-126，jer-chao@c2c4775）：
 * - `\` 转义吞掉下一个字符（引号内外都一样）；
 * - 单/双引号内的字符不参与配平，另一种引号在其中不算开合；
 * - `[]` 深度非 0 时不数 `{}`；`]` 可把深度减成负数，此后 `{}` 都不再计数（上游同样如此，结果是不配平）。
 * 上游在串尾是 `\` 时会越界抛异常，这里按不配平处理。
 */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let braces = 0;
  let inSingle = false;
  let inDouble = false;
  let i = open;
  do {
    if (i >= text.length) break;
    const c = text[i++];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (inSingle || inDouble) continue;
    if (c === '[') depth += 1;
    else if (c === ']') depth -= 1;
    else if (depth === 0) {
      if (c === '{') braces += 1;
      else if (c === '}') braces -= 1;
    }
  } while (depth > 0 || braces > 0);
  // 只有深度 0 处的 `}` 能让 braces 归零，所以循环正常结束时最后读到的字符就是配对的 `}`。
  return depth > 0 || braces > 0 ? -1 : i - 1;
}

// ---------------------------------------------------------------- 字段求值（§3.3）
/**
 * 求值一个字符串字段：
 * 逐条候选取首个非空（M1 期候选数=1）；套用 ##正则## 替换；统一 trim()。
 * 空字符串 = 未命中（上层按「字段缺失降级」处理，§7.2）。
 *
 * `multi`（默认 false）：终端命中多个节点时是否拼接。单值字段（name/bookUrl/...）取首个非空；
 * 仅 `ruleContent.content` 由门面传 `multi=true` 拼接多段落。见 dom-ops.ts:applyTerminal。
 */
export function evaluateField(field: FieldIr, scope: EvalScope, multi = false): string {
  return withFieldJsLib(field, () => evaluateFieldBody(field, scope, multi));
}

function evaluateFieldBody(field: FieldIr, scope: EvalScope, multi: boolean): string {
  if (scope.kind === 'json' && scope.object !== undefined) {
    // itemvars1028：对象条目上 legado putRule 也按键直取求值，这里不复现，放袋的字段失败（不静默漏放）。
    if (field.varPuts !== undefined || field.varPut) return evalFailed('对象条目上的字段放变量袋，不复现');
    return objectFieldValue(field, scope.object);
  }
  checkBookMembers(field, scope);
  if (field.varGets && scope.host?.vars === undefined) return evalFailed('字段读变量袋，但作用域没带变量袋');
  if (field.varPuts !== undefined) putVars(field.varPuts, scope);
  if (field.chain) {
    const value = field.jsoup
      ? evaluateJsoupChain(field, field.chain, scope, false, multi)
      : evaluateChain(field.chain, scope, false, multi, field.jsGets, field.jsUtil);
    return chainToString(value, multi);
  }
  if (field.joins !== undefined || field.concats !== undefined) {
    // T7 构件（&& 连接符 / %% 拼接）：M1 未实现，宁可失败也不要静默返回错的字符串。
    return evalFailed('M1 不支持 && / %% 组合规则（T7）');
  }
  if (field.makeUp) return makeUpFieldValue(field, field.makeUp, scope, multi);
  let value = firstRuleValue(field.rules, scope, multi);
  const kind = field.rules.length === 1 ? field.rules[0].kind : undefined;
  // aio1027：模板代换后为空时 legado 拿捕获组列表的 toString 去做 `##` 替换（这类规则编译期已拒），这里空即空。
  if (kind === 'groupRef' && value === '') return '';
  if (field.regex !== undefined) value = applyRegexSubs(value, field.regex);
  // 正则-only 规则的输入是未解码的原文、AllInOne 条目值是正则截出的原文：对齐 legado getString 末段（含 `&` 即
  // unescapeHtml4）；正文（multi）交 content-html。
  if (!multi && (kind === 'self' || kind === 'groupRef') && value.includes('&')) value = decodeHTML(value);
  return value.trim();
}

/**
 * jslib1028：当前字段的 jsLib 原文（FieldIr.jsLib，compile.ts 只挂给带 JS 的顶层字段）。求值同步进行，入口（evaluateField /
 * evaluateFieldList / evaluateInitScope / evaluateFieldStrings）设上、返回时恢复；子字段（链里的规则段、模板占位、getter 白名单）
 * 不挂，沿用外层的库（legado 同源共享作用域）。未挂 = 沙箱绑定逐字不变。
 */
let fieldJsLib: string | undefined;

function withFieldJsLib<T>(field: FieldIr, run: () => T): T {
  if (field.jsLib === undefined) return run();
  const outer = fieldJsLib;
  fieldJsLib = field.jsLib;
  try {
    return run();
  } finally {
    fieldJsLib = outer;
  }
}

/** 沙箱绑定的 jsLib 键（jslib1028）：当前字段没库时不带键。 */
function jsLibBinding(): Pick<JsBindings, 'jsLib'> {
  return fieldJsLib === undefined ? {} : { jsLib: fieldJsLib };
}

/**
 * fieldnet1029：字段 `java.ajax` 要的页面还没取到（withFieldNet 缓存未命中）。`url` = JS 传进来的原串。沙箱把宿主回调的
 * RuleEngineError 原样抛出（JS 的 try/catch 吞不掉），evaluateFieldSafe 也不吞；门面/准入认出它取页后整段重放。
 */
export class FieldNetMissError extends RuleEngineError {
  constructor(readonly url: string) {
    super('RULE_EVAL_FAILED', 'java.ajax 页面未取');
    this.name = 'FieldNetMissError';
  }
}

/**
 * fieldnet1029：字段 `java.ajax` 的页面缓存（url 原串 → body）。求值同步进行，门面/准入的取页循环用 withFieldNet 设上、返回时
 * 恢复。未设 = 调用方不取页：挂了 jsAjax 的字段求值失败（不是未命中）。引擎本身仍零网络。
 */
let fieldNet: ReadonlyMap<string, string> | undefined;

export function withFieldNet<T>(net: ReadonlyMap<string, string>, run: () => T): T {
  const outer = fieldNet;
  fieldNet = net;
  try {
    return run();
  } finally {
    fieldNet = outer;
  }
}

/** 挂了 FieldIr.jsAjax 的字段的 ajax 回调（jsoup 包装成 Java 字符串）；其余字段不装，沙箱逐字不变。 */
function fieldNetCallbacks(field: FieldIr): NonNullable<JsBindings['callbacks']> | undefined {
  if (!field.jsAjax) return undefined;
  return {
    ajax: (url) => {
      const net = fieldNet;
      if (net === undefined) return evalFailed('java.ajax 需联网取页，当前调用方不取页');
      const body = net.get(url);
      if (body === undefined) throw new FieldNetMissError(url);
      return body;
    },
  };
}

/** 往沙箱绑定上并 ajax 回调（fieldnet1029）；字段没挂 jsAjax 时原样返回。 */
function withNetCallbacks<T extends Pick<JsBindings, 'callbacks'>>(field: FieldIr, bindings: T): T {
  const ajax = fieldNetCallbacks(field);
  return ajax === undefined ? bindings : { ...bindings, callbacks: { ...bindings.callbacks, ...ajax } };
}

/**
 * book1028：字段读到的书籍成员（FieldIr.bookMembers）须在作用域上带齐且非空。缺 = 调用方没有该阶段的书信息（不猜）；
 * 空串在 Rhino 里是 Java String 包装、真值判断为 true，与 JS 空串不同口径，也失败。
 */
function checkBookMembers(field: FieldIr, scope: EvalScope): void {
  const members = field.bookMembers;
  if (members === undefined) return;
  for (const member of members) {
    const value = scope.host?.book?.[member];
    if (value === undefined || value === '') evalFailed(`字段读 book.${member}，但作用域没带该成员或为空`);
  }
}

/** legado putRule（varbag1028）：字段规则之前、在同一内容上逐键求值存袋。作用域没带袋（不读目录的调用方）时不存。 */
function putVars(puts: NonNullable<FieldIr['varPuts']>, scope: EvalScope): void {
  const vars = scope.host?.vars;
  if (vars === undefined) return;
  for (const [key, rule] of puts) vars.set(key, evaluateField(rule, scope));
}

/** `@get:{键}`（varbag1028）：袋里没有的键得空串（legado get 落空口径；编译期已保证键由详情字段放）。 */
function varGet(key: string, scope: EvalScope): string {
  const vars = scope.host?.vars;
  if (vars === undefined) return evalFailed('目录字段读详情页变量，但作用域没带变量袋');
  return vars.get(key) ?? '';
}

/** 逐条候选取首个非空（节点结果按 text 取）。 */
function firstRuleValue(rules: readonly RuleIr[], scope: EvalScope, multi: boolean): string {
  let value = '';
  for (const ir of rules) {
    const result = evaluateRule(ir, scope, multi);
    if (result.kind === 'text') value = result.value;
    else value = scope.kind === 'html' ? applyTerminal(scope.$, result.nodes, { op: 'text' }, scope.pageUrl, multi) : '';
    if (value.trim() !== '') break;
  }
  return value;
}

/**
 * 规则级 makeUp（bind1028，见 parse.ts parseMakeUpField）：片段拼成串后 `split("##")`。Regex 模式首段 trim 即值（为空且有
 * 替换时对 content.toString() 替换），否则值取自规则主体；之后套拼出的正则（编译失败按 legado 口径回退）。Regex 模式的值
 * 与正则-only 主体是未解码文本，非正文字段含 `&` 时按 unescapeHtml4 口径（只认带分号的实体）解码。
 */
function makeUpFieldValue(field: FieldIr, makeUp: NonNullable<FieldIr['makeUp']>, scope: EvalScope, multi: boolean): string {
  const pieces = makeUpText(makeUp.parts, scope, multi).split('##');
  const regex = dynamicRegex(pieces);
  let value: string;
  let raw = true;
  if (makeUp.regexMode) {
    value = pieces[0].trim();
    if (value === '' && regex) value = selfText(scope);
  } else {
    value = firstRuleValue(field.rules, scope, multi);
    raw = field.rules[0]?.kind === 'self';
  }
  if (regex) value = applyRegexSubs(value, [regex]);
  if (!multi && raw && value.includes('&')) value = decodeHTMLStrict(value);
  return value.trim();
}

/** makeUp 拼出的串长度上限（jsext1028 同款）：占位可能拼进整页文本，超出即失败。 */
const MAX_MADE_UP_CHARS = 65_536;

/** 拼模板片段：`{{规则}}` 在字段作用域取字符串；`{{JS}}` 以当前内容为 result（legado makeUpRule(result)），null 不拼。 */
function makeUpText(parts: readonly JsTemplatePart[], scope: EvalScope, multi: boolean): string {
  let text = '';
  for (const part of parts) {
    if (part.kind === 'text') text += part.text;
    else if (part.kind === 'rule') text += evaluateField(part.field, scope, multi);
    else if (part.kind === 'get') text += varGet(part.key, scope);
    else {
      const out = runJs(part.code, { result: scope.source ?? '', src: scope.source, baseUrl: scope.pageUrl, ...hostBindings(scope), ...jsLibBinding() });
      if (Array.isArray(out)) return evalFailed('模板 {{JS}} 返回了数组（legado 按 NativeArray.toString 拼，不复现）');
      if (out !== null) text += out;
    }
    if (text.length > MAX_MADE_UP_CHARS) return evalFailed('模板 makeUp 后过长');
  }
  return text;
}

/** makeUp 切出的正则（`split("##")` 第 2/3 段，≥4 段 replaceFirst）；正则段为空不替换。 */
function dynamicRegex(pieces: readonly string[]): RegexSub | undefined {
  if (pieces.length < 2 || pieces[1] === '') return undefined;
  if (pieces[1].length > MAX_REGEX_PATTERN_LENGTH) return evalFailed('模板 makeUp 后正则 pattern 过长');
  const regex: RegexSub = { pattern: pieces[1], replacement: pieces[2] ?? '', dynamic: true };
  if (pieces.length > 3) regex.first = true;
  return regex;
}

/** 作用域上的宿主绑定 → 沙箱绑定（bind1028）。没注入的不进沙箱：JS 里引用它照旧 ReferenceError。 */
function hostBindings(scope: EvalScope): Pick<JsBindings, 'globals' | 'objects' | 'callbacks'> {
  const host = scope.host;
  if (host === undefined) return {};
  const objects: Record<string, Record<string, string>> = {};
  const out: Pick<JsBindings, 'globals' | 'objects' | 'callbacks'> = { objects };
  if (host.book !== undefined) objects.book = host.origin === undefined ? { ...host.book } : { ...host.book, origin: host.origin };
  else if (host.origin !== undefined) objects.book = { origin: host.origin };
  if (host.chapterTitle !== undefined) {
    objects.chapter = { title: host.chapterTitle };
    out.globals = { title: host.chapterTitle };
  }
  if (host.vars !== undefined) out.callbacks = varCallbacks(host.vars);
  return out;
}

/**
 * 变量袋回调（varbag1028）：legado `java.put(key, value)` 存值并原样返回、`java.get(key)` 取值（键编译期已核成字面量）。
 * put 的值不是字符串、get 多实参（legado 的 get(url, headers) 是网络请求）求值失败。
 */
function varCallbacks(vars: Map<string, string>): NonNullable<JsBindings['callbacks']> {
  return {
    put: (key, extra) => {
      const value = extra.length === 1 ? extra[0] : null;
      if (typeof value !== 'string') return evalFailed('java.put 的值不是单个字符串');
      vars.set(key, value);
      return value;
    },
    get: (key, extra) => (extra.length === 0 ? vars.get(key) ?? '' : evalFailed('java.get 多实参（legado 网络请求重载）不复现')),
  };
}

/**
 * JS 链的沙箱绑定：宿主只读绑定（bind1028）+ getter 回调（jsget1028）。getter 只认编译期白名单（FieldIr.jsGets）里的实参，
 * 在字段作用域上取值——legado 的 `java` 是 AnalyzeRule，content 是整页或列表条目，不随链上一段结果变；默认模式多个命中
 * 按行拼接。getString 结果含 `&` 时按 unescapeHtml4 口径解码，getStringList 按行拆、不解码。同一次执行内按实参记忆。
 * `util`（jsutil1028）= 字段 JS 用到了加解密 / toNumChapter 帮手（FieldIr.jsUtil），只此时让沙箱装这批帮手。
 * `initContent`（initjs1028，只给 JS init）：getter 收第二实参 mContent，须恰是 init 的 result（详情页原文，legado 在它上取值，
 * 与 content 同一份）；别的第二实参、多于两个实参求值失败。缺省时多余实参照旧不看。
 */
function jsBindings(
  scope: EvalScope, gets: FieldIr['jsGets'], util?: true, initContent?: string,
): Pick<JsBindings, 'globals' | 'objects' | 'callbacks' | 'utilHelpers' | 'jsLib'> {
  const base = util ? { ...hostBindings(scope), utilHelpers: true } : hostBindings(scope);
  const host = fieldJsLib === undefined ? base : { ...base, ...jsLibBinding() };
  if (gets === undefined) return host;
  return { ...host, callbacks: { ...host.callbacks, ...getterCallbacks(scope, gets, initContent) } };
}

/** jsget1028 的 getter 回调（口径见 jsBindings）；listget1028 的列表 JS 同用，scope 为页面作用域。 */
function getterCallbacks(
  scope: EvalScope, gets: NonNullable<FieldIr['jsGets']>, initContent?: string,
): NonNullable<JsBindings['callbacks']> {
  const memo = new Map<string, string>();
  const read = (rule: string, extra: readonly (string | null)[]): string => {
    if (initContent !== undefined && extra.length > 0 && (extra.length > 1 || extra[0] !== initContent)) {
      return evalFailed('init JS 的 java.getString 第二实参不是 result');
    }
    const field = gets.get(rule);
    if (field === undefined) return evalFailed('java.getString 的实参不在编译期白名单里');
    let value = memo.get(rule);
    if (value === undefined) {
      value = evaluateField(field, scope, true);
      memo.set(rule, value);
    }
    return value;
  };
  return {
    getString: (rule, extra) => {
      const value = read(rule, extra);
      return value.includes('&') ? decodeHTMLStrict(value) : value;
    },
    getStringList: (rule, extra) => splitLines(read(rule, extra)),
  };
}

/**
 * 求值一个列表字段（bookList/chapterList）：返回节点集供上层逐条套子规则。
 * M1 期候选数=1；非 HTML 作用域或未命中 → 空节点集。
 * P1a || 组合（or 节点在 rules[0]）：空值短路取**首个非空节点集**——只有节点支能
 * 献出节点集；标量支（text/jsonpath/template/带 terminal 的 css）在列表口径下视为
 * 空支（它没有节点身份，不能把「节点与标量压成一个 selector」，设计 §7 P1a），
 * 求值异常照旧上抛不吞。
 */
export function evaluateFieldNodes(field: FieldIr, scope: EvalScope): CheerioNodes {
  if (field.chain) return evalFailed('列表字段不支持 JS 链');
  if (scope.kind !== 'html') return emptyNodes();
  for (const ir of field.rules) {
    if (ir.kind === 'or') {
      for (const branch of ir.branches) {
        const result = evaluateRule(branch, scope);
        if (result.kind === 'nodes' && result.nodes.length > 0) return result.nodes;
      }
      continue;
    }
    if (ir.kind === 'and') {
      // and1027：各支节点集按支序拼接（legado getElements 的 Elements.addAll，保序、不去重）。
      const nodes = ir.branches.flatMap((branch) => {
        const result = evaluateRule(branch, scope);
        return result.kind === 'nodes' ? result.nodes.toArray() : [];
      });
      if (nodes.length > 0) return scope.$(nodes as never);
      continue;
    }
    if (ir.kind === 'regexList') continue; // AllInOne 条目不是节点（evaluateFieldList 另走 aioListScopes）
    const result = evaluateRule(ir, scope);
    if (result.kind === 'nodes' && result.nodes.length > 0) return result.nodes;
  }
  return scope.$([]);
}

/**
 * 列表字段逐条求值用的作用域序列（bookList → 每条的 name/author/bookUrl；chapterList 同理）。
 * - HTML：`evaluateFieldNodes` 的节点集逐个 `insideNode`，与直接调用二者逐字等价；
 * - JSON：对齐 legado AnalyzeByJSonPath.getList——JSONPath 规则按 `evalJsonPathList` 取列表项，
 *   默认语法规则补 `$.` 后同样处理（`.bookList[*]` → `$..bookList[*]`），`||` 取首个非空支；
 *   模板/字面量/显式 CSS 没有列表语义，视为空支。每项各自成为 JSON 作用域。
 * 条目作用域都沿用页面作用域的宿主绑定（bind1028；legado 同一个 AnalyzeRule 的 book 不随条目变）。
 */
export function evaluateFieldList(field: FieldIr, scope: EvalScope): EvalScope[] {
  return withFieldJsLib(field, () => evaluateFieldListBody(field, scope));
}

function evaluateFieldListBody(field: FieldIr, scope: EvalScope): EvalScope[] {
  checkBookMembers(field, scope);
  if (field.varGets && scope.host?.vars === undefined) evalFailed('列表字段读变量袋，但作用域没带变量袋');
  const scopes = fieldListScopes(field, scope);
  if (scope.host !== undefined) for (const item of scopes) item.host ??= scope.host;
  return scopes;
}

function fieldListScopes(field: FieldIr, scope: EvalScope): EvalScope[] {
  if (field.chain) return field.jsoup ? jsoupListScopes(field, field.chain, scope) : listChainScopes(field, field.chain, scope);
  const head = field.rules[0];
  if (head?.kind === 'regexList') return aioListScopes(head, scope);
  if (scope.kind === 'html') {
    const nodes = evaluateFieldNodes(field, scope);
    const scopes: EvalScope[] = [];
    for (let index = 0; index < nodes.length; index += 1) scopes.push(insideNode(scope, nodes[index]));
    return scopes;
  }
  for (const ir of field.rules) {
    const items = jsonListItems(ir, scope.json);
    if (items.length > 0) return items.map((item) => createJsonScope(item, scope.pageUrl));
  }
  return [];
}

/**
 * AllInOne 列表（aio1027）：对页面原文（legado `result.toString()`，HTML/JSON 页一样）在沙箱里跑 getElements 级联，
 * 每个末级匹配成为一个条目作用域。沙箱只回传 JSON 文本，宿主逐项校验形状，不信任沙箱产出。
 */
function aioListScopes(ir: Extract<RuleIr, { kind: 'regexList' }>, scope: EvalScope): EvalScope[] {
  const source = scope.source;
  if (source === undefined) return evalFailed('AllInOne 列表规则需要页面原文，当前作用域没有');
  const out = runJs(aioListCode(ir.stages), { result: source, src: source, baseUrl: scope.pageUrl });
  if (typeof out !== 'string') return evalFailed('AllInOne 列表求值结果异常');
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return evalFailed('AllInOne 列表求值结果异常');
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => Array.isArray(item) && item.every((group) => typeof group === 'string'))) {
    return evalFailed('AllInOne 列表求值结果异常');
  }
  return (parsed as string[][]).map((groups): JsonScope => ({ kind: 'json', json: undefined, pageUrl: scope.pageUrl, groups: ['', ...groups] }));
}

/**
 * 列表字段的 JS 链（listjs1027，legado AnalyzeRule.getElements）：首段 result = 页面原文，JS 段之间传字符串；
 * 末段 JS 的数组逐项成为条目，末段规则把上一段字符串重新解析成列表。中间段返回 null → 空列表（legado `result ?: continue`）。
 * 条目字段的 SourceRule 在 legado 里按**原页面**是否 JSON 定模式：条目的形态与原页面对不上（HTML 页上产出 JSON 条目、
 * 或反过来）时 legado 条目规则读不动，这里求值失败而不是按条目内容另选解释。`reverse`（`-` 前缀）由调用方对整表处理。
 */
function listChainScopes(field: FieldIr, chain: readonly ChainStage[], scope: EvalScope): EvalScope[] {
  const source = scope.source;
  if (source === undefined) return evalFailed('列表 JS 需要页面原文，当前作用域没有');
  const pageJson = scope.kind === 'json';
  const book = listBookBindings(field, scope);
  let value = source;
  for (let index = 0; index < chain.length; index += 1) {
    const stage = chain[index];
    const last = index === chain.length - 1;
    if (stage.kind === 'js') {
      const bindings = { result: value, src: source, baseUrl: scope.pageUrl, ...book };
      if (last) {
        const items = runJsItems(stage.code, bindings);
        return items === null ? [] : items.map((item) => listItemScope(item, pageJson, scope.pageUrl));
      }
      const out = runJs(stage.code, bindings);
      if (out === null) return [];
      if (Array.isArray(out)) return evalFailed('列表 JS 中间段返回了数组');
      value = out;
      continue;
    }
    if (stage.kind !== 'rule' || !last) return evalFailed('列表 JS 链形态异常');
    const itemsJson = stage.mode === 'json' || ((stage.mode ?? 'default') === 'default' && pageJson);
    if (itemsJson !== pageJson) return evalFailed('列表 JS 末段规则的模式与原页面不一致（legado 条目规则读不动）');
    return evaluateFieldList(stage.field, pageJson ? jsonTextScope(value, scope.pageUrl) : createHtmlScope(value, scope.pageUrl));
  }
  return evalFailed('列表 JS 链形态异常');
}

/**
 * 列表 JS 的 `book`（book1028）、变量袋回调（searchvars1028）、getter 回调（listget1028，在页面作用域上取值——legado getElements
 * 时 content 是整页）与加解密 / toNumChapter / t2s 帮手（listutil1029）：只给挂了 bookMembers / varGets / jsGets / jsUtil 的列表字段，
 * 其余宿主绑定列表 JS 照旧不给。
 */
function listBookBindings(field: FieldIr, scope: EvalScope): Pick<JsBindings, 'objects' | 'callbacks' | 'jsLib' | 'utilHelpers'> {
  const out: Pick<JsBindings, 'objects' | 'callbacks' | 'jsLib' | 'utilHelpers'> = { ...jsLibBinding() };
  if (field.jsUtil) out.utilHelpers = true;
  const book = field.bookMembers === undefined ? undefined : hostBindings(scope).objects?.book;
  if (book !== undefined) out.objects = { book };
  const vars = field.varGets ? scope.host?.vars : undefined;
  if (vars !== undefined) out.callbacks = varCallbacks(vars);
  if (field.jsGets !== undefined) out.callbacks = { ...out.callbacks, ...getterCallbacks(scope, field.jsGets) };
  return out;
}

/**
 * 字符串条目按原页面的模式重新解析（legado setContent(item) 后用页面级 SourceRule）；对象条目键值直取。
 * 字符串条目的原文就是条目本身（legado 条目字段的 JS 段 result/src 都是它），故挂 source。
 */
function listItemScope(item: JsListItem, pageJson: boolean, pageUrl: string): EvalScope {
  if (typeof item !== 'string') return { kind: 'json', json: undefined, pageUrl, object: item };
  const scope: EvalScope = pageJson ? jsonTextScope(item, pageUrl) : createHtmlScope(item, pageUrl);
  scope.source = item;
  return scope;
}

/**
 * jsoup1028 列表链（FieldIr.jsoup）：形态同 listChainScopes，另收首段取节点的规则——legado getElements 得 Elements，作为 result
 * 交给后面的 JS（只在 HTML 页上复现）；JS 段走 runJsoup/runJsoupItems，末段返回的 Element（含 Elements 的元素）各自成为条目。
 */
function jsoupListScopes(field: FieldIr, chain: readonly ChainStage[], scope: EvalScope): EvalScope[] {
  const source = scope.source;
  if (source === undefined) return evalFailed('列表 JS 需要页面原文，当前作用域没有');
  const pageJson = scope.kind === 'json';
  const getElements = jsoupGetElements(field, scope);
  const book = withNetCallbacks(field, listBookBindings(field, scope));
  const bookVariables = field.bookVars !== undefined;
  let value = source;
  let elements: JElement[] | undefined;
  for (let index = 0; index < chain.length; index += 1) {
    const stage = chain[index];
    const last = index === chain.length - 1;
    if (stage.kind === 'rule' && index === 0 && !last) {
      if (scope.kind !== 'html') return evalFailed('列表 JS 首段规则只在 HTML 页上复现');
      const nodes = evaluateFieldNodes(stage.field, scope).toArray() as AnyNode[];
      if (!nodes.every((node) => isJElement(node))) return evalFailed('列表 JS 首段规则命中了非元素节点');
      elements = nodes as JElement[];
      continue;
    }
    if (stage.kind === 'js') {
      const bindings: JsBindings = {
        result: value, src: source, baseUrl: scope.pageUrl, jsoup: { result: elements, getElements, bookVariables }, ...book,
      };
      elements = undefined;
      if (last) {
        const items = runJsoupItems(stage.code, bindings);
        return items === null ? [] : items.map((item) => (typeof item === 'object' && 'jsoupNode' in item
          ? nodeItemScope(item.jsoupNode, pageJson, scope.pageUrl)
          : listItemScope(item, pageJson, scope.pageUrl)));
      }
      const out = runJsoup(stage.code, bindings, chain[index + 1].kind === 'js' ? 'midjs' : 'mid');
      if (out === null) return [];
      if (Array.isArray(out)) return evalFailed('列表 JS 中间段返回了数组');
      value = out;
      continue;
    }
    if (stage.kind !== 'rule' || !last) return evalFailed('列表 JS 链形态异常');
    const itemsJson = stage.mode === 'json' || ((stage.mode ?? 'default') === 'default' && pageJson);
    if (itemsJson !== pageJson) return evalFailed('列表 JS 末段规则的模式与原页面不一致（legado 条目规则读不动）');
    return evaluateFieldList(stage.field, pageJson ? jsonTextScope(value, scope.pageUrl) : createHtmlScope(value, scope.pageUrl));
  }
  return evalFailed('列表 JS 链形态异常');
}

/** 列表 JS 返回的 Element 条目（jsoup1028）：在它所在文档上收窄成条目作用域；JSON 页上 legado 条目规则按 Json 模式读不动。 */
function nodeItemScope(node: JElement, pageJson: boolean, pageUrl: string): EvalScope {
  if (pageJson) return evalFailed('列表 JS 在 JSON 页上返回了 Element（legado 条目规则读不动）');
  const $ = docApi(node);
  return { kind: 'html', $, nodes: $(node as never) as unknown as CheerioNodes, pageUrl };
}

function jsonTextScope(text: string, pageUrl: string): JsonScope {
  const parsed = tryParseJson(text);
  return parsed.ok ? createJsonScope(parsed.value, pageUrl) : evalFailed('列表 JS 产出的不是 JSON（legado Json 模式解析失败）');
}

/**
 * 对象条目上的字段值（legado getString 的 NativeObject 分支）：键值直取 → 取不到即空串（不再套替换）→ `##` 替换 →
 * 含 `&` 解 HTML 实体 → trim（引擎统一口径）。值是数字/对象等 Rhino toString 口径不复现的类型时求值失败。
 */
function objectFieldValue(field: FieldIr, object: ReadonlyMap<string, string | null>): string {
  const key = field.objectKey;
  if (key === undefined) return evalFailed('列表 JS 对象条目上没有键值直取规则');
  if ('unsupported' in key) return evalFailed(`列表 JS 对象条目上不可复现的规则（${key.unsupported}）`);
  const raw = object.get(key.key);
  if (raw === undefined) return '';
  if (raw === null) return evalFailed('列表 JS 对象条目的值不是字符串/布尔');
  let value = key.regex === undefined ? raw : applyRegexSubs(raw, [key.regex]);
  if (value.includes('&')) value = decodeHTML(value);
  return value.trim();
}

function jsonListItems(ir: RuleIr, json: unknown): unknown[] {
  switch (ir.kind) {
    case 'jsonpath':
      return evalJsonPathList(ir.path, json);
    case 'css': {
      const path = reinterpretedPath(ir);
      return path ? evalJsonPathList(path, json) : [];
    }
    case 'or':
      for (const branch of ir.branches) {
        const items = jsonListItems(branch, json);
        if (items.length > 0) return items;
      }
      return [];
    case 'and':
      return ir.branches.flatMap((branch) => jsonListItems(branch, json));
    default:
      return [];
  }
}

// ---------------------------------------------------------------- 详情页 init（init1028）
/**
 * legado BookInfo `analyzeRule.setContent(analyzeRule.getElement(init))`：详情字段改在 init 的结果上求值（FieldIr.initScope
 * 由 compile.ts 只挂给可复现的 init）。getElement 按页面定模式（AnalyzeRule.SourceRule）：
 * - HTML：默认语法/CSS 取 Elements（`||` 取首个非空支），后续字段 `Jsoup.parse(Elements.toString())`——这里按行拼 outerHtml
 *   重新载入。带末端 op 的规则（getElements 把末段当选择器）与 JSONPath（Jayway 解析 HTML 抛错）求值失败。
 * - JSON：Jayway `ctx.read`（默认配置，不吞异常）。确定路径取命中值，缺失/null 即失败（setContent(null) 断言）；不确定路径
 *   取命中列表。对象/数组成为 JSON 作用域，字符串按页面重新判定 HTML/JSON；数字/布尔（Integer/Double.toString 口径）、
 *   显式 CSS（强制 JSoup 解析 JSON 文本）与 `||`（Jayway 不认）求值失败。
 * 页面 URL 与宿主绑定沿用页面作用域。
 */
export function evaluateInitScope(field: FieldIr, scope: EvalScope): EvalScope {
  return withFieldJsLib(field, () => evaluateInitScopeBody(field, scope));
}

function evaluateInitScopeBody(field: FieldIr, scope: EvalScope): EvalScope {
  checkBookMembers(field, scope);
  if (field.chain) {
    const next = jsInitScope(field, field.chain, scope);
    if (scope.host) next.host = scope.host;
    return next;
  }
  const ir = field.rules[0];
  if (field.rules.length !== 1 || ir === undefined) return evalFailed('init 规则不可复现');
  const next = scope.kind === 'html' ? htmlInitScope(ir, scope) : jsonInitScope(ir, scope);
  if (scope.host) next.host = scope.host;
  return next;
}

/**
 * JS init（initjs1028，compile.ts 只给 parse.ts initJsFieldSupported 判可复现的挂 initScope）：legado getElement 的 Js 模式，
 * `evalJS(init, content)`，result/src = 详情页原文。返回字符串 → 按内容重新判定 HTML/JSON 成为新页面；返回普通对象 → 详情字段
 * 按 FieldIr.objectKey 键值直取（legado getString 的 NativeObject 分支，compile.ts 给 ruleBookInfo 字段挂）。
 * makeUp 后带 `##` 替换或代码为空不复现。initjsoup1028：jsoup 重编出的 init（FieldIr.jsoup）改走 runJsoupInit——result/src 仍是
 * 详情页原文，`java.getElement(s)` 在页面作用域上取节点，返回 Element/Elements 求值失败。
 */
function jsInitScope(field: FieldIr, chain: readonly ChainStage[], scope: EvalScope): EvalScope {
  const stage = chain[0];
  if (chain.length !== 1 || stage?.kind !== 'js' || stage.regex !== undefined) return evalFailed('init JS 形态不可复现');
  const source = scope.source;
  if (source === undefined) return evalFailed('init JS 需要页面原文，当前作用域没有');
  const { code, regex } = makeUpJs(stage, source, scope, field.jsGets, field.jsUtil);
  if (regex !== undefined || code === '') return evalFailed('init JS makeUp 后带 ## 替换或为空，不复现');
  const bindings: JsBindings = { result: source, src: source, baseUrl: scope.pageUrl, ...jsBindings(scope, field.jsGets, field.jsUtil, source) };
  const budgetKey = stage.template ? stage.code : code;
  const out = field.jsoup
    ? runJsoupInit(code, withNetCallbacks(field, { ...bindings, jsoup: { getElements: jsoupGetElements(field, scope) } }), budgetKey)
    : runJsInit(code, bindings, budgetKey);
  if (typeof out === 'string') return rescope(out, scope);
  return { kind: 'json', json: undefined, pageUrl: scope.pageUrl, object: out };
}

function htmlInitScope(ir: RuleIr, scope: HtmlScope): HtmlScope {
  const nodesOf = (rule: RuleIr): CheerioNodes => {
    if (rule.kind !== 'css') return evalFailed('init 的 JSONPath 规则不能对 HTML 输入求值');
    if (rule.terminal !== undefined) return evalFailed('init 规则带末端取值（legado getElements 当选择器），不复现');
    const result = evaluateRule(rule, scope);
    return result.kind === 'nodes' ? result.nodes : evalFailed('init 规则没有取出节点集');
  };
  let nodes: CheerioNodes | undefined;
  if (ir.kind === 'or') {
    for (const branch of ir.branches) {
      nodes = nodesOf(branch);
      if (nodes.length > 0) break;
    }
  } else nodes = nodesOf(ir);
  const html = (nodes?.toArray() ?? []).map((node) => scope.$.html(node as never) ?? '').join(MULTI_JOIN);
  const next = createHtmlScope(html, scope.pageUrl);
  next.contentText = html;
  return next;
}

function jsonInitScope(ir: RuleIr, scope: JsonScope): EvalScope {
  if (scope.json === undefined) return evalFailed('init 规则不能对列表条目求值');
  let path: JsonPathIr | null;
  if (ir.kind === 'jsonpath') path = ir.path;
  else if (ir.kind === 'css' && defaultSyntaxSource(ir) !== undefined) path = reinterpretedPath(ir);
  else return evalFailed('init 规则在 JSON 输入上不可复现（显式 CSS 或 ||）');
  if (path === null) return evalFailed('init 规则不是合法 JSONPath');
  const values = evalJsonPath(path, scope.json);
  const value = isDefinitePath(path) ? values[0] : values;
  if (value === undefined || value === null) return evalFailed('init 规则在 JSON 上没有命中（legado setContent(null)）');
  if (typeof value === 'string') return rescope(value, scope);
  if (typeof value !== 'object') return evalFailed('init 取出数字/布尔，不复现');
  return createJsonScope(value, scope.pageUrl);
}

/**
 * 详情字段（ruleBookInfo.name/author/tocUrl…）的求值作用域：init 挂了 initScope 时换成 init 结果，否则即页面作用域。
 * 变量袋源（varbag1028）另挂一只袋：详情字段求值时往里 put，调用方按 name → author → tocUrl 求值后用 scopeVars 取出。
 * `seed`（itemvars1028）= 同一本书搜索条目带出的袋（legado toBook 复制变量），袋以它为初值；不传即空袋。
 */
export function bookInfoScope(compiled: CompiledRules, scope: EvalScope, seed?: Readonly<Record<string, string>>): EvalScope {
  const init = compiled.get('ruleBookInfo.init');
  const base = compiledUsesVarBag(compiled) ? { ...scope, host: { ...scope.host, vars: new Map(Object.entries(seed ?? {})) } } : scope;
  return init && !('skipped' in init) && init.initScope ? evaluateInitScope(init, base) : base;
}

/** 编译产物里是否有变量袋字段（varbag1028：详情 put 或目录 get；搜索字段的读袋属搜索袋，不算）。 */
export function compiledUsesVarBag(compiled: CompiledRules): boolean {
  for (const [name, field] of compiled) {
    if (name.startsWith('ruleSearch.')) continue;
    if (!('skipped' in field) && (field.varPuts !== undefined || field.varPut || field.varGets)) return true;
  }
  return false;
}

/** 编译产物里是否有读搜索袋的搜索字段（searchvars1028）。没有时调用方不挂袋，搜索求值路径逐字不变。 */
export function compiledUsesSearchVars(compiled: CompiledRules): boolean {
  for (const [name, field] of compiled) if (name.startsWith('ruleSearch.') && !('skipped' in field) && field.varGets) return true;
  return false;
}

/** 编译产物里是否有条目袋字段（itemvars1028）。有时门面按 legado 顺序逐条建袋、结果带上本条的袋。 */
export function compiledUsesItemVars(compiled: CompiledRules): boolean {
  for (const field of compiled.values()) if (!('skipped' in field) && field.itemVars) return true;
  return false;
}

/** 详情/目录字段是否读条目袋（itemvars1028）：是则调用方必须把搜索结果的袋交给详情，否则求值失败。 */
export function compiledDetailNeedsItemVars(compiled: CompiledRules): boolean {
  for (const [name, field] of compiled) if (!name.startsWith('ruleSearch.') && !('skipped' in field) && field.itemVars) return true;
  return false;
}

/** 作用域上的变量袋快照（varbag1028）；没挂袋返回 undefined。 */
export function scopeVars(scope: EvalScope): Record<string, string> | undefined {
  const vars = scope.host?.vars;
  return vars === undefined ? undefined : Object.fromEntries(vars);
}

/** 目录页作用域挂上详情页带来的变量袋（varbag1028）：袋是副本，目录求值不回写详情结果。 */
export function withVars<T extends EvalScope>(scope: T, vars: Readonly<Record<string, string>>): T {
  return { ...scope, host: { ...scope.host, vars: new Map(Object.entries(vars)) } };
}

/** 编译产物里是否有读书籍成员的字段（book1028）。没有时调用方不必准备书信息，求值路径逐字不变。 */
export function compiledUsesBook(compiled: CompiledRules): boolean {
  for (const field of compiled.values()) if (!('skipped' in field) && field.bookMembers !== undefined) return true;
  return false;
}

/** 作用域挂上本书已求出的书籍成员（book1028）；`book` 为 undefined 时原样返回。 */
export function withBook<T extends EvalScope>(scope: T, book: Readonly<Record<string, string>> | undefined): T {
  return book === undefined ? scope : { ...scope, host: { ...scope.host, book } };
}

// ---------------------------------------------------------------- JS 链（jsbox1027）
/** 字段是否编译成了 JS 链（ENGINE_SYNTAX_JS on 且字段含 JS 段）。 */
export function fieldUsesJs(field: FieldIr | SkippedField | undefined): field is FieldIr & { chain: ChainStage[] } {
  return field !== undefined && !('skipped' in field) && field.chain !== undefined;
}

/** 编译产物里是否有要用沙箱的字段：JS 链、AllInOne 列表（aio1027），或带 `{{JS}}` 的规则级 makeUp（bind1028）。调用方据此先 await preloadJsSandbox。 */
export function compiledUsesJs(compiled: CompiledRules): boolean {
  for (const field of compiled.values()) {
    if (fieldUsesJs(field)) return true;
    if ('skipped' in field) continue;
    if (field.rules[0]?.kind === 'regexList') return true;
    if (field.makeUp?.parts.some((part) => part.kind === 'js')) return true;
  }
  return false;
}

/**
 * 列表口径求值（legado getStringList，下一页链接用）：规则段按多值取（multi 拼接后按行拆），
 * JS 段返回数组即列表、返回字符串按 `\n` 拆；逐项 trim、去空。非链字段退化为单值列表。
 * URL 绝对化与去重留给调用方（对齐 legado isUrl 分支）。
 */
export function evaluateFieldStrings(field: FieldIr, scope: EvalScope): string[] {
  return withFieldJsLib(field, () => evaluateFieldStringsBody(field, scope));
}

function evaluateFieldStringsBody(field: FieldIr, scope: EvalScope): string[] {
  if (!field.chain && field.lastAttrList) {
    // lastattr1029：legado getStringList 末段 attr 逐节点取值，`##` 替换逐项套（不对拼接串）。
    const { regex, ...bare } = field;
    return splitLines(evaluateField(bare, scope, true))
      .map((item) => (regex === undefined ? item : applyRegexSubs(item, regex)).trim())
      .filter((item) => item !== '');
  }
  if (!field.chain) {
    const value = evaluateField(field, scope);
    return value === '' ? [] : [value];
  }
  checkBookMembers(field, scope);
  const value = field.jsoup
    ? evaluateJsoupChain(field, field.chain, scope, true, true)
    : evaluateChain(field.chain, scope, true, true, field.jsGets, field.jsUtil);
  if (value === null) return [];
  return (Array.isArray(value) ? value : value.split('\n')).map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * legado AnalyzeRule.getString / getStringList 的逐段执行（AnalyzeRule.kt）：
 * - 首段输入是作用域本身（规则段）或页面原文（JS / 纯正则段）；之后每段输入是上一段的字符串结果——
 *   规则段把它重新当页面解析（JSON/HTML 按内容判，见 normalizeBody），JS 段把它作为 `result`；
 * - JS 返回 null/undefined → 整条链中止（legado result=null 后跳过余下各段，最终得空）；
 * - 列表结果喂给 JS 前先做 `$n` 替换（SourceRule.makeUpRule：n≥1 取第 n 项，越界删去，`$0` 原样）。
 * `list` = getStringList 口径（规则段按多值拆行、正则逐项替换）；否则规则段按 `multi` 取值。
 */
function evaluateChain(
  chain: readonly ChainStage[], scope: EvalScope, list: boolean, multi: boolean, gets?: FieldIr['jsGets'], util?: true,
): JsValue | null {
  let value: JsValue | undefined; // undefined = 还在首段
  for (const stage of chain) {
    if (stage.kind === 'rule') {
      const stageScope = value === undefined ? scope : rescope(joinLines(value), scope);
      value = list ? splitLines(evaluateField(stage.field, stageScope, true)) : evaluateField(stage.field, stageScope, multi);
      // nullskip1029：legado getString 的 null（`result ?: continue`），余下各段不跑。isJSON 页上 Default 段走 JSONPath，取空得 ""。
      if (stage.nullSkip && !list && scope.kind === 'html' && value === '') return null;
      continue;
    }
    const input = value ?? scope.source ?? (stage.kind === 'js' && stage.detached ? '' : undefined);
    if (input === undefined) return evalFailed('JS 链首段需要页面原文，当前作用域没有');
    if (stage.kind === 'regex') {
      value = Array.isArray(input) && list
        ? input.map((item) => applyRegexSubs(item, stage.regex))
        : applyRegexSubs(joinLines(input), stage.regex);
      continue;
    }
    const { code, regex } = makeUpJs(stage, input, scope, gets, util);
    if (code === '') { // legado getString：makeUp 后代码为空只做替换；无替换时 evalJS("") 得 null
      if (regex === undefined) return null;
      value = applyRegexSubs(joinLines(input), [regex]);
      continue;
    }
    const out = runJs(code, { result: input, src: scope.source, baseUrl: scope.pageUrl, ...jsBindings(scope, gets, util) }, stage.template ? stage.code : code);
    if (out === null) return null;
    if (regex === undefined) value = out;
    else if (!Array.isArray(out)) value = applyRegexSubs(out, [regex]);
    else if (list) value = out.map((item) => applyRegexSubs(item, [regex]));
    else return evalFailed('JS 段返回数组后接 ## 替换（legado 按 List.toString 替换，不复现）');
  }
  return value ?? null;
}

/**
 * jsoup1028 字符串链（FieldIr.jsoup，parse.ts jsoupFrame）：逐段口径同 evaluateChain，JS 段改走 runJsoup——作用域是 HTML 条目时
 * （legado AnalyzeRule.content 是条目 Element）首段 result 与各段 src 都是该 Element；`java.getElement(s)` 在字段作用域上取节点。
 * 段产出能否流出由下一段定（JsoupMode）：后接规则不许 Element、后接 JS 还不许 Java 字符串，末段/后接正则按 getString 口径转字符串。
 * 条目 Element 接正则段或含 {{}} 的 JS 段（legado 按 toString 口径，不复现）求值失败。
 */
function evaluateJsoupChain(field: FieldIr, chain: readonly ChainStage[], scope: EvalScope, list: boolean, multi: boolean): JsValue | null {
  const item = scope.source === undefined ? jsoupItem(scope) : undefined;
  const getElements = jsoupGetElements(field, scope);
  let value: JsValue | undefined; // undefined = 还在首段
  for (let index = 0; index < chain.length; index += 1) {
    const stage = chain[index];
    if (stage.kind === 'rule') {
      const stageScope = value === undefined ? scope : rescope(joinLines(value), scope);
      value = list ? splitLines(evaluateField(stage.field, stageScope, true)) : evaluateField(stage.field, stageScope, multi);
      if (stage.nullSkip && !list && scope.kind === 'html' && value === '') return null; // nullskip1029，同 evaluateChain
      continue;
    }
    const element = value === undefined ? item : undefined;
    const input = value ?? scope.source ?? (element !== undefined || (stage.kind === 'js' && stage.detached) ? '' : undefined);
    if (input === undefined) return evalFailed('JS 链首段需要页面原文，当前作用域没有');
    if (stage.kind === 'js' && stage.template) return evalFailed('jsoup 直连的 JS 段含 {{}}');
    if (stage.kind === 'regex') {
      if (element !== undefined) return evalFailed('条目 Element 接正则段（legado 按 Element.toString 替换，不复现）');
      value = Array.isArray(input) && list
        ? input.map((entry) => applyRegexSubs(entry, stage.regex))
        : applyRegexSubs(joinLines(input), stage.regex);
      continue;
    }
    const { code, regex } = makeUpJs(stage, input, scope, field.jsGets, field.jsUtil);
    const next = chain[index + 1];
    const mode = regex !== undefined || next === undefined || next.kind === 'regex' ? 'final' : next.kind === 'rule' ? 'mid' : 'midjs';
    const bindings: JsBindings = withNetCallbacks(field, {
      result: input, src: scope.source, baseUrl: scope.pageUrl, ...jsBindings(scope, field.jsGets, field.jsUtil),
      jsoup: { result: element, src: item, getElements, bookVariables: field.bookVars !== undefined },
    });
    const out = runJsoup(code, bindings, mode, code);
    if (out === null) return null;
    if (regex === undefined) value = out;
    else if (!Array.isArray(out)) value = applyRegexSubs(out, [regex]);
    else if (list) value = out.map((entry) => applyRegexSubs(entry, [regex]));
    else return evalFailed('JS 段返回数组后接 ## 替换（legado 按 List.toString 替换，不复现）');
  }
  return value ?? null;
}

/** 作用域是 HTML 条目（单个 Element，非整页、非 init 结果）时的该 Element（jsoup1028）。 */
function jsoupItem(scope: EvalScope): JElement | undefined {
  if (scope.kind !== 'html' || scope.contentText !== undefined || scope.nodes.length !== 1) return undefined;
  const node = scope.nodes[0] as AnyNode;
  return isJElement(node) && !isDocument(node) ? node : undefined;
}

/**
 * `java.getElement(s)("规则")` 的宿主回调（jsoup1028）：只认编译期白名单（FieldIr.jsElements），在字段作用域上取节点
 * （legado getElements 的 content 是整页或条目，不随链上一段结果变）。非 HTML 作用域（JSON 页、init 结果）求值失败。
 */
function jsoupGetElements(field: FieldIr, scope: EvalScope): ((rule: string) => readonly JElement[]) | undefined {
  const elements = field.jsElements;
  if (elements === undefined) return undefined;
  return (rule) => {
    const sub = elements.get(rule);
    if (sub === undefined) return evalFailed('java.getElements 的实参不在编译期白名单里');
    if (scope.kind !== 'html' || scope.contentText !== undefined) return evalFailed('java.getElements 只在 HTML 作用域上复现');
    const nodes = evaluateFieldNodes(sub, scope).toArray() as AnyNode[];
    if (!nodes.every((node) => isJElement(node))) return evalFailed('java.getElements 命中了非元素节点');
    return nodes as JElement[];
  };
}

/** makeUp 后代码的长度上限（jsext1028）：占位可能拼进整页文本，超出即失败。 */
const MAX_MADE_UP_JS_CHARS = 65_536;

/**
 * JS 段执行前的 legado SourceRule.makeUpRule（jsext1028 见 parse.ts parseJsExtStage）：列表输入先做 `$n` 替换；
 * 有 `{{}}` 模板时逐个求值拼回代码——规则占位在字段作用域上取字符串，JS 占位以上一段结果为 result 求值——
 * 再按 `##` 切出代码与替换。占位结果为 null/数组（legado 口径不复现）、列表输入接模板一律求值失败。
 */
function makeUpJs(
  stage: Extract<ChainStage, { kind: 'js' }>, input: JsValue, scope: EvalScope, gets?: FieldIr['jsGets'], util?: true,
): { code: string; regex?: RegexSub } {
  if (!stage.template) return { code: Array.isArray(input) ? substituteListRefs(stage.code, input) : stage.code, regex: stage.regex };
  if (Array.isArray(input)) return evalFailed('列表结果接含 {{}} 的 JS 段（legado 口径不复现）');
  let text = '';
  for (const part of stage.template) {
    if (part.kind === 'text') text += part.text;
    else if (part.kind === 'rule') text += evaluateField(part.field, scope);
    else if (part.kind === 'get') text += varGet(part.key, scope);
    else {
      const out = runJs(part.code, { result: input, src: scope.source, baseUrl: scope.pageUrl, ...jsBindings(scope, gets, util) });
      if (out === null || Array.isArray(out)) return evalFailed('JS 段 {{}} 占位的结果不是字符串');
      text += out;
    }
    if (text.length > MAX_MADE_UP_JS_CHARS) return evalFailed('JS 段 makeUp 后过长');
  }
  const parts = text.split('##');
  const code = parts[0].trim();
  if (parts.length < 2 || parts[1] === '') return { code };
  if (parts[1].length > MAX_REGEX_PATTERN_LENGTH) return evalFailed('JS 段 makeUp 后正则 pattern 过长');
  const regex: RegexSub = { pattern: parts[1], replacement: parts[2] ?? '' };
  if (parts.length > 3) regex.first = true;
  return { code, regex };
}

/** 字符串口径收尾（legado getString 末段）：数组按行拼；非正文字段含 `&` 时解 HTML 实体；trim。 */
function chainToString(value: JsValue | null, multi: boolean): string {
  let text = value === null ? '' : joinLines(value);
  // 正文（multi）不在这里解：content-html 把 JS 链正文当 HTML 转纯文本，实体在那一步解（legado HtmlFormatter 后再 unescape）。
  if (!multi && text.includes('&')) text = decodeHTML(text);
  return text.trim();
}

function joinLines(value: JsValue): string {
  return Array.isArray(value) ? value.join('\n') : value;
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** SourceRule.makeUpRule 的 `$n`（1–2 位数字）替换：只在上一段结果是列表时发生。 */
function substituteListRefs(code: string, items: readonly string[]): string {
  return code.replace(/\$(\d{1,2})/g, (whole, digits: string) => {
    const index = Number(digits);
    if (index < 1) return whole;
    return index < items.length ? items[index] : '';
  });
}

/**
 * 套用 `##pattern##replacement##flags##` 替换（`##p##` 无 replacement 即删除匹配，§3.3）。
 * `first`（regex1027）= legado replaceFirst：取首个匹配串、对它再套一次替换（Matcher.group(0).replaceFirst），
 * 匹配外的文本丢弃，无匹配得空串。`dynamic`（bind1028）的 pattern 编译失败按 legado replaceRegex 回退：first 得 replacement，
 * 否则按字面量整串替换。
 */
export function applyRegexSubs(text: string, subs: readonly RegexSub[]): string {
  let out = text;
  for (const sub of subs) {
    let re: RegExp;
    try {
      // first 去掉 g（只取首个匹配）；AllInOne 的 Java 内联标志（aio1027，如 `(?s)`）随 flags 带过来。
      re = new RegExp(sub.pattern, sub.first ? (sub.flags ?? '').replace('g', '') : (sub.flags ?? 'g'));
    } catch {
      if (!sub.dynamic) return evalFailed(`正则无法编译：${sub.pattern}`, sub.pattern);
      out = sub.first ? sub.replacement : out.split(sub.pattern).join(sub.replacement);
      continue;
    }
    if (sub.first) {
      const match = re.exec(out);
      out = match ? match[0].replace(re, sub.replacement) : '';
      continue;
    }
    out = out.replace(re, sub.replacement);
  }
  return out;
}

// ---------------------------------------------------------------- 失败隔离（§3.4）
/**
 * 核心四要素字段（survey CORE_FIELDS 13 字段，与滤网 1 同口径）。
 * 核心字段求值失败 → 该源本轮 miss；其余（装饰字段）→ 置空继续。
 */
export const CORE_FIELDS: ReadonlySet<string> = new Set([
  'ruleSearch.bookList',
  'ruleSearch.bookUrl',
  'ruleSearch.name',
  'ruleSearch.author',
  'ruleBookInfo.name',
  'ruleBookInfo.author',
  'ruleBookInfo.tocUrl',
  'ruleToc.chapterList',
  'ruleToc.chapterName',
  'ruleToc.chapterUrl',
  'ruleToc.nextTocUrl',
  'ruleContent.content',
  'ruleContent.nextContentUrl',
]);

export function isCoreField(fieldName: string): boolean {
  return CORE_FIELDS.has(fieldName);
}

/**
 * 字段级安全求值（§3.4）：
 * 任何求值异常 → RuleEngineError('RULE_EVAL_FAILED')；
 * 核心字段上抛（该源本轮 miss），装饰字段置空继续。
 */
export function evaluateFieldSafe(fieldName: string, field: FieldIr, scope: EvalScope): string {
  try {
    return evaluateField(field, scope);
  } catch (error) {
    if (error instanceof FieldNetMissError) throw error; // fieldnet1029：待取页，交调用方取页重放
    const wrapped = error instanceof RuleEngineError && error.code === 'RULE_EVAL_FAILED'
      ? error
      : new RuleEngineError(
        'RULE_EVAL_FAILED',
        `字段求值失败：${fieldName}（${error instanceof Error ? error.message : String(error)}）`,
        fieldName,
      );
    if (isCoreField(fieldName)) throw wrapped;
    return '';
  }
}

/** 空节点集（JSON 作用域下求列表字段用；单纯用来表达「无命中」）。 */
function emptyNodes(): CheerioNodes {
  return load('')([]) as unknown as CheerioNodes;
}

function evalFailed(message: string, rule?: string): never {
  throw new RuleEngineError('RULE_EVAL_FAILED', message, rule);
}
