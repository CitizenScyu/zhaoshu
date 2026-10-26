// vars1027：legado @put/@get 变量存取的静态子集（ENGINE_SYNTAX_VARS，默认关）。编译前对源规则做一次改写，
// parseFieldRule 本身不变（改写后仍残留 @put/@get 的照旧 unsupported_var_put/get）。
// legado 口径（AnalyzeRule）：putPattern = `@put:(\{[^}]+?\})`（忽略大小写）从规则里摘出、按 GSON 宽松解析成
// 键→规则，**对当前内容**逐条求值存入变量；摘掉后的剩余部分才是字段规则——所以剥 @put 对字段自身的值是精确的。
// `@get:{k}` 读变量；get() 先认内置键 bookName/title，其后才是 put 进来的值。
// 子集（10-27 离线统计 5371 源，@get/@put 拒 76 源 / 48 host 中占大头的写法）：
//   ruleBookInfo.init 只由 @put:{...} 组成时，同组字段整条恰为 `@get:{k}` 的，就地换成 put 里 k 的规则——
//   put 与 get 都在详情页这一页上求值，内联与 legado 同值。跨阶段（搜索页 put、目录/正文 get）要运行时变量袋，
//   不在子集内，残留 @get 照旧拒。

const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleContent', 'ruleToc', 'ruleExplore'] as const;
const PUT_RE = /@put:\{[^}]+?\}/gi;
const GET_WHOLE_RE = /^@get:\{([^}]+?)\}$/i;
/** legado get() 先返回书名/章节名，put 同名键读不到——不内联。 */
const RESERVED_GET_KEYS = new Set(['bookName', 'title']);

/** 规则文本是否涉及变量存取（语义版本判定用，宁宽勿漏）。 */
export function ruleMayUseVars(rule: string): boolean {
  return /@(?:put|get):/i.test(rule);
}

// GSON 宽松模式裸串的终止符（JsonReader.isLiteral）。
const LITERAL_STOP = /[\s/\\;#={}[\]:,]/;

/**
 * 解析 `{k:'rule', "k2":"rule2", k3:$.id}`（GSON lenient 子集：键/值可单双引号或裸串，逗号分隔）。
 * 任何不认识的形态返回 null——调用方不内联，残留 @get 照旧拒。
 */
export function parsePutMap(text: string): Map<string, string> | null {
  let i = 0;
  const skip = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const token = (): string | null => {
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let out = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] !== '\\') { out += text[i]; i += 1; continue; }
        const c = text[i + 1];
        i += 2;
        if (c === undefined) return null;
        if (c === 'u') {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c;
        }
      }
      if (text[i] !== quote) return null;
      i += 1;
      return out;
    }
    const start = i;
    while (i < text.length && !LITERAL_STOP.test(text[i])) i += 1;
    return i > start ? text.slice(start, i) : null;
  };
  const map = new Map<string, string>();
  skip();
  if (text[i] !== '{') return null;
  i += 1;
  skip();
  if (text[i] === '}') i += 1;
  else {
    for (;;) {
      const key = token();
      skip();
      if (key === null || text[i] !== ':') return null;
      i += 1;
      skip();
      const value = token();
      if (value === null) return null;
      map.set(key, value);
      skip();
      if (text[i] === ',') { i += 1; skip(); continue; }
      if (text[i] === '}') { i += 1; break; }
      return null;
    }
  }
  skip();
  return i === text.length ? map : null;
}

/** ruleBookInfo.init 只由 @put:{...} 组成时合并出 put 表（后者覆盖前者，同 legado 依次 put）；否则 undefined。 */
function initPutMap(init: unknown): Map<string, string> | undefined {
  if (typeof init !== 'string' || init.replace(PUT_RE, '').trim() !== '') return undefined;
  const merged = new Map<string, string>();
  for (const match of init.matchAll(PUT_RE)) {
    const map = parsePutMap(match[0].slice('@put:'.length));
    if (!map) return undefined;
    for (const [key, value] of map) merged.set(key, value);
  }
  return merged.size > 0 ? merged : undefined;
}

/**
 * 源规则改写（开关 on 时编译前调用）：各组字段剥 @put；ruleBookInfo 内整条 `@get:{k}` 按 init 的 put 表内联。
 * 不涉及变量的源原样返回（同一对象），涉及的返回浅拷贝，不改入参。
 */
export function resolveSourceVars<T extends object>(rules: T): T {
  const source = rules as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const group of RULE_GROUPS) {
    const fields = source[group];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    const entries = Object.entries(fields as Record<string, unknown>);
    if (!entries.some(([, rule]) => typeof rule === 'string' && ruleMayUseVars(rule))) continue;
    const puts = group === 'ruleBookInfo' ? initPutMap((fields as Record<string, unknown>).init) : undefined;
    const next: Record<string, unknown> = {};
    for (const [name, rule] of entries) {
      if (typeof rule !== 'string' || !ruleMayUseVars(rule)) { next[name] = rule; continue; }
      let value = rule.replace(PUT_RE, '');
      const get = name === 'init' ? null : GET_WHOLE_RE.exec(value.trim());
      const key = get?.[1].trim();
      if (key !== undefined && !RESERVED_GET_KEYS.has(key) && puts?.has(key)) value = puts.get(key)!;
      next[name] = value;
    }
    out ??= { ...source };
    out[group] = next;
  }
  return (out ?? rules) as T;
}
