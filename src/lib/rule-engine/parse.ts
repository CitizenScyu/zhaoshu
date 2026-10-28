// 规则文本 → IR。方言识别（默认语法/@css:/css:/JSONPath $. /纯文本/{{$.x}} 模板）、
// 构件白名单、##正则##尾缀剥离、深度/长度上限、不支持构件编译期拒绝（RULE_UNSUPPORTED）。
// 设计依据：m1-engine-design.md v3 §2.3。这就是滤网 1 的实现本体。

import {
  ChainStage,
  CssStep,
  FieldIr,
  JS_JAVA_HELPERS,
  JS_JAVA_UTIL_HELPERS,
  JsonPathIr,
  JsTemplatePart,
  MAX_CSS_CHAIN_DEPTH,
  MAX_JS_RULE_LENGTH,
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
import { AIO_LIST_FIELDS, isAioListField, isAioListRule, parseAioField } from './aio-syntax';
import {
  engineSyntaxAioEnabled, engineSyntaxAndEnabled, engineSyntaxJsBindEnabled, engineSyntaxJsEnabled, engineSyntaxJsExtEnabled,
  engineSyntaxJsGetEnabled, engineSyntaxJsonPathEnabled, engineSyntaxJsUtilEnabled, engineSyntaxListJsEnabled, engineSyntaxOrEnabled,
  engineSyntaxRegexEnabled, engineSyntaxXPathEnabled, engineSyntaxXPathEvalEnabled, engineInitJsActive, engineSyntaxJsoupEnabled,
  engineSyntaxBookFieldsEnabled,
} from './syntax-flags';
import { compileXPath, XPathSyntaxError } from './xpath-eval';
import { looksLikeXPath, xpathPrefixed, xpathSegmentBody, xpathToCss } from './xpath-subset';
import { VAR_BAG_RESERVED_KEYS } from './vars-subset';

function unsupported(msg: string, rule: string, diagnostic: RuleDiagnostic): never {
  throw new RuleEngineError('RULE_UNSUPPORTED', msg, rule, diagnostic);
}

/**
 * 当前 parseFieldRule 帧的 JSONPath 扩展子集开关（jsonpath1028）：编译全程同步，parseFieldRule 进出时保存/恢复，
 * translateSegment / tryParseTemplate 据此调 parseJsonPath(…, ext)。
 */
let jsonPathExt = false;

/**
 * 当前 parseFieldRule 帧的变量袋模式（varbag1028，ParseOptions.varBag）：同样进出时保存/恢复，嵌套的规则段、`{{规则}}`、
 * getter 实参不继承（它们里面的 put/get 照旧拒）。
 */
let varBag: VarBagParse | undefined;

/**
 * 当前 parseFieldRule 帧的 jsoup 直连重试（jsoup1028，ParseOptions.jsoupEnabled）：off 态口径编译被拒的字段才在这一帧里重编，
 * 帧内放行 `java.getElement(s)("规则")`（实参编进 elements）、`org.jsoup.Jsoup.parse`、条目级 `result`/`src`、列表链首段规则。
 * 嵌套解析不继承。`options` = 实参规则的编译开关（不含 JS）。
 */
let jsoupFrame: { elements: Map<string, FieldIr>; options: ParseOptions } | undefined;

/**
 * 当前 parseFieldRule 帧的书籍成员重试（book1028，ParseOptions.bookFieldsEnabled）：off 态口径编译被拒的字段才在这一帧里重编，
 * 帧内 `book` 另放行 `members`（字段所在阶段 legado 已求出的成员，见 bookStageMembers），读到的成员记进 `used`。嵌套解析不继承。
 */
let bookFrame: { members: ReadonlySet<string>; used: Set<string> } | undefined;

/** 变量袋编译模式：`put` = JS 里放行字面量键的 `java.put`；`get` = 放行 `java.get('键')` 与规则级 makeUp 的 `@get:{键}`。键记进 keys。 */
export interface VarBagParse {
  mode: 'put' | 'get';
  keys: Set<string>;
}

// ---- 不支持构件（编译期一律拒绝，见 §0/§2.3 与任务 reject-list）----
// xpath / tpl_rule({{@@}}) / tpl_var({{变量}}，baseUrl 除外) / put(@put:) / get(@get:) /
// tpl_js_expr / @js:/<js> / ||(顶层) / &&(顶层) / %%(拼接) / match:
const JS_EXPR_RE = /[=+*/%!<>?;]|java\.|Date\.|baseUrl\.|typeof|new\s|\breturn\b|\.match\(|\.replace\(/;

/**
 * 唯一放行的模板变量（窄口子，见 tocfix 任务书）。
 *
 * legado 语义对照：legado 的 `BaseAnalysis`/`AnalyzeUrl` 在展开规则时把内置变量
 * `baseUrl` 替换为**当前页面的 URL 字符串**（不是对象、不是表达式）。故 `{{baseUrl}}`
 * 等价于「本格取当前页 URL」，引擎侧实现为 TemplatePart{kind:'var',name:'baseUrl'}，
 * 求值期取 scope.pageUrl（见 evaluate.ts renderTemplate）。
 *
 * 边界（有意收窄）：
 * - **只放行 trim 后恰为 `baseUrl` 的这一种**；`result`/`book`/`chapter`/`headerMap`
 *   及其它任何 `{{变量}}` 照旧 tpl_var 拒绝（JS_EXPR_RE 之下的兜底分支不动）。
 * - `{{baseUrl.replace(...)}}` 内含 `.replace(`，命中 JS_EXPR_RE → 仍按 tpl_js_expr 拒；
 *   本口子不开 JS 口。JS 侧求值（如 baseUrl.replace）留给 T7。
 * - 与 `@baseUrl` 具名属性兜底（LEGADO_SPECIAL_VARS，见下）无关：那是末端 op，本改动不动它。
 */
const ALLOWED_TEMPLATE_VARS = new Set(['baseUrl']);

/**
 * 顶层构件白名单校验（在剥正则尾缀之前，对整条规则做粗筛）。
 * 命中任何不支持构件 → RULE_UNSUPPORTED。
 */
function rejectUnsupportedConstructs(rule: string): void {
  if (ruleHasJs(rule)) unsupported('规则含 JS（@js:/<js>）', rule, { code: 'unsupported_js' });
  if (rule.includes('@put:')) unsupported('规则含 @put 变量存取', rule, { code: 'unsupported_var_put' });
  if (rule.includes('@get:')) unsupported('规则含 @get 变量存取', rule, { code: 'unsupported_var_get' });
  if (rule.trimStart().startsWith('match:')) unsupported('规则含 match: 正则', rule, { code: 'unsupported_regex_match' });
  if (rule.includes('%%')) unsupported('规则含 %% 拼接（T7）', rule, { code: 'unsupported_operator', operator: '%%' });
  rejectUnsupportedTemplates(rule);
}

/**
 * 全串扫描 {{...}} 模板并拒绝不支持类别（对齐 §2.3 step 2 与 survey.py refined_feats：
 * 二者都对整条规则做扫描——含正则尾缀里的 {{变量}}，如 `##...{{chapter.title}}`）。
 * `{{$...}}`（tpl_jsonpath）与 `{{baseUrl}}`（窄口子，见 ALLOWED_TEMPLATE_VARS）放行；
 * `{{@@}}`（tpl_rule）/JS 表达式（tpl_js_expr）/其余 {{变量}}（tpl_var）一律 RULE_UNSUPPORTED。
 */
function rejectUnsupportedTemplates(rule: string): void {
  const re = /\{\{(.*?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule)) !== null) {
    const inner = m[1].trim();
    if (inner.startsWith('$')) continue; // tpl_jsonpath（M1 支持）
    if (ALLOWED_TEMPLATE_VARS.has(inner)) continue; // {{baseUrl}}：当前页 URL（窄口子）
    if (inner.startsWith('@@')) unsupported('模板含 {{@@规则}}（tpl_rule）', rule, { code: 'unsupported_template_rule' });
    if (JS_EXPR_RE.test(inner)) unsupported('模板含 JS 表达式（tpl_js_expr）', rule, { code: 'unsupported_template_js' });
    unsupported('模板含 {{变量}}（tpl_var）', rule, { code: 'unsupported_template_var' });
  }
}

/**
 * 解析 {{...}} 模板：允许 {{$.x}}（tpl_jsonpath）与 {{baseUrl}}（窄口子 → var part）。
 * {{@@...}}=tpl_rule、其余 {{变量}}=tpl_var、含 JS 表达式=tpl_js_expr → 一律 RULE_UNSUPPORTED。
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
      parts.push({ kind: 'jsonpath', path: parseJsonPath(inner, jsonPathExt) });
    } else if (ALLOWED_TEMPLATE_VARS.has(inner)) {
      parts.push({ kind: 'var', name: 'baseUrl' });
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
  return tokenizeTopLevel(rule, '||');
}

/** 按顶层二字符操作符（`||` / `&&`）切分，口径同 tokenizeOrBranches（and1027 复用）。 */
export function tokenizeTopLevel(rule: string, op: '||' | '&&'): string[] {
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
    if (stack.length === 0 && rule.startsWith(op, i)) {
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
export function stripRegexSuffix(segment: string, rule: string, regexEnabled = false): { body: string; regex: RegexSub[] } {
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
  // regex1027：legado SourceRule.makeUpRule 只有「≥4 段即 replaceFirst」，没有 flags 概念（`##p##r##i` 也是 replaceFirst）。
  // 只对主体为空的正则-only 段生效（整页/条目原文上的全局替换没有意义）；`选择器##p##r###` 照旧全局替换——
  // 已在池的源按旧语义实测通过，改它们的取值须另开开关并实测（or-sim regex-sim：on 态波及 516 个在池源）。
  if (regexEnabled && chunks.length >= 3 && body.trim() === '') regex.push({ pattern, replacement, first: true });
  else regex.push({ pattern, replacement, flags: finalFlags });
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
function translateSegment(segment: string, rule: string, xpathEnabled = false, xpathEval = false): RuleIr {
  const seg = segment.trim();

  // 1) JSONPath：段首 $ 或 {{$.x}} 模板
  if (seg.startsWith('$')) {
    return { kind: 'jsonpath', path: parseJsonPath(seg, jsonPathExt) };
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

  // 3) XPath：ENGINE_SYNTAX_XPATH on 时简单子集翻成 CSS（xpath1027，见 xpath-subset.ts）；
  //    子集外与开关 off 一律拒绝。翻出的 IR 不登记默认语法侧表——XPath 对 JSON 输入无意义。
  //    xpatheval1027（ENGINE_SYNTAX_XPATH_EVAL）：子集外且属 legado XPath 模式（`@XPath:` 前缀或 `/` 开头）的段
  //    改交 xpath-eval.ts 求值；只是「疑似 XPath」而不以 `/` 开头的段 legado 不按 XPath 处理，照旧拒。
  if (xpathEnabled) {
    const expr = xpathSegmentBody(seg);
    if (expr !== null) {
      const css = xpathToCss(expr);
      if (!css) {
        const forced = xpathPrefixed(seg);
        if (xpathEval && (forced || seg.startsWith('/'))) return xpathEvalIr(expr, seg, forced, rule);
        unsupported('XPath 超出可翻译子集', rule, { code: 'unsupported_xpath' });
      }
      const terminal = css.terminal === undefined ? undefined : toTerminal(css.terminal, rule);
      return { kind: 'css', chain: css.selector ? [{ selector: css.selector }] : [], terminal };
    }
  }
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
 * JsoupXpath 求值 IR（xpatheval1027）。解析不了的段拒 unsupported_xpath；例外是 `/` 开头、含 `{$.` 内嵌规则的段
 * （如 `/book/{$.id}.html`）——legado 在 JSON 输入上按 Json 模式替换内嵌规则，留 program=null 只在 JSON 上求值。
 */
function xpathEvalIr(expr: string, seg: string, forced: boolean, rule: string): RuleIr {
  try {
    return { kind: 'xpath', program: compileXPath(expr), source: seg, forced };
  } catch (error) {
    if (!(error instanceof XPathSyntaxError)) throw error;
    if (!forced && seg.includes('{$.')) return { kind: 'xpath', program: null, source: seg, forced };
    return unsupported(`XPath 无法求值：${error.message}`, rule, { code: 'unsupported_xpath' });
  }
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
  /** 简单子集 XPath 是否翻成 CSS（ENGINE_SYNTAX_XPATH，xpath1027）。默认读 env（缺失=off）。 */
  xpathEnabled?: boolean;
  /** 子集外 XPath 是否交 JsoupXpath 语义求值（ENGINE_SYNTAX_XPATH_EVAL，xpatheval1027；须 xpathEnabled）。默认读 env。 */
  xpathEvalEnabled?: boolean;
  /** 含 JS 段的字段可否编译成链（ENGINE_SYNTAX_JS，jsbox1027）。默认读 env（缺失=off）；还须给出 field。 */
  jsEnabled?: boolean;
  /** 字段全名（如 `ruleContent.content`）。JS 链只对白名单字段开放，未给出时含 JS 照旧拒。 */
  field?: string;
  /** legado `##` 正则语义（ENGINE_SYNTAX_REGEX，regex1027：replaceFirst + 正则-only 规则）。默认读 env（缺失=off）。 */
  regexEnabled?: boolean;
  /** legado `&&` 合并（ENGINE_SYNTAX_AND，and1027；须 orEnabled，且只对 AND_FIELDS 生效）。默认读 env（缺失=off）。 */
  andEnabled?: boolean;
  /** legado AllInOne 正则列表（ENGINE_SYNTAX_AIO，aio1027）。默认读 env（缺失=off）；还须给出 field。 */
  aioEnabled?: boolean;
  /**
   * 字段所在规则组的列表规则以 `:` 开头（aio1027，调用方按 aio-syntax.ts aioGroups 判定）：同组条目字段按 legado Regex 模式
   * 解释（`$N` 捕获组引用）。列表字段自身由规则原文判定，不看这一项。
   */
  aioGroup?: boolean;
  /** 列表字段（bookList/chapterList）的 JS 段（ENGINE_SYNTAX_LIST_JS，listjs1027；须 jsEnabled）。默认读 env（缺失=off）。 */
  listJsEnabled?: boolean;
  /**
   * 字段所在规则组的列表规则含 JS（listjs1027，调用方按 listJsGroups 判定）：同组条目字段另挂 objectKey，供 JS 返回的
   * 对象条目按 legado 键值直取。只在 jsEnabled 与 listJsEnabled 同开时生效。
   */
  listJsGroup?: boolean;
  /**
   * JS 段扩展（ENGINE_SYNTAX_JS_EXT，jsext1028；须 jsEnabled）：JS 段放行 `eval`；字符串字段的 JS 段内 `{{}}`/`##` 按 legado
   * SourceRule.makeUpRule 改写（列表字段 getElements 不 makeUp，仍拒）。默认读 env（缺失=off）。
   */
  jsExtEnabled?: boolean;
  /**
   * 宿主绑定与规则级 makeUp（ENGINE_SYNTAX_JS_BIND，bind1028；须 jsEnabled）：JS 里放行 `book.origin`/`chapter.title`/`title`
   * （按字段，见 fieldBinds）；核心字符串字段的非 JS 规则里旧路径拒收的 `{{}}` 按 legado SourceRule 拼值（parseMakeUpField）。
   * 默认读 env（缺失=off）。
   */
  jsBindEnabled?: boolean;
  /**
   * `java.getString`/`java.getStringList`（ENGINE_SYNTAX_JS_GET，jsget1028；须 jsEnabled）：字符串字段 JS 链里字面量实参的调用
   * 编译进 FieldIr.jsGets 白名单（collectJavaGets）。默认读 env（缺失=off）。
   */
  jsGetEnabled?: boolean;
  /**
   * 对称加解密 / toNumChapter 帮手（ENGINE_SYNTAX_JS_UTIL，jsutil1028；须 jsEnabled）：字符串字段 JS 链里放行 JS_JAVA_UTIL_HELPERS，
   * 用到的字段标 FieldIr.jsUtil（列表 JS 与 makeUp 不收）。默认读 env（缺失=off）。
   */
  jsUtilEnabled?: boolean;
  /**
   * JSONPath 扩展子集（ENGINE_SYNTAX_JSON_PATH，jsonpath1028）：off 态解析不了的 `$` 路径再试 `.[` 与 `[?(表达式)]`
   * （jsonpath.ts parseJsonPath ext）。默认读 env（缺失=off）。
   */
  jsonPathEnabled?: boolean;
  /**
   * 详情页 JS init（ENGINE_SYNTAX_INIT_JS，initjs1028；须 jsEnabled）：`ruleBookInfo.init` 的 JS 链放行，且 getter 白名单另认
   * `X = (x) => java.getString(x)` 别名（collectJavaGets）。默认读 env（ENGINE_SYNTAX_INIT 与 ENGINE_SYNTAX_INIT_JS 同开才算）。
   */
  initJsEnabled?: boolean;
  /**
   * 变量袋（varbag1028，compile.ts 只给 vars-subset.ts varBagPlan 判出的字段传）：见 VarBagParse。只作用于本帧，嵌套解析不继承。
   */
  varBag?: VarBagParse;
  /**
   * jsoup DOM 直连（ENGINE_SYNTAX_JSOUP，jsoup1028；须 jsEnabled）：字符串/列表字段按 off 态口径编译被拒时，再按 jsoup 口径重编
   * （见 jsoupFrame），通过的字段标 FieldIr.jsoup。off 态编译得过的字段逐字不变。默认读 env（缺失=off）。
   */
  jsoupEnabled?: boolean;
  /**
   * JS 读 `book` 的书籍成员（ENGINE_SYNTAX_BOOK_FIELDS，book1028；须 jsEnabled 与 jsBindEnabled）：字段按 off 态口径（及 jsoup
   * 重试）编译被拒时，再在 bookFrame 里重编，通过的字段标 FieldIr.bookMembers。`ruleBookInfo.canReName` 非空的源由 compile.ts
   * 传 false。默认读 env（缺失=off）。
   */
  bookFieldsEnabled?: boolean;
}

export function parseFieldRule(rule: string, options: ParseOptions = {}): FieldIr {
  const saved = jsonPathExt;
  const savedBag = varBag;
  const savedFrame = jsoupFrame;
  const savedBook = bookFrame;
  jsonPathExt = options.jsonPathEnabled ?? engineSyntaxJsonPathEnabled();
  varBag = options.varBag;
  jsoupFrame = undefined;
  bookFrame = undefined;
  const bagKeys = varBag === undefined ? undefined : [...varBag.keys];
  try {
    return parseFieldRuleWithObjectKey(rule, options);
  } catch (error) {
    if (!(error instanceof RuleEngineError) || error.code !== 'RULE_UNSUPPORTED') throw error;
    // 重试顺序：jsoup 单开（jsoup1028 原口径，逐字不变）→ book 单开 → 两者同开（book1028）。
    const jsoup = jsoupRetryAllowed(rule, options);
    const members = bookRetryMembers(rule, options);
    const attempts: { jsoup: boolean; book: boolean }[] = [];
    if (jsoup) attempts.push({ jsoup: true, book: false });
    if (members) attempts.push({ jsoup: false, book: true });
    if (members && jsoup) attempts.push({ jsoup: true, book: true });
    const restoreBag = () => {
      if (varBag === undefined || bagKeys === undefined) return;
      varBag.keys.clear();
      for (const key of bagKeys) varBag.keys.add(key);
    };
    for (const attempt of attempts) {
      restoreBag();
      const frame = attempt.jsoup ? { elements: new Map<string, FieldIr>(), options: jsSegmentOptions(options) } : undefined;
      const book = attempt.book && members ? { members, used: new Set<string>() } : undefined;
      jsoupFrame = frame;
      bookFrame = book;
      let field: FieldIr;
      try {
        field = parseFieldRuleWithObjectKey(rule, options);
      } catch {
        continue;
      }
      // 帧内只读到 book.origin（chapterName/列表 JS 因帧换绑才过）不算 book1028 增量，照旧拒。
      if (book && book.used.size === 0) continue;
      if (frame) {
        field.jsoup = true;
        if (frame.elements.size > 0) field.jsElements = frame.elements;
      }
      if (book) field.bookMembers = [...book.used].sort();
      return field;
    }
    restoreBag();
    throw error; // 重编也不过：报 off 态口径的原错误（诊断维度不变）
  } finally {
    jsonPathExt = saved;
    varBag = savedBag;
    jsoupFrame = savedFrame;
    bookFrame = savedBook;
  }
}

/** jsoup1028 重试的前提：开关同开、字段已知（详情 init 不收）、规则含 JS。 */
function jsoupRetryAllowed(rule: string, options: ParseOptions): boolean {
  return typeof rule === 'string' && options.field !== undefined && options.field !== 'ruleBookInfo.init'
    && (options.jsEnabled ?? engineSyntaxJsEnabled()) && (options.jsoupEnabled ?? engineSyntaxJsoupEnabled())
    && ruleHasJs(rule.trim());
}

/**
 * book1028 重试可放行的 `book` 成员（含 origin）：开关同开、字段在 bookStageMembers 里、规则文本含 `book.`。不重试时 undefined。
 */
function bookRetryMembers(rule: string, options: ParseOptions): ReadonlySet<string> | undefined {
  if (typeof rule !== 'string' || options.field === undefined || !bindActive(options)
    || !(options.bookFieldsEnabled ?? engineSyntaxBookFieldsEnabled()) || !/(?<![\w$.])book\s*\./.test(rule)) return undefined;
  return bookStageMembers(options.field);
}

/** JS 链里规则段 / getter 实参的编译开关（不含 JS）。 */
function jsSegmentOptions(options: ParseOptions): ParseOptions {
  return {
    orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: false,
    regexEnabled: options.regexEnabled ?? engineSyntaxRegexEnabled(), jsonPathEnabled: options.jsonPathEnabled,
  };
}

function parseFieldRuleWithObjectKey(rule: string, options: ParseOptions): FieldIr {
  const field = parseFieldRuleText(rule, options);
  // listjs1027：对象条目的键值直取只看规则原文（legado getString 遇 NativeObject 不走解析器），与上面的编译结果并存。
  if (options.listJsGroup === true && options.field !== undefined && !isAioListField(options.field)
    && (options.jsEnabled ?? engineSyntaxJsEnabled()) && (options.listJsEnabled ?? engineSyntaxListJsEnabled())) {
    field.objectKey = objectKeyOf(rule);
  }
  return field;
}

function parseFieldRuleText(rule: string, options: ParseOptions): FieldIr {
  if (typeof rule !== 'string') unsupported('规则非字符串', String(rule), { code: 'invalid_rule_type' });
  const trimmed = rule.trim();
  if (trimmed === '') unsupported('空规则', rule, { code: 'empty_rule' });
  // aio1027：AllInOne 组整组换一套解释（Regex 模式下 CSS/JSONPath/JS 都不适用），排在一切方言判定之前。off 态逐字不变。
  if (options.field !== undefined && (options.aioGroup === true || (isAioListField(options.field) && isAioListRule(rule)))
    && (options.aioEnabled ?? engineSyntaxAioEnabled())) return parseAioField(rule, options.field);
  if (ruleHasJs(trimmed) && (options.jsEnabled ?? engineSyntaxJsEnabled())) {
    if (options.field !== undefined && isAioListField(options.field) && (options.listJsEnabled ?? engineSyntaxListJsEnabled())) {
      return parseListJsChain(rule, options);
    }
    return parseJsChain(trimmed, rule, options);
  }
  if (trimmed.length > MAX_RULE_LENGTH) unsupported('规则过长', rule, { code: 'rule_too_long' });

  // bind1028：旧路径拒收的 `{{}}` 才改走 legado makeUp，旧路径收得下的模板（`{{$.x}}`/`{{baseUrl}}`）两态同路。
  // varbag1028：目录字段在变量袋 get 模式下，含 `@get:{}` 的规则同走 makeUp（legado evalPattern 把 @get 与 {{}} 一起切）。
  if (options.field !== undefined && SELF_FIELDS.has(options.field)
    && ((trimmed.includes('{{') && bindActive(options) && templatesRejected(trimmed)) || (varBag?.mode === 'get' && /@get:\{/i.test(trimmed)))) {
    return parseMakeUpField(trimmed, rule, options);
  }

  rejectUnsupportedConstructs(trimmed);

  const orEnabled = options.orEnabled ?? engineSyntaxOrEnabled();
  // and1027：off 判据（整串、含 ## 尾缀）命中才可能走 && 合并，未命中的规则两态逐字同路——开关只救被拒的规则。
  const offAnd = splitTopLevel(trimmed, '&&').length > 1;
  const andEnabled = offAnd && orEnabled && options.field !== undefined && AND_FIELDS.has(options.field)
    && (options.andEnabled ?? engineSyntaxAndEnabled());
  // 顶层 && → 拒（P1b 前两态一致）
  if (offAnd && !andEnabled) unsupported('规则含顶层 &&（T7）', rule, { code: 'unsupported_operator', operator: '&&' });

  const xpathEnabled = options.xpathEnabled ?? engineSyntaxXPathEnabled();
  const xpathEval = xpathEnabled && (options.xpathEvalEnabled ?? engineSyntaxXPathEvalEnabled());
  const regexEnabled = options.regexEnabled ?? engineSyntaxRegexEnabled();
  if (!orEnabled) {
    // off：冻结的 M1 路径（旧 splitTopLevel、旧顺序，逐字保留）。
    const orParts = splitTopLevel(trimmed, '||');
    if (orParts.length > 1) unsupported('规则含顶层 ||（T7）', rule, { code: 'unsupported_operator', operator: '||' });
    return singleSegmentField(orParts[0], rule, xpathEnabled, xpathEval, undefined, regexEnabled, options.field);
  }

  // on：先剥字段级 ## 尾缀，再切顶层 ||。尾缀挂在 FieldIr.regex（组合选定后净化）。
  const { body, regex } = stripRegexSuffix(trimmed, rule, regexEnabled);
  if (body.trim() === '' && regex.length > 0) return regexOnlyField(regex, rule, regexEnabled, options.field);
  const branches = tokenizeOrBranches(body);
  if (andEnabled) {
    const parts = tokenizeTopLevel(body, '&&');
    if (parts.length > 1) {
      // legado RuleAnalyzer.splitRule 只认首个出现的操作符，另一种留在支内当选择器文本——混用即坏规则，不猜。
      if (branches.length > 1) unsupported('规则混用顶层 || 与 &&', rule, { code: 'unsupported_operator', operator: '&&' });
      return andField(parts, regex, rule, xpathEnabled, xpathEval, options.field!);
    }
  }
  if (branches.length > 1) {
    if (branches.length > MAX_OR_BRANCHES) {
      unsupported(`|| 分支数超上限（${branches.length} > ${MAX_OR_BRANCHES}）`, rule, { code: 'or_branches_too_many' });
    }
    const field: FieldIr = { rules: [{ kind: 'or', branches: branches.map((branch) => parseOrBranch(branch, rule, xpathEnabled, xpathEval)) }] };
    if (regex.length > 0) field.regex = regex;
    return field;
  }
  return singleSegmentField(body, rule, xpathEnabled, xpathEval, { body, regex }, regexEnabled, options.field);
}

/** 单段（无顶层 ||）字段编译。off 路径的这段与旧实现逐行等价。 */
function singleSegmentField(
  segment: string,
  rule: string,
  xpathEnabled: boolean,
  xpathEval: boolean,
  precomputed?: { body: string; regex: RegexSub[] },
  regexEnabled = false,
  fieldName?: string,
): FieldIr {
  const { body, regex } = precomputed ?? stripRegexSuffix(segment, rule, regexEnabled);
  // 正则-only 规则（剥掉 ##...## 尾缀后主体为空，如 `##<a.*?href="([^"]+)"##$1###`）：
  // ##regex## 在 §2.3 里只定义为「选择器后缀」，无选择器主体的独立正则不在 M1 集内 → 显式拒绝
  // （不猜「对原始输入直接跑正则」的语义，§2.3 第5条不猜测）。regex1027 开关 on 时按 legado 语义收下，见 regexOnlyField。
  if (body.trim() === '' && regex.length > 0) return regexOnlyField(regex, rule, regexEnabled, fieldName);
  const field: FieldIr = { rules: [translateSegment(body, rule, xpathEnabled, xpathEval)] };
  if (regex.length > 0) field.regex = regex;
  return field;
}

/**
 * 正则-only 规则开放的字段：核心字段（evaluate.ts CORE_FIELDS）去掉三个列表字段。列表字段在 legado getElements 里
 * 没有替换语义（主体为空 = 空列表）；装饰字段照旧 skipped——放开它们只会让大批已在池源的 identity 翻动
 * （or-sim regex-sim：428 个在池源只因装饰字段换 rules_hash）而不多收一个源。未给出字段名的调用一律拒。
 */
const SELF_FIELDS: ReadonlySet<string> = new Set([
  'ruleSearch.name', 'ruleSearch.author', 'ruleSearch.bookUrl',
  'ruleBookInfo.name', 'ruleBookInfo.author', 'ruleBookInfo.tocUrl',
  'ruleToc.chapterName', 'ruleToc.chapterUrl', 'ruleToc.nextTocUrl',
  'ruleContent.content', 'ruleContent.nextContentUrl',
]);

/**
 * 正则-only 规则（regex1027）。legado AnalyzeRule.getString：主体为空、有替换正则时不调解析器，result 保持
 * content，直接 `replaceRegex(content.toString())`——整页 = 页面原文、条目 = 元素 outerHtml，结果非正文时解 HTML 实体。
 * 开关 off 与 SELF_FIELDS 之外的字段照旧 regex_only。
 */
function regexOnlyField(regex: RegexSub[], rule: string, regexEnabled: boolean, fieldName: string | undefined): FieldIr {
  if (!regexEnabled || fieldName === undefined || !SELF_FIELDS.has(fieldName)) {
    unsupported('正则-only 规则（无选择器主体，非 M1 集）', rule, { code: 'regex_only' });
  }
  return { rules: [{ kind: 'self' }], regex };
}

/**
 * && 合并开放的字段（and1027）：核心字段去掉两个「下一页」URL——legado 对它们走 getStringList 收全部支的 URL
 * （多页翻页），引擎 next 字段单值口径装不下，不猜。装饰字段不开：不多收一个源，只会让在池源 identity 翻动。
 */
const AND_FIELDS: ReadonlySet<string> = new Set([
  'ruleSearch.bookList', 'ruleSearch.name', 'ruleSearch.author', 'ruleSearch.bookUrl',
  'ruleBookInfo.name', 'ruleBookInfo.author', 'ruleBookInfo.tocUrl',
  'ruleToc.chapterList', 'ruleToc.chapterName', 'ruleToc.chapterUrl',
  'ruleContent.content',
]);
/** URL 字段：legado getString(isUrl=true) 在 Default 模式走 getString0，取首个非空支。 */
const AND_URL_FIELDS: ReadonlySet<string> = new Set(['ruleSearch.bookUrl', 'ruleBookInfo.tocUrl', 'ruleToc.chapterUrl']);
const AND_LIST_FIELDS: ReadonlySet<string> = new Set(['ruleSearch.bookList', 'ruleToc.chapterList']);

/**
 * `&&` 合并字段（and1027）。legado SourceRule 先剥 `##` 尾缀，RuleAnalyzer.splitRule 再切主体；规则模式由**整条**规则的
 * 前缀定（`$.`/`$[` → Json，否则 Default），各支共用。这里只收两种能逐支对齐的形态：
 * - 全部支都是默认语法选择器（JSON 输入上各支照旧按 Jayway 重解释，与 legado isJSON → Json 模式一致）；
 * - 首支是 JSONPath（整条走 Json 模式），其后各支 JSONPath 或默认语法（Json 模式里补 `$.`，同上）。
 * 显式 `@css:`（legado 整条切成 CSS 模式，后支不再按默认语法）、XPath、字面量、模板支一律拒，不猜。
 * 列表字段的支不能带末端操作（legado getElements 把 `@text` 当选择器步，取不到节点）。
 */
function andField(
  parts: string[], regex: RegexSub[], rule: string, xpathEnabled: boolean, xpathEval: boolean, fieldName: string,
): FieldIr {
  if (parts.length > MAX_OR_BRANCHES) {
    unsupported(`&& 分支数超上限（${parts.length} > ${MAX_OR_BRANCHES}）`, rule, { code: 'or_branches_too_many' });
  }
  const reject = (why: string): never => unsupported(`&& 组合${why}`, rule, { code: 'unsupported_operator', operator: '&&' });
  const list = AND_LIST_FIELDS.has(fieldName);
  // legado 列表规则以 `:` 开头是 AllInOne 正则模式（splitSourceRule allInOne），`&&` 是正则级联而非节点合并。
  if (list && parts[0].trim().startsWith(':')) reject('列表字段是 AllInOne 正则（`:` 开头）');
  const jsonMode = parts[0].trim().startsWith('$');
  const branches = parts.map((part): RuleIr => {
    if (part.trim() === '') unsupported('&& 分支为空', rule, { code: 'empty_and_branch' });
    const ir = translateSegment(part, rule, xpathEnabled, xpathEval);
    if (ir.kind === 'jsonpath') {
      if (!jsonMode) reject('首支是默认语法、后支是 JSONPath');
      return ir;
    }
    if (ir.kind !== 'css' || defaultSyntaxSource(ir) === undefined) return reject('含显式 CSS/XPath/字面量/模板支');
    if (list && ir.terminal !== undefined) reject('列表字段的支带末端操作');
    return ir;
  });
  const and: Extract<RuleIr, { kind: 'and' }> = { kind: 'and', branches };
  if (AND_URL_FIELDS.has(fieldName)) and.first = true;
  const field: FieldIr = { rules: [and] };
  if (regex.length > 0) field.regex = regex;
  return field;
}

/**
 * 编译一个 || 支（P1a）。支内不再有顶层 ||（tokenizer 已把括号/引号/花括号内的 || 留在
 * 支内，形如 `(b||c)` 的「嵌套组合」不是合法本方言构件——按不支持的 CSS 选择器在
 * 求值期失败，编译期不猜其语义）。空支显式拒（`a||` 不猜「跳过空支」）。
 */
function parseOrBranch(branch: string, rule: string, xpathEnabled: boolean, xpathEval: boolean): RuleIr {
  if (branch.trim() === '') unsupported('|| 分支为空', rule, { code: 'empty_or_branch' });
  return translateSegment(branch, rule, xpathEnabled, xpathEval);
}

// ---- JS 链（jsbox1027，ENGINE_SYNTAX_JS）----
/** 与 rejectUnsupportedConstructs 同一判据：开关 off 时含 JS 照旧 unsupported_js。 */
export function ruleHasJs(rule: string): boolean {
  return rule.includes('@js:') || /<js\b|<js>/.test(rule);
}

/** legado AnalyzeRule.JS_PATTERN（大小写不敏感）：`<js>…</js>` 取最短，`@js:` 吞到串尾。 */
const JS_SEGMENT_RE = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;

/** 页面级字段：首段输入是整页原文，JS 里可用 `src`（legado evalJS 的 src = content）。 */
const JS_PAGE_FIELDS: ReadonlySet<string> = new Set([
  'ruleBookInfo.name', 'ruleBookInfo.author', 'ruleBookInfo.tocUrl',
  'ruleToc.nextTocUrl', 'ruleContent.content', 'ruleContent.nextContentUrl',
]);
/**
 * 条目级字段：legado 里首段输入是 jsoup Element / JSON Map，JS 要靠 Java 互操作才读得动——只放行
 * 「先规则取出字符串、后 JS 加工」的形态，首段是 JS/纯正则一律拒；`src` 同理不可用。
 * 列表字段（bookList/chapterList）的 JS 要返回节点/对象集合，不开放。
 */
const JS_ITEM_FIELDS: ReadonlySet<string> = new Set([
  'ruleSearch.name', 'ruleSearch.author', 'ruleSearch.bookUrl', 'ruleToc.chapterName', 'ruleToc.chapterUrl',
]);

/** 该字段是否允许 JS 链（parseJsChain 的白名单；准入初筛与语义版本判定共用）。 */
export function jsChainFieldAllowed(field: string): boolean {
  return JS_PAGE_FIELDS.has(field) || JS_ITEM_FIELDS.has(field);
}

// ---- 详情页 init（init1028，ENGINE_SYNTAX_INIT）----
/**
 * `ruleBookInfo.init` 原文能否按 legado BookInfo `setContent(getElement(init))` 复现（编译前的文本判据）。拒：
 * `@put`/`@get`（变量袋与 vars-subset 的 init 口径另算）；`##`（getElement 的替换作用在 Elements/Map 的 toString 上）；
 * `:` 开头（getElement 以 allInOne 切规则，按 Regex 模式取捕获组列表）；JS（返回对象供键值直取，另做）；
 * `/` 或 `@XPath:` 开头的支（getElement 的 XPath 结果是 JXNode 列表，toString 后被当成 JSON）。
 */
export function initRuleTextSupported(rule: unknown): boolean {
  if (typeof rule !== 'string' || rule.trim() === '') return false;
  const trimmed = rule.trim();
  if (/@put:|@get:/i.test(trimmed) || trimmed.includes('##') || trimmed.startsWith(':') || ruleHasJs(trimmed)) return false;
  return !/(^|\|\|)\s*(\/|@xpath:)/i.test(trimmed);
}

/**
 * init 编译结果能否复现（IR 判据，配合 initRuleTextSupported）：单条 css / jsonpath，或支全是 css / jsonpath 的 `||`。
 * 模板、字面量、`&&`、正则尾缀、makeUp、JS 链一律不收。HTML/JSON 两侧再按页面在求值期细分（evaluate.ts evaluateInitScope）。
 */
export function initFieldSupported(field: FieldIr): boolean {
  if (field.chain || field.makeUp || field.regex || field.joins || field.concats || field.rules.length !== 1) return false;
  const ir = field.rules[0];
  const simple = (rule: RuleIr) => rule.kind === 'css' || rule.kind === 'jsonpath';
  return simple(ir) || (ir.kind === 'or' && ir.branches.every(simple));
}

/**
 * JS init（initjs1028）的编译结果能否复现：整条规则恰好一段 JS（前后无规则段、无 `##` 替换），求值见 evaluate.ts jsInitScope。
 * 原文另须含 JS（ruleHasJs），调用方判。
 */
export function initJsFieldSupported(field: FieldIr): boolean {
  if (field.rules.length !== 0 || field.regex || field.makeUp || field.chain?.length !== 1) return false;
  const stage = field.chain[0];
  return stage.kind === 'js' && stage.regex === undefined && stage.detached !== true;
}

/** 准入初筛用（compile-smoke rulesNoJs）：init 原文按 env 开关编译后是可复现的 JS init。 */
export function initJsRuleSupported(rule: unknown): boolean {
  if (typeof rule !== 'string' || !ruleHasJs(rule.trim())) return false;
  try {
    return initJsFieldSupported(parseFieldRule(rule, { field: 'ruleBookInfo.init', jsEnabled: true, initJsEnabled: true }));
  } catch {
    return false;
  }
}

/**
 * 依赖 legado 宿主状态或动态代码的标识符：沙箱里没有对应对象，编译期先拒，免得准入放进实跑必失败的源。
 * 只认「前面不是 `.`」的裸标识符（`x.book` 是属性访问，不算）；字符串/注释里的不算。
 */
const JS_BANNED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'book', 'source', 'cookie', 'cache', 'chapter', 'title', 'nextChapterUrl', 'rssArticle', 'Packages', 'org',
  'eval', 'Function', 'importScript', 'XMLHttpRequest', 'fetch', 'webView', 'startBrowser',
]);

/**
 * 含 JS 段的字段 → legado 链式 FieldIr（AnalyzeRule.splitSourceRule 的切法：JS 段原样、非 JS 段 trim 后为空即丢）。
 * 非 JS 段各自按普通规则编译（含 ## 尾缀/||，开关同外层）；剥掉 ## 后主体为空的段成为只做替换的 regex 段。
 * 求值见 evaluate.ts evaluateChain。
 */
function parseJsChain(trimmed: string, rule: string, options: ParseOptions): FieldIr {
  const field = options.field;
  const itemLevel = field !== undefined && JS_ITEM_FIELDS.has(field);
  // initjs1028：详情页 init 是页面级（result/src = 详情页原文）。
  const initJs = field === 'ruleBookInfo.init' && (options.initJsEnabled ?? engineInitJsActive());
  if (field === undefined || !(jsChainFieldAllowed(field) || initJs)) {
    unsupported('规则含 JS（@js:/<js>）', rule, { code: 'unsupported_js' });
  }
  if (trimmed.length > MAX_JS_RULE_LENGTH) unsupported('规则过长', rule, { code: 'rule_too_long' });
  const regexEnabled = options.regexEnabled ?? engineSyntaxRegexEnabled();
  const jsExt = options.jsExtEnabled ?? engineSyntaxJsExtEnabled();
  const binds = (options.jsBindEnabled ?? engineSyntaxJsBindEnabled()) ? fieldBinds(field) : undefined;
  const segmentOptions: ParseOptions = {
    orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: false,
    regexEnabled, jsonPathEnabled: options.jsonPathEnabled,
  };
  const gets: JsGets | undefined = (options.jsGetEnabled ?? engineSyntaxJsGetEnabled())
    ? { options: segmentOptions, out: new Map(), aliases: initJs } : undefined;
  const util: JsUtil | undefined = (options.jsUtilEnabled ?? engineSyntaxJsUtilEnabled()) ? { used: false } : undefined;
  const chain: ChainStage[] = [];
  const pushRule = (text: string) => {
    const segment = text.trim();
    if (segment === '') return;
    if (segment.startsWith('##')) {
      if (itemLevel && chain.length === 0) unsupported('条目级字段首段不能是纯正则', rule, { code: 'unsupported_js' });
      chain.push({ kind: 'regex', regex: stripRegexSuffix(segment, rule, regexEnabled).regex });
      return;
    }
    chain.push({ kind: 'rule', field: parseFieldRule(segment, segmentOptions) });
  };
  let last = 0;
  for (const match of trimmed.matchAll(JS_SEGMENT_RE)) {
    pushRule(trimmed.slice(last, match.index));
    const code = match[1] ?? match[2] ?? '';
    // jsoup1028：帧内条目级首段 JS 的 result/src 是条目 Element（evaluate.ts evaluateJsoupChain），读输入也收。
    const first = itemLevel && chain.length === 0;
    const detached = first && jsExt && !jsReadsInput(code);
    if (first && !detached && jsoupFrame === undefined) unsupported('条目级字段首段不能是 JS', rule, { code: 'unsupported_js' });
    if (jsExt) {
      const stage = parseJsExtStage(code, rule, itemLevel, segmentOptions, binds, gets, util);
      if (first) {
        if (stage.kind !== 'js') unsupported('条目级字段首段不能是纯正则', rule, { code: 'unsupported_js' });
        if (detached) stage.detached = true;
      }
      if (jsoupFrame !== undefined && stage.kind === 'js' && stage.template) {
        unsupported('jsoup 直连的 JS 段含 {{}}', rule, { code: 'unsupported_js' });
      }
      chain.push(stage);
    } else {
      checkJsCode(code, rule, itemLevel, false, binds, gets, util);
      chain.push({ kind: 'js', code });
    }
    last = match.index + match[0].length;
  }
  pushRule(trimmed.slice(last));
  const out: FieldIr = { rules: [], chain };
  if (gets && gets.out.size > 0) out.jsGets = gets.out;
  if (util?.used) out.jsUtil = true;
  return out;
}

// ---- 列表 JS（listjs1027，ENGINE_SYNTAX_LIST_JS）----
/** 列表规则含 JS 的规则组（嵌套形态 `{ ruleSearch: { bookList } }`）；AllInOne 列表（`:` 开头）不算。 */
export function listJsGroups(source: Record<string, unknown>): Set<string> {
  const groups = new Set<string>();
  for (const [group, list] of Object.entries(AIO_LIST_FIELDS)) {
    const fields = source[group];
    if (fields && typeof fields === 'object' && !Array.isArray(fields)
      && isListJsRule((fields as Record<string, unknown>)[list])) groups.add(group);
  }
  return groups;
}

/** 扁平形态（`'ruleSearch.bookList' → 规则`）同 listJsGroups。 */
export function listJsGroupsFlat(rules: Record<string, unknown>): Set<string> {
  const groups = new Set<string>();
  for (const [group, list] of Object.entries(AIO_LIST_FIELDS)) {
    if (isListJsRule(rules[`${group}.${list}`])) groups.add(group);
  }
  return groups;
}

function isListJsRule(rule: unknown): boolean {
  return typeof rule === 'string' && ruleHasJs(rule) && !isAioListRule(rule);
}

/**
 * 列表字段的 JS 链（legado AnalyzeRule.getElements）。先按 BookList/BookChapterList 对原文剥一个 `-`（整表反转）再剥一个
 * `+`，之后按 splitSourceRule 切段。只收两种形态：
 * - 一到多段 JS：末段返回数组，逐项成为条目（js-sandbox runJsItems）；
 * - 一到多段 JS + 一段规则：JS 产出字符串，规则段把它重新解析成列表（规则段的模式见 ChainStage.mode）。
 * 首段是规则（节点/JSON 对象要 Java 互操作才读得动）、JS 段之间夹规则段、纯正则段一律拒；jsoup1028 帧内另收首段取节点的规则。
 */
function parseListJsChain(rule: string, options: ParseOptions): FieldIr {
  const reject = (why: string): never => unsupported(`列表 JS ${why}`, rule, { code: 'unsupported_js' });
  let text = rule;
  const reverse = text.startsWith('-');
  if (reverse) text = text.slice(1);
  if (text.startsWith('+')) text = text.slice(1);
  text = text.trim();
  if (text.length > MAX_JS_RULE_LENGTH) unsupported('规则过长', rule, { code: 'rule_too_long' });
  const chain: ChainStage[] = [];
  let last = 0;
  for (const match of text.matchAll(JS_SEGMENT_RE)) {
    const between = text.slice(last, match.index).trim();
    if (between !== '') {
      // jsoup1028：帧内首段可以是取节点的规则（legado getElements 得 Elements，作为 result 交给后面的 JS）。
      if (chain.length > 0 || jsoupFrame === undefined) reject(chain.length === 0 ? '首段不是 JS' : 'JS 段之间夹规则段');
      const head = listRuleStage(between, rule, options, reject);
      if (head.kind !== 'rule' || head.mode === 'json' || !nodeFieldIr(head.field)) reject('首段规则不是取节点的规则');
      chain.push(head);
    }
    const code = match[1] ?? match[2] ?? '';
    // book1028：帧内列表 JS 也可读 book（legado 目录 getElements 的 ruleData 即 Book）。
    checkJsCode(code, rule, false, options.jsExtEnabled ?? engineSyntaxJsExtEnabled(), bookFrame ? fieldBinds(options.field) : undefined);
    chain.push({ kind: 'js', code });
    last = match.index + match[0].length;
  }
  if (!chain.some((stage) => stage.kind === 'js')) reject('没有 JS 段');
  const tail = text.slice(last).trim();
  if (tail !== '') chain.push(listRuleStage(tail, rule, options, reject));
  const field: FieldIr = { rules: [], chain };
  if (reverse) field.reverse = true;
  return field;
}

/**
 * 列表 JS 链的末段规则。getElements 不调 makeUpRule：`##`/`{{}}`/`@get` 原样留在选择器里，`$N` 把整段切成 Regex 模式——
 * 都不猜，拒。前缀按 SourceRule 构造的顺序判模式；`@CSS:` 规范成解析器认的小写，`@@`/`@Json:` 剥掉。
 */
function listRuleStage(tail: string, rule: string, options: ParseOptions, reject: (why: string) => never): ChainStage {
  if (tail.includes('##') || tail.includes('{{') || /@(?:get|put):/i.test(tail) || /\$\d/.test(tail) || tail.startsWith(':')) {
    reject('末段规则含 ##/{{}}/@get/@put/$N/`:`');
  }
  let body = tail;
  let mode: 'json' | 'html' | 'default' = 'default';
  if (/^@css:/i.test(body)) {
    mode = 'html';
    body = `@css:${body.slice(5)}`;
  } else if (body.startsWith('@@')) {
    mode = 'html';
    body = body.slice(2);
  } else if (/^@xpath:/i.test(body) || body.startsWith('/')) {
    mode = 'html';
  } else if (/^@json:/i.test(body)) {
    mode = 'json';
    body = body.slice(6);
  } else if (body.startsWith('$.') || body.startsWith('$[')) {
    mode = 'json';
  }
  if (body.trim() === '') reject('末段规则为空');
  const field = parseFieldRule(body, {
    orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: false,
    regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: false, field: options.field,
    jsonPathEnabled: options.jsonPathEnabled,
  });
  return { kind: 'rule', field, mode };
}

/** legado JS_PATTERN 的首个 JS 段（非全局，objectKeyOf 用）。 */
const FIRST_JS_SEGMENT_RE = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/i;

/**
 * 对象条目上的键值直取（legado AnalyzeRule.getString 的 NativeObject 分支）：只用首个 SourceRule——JS 段之前的规则文本。
 * SourceRule 构造剥 `@@`/`@XPath:`/`@Json:`（`@CSS:` 与 `$.` 留在文本里，于是成了取不到的键），makeUpRule 再按 Kotlin
 * split("##") 切出键（trim）与替换（≥4 段即 replaceFirst）。首段即 JS 时首个 SourceRule 是 Js 模式、规则文本就是 JS 代码，
 * legado 照样拿它当键（不执行）。@put/@get/{{}}/`$N`（模板拼值）不复现。
 */
export function objectKeyOf(rule: string): NonNullable<FieldIr['objectKey']> {
  const js = FIRST_JS_SEGMENT_RE.exec(rule);
  let head = (js ? rule.slice(0, js.index) : rule).trim();
  if (head === '' && js) head = js[1] ?? js[2] ?? '';
  else if (head.startsWith('@@')) head = head.slice(2);
  else if (/^@xpath:/i.test(head)) head = head.slice(7);
  else if (/^@json:/i.test(head)) head = head.slice(6);
  const parts = head.split('##');
  if (/@(?:put|get):/i.test(head) || head.includes('{{') || /\$\d/.test(parts[0])) return { unsupported: '模板/变量/$N' };
  const key = parts[0].trim();
  if (parts.length < 2 || parts[1] === '') return { key };
  const pattern = parts[1];
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return { unsupported: '正则 pattern 过长' };
  try {
    new RegExp(pattern, 'g');
  } catch {
    return { unsupported: '正则 pattern 无法编译' };
  }
  const regex: RegexSub = { pattern, replacement: parts[2] ?? '' };
  if (parts.length > 3) regex.first = true;
  return { key, regex };
}

// ---- JS 段扩展（jsext1028，ENGINE_SYNTAX_JS_EXT）----
/** legado SourceRule.evalPattern 的 `{{}}` 部分（`@get:{}` 另拒）：取最短。 */
const JS_TEMPLATE_RE = /\{\{([\w\W]*?)\}\}/g;

/** 编译期骨架里的占位（不会出现在规则文本里）；查标识符时换成数字字面量。 */
const TEMPLATE_HOLE = '\u0000';

/** legado AnalyzeRule.isRule：`{{}}` 内以这些开头的按规则取值，其余按 JS 求值。 */
function isMakeUpRule(text: string): boolean {
  return text.startsWith('@') || text.startsWith('$.') || text.startsWith('$[') || text.startsWith('//');
}

/**
 * JS 段的 legado makeUpRule（jsext1028）：SourceRule 构造把 JS 段原文按 evalPattern 切出 `{{}}` 占位，getString 前
 * makeUpRule 把占位求值拼回，再 `split("##")`——首段 trim 为代码、第 2 段正则、第 3 段替换、≥4 段 replaceFirst
 * （正则为空不替换）。只改写 off 态被拒的段：不含 `##`/`{{` 的段与旧路径同一产物（另放行 eval）。
 * `{{规则}}` 按普通规则编译（不嵌 JS），`{{JS}}` 与拼回后的代码骨架过同一套白名单。
 */
function parseJsExtStage(
  code: string, rule: string, itemLevel: boolean, segmentOptions: ParseOptions, binds?: JsBinds, gets?: JsGets, util?: JsUtil,
): ChainStage {
  if (/@(?:get|put):/i.test(code)) unsupported('JS 段含 @get/@put', rule, { code: 'unsupported_js' });
  if (!code.includes('##') && !code.includes('{{')) {
    checkJsCode(code, rule, itemLevel, true, binds, gets, util);
    return { kind: 'js', code };
  }
  if (!code.includes('{{')) {
    const parts = code.split('##');
    const body = parts[0].trim();
    const regex = makeUpRegex(parts, rule);
    // legado getString：makeUp 后代码为空、有替换时跳过 evalJS，只对上一段结果做替换。
    if (body === '' && regex) return { kind: 'regex', regex: [regex] };
    checkJsCode(body, rule, itemLevel, true, binds, gets, util);
    const stage: ChainStage = { kind: 'js', code: body };
    if (regex) stage.regex = regex;
    return stage;
  }
  const template: JsTemplatePart[] = [];
  let skeleton = '';
  let last = 0;
  for (const match of code.matchAll(JS_TEMPLATE_RE)) {
    const text = code.slice(last, match.index);
    if (text !== '') template.push({ kind: 'text', text });
    skeleton += text + TEMPLATE_HOLE;
    const inner = match[1];
    if (isMakeUpRule(inner)) {
      template.push({ kind: 'rule', field: parseFieldRule(inner, segmentOptions) });
    } else {
      checkJsCode(inner, rule, itemLevel, true, binds, gets, util);
      template.push({ kind: 'js', code: inner });
    }
    last = match.index + match[0].length;
  }
  const tail = code.slice(last);
  if (tail !== '') template.push({ kind: 'text', text: tail });
  skeleton += tail;
  const parts = skeleton.split('##');
  const body = parts[0].trim();
  // 代码段为空（占位都在 ## 之后）且有替换段：求值期只做替换（evaluate.ts），不过白名单。
  // jsget1028：getter 先在带占位的骨架上收（实参含占位的留给白名单拒），再把占位换成数字过白名单。
  if (body !== '' || parts.length < 2) {
    const checked = gets ? collectJavaGets(body, rule, gets) : body;
    checkJsCode(checked.replaceAll(TEMPLATE_HOLE, '0'), rule, itemLevel, true, binds, undefined, util);
  }
  // 正则段里没有占位时编译期即可校验（有占位的留到求值期）。
  if (parts.length > 1 && !parts[1].includes(TEMPLATE_HOLE)) makeUpRegex(parts, rule);
  return { kind: 'js', code, template };
}

/** JS 段（含 `{{}}` 占位原文）可能读到上一段结果或作用域原文：引用 result/src 或能间接取到它们的标识符；字面量剥不干净也算。 */
const JS_INPUT_IDENTIFIERS: ReadonlySet<string> = new Set(['result', 'src', 'eval', 'this', 'globalThis', 'arguments', 'Function']);

function jsReadsInput(code: string): boolean {
  // `{{JS}}` 占位以上一段结果为 result 求值，即使写在字符串字面量里也算；`{{规则}}` 在字段作用域取值，不算。
  for (const match of code.matchAll(JS_TEMPLATE_RE)) if (!isMakeUpRule(match[1]) && jsReadsInput(match[1])) return true;
  const bare = stripJsLiterals(code.replace(JS_TEMPLATE_RE, '0'));
  if (bare === null) return true;
  for (const match of bare.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) if (JS_INPUT_IDENTIFIERS.has(match[0])) return true;
  return false;
}

/** makeUpRule 切出的正则替换（parts = `split("##")` 结果）；正则段为空 → 不替换。 */
function makeUpRegex(parts: readonly string[], rule: string): RegexSub | undefined {
  if (parts.length < 2 || parts[1] === '') return undefined;
  const pattern = parts[1];
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) unsupported('正则 pattern 过长', rule, { code: 'regex_pattern_too_long' });
  try {
    new RegExp(pattern, 'g');
  } catch {
    unsupported(`正则 pattern 无法编译：${pattern}`, rule, { code: 'regex_invalid' });
  }
  const regex: RegexSub = { pattern, replacement: parts[2] ?? '' };
  if (parts.length > 3) regex.first = true;
  return regex;
}

/**
 * JS 段的编译期白名单（沙箱内的二道防线见 js-sandbox.ts）。`allowEval`（jsext1028）：放行 `eval`（代码同样在沙箱里跑）。
 * `binds`（bind1028）：该字段可读的宿主绑定，命中的标识符只许读白名单成员、不许赋值/自增。
 * `util`（jsutil1028）：另放行 JS_JAVA_UTIL_HELPERS，用到即记 `used`（调用方据此给字段标 jsUtil）。
 */
function checkJsCode(
  code: string, rule: string, itemLevel: boolean, allowEval = false, binds?: JsBinds, gets?: JsGets, util?: JsUtil,
): void {
  const reject = (why: string): never => unsupported(`JS 段${why}`, rule, { code: 'unsupported_js' });
  if (code.trim() === '') reject('为空');
  // legado 在求值前对 JS 文本做 {{}}/@get/## 改写（SourceRule 构造与 makeUpRule），这里不模拟那几步。
  if (code.includes('##') || code.includes('{{') || /@(?:get|put):/i.test(code)) reject('含 ##/{{}}/@get/@put');
  const frame = jsoupFrame;
  const collected = gets ? collectJavaGets(code, rule, gets) : code;
  const bare = stripJsLiterals(collectVarCalls(frame ? collectJsoupCalls(collected, rule, frame) : collected)) ?? reject('字符串/注释未闭合');
  for (const match of bare.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    const members = binds?.get(name);
    if (members) {
      checkBoundRef(bare, match.index, name, members, reject);
      continue;
    }
    if ((JS_BANNED_IDENTIFIERS.has(name) && !(allowEval && name === 'eval')) || (itemLevel && name === 'src' && frame === undefined)) {
      reject(`引用了沙箱不提供的 ${name}`);
    }
    if (name !== 'java') continue;
    const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(bare.slice(match.index + name.length));
    if (member && util && JS_JAVA_UTIL_HELPERS.has(member[1])) {
      util.used = true;
      continue;
    }
    if (!member || !JS_JAVA_HELPERS.has(member[1])) reject(`用了沙箱不提供的 java.${member?.[1] ?? '[…]'}`);
  }
}

// ---- 对称加解密 / toNumChapter 帮手（jsutil1028，ENGINE_SYNTAX_JS_UTIL）----
/** 一条 JS 链编译期的帮手使用记录：任一段用到即 `used`。 */
interface JsUtil {
  used: boolean;
}

// ---- java.getString/getStringList（jsget1028，ENGINE_SYNTAX_JS_GET）----
/**
 * 编译期收集的实参白名单：`options` = 规则段的编译开关（不含 JS），`out` = 规则文本 → 编译结果。
 * `aliases`（initjs1028，只给 JS init）：另认 getString 箭头函数别名（collectJavaAliases）。
 */
interface JsGets {
  options: ParseOptions;
  out: Map<string, FieldIr>;
  aliases?: boolean;
}

/** `java.getString("…")`/`java.getStringList('…')`：恰好一个不跨行的字符串字面量实参（isUrl 等多参形态不收）。 */
const JAVA_GET_CALL_RE = /(?<![\w$.])java\s*\.\s*(?:getString|getStringList)\s*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\)/g;

/**
 * 把字面量实参的 getter 调用编译进白名单，并在待查代码里换成 `(0)`；其余调用（动态实参、起点落在字符串/注释/模板字面量
 * 里、实参含转义口径不定的序列或模板占位）原样留下，交白名单按「沙箱不提供的 java.getString」拒。
 * 实参规则编译不过 → 整段拒（unsupported_js）。
 */
function collectJavaGets(code: string, rule: string, gets: JsGets): string {
  return collectLiteralCalls(gets.aliases ? collectJavaAliases(code, rule, gets) : code, JAVA_GET_CALL_RE, rule, gets);
}

/** 探针：起点之前的代码接一个 `_`，剥完字面量后 `_` 还在末尾 = 起点在代码里（不在字符串/注释/正则/模板字面量里）。 */
function startsInCode(code: string, index: number): boolean {
  const probe = stripJsLiterals(`${code.slice(0, index)}_`);
  return probe !== null && probe.endsWith('_') && (probe.split('`').length - 1) % 2 === 0;
}

/** 把 `pattern` 命中的字面量实参调用（首个捕获组 = 字面量）编进白名单、在待查代码里换成 `(0)`。 */
function collectLiteralCalls(code: string, pattern: RegExp, rule: string, gets: JsGets, what = 'java.getString'): string {
  let out = '';
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    if (!startsInCode(code, match.index)) continue;
    const text = jsStringLiteralValue(match[1]);
    if (text === null || text.includes(TEMPLATE_HOLE)) continue;
    if (!gets.out.has(text)) {
      try {
        gets.out.set(text, parseFieldRule(text, gets.options));
      } catch {
        unsupported(`JS 段 ${what} 的实参规则编译不过`, rule, { code: 'unsupported_js' });
      }
    }
    out += `${code.slice(last, match.index)}(0)`;
    last = match.index + match[0].length;
  }
  return out + code.slice(last);
}

// ---- jsoup DOM 直连（jsoup1028，ENGINE_SYNTAX_JSOUP）----
/** `java.getElement("…")`/`java.getElements('…')`：恰好一个不跨行的字符串字面量实参。 */
const JAVA_GET_ELEMENTS_CALL_RE = /(?<![\w$.])java\s*\.\s*getElements?\s*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\)/g;
/** `org.jsoup.Jsoup.parse` / `Packages.org.jsoup.Jsoup.parse`（沙箱只提供这一个 jsoup 静态入口）。 */
const JSOUP_PARSE_RE = /(?<![\w$.])(?:Packages\s*\.\s*)?org\s*\.\s*jsoup\s*\.\s*Jsoup\s*\.\s*parse(?![\w$])/g;

/**
 * jsoup 帧内：字面量实参的 `java.getElement(s)` 编进 frame.elements（须是取节点的规则）、`Jsoup.parse` 入口换成 `(0)`，
 * 其余 `org`/`Packages`/动态实参照旧交白名单拒。
 */
function collectJsoupCalls(code: string, rule: string, frame: NonNullable<typeof jsoupFrame>): string {
  const before = new Set(frame.elements.keys());
  const out = collectLiteralCalls(code, JAVA_GET_ELEMENTS_CALL_RE, rule, { options: frame.options, out: frame.elements }, 'java.getElements');
  for (const [text, field] of frame.elements) {
    if (!before.has(text) && !nodeFieldIr(field)) unsupported('JS 段 java.getElements 的实参不是取节点的规则', rule, { code: 'unsupported_js' });
  }
  return out.replace(JSOUP_PARSE_RE, '(0)');
}

/** 取节点的规则（jsoup1028）：单条不带末端操作的 CSS（或各支都是这种 CSS 的 ||/&&），不带链/替换/拼接/变量。 */
function nodeFieldIr(field: FieldIr): boolean {
  if (field.chain || field.makeUp || (field.regex?.length ?? 0) > 0 || field.joins || field.concats !== undefined || field.varPuts
    || field.objectKey || field.rules.length !== 1) return false;
  const ir = field.rules[0];
  const plainCss = (node: RuleIr) => node.kind === 'css' && node.terminal === undefined;
  return plainCss(ir) || ((ir.kind === 'or' || ir.kind === 'and') && ir.branches.every(plainCss));
}

// ---- 变量袋 java.put / java.get（varbag1028，ENGINE_SYNTAX_VARS_BAG）----
const JAVA_PUT_CALL_RE = /(?<![\w$.])java\s*\.\s*put\s*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*,/g;
const JAVA_VAR_GET_CALL_RE = /(?<![\w$.])java\s*\.\s*get\s*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\)/g;

/**
 * 变量袋模式下（本帧 varBag）把字面量键的 `java.put('k', 值` 换成 `(0, 值`、`java.get('k')` 换成 `(0)` 再交白名单查，键记进
 * varBag.keys。动态键、起点在字面量/注释里、内置键、多实参的 get（legado 的网络请求重载）原样留下，按「沙箱不提供的 java.put/get」拒。
 * 不在变量袋模式时原样返回。
 */
function collectVarCalls(code: string): string {
  const bag = varBag;
  if (bag === undefined) return code;
  let out = '';
  let last = 0;
  for (const match of code.matchAll(bag.mode === 'put' ? JAVA_PUT_CALL_RE : JAVA_VAR_GET_CALL_RE)) {
    if (!startsInCode(code, match.index)) continue;
    const key = jsStringLiteralValue(match[1]);
    if (key === null || key === '' || key.includes(TEMPLATE_HOLE) || VAR_BAG_RESERVED_KEYS.has(key)) continue;
    bag.keys.add(key);
    out += `${code.slice(last, match.index)}${bag.mode === 'put' ? '(0,' : '(0)'}`;
    last = match.index + match[0].length;
  }
  return out + code.slice(last);
}

/**
 * getString 箭头函数别名（initjs1028）：`[var|let|const] NAME = (P) => java.getString(P[, result])`（或 `P =>`），形参即实参。
 * 别名的每次调用都必须是 `NAME("字面量")`——实参编进白名单、调用与别名体换成 `(0)`；换完后代码里的 NAME 只许剩定义处
 * 那一个（重定义、传递、动态实参、对象键同名一律不认，交白名单拒）。运行时回调照旧只认白名单实参，第二实参须是 init 的
 * result（evaluate.ts jsBindings）。
 */
const JAVA_ALIAS_DEF_RE = /(?<![\w$.])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*(java\s*\.\s*getString\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*result\s*)?\))/g;

/** 别名名不能遮住沙箱提供的全局或宿主绑定。 */
const JS_ALIAS_RESERVED: ReadonlySet<string> = new Set(['java', 'result', 'src', 'baseUrl', 'var', 'let', 'const', 'return', 'typeof']);

function collectJavaAliases(code: string, rule: string, gets: JsGets): string {
  const names: string[] = [];
  let out = '';
  let last = 0;
  for (const match of code.matchAll(JAVA_ALIAS_DEF_RE)) {
    const [, name, wrapped, bare, body, arg] = match;
    if ((wrapped ?? bare) !== arg || JS_ALIAS_RESERVED.has(name) || JS_BANNED_IDENTIFIERS.has(name) || names.includes(name)) continue;
    if (!startsInCode(code, match.index)) continue;
    names.push(name);
    const bodyAt = match.index + match[0].length - body.length;
    out += `${code.slice(last, bodyAt)}(0)`;
    last = match.index + match[0].length;
  }
  let rewritten = out + code.slice(last);
  for (const name of names) {
    const escaped = name.replace(/\$/g, '\\$');
    const call = new RegExp(`(?<![\\w$.])${escaped}\\s*\\(\\s*("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')\\s*\\)`, 'g');
    rewritten = collectLiteralCalls(rewritten, call, rule, gets);
    const bare = stripJsLiterals(rewritten);
    if (bare === null) return code;
    const uses = [...bare.matchAll(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, 'g'))].length;
    if (uses !== 1) unsupported(`JS 段 getString 别名 ${name} 有非字面量用法`, rule, { code: 'unsupported_js' });
  }
  return rewritten;
}

const JS_SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };

/** 字符串字面量（含引号）的值：只认常见转义与 `\uXXXX`；`\x`、`\u{}`、八进制/`\0`、续行 → null（不猜）。 */
function jsStringLiteralValue(literal: string): string | null {
  const body = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    const next = body[i];
    if (next in JS_SIMPLE_ESCAPES) out += JS_SIMPLE_ESCAPES[next];
    else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 1, i + 5))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (/[0-9xu\r\n\u2028\u2029]/.test(next)) return null;
    else out += next;
  }
  return out;
}

// ---- 宿主只读绑定（bind1028，ENGINE_SYNTAX_JS_BIND）----
/** 标识符 → 可读成员；`''` = 裸标识符本身就是值（legado bindings 的 `title`）。 */
type JsBinds = ReadonlyMap<string, ReadonlySet<string>>;

/** 全部 JS 字段：legado evalJS 的 `book` = ruleData（搜索条目 SearchBook / 书籍 Book），`origin` = 书源地址。 */
const BIND_ORIGIN: JsBinds = new Map([['book', new Set(['origin'])]]);
/** 另有当前章节的字段：目录 chapterUrl（legado 先求 chapterName 赋给 bookChapter.title）与正文两字段。 */
const BIND_CHAPTER: JsBinds = new Map([
  ['book', new Set(['origin'])], ['chapter', new Set(['title'])], ['title', new Set([''])],
]);
const CHAPTER_BIND_FIELDS: ReadonlySet<string> = new Set(['ruleToc.chapterUrl', 'ruleContent.content', 'ruleContent.nextContentUrl']);

/**
 * 字段可读的宿主绑定。chapterName 求值时章节名还没出来，目录列表/搜索列表也不开（列表 JS 与 makeUp 都不经这里）。
 * book1028 帧内（bookFrame）`book` 换成帧的成员集，chapterName 与目录列表另得 `book`。
 */
function fieldBinds(field: string | undefined): JsBinds | undefined {
  if (field === undefined) return undefined;
  const frame = bookFrame;
  if (frame !== undefined) {
    const base = CHAPTER_BIND_FIELDS.has(field) ? BIND_CHAPTER : BIND_ORIGIN;
    return new Map([...base, ['book', frame.members]]);
  }
  if (field === 'ruleToc.chapterName' || isAioListField(field)) return undefined;
  return CHAPTER_BIND_FIELDS.has(field) ? BIND_CHAPTER : BIND_ORIGIN;
}

/**
 * book1028：字段求值时 legado `book` 上已有确定值的成员（含 origin）。搜索条目按 getSearchItem 顺序（name → author → kind →
 * wordCount → lastChapter → intro → coverUrl → bookUrl）只给本条已求出的 name/author；详情给 name/author（搜索条目带来，
 * canReName 源已排除）与 bookUrl；目录（含列表）另给 tocUrl。kind 等可空成员、正文、发现页不收。
 */
function bookStageMembers(field: string): ReadonlySet<string> | undefined {
  if (field === 'ruleSearch.author') return BOOK_SEARCH_AUTHOR;
  if (BOOK_SEARCH_LATE_FIELDS.has(field)) return BOOK_SEARCH_LATE;
  if (field.startsWith('ruleBookInfo.')) return BOOK_INFO;
  if (field.startsWith('ruleToc.')) return BOOK_TOC;
  return undefined;
}
const BOOK_SEARCH_AUTHOR: ReadonlySet<string> = new Set(['origin', 'name']);
const BOOK_SEARCH_LATE: ReadonlySet<string> = new Set(['origin', 'name', 'author']);
const BOOK_SEARCH_LATE_FIELDS: ReadonlySet<string> = new Set([
  'ruleSearch.kind', 'ruleSearch.wordCount', 'ruleSearch.lastChapter', 'ruleSearch.intro', 'ruleSearch.coverUrl', 'ruleSearch.bookUrl',
]);
const BOOK_INFO: ReadonlySet<string> = new Set(['origin', 'name', 'author', 'bookUrl']);
const BOOK_TOC: ReadonlySet<string> = new Set(['origin', 'name', 'author', 'bookUrl', 'tocUrl']);

/** 宿主绑定的一处引用：`book.origin` 这类成员读，或裸 `title`（字符串值，其成员如 `.length` 照常可读）；赋值、自增自减、对象的其余成员一律拒。 */
function checkBoundRef(
  bare: string, index: number, name: string, members: ReadonlySet<string>, reject: (why: string) => never,
): void {
  let rest = bare.slice(index + name.length);
  const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
  if (member && members.has(member[1])) rest = rest.slice(member[0].length);
  else if (!members.has('')) reject(`用了沙箱不提供的 ${name}${member ? `.${member[1]}` : ''}`);
  // book1028：书籍成员在 Rhino 里是 Java String 包装（typeof 'object'、`.length` 是方法、replace 不认正则），只收与 JS 字符串同结果的用法。
  if (name === 'book' && member && member[1] !== 'origin' && bookFrame !== undefined) {
    if (/^\s*(?:[.[(]|\?\.|[!=]==|instanceof\b)/.test(rest) || /(?:\btypeof|\bdelete|[!=]==)\s*$/.test(bare.slice(0, index))) {
      reject(`把 book.${member[1]} 当 JS 字符串用（Rhino 里是 Java String）`);
    }
    bookFrame.used.add(member[1]);
  }
  if (/(?:\+\+|--)\s*$/.test(bare.slice(0, index)) || /^\s*(?:\+\+|--|(?:\*\*|>>>|<<|>>|&&|\|\||\?\?|[-+*/%&|^])?=(?!=))/.test(rest)) {
    reject(`给宿主绑定 ${name} 赋值`);
  }
}

/** bind1028 是否对本次解析生效：须 JS 链同开（ENGINE_SYNTAX_JS），口径同外层开关的 env 默认。 */
function bindActive(options: ParseOptions): boolean {
  return (options.jsEnabled ?? engineSyntaxJsEnabled()) && (options.jsBindEnabled ?? engineSyntaxJsBindEnabled());
}

/** 旧路径（rejectUnsupportedTemplates）会拒这条规则的某个 `{{}}`。 */
function templatesRejected(text: string): boolean {
  try {
    rejectUnsupportedTemplates(text);
    return false;
  } catch (error) {
    if (error instanceof RuleEngineError) return true;
    throw error;
  }
}

/** 裸标识符模板 `{{x}}`/`{{x.y}}` 的根须是 legado evalJS 能取到的名字，否则（`{{host}}`/`{{key}}`…）照旧 tpl_var。 */
const TEMPLATE_JS_ROOTS: ReadonlySet<string> = new Set([
  'baseUrl', 'result', 'src', 'title', 'book', 'chapter', 'java', 'Date', 'Math', 'String', 'Number', 'JSON',
]);

/**
 * 非 JS 规则里的 legado 模板（bind1028，AnalyzeRule.SourceRule）：构造时剥 `@@`/`@XPath:`/`@Json:` 前缀，按 evalPattern 切出
 * `{{}}`；首个 `{{` 在串首或其前没有 `##` 时整条进 Regex 模式——getString 直接返回 makeUp 后的规则串（`split("##")` 首段
 * trim，主体为空则对 content.toString() 替换），否则保持原模式，`{{}}` 只在首个 `##` 之后，拼出动态正则/替换。
 * `{{规则}}`（isRule）在字段作用域取字符串（规则内不嵌 JS），`{{JS}}` 以当前内容为 result 求值（条目级字段不许读
 * result/src），null 不拼。`@get`/`@put`/`match:`/`%%` 与模板外文本的 `$N`（splitRegex 会把模式切成 Regex）不猜，拒。
 */
function parseMakeUpField(trimmed: string, rule: string, options: ParseOptions): FieldIr {
  const field = options.field!;
  const bagGet = varBag?.mode === 'get';
  if (/@put:/i.test(trimmed)) unsupported('规则含 @put 变量存取', rule, { code: 'unsupported_var_put' });
  if (!bagGet && /@get:/i.test(trimmed)) unsupported('规则含 @get 变量存取', rule, { code: 'unsupported_var_get' });
  if (trimmed.startsWith('match:')) unsupported('规则含 match: 正则', rule, { code: 'unsupported_regex_match' });
  if (trimmed.includes('%%')) unsupported('规则含 %% 拼接（T7）', rule, { code: 'unsupported_operator', operator: '%%' });
  const prefix = /^(?:@@|@xpath:|@json:)/i.exec(trimmed)?.[0] ?? '';
  const body = trimmed.slice(prefix.length);
  if (bagGet && (body.match(/@get:/gi)?.length ?? 0) !== (body.match(/@get:\{[^}]+?\}/gi)?.length ?? 0)) {
    unsupported('规则含 @get 变量存取', rule, { code: 'unsupported_var_get' });
  }
  const first = (bagGet ? /@get:\{[^}]+?\}|\{\{[\w\W]*?\}\}/i : /\{\{[\w\W]*?\}\}/).exec(body);
  if (!first) return unsupported('模板含 {{变量}}（tpl_var）', rule, { code: 'unsupported_template_var' });
  const head = body.slice(0, first.index);
  if (first.index === 0 || !head.includes('##')) {
    return { rules: [], makeUp: { parts: makeUpParts(body, rule, options, field), regexMode: true } };
  }
  const hash = head.indexOf('##');
  const parts = makeUpParts(body.slice(hash), rule, options, field);
  if (/\$\d/.test(head.slice(0, hash))) unsupported('模板外的文本含 $N（legado 切成 Regex 模式）', rule, { code: 'unsupported_template_var' });
  const out: FieldIr = head.slice(0, hash).trim() === ''
    ? { rules: [{ kind: 'self' }] }
    : parseFieldRuleText(trimmed.slice(0, prefix.length + hash), options);
  out.makeUp = { parts, regexMode: false };
  return out;
}

/** 切模板片段：文本原样（不许 `$N`）、`{{规则}}` 编译成字段、`{{JS}}` 过白名单、`@get:{键}`（变量袋 get 模式）读袋。 */
function makeUpParts(text: string, rule: string, options: ParseOptions, field: string): JsTemplatePart[] {
  const itemLevel = JS_ITEM_FIELDS.has(field);
  const bind = bindActive(options);
  const binds = bind ? fieldBinds(field) : undefined;
  const bag = varBag?.mode === 'get' ? varBag : undefined;
  const parts: JsTemplatePart[] = [];
  const pushText = (piece: string) => {
    if (piece === '') return;
    if (/\$\d/.test(piece)) unsupported('模板外的文本含 $N（legado 切成 Regex 模式）', rule, { code: 'unsupported_template_var' });
    parts.push({ kind: 'text', text: piece });
  };
  let last = 0;
  for (const match of text.matchAll(bag ? VAR_BAG_TEMPLATE_RE : JS_TEMPLATE_RE)) {
    pushText(text.slice(last, match.index));
    last = match.index + match[0].length;
    const inner = match[1];
    if (bag && match[2] !== undefined) {
      const key = match[2];
      if (VAR_BAG_RESERVED_KEYS.has(key)) unsupported('@get 读了内置键（bookName/title）', rule, { code: 'unsupported_var_get' });
      bag.keys.add(key);
      parts.push({ kind: 'get', key });
      continue;
    }
    if (isMakeUpRule(inner)) {
      parts.push({ kind: 'rule', field: parseMakeUpRule(inner, rule, options) });
    } else {
      // 变量袋路径不要求宿主绑定开：`{{JS}}` 仍是 bind1028 的能力，没开就照旧拒。
      if (!bind) unsupported('模板含 JS 表达式（tpl_js_expr）', rule, { code: 'unsupported_template_js' });
      const path = /^\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/.exec(inner);
      if (path && !TEMPLATE_JS_ROOTS.has(path[1])) unsupported('模板含 {{变量}}（tpl_var）', rule, { code: 'unsupported_template_var' });
      if (itemLevel && jsReadsInput(inner)) unsupported('条目级字段的模板 JS 读了 result/src', rule, { code: 'unsupported_template_js' });
      checkJsCode(inner, rule, itemLevel, true, binds);
      parts.push({ kind: 'js', code: inner });
    }
  }
  pushText(text.slice(last));
  return parts;
}

/** legado evalPattern（忽略大小写）：`{{…}}` 进第 1 组，`@get:{键}` 的键进第 2 组。 */
const VAR_BAG_TEMPLATE_RE = /\{\{([\w\W]*?)\}\}|@get:\{([^}]+?)\}/gi;

/**
 * `{{规则}}`：legado 以单条 SourceRule 在当前内容上 getString（不切 JS 段）。前缀按 SourceRule 构造归一：`@CSS:` 规范成
 * 解析器认的小写，`@@` 剥掉，`@Json:` 剥掉后按 Jayway 补 `$.`（`@XPath:` 交 translateSegment）。
 */
function parseMakeUpRule(inner: string, rule: string, options: ParseOptions): FieldIr {
  let text = inner;
  if (/^@css:/i.test(text)) text = `@css:${text.slice(5)}`;
  else if (text.startsWith('@@')) text = text.slice(2);
  else if (/^@json:/i.test(text)) {
    const path = text.slice(6);
    text = path.startsWith('$') ? path : path.startsWith('[') ? `$${path}` : `$.${path}`;
  }
  if (text.trim() === '') unsupported('模板 {{规则}} 为空', rule, { code: 'unsupported_template_rule' });
  return parseFieldRule(text, {
    orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: false,
    regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: false, field: options.field,
    jsonPathEnabled: options.jsonPathEnabled,
  });
}

/** 正则字面量前一个有效字符若是这些（或在行首），`/` 是正则开头而非除号。 */
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%<>~^';

/**
 * 把 JS 里的字符串字面量、正则字面量与注释换成占位（只为扫标识符）；未闭合返回 null。
 * 模板字面量不剥（`${}` 里是代码，宁可多扫）。正则字面量按常规启发式识别：`/` 前一个有效字符是
 * 运算符/开括号/串首，或紧跟关键字 return/typeof 时视为正则开头。
 */
function stripJsLiterals(code: string): string | null {
  let out = '';
  let i = 0;
  let prev = ''; // 上一个非空白有效字符；字面量与标识符记作 'a'（操作数）
  let word = ''; // 紧邻的上一个标识符（判 return/typeof 后的正则）
  while (i < code.length) {
    const ch = code[i];
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      i = end < 0 ? code.length : end;
      out += ' ';
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      out += ' ';
      continue;
    }
    const regexStart = ch === '/' && (prev === '' || REGEX_PRECEDERS.includes(prev) || word === 'return' || word === 'typeof');
    if (ch === "'" || ch === '"' || regexStart) {
      let j = i + 1;
      let inClass = false;
      for (; j < code.length; j += 1) {
        const c = code[j];
        if (c === '\\') {
          j += 1;
          continue;
        }
        if (c === '\n') return null;
        if (ch !== '/') {
          if (c === ch) break;
        } else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      if (j >= code.length) return null;
      i = j + 1;
      if (regexStart) while (i < code.length && /[a-z]/i.test(code[i])) i += 1; // flags
      out += ' a ';
      prev = 'a';
      word = '';
      continue;
    }
    out += ch;
    if (/[\w$]/.test(ch)) {
      word = /[\w$]/.test(code[i - 1] ?? '') ? word + ch : ch;
      prev = 'a';
    } else if (!/\s/.test(ch)) {
      prev = ch;
      word = '';
    }
    i += 1;
  }
  return out;
}

/** 便捷单规则解析（返回首个 RuleIr，测试用）。 */
export function parseRule(rule: string): RuleIr {
  return parseFieldRule(rule).rules[0];
}

export type { JsonPathIr };
