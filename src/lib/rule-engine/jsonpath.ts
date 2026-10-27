// JSONPath 子集：自写解析 + 求值，不引库（§1 决策：jsonpath-plus 的 filter 走 JS 求值，
// 违反「不执行 JS」红线）。支持构件（设计 §2.2，M1-113 集核心字段口径）：
//   $.a.b   ['a']   ..b   [*] / .*   [n] / [n,m]   [a:b]   [?(@.x == y)]
//   ..[n] / ..[n,m] / ..[a:b]（Jayway 扫描 + 数组 token，jsoninner41）
// $ 后跟非上述语法 → RULE_UNSUPPORTED（编译期拒绝，不猜测）。
// jsonpath1028（ENGINE_SYNTAX_JSON_PATH，ext=true）：off 态解析不了的路径再试扩展子集——`.[`（Jayway 单点后接方括号
// token）与 `[?(表达式)]`（存在性 / 比较 / && || ! 括号，对齐 Jayway 2.9.0 FilterCompiler + legado SUPPRESS_EXCEPTIONS）。
// off 态能解析的路径 IR 逐字不变。

import {
  JsonPathFilterExpr,
  JsonPathFilterLiteral,
  JsonPathIr,
  JsonPathSegment,
  RuleEngineError,
} from './types';

type Json = unknown;

// ---------------------------------------------------------------- 解析
const IDENT = /[^.\[\]]+/y; // 一段裸标识（child），到 . 或 [ 为止

/**
 * 解析 JSONPath 字符串为 IR。非子集语法 → RULE_UNSUPPORTED。ext（jsonpath1028）只在 off 态失败时生效；
 * 扩展子集也解析不了时抛 off 态的原错误（诊断桶不变）。
 */
export function parseJsonPath(input: string, ext = false): JsonPathIr {
  try {
    return parsePath(input, false);
  } catch (err) {
    if (!ext || !(err instanceof RuleEngineError)) throw err;
    try {
      return parsePath(input, true);
    } catch (extErr) {
      if (extErr instanceof RuleEngineError) throw err;
      throw extErr;
    }
  }
}

function parsePath(input: string, ext: boolean): JsonPathIr {
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
        if (raw[i] === '[') {
          // `..[n]`：Jayway 的扫描 token 后接数组 token（ArrayIndexToken/ArraySliceToken 都继承
          // ArrayPathToken）。ScanPathToken.walkArray 对每个数组（先序、含起点）：数组 token 是末段时
          // 对该数组求下标；不是末段时**跳过下标**，把后续 token 施于该数组的每个元素（json-path 2.10.0
          // ScanPathToken.java:47-70）。`..[*]`/`..['x']`/过滤器不是数组 token，仍拒绝。
          const close = raw.indexOf(']', i);
          if (close < 0) fail('未闭合的 [');
          const bracket = parseBracket(raw.slice(i + 1, close).trim(), fail);
          if (bracket.kind !== 'index' && bracket.kind !== 'indexList' && bracket.kind !== 'slice') {
            fail('递归 .. 后缺少字段名');
          }
          i = close + 1;
          if (i >= n) segments.push({ kind: 'arrayScan', elements: false }, bracket);
          else segments.push({ kind: 'arrayScan', elements: true });
          continue;
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
      // Jayway PathCompiler.readDotToken：单点后读下一个 token，`$.x.[0]` ≡ `$.x[0]`、`$.[*]` ≡ `$[*]`
      if (ext && raw[i] === '[') continue;
      const name = readIdent(raw, i);
      if (name === null) fail('. 后缺少字段名');
      segments.push({ kind: 'child', name: name as string });
      i += (name as string).length;
      continue;
    }
    if (ch === '[') {
      if (ext && raw.startsWith('[?(', i)) {
        const close = matchParen(raw, i + 2);
        if (close < 0 || raw[close + 1] !== ']') fail('过滤器括号不匹配或 ) 后不是 ]');
        segments.push({ kind: 'filter', expr: parseFilterExpr(raw.slice(i + 2, close + 1), fail) });
        i = close + 2;
        continue;
      }
      const close = raw.indexOf(']', i);
      if (close < 0) fail('未闭合的 [');
      const inner = raw.slice(i + 1, close).trim();
      if (ext && inner.startsWith('?')) fail(`过滤器须紧接 [?(：${inner}`);
      segments.push(parseBracket(inner, fail, ext));
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

function parseBracket(inner: string, fail: (m: string) => never, strict = false): JsonPathSegment {
  if (inner === '*') return { kind: 'wildcard' };

  // 引号包裹的字段名：['name'] / ["name"]。strict（jsonpath1028 扩展子集）：含引号/逗号/反斜杠的名字在 Jayway 里是
  // 多属性或转义，拒绝
  const quoted = /^(['"])(.*)\1$/.exec(inner);
  if (quoted && strict && /['",\\]/.test(quoted[2])) fail(`方括号字段名含引号/逗号/反斜杠：${inner}`);
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

// ---------------------------------------------------------------- 过滤器（jsonpath1028）
const MAX_FILTER_LENGTH = 512;
/** 过滤器左值的字段名：ASCII 词字符与 `-`、非 ASCII 字符；其余（运算符/括号/引号/空白/通配等）一律不进名字。 */
const FILTER_NAME = /[A-Za-z0-9_\-\u0080-\uffff]+/y;
const FILTER_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);
/** Java new BigDecimal(String) 接受的形态（ASCII 数字）；Jayway 数字左值对字符串字面量按它比较。 */
const BIG_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** `(` 在 at 处，返回配对 `)` 的下标（跳过引号串，对齐 Jayway indexOfClosingBracket）；不配对 → -1。 */
function matchParen(raw: string, at: number): number {
  let depth = 0;
  for (let k = at; k < raw.length; k++) {
    const c = raw[k];
    if (c === "'" || c === '"') {
      const end = raw.indexOf(c, k + 1);
      if (end < 0) return -1;
      k = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k;
  }
  return -1;
}

/**
 * `(表达式)` → 过滤器 IR。文法对齐 Jayway FilterCompiler（空白只认空格）：OR = AND {`||` AND}；AND = 操作数 {`&&` 操作数}；
 * 操作数 = `!` 操作数（后面不是 @）| `(` OR `)` | 关系式。关系式左值只收 `[!]@.a.b`，右值只收字符串/数字/true/false/null
 * 字面量；正则、JSON 字面量、`$` 路径、词运算符（in/size/contains…）、转义都拒（不猜测）。
 */
function parseFilterExpr(text: string, fail: (m: string) => never): JsonPathFilterExpr {
  if (text.length > MAX_FILTER_LENGTH) fail('过滤器过长');
  if (/[\\/[\]${}\t\n\r]/.test(text)) fail('过滤器含不支持的字符（\\ / [ ] $ { } 或制表/换行）');
  let p = 0;
  const skip = (): void => {
    while (text[p] === ' ') p++;
  };
  const atBoundary = (k: number): boolean => k >= text.length || ' )&|'.includes(text[k]);

  const readOr = (): JsonPathFilterExpr => {
    const items = [readAnd()];
    for (;;) {
      skip();
      if (!text.startsWith('||', p)) break;
      p += 2;
      items.push(readAnd());
    }
    return items.length === 1 ? items[0] : { kind: 'or', items };
  };
  const readAnd = (): JsonPathFilterExpr => {
    const items = [readOperand()];
    for (;;) {
      skip();
      if (!text.startsWith('&&', p)) break;
      p += 2;
      items.push(readOperand());
    }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  };
  const readOperand = (): JsonPathFilterExpr => {
    skip();
    if (text[p] === '!') {
      let q = p + 1;
      while (text[q] === ' ') q++;
      if (text[q] !== '@') {
        p = q;
        return { kind: 'not', item: readOperand() };
      }
    }
    if (text[p] === '(') {
      p++;
      const inner = readOr();
      skip();
      if (text[p] !== ')') fail('过滤器缺少 )');
      p++;
      return inner;
    }
    return readRelational();
  };
  const readRelational = (): JsonPathFilterExpr => {
    let negate = false;
    if (text[p] === '!') {
      negate = true;
      p++;
      skip();
    }
    if (text[p] !== '@') fail('过滤器左值只支持 @.字段');
    p++;
    const path: string[] = [];
    while (text[p] === '.') {
      FILTER_NAME.lastIndex = p + 1;
      const m = FILTER_NAME.exec(text);
      if (!m) fail('过滤器 @. 后缺少字段名');
      path.push(m![0]);
      p += 1 + m![0].length;
    }
    if (path.length === 0) fail('过滤器左值只支持 @.字段');
    if (p < text.length && !' )<>=!~'.includes(text[p])) fail('过滤器字段名后有不支持的字符');
    skip();
    let q = p;
    while (q < text.length && '<>=~!'.includes(text[q])) q++;
    const op = text.slice(p, q);
    if (op === '') {
      // Jayway readRelationalOperator 读不出运算符时退回存在性检查；后面跟的若不是 ) && || 则可能是词运算符，拒
      if (!(p >= text.length || text[p] === ')' || text.startsWith('&&', p) || text.startsWith('||', p))) {
        fail('过滤器不支持词运算符');
      }
      return { kind: 'exists', path, negate };
    }
    // `!@.x == v` 在 Jayway 里 `!` 被静默忽略，不复刻
    if (negate) fail('过滤器 ! 不能与比较运算符连用');
    if (!FILTER_OPS.has(op)) fail(`过滤器不支持的运算符 ${op}`);
    p = q;
    skip();
    return { kind: 'cmp', path, op: op as '==' | '!=' | '<' | '<=' | '>' | '>=', value: readLiteral() };
  };
  const readLiteral = (): JsonPathFilterLiteral => {
    const c = text[p];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, p + 1);
      if (end < 0) fail('过滤器字符串未闭合');
      const value = text.slice(p + 1, end);
      checkStringLiteral(value, fail);
      p = end + 1;
      return { kind: 'string', value };
    }
    for (const [word, lit] of [
      ['true', { kind: 'bool', value: true }],
      ['false', { kind: 'bool', value: false }],
      ['null', { kind: 'null' }],
    ] as const) {
      if (text.startsWith(word, p) && atBoundary(p + word.length)) {
        p += word.length;
        return lit;
      }
    }
    const m = /-?(\d+)(?:\.(\d+))?/y;
    m.lastIndex = p;
    const num = m.exec(text);
    if (!num || !atBoundary(p + num[0].length)) fail('过滤器字面量只支持字符串/整数/小数/true/false/null');
    p += num![0].length;
    return { kind: 'number', value: Number(num![0]), canonical: bigDecimalString(num![0], num![1], num![2] ?? '', fail) };
  };

  const expr = readOperand();
  skip();
  if (p !== text.length) fail('过滤器表达式后有多余字符');
  return expr;
}

/**
 * Java BigDecimal(literal).toString()（Jayway 字符串左值对数字字面量按它比较）：去整数前导零、保留小数尾零、零不带负号；
 * 会切科学计数法的（scale>0 且调整指数 < -6）与超 15 位有效数字的（double 不保精度）拒。
 */
function bigDecimalString(text: string, intPart: string, frac: string, fail: (m: string) => never): string {
  const digits = (intPart + frac).replace(/^0+/, '');
  if (digits.length > 15) fail('过滤器数字超过 15 位有效数字');
  const adjusted = Math.max(digits.length, 1) - 1 - frac.length;
  if (frac.length > 0 && adjusted < -6) fail('过滤器数字在 Jayway 里会转科学计数法');
  const sign = text.startsWith('-') && digits !== '' ? '-' : '';
  const head = intPart.replace(/^0+(?=\d)/, '');
  return frac ? `${sign}${head}.${frac}` : `${sign}${head}`;
}

/** 字符串字面量：非 ASCII 十进制数字（Java BigDecimal 认、JS Number 不认）与超 double 精度/范围的数值串拒。 */
function checkStringLiteral(value: string, fail: (m: string) => never): void {
  if (/(?![0-9])\p{Nd}/u.test(value)) fail('过滤器字符串含非 ASCII 数字');
  const m = BIG_DECIMAL.exec(value);
  if (!m) return;
  const digits = m[1].replace('.', '').replace(/^0+/, '');
  const exp = m[2] ? Number(m[2].slice(1)) : 0;
  if (digits.length > 15 || Math.abs(exp) > 300) fail('过滤器数值字符串超出 double 精度/范围');
}

// ---------------------------------------------------------------- 求值
/**
 * Jayway 的「确定路径」判据（Path.isDefinite）：只含 child 与单下标。递归 `..`、通配 `*`、
 * 多下标、切片、过滤器都会让结果成为「命中列表」。列表字段据此区分：确定路径取到的数组
 * 本身就是列表（`$.Novels`），不确定路径的命中值逐个成为列表项（`$.books[*]`）。
 */
export function isDefinitePath(ir: JsonPathIr): boolean {
  return ir.segments.every((seg) => seg.kind === 'root' || seg.kind === 'child' || seg.kind === 'index');
}

/**
 * 列表字段（bookList/chapterList）在 JSON 输入上的取值，对齐 legado AnalyzeByJSonPath.getList
 * （`ctx.read<ArrayList<Any>>(rule)`）：确定路径命中数组 → 数组元素；命中对象/标量 → 转型失败
 * 返回空列表；不确定路径 → 命中值本身即列表项（不再展平）。
 */
export function evalJsonPathList(ir: JsonPathIr, root: Json): Json[] {
  const values = evalJsonPath(ir, root);
  if (!isDefinitePath(ir)) return values;
  const only = values[0];
  return Array.isArray(only) ? only : [];
}

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
    case 'arrayScan': {
      collectArrays(node, seg.elements, out);
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
    case 'filter': {
      // Jayway PredicatePathToken：对象判它自身，数组逐元素判，标量不产出
      if (Array.isArray(node)) {
        for (const item of node) if (filterAccept(seg.expr, item)) out.push(item);
      } else if (isObject(node) && filterAccept(seg.expr, node)) {
        out.push(node);
      }
      return;
    }
  }
}

function filterAccept(expr: JsonPathFilterExpr, item: Json): boolean {
  switch (expr.kind) {
    case 'exists': {
      // Jayway 存在性检查用 REQUIRE_PROPERTIES：每一步都得是对象且有自有属性（叶子为 null 也算存在）
      let cur = item;
      let ok = true;
      for (const name of expr.path) {
        if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, name)) {
          ok = false;
          break;
        }
        cur = cur[name];
      }
      return expr.negate ? !ok : ok;
    }
    case 'cmp':
      return filterCompare(filterLeft(item, expr.path), expr.op, expr.value);
    case 'and':
      return expr.items.every((e) => filterAccept(e, item));
    case 'or':
      return expr.items.some((e) => filterAccept(e, item));
    case 'not':
      return !filterAccept(expr.item, item);
  }
}

/** 比较左值：legado 带 SUPPRESS_EXCEPTIONS，缺字段/中间不是对象都读成 null。 */
function filterLeft(item: Json, path: string[]): Json {
  let cur = item;
  for (const name of path) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, name)) return null;
    cur = cur[name];
  }
  return cur;
}

/**
 * Jayway EvaluatorFactory 的六个比较（左值 ValueNode 的 equals / compareTo 口径）：数字对数字比数值、数字对字符串按
 * BigDecimal 解析该串、字符串对数字比 BigDecimal.toString()；null 只等于 null；布尔只等于布尔；对象/数组不等于任何字面量。
 * 大小比较只在数字对数字、字符串对字符串（UTF-16 码元序）之间成立，其余为假。
 */
function filterCompare(left: Json, op: '==' | '!=' | '<' | '<=' | '>' | '>=', lit: JsonPathFilterLiteral): boolean {
  if (op === '==' || op === '!=') {
    let eq: boolean;
    if (left === null) eq = lit.kind === 'null';
    else if (typeof left === 'number') {
      eq = lit.kind === 'number' ? left === lit.value : lit.kind === 'string' && BIG_DECIMAL.test(lit.value) && Number(lit.value) === left;
    } else if (typeof left === 'string') {
      eq = lit.kind === 'string' ? left === lit.value : lit.kind === 'number' && left === lit.canonical;
    } else if (typeof left === 'boolean') eq = lit.kind === 'bool' && left === lit.value;
    else eq = false;
    return op === '==' ? eq : !eq;
  }
  let a: number | string;
  let b: number | string;
  if (typeof left === 'number' && lit.kind === 'number') [a, b] = [left, lit.value];
  else if (typeof left === 'string' && lit.kind === 'string') [a, b] = [left, lit.value];
  else return false;
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
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

/** Jayway ScanPathToken.walk 的先序：数组先产出自身（或全部元素）再下探元素，对象按属性序下探。 */
function collectArrays(node: Json, elements: boolean, out: Json[]): void {
  if (Array.isArray(node)) {
    if (elements) out.push(...node);
    else out.push(node);
    for (const el of node) collectArrays(el, elements, out);
  } else if (isObject(node)) {
    for (const v of Object.values(node)) collectArrays(v, elements, out);
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
