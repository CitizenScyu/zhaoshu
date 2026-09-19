// DOM 求值层：CSS 选择器链求值 + 末端操作（TerminalOp）语义。
// 设计依据：m1-engine-design.md v3 §3.2（四步求值 + 语义表）。cheerio/css-select 适配层。
// 引擎不含任何网络/预算/节流逻辑——本文件是纯函数，输入 (HTML 已 load 的 $, 规则 IR, pageUrl)。

import type { AnyNode, Element, Text } from 'domhandler';
import type { Cheerio, CheerioAPI } from 'cheerio';
import { type CssStep, RuleEngineError, type TerminalOp } from './types';

export type HtmlNode = AnyNode;
export type CheerioNodes = Cheerio<AnyNode>;

/**
 * 多节点拼接分隔符。
 * 仅用于「确需拼接多个节点」的两处：正文 `ruleContent.content`（多段落容器，applyTerminal
 * multi=true）与单节点内 `@textNodes` 子文本拼接（textNodesOf，与命中数无关）；jsonpath 多值
 * （jsonValuesToString）另有其约定。**单值字段**（name/bookUrl/... ）不再拼接，取首个非空值。
 */
export const MULTI_JOIN = '\n';

function evalFailed(message: string, rule?: string): never {
  throw new RuleEngineError('RULE_EVAL_FAILED', message, rule);
}

// ---------------------------------------------------------------- 文本三类（legado 口径）
/**
 * 自身文本（不含子孙）：直接子文本节点原样拼接。对应 legado `@ownText`（jsoup ownText）。
 */
export function ownTextOf(node: HtmlNode): string {
  const children = elementsChildren(node);
  let out = '';
  for (const child of children) {
    if (child.type === 'text') out += (child as Text).data;
  }
  return out;
}

/**
 * 直接子文本节点拼接（以换行连接）。对应 legado `@textNodes`。
 */
export function textNodesOf(node: HtmlNode): string {
  return elementsChildren(node)
    .filter((child) => child.type === 'text')
    .map((child) => (child as Text).data)
    .join(MULTI_JOIN);
}

function elementsChildren(node: HtmlNode): AnyNode[] {
  const parent = node as Partial<Element>;
  return Array.isArray(parent.children) ? parent.children : [];
}

// ---------------------------------------------------------------- URL 绝对化
/**
 * 相对 URL → 绝对 URL（`new URL(value, pageUrl)`）。失败返回 null = 该值丢弃（§3.2）。
 * 只对 URL 类属性（href/src）应用——title/alt/content 等是文本，绝对化会污染数据。
 */
export function absolutizeUrl(value: string, pageUrl: string): string | null {
  const raw = value.trim();
  if (raw === '') return null;
  try {
    return new URL(raw, pageUrl).href;
  } catch {
    return null;
  }
}

/** URL 类末端操作（需绝对化）。 */
const URL_OPS = new Set<TerminalOp['op']>(['href', 'src']);

/** 单列属性名（与 legado 的 @属性 同款；@attr 兜底走具名属性）。 */
const OP_ATTRS: Partial<Record<TerminalOp['op'], string>> = {
  content: 'content',
  value: 'value',
  title: 'title',
  alt: 'alt',
  data: 'data',
  srcset: 'srcset',
};

// ---------------------------------------------------------------- 末端操作
/**
 * 对命中的节点集应用末端操作，返回字段字符串。
 * 属性不存在 / URL 绝对化失败 → 该节点贡献被丢弃（null）。
 *
 * `multi=false`（默认，单值字段）：取**首个非空**节点值（等价 legado 单值字段 first()——
 *   yingsx 一类 `li` 含「标题a + 章节a」时只取首个，不再把两条 URL/文本 `\n` 拼坏）。
 * `multi=true`（仅正文 `ruleContent.content`，由门面 opt-in）：多节点按 MULTI_JOIN 拼接
 *   （多段落容器 `@p@text` 靠此拼成整章，40/174 源依赖，不能改）。
 */
export function applyTerminal(
  $: CheerioAPI,
  nodes: CheerioNodes,
  terminal: TerminalOp,
  pageUrl: string,
  multi = false,
): string {
  const values: string[] = [];
  let first: string | null = null;
  nodes.each((_index, node) => {
    if (!multi && first !== null) return;
    const value = terminalValue($, node, terminal, pageUrl);
    if (value === null) return;
    if (multi) values.push(value);
    else if (first === null) first = value;
  });
  return multi ? values.join(MULTI_JOIN) : (first ?? '');
}

function terminalValue(
  $: CheerioAPI,
  node: HtmlNode,
  terminal: TerminalOp,
  pageUrl: string,
): string | null {
  if (terminal.op === 'attr') return attrValue($, node, terminal.name);
  if (URL_OPS.has(terminal.op)) {
    const raw = attrValue($, node, terminal.op);
    return raw === null ? null : absolutizeUrl(raw, pageUrl);
  }
  const attrName = OP_ATTRS[terminal.op];
  if (attrName !== undefined) return attrValue($, node, attrName);
  switch (terminal.op) {
    case 'text':
      // textContent（含子孙文本）。legado AnalyzeByDefault 的 `@text` 即 jsoup `element.text()`。
      return $(node).text();
    case 'ownText':
      return ownTextOf(node);
    case 'textNodes':
      return textNodesOf(node);
    case 'html':
      return $(node).html() ?? '';
    case 'all':
      return $.html(node) ?? '';
    default:
      return evalFailed(`不支持的末端操作 @${terminal.op}`);
  }
}

function attrValue($: CheerioAPI, node: HtmlNode, name: string): string | null {
  const raw = $(node).attr(name);
  return raw === undefined ? null : raw;
}

// ---------------------------------------------------------------- CSS 链求值（§3.2 四步）
/**
 * 求值一条 CSS 选择器链。
 * - 无 terminal → 返回节点集（bookList/chapterList 等列表字段用）；
 * - 有 terminal → 返回字符串。
 * 任何选择器错误 → RuleEngineError('RULE_EVAL_FAILED')（§3.4 字段层决定降级还是 miss）。
 */
export function evaluateCssChain(
  $: CheerioAPI,
  scope: CheerioNodes,
  chain: CssStep[],
  terminal: TerminalOp | undefined,
  pageUrl: string,
  multi = false,
): CheerioNodes | string {
  let nodes = scope;
  for (const step of chain) {
    nodes = runStep($, nodes, step);
    if (nodes.length === 0) return terminal ? '' : nodes;
  }
  return terminal ? applyTerminal($, nodes, terminal, pageUrl, multi) : nodes;
}

/**
 * 单段求值（§3.2 四步）：
 * 1) `scope.find(selector)`（首段的 scope 是 document 级）；
 * 2) `text.` 关键字的 ownText 复核（剔除「文本在子孙而非自身」的假命中）；
 * 3) excludes（负数从尾）→ index（负数从尾）→ slice。
 */
export function runStep($: CheerioAPI, scope: CheerioNodes, step: CssStep): CheerioNodes {
  let nodes: CheerioNodes;
  try {
    nodes = scope.find(step.selector);
  } catch {
    return evalFailed(`选择器无法求值：${step.selector}`, step.selector);
  }
  if (step.ownTextContains !== undefined) {
    const keyword = step.ownTextContains;
    nodes = nodes.filter((_index, node) => ownTextOf(node).includes(keyword));
  }
  let list = nodes.toArray();
  if (step.excludes !== undefined && step.excludes.length > 0) {
    const drop = new Set(step.excludes.map((raw) => (raw < 0 ? list.length + raw : raw)));
    list = list.filter((_node, index) => !drop.has(index));
  }
  if (step.index !== undefined) {
    const index = step.index < 0 ? list.length + step.index : step.index;
    list = index >= 0 && index < list.length ? [list[index]] : [];
  } else if (step.slice !== undefined) {
    const [start, end] = step.slice;
    const norm = (value: number) => (value < 0 ? Math.max(list.length + value, 0) : Math.min(value, list.length));
    list = list.slice(norm(start), norm(end));
  }
  return $(list);
}
