// jslib1028（ENGINE_SYNTAX_JS_LIB）：legado 书源 jsLib（公共函数库）的编译期判定。legado SharedJsScope 先在共享作用域里
// 求值 jsLib，封存后作为每次规则 JS 作用域的原型：规则读得到库里的顶层名字，库函数的自由变量只在共享作用域与内建里找
// （读不到规则作用域的 result/java/book…），库求值抛错则该源全部 JS 失败。这里只放行能静态说清的库：
// - 代码形（JSON 形的库名 → 远程 URL 要联网取，不复现）；顶层只有函数声明、`var` 声明与裸赋值，初值只是字面量或函数，
//   求值不调用任何东西、不改内建；顶层名不与沙箱注入的全局/内建同名（否则在沙箱里会盖掉宿主绑定）。
// - `pure`：库函数体里的标识符只落在库里声明过的名字与安全内建上，不碰宿主绑定/this/eval，不给顶层名赋值、不改内建，
//   顶层初值没有数组/对象（legado 共享作用域跨求值缓存，可变对象的修改会留下来，沙箱每次重建，不复现）。
// 字段侧（jsLibRuleProblem）：规则不跑 JS（无 JS 段、无 `{{}}`）时与库无关；没提库的顶层名时库只是被求值一次（与 legado 同，
// 求值失败同样致命）；提到了则须库 pure、不给顶层名与内建赋值/重新声明（legado 共享作用域封存，赋值抛错；沙箱里会改到库函数
// 看到的全局）。库函数内部的名字（参数、局部变量）两边都看不见，规则里同名的词不算引用。
// 运行时沙箱在 prelude 之后、规则代码之前求值库原文（js-sandbox.ts JsBindings.jsLib）。

/** 编译期认定可复现的 jsLib。 */
export interface JsLib {
  /** 库原文（运行时原样求值）。 */
  readonly code: string;
  /** 顶层声明的名字（函数声明、var、裸赋值）。 */
  readonly topNames: ReadonlySet<string>;
  /** 库里任何位置声明的名字（含顶层、函数参数、局部 var/let/const、函数名、catch 参数；pure 判定用）。 */
  readonly allNames: ReadonlySet<string>;
  /** 库函数纯（口径见文件头）：规则提到库名字的字段只在 pure 时放行。 */
  readonly pure: boolean;
  /** 不 pure 的首个原因（诊断用；pure 时 undefined）。 */
  readonly impureReason?: string;
}

/** 库原文长度上限：超出不分析（整源照旧按带 jsLib 处理）。 */
const MAX_JS_LIB_CHARS = 64 * 1024;

const KEYWORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
  'new', 'return', 'switch', 'throw', 'try', 'typeof', 'var', 'let', 'const', 'void', 'while', 'true', 'false', 'null', 'of',
]);

/** Rhino 与 QuickJS 口径一致、库函数可以直接读的内建（只读；赋值/改成员另判）。 */
const SAFE_GLOBALS: ReadonlySet<string> = new Set([
  'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'RegExp', 'Date', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape',
  'unescape', 'undefined', 'NaN', 'Infinity', 'arguments',
]);

/**
 * 不许库声明的名字：沙箱注入的全局（js-sandbox.ts installGlobals 与搜索模板 globals）、legado 规则作用域绑定、Rhino 顶层的
 * Java 桥、QuickJS 其余内建。库在沙箱里先于规则求值，同名声明会盖掉它们；库函数读到这些名字在两边语义不同。
 */
const RESERVED: ReadonlySet<string> = new Set([
  'result', 'src', 'baseUrl', 'java', 'book', 'chapter', 'title', 'source', 'cookie', 'cache', 'key', 'page', 'searchKey', 'searchPage',
  'nextChapterUrl', 'rssArticle', 'speakText', 'speakSpeed', 'url', 'jsoup', 'Packages', 'JavaImporter', 'JavaAdapter', 'importPackage',
  'importClass', 'javax', 'org', 'com', 'android', 'edu', 'net', 'getClass', 'print', 'load', 'eval', 'Function', 'globalThis', 'this',
  'Proxy', 'Reflect', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'BigInt', 'console', 'ArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray',
  'XML', 'XMLList', 'Namespace', 'QName', 'uneval', 'Iterator', 'StopIteration', 'Continuation', 'queueMicrotask', 'EvalError',
  'ReferenceError', 'URIError', 'AggregateError', 'Atomics', 'SharedArrayBuffer', 'WeakRef', 'FinalizationRegistry',
  ...KEYWORDS, ...SAFE_GLOBALS,
]);

/** 成员名里出现即不 pure：能改内建或摸到 Function 构造器。 */
const BANNED_MEMBERS: ReadonlySet<string> = new Set([
  'prototype', '__proto__', 'constructor', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'assign', 'freeze', 'seal',
  'preventExtensions', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

/** 库里出现即整库不分析的语法：Rhino 与 QuickJS 支持度不一，或是模板字面量（`${}` 里是代码，不切）。 */
const UNSUPPORTED_IDS: ReadonlySet<string> = new Set(['class', 'async', 'await', 'import', 'export', 'yield', 'with', 'debugger', 'super']);
const UNSUPPORTED_PUNCT: ReadonlySet<string> = new Set(['=>', '...', '??', '?.', '**', '**=', '??=', '||=', '&&=']);

const ASSIGN_OPS: ReadonlySet<string> = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

type TokenKind = 'id' | 'num' | 'lit' | 'p';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  /** 与上一个记号之间有换行（ASI 判语句结束）。 */
  readonly nl: boolean;
}

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '??=', '||=', '&&=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
];

/** 正则字面量前一个记号若是这些标点（或在开头），`/` 是正则开头而非除号（同 parse.ts stripJsLiterals 的启发式）。 */
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%<>~^';

/** 切记号；字符串/正则字面量记作 lit。未闭合、模板字面量、不认识的字符返回 null。 */
function tokenize(code: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let nl = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
      nl = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      i = end < 0 ? code.length : end;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return null;
      if (/[\n\r\u2028\u2029]/.test(code.slice(i, end))) nl = true;
      i = end + 2;
      continue;
    }
    if (ch === '`') return null;
    const prev = tokens.at(-1);
    const regexStart = ch === '/' && (prev === undefined || (prev.kind === 'p' && REGEX_PRECEDERS.includes(prev.value.at(-1)!))
      || (prev.kind === 'id' && (prev.value === 'return' || prev.value === 'typeof')));
    if (ch === "'" || ch === '"' || regexStart) {
      let j = i + 1;
      let inClass = false;
      for (; j < code.length; j += 1) {
        const c = code[j];
        if (c === '\\') {
          j += 1;
          continue;
        }
        if (c === '\n' || c === '\r') return null;
        if (ch !== '/') {
          if (c === ch) break;
        } else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      if (j >= code.length) return null;
      i = j + 1;
      if (regexStart) while (i < code.length && /[a-z]/i.test(code[i])) i += 1;
      tokens.push({ kind: 'lit', value: '', nl });
      nl = false;
      continue;
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(code.slice(i, i + 64));
    if (num && /[\d.]/.test(ch) && (ch !== '.' || /\d/.test(code[i + 1] ?? ''))) {
      if (/[\w$]/.test(code[i + num[0].length] ?? '')) return null;
      tokens.push({ kind: 'num', value: num[0], nl });
      nl = false;
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 256));
    if (id) {
      tokens.push({ kind: 'id', value: id[0], nl });
      nl = false;
      i += id[0].length;
      continue;
    }
    let punct = PUNCTUATORS.find((p) => code.startsWith(p, i));
    // `a?.5:b` 是三目加小数，不是可选链
    if (punct === '?.' && /\d/.test(code[i + 2] ?? '')) punct = undefined;
    if (punct === undefined) {
      if (!'{}()[];,<>+-*/%&|^!~?:=.'.includes(ch)) return null;
      punct = ch;
    }
    tokens.push({ kind: 'p', value: punct, nl });
    nl = false;
    i += punct.length;
  }
  return tokens;
}

const isP = (token: Token | undefined, value: string): boolean => token?.kind === 'p' && token.value === value;
const isId = (token: Token | undefined): token is Token => token?.kind === 'id' && !KEYWORDS.has(token.value);

/** 从开括号下标找配对的闭括号下标；不配对返回 -1。 */
function matchBracket(tokens: readonly Token[], open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.kind !== 'p') continue;
    if (t.value in pairs) stack.push(pairs[t.value]);
    else if (t.value === ')' || t.value === ']' || t.value === '}') {
      if (stack.pop() !== t.value) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** 顶层结构解析的结果：顶层名、各函数（参数与函数体的记号区间）、是否有数组/对象初值。 */
interface TopLevel {
  topNames: Set<string>;
  bodies: { params: string[]; name?: string; start: number; end: number }[];
  mutableInit: boolean;
}

/** 解析顶层：只认函数声明、`var` 声明、裸赋值，初值只认字面量/函数/数组/对象。不合返回 null。 */
function parseTopLevel(tokens: readonly Token[]): TopLevel | null {
  const out: TopLevel = { topNames: new Set(), bodies: [], mutableInit: false };
  let i = 0;
  // 函数：tokens[i] 是 `function`；named = 必须带名字（声明）。返回函数体闭括号后的下标。
  const parseFunction = (named: boolean): number | null => {
    i += 1;
    let name: string | undefined;
    if (isId(tokens[i])) name = tokens[i++].value;
    else if (named) return null;
    if (!isP(tokens[i], '(')) return null;
    const close = matchBracket(tokens, i);
    if (close < 0) return null;
    const params: string[] = [];
    for (let k = i + 1; k < close; k += 1) {
      const t = tokens[k];
      if (isId(t) && (k === i + 1 || isP(tokens[k - 1], ',')) && (k + 1 === close || isP(tokens[k + 1], ','))) params.push(t.value);
      else if (!isP(t, ',')) return null; // 默认值/解构参数不认
    }
    i = close + 1;
    if (!isP(tokens[i], '{')) return null;
    const end = matchBracket(tokens, i);
    if (end < 0) return null;
    out.bodies.push({ params, name, start: i + 1, end });
    if (named && name !== undefined) out.topNames.add(name);
    i = end + 1;
    return i;
  };
  const parseInit = (): boolean => {
    const t = tokens[i];
    if (t === undefined) return false;
    if (t.kind === 'lit' || t.kind === 'num') {
      i += 1;
      return true;
    }
    if ((isP(t, '-') || isP(t, '+')) && tokens[i + 1]?.kind === 'num') {
      i += 2;
      return true;
    }
    if (t.kind === 'id' && ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(t.value)) {
      i += 1;
      return true;
    }
    if (t.kind === 'id' && t.value === 'function') return parseFunction(false) !== null;
    if (isP(t, '[')) {
      out.mutableInit = true;
      i += 1;
      while (!isP(tokens[i], ']')) {
        if (isP(tokens[i], ',')) {
          i += 1;
          continue;
        }
        if (!parseInit()) return false;
        if (!isP(tokens[i], ',') && !isP(tokens[i], ']')) return false;
      }
      i += 1;
      return true;
    }
    if (isP(t, '{')) {
      out.mutableInit = true;
      i += 1;
      while (!isP(tokens[i], '}')) {
        const k = tokens[i];
        if (!(k?.kind === 'id' || k?.kind === 'lit' || k?.kind === 'num') || !isP(tokens[i + 1], ':')) return false;
        i += 2;
        if (!parseInit()) return false;
        if (isP(tokens[i], ',')) i += 1;
        else if (!isP(tokens[i], '}')) return false;
      }
      i += 1;
      return true;
    }
    return false;
  };
  // 语句结束：`;`、换行（ASI）或结尾。
  const endStatement = (): boolean => {
    if (isP(tokens[i], ';')) {
      i += 1;
      return true;
    }
    return i >= tokens.length || tokens[i].nl;
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (isP(t, ';')) {
      i += 1;
      continue;
    }
    if (t.kind === 'id' && t.value === 'function') {
      if (parseFunction(true) === null) return null;
      continue;
    }
    if (t.kind === 'id' && t.value === 'var') {
      i += 1;
      for (;;) {
        const name = tokens[i];
        if (!isId(name)) return null;
        out.topNames.add(name.value);
        i += 1;
        if (isP(tokens[i], '=')) {
          i += 1;
          if (!parseInit()) return null;
        }
        if (!isP(tokens[i], ',')) break;
        i += 1;
      }
      if (!endStatement()) return null;
      continue;
    }
    if (isId(t) && isP(tokens[i + 1], '=')) {
      out.topNames.add(t.value);
      i += 2;
      if (!parseInit() || !endStatement()) return null;
      continue;
    }
    return null;
  }
  return out;
}

/** 函数体里声明的名字：var/let/const 列表（逗号续接、换行或分号结束）、函数名与参数、catch 参数。宁少勿多；认不了的形态返回原因。 */
function collectDeclared(tokens: readonly Token[], start: number, end: number, into: Set<string>): string | undefined {
  for (let i = start; i < end; i += 1) {
    const t = tokens[i];
    if (t.kind !== 'id') continue;
    if (t.value === 'var' || t.value === 'let' || t.value === 'const') {
      let depth = 0;
      let expectName = true;
      for (let k = i + 1; k < end; k += 1) {
        const u = tokens[k];
        if (expectName) {
          if (!isId(u)) return `声明后跟 ${tokens[k].value}`; // 解构声明不认
          into.add(u.value);
          expectName = false;
          continue;
        }
        if (u.kind === 'p' && '([{'.includes(u.value)) depth += 1;
        else if (u.kind === 'p' && ')]}'.includes(u.value)) {
          depth -= 1;
          if (depth < 0) break;
        } else if (depth === 0 && isP(u, ',')) {
          expectName = true;
          continue;
        } else if (depth === 0 && (isP(u, ';') || (u.kind === 'id' && (u.value === 'in' || u.value === 'of')))) break;
        if (depth === 0 && tokens[k + 1]?.nl && !isP(u, ',')) break;
      }
    } else if (t.value === 'function') {
      let k = i + 1;
      if (isId(tokens[k])) into.add(tokens[k++].value);
      if (!isP(tokens[k], '(')) return `function 后跟 ${tokens[k]?.value ?? '结尾'}`;
      const close = matchBracket(tokens, k);
      if (close < 0) return '括号不配对';
      for (let p = k + 1; p < close; p += 1) {
        if (isId(tokens[p])) into.add(tokens[p].value);
        else if (!isP(tokens[p], ',')) return `参数里有 ${tokens[p].value}`;
      }
    } else if (t.value === 'catch' && isP(tokens[i + 1], '(') && isId(tokens[i + 2]) && isP(tokens[i + 3], ')')) {
      into.add(tokens[i + 2].value);
    }
  }
  return undefined;
}

/** 函数体不 pure 的原因（口径见文件头）；pure 时 undefined。 */
function bodyImpurity(
  tokens: readonly Token[], start: number, end: number, top: ReadonlySet<string>, all: ReadonlySet<string>,
): string | undefined {
  for (let i = start; i < end; i += 1) {
    const t = tokens[i];
    if (t.kind !== 'id') continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (isP(prev, '.')) {
      if (BANNED_MEMBERS.has(t.value)) return `成员 ${t.value}`;
      continue;
    }
    if (t.value === 'delete' || t.value === 'this') return t.value;
    if (KEYWORDS.has(t.value)) continue;
    // 对象字面量的键（`{k: v` / `, k: v`）
    if ((isP(prev, '{') || isP(prev, ',')) && isP(next, ':')) continue;
    if (!all.has(t.value) && !SAFE_GLOBALS.has(t.value)) return `自由变量 ${t.value}`;
    // 给顶层名赋值 / 自增自减
    if (top.has(t.value) && ((next?.kind === 'p' && ASSIGN_OPS.has(next.value)) || isP(next, '++') || isP(next, '--')
      || isP(prev, '++') || isP(prev, '--'))) return `给顶层名 ${t.value} 赋值`;
    // 改内建或顶层对象的成员：根上接 .x / [..] 链后跟赋值或自增自减
    if (SAFE_GLOBALS.has(t.value) || top.has(t.value)) {
      let k = i + 1;
      while (k < end) {
        if (isP(tokens[k], '.') && tokens[k + 1]?.kind === 'id') k += 2;
        else if (isP(tokens[k], '[')) {
          const close = matchBracket(tokens, k);
          if (close < 0) return '括号不配对';
          k = close + 1;
        } else break;
      }
      if (k > i + 1) {
        const after = tokens[k];
        if ((after?.kind === 'p' && ASSIGN_OPS.has(after.value)) || isP(after, '++') || isP(after, '--')) return `改 ${t.value} 的成员`;
      }
    }
  }
  return undefined;
}

const memo = new Map<string, JsLib | null>();

/**
 * jsLib 原文 → 可复现的库（口径见文件头）；不是字符串/空白/JSON 形/超长/语法不认/顶层不只是声明/顶层名撞保留名 → null
 * （调用方照旧按「带 jsLib」整源不开 JS 链）。
 */
export function analyzeJsLib(raw: unknown): JsLib | null {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_JS_LIB_CHARS) return null;
  const hit = memo.get(raw);
  if (hit !== undefined || memo.has(raw)) return hit ?? null;
  const lib = analyze(raw);
  memo.set(raw, lib);
  if (memo.size > 256) memo.delete(memo.keys().next().value!);
  return lib;
}

function analyze(code: string): JsLib | null {
  const trimmed = code.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return null; // legado isJsonObject：JSON 形库要联网
  const tokens = tokenize(code);
  if (tokens === null || tokens.length === 0) return null;
  for (const t of tokens) {
    if (t.kind === 'id' && UNSUPPORTED_IDS.has(t.value)) return null;
    if (t.kind === 'p' && UNSUPPORTED_PUNCT.has(t.value)) return null;
  }
  const top = parseTopLevel(tokens);
  if (top === null || top.topNames.size === 0) return null;
  for (const name of top.topNames) if (RESERVED.has(name) || name.startsWith('__')) return null;
  const all = new Set(top.topNames);
  let impureReason = top.mutableInit ? '顶层初值有数组/对象' : undefined;
  for (const body of top.bodies) {
    // 每个顶层函数单独收局部名（含嵌套函数的，宁宽）：自由变量只能落在顶层名、本函数局部名与安全内建上。局部名与保留名
    // 同名只是遮蔽，两边一样；但有嵌套函数时收集口径分不清作用域（外层可能把它当自由变量读到宿主全局），按不 pure。
    const locals = new Set<string>(body.params);
    if (body.name !== undefined) locals.add(body.name);
    const declared = collectDeclared(tokens, body.start, body.end, locals);
    if (declared !== undefined) impureReason ??= declared;
    for (const name of locals) all.add(name);
    const nested = tokens.slice(body.start, body.end).some((t) => t.kind === 'id' && t.value === 'function');
    const reserved = [...locals].find((name) => RESERVED.has(name) || name.startsWith('__'));
    if (reserved !== undefined && nested) impureReason ??= `嵌套函数里声明了保留名 ${reserved}`;
    if (impureReason !== undefined) continue;
    impureReason = bodyImpurity(tokens, body.start, body.end, top.topNames, new Set([...top.topNames, ...locals]));
  }
  return { code, topNames: top.topNames, allNames: all, pure: impureReason === undefined, impureReason };
}

const RULE_IDENT_RE = /(?<![\w$])[A-Za-z_$][\w$]*/g;
const RULE_ASSIGN_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:=(?!=)|[-+*/%&|^]=|<<=|>>>?=|\+\+|--)/g;
const RULE_PREFIX_RE = /(?:\+\+|--)\s*([A-Za-z_$][\w$]*)/g;
const RULE_DECLARE_RE = /(?<![\w$])(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/g;
const RULE_DYNAMIC: ReadonlySet<string> = new Set(['eval', 'Function', 'globalThis', 'this', 'constructor']);
/** 规则会跑 JS：JS 段（legado JS_PATTERN 大小写不敏感）或 `{{}}` 模板。 */
const RULE_RUNS_JS_RE = /<js\b|@js:|\{\{/i;

/**
 * 字段规则原文能否在带库的沙箱里与 legado 同口径求值；不能时返回原因（拼在「JS 段」之后）。按整段原文扫标识符（字符串、CSS 里的
 * 同名词也算），宁可多拒。
 */
export function jsLibRuleProblem(lib: JsLib, rule: string): string | undefined {
  if (!RULE_RUNS_JS_RE.test(rule)) return undefined;
  const names = new Set<string>();
  for (const match of rule.matchAll(RULE_IDENT_RE)) names.add(match[0]);
  const refs = [...names].filter((name) => lib.topNames.has(name));
  if (refs.length === 0) {
    // 库不 pure 时，动态取名（eval/this/constructor…）可能绕过名字扫描摸到库函数
    if (!lib.pure) for (const name of RULE_DYNAMIC) if (names.has(name)) return `在带 jsLib 的源里用了 ${name}`;
    return undefined;
  }
  if (!lib.pure) return `引用了 jsLib 里的 ${refs[0]}（库函数不可复现）`;
  const guarded = (name: string) => lib.topNames.has(name) || SAFE_GLOBALS.has(name);
  for (const re of [RULE_ASSIGN_RE, RULE_PREFIX_RE, RULE_DECLARE_RE]) {
    for (const match of rule.matchAll(re)) if (guarded(match[1])) return `给 jsLib 顶层名或内建 ${match[1]} 赋值/重新声明`;
  }
  return undefined;
}
