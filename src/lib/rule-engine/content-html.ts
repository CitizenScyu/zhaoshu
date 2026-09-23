// 引擎源正文的 HTML→纯文本（41-HTMLFIX，第二轮按复审裁定重写）。
//
// 只用于正文层（engineFetchContent 的 ruleContent.content 产出），不改变 evaluateText 的
// `@html` 语义——简介等其它字段的 @html 仍返回原始 HTML。对齐 Legado 正文格式化（HtmlFormatter）
// 的段落语义：块级标签转段落换行、script/style 连内容删除、实体解码。
//
// 是否转换由调用方按**规则类型**判定（contentNeedsHtmlToText），不再按内容嗅探：
// 纯文本类规则（@text/@ownText/@textNodes）逐字节透传，其余（@html、JSON 路径、模板等）一律转换。

import type { FieldIr, RuleIr } from './types';

// 块级/换行标签：闭合处转段落换行。覆盖 Legado HtmlFormatter 的块级集合（其超集）。
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'tr', 'blockquote', 'pre', 'section', 'article', 'header', 'footer',
  'ul', 'ol', 'table', 'hr', 'dl', 'dt', 'dd',
]);

/** cheerio 文本类末端：产出已经是纯文本（实体由 parse5 解过），转换必须逐字节透传。 */
const TEXT_OPS = new Set(['text', 'ownText', 'textNodes']);

/**
 * 规则的每一支是否都是「纯文本类」CSS 末端。
 * 无 terminal 的 css 支在字段层会被按 @text 求值（evaluate.ts:220 的默认末端），
 * 同样视为纯文本；`or` 组合要求全部分支都是纯文本，混合分支保守按「需转换」处理。
 */
function ruleIsPlainText(ir: RuleIr): boolean {
  if (ir.kind === 'or') return ir.branches.every(ruleIsPlainText);
  if (ir.kind !== 'css') return false;
  return ir.terminal === undefined || TEXT_OPS.has(ir.terminal.op);
}

/**
 * 正文规则是否需要做 HTML→纯文本。判定依据是规则类型而不是内容（B1/B3）：
 * 全部候选支都是 text/ownText/textNodes（或无后缀，默认 @text）时返回 false，逐字节透传；
 * 其余（@html、@all、jsonpath、template、text 字面量、混合 || 分支）返回 true。
 * 字段缺失时按不转换处理（产出为空串，没有可转换的东西）。
 */
export function contentNeedsHtmlToText(field: FieldIr | undefined): boolean {
  if (!field) return false;
  return !field.rules.every(ruleIsPlainText);
}

// HTML4 命名实体表（S7：JSON 正文不经 parse5，需要自行解码）。
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', middot: '·',
  emsp: ' ', ensp: ' ',
};

const REPLACEMENT = '�';

/**
 * HTML 实体解码：命名实体 + 十进制/十六进制数字实体。
 * 码点为 0、落在代理区（U+D800–U+DFFF）或超过 U+10FFFF 时输出 U+FFFD，不抛异常（B4）。
 * 命名实体用 Object.hasOwn 查表，`&constructor;` 等原样保留（S2）。
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT;
      return String.fromCodePoint(code);
    }
    const key = body.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

/** 单趟删除 `<tag…>…</tag…>`（大小写不敏感，结束标签允许 `</tag >` 形态）。
 *  只认标签名后紧跟空白、`>` 或 `/` 的开标签，`<scripts>` 这类更长的名字不误伤。
 *  找不到闭合时从开标签截到输入末尾。游标只前进，整串只扫一次、只小写一次。 */
function stripTagBlocks(text: string, lower: string, tag: string): { text: string; lower: string } {
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let pos = 0;
  for (let from = 0; ;) {
    const start = lower.indexOf(open, from);
    if (start < 0) { out += text.slice(pos); break; }
    const boundary = lower[start + open.length];
    if (boundary !== undefined && boundary !== '>' && boundary !== '/' && !/\s/.test(boundary)) { from = start + open.length; continue; }
    out += text.slice(pos, start);
    const gt = lower.indexOf('>', start + open.length);
    if (gt < 0) { pos = text.length; break; }
    const end = lower.indexOf(close, gt + 1);
    if (end < 0) { pos = text.length; break; }
    const endGt = lower.indexOf('>', end + close.length);
    pos = endGt < 0 ? text.length : endGt + 1;
    from = pos;
  }
  const joined = out;
  return { text: joined, lower: joined.toLowerCase() };
}

/** 单趟删除 `<!-- … -->`；找不到闭合时从 `<!--` 截到末尾。游标只前进。 */
function stripComments(text: string): string {
  let out = '';
  let pos = 0;
  for (let from = 0; ;) {
    const start = text.indexOf('<!--', from);
    if (start < 0) return out + text.slice(pos);
    out += text.slice(pos, start);
    const end = text.indexOf('-->', start + 4);
    if (end < 0) return out;
    pos = end + 3;
    from = pos;
  }
}

/**
 * 把正文 HTML 转成纯文本。调用方保证只对「非纯文本类」规则的产出调用（见
 * contentNeedsHtmlToText）；本函数对任何输入都是全量转换，不再自行判断。
 * 段落约定与仓内正文一致：块级标签处换行，段落之间单换行分隔（MULTI_JOIN 口径）。
 * 全部扫描都是线性的（B2）：标签用 `[^<>]*`，注释与 script/style 用 indexOf。
 */
export function contentHtmlToText(html: string): string {
  // CR 归一（s4）：只影响 JSON 等原始串路径，parse5 路径的 CR 已被归一。
  let text = html.replace(/\r\n?/g, '\n');
  // script/style 连同内容整段删除（单趟游标扫描，大小写不敏感）。未闭合时截到末尾。
  let lower = text.toLowerCase();
  for (const tag of ['script', 'style']) {
    const stripped = stripTagBlocks(text, lower, tag);
    text = stripped.text;
    lower = stripped.lower;
  }
  // 注释：找不到闭合 `-->` 时截到末尾（与 script 同口径），同样单趟。
  text = stripComments(text);
  // 标签：块级 → 段落换行，其余只剥标签。名字允许 `:`/`-`/`_`（接住 `<o:p>` 这类，N1）。
  // `[^<>]*` 不跨 `<`，线性且不吞正文里的 `<`。
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9:_-]*)(?:\s[^<>]*)?\/?>/g, (whole, name: string) => (
    BLOCK_TAGS.has(name.toLowerCase()) ? '\n' : ''
  ));
  // 先剥标签再解码实体（R4）：页面上的转义文本 `&lt;b&gt;` 不会先变成真标签再被吃掉。
  text = decodeEntities(text);
  // 零宽字符（U+200B–U+200D）是防爬水印，删除（S6，参照 Legado noPrintRegex 的思路，
  // 其具体码点集合未逐一核对）。
  text = text.replace(/[​‌‍]/g, '');
  const lines = text.split('\n');
  // 逐行 trim：剥半角空格/制表/不间断空格（U+00A0）与 em 空格（U+2003）、en 空格（U+2002，s5），
  // 行首全角缩进「　　」(U+3000) 保留。只含这些空白的行视为空行参与压缩（S5）。
  const isEdgeSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === ' ' || ch === ' ' || ch === ' ';
  const cleaned = lines.map((line) => {
    let start = 0;
    let end = line.length;
    while (start < end && isEdgeSpace(line[start])) start += 1;
    while (end > start && isEdgeSpace(line[end - 1])) end -= 1;
    const core = line.slice(start, end);
    return /^[　]+$/.test(core) ? '' : core;
  });
  // 连续空行压成一个；只修整整体首尾的换行，行内全角缩进保留。
  return cleaned.join('\n').replace(/\n{2,}/g, '\n').replace(/^\n+/g, '').replace(/\n+$/g, '');
}
