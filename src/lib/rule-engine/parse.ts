// 规则文本 → IR。方言识别（默认语法/@css:/css:/JSONPath $. /纯文本/{{$.x}} 模板）、
// 构件白名单、##正则##尾缀剥离、深度/长度上限、不支持构件编译期拒绝（RULE_UNSUPPORTED）。
// 设计依据：m1-engine-design.md v3 §2.3。这就是滤网 1 的实现本体。

import {
  CssStep,
  FieldIr,
  JsonPathIr,
  MAX_CSS_CHAIN_DEPTH,
  MAX_REGEX_PATTERN_LENGTH,
  MAX_RULE_LENGTH,
  RegexSub,
  RuleEngineError,
  RuleIr,
  TemplatePart,
  TerminalOp,
} from './types';
import { parseJsonPath } from './jsonpath';

function unsupported(msg: string, rule: string): never {
  throw new RuleEngineError('RULE_UNSUPPORTED', msg, rule);
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
  if (rule.includes('@js:') || /<js\b|<js>/.test(rule)) unsupported('规则含 JS（@js:/<js>）', rule);
  if (rule.includes('@put:')) unsupported('规则含 @put 变量存取', rule);
  if (rule.includes('@get:')) unsupported('规则含 @get 变量存取', rule);
  if (rule.trimStart().startsWith('match:')) unsupported('规则含 match: 正则', rule);
  if (rule.includes('%%')) unsupported('规则含 %% 拼接（T7）', rule);
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
    if (inner.startsWith('@@')) unsupported('模板含 {{@@规则}}（tpl_rule）', rule);
    if (JS_EXPR_RE.test(inner)) unsupported('模板含 JS 表达式（tpl_js_expr）', rule);
    unsupported('模板含 {{变量}}（tpl_var）', rule);
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
    if (inner.startsWith('@@')) unsupported('模板含 {{@@规则}}（tpl_rule）', rule);
    if (inner.startsWith('$')) {
      parts.push({ kind: 'jsonpath', path: parseJsonPath(inner) });
    } else if (JS_EXPR_RE.test(inner)) {
      unsupported('模板含 JS 表达式（tpl_js_expr）', rule);
    } else {
      unsupported('模板含 {{变量}}（tpl_var）', rule);
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
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) unsupported('正则 pattern 过长', rule);
  // 只保留合法 JS 正则 flag 字符（去重）；legado 规则常有 trailing ### 等噪声 → 视作无 flags。
  const cleanFlags = flags ? [...new Set(flags.split(''))].filter((c) => 'gimsuy'.includes(c)).join('') : '';
  const finalFlags = cleanFlags === '' ? undefined : cleanFlags;
  try {
    new RegExp(pattern, finalFlags ?? 'g');
  } catch {
    unsupported(`正则 pattern 无法编译：${pattern}`, rule);
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
  if (LEGADO_SPECIAL_VARS.has(token)) unsupported(`不支持 legado 特殊变量 @${token}`, rule);
  // 具名属性兜底：@some-attr（HTML 属性名，含连字符/冒号）
  if (/^[\w:-]+$/.test(token)) return { op: 'attr', name: token };
  unsupported(`不支持的末端操作 @${token}`, rule);
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
  if (looksLikeXPath(seg)) unsupported('规则疑似 XPath', rule);

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

  // 6) 默认语法选择器链
  return buildCssChain(seg, rule, false);
}

/**
 * 构建 CSS 选择器链。默认语法按 @ 切分为多段 + 末端 op；@css: 整段为一个 selector + 末端 op。
 */
function buildCssChain(body: string, rule: string, explicit: boolean): RuleIr {
  // 末端 @op 与段间 @ 都用 @ 表达。策略：按顶层 @ 切分，最后一段若是纯末端关键字/属性则为 terminal。
  const atParts = splitTopLevel(body, '@');
  if (atParts.length > MAX_CSS_CHAIN_DEPTH + 1) unsupported('选择器链过深', rule);

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
  if (chain.length === 0 && !terminal) unsupported('空选择器', rule);
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
 * M1 期：顶层 || 切出 >1 段 → RULE_UNSUPPORTED；&& → RULE_UNSUPPORTED。
 */
export function parseFieldRule(rule: string): FieldIr {
  if (typeof rule !== 'string') unsupported('规则非字符串', String(rule));
  const trimmed = rule.trim();
  if (trimmed === '') unsupported('空规则', rule);
  if (trimmed.length > MAX_RULE_LENGTH) unsupported('规则过长', rule);

  rejectUnsupportedConstructs(trimmed);

  // 顶层 && → T7 拒绝
  if (splitTopLevel(trimmed, '&&').length > 1) unsupported('规则含顶层 &&（T7）', rule);
  // 顶层 || → M1 期 >1 段拒绝
  const orParts = splitTopLevel(trimmed, '||');
  if (orParts.length > 1) unsupported('规则含顶层 ||（T7）', rule);

  const segment = orParts[0];
  const { body, regex } = stripRegexSuffix(segment, rule);
  // 正则-only 规则（剥掉 ##...## 尾缀后主体为空，如 `##<a.*?href="([^"]+)"##$1###`）：
  // ##regex## 在 §2.3 里只定义为「选择器后缀」，无选择器主体的独立正则不在 M1 集内 → 显式拒绝
  // （不猜「对原始输入直接跑正则」的语义，§2.3 第5条不猜测）。
  if (body.trim() === '' && regex.length > 0) unsupported('正则-only 规则（无选择器主体，非 M1 集）', rule);
  const ir = translateSegment(body, rule);
  const field: FieldIr = { rules: [ir] };
  if (regex.length > 0) field.regex = regex;
  return field;
}

/** 便捷单规则解析（返回首个 RuleIr，测试用）。 */
export function parseRule(rule: string): RuleIr {
  return parseFieldRule(rule).rules[0];
}

export type { JsonPathIr };
