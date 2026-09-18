// 求值层：IR × (DOM | JSON) → 字符串/节点集；##正则替换##；字段后处理与失败隔离。
// 设计依据：m1-engine-design.md v3 §3.1（输入归一化）/ §3.2（DOM 求值）/ §3.3（正则与后处理）
// / §3.4（失败隔离）。引擎零网络：本文件不引入任何请求路径，页 URL 由调用方经 scope 传入。

import { load, type CheerioAPI } from 'cheerio';
import { type FieldIr, RuleEngineError, type RuleIr, type RegexSub, type TemplatePart } from './types';
import { evalJsonPath } from './jsonpath';
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
  if (bytes.toString('base64').replace(/=+$/u, '') !== compact.replace(/=+$/u, '')) return payload;
  const decoded = bytes.toString('utf8');
  // UTF-8 有效性：空结果或含替换字符 U+FFFD = 解码出的不是合法文本，回落原文。
  if (decoded === '' || decoded.includes('�')) return payload;
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
/** HTML 输入的作用域。`nodes` 是求值起点：整篇文档（`$.root()`）或 bookList 的某一条。 */
export interface HtmlScope {
  kind: 'html';
  $: CheerioAPI;
  nodes: CheerioNodes;
  pageUrl: string;
}

/** JSON 输入的作用域（jsonpath / tpl_jsonpath 规则用）。 */
export interface JsonScope {
  kind: 'json';
  json: unknown;
  pageUrl: string;
}

export type EvalScope = HtmlScope | JsonScope;

export type EvalResult = { kind: 'text'; value: string } | { kind: 'nodes'; nodes: CheerioNodes };

/** 载入 HTML 建立文档级作用域。 */
export function createHtmlScope(html: string, pageUrl: string): HtmlScope {
  const $ = load(html);
  return { kind: 'html', $, nodes: $.root() as unknown as CheerioNodes, pageUrl };
}

/** 建立 JSON 作用域。 */
export function createJsonScope(json: unknown, pageUrl: string): JsonScope {
  return { kind: 'json', json, pageUrl };
}

/** 按归一化结果建立作用域（§3.1 的分流点）。 */
export function createScope(body: NormalizedBody, pageUrl: string): EvalScope {
  return body.kind === 'json' ? createJsonScope(body.json, pageUrl) : createHtmlScope(body.text, pageUrl);
}

/** 收窄作用域到某个节点（列表字段逐条求值用，如 bookList → 每条的 name/author/bookUrl）。 */
export function insideNode(scope: HtmlScope, node: unknown): HtmlScope {
  return { ...scope, nodes: scope.$(node as never) };
}

// ---------------------------------------------------------------- 单规则求值
export function evaluateRule(ir: RuleIr, scope: EvalScope): EvalResult {
  switch (ir.kind) {
    case 'css': {
      if (scope.kind !== 'html') return evalFailed('HTML 选择器规则不能对 JSON 输入求值');
      const result = evaluateCssChain(scope.$, scope.nodes, ir.chain, ir.terminal, scope.pageUrl);
      return typeof result === 'string' ? { kind: 'text', value: result } : { kind: 'nodes', nodes: result };
    }
    case 'jsonpath': {
      if (scope.kind !== 'json') return evalFailed('JSONPath 规则不能对 HTML 输入求值');
      return { kind: 'text', value: jsonValuesToString(evalJsonPath(ir.path, scope.json)) };
    }
    case 'template':
      return { kind: 'text', value: renderTemplate(ir.parts, scope) };
    case 'text':
      return { kind: 'text', value: ir.literal };
    default:
      return evalFailed('未知的规则 IR');
  }
}

/** `{{$.x}}` 模板渲染：字面段原样，求值段取首个命中（多值取首，避免把 URL 类字段拼坏）。 */
function renderTemplate(parts: TemplatePart[], scope: EvalScope): string {
  if (scope.kind !== 'json') return evalFailed('模板规则不能对 HTML 输入求值');
  let out = '';
  for (const part of parts) {
    if (part.kind === 'literal') {
      out += part.text;
      continue;
    }
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

// ---------------------------------------------------------------- 字段求值（§3.3）
/**
 * 求值一个字符串字段：
 * 逐条候选取首个非空（M1 期候选数=1）；套用 ##正则## 替换；统一 trim()。
 * 空字符串 = 未命中（上层按「字段缺失降级」处理，§7.2）。
 */
export function evaluateField(field: FieldIr, scope: EvalScope): string {
  if (field.joins !== undefined || field.concats !== undefined) {
    // T7 构件（&& 连接符 / %% 拼接）：M1 未实现，宁可失败也不要静默返回错的字符串。
    return evalFailed('M1 不支持 && / %% 组合规则（T7）');
  }
  let value = '';
  for (const ir of field.rules) {
    const result = evaluateRule(ir, scope);
    if (result.kind === 'text') value = result.value;
    else value = scope.kind === 'html' ? applyTerminal(scope.$, result.nodes, { op: 'text' }, scope.pageUrl) : '';
    if (value.trim() !== '') break;
  }
  if (field.regex !== undefined) value = applyRegexSubs(value, field.regex);
  return value.trim();
}

/**
 * 求值一个列表字段（bookList/chapterList）：返回节点集供上层逐条套子规则。
 * M1 期候选数=1；非 HTML 作用域或未命中 → 空节点集。
 */
export function evaluateFieldNodes(field: FieldIr, scope: EvalScope): CheerioNodes {
  if (scope.kind !== 'html') return emptyNodes();
  for (const ir of field.rules) {
    const result = evaluateRule(ir, scope);
    if (result.kind === 'nodes' && result.nodes.length > 0) return result.nodes;
  }
  return scope.$([]);
}

/** 套用 `##pattern##replacement##flags##` 替换（`##p##` 无 replacement 即删除匹配，§3.3）。 */
export function applyRegexSubs(text: string, subs: readonly RegexSub[]): string {
  let out = text;
  for (const sub of subs) {
    let re: RegExp;
    try {
      re = new RegExp(sub.pattern, sub.flags ?? 'g');
    } catch {
      return evalFailed(`正则无法编译：${sub.pattern}`, sub.pattern);
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
