// 规则文本 → IR。方言识别（默认语法/@css:/css:/JSONPath $. /纯文本/{{$.x}} 模板）、
// 构件白名单、##正则##尾缀剥离、深度/长度上限、不支持构件编译期拒绝（RULE_UNSUPPORTED）。
// 设计依据：m1-engine-design.md v3 §2.3。这就是滤网 1 的实现本体。

import {
  CssStep,
  FieldIr,
  JsonPathIr,
  MAX_CSS_CHAIN_DEPTH,
  MAX_OR_BRANCHES,
  MAX_REGEX_PATTERN_LENGTH,
  MAX_RULE_LENGTH,
  RegexSub,
  RuleDiagnostic,
  RuleEngineError,
  RuleIr,
  TemplatePart,
  TerminalOp,
} from './types';
import { parseJsonPath } from './jsonpath';
import { engineSyntaxOrEnabled } from './syntax-flags';

function unsupported(msg: string, rule: string, diagnostic: RuleDiagnostic): never {
  throw new RuleEngineError('RULE_UNSUPPORTED', msg, rule, diagnostic);
}

// ---- 不支持构件（编译期一律拒绝，见 §0/§2.3 与任务 reject-list）----
// xpath / tpl_rule({{@@}}) / tpl_var({{变量}}) / put(@put:) / get(@get:) /
// tpl_js_expr / @js:/<js> / ||(顶层) / &&(顶层) / %%(拼接) / match:
const JS_EXPR_RE = /[=+*/%!<>?;]|java\.|Date\.|baseUrl\.|typeof|new\s|\breturn\b|\.match\(|\.replace\(/;

/**
 * 顶层构件白名单校验（在剥正则尾缀之前，对整条规则做粗筛）。
 * 命中任何不支持构件 → RULE_UNSUPPORTED。
 */
function rejectUnsupportedConstructs(rule: string): void {
  if (rule.includes('@js:') || /<js\b|<js>/.test(rule)) unsupported('规则含 JS（@js:/<js>）', rule, { code: 'unsupported_js' });
  if (rule.includes('@put:')) unsupported('规则含 @put 变量存取', rule, { code: 'unsupported_var_put' });
  if (rule.includes('@get:')) unsupported('规则含 @get 变量存取', rule, { code: 'unsupported_var_get' });
  if (rule.trimStart().startsWith('match:')) unsupported('规则含 match: 正则', rule, { code: 'unsupported_regex_match' });
  if (rule.includes('%%')) unsupported('规则含 %% 拼接（T7）', rule, { code: 'unsupported_operator', operator: '%%' });
  rejectUnsupportedTemplates(rule);
}

/**
 * 全串扫描 {{...}} 模板并拒绝不支持类别（对齐 §2.3 step 2 与 survey.py refined_feats：
 * 二者都对整条规则做扫描——含正则尾缀里的 {{变量}}，如 `##...{{chapter.title}}`）。
 * 只有 {{$...}}（tpl_jsonpath）放行；{{@@}}（tpl_rule）/JS 表达式（tpl_js_expr）/
 * 其余 {{变量}}（tpl_var）一律 RULE_UNSUPPORTED。
 */
function rejectUnsupportedTemplates(rule: string): void {
  const re = /\{\{(.*?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule)) !== null) {
    const inner = m[1].trim();
    if (inner.startsWith('$')) continue; // tpl_jsonpath（M1 支持）
    if (inner.startsWith('@@')) unsupported('模板含 {{@@规则}}（tpl_rule）', rule, { code: 'unsupported_template_rule' });
    if (JS_EXPR_RE.test(inner)) unsupported('模板含 JS 表达式（tpl_js_expr）', rule, { code: 'unsupported_template_js' });
    unsupported('模板含 {{变量}}（tpl_var）', rule, { code: 'unsupported_template_var' });
  }
}

/** XPath 判别（survey.py JS_EXPR 之外的 xpath 检测同款口径）。 */
function looksLikeXPath(rule: string): boolean {
  return /(^\s*\/\/|\/text\(\)|\[@|starts-with\(|following-sibling|\/\/@)/.test(rule);
}

/**
 * 解析 {{...}} 模板：只允许 {{$.x}}（tpl_jsonpath）。
 * {{@@...}}=tpl_rule、{{变量}}=tpl_var、含 JS 表达式=tpl_js_expr → 一律 RULE_UNSUPPORTED。
 * 返回 null 表示该段不含 {{}}（走非模板路径）。
 */
function tryParseTemplate(segment: string, rule: string): TemplatePart[] | null {
  if (!segment.includes('{{')) return null;
  const parts: TemplatePart[] = [];
  const re = /\{\{(.*?)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    if (m.index > last) parts.push({ kind: 'literal', text: segment.slice(last, m.index) });
    const inner = m[1].trim();
    if (inner.startsWith('@@')) unsupported('模板含 {{@@规则}}（tpl_rule）', rule, { code: 'unsupported_template_rule' });
    if (inner.startsWith('$')) {
      parts.push({ kind: 'jsonpath', path: parseJsonPath(inner) });
    } else if (JS_EXPR_RE.test(inner)) {
      unsupported('模板含 JS 表达式（tpl_js_expr）', rule, { code: 'unsupported_template_js' });
    } else {
      unsupported('模板含 {{变量}}（tpl_var）', rule, { code: 'unsupported_template_var' });
    }
    last = re.lastIndex;
  }
  if (last < segment.length) parts.push({ kind: 'literal', text: segment.slice(last) });
  return parts;
}

// ---- 顶层 || 切分（括号/引号感知）----
/** 按顶层 || 切分；括号 () [] 与引号 '' "" 内的 || 不计。 */
export function splitTopLevel(rule: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (let i = 0; i < rule.length; i++) {
    const ch = rule[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && rule.startsWith(sep, i)) {
      out.push(buf);
      buf = '';
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// ---- P1a tokenizer：顶层 || 切分（括号/引号/花括号/反斜杠转义感知）----
/**
 * P1a tokenizer（设计 §4 末段：splitTopLevel 未处理转义与花括号，不能当完整 Legado
 * tokenizer；§3.7：RuleAnalyzer 感知 []、代码 {}、引号与反斜杠）。
 * 只用于 **on 态** 的 || 切分；off 态继续用上面的旧 splitTopLevel（行为冻结）。
 * 相比旧函数多两件事：
 * 1) `{}`：模板 `{{...}}`、JSONPath filter 代码块内的 || 不切；
 * 2) `\`：反斜杠转义下一个字符——`\|`、`\|\|` 不构成操作符（legado RuleAnalyzer 的
 *    反斜杠感知同款），转义字符原样留在支内。
 */
export function tokenizeOrBranches(rule: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < rule.length; i++) {
    const ch = rule[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    const closer = ch === ')' ? '(' : ch === ']' ? '[' : ch === '}' ? '{' : null;
    if (closer) {
      const at = stack.lastIndexOf(closer);
      if (at >= 0) stack.length = at; // 弹到最近匹配（未配对开括号宽容忽略）
    } else if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    }
    if (stack.length === 0 && rule.startsWith('||', i)) {
      out.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// ---- ##正则##尾缀剥离 ----
/**
 * 从段尾剥出 ##pattern##replacement##flags## 系列。
 * 1 个 ##=只删匹配（replacement=''）、2 个=删、3 个=pattern/replacement(/flags)。
 * 返回 { body, regex }。pattern 编译失败 → RULE_UNSUPPORTED。
 */
export function stripRegexSuffix(segment: string, rule: string): { body: string; regex: RegexSub[] } {
  const idx = segment.indexOf('##');
  if (idx < 0) return { body: segment, regex: [] };
  const body = segment.slice(0, idx);
  const tail = segment.slice(idx); // 以 ## 开头
  // 按 ## 切；首元素为空（因 tail 以 ## 开头）
  const chunks = tail.split('##');
  chunks.shift(); // 去掉前导空
  // 末尾可能因 trailing ## 产生空串，保留语义：pattern##（删匹配）
  const regex: RegexSub[] = [];
  // legado：单个 ## 段序列即一组 pattern/replacement/flags；不常见多组，这里按三元一组尽力解析。
  // 结构：[pattern, replacement?, flags?, ...]。M1 观察到最多一组（含 trailing ### 空 flags）。
  const pattern = chunks[0] ?? '';
  const replacement = chunks[1] ?? '';
  const flags = chunks[2] !== undefined && chunks[2] !== '' ? chunks[2] : undefined;
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) unsupported('正则 pattern 过长', rule, { code: 'regex_pattern_too_long' });
  // 只保留合法 JS 正则 flag 字符（去重）；legado 规则常有 trailing ### 等噪声 → 视作无 flags。
  const cleanFlags = flags ? [...new Set(flags.split(''))].filter((c) => 'gimsuy'.includes(c)).join('') : '';
  const finalFlags = cleanFlags === '' ? undefined : cleanFlags;
  try {
    new RegExp(pattern, finalFlags ?? 'g');
  } catch {
    unsupported(`正则 pattern 无法编译：${pattern}`, rule, { code: 'regex_invalid' });
  }
  regex.push({ pattern, replacement, flags: finalFlags });
  return { body, regex };
}

// ---- 默认语法翻译 ----
const TERMINAL_KEYWORDS = new Set([
  'text',
  'textNodes',
  'ownText',
  'html',
  'all',
  'content',
  'href',
  'src',
  'title',
  'alt',
  'data',
  'srcset',
  'value',
]);

type TerminalKeyword = Exclude<Extract<TerminalOp, { op: string }>['op'], 'attr'>;

// legado 运行时特殊变量（非 DOM 属性）——§2.3 第 5 条：不认识的 token 编译期拒绝，不猜测。
// 若当具名属性兜底（@baseUrl → {op:'attr',name:'baseUrl'}）会让实跑不通的源静默编译通过，污染数字。
const LEGADO_SPECIAL_VARS = new Set(['baseUrl', 'result', 'book', 'chapter', 'headerMap']);

function toTerminal(token: string, rule: string): TerminalOp {
  if (TERMINAL_KEYWORDS.has(token)) return { op: token as TerminalKeyword };
  if (LEGADO_SPECIAL_VARS.has(token)) unsupported(`不支持 legado 特殊变量 @${token}`, rule, { code: 'unsupported_special_var' });
  // 具名属性兜底：@some-attr（HTML 属性名，含连字符/冒号）
  if (/^[\w:-]+$/.test(token)) return { op: 'attr', name: token };
  unsupported(`不支持的末端操作 @${token}`, rule, { code: 'unsupported_terminal' });
}

/**
 * 翻译一个「@ 段」内的 selector + 索引/切片/排除 后缀为 CssStep。
 * 处理：tag.X / class.X（多 class 空格→.）/ id.X / text.X / .class 简写 /
 * X.n（标签+索引）/ !n 排除 / .n:m 切片。
 */
function translateStep(raw: string, rule: string): CssStep {
  let s = raw.trim();
  const step: CssStep = { selector: '' };

  // 关键字前缀翻译。text. 特殊：其后是「关键字文本」而非选择器片段。
  if (/^text\./.test(s)) {
    const keyword = s.slice('text.'.length);
    step.selector = `:contains(${cssEscapeContains(keyword)})`;
    step.ownTextContains = keyword;
    return step;
  }

  // 逐 token 处理 class./id./tag. 与索引/排除后缀。先剥后缀（!排除、.数字索引/切片）。
  s = extractSuffixes(s, step, rule);

  // 关键字翻译
  s = s
    .replace(/(^|\s)tag\.([A-Za-z][\w-]*)/g, '$1$2')
    .replace(/(^|\s)id\.([\w-]+)/g, '$1#$2')
    .replace(/(^|\s)class\.([\w-]+(?:\s+[\w-]+)*)/g, (_m, pre, cls: string) => pre + '.' + cls.trim().split(/\s+/).join('.'));

  step.selector = s.trim();
  return step;
}

/**
 * 剥出末端索引/切片/排除后缀（.n / .n:m / !n / !a:b:c / [!a,b]）。
 * legado 语义：紧贴选择器尾的 .数字 是索引，! 开头是排除。
 */
function extractSuffixes(s: string, step: CssStep, rule: string): string {
  // 括号排除 [!1,3,5]
  const brk = /\[!([-\d,]+)\]\s*$/.exec(s);
  if (brk) {
    step.excludes = brk[1].split(',').map((x) => Number.parseInt(x, 10));
    s = s.slice(0, brk.index);
  }
  // 排除 !0:1:-1 或 !0
  const excl = /!(-?\d+(?::-?\d+)*)\s*$/.exec(s);
  if (excl) {
    step.excludes = excl[1].split(':').map((x) => Number.parseInt(x, 10));
    s = s.slice(0, excl.index);
  }
  // 切片 .a:b（数字:数字）
  const slice = /\.(-?\d+):(-?\d+)\s*$/.exec(s);
  if (slice) {
    step.slice = [Number.parseInt(slice[1], 10), Number.parseInt(slice[2], 10)];
    return s.slice(0, slice.index);
  }
  // 索引 .n（末尾纯数字段）——需与 .classname 简写区分：仅当 . 后是纯数字才是索引。
  const idx = /\.(-?\d+)\s*$/.exec(s);
  if (idx) {
    step.index = Number.parseInt(idx[1], 10);
    return s.slice(0, idx.index);
  }
  void rule;
  return s;
}

/** :contains(X) 里的文本转义（去掉可能破坏 css-select 的引号/括号）。 */
function cssEscapeContains(text: string): string {
  return text.replace(/[()]/g, '');
}

/**
 * 翻译一段（已剥正则尾缀、无顶层 ||）为 RuleIr。
 */
function translateSegment(segment: string, rule: string): RuleIr {
  const seg = segment.trim();

  // 1) JSONPath：段首 $ 或 {{$.x}} 模板
  if (seg.startsWith('$')) {
    return { kind: 'jsonpath', path: parseJsonPath(seg) };
  }

  // 2) {{...}} 模板（只允许 {{$.x}}）
  const tpl = tryParseTemplate(seg, rule);
  if (tpl) {
    // 纯字面（无 hole）退化为 text；否则 template
    if (tpl.every((p) => p.kind === 'literal')) {
      return { kind: 'text', literal: tpl.map((p) => (p.kind === 'literal' ? p.text : '')).join('') };
    }
    return { kind: 'template', parts: tpl };
  }

  // 3) XPath → 拒绝
  if (looksLikeXPath(seg)) unsupported('规则疑似 XPath', rule, { code: 'unsupported_xpath' });

  // 4) 显式 CSS：@css: / css:
  let cssBody = seg;
  let explicitCss = false;
  if (seg.startsWith('@css:')) {
    cssBody = seg.slice('@css:'.length);
    explicitCss = true;
  } else if (seg.startsWith('css:')) {
    cssBody = seg.slice('css:'.length);
    explicitCss = true;
  }

  if (explicitCss) {
    // 整段交 css-select；仍可能带末端 @op。
    return buildCssChain(cssBody, rule, true);
  }

  // 5) 纯绝对 URL（无 @ 段、无选择器特征）→ text
  if (/^https?:\/\//i.test(seg) && !seg.includes('@')) {
    return { kind: 'text', literal: seg };
  }

  // 6) 默认语法选择器链。原文记进侧表：JSON 输入上按 JSONPath 重解释（见 defaultSyntaxSource）。
  const ir = buildCssChain(seg, rule, false);
  DEFAULT_SYNTAX_SOURCE.set(ir, seg);
  return ir;
}

/**
 * 默认语法（无 `$`/`@css:`/模板前缀）规则的原文侧表。legado 按**输入内容**定模式
 * （AnalyzeRule.SourceRule：内容是 JSON 时无前缀规则走 Mode.Json，交 Jayway——路径不以
 * `$`/`@` 开头即补 `$.`，故 `bookName`→`$.bookName`、`.bookList[*]`→`$..bookList[*]`），
 * 编译期不知道页面是 HTML 还是 JSON，所以原文要留到求值期。
 * 用侧表而不是 IR 字段：IR 结构（快照/toEqual 断言、compile 缓存）保持不变；IR 在引擎内
 * 只按引用传递、不克隆不序列化。显式 `@css:`/`css:` 规则不登记——legado 对它们强制 CSS 模式。
 */
const DEFAULT_SYNTAX_SOURCE = new WeakMap<RuleIr, string>();

/** 默认语法规则的原文（已剥 ## 尾缀、已 trim）；显式 CSS 或非 css IR 返回 undefined。 */
export function defaultSyntaxSource(ir: RuleIr): string | undefined {
  return DEFAULT_SYNTAX_SOURCE.get(ir);
}

/**
 * 构建 CSS 选择器链。默认语法按 @ 切分为多段 + 末端 op；@css: 整段为一个 selector + 末端 op。
 */
function buildCssChain(body: string, rule: string, explicit: boolean): RuleIr {
  // 末端 @op 与段间 @ 都用 @ 表达。策略：按顶层 @ 切分，最后一段若是纯末端关键字/属性则为 terminal。
  const atParts = splitTopLevel(body, '@');
  if (atParts.length > MAX_CSS_CHAIN_DEPTH + 1) unsupported('选择器链过深', rule, { code: 'selector_chain_too_deep' });

  let terminal: TerminalOp | undefined;
  const last = atParts[atParts.length - 1].trim();
  // 末端判定：最后一段是已知末端关键字或形如具名属性（无空格、无 css 组合符）且不是唯一段。
  if (atParts.length > 1 && isTerminalToken(last)) {
    terminal = toTerminal(last, rule);
    atParts.pop();
  } else if (atParts.length === 1 && TERMINAL_KEYWORDS.has(last)) {
    // 单段且属已知末端关键字（`text`/`href`/`html`…，如 chapterUrl=href、chapterName=text##上次阅读）：
    // 也是 terminal（对当前 scope 套 op），不能当 CSS 标签名去找 <text>。注意只用 TERMINAL_KEYWORDS 判定，
    // 不得用 isTerminalToken 兜底——否则裸标签名 div/a/p、具名属性 data-id 会被误判成 op/attr。
    terminal = toTerminal(last, rule);
    atParts.pop();
  } else if (atParts.length > 1 && last === '') {
    // 末尾空 @（节点集原样，bookList/chapterList 用）
    atParts.pop();
  }

  const chain: CssStep[] = [];
  for (const part of atParts) {
    const p = part.trim();
    if (p === '') continue;
    if (explicit) {
      // @css: 段不做关键字翻译，但仍支持末端索引/切片/排除后缀
      const step: CssStep = { selector: '' };
      const rest = extractSuffixes(p, step, rule);
      step.selector = rest.trim();
      chain.push(step);
    } else {
      chain.push(translateStep(p, rule));
    }
  }
  // 裸 @op（如 chapterName=`@text`、chapterUrl=`@href`，book15 自身即此形态）：
  // 对当前 scope 节点集直接套末端操作，chain 合法为空。仅「既无选择器又无 terminal」才是空规则。
  if (chain.length === 0 && !terminal) unsupported('空选择器', rule, { code: 'empty_selector' });
  return { kind: 'css', chain, terminal };
}

function isTerminalToken(token: string): boolean {
  if (TERMINAL_KEYWORDS.has(token)) return true;
  if (LEGADO_SPECIAL_VARS.has(token)) return true; // 交给 toTerminal 显式拒绝，不当选择器步
  // 具名属性形态：含 - 或 :（如 data-id、og:title）。裸标签名（li/a/p/div）是选择器步，不是末端。
  return /^[\w]+[-:][\w:-]*$/.test(token);
}

// ---- 顶层入口 ----
/**
 * 编译一条字段规则文本为 FieldIr。
 *
 * 两态（task-syntax-p1a / 设计 §7 P1a 行）：
 * - **off（默认，ENGINE_SYNTAX_OR 关）**：与旧 parser **逐字一致**——顶层 || 切出 >1 段
 *   → RULE_UNSUPPORTED（{ code:'unsupported_operator', operator:'||' }），且沿用旧
 *   splitTopLevel（对整串、含正则尾缀切分）与旧「先切 || 后剥 ##」顺序。冻结不动。
 * - **on**：先剥**字段级** ## 净化尾缀（legado splitSourceRule 顺序：## 净化作用于组合
 *   之后的最终值，尾缀属于整字段而非某一支——设计 §3.2「最后套 ## 净化」），再用 P1a
 *   tokenizer（tokenizeOrBranches，{}/转义感知）切顶层 ||，>1 支产出 OrNode
 *   （{ kind:'or', branches }）。逐支独立走 translateSegment——后支的非法构件
 *   （@get/JS/模板变量…）不会被前支掩盖（§5.1「编译时检查所有分支」）；节点支与
 *   标量支保持各自形态，不互相压扁（求值见 evaluate.ts 'or' 分支）。
 *   && 顶层两态均拒（P1b）；%%/模板/JS/@get/@put 拒绝逻辑两态共用（rejectUnsupportedConstructs）。
 */
export interface ParseOptions {
  /** 顶层 || 组合是否可编译（ENGINE_SYNTAX_OR）。默认读 env（缺失=off）。 */
  orEnabled?: boolean;
}

export function parseFieldRule(rule: string, options: ParseOptions = {}): FieldIr {
  if (typeof rule !== 'string') unsupported('规则非字符串', String(rule), { code: 'invalid_rule_type' });
  const trimmed = rule.trim();
  if (trimmed === '') unsupported('空规则', rule, { code: 'empty_rule' });
  if (trimmed.length > MAX_RULE_LENGTH) unsupported('规则过长', rule, { code: 'rule_too_long' });

  rejectUnsupportedConstructs(trimmed);

  // 顶层 && → 拒（P1b 前两态一致）
  if (splitTopLevel(trimmed, '&&').length > 1) unsupported('规则含顶层 &&（T7）', rule, { code: 'unsupported_operator', operator: '&&' });

  const orEnabled = options.orEnabled ?? engineSyntaxOrEnabled();
  if (!orEnabled) {
    // off：冻结的 M1 路径（旧 splitTopLevel、旧顺序，逐字保留）。
    const orParts = splitTopLevel(trimmed, '||');
    if (orParts.length > 1) unsupported('规则含顶层 ||（T7）', rule, { code: 'unsupported_operator', operator: '||' });
    return singleSegmentField(orParts[0], rule);
  }

  // on：先剥字段级 ## 尾缀，再切顶层 ||。尾缀挂在 FieldIr.regex（组合选定后净化）。
  const { body, regex } = stripRegexSuffix(trimmed, rule);
  if (body.trim() === '' && regex.length > 0) unsupported('正则-only 规则（无选择器主体，非 M1 集）', rule, { code: 'regex_only' });
  const branches = tokenizeOrBranches(body);
  if (branches.length > 1) {
    if (branches.length > MAX_OR_BRANCHES) {
      unsupported(`|| 分支数超上限（${branches.length} > ${MAX_OR_BRANCHES}）`, rule, { code: 'or_branches_too_many' });
    }
    const field: FieldIr = { rules: [{ kind: 'or', branches: branches.map((branch) => parseOrBranch(branch, rule)) }] };
    if (regex.length > 0) field.regex = regex;
    return field;
  }
  return singleSegmentField(body, rule, { body, regex });
}

/** 单段（无顶层 ||）字段编译。off 路径的这段与旧实现逐行等价。 */
function singleSegmentField(
  segment: string,
  rule: string,
  precomputed?: { body: string; regex: RegexSub[] },
): FieldIr {
  const { body, regex } = precomputed ?? stripRegexSuffix(segment, rule);
  // 正则-only 规则（剥掉 ##...## 尾缀后主体为空，如 `##<a.*?href="([^"]+)"##$1###`）：
  // ##regex## 在 §2.3 里只定义为「选择器后缀」，无选择器主体的独立正则不在 M1 集内 → 显式拒绝
  // （不猜「对原始输入直接跑正则」的语义，§2.3 第5条不猜测）。
  if (body.trim() === '' && regex.length > 0) unsupported('正则-only 规则（无选择器主体，非 M1 集）', rule, { code: 'regex_only' });
  const field: FieldIr = { rules: [translateSegment(body, rule)] };
  if (regex.length > 0) field.regex = regex;
  return field;
}

/**
 * 编译一个 || 支（P1a）。支内不再有顶层 ||（tokenizer 已把括号/引号/花括号内的 || 留在
 * 支内，形如 `(b||c)` 的「嵌套组合」不是合法本方言构件——按不支持的 CSS 选择器在
 * 求值期失败，编译期不猜其语义）。空支显式拒（`a||` 不猜「跳过空支」）。
 */
function parseOrBranch(branch: string, rule: string): RuleIr {
  if (branch.trim() === '') unsupported('|| 分支为空', rule, { code: 'empty_or_branch' });
  return translateSegment(branch, rule);
}

/** 便捷单规则解析（返回首个 RuleIr，测试用）。 */
export function parseRule(rule: string): RuleIr {
  return parseFieldRule(rule).rules[0];
}

export type { JsonPathIr };
