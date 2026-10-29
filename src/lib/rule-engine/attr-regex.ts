// attrregex1030（ENGINE_SYNTAX_ATTR_REGEX）：jsoup 的 `[k~=re]` 是属性值正则，css-select 的 `~=` 是空白分词整词比较。
// 依据：jsoup 1.16.2（legado libs.toml 钉死）QueryParser.byAttribute——`[` 段由 TokenQueue.chompBalanced('[', ']') 取出，
// key = consumeToAny("=", "!=", "^=", "$=", "*=", "~=")，`~=` 之后的余下全文（不 trim、不剥引号）交 Pattern.compile；
// Evaluator.AttributeWithValueMatching：element.hasAttr(key.lower().trim()) && pattern.matcher(attr).find()。
// css-select 上 `[property~=category|status]` 恒不中，含 `[`/空白的正则（`[src~=^https?://[a-z]+]`）直接抛。
// on 时 parse.ts 把这些段改写成伪类 `:-nf-attr-re(hex)`（hex = UTF-8 编码的 [key, pattern, flags]），求值时由
// evaluate.ts 载入文档挂的 ATTR_REGEX_PSEUDOS 匹配。正则经 aio-syntax.ts translateJavaRegex 翻译（只放行两边同义的构件），
// 译不了的段保持原样（旧口径）。已知差异：cheerio filter 不带自定义伪类，selfmatch1029 的自身回退对改写后的段取空。
import type { Element } from 'domhandler';
import { translateJavaRegex } from './aio-syntax';
import { MAX_REGEX_PATTERN_LENGTH } from './types';

export const ATTR_REGEX_PSEUDO = '-nf-attr-re';

const toHex = (text: string): string => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * jsoup TokenQueue.chompBalanced('[', ']')：从 `start`（须是 `[`）起找配对的 `]`，返回其下标，找不到 -1。单/双引号内、
 * `\Q…\E` 内不计括号；紧跟反斜杠的字符不计（jsoup 只看前一个字符，`\\]` 的 `]` 也算转义）。
 */
function jsoupBracketEnd(text: string, start: number): number {
  let depth = 0;
  let last = '';
  let single = false;
  let double = false;
  let quoted = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (last !== '\\') {
      if (ch === "'" && !double) single = !single;
      else if (ch === '"' && !single) double = !double;
      if (single || double || quoted) {
        last = ch;
        continue;
      }
      if (ch === '[') depth += 1;
      else if (ch === ']') depth -= 1;
    } else if (ch === 'Q') {
      quoted = true;
    } else if (ch === 'E') {
      quoted = false;
    }
    last = ch;
    if (depth === 0) return i;
  }
  return -1;
}

const ATTR_EVALS = ['=', '!=', '^=', '$=', '*=', '~='];

/** 一个 `[…]` 段内文（不含外层括号）若是 jsoup `~=`，返回改写后的伪类；否则（含正则译不了）null。 */
function rewriteSegment(inner: string): string | null {
  let at = 0;
  while (at < inner.length && !ATTR_EVALS.some((op) => inner.startsWith(op, at))) at += 1;
  if (!inner.startsWith('~=', at)) return null;
  const key = inner.slice(0, at).toLowerCase().trim();
  if (key === '' || /[\s"'\\()[\]]/.test(key)) return null;
  const source = inner.slice(at + 2);
  if (source.length > MAX_REGEX_PATTERN_LENGTH) return null;
  let pattern = '';
  let flags = '';
  if (source !== '') {
    try {
      ({ pattern, flags } = translateJavaRegex(source, source));
    } catch {
      return null;
    }
  }
  return `:${ATTR_REGEX_PSEUDO}(${toHex(JSON.stringify([key, pattern, flags]))})`;
}

/**
 * 把选择器里顶层（圆括号外、引号外）的 jsoup `[k~=re]` 改写成 `:-nf-attr-re(hex)`；其余写法逐字不变。改写段按
 * jsoup chompBalanced 定界，所以正则里的 `[a-z]`、`]` 转义照 jsoup 归属。
 */
export function rewriteLegadoAttrRegex(selector: string): string {
  if (!selector.includes('~=')) return selector;
  let out = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < selector.length) out += selector[++i];
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '[' && depth === 0) {
      const end = jsoupBracketEnd(selector, i);
      const pseudo = end > 0 ? rewriteSegment(selector.slice(i + 1, end)) : null;
      if (pseudo !== null) {
        out += pseudo;
        i = end;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

interface AttrRegex {
  key: string;
  re: RegExp;
}

/** 伪类实参 → 已编译正则（同一选择器每页都会重编译，按实参缓存；条数随规则文本有界，超限清空）。 */
const COMPILED = new Map<string, AttrRegex | null>();
const COMPILED_LIMIT = 4096;

function compiled(data: string): AttrRegex | null {
  const hit = COMPILED.get(data);
  if (hit !== undefined) return hit;
  let value: AttrRegex | null = null;
  try {
    const bytes = new Uint8Array((data.match(/../g) ?? []).map((b) => parseInt(b, 16)));
    const [key, pattern, flags] = JSON.parse(new TextDecoder().decode(bytes)) as [string, string, string];
    value = { key, re: new RegExp(pattern, flags) };
  } catch {
    value = null;
  }
  if (COMPILED.size >= COMPILED_LIMIT) COMPILED.clear();
  COMPILED.set(data, value);
  return value;
}

/** 文档载入选项里挂的自定义伪类（evaluate.ts createHtmlScope）。只有 rewriteLegadoAttrRegex 产出的选择器会用到。 */
export const ATTR_REGEX_PSEUDOS = {
  [ATTR_REGEX_PSEUDO]: (elem: Element, data: string | null | undefined): boolean => {
    const spec = data ? compiled(data) : null;
    if (spec === null) return false;
    const value = elem.attribs[spec.key];
    return value !== undefined && spec.re.test(value);
  },
};
