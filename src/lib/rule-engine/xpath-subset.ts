// xpath1027：简单子集 XPath → CSS 选择器（编译期翻译，求值仍走 cheerio 的 scope.find）。
// legado 口径（AnalyzeRule.SourceRule）：段首 `@XPath:` 或 `/` 即 XPath 模式。JsoupXpath 在元素上下文里把开头的
// `//` 当「当前节点的后代」，与 scope.find 同义，所以列表内字段的 `//a/@href` 可直接按后代翻。
// 子集（离线统计 125 个 XPath 源 612 条表达式里 491 条落在此内）：
//   步    = `*` 或标签名，后跟若干谓词；轴 `//`=后代（' '）、`/`=子（' > '），开头可带 `.`；
//   谓词  = `[@a]` / `[@a='v']` / `[contains(@a,'v')]` / `[n]` / `[last()]`；
//           下标只能在属性谓词之前（`div[2][@class='x']`）——XPath 里属性谓词之后的 [n] 是过滤后的位次，CSS 表达不了；
//   末尾  = `/text()`（直接子文本节点 → textNodes）或 `/@attr`（→ 同名末端 op，href/src 照常绝对化）。
// 子集外（following-sibling::、`//text()`、函数谓词、并集 `|` 等）返回 null，由调用方照旧拒 unsupported_xpath。

/** XPath 判别（survey.py JS_EXPR 之外的 xpath 检测同款口径）。 */
export function looksLikeXPath(rule: string): boolean {
  return /(^\s*\/\/|\/text\(\)|\[@|starts-with\(|following-sibling|\/\/@)/.test(rule);
}

const XPATH_PREFIX = '@xpath:';

/** 开关 on 时该段按 XPath 处理则返回去前缀的表达式，否则 null（`@XPath:` 前缀、`/` 开头或旧判别命中）。 */
export function xpathSegmentBody(seg: string): string | null {
  if (seg.slice(0, XPATH_PREFIX.length).toLowerCase() === XPATH_PREFIX) return seg.slice(XPATH_PREFIX.length).trim();
  if (seg.startsWith('/') || looksLikeXPath(seg)) return seg;
  return null;
}

/**
 * 字段规则文本是否可能含 XPath 段（语义版本判定用，宁宽勿漏）。段只会从字段开头或顶层 `||` 之后开始，
 * 故「开头/|| 后紧跟 `/`」+ `@XPath:` + 旧判别 覆盖 xpathSegmentBody 的全部命中。
 */
export function ruleMayUseXPath(rule: string): boolean {
  return looksLikeXPath(rule) || rule.toLowerCase().includes(XPATH_PREFIX) || /(^|\|\|)\s*\//.test(rule);
}

export interface XPathCss {
  /** CSS 选择器；空串 = 直接对当前节点套末端（如 `/text()`）。 */
  selector: string;
  /** 末端 token（交 parse.ts toTerminal）：`textNodes` 或属性名。 */
  terminal?: string;
}

const STEP_NAME = /^(?:\*|[A-Za-z_][\w-]*)/;
const QUOTED = String.raw`(?:'([^']*)'|"([^"]*)")`;
const ATTR_EQ = new RegExp(String.raw`^@([\w-]+)\s*=\s*${QUOTED}$`);
const ATTR_CONTAINS = new RegExp(String.raw`^contains\(\s*@([\w-]+)\s*,\s*${QUOTED}\s*\)$`);

function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 谓词结束位置（首个引号外的 `]`）；找不到返回 -1。s[0] 为 `[`。 */
function predicateEnd(s: string): number {
  let quote: string | null = null;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '[') {
      return -1; // 嵌套谓词不在子集内
    } else if (ch === ']') {
      return i;
    }
  }
  return -1;
}

/** 翻译简单子集 XPath；子集外返回 null。 */
export function xpathToCss(expr: string): XPathCss | null {
  let s = expr.trim();
  if (s.startsWith('./')) s = s.slice(1);
  if (s === '') return null;
  let selector = '';
  let first = true;
  while (s.length > 0) {
    let descendant: boolean;
    if (s.startsWith('//')) {
      descendant = true;
      s = s.slice(2);
    } else if (s.startsWith('/')) {
      descendant = false;
      s = s.slice(1);
    } else if (first) {
      descendant = false; // 相对路径 `div/a`：首步为子轴
    } else {
      return null;
    }
    if (s === 'text()') return descendant ? null : { selector, terminal: 'textNodes' };
    const attr = /^@([\w-]+)$/.exec(s);
    if (attr) return descendant ? null : { selector, terminal: attr[1] };

    const name = STEP_NAME.exec(s);
    if (!name) return null;
    const tag = name[0];
    let step = tag;
    s = s.slice(tag.length);
    let sawAttr = false;
    let sawPosition = false;
    while (s.startsWith('[')) {
      const end = predicateEnd(s);
      if (end < 0) return null;
      const body = s.slice(1, end).trim();
      s = s.slice(end + 1);
      let m: RegExpExecArray | null;
      if (/^\d+$/.test(body) || body === 'last()') {
        if (sawAttr || sawPosition) return null;
        sawPosition = true;
        const kind = tag === '*' ? 'child' : 'of-type';
        if (body === 'last()') {
          step += `:last-${kind}`;
        } else {
          const n = Number(body);
          if (n < 1) return null;
          step += `:nth-${kind}(${n})`;
        }
      } else if ((m = /^@([\w-]+)$/.exec(body))) {
        sawAttr = true;
        step += `[${m[1]}]`;
      } else if ((m = ATTR_EQ.exec(body))) {
        sawAttr = true;
        step += `[${m[1]}=${cssString(m[2] ?? m[3])}]`;
      } else if ((m = ATTR_CONTAINS.exec(body))) {
        const value = m[2] ?? m[3];
        if (value === '') return null; // contains(@a,'') 对缺失属性也为真，CSS 无对应
        sawAttr = true;
        step += `[${m[1]}*=${cssString(value)}]`;
      } else {
        return null;
      }
    }
    // 首步子轴写 `> X`（元素 scope 上 cheerio 认相对选择器）。例外 `/html`：文档根上 css-select 不认 `> html`，
    // 而根下唯一元素就是 <html>、元素 scope 下 `> html` 本就不可能命中，故去掉 `> ` 两种 scope 语义都不变。
    if (first) selector = descendant || tag.toLowerCase() === 'html' ? step : `> ${step}`;
    else selector += descendant ? ` ${step}` : ` > ${step}`;
    first = false;
  }
  return selector ? { selector } : null;
}
