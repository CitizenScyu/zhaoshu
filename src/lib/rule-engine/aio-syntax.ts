// legado AllInOne 正则列表（aio1027，ENGINE_SYNTAX_AIO）：列表规则以 `:` 开头时，legado AnalyzeRule.splitSourceRule
// （allInOne=true）把它整条当 Java 正则，AnalyzeByRegex.getElements 按 `&&` 级联——中间级拼接全部 group(0) 再交下一级，
// 末级每个匹配产出一条 `[group0..groupN]`（null 记 ""）。同一 AnalyzeRule 随后进入 isRegex 模式，同组条目字段一律按
// Regex 模式解释：`$N`（1–2 位）取该条第 N 个捕获组（越界得空，`$0` 原样），其余文本是字面量；`##` 尾缀照常替换。
// 依据：legado AnalyzeRule.kt splitSourceRule / splitRegex / makeUpRule / replaceRegex、AnalyzeByRegex.kt、
// BookChapterList.kt（列表先求值，nextTocUrl 随后在同一 Regex 模式下求值）。
//
// 正则跑在 QuickJS 沙箱里（evaluate.ts aioListScopes）：页面级正则可能回溯爆炸，沙箱有 250ms 中断与按代码计账的预算。
// Java 与 JS 正则方言只在可证明同义的子集里翻译，其余编译期拒（见 translateJavaRegex）。已知未模拟的差异：
// - Android java.util.regex 由 ICU 实现，`\d` 含全角等 Unicode 数字，JS 只认 ASCII（页面里数字几乎都是 ASCII）；
// - Java `$`（无 MULTILINE）还匹配末尾换行之前的位置，JS 只匹配串尾；Java `.` 另排除 U+0085；
// - Java `(?i)` 只做 ASCII 大小写折叠，JS `i` 按 Unicode 简单折叠；
// - 捕获组值本身含 `##` 时 legado 代换后再切 `##` 会错位，这里按规则原文静态切；
// - 条目模板代换后为空且带 `##` 替换时 legado 拿捕获组列表的 toString 去替换，这里得空（这种规则编译期已拒）。
import {
  type FieldIr, MAX_RULE_LENGTH, type RegexSub, type RuleDiagnostic, RuleEngineError, type AioRegexStage, type GroupRefPart,
} from './types';

/** 支持 AllInOne 的规则组 → 列表字段（legado 只在 getElements 里认 `:`；发现页 ruleExplore 不在阅读路径）。 */
export const AIO_LIST_FIELDS: Readonly<Record<string, string>> = { ruleSearch: 'bookList', ruleToc: 'chapterList' };

/** 条目 URL 字段：没有 `$N` 的字面量会让每一条都指向同一地址，编译期拒。 */
const AIO_URL_FIELDS: ReadonlySet<string> = new Set(['ruleSearch.bookUrl', 'ruleToc.chapterUrl']);

/** legado splitSourceRule：原文（不 trim）以 `:` 开头。 */
export function isAioListRule(rule: unknown): rule is string {
  return typeof rule === 'string' && rule.startsWith(':');
}

/** 字段全名所属规则组（`ruleToc.chapterName` → `ruleToc`）。 */
export function ruleGroupOf(field: string): string {
  const dot = field.indexOf('.');
  return dot < 0 ? field : field.slice(0, dot);
}

/** 字段是否是 AllInOne 组的列表字段。 */
export function isAioListField(field: string): boolean {
  const list = AIO_LIST_FIELDS[ruleGroupOf(field)];
  return list !== undefined && field === `${ruleGroupOf(field)}.${list}`;
}

/** 嵌套形态（`{ ruleSearch: { bookList } }`）里列表规则走 AllInOne 的规则组。 */
export function aioGroups(source: Record<string, unknown>): Set<string> {
  const groups = new Set<string>();
  for (const [group, list] of Object.entries(AIO_LIST_FIELDS)) {
    const fields = source[group];
    if (fields && typeof fields === 'object' && !Array.isArray(fields)
      && isAioListRule((fields as Record<string, unknown>)[list])) groups.add(group);
  }
  return groups;
}

/** 扁平形态（`'ruleSearch.bookList' → 规则`）同 aioGroups。 */
export function aioGroupsFlat(rules: Record<string, unknown>): Set<string> {
  const groups = new Set<string>();
  for (const [group, list] of Object.entries(AIO_LIST_FIELDS)) {
    if (isAioListRule(rules[`${group}.${list}`])) groups.add(group);
  }
  return groups;
}

function unsupported(msg: string, rule: string, code: string): never {
  const diagnostic: RuleDiagnostic = { code };
  throw new RuleEngineError('RULE_UNSUPPORTED', msg, rule, diagnostic);
}

/** AllInOne 组字段编译入口（parse.ts parseFieldRule 在开关 on、字段属 AllInOne 组时先走这里）。 */
export function parseAioField(rule: string, field: string): FieldIr {
  if (rule.length > MAX_RULE_LENGTH) unsupported('规则过长', rule, 'rule_too_long');
  // legado 先切 JS、再按 @put/@get/{{}} 拆规则；Regex 模式下它们照样生效，这里不模拟。
  if (/<js>|@js:/i.test(rule)) unsupported('AllInOne 规则含 JS', rule, 'unsupported_js');
  if (rule.includes('{{') || /@(?:get|put):/i.test(rule)) unsupported('AllInOne 规则含模板/变量', rule, 'aio_dynamic');
  if (isAioListField(field)) return aioListField(rule);
  if (field === 'ruleToc.nextTocUrl') return aioNextTocField(rule);
  return aioItemField(rule, field);
}

/** 列表规则 `:正则[&&正则…]` → regexList。getElements 不走 makeUpRule，`##` 会留在正则里——不猜，拒。 */
function aioListField(rule: string): FieldIr {
  if (!isAioListRule(rule)) unsupported('AllInOne 组的列表规则须以 `:` 开头', rule, 'aio_list_shape');
  const body = rule.slice(1);
  if (body.includes('##')) unsupported('AllInOne 列表规则含 ##', rule, 'aio_list_shape');
  // Kotlin splitNotBlank("&&")：逐段 trim、去空白段。
  const stages = body.split('&&').map((part) => part.trim()).filter((part) => part !== '');
  if (stages.length === 0) unsupported('AllInOne 列表规则为空', rule, 'aio_list_shape');
  const out: AioRegexStage[] = stages.map((stage) => {
    const { pattern, flags } = translateJavaRegex(stage, rule);
    return { pattern, flags };
  });
  return { rules: [{ kind: 'regexList', stages: out }] };
}

/**
 * 条目字段：`模板[##正则[##替换[##…]]]`。模板里 `$N` 取捕获组；`##` 段对代换结果做 legado replaceRegex
 * （≥4 段 replaceFirst）。模板为空而带替换的（2vdu 形态）legado 对捕获组列表的 toString 做替换，不模拟，拒。
 */
function aioItemField(rule: string, field: string): FieldIr {
  const parts = rule.split('##');
  const template = parseGroupTemplate(parts[0]);
  const hasGroup = template.some((part) => part.kind === 'group');
  if (parts[0].trim() === '') unsupported('AllInOne 条目模板为空', rule, 'aio_item_shape');
  if (AIO_URL_FIELDS.has(field) && !hasGroup) unsupported('AllInOne 条目 URL 不含 $N 捕获组引用', rule, 'aio_item_shape');
  const ir: FieldIr = { rules: [{ kind: 'groupRef', parts: template }] };
  const sub = aioRegexSub(parts, rule);
  if (sub) ir.regex = [sub];
  return ir;
}

/**
 * 目录下一页：legado 在同一 Regex 模式下对目录页原文求值（content 是字符串，`$N` 只是字面量），只收正则-only
 * 形态（`##正则##替换###`，对页面原文替换）。带模板的（字面量 URL）每页都指同一地址，拒。
 */
function aioNextTocField(rule: string): FieldIr {
  const parts = rule.split('##');
  if (parts[0].trim() !== '') unsupported('AllInOne 目录组 nextTocUrl 只支持正则-only 形态', rule, 'aio_next_toc');
  const sub = aioRegexSub(parts, rule);
  if (!sub) unsupported('AllInOne 目录组 nextTocUrl 为空', rule, 'aio_next_toc');
  return { rules: [{ kind: 'self' }], regex: [sub] };
}

/** legado makeUpRule 的 `##` 切分：[1] 正则、[2] 替换（缺省空）、段数 >3 即 replaceFirst；正则为空 = 不替换。 */
function aioRegexSub(parts: readonly string[], rule: string): RegexSub | undefined {
  if (parts.length < 2 || parts[1] === '') return undefined;
  const { pattern, flags, groups } = translateJavaRegex(parts[1], rule);
  const replacement = translateReplacement(parts[2] ?? '', groups, rule);
  return parts.length > 3 ? { pattern, replacement, flags, first: true } : { pattern, replacement, flags: `${flags}g` };
}

/** legado splitRegex：`\$\d{1,2}` 贪婪取 1–2 位；`$0` 是默认类型（字面量）。 */
function parseGroupTemplate(text: string): GroupRefPart[] {
  const parts: GroupRefPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/\$\d{1,2}/g)) {
    const index = match.index;
    if (index > last) parts.push({ kind: 'literal', text: text.slice(last, index) });
    const group = Number(match[0].slice(1));
    parts.push(group === 0 ? { kind: 'literal', text: match[0] } : { kind: 'group', index: group });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'literal', text: text.slice(last) });
  return parts;
}

/**
 * Java Matcher 替换串 → JS replace 替换串。Java 认 `\x` 转义与 `$N`/`${name}`；JS 认 `$N`/`$&`/`$$`/`` $` ``/`$'`/`$<name>`。
 * 只收两边同义的子集：普通文本 + 单位数 `$N`（N ≤ 组数，`$0` → `$&`）；反斜杠、其余 `$` 形态、两位数组号一律拒
 * （Java 越界组号抛异常，legado 退成字面替换；两位数组号 Java 按组数贪婪取、JS 规则不同）。
 */
function translateReplacement(text: string, groups: number, rule: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') unsupported('替换串含反斜杠转义', rule, 'aio_replacement');
    if (ch !== '$') {
      out += ch;
      continue;
    }
    const digit = /^\$(\d)(?!\d)/.exec(text.slice(i));
    if (!digit) unsupported('替换串含不支持的 $ 形态', rule, 'aio_replacement');
    const group = Number(digit[1]);
    if (group > groups) unsupported('替换串引用的捕获组不存在', rule, 'aio_replacement');
    out += group === 0 ? '$&' : `$${group}`;
    i += 1;
  }
  return out;
}

/** Java 内联标志 → JS flags（`u` = UNICODE_CASE，JS 非 u 模式的 `i` 已是 Unicode 折叠，丢弃）。 */
const JAVA_INLINE_FLAGS: Readonly<Record<string, string>> = { s: 's', i: 'i', m: 'm', u: '' };

/** 字母/数字转义里两边同义的：类转义 `\d\D\s\S`（\d 差异见文件头）与控制字符 `\t\n\r\f`；`\xhh`、`\uhhhh` 另判。 */
const SAFE_ALNUM_ESCAPES: ReadonlySet<string> = new Set(['d', 'D', 's', 'S', 't', 'n', 'r', 'f']);

/**
 * Java 正则 → JS 正则（非 u 模式）。开头的 `(?flags)` 转成 JS flags；其余逐字符扫描，只放行两边同义的构件：
 * - 拒 `\w\W\b\B`（ICU 按 Unicode 判单词字符，JS 只认 ASCII——中文页面上结果完全不同）、`\A\Z\z\G\Q\E\p\P\h\H\R\X\v\e\a\c\N\k`、
 *   `\0` 与数字反向引用（JS 非 u 模式下 `\12` 可能被当八进制）、`\x{…}`；
 * - 拒占有量词（`*+ ++ ?+ }+`）、原子组 `(?>`、中段内联标志 `(?i)`/`(?i:`；只放行 `(?: (?= (?! (?<= (?<! (?<name>`；
 * - 拒字符类内的 `[`（Java 并集）与 `&&`（Java 交集）、`[]`/`[^]`（Java 把 `]` 当字面量，JS 是空类）；
 * - 拒孤立 `{`（Java 非法重复，JS 当字面量）。
 * 返回 JS 源串、flags（不含 g）与捕获组数。
 */
export function translateJavaRegex(source: string, rule: string): { pattern: string; flags: string; groups: number } {
  let flags = '';
  let pattern = source;
  const lead = /^\(\?([A-Za-z]+)\)/.exec(pattern);
  if (lead) {
    for (const ch of lead[1]) {
      const js = JAVA_INLINE_FLAGS[ch];
      if (js === undefined) unsupported(`正则内联标志 (?${ch}) 没有 JS 等价`, rule, 'aio_regex_unsupported');
      if (js !== '' && !flags.includes(js)) flags += js;
    }
    pattern = pattern.slice(lead[0].length);
  }
  if (pattern === '') unsupported('正则为空', rule, 'aio_regex_unsupported');
  scanJavaRegex(pattern, rule);
  try {
    new RegExp(pattern, flags);
  } catch {
    unsupported('正则无法编译', rule, 'aio_regex_invalid');
  }
  const groups = new RegExp(`${pattern}|`, flags).exec('')!.length - 1;
  return { pattern, flags, groups };
}

function scanJavaRegex(pattern: string, rule: string): void {
  const bad: (what: string) => never = (what) => unsupported(`正则含 Java/JS 语义不同的构件：${what}`, rule, 'aio_regex_unsupported');
  let inClass = false;
  let classStart = -1;
  let quantified = false; // 上一个 token 是量词：其后 `?` 是惰性，`+` 是占有量词
  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) bad('末尾孤立反斜杠');
      if (next === 'x') {
        if (!/^[0-9A-Fa-f]{2}$/.test(pattern.slice(i + 2, i + 4))) bad('\\x 非两位十六进制');
        i += 4;
      } else if (next === 'u') {
        if (!/^[0-9A-Fa-f]{4}$/.test(pattern.slice(i + 2, i + 6))) bad('\\u 非四位十六进制');
        i += 6;
      } else if (/[A-Za-z0-9]/.test(next)) {
        if (!SAFE_ALNUM_ESCAPES.has(next)) bad(`\\${next}`);
        i += 2;
      } else {
        i += 2; // 转义的标点：两边都是字面量
      }
      quantified = false;
      continue;
    }
    if (inClass) {
      if (ch === '[') bad('字符类内的 [');
      if (ch === '&' && pattern[i + 1] === '&') bad('字符类内的 &&');
      if (ch === ']') {
        if (i === classStart) bad('[] / [^]');
        inClass = false;
      }
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      if (pattern[i] === '^') i += 1;
      classStart = i;
      quantified = false;
      continue;
    }
    if (ch === '(') {
      if (pattern[i + 1] === '?') {
        const group = /^(?::|=|!|<=|<!|<[A-Za-z][A-Za-z0-9]*>)/.exec(pattern.slice(i + 2));
        if (!group) bad('(? 构件');
        i += 2 + group[0].length;
      } else {
        i += 1;
      }
      quantified = false;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      if (quantified) {
        if (ch === '?') {
          quantified = false;
          i += 1;
          continue;
        }
        bad(ch === '+' ? '占有量词' : '量词叠用');
      }
      quantified = true;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const repeat = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
      if (!repeat) bad('孤立的 {');
      if (quantified) bad('量词叠用');
      quantified = true;
      i += repeat[0].length;
      continue;
    }
    quantified = false;
    i += 1;
  }
  if (inClass) bad('字符类未闭合');
}

/** 沙箱里跑的列表求值代码（getElements 同款级联）。按 IR 记忆：同一编译产物逐页复用同一段代码，预算按代码计账。 */
const listCode = new WeakMap<readonly AioRegexStage[], string>();

export function aioListCode(stages: readonly AioRegexStage[]): string {
  const hit = listCode.get(stages);
  if (hit !== undefined) return hit;
  const literal = JSON.stringify(stages.map((stage) => [stage.pattern, stage.flags]));
  // 末级只回传 group1..N（group0 用不到——`$0` 是字面量），省掉整段匹配串的输出体积；宿主侧补位对齐下标。
  const code = `(function(){
  var stages = ${literal};
  var text = src;
  for (var i = 0; i < stages.length; i++) {
    var re = new RegExp(stages[i][0], stages[i][1] + 'g');
    var last = i === stages.length - 1;
    var items = [], joined = '', hit = false, m;
    while ((m = re.exec(text)) !== null) {
      hit = true;
      if (last) {
        var groups = [];
        for (var k = 1; k < m.length; k++) groups.push(m[k] === undefined ? '' : m[k]);
        items.push(groups);
      } else {
        joined += m[0];
      }
      if (m[0] === '') re.lastIndex++;
    }
    if (!hit) return '[]';
    if (last) return JSON.stringify(items);
    text = joined;
  }
  return '[]';
})()`;
  listCode.set(stages, code);
  return code;
}
