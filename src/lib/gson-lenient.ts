// searchopt1028：Gson 2.11 JsonReader（Strictness.LENIENT）的读取子集 + legado GSON 的 pretty toJson。纯函数（进客户端包）。
// legado AnalyzeUrl 解析 `url,{选项}` 时先 GSONStrict、失败再 GSON（宽松）——两者都失败选项整段忽略；宽松是严格的超集，
// 故这里只实现宽松一种。接受集照 JsonReader.doPeek：键/值可单双引号或裸串、`=`/`=>` 作键值分隔、`;` 作成员分隔、
// `//` `#` `/* */` 注释、数组里多余逗号读作 null、开头 `)]}'\n` 前缀；对象尾逗号、未知转义、未闭合串仍是错。
// 读完一个值后只许剩空白/注释（Gson.assertFullConsumption）。任何不在接受集里的形态返回 null，不猜。

export type GsonValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; raw: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'array'; items: GsonValue[] }
  | { kind: 'object'; entries: Map<string, GsonValue>; duplicate: boolean };

/** Gson 2.11 默认嵌套上限。 */
const MAX_NESTING = 255;
/** JsonReader.isLiteral 的终止符。 */
const LITERAL_STOP = /[/\\;#={}[\]:, \t\f\r\n]/;
/** JsonReader.peekNumber 认的数字（含前导 0 的形态 Gson 读作裸串）。 */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const ESCAPES: Record<string, string> = { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '\n': '\n', "'": "'", '"': '"', '\\': '\\', '/': '/' };

class GsonSyntaxError extends Error {}

function fail(): never {
  throw new GsonSyntaxError();
}

/** 解析一个 Gson 宽松 JSON 文档；不在接受集里返回 null。 */
export function parseGsonLenient(text: string): GsonValue | null {
  let i = 0;
  const skip = (): void => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
      if (c === '#' || (c === '/' && text[i + 1] === '/')) {
        while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) fail();
        i = end + 2;
        continue;
      }
      return;
    }
  };
  const quoted = (quote: string): string => {
    i += 1;
    let out = '';
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i];
      if (c === quote) { i += 1; return out; }
      if (c !== '\\') { out += c; i += 1; continue; }
      const e = text[i + 1];
      i += 2;
      if (e === 'u') {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else if (e !== undefined && Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
        out += ESCAPES[e];
      } else {
        fail();
      }
    }
  };
  const literal = (): string => {
    const start = i;
    while (i < text.length && !LITERAL_STOP.test(text[i])) i += 1;
    if (i === start) fail();
    return text.slice(start, i);
  };
  const keyword = (raw: string): GsonValue => {
    const lower = raw.toLowerCase();
    if (lower === 'true' || lower === 'false') return { kind: 'boolean', value: lower === 'true' };
    if (lower === 'null') return { kind: 'null' };
    if (JSON_NUMBER.test(raw)) return { kind: 'number', raw };
    return { kind: 'string', value: raw };
  };
  const value = (depth: number): GsonValue => {
    const c = text[i];
    if (c === '"' || c === "'") return { kind: 'string', value: quoted(c) };
    if (c === '{' || c === '[') {
      if (depth >= MAX_NESTING) fail();
      i += 1;
      return c === '{' ? object(depth + 1) : array(depth + 1);
    }
    return keyword(literal());
  };
  const array = (depth: number): GsonValue => {
    const items: GsonValue[] = [];
    skip();
    if (text[i] === ']') { i += 1; return { kind: 'array', items }; }
    for (;;) {
      // 宽松模式：值位置上的 `,`/`;`/`]` 读作 null（不吃掉该字符）。
      const c = text[i];
      if (c === ',' || c === ';' || c === ']') items.push({ kind: 'null' });
      else items.push(value(depth));
      skip();
      const sep = text[i];
      if (sep === ']') { i += 1; return { kind: 'array', items }; }
      if (sep !== ',' && sep !== ';') fail();
      i += 1;
      skip();
    }
  };
  const object = (depth: number): GsonValue => {
    const entries = new Map<string, GsonValue>();
    let duplicate = false;
    skip();
    if (text[i] === '}') { i += 1; return { kind: 'object', entries, duplicate }; }
    for (;;) {
      const c = text[i];
      const name = c === '"' || c === "'" ? quoted(c) : literal();
      skip();
      if (text[i] === ':') i += 1;
      else if (text[i] === '=') i += text[i + 1] === '>' ? 2 : 1;
      else fail();
      skip();
      const v = value(depth);
      if (entries.has(name)) duplicate = true;
      entries.set(name, v);
      skip();
      const sep = text[i];
      if (sep === '}') { i += 1; return { kind: 'object', entries, duplicate }; }
      if (sep !== ',' && sep !== ';') fail();
      i += 1;
      skip();
    }
  };
  try {
    skip();
    if (text.startsWith(")]}'\n", i)) i += 5;
    skip();
    if (i >= text.length) return null;
    const result = value(0);
    skip();
    return i === text.length ? result : null;
  } catch (error) {
    if (error instanceof GsonSyntaxError || error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * legado StringJsonDeserializer：基本值取 asString（数字保留原文），null 为 null；对象/数组 legado 取 JSON 文本——
 * 这里只需「非 null」这一事实（调用方对这类值一律按不支持或非 POST 处理），返回其类型标记。
 */
export function gsonAsString(v: GsonValue | undefined): string | null {
  if (v === undefined || v.kind === 'null') return null;
  if (v.kind === 'string') return v.value;
  if (v.kind === 'number') return v.raw;
  if (v.kind === 'boolean') return String(v.value);
  return `\u0000${v.kind}`;
}

/** Long 能精确表示、且 legado 两种数字策略（LONG_OR_DOUBLE / DoubleAsIntFix）都写回原文的整数。 */
export function gsonPlainInteger(v: GsonValue): boolean {
  return v.kind === 'number' && /^-?(?:0|[1-9]\d*)$/.test(v.raw) && Number.isSafeInteger(Number(v.raw));
}

/**
 * legado GSON.toJson（setPrettyPrinting、disableHtmlEscaping、LONG_OR_DOUBLE）的子集：串/布尔/普通整数与其对象、数组。
 * null（Gson 对 Map 里的 null 整项省略）、非整数数字（Double 写法不同）、U+2028/2029 与代理项（转义口径不同）返回 null。
 */
export function gsonPrettyJson(v: GsonValue, indent = ''): string | null {
  switch (v.kind) {
    case 'string':
      return /[\u2028\u2029\uD800-\uDFFF]/.test(v.value) ? null : JSON.stringify(v.value);
    case 'boolean':
      return String(v.value);
    case 'number':
      return gsonPlainInteger(v) ? v.raw : null;
    case 'null':
      return null;
    case 'array': {
      if (v.items.length === 0) return '[]';
      const inner = `${indent}  `;
      const parts: string[] = [];
      for (const item of v.items) {
        const s = gsonPrettyJson(item, inner);
        if (s === null) return null;
        parts.push(`${inner}${s}`);
      }
      return `[\n${parts.join(',\n')}\n${indent}]`;
    }
    case 'object': {
      if (v.entries.size === 0) return '{}';
      const inner = `${indent}  `;
      const parts: string[] = [];
      for (const [k, item] of v.entries) {
        const key = gsonPrettyJson({ kind: 'string', value: k });
        const s = gsonPrettyJson(item, inner);
        if (key === null || s === null) return null;
        parts.push(`${inner}${key}: ${s}`);
      }
      return `{\n${parts.join(',\n')}\n${indent}}`;
    }
  }
}
