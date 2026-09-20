// JSONPath 子集：自写解析 + 求值，不引库（§1 决策：jsonpath-plus 的 filter 走 JS 求值，
// 违反「不执行 JS」红线）。支持构件（设计 §2.2，M1-113 集核心字段口径）：
//   $.a.b   ['a']   ..b   [*] / .*   [n] / [n,m]   [a:b]   [?(@.x == y)]
// $ 后跟非上述语法 → RULE_UNSUPPORTED（编译期拒绝，不猜测）。

import {
  JsonPathIr,
  JsonPathSegment,
  RuleEngineError,
} from './types';

type Json = unknown;

// ---------------------------------------------------------------- 解析
const IDENT = /[^.\[\]]+/y; // 一段裸标识（child），到 . 或 [ 为止

/** 解析 JSONPath 字符串为 IR。非子集语法 → RULE_UNSUPPORTED。 */
export function parseJsonPath(input: string): JsonPathIr {
  const raw = input.trim();
  if (!raw.startsWith('$')) {
    throw new RuleEngineError('RULE_UNSUPPORTED', 'JSONPath 必须以 $ 开头', input, { code: 'unsupported_jsonpath' });
  }
  const segments: JsonPathSegment[] = [{ kind: 'root' }];
  let i = 1;
  const n = raw.length;

  const fail = (msg: string): never => {
    throw new RuleEngineError('RULE_UNSUPPORTED', `JSONPath 不支持的语法：${msg}`, input, { code: 'unsupported_jsonpath' });
  };

  while (i < n) {
    const ch = raw[i];
    if (ch === '.') {
      // .. 递归 或 . 子级 或 .*
      if (raw[i + 1] === '.') {
        i += 2;
        if (raw[i] === '*') {
          // 递归通配 `$..*` 不在 M1 子集：语义应为「所有层级的所有值」，与 `$.*`（仅一层）不同。
          // 不静默塌缩为 $.*（那会悄悄改语义），显式拒绝（对齐 `$..[*]` 的「递归后缺字段名」）。
          fail('递归通配 `$..*` 不在 M1 子集（递归 .. 后需字段名）');
        }
        const name = readIdent(raw, i);
        if (name === null) fail('递归 .. 后缺少字段名');
        segments.push({ kind: 'recursive', name: name as string });
        i += (name as string).length;
        continue;
      }
      i += 1;
      if (raw[i] === '*') {
        segments.push({ kind: 'wildcard' });
        i += 1;
        continue;
      }
      const name = readIdent(raw, i);
      if (name === null) fail('. 后缺少字段名');
      segments.push({ kind: 'child', name: name as string });
      i += (name as string).length;
      continue;
    }
    if (ch === '[') {
      const close = raw.indexOf(']', i);
      if (close < 0) fail('未闭合的 [');
      const inner = raw.slice(i + 1, close).trim();
      segments.push(parseBracket(inner, fail));
      i = close + 1;
      continue;
    }
    fail(`未识别的字符 '${ch}'`);
  }
  return { segments };
}

function readIdent(raw: string, at: number): string | null {
  IDENT.lastIndex = at;
  const m = IDENT.exec(raw);
  return m && m.index === at ? m[0] : null;
}

function parseBracket(inner: string, fail: (m: string) => never): JsonPathSegment {
  if (inner === '*') return { kind: 'wildcard' };

  // 引号包裹的字段名：['name'] / ["name"]
  const quoted = /^(['"])(.*)\1$/.exec(inner);
  if (quoted) return { kind: 'child', name: quoted[2] };

  // 过滤器 [?(@.x == y)]
  if (inner.startsWith('?')) {
    const m = /^\?\(\s*@\.([^\s=]+)\s*==\s*(.+?)\s*\)$/.exec(inner);
    if (!m) fail(`过滤器只支持 ?(@.field == value)：${inner}`);
    return { kind: 'filterEq', name: m![1], value: parseLiteral(m![2]) };
  }

  // 切片 [a:b] / [:b] / [a:]
  if (inner.includes(':')) {
    const parts = inner.split(':');
    if (parts.length !== 2) fail(`切片只支持 [a:b]：${inner}`);
    const start = parts[0].trim() === '' ? undefined : toInt(parts[0], fail);
    const end = parts[1].trim() === '' ? undefined : toInt(parts[1], fail);
    return { kind: 'slice', start, end };
  }

  // 下标列表 [n,m]
  if (inner.includes(',')) {
    const indexes = inner.split(',').map((p) => toInt(p, fail));
    return { kind: 'indexList', indexes };
  }

  // 单下标 [n]
  return { kind: 'index', index: toInt(inner, fail) };
}

function toInt(s: string, fail: (m: string) => never): number {
  const t = s.trim();
  if (!/^-?\d+$/.test(t)) fail(`期望整数下标：${s}`);
  return Number.parseInt(t, 10);
}

function parseLiteral(s: string): string | number | boolean {
  const t = s.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (t === s.trim()) {
    // 未去引号：可能是数字/布尔
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  }
  return t;
}

// ---------------------------------------------------------------- 求值
/** 对 JSON 输入求值，返回命中值列表（可能为空）。求值不抛业务错，越界/缺字段=空。 */
export function evalJsonPath(ir: JsonPathIr, root: Json): Json[] {
  let current: Json[] = [root];
  for (const seg of ir.segments) {
    if (seg.kind === 'root') continue;
    const next: Json[] = [];
    for (const node of current) {
      applySegment(seg, node, next);
    }
    current = next;
  }
  return current;
}

function applySegment(seg: JsonPathSegment, node: Json, out: Json[]): void {
  switch (seg.kind) {
    case 'root':
      return;
    case 'child': {
      const v = childValue(node, seg.name);
      if (v !== undefined) out.push(v);
      return;
    }
    case 'recursive': {
      collectRecursive(node, seg.name, out);
      return;
    }
    case 'wildcard': {
      if (Array.isArray(node)) out.push(...node);
      else if (isObject(node)) out.push(...Object.values(node));
      return;
    }
    case 'index': {
      if (Array.isArray(node)) {
        const idx = seg.index < 0 ? node.length + seg.index : seg.index;
        if (idx >= 0 && idx < node.length) out.push(node[idx]);
      }
      return;
    }
    case 'indexList': {
      if (Array.isArray(node)) {
        for (const raw of seg.indexes) {
          const idx = raw < 0 ? node.length + raw : raw;
          if (idx >= 0 && idx < node.length) out.push(node[idx]);
        }
      }
      return;
    }
    case 'slice': {
      if (Array.isArray(node)) {
        const len = node.length;
        const norm = (x: number | undefined, dflt: number): number => {
          if (x === undefined) return dflt;
          return x < 0 ? Math.max(len + x, 0) : Math.min(x, len);
        };
        const start = norm(seg.start, 0);
        const end = norm(seg.end, len);
        for (let k = start; k < end; k++) out.push(node[k]);
      }
      return;
    }
    case 'filterEq': {
      const items = Array.isArray(node) ? node : isObject(node) ? Object.values(node) : [];
      for (const item of items) {
        const field = childValue(item, seg.name);
        if (looseEq(field, seg.value)) out.push(item);
      }
      return;
    }
  }
}

function childValue(node: Json, name: string): Json {
  if (isObject(node) && Object.prototype.hasOwnProperty.call(node, name)) {
    return (node as Record<string, Json>)[name];
  }
  return undefined;
}

function collectRecursive(node: Json, name: string, out: Json[]): void {
  if (Array.isArray(node)) {
    for (const el of node) collectRecursive(el, name, out);
  } else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === name) out.push(v);
      collectRecursive(v, name, out);
    }
  }
}

function looseEq(a: Json, b: string | number | boolean): boolean {
  if (typeof a === typeof b) return a === b;
  // 跨类型宽松比较：JSON 数字/字符串常混用
  return String(a) === String(b);
}

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
