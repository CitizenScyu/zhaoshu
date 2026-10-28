// vars1027：legado @put/@get 变量存取的静态子集（ENGINE_SYNTAX_VARS，默认关）。编译前对源规则做一次改写，
// parseFieldRule 本身不变（改写后仍残留 @put/@get 的照旧 unsupported_var_put/get）。
// legado 口径（AnalyzeRule）：putPattern = `@put:(\{[^}]+?\})`（忽略大小写）从规则里摘出、按 GSON 宽松解析成
// 键→规则，**对当前内容**逐条求值存入变量；摘掉后的剩余部分才是字段规则——所以剥 @put 对字段自身的值是精确的。
// `@get:{k}` 读变量；get() 先认内置键 bookName/title，其后才是 put 进来的值。
// 子集（10-27 离线统计 5371 源，@get/@put 拒 76 源 / 48 host 中占大头的写法）：
//   ruleBookInfo.init 只由 @put:{...} 组成时，同组字段整条恰为 `@get:{k}` 的，就地换成 put 里 k 的规则——
//   put 与 get 都在详情页这一页上求值，内联与 legado 同值。vars2-1027 起推广到同组按求值顺序推演（搜索条目内
//   前字段 put → 后字段 get；`@get:{k}##正则` 后缀）。跨阶段（搜索页 put、目录/正文 get）要运行时变量袋，
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

/**
 * legado 对单本书逐字段求值的顺序（BookList.getSearchItem / BookInfo.analyzeBookInfo，取证快照 Jer-Chao@c2c4775）。
 * 同一条目/同一页上，前面字段的 @put 对后面字段的 @get 可见；列表外字段（bookList 等）在逐条目求值之前、对整页求值。
 */
const FIELD_ORDER: Partial<Record<(typeof RULE_GROUPS)[number], readonly string[]>> = {
  ruleSearch: ['name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'bookUrl'],
  ruleBookInfo: ['init', 'name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'tocUrl', 'downloadUrls'],
};

/** 规则里全部 @put 块合并成的表（后者覆盖前者，同 legado 依次 put）；任一块解析不了返回 null。 */
function rulePuts(rule: string): Map<string, string> | null {
  const merged = new Map<string, string>();
  for (const match of rule.matchAll(PUT_RE)) {
    const map = parsePutMap(match[0].slice('@put:'.length));
    if (!map) return null;
    for (const [key, value] of map) merged.set(key, value);
  }
  return merged;
}

/**
 * 按求值顺序推演每个字段读 @get 时变量的值：值为规则串 = 与该字段同一内容上求值、可内联；
 * null = 不可内联（列表前整页求值、详情页 init 换内容后求值、或有解析不了的 put 致键集未知）。
 */
function inlineGroup(group: string, fields: Record<string, unknown>): Record<string, unknown> {
  const order = FIELD_ORDER[group as keyof typeof FIELD_ORDER] ?? [];
  const known = new Map<string, string | null>();
  let unknownPuts = false;
  const record = (rule: unknown, inlinable: boolean) => {
    if (typeof rule !== 'string' || !/@put:/i.test(rule)) return;
    const puts = rulePuts(rule);
    if (!puts) { unknownPuts = true; return; }
    for (const [key, value] of puts) known.set(key, inlinable ? value : null);
  };
  // 列表外字段（bookList/checkKeyWord…）先于逐条目字段、在整页上求值：值与条目内容不同，不可内联。
  for (const [name, rule] of Object.entries(fields)) if (!order.includes(name)) record(rule, false);
  // 详情页 init：只由 @put 组成时 put 在整页上求值（可内联），随后 legado 把内容换成空结果，
  // 后续字段的 put 在空内容上求值（不可内联）；init 带剩余规则时内容换成 init 结果、引擎不跟随，整组不内联。
  const init = fields.init;
  const initPutOnly = typeof init === 'string' && init.replace(PUT_RE, '').trim() === '' && /@put:/i.test(init);
  if (group === 'ruleBookInfo' && typeof init === 'string' && init.trim() && !initPutOnly) unknownPuts = true;

  const next: Record<string, unknown> = { ...fields };
  for (const name of order) {
    const rule = fields[name];
    if (typeof rule !== 'string') continue;
    if (name !== 'init' && !unknownPuts) {
      const body = rule.replace(PUT_RE, '').trim();
      const cut = body.indexOf('##');
      const suffix = cut < 0 ? '' : body.slice(cut);
      // legado 取 `@get:{` 与 `}` 之间原样作键（不 trim），`{ n }` 读不到 put 的 n。
      const key = GET_WHOLE_RE.exec((cut < 0 ? body : body.slice(0, cut)).trim())?.[1];
      const value = key === undefined || RESERVED_GET_KEYS.has(key) ? undefined : known.get(key);
      // `@get:{k}##正则`：legado 取变量值后再做替换；put 规则自身带 ## 时两段正则会串，不内联。
      if (typeof value === 'string' && !(suffix && value.includes('##'))) next[name] = value + suffix;
    }
    record(rule, name === 'init' || group !== 'ruleBookInfo' || !initPutOnly);
  }
  for (const [name, rule] of Object.entries(next)) {
    if (typeof rule === 'string' && /@put:/i.test(rule)) next[name] = rule.replace(PUT_RE, '');
  }
  return next;
}

/**
 * 源规则改写（开关 on 时编译前调用）：各组字段剥 @put；ruleSearch/ruleBookInfo 内整条 `@get:{k}`（可带 `##正则`
 * 后缀）按 legado 求值顺序推演出与该字段同内容的 put 规则时就地内联。
 * 不涉及变量的源原样返回（同一对象），涉及的返回浅拷贝，不改入参。
 */
export function resolveSourceVars<T extends object>(rules: T): T {
  const source = rules as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const group of RULE_GROUPS) {
    const fields = source[group];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    if (!Object.values(fields).some((rule) => typeof rule === 'string' && ruleMayUseVars(rule))) continue;
    out ??= { ...source };
    out[group] = inlineGroup(group, fields as Record<string, unknown>);
  }
  return (out ?? rules) as T;
}

// ---- 详情页 put → 目录页 get 变量袋（varbag1028，ENGINE_SYNTAX_VARS_BAG）----
/** 放 put 的详情字段（legado BookInfo 求值顺序）与读 get 的目录非列表字段。 */
export const VAR_BAG_PUT_FIELDS = ['name', 'author', 'tocUrl'] as const;
const VAR_BAG_GET_FIELDS: ReadonlySet<string> = new Set(['chapterName', 'chapterUrl', 'nextTocUrl']);
/** legado get() 先认的内置键、以及会落到原型链上的键：袋里不收。 */
export const VAR_BAG_RESERVED_KEYS: ReadonlySet<string> = new Set(['bookName', 'title', '__proto__']);
const JAVA_PUT_ANY = /(?<![\w$])java\s*\.\s*put\s*\(/g;
const JAVA_GET_ANY = /(?<![\w$])java\s*\.\s*get\s*\(/g;
const JAVA_PUT_LITERAL = /(?<![\w$])java\s*\.\s*put\s*\(\s*(['"])([^'"]+)\1\s*,/g;
const JAVA_GET_LITERAL = /(?<![\w$])java\s*\.\s*get\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const GET_ANY_RE = /@get:\{([^}]+?)\}/gi;

/** 变量袋的文本级计划：每个详情 put 字段放的键、每个目录 get 字段读的键。编译期（compile.ts）再逐字段核实。 */
export interface VarBagPlan {
  puts: ReadonlyMap<string, ReadonlySet<string>>;
  gets: ReadonlyMap<string, ReadonlySet<string>>;
}

const count = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

/**
 * 原始规则（未经 resolveSourceVars）上判变量袋子集，不在子集内返回 null：
 * - put（`@put:{…}` 与键为字面量的 `java.put('k', …)`）只在 ruleBookInfo.name/author/tocUrl；
 * - get 只在 ruleToc 非列表字段（`@get:{k}` 与 `java.get('k')`），详情页内 `@get` 归 resolveSourceVars；
 * - 键都是字面量、get 的键都被 put 过、一个键只由一个字段放（同字段 @put 与 java.put 也不重键）、不碰保留键；
 * - 详情页 init 不是 JS（JS init 可能把内容换成对象，put 规则求值口径对不上）。
 * 只是文本粗筛：字段能否编译、键在编译后是否真被收进来由调用方核实。
 */
export function varBagPlan(rules: object): VarBagPlan | null {
  const source = rules as Record<string, unknown>;
  const puts = new Map<string, Set<string>>();
  const gets = new Map<string, Set<string>>();
  if (typeof source.searchUrl === 'string' && usesBag(source.searchUrl)) return null;
  for (const group of RULE_GROUPS) {
    const fields = source[group];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [name, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string') continue;
      const putCount = count(rule, PUT_RE) + count(rule, JAVA_PUT_ANY);
      const javaGets = count(rule, JAVA_GET_ANY);
      if (putCount > 0) {
        if (group !== 'ruleBookInfo' || !(VAR_BAG_PUT_FIELDS as readonly string[]).includes(name)) return null;
        const javaKeys = [...rule.matchAll(JAVA_PUT_LITERAL)].map((match) => match[2]);
        if (javaKeys.length !== count(rule, JAVA_PUT_ANY)) return null;
        const mapKeys = rulePuts(rule);
        if (!mapKeys) return null;
        if (javaKeys.some((key) => mapKeys.has(key))) return null;
        puts.set(name, new Set([...mapKeys.keys(), ...javaKeys]));
      }
      if (group === 'ruleBookInfo') {
        if (javaGets > 0) return null;
        continue;
      }
      if (javaGets === 0 && !/@get:/i.test(rule)) continue;
      if (group !== 'ruleToc' || !VAR_BAG_GET_FIELDS.has(name)) return null;
      const javaKeys = [...rule.matchAll(JAVA_GET_LITERAL)].map((match) => match[2]);
      if (javaKeys.length !== javaGets) return null;
      const keys = [...[...rule.matchAll(GET_ANY_RE)].map((match) => match[1]), ...javaKeys];
      if (count(rule, /@get:/gi) !== count(rule, GET_ANY_RE)) return null;
      gets.set(name, new Set(keys));
    }
  }
  const info = source.ruleBookInfo as Record<string, unknown> | undefined;
  if (typeof info?.init === 'string' && /<js>|@js:/i.test(info.init)) return null;
  if (gets.size === 0) return null;
  const owner = new Map<string, string>();
  for (const [name, keys] of puts) {
    for (const key of keys) {
      if (VAR_BAG_RESERVED_KEYS.has(key) || owner.has(key)) return null;
      owner.set(key, name);
    }
  }
  for (const keys of gets.values()) for (const key of keys) if (!owner.has(key)) return null;
  return { puts, gets };
}

function usesBag(rule: string): boolean {
  return /@(?:put|get):/i.test(rule) || count(rule, JAVA_PUT_ANY) + count(rule, JAVA_GET_ANY) > 0;
}

// ---- 搜索 URL put → 搜索字段 get 变量袋（searchvars1028，ENGINE_SYNTAX_SEARCH_VARS）----
/** 读搜索袋的搜索字段：门面 engineSearchBook 与准入 searchCandidates 求值的那几个。 */
const SEARCH_VAR_GET_FIELDS: ReadonlySet<string> = new Set(['bookList', 'name', 'author', 'bookUrl']);

/** 搜索袋的文本级计划：searchUrl put 的键、每个搜索字段读的键。编译期（compile.ts compileSearchVars）再逐字段核实。 */
export interface SearchVarPlan {
  puts: ReadonlySet<string>;
  gets: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * 原始规则（未经 resolveSourceVars）上判搜索袋子集，不在子集内返回 null：
 * - put 只认 searchUrl 里键为字面量的 `java.put('k', …)`（legado AnalyzeUrl.put 写进本次搜索的 RuleData）；
 * - ruleSearch 各字段一律不 put（`@put`/`java.put`：条目 put 写进各条 SearchBook，另一套语义）；
 * - get（`@get:{k}` 与 `java.get('k')`）只换 bookList/name/author/bookUrl，键都是字面量、都被 searchUrl put 过、不碰保留键；
 *   其余搜索字段里的 get 不看（门面不求值它们，照旧按普通编译）。
 * 只是文本粗筛：字段能否编译、键在编译后是否真被收进来由调用方核实。
 */
export function searchVarPlan(rules: object, searchUrl: unknown): SearchVarPlan | null {
  if (typeof searchUrl !== 'string') return null;
  const puts = new Set([...searchUrl.matchAll(JAVA_PUT_LITERAL)].map((match) => match[2]));
  if (puts.size === 0) return null;
  const fields = (rules as Record<string, unknown>).ruleSearch;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const gets = new Map<string, Set<string>>();
  for (const [name, rule] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof rule !== 'string') continue;
    if (count(rule, PUT_RE) + count(rule, JAVA_PUT_ANY) > 0) return null;
    const javaGets = count(rule, JAVA_GET_ANY);
    if (!SEARCH_VAR_GET_FIELDS.has(name) || (javaGets === 0 && !/@get:/i.test(rule))) continue;
    const javaKeys = [...rule.matchAll(JAVA_GET_LITERAL)].map((match) => match[2]);
    if (javaKeys.length !== javaGets) return null;
    if (count(rule, /@get:/gi) !== count(rule, GET_ANY_RE)) return null;
    const keys = [...[...rule.matchAll(GET_ANY_RE)].map((match) => match[1]), ...javaKeys];
    if (keys.some((key) => VAR_BAG_RESERVED_KEYS.has(key) || !puts.has(key))) return null;
    gets.set(name, new Set(keys));
  }
  return gets.size === 0 ? null : { puts, gets };
}

// ---- 搜索条目袋（itemvars1028，ENGINE_SYNTAX_ITEM_VARS）----
/** 条目字段里能放 `java.put` 的（门面求值的那几个）；其余条目字段只认 `@put`（legado putRule 照样在条目上求值）。 */
export const ITEM_JAVA_PUT_FIELDS: ReadonlySet<string> = new Set(['name', 'author', 'bookUrl']);
/** 条目字段的 legado 求值顺序（compile.ts compileItemVars 按它挪 put）。 */
export const ITEM_FIELD_ORDER: readonly string[] = FIELD_ORDER.ruleSearch!;

/**
 * 条目袋的文本级计划。`urlPuts` = searchUrl 的 `java.put` 键；`searchPuts` / `infoPuts` = 各条目字段 / 详情字段放的键；
 * `gets` = `组.字段` → 读的键（搜索字段、详情 name/author/tocUrl、目录 chapterName/chapterUrl/nextTocUrl）。
 * 编译期（compile.ts compileItemVars）再逐字段核实。
 */
export interface ItemVarPlan {
  urlPuts: ReadonlySet<string>;
  searchPuts: ReadonlyMap<string, ReadonlySet<string>>;
  infoPuts: ReadonlyMap<string, ReadonlySet<string>>;
  gets: ReadonlyMap<string, ReadonlySet<string>>;
}

/** 字段放的键：`@put` 块与字面量键的 `java.put`，任一块解析不了、有动态键、两种写法重键返回 null。 */
function literalPuts(rule: string): { at: ReadonlySet<string>; java: ReadonlySet<string> } | null {
  const java = [...rule.matchAll(JAVA_PUT_LITERAL)].map((match) => match[2]);
  if (java.length !== count(rule, JAVA_PUT_ANY) || count(rule, /@put:/gi) !== count(rule, PUT_RE)) return null;
  const at = rulePuts(rule);
  if (!at || java.some((key) => at.has(key))) return null;
  return { at: new Set(at.keys()), java: new Set(java) };
}

/** 字段读的键：`@get:{k}` 与 `java.get('k')`，有动态键或写不全的 `@get:` 返回 null；不读返回空集。 */
function literalGets(rule: string): Set<string> | null {
  const javaKeys = [...rule.matchAll(JAVA_GET_LITERAL)].map((match) => match[2]);
  if (javaKeys.length !== count(rule, JAVA_GET_ANY) || count(rule, /@get:/gi) !== count(rule, GET_ANY_RE)) return null;
  return new Set([...[...rule.matchAll(GET_ANY_RE)].map((match) => match[1]), ...javaKeys]);
}

const groupOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * 原始规则（未经 resolveSourceVars）上判条目袋子集，不在子集内返回 null。legado：每条 SearchBook 以本次搜索 RuleData 的变量
 * 为初值，条目字段按 name → author → kind → wordCount → lastChapter → intro → coverUrl → bookUrl 求值、各自先 putRule 后
 * makeUp；toBook 复制变量，详情/目录 setRuleData(book) 读写同一份。子集：
 * - searchUrl 只认字面量键的 `java.put`（同 searchVarPlan）；
 * - 条目字段：name/author/bookUrl 可 `@put` 与字面量键 `java.put`，kind…coverUrl 只可 `@put`（门面不求值它们，put 挪到
 *   bookUrl 前面求值），bookList 与其余字段不 put；放 `java.put` 的字段不读袋（JS 内 put/get 交错的次序不推演）；
 * - 条目字段的读只看 bookList/name/author/bookUrl：bookList 只读 searchUrl 的键，其余读 searchUrl 的键或求值顺序上**更前**
 *   字段放的键；
 * - 详情：init 不碰袋、不是 JS；name/author/tocUrl 放与读（同 varBagPlan），读的键须是搜索侧放的、且不被详情字段放；
 * - 目录：不放；chapterName/chapterUrl/nextTocUrl 读搜索侧或详情放的键，其余目录字段不读；正文不碰袋；
 * - 键都是字面量、不碰保留键；搜索侧（searchUrl 与条目字段）内一个键只一处放，详情内同理，跨侧同键 = 详情覆盖；
 * - bookUrl 规则非空；至少有一处读条目字段放的键，或详情/目录读搜索侧的键（只有搜索字段读 searchUrl 的键归 searchvars1028）。
 * 只是文本粗筛：字段能否编译、键在编译后是否真被收进来由调用方核实。
 */
export function itemVarPlan(rules: object, searchUrl: unknown): ItemVarPlan | null {
  const source = rules as Record<string, unknown>;
  const search = groupOf(source.ruleSearch);
  if (!search || typeof search.bookUrl !== 'string' || search.bookUrl.trim() === '') return null;
  const urlPuts = new Set<string>();
  if (typeof searchUrl === 'string') {
    if (/@(?:put|get):/i.test(searchUrl)) return null;
    const keys = [...searchUrl.matchAll(JAVA_PUT_LITERAL)].map((match) => match[2]);
    if (keys.length !== count(searchUrl, JAVA_PUT_ANY)) return null;
    for (const key of keys) urlPuts.add(key);
  }
  const order = ITEM_FIELD_ORDER;
  const searchOwner = new Map<string, string>([...urlPuts].map((key) => [key, 'searchUrl']));
  const searchPuts = new Map<string, Set<string>>();
  const gets = new Map<string, Set<string>>();
  for (const [name, rule] of Object.entries(search)) {
    if (typeof rule !== 'string' || count(rule, /@put:/gi) + count(rule, JAVA_PUT_ANY) === 0) continue;
    if (!order.includes(name)) return null;
    const puts = literalPuts(rule);
    if (!puts) return null;
    if (puts.java.size > 0 && (!ITEM_JAVA_PUT_FIELDS.has(name) || count(rule, JAVA_GET_ANY) > 0 || /@get:/i.test(rule))) return null;
    const keys = new Set([...puts.at, ...puts.java]);
    for (const key of keys) {
      if (VAR_BAG_RESERVED_KEYS.has(key) || searchOwner.has(key)) return null;
      searchOwner.set(key, name);
    }
    searchPuts.set(name, keys);
  }
  for (const [name, rule] of Object.entries(search)) {
    if (typeof rule !== 'string' || !SEARCH_VAR_GET_FIELDS.has(name)) continue;
    const keys = literalGets(rule);
    if (!keys) return null;
    if (keys.size === 0) continue;
    for (const key of keys) {
      const from = searchOwner.get(key);
      if (from === undefined || VAR_BAG_RESERVED_KEYS.has(key)) return null;
      if (from !== 'searchUrl' && (name === 'bookList' || order.indexOf(from) >= order.indexOf(name))) return null;
    }
    gets.set(`ruleSearch.${name}`, keys);
  }

  const info = groupOf(source.ruleBookInfo) ?? {};
  if (typeof info.init === 'string' && (usesBag(info.init) || /<js>|@js:/i.test(info.init))) return null;
  const infoOwner = new Map<string, string>();
  const infoPuts = new Map<string, Set<string>>();
  for (const [name, rule] of Object.entries(info)) {
    if (name === 'init' || typeof rule !== 'string') continue;
    const hasGet = count(rule, JAVA_GET_ANY) > 0 || /@get:/i.test(rule);
    if (count(rule, /@put:/gi) + count(rule, JAVA_PUT_ANY) > 0) {
      if (!(VAR_BAG_PUT_FIELDS as readonly string[]).includes(name)) return null;
      const puts = literalPuts(rule);
      if (!puts || (puts.java.size > 0 && hasGet)) return null;
      const keys = new Set([...puts.at, ...puts.java]);
      for (const key of keys) {
        if (VAR_BAG_RESERVED_KEYS.has(key) || infoOwner.has(key)) return null;
        infoOwner.set(key, name);
      }
      infoPuts.set(name, keys);
    }
  }
  for (const name of VAR_BAG_PUT_FIELDS) {
    const rule = info[name];
    if (typeof rule !== 'string') continue;
    const keys = literalGets(rule);
    if (!keys) return null;
    // 详情自己放的键归 resolveSourceVars（同页内联）；编译后还残留的，compileItemVars 按不在允许集合拒。
    const fromSearch = new Set([...keys].filter((key) => !infoOwner.has(key)));
    if ([...fromSearch].some((key) => VAR_BAG_RESERVED_KEYS.has(key) || !searchOwner.has(key))) return null;
    if (fromSearch.size > 0) gets.set(`ruleBookInfo.${name}`, fromSearch);
  }

  const toc = groupOf(source.ruleToc) ?? {};
  for (const [name, rule] of Object.entries(toc)) {
    if (typeof rule !== 'string') continue;
    if (count(rule, /@put:/gi) + count(rule, JAVA_PUT_ANY) > 0) return null;
    if (count(rule, JAVA_GET_ANY) === 0 && !/@get:/i.test(rule)) continue;
    if (!VAR_BAG_GET_FIELDS.has(name)) return null;
    const keys = literalGets(rule);
    if (!keys || [...keys].some((key) => VAR_BAG_RESERVED_KEYS.has(key) || !(searchOwner.has(key) || infoOwner.has(key)))) return null;
    if (keys.size > 0) gets.set(`ruleToc.${name}`, keys);
  }
  const content = groupOf(source.ruleContent) ?? {};
  if (Object.values(content).some((rule) => typeof rule === 'string' && usesBag(rule))) return null;

  const active = [...gets].some(([field, keys]) => field.startsWith('ruleSearch.')
    ? [...keys].some((key) => !urlPuts.has(key))
    : [...keys].some((key) => searchOwner.has(key)));
  return active ? { urlPuts, searchPuts, infoPuts, gets } : null;
}

/** 字段原文里全部 `@put:{…}` 合并成的键 → 规则（varbag1028 编译用）；任一块解析不了返回 null。 */
export function varPutRules(rule: string): Map<string, string> | null {
  return rulePuts(rule);
}
