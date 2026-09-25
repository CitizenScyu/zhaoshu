// 求值层：IR × (DOM | JSON) → 字符串/节点集；##正则替换##；字段后处理与失败隔离。
// 设计依据：m1-engine-design.md v3 §3.1（输入归一化）/ §3.2（DOM 求值）/ §3.3（正则与后处理）
// / §3.4（失败隔离）。引擎零网络：本文件不引入任何请求路径，页 URL 由调用方经 scope 传入。

import { load, type CheerioAPI } from 'cheerio';
import {
  type FieldIr, type JsonPathIr, RuleEngineError, type RuleIr, type RegexSub, type TemplatePart,
} from './types';
import { evalJsonPath, evalJsonPathList, parseJsonPath } from './jsonpath';
import { defaultSyntaxSource } from './parse';
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
      // JSON 输入上字面量里的 `{$.x}` 内嵌规则就地替换（如 `http://h/b/{$.id}.html`）；
      // 没有可替换的内嵌规则则原样返回字面量。
      if (scope.kind === 'json' && ir.literal.includes(INNER_JSON_RULE_OPEN)) {
        return { kind: 'text', value: replaceInnerJsonRules(ir.literal, scope.json) ?? ir.literal };
      }
      return { kind: 'text', value: ir.literal };
    case 'or':
      // P1a || 组合（空值短路）。列表上下文（evaluateFieldNodes）不走这里——
      // 它按「首个非空节点集」逐支取，见 evaluateFieldNodes 的 or 分支。
      return evaluateOr(ir, scope, multi);
    default:
      return evalFailed('未知的规则 IR');
  }
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
  let path: JsonPathIr | null = null;
  // `@` 开头在 Jayway 里是当前节点语法（如 `@text`，其后必须紧跟 `.`/`[`，否则非法），
  // 故不前缀，按读取失败处理。
  if (source !== undefined && !source.startsWith('@')) {
    try { path = parseJsonPath(jaywayJsonPath(source)); } catch { path = null; }
  }
  reinterpretedPaths.set(ir, path);
  return path;
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
 */
function jaywayJsonPath(source: string): string {
  return source.startsWith('[') ? `$${source}` : `$.${source}`;
}

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
    if (close > at) {
      try { value = jsonValuesToString(evalJsonPath(parseJsonPath(text.slice(at + 1, close)), json)); } catch { value = ''; }
    }
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

/** `open` 处的 `{` 对应的 `}` 下标；不配平返回 -1。 */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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
  if (field.joins !== undefined || field.concats !== undefined) {
    // T7 构件（&& 连接符 / %% 拼接）：M1 未实现，宁可失败也不要静默返回错的字符串。
    return evalFailed('M1 不支持 && / %% 组合规则（T7）');
  }
  let value = '';
  for (const ir of field.rules) {
    const result = evaluateRule(ir, scope, multi);
    if (result.kind === 'text') value = result.value;
    else value = scope.kind === 'html' ? applyTerminal(scope.$, result.nodes, { op: 'text' }, scope.pageUrl, multi) : '';
    if (value.trim() !== '') break;
  }
  if (field.regex !== undefined) value = applyRegexSubs(value, field.regex);
  return value.trim();
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
  if (scope.kind !== 'html') return emptyNodes();
  for (const ir of field.rules) {
    if (ir.kind === 'or') {
      for (const branch of ir.branches) {
        const result = evaluateRule(branch, scope);
        if (result.kind === 'nodes' && result.nodes.length > 0) return result.nodes;
      }
      continue;
    }
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
 */
export function evaluateFieldList(field: FieldIr, scope: EvalScope): EvalScope[] {
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
    default:
      return [];
  }
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
