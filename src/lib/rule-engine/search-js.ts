// searchjs1027（ENGINE_SEARCH_JS，默认关，须 ENGINE_POST_SEARCH 同开）：legado 搜索模板里的 JS 求值。
// 口径照 legado AnalyzeUrl.initUrl（Jer-Chao/legado@c2c4775）：analyzeJs（`<js>…</js>` / `@js:` 逐段求值，段间文本
// 替换 `@result`）→ replaceKeyPageJs（`{{表达式}}` 逐个求值、`<a,b>` 页码取首项）→ analyzeUrl（选项/编码，
// source-parser buildLegadoSearchRequest）。JS 一律在 js-sandbox 的 QuickJS 里跑：无网络/文件/定时器，
// 只绑定 key/page/baseUrl/result/source（只读：getKey/bookSourceUrl/getVariable→''）/cookie（空实现）/book=null，
// java 在纯计算帮手之外补 put/get（本次请求构造内的变量袋，见 SETUP）；
// java.ajax、cache、source.put 等依赖宿主状态的调用在沙箱里不存在 → 求值失败 → 判不支持。
// 只对旧口径构造不出请求的模板生效（searchTemplateNeedsJs），旧口径能构造的模板逐字走旧路径。
// 本模块只在服务端用（js-sandbox 依赖 node:crypto 与 wasm），纯函数部分在 source-parser.ts。

import {
  buildLegadoSearchRequest, buildSourceSearchRequest, searchTemplateNeedsJs,
  type SourceSearchRequest, type SourceUrlValidator,
} from '@/lib/source-parser';
import { checkSourceUrl, SourcePolicyError, validateSourceUrl } from '@/lib/source-policy';
import { preloadJsSandbox, runJs } from './js-sandbox';
import { RuleEngineError } from './types';

/**
 * 沙箱暂不可用（未加载完、wasm 异常后重载中、执行预算耗尽）：是瞬时状态，不是书源的问题——
 * 调用方不得把它记成策略拒绝（准入拒/永久禁用），只当本次跳过。
 */
export class SearchJsNotReadyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SearchJsNotReadyError';
  }
}

const MAX_JS_SEGMENTS = 8;
const MAX_INLINE_EXPRESSIONS = 32;
const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
const PAGE_PATTERN = /<(.*?)>/g;
const OPTION_SPLIT = /\s*,\s*(?=\{)/;
const SEARCH_PAGE = 1;
const MAX_SEARCH_VARS = 32;
const MAX_SEARCH_VARS_CHARS = 16_384;

// 沙箱里的 legado 绑定（在包装函数体内展开：vars 是闭包变量，规则代码经间接 eval 在全局作用域跑、看不到它）。
// source/cookie/java 冻结；__sourceKey/__vars 用完即删。
// java.put/get = legado AnalyzeUrl.put/get：搜索时写进本次搜索的 RuleData（一次请求构造内各段共享），put 返回值本身。
// get 读不到本次 put 过的键时 legado 会再查持久化的源变量，这里没有那份状态 → 判不支持；
// 值只收字符串/布尔/无指数形态的数字（Rhino 转 String 与 JS 同形），其余形态不可复现即拒。
const SETUP = `
  var k = globalThis.__sourceKey; delete globalThis.__sourceKey;
  var vars = Object.create(null), seed = JSON.parse(globalThis.__vars); delete globalThis.__vars;
  Object.keys(seed).forEach(function(n){ vars[n] = seed[n]; });
  globalThis.source = Object.freeze({
    key: k, bookSourceUrl: k, variable: '',
    getKey: function(){ return k; }, getBookSourceUrl: function(){ return k; }, getVariable: function(){ return ''; }
  });
  globalThis.cookie = Object.freeze({ getCookie: function(){ return ''; }, removeCookie: function(){} });
  globalThis.book = null;
  var j = globalThis.java, nj = {};
  Object.keys(j).forEach(function(n){ nj[n] = j[n]; });
  nj.put = function(name, v){
    if (typeof name !== 'string') throw new TypeError('java.put 键须为字符串');
    var s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'boolean' || (typeof v === 'number' && isFinite(v) && !/e/i.test(String(v)))) s = String(v);
    else throw new TypeError('java.put 不支持的值类型：' + typeof v);
    vars[name] = s;
    return s;
  };
  nj.get = function(name){
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(vars, name)) throw new TypeError('java.get 读不到本次 put 的变量');
    return vars[name];
  };
  globalThis.java = Object.freeze(nj);
`;

// analyzeJs：legado `evalJS(code, result).toString()`。null → "null"（照抄）；数字在 Rhino 是 Double，toString 得 "1.0"，
// 与 JS 口径不一致，直接判不支持；对象/数组的 Java toString 形态不可复现，同样拒。
const SEGMENT_FORMAT = `(function(v){
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  throw new TypeError('不支持的 JS 结果类型：' + typeof v);
})`;

// `{{表达式}}`：legado `evalJS(it) ?: ""`，String 原样、整数 Double 按 "%.0f"，其余 toString。
// 非整数只放行 Java Double.toString 与 JS String 一致的范围（1e-3 ≤ |v| < 1e7），其余形态不可复现即拒。
const INLINE_FORMAT = `(function(v){
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (typeof v === 'number' && isFinite(v)) {
    if (v % 1 === 0) { if (Math.abs(v) >= 1e21) throw new RangeError('数字过大'); return v.toFixed(0); }
    var a = Math.abs(v);
    if (a >= 1e-3 && a < 1e7) return String(v);
  }
  throw new TypeError('不支持的 JS 结果类型：' + typeof v);
})`;

interface EvalContext { title: string; baseUrl: string; vars: Record<string, string> }

function evalSearchJs(code: string, ctx: EvalContext, result: string | null): string {
  const wrapper = `(function(){${SETUP}${result === null ? 'globalThis.result = null;\n' : ''}`
    + `var out = ${result === null ? INLINE_FORMAT : SEGMENT_FORMAT}((0, eval)(${JSON.stringify(code)}));\n`
    + 'return JSON.stringify([out, vars]);\n})()';
  let packed: unknown;
  try {
    packed = runJs(wrapper, {
      result: result ?? '',
      baseUrl: ctx.baseUrl,
      globals: { key: ctx.title, page: SEARCH_PAGE, __sourceKey: ctx.baseUrl, __vars: JSON.stringify(ctx.vars) },
    });
  } catch (error) {
    if (error instanceof RuleEngineError) {
      if (/未就绪|预算耗尽|沙箱异常/.test(error.message)) throw new SearchJsNotReadyError(error.message);
      throw new SourcePolicyError(`不支持该书源的搜索 JS（${error.message}）`);
    }
    throw error;
  }
  if (typeof packed !== 'string') throw new SourcePolicyError('不支持该书源的搜索 JS（结果非字符串）');
  const [value, vars] = JSON.parse(packed) as [unknown, Record<string, string>];
  if (typeof value !== 'string') throw new SourcePolicyError('不支持该书源的搜索 JS（结果非字符串）');
  if (Object.keys(vars).length > MAX_SEARCH_VARS || JSON.stringify(vars).length > MAX_SEARCH_VARS_CHARS) {
    throw new SourcePolicyError('不支持该书源的搜索 JS（变量过多）');
  }
  ctx.vars = vars;
  return value;
}

/** legado AnalyzeUrl.analyzeJs。 */
function analyzeJs(ruleUrl: string, ctx: EvalContext): string {
  let result = ruleUrl;
  let start = 0;
  let segments = 0;
  const literal = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) result = trimmed.split('@result').join(result);
  };
  for (const match of ruleUrl.matchAll(JS_PATTERN)) {
    if ((segments += 1) > MAX_JS_SEGMENTS) throw new SourcePolicyError('不支持该书源的搜索 JS（段数过多）');
    if (match.index > start) literal(ruleUrl.slice(start, match.index));
    result = evalSearchJs(match[2] ?? match[1], ctx, result);
    start = match.index + match[0].length;
  }
  if (ruleUrl.length > start) literal(ruleUrl.slice(start));
  return result;
}

/** legado RuleAnalyzer.innerRule("{{", "}}")：逐个 `{{` 找其后首个 `}}`，没有闭合就继续找下一个 `{{`。 */
function replaceInline(ruleUrl: string, ctx: EvalContext): string {
  if (!ruleUrl.includes('{{') || !ruleUrl.includes('}}')) return ruleUrl;
  let out = '';
  let startX = 0;
  let pos = 0;
  let count = 0;
  for (;;) {
    const open = ruleUrl.indexOf('{{', pos);
    if (open === -1) break;
    pos = open + 2;
    const close = ruleUrl.indexOf('}}', pos);
    if (close === -1) continue;
    if ((count += 1) > MAX_INLINE_EXPRESSIONS) throw new SourcePolicyError('不支持该书源的搜索 JS（表达式过多）');
    const expr = ruleUrl.slice(pos, close);
    const value = expr === 'key' ? ctx.title : expr === 'page' ? String(SEARCH_PAGE) : evalSearchJs(expr, ctx, null);
    out += ruleUrl.slice(startX, open) + value;
    pos = close + 2;
    startX = pos;
  }
  if (startX === 0) return ruleUrl;
  const url = out + ruleUrl.slice(startX);
  return url || ruleUrl;
}

/** legado pagePattern `<(.*?)>`：page=1 取首项（逗号切、去两端 ≤ ' ' 字符）；匹配在替换前的串上找、逐个全量替换。 */
function replacePages(ruleUrl: string): string {
  let url = ruleUrl;
  for (const match of ruleUrl.matchAll(PAGE_PATTERN)) {
    const first = match[1].split(',')[0].replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
    url = url.split(match[0]).join(first);
  }
  return url;
}

interface EvaluatedSearchJs { ruleUrl: string; baseUrl: string }

/** legado AnalyzeUrl 的 JS 段与 `{{…}}`/页码求值，得交给 buildLegadoSearchRequest 的 ruleUrl。base 带选项时照 legado 剥掉，作相对地址基准。 */
function evaluateSearchJs(template: string, title: string, base: string): EvaluatedSearchJs {
  const split = OPTION_SPLIT.exec(base);
  const ctx: EvalContext = { title, baseUrl: split ? base.slice(0, split.index) : base, vars: {} };
  return { ruleUrl: replacePages(replaceInline(analyzeJs(template, ctx), ctx)), baseUrl: ctx.baseUrl };
}

/** legado AnalyzeUrl 口径的整条搜索请求。base = 书源 bookSourceUrl。 */
export function buildSearchJsRequest(
  template: string, title: string, base: string, validate: SourceUrlValidator = validateSourceUrl,
): SourceSearchRequest {
  const { ruleUrl, baseUrl } = evaluateSearchJs(template, title, base);
  return buildLegadoSearchRequest(ruleUrl, baseUrl, validate);
}

function withSearchJs(
  template: unknown, title: string, base: string | undefined, validate: SourceUrlValidator, searchJs: boolean,
  evaluate: (template: string, base: string) => EvaluatedSearchJs,
): SourceSearchRequest {
  try {
    return buildSourceSearchRequest(template, title, base, validate);
  } catch (error) {
    if (!(error instanceof SourcePolicyError) || !searchJs || typeof template !== 'string' || base === undefined
      || !searchTemplateNeedsJs(template, base)) throw error;
    const { ruleUrl, baseUrl } = evaluate(template, base);
    return buildLegadoSearchRequest(ruleUrl, baseUrl, validate);
  }
}

/**
 * 运行时/准入统一入口：先走旧口径（buildSourceSearchRequest，逐字不变）；只有旧口径构造不出、开关开、
 * 且模板确实要 JS（searchTemplateNeedsJs）时才按 legado JS 口径求值。其余情况原样抛旧口径的错误。
 * 调用前须已 await prepareSearchJs()，否则抛 SearchJsNotReadyError。
 */
export function buildSearchRequest(
  template: unknown, title: string, base: string | undefined,
  validate: SourceUrlValidator = validateSourceUrl, searchJs = false,
): SourceSearchRequest {
  return withSearchJs(template, title, base, validate, searchJs, (t, b) => evaluateSearchJs(t, title, b));
}

function allowAnyHost(value: unknown, base?: string): URL {
  return checkSourceUrl(value, base, { hostAllowed: () => true });
}

/** 判「模板能否构造」用的占位书名（与 source-usability / 候选口径同一个）。 */
export const SEARCH_PROBE_TITLE = '书';
const MAX_PROBE_CACHE = 512;
const probed = new Map<string, EvaluatedSearchJs | { rejected: string }>();

/**
 * 占位书名下的 JS 段求值结果（ruleUrl 或策略拒原因）按 base+模板 LRU 记忆：候选筛与取书池每次请求都要判全部源，
 * 不能每次都起沙箱、吃共享 JS 预算（还会因单段预算耗尽让同一个源时好时坏）。只记忆求值结果，host 门/红线每次对
 * 结果重验；沙箱未就绪抛 SearchJsNotReadyError、不记忆。真实搜索（真书名）不走这里。
 */
function probeSearchJs(template: string, base: string): EvaluatedSearchJs {
  const cacheKey = `${base}\0${template}`;
  let entry = probed.get(cacheKey);
  if (entry !== undefined) {
    probed.delete(cacheKey);
  } else {
    try {
      entry = evaluateSearchJs(template, SEARCH_PROBE_TITLE, base);
    } catch (error) {
      if (!(error instanceof SourcePolicyError)) throw error;
      entry = { rejected: error.message };
    }
  }
  probed.set(cacheKey, entry);
  while (probed.size > MAX_PROBE_CACHE) probed.delete(probed.keys().next().value!);
  if ('rejected' in entry) throw new SourcePolicyError(entry.rejected);
  return entry;
}

/** 同 buildSearchRequest，书名固定为 SEARCH_PROBE_TITLE、JS 段求值走 probeSearchJs 记忆：只给「能否构造」类判定用。 */
export function buildSearchProbeRequest(
  template: unknown, base: string | undefined, validate: SourceUrlValidator = validateSourceUrl, searchJs = false,
): SourceSearchRequest {
  return withSearchJs(template, SEARCH_PROBE_TITLE, base, validate, searchJs, probeSearchJs);
}

/**
 * 候选口径：该需 JS 的模板能否在沙箱里构造出请求（放开 host 白名单，红线照守；占位书名，求值结果记忆见 probeSearchJs）。
 * 沙箱未就绪抛 SearchJsNotReadyError。调用方先确认 searchTemplateNeedsJs。
 */
export function searchJsConstructible(template: string, base: string): boolean {
  try {
    const { ruleUrl, baseUrl } = probeSearchJs(template, base);
    buildLegadoSearchRequest(ruleUrl, baseUrl, allowAnyHost);
    return true;
  } catch (error) {
    if (!(error instanceof SourcePolicyError)) throw error;
    return false;
  }
}

/** 求值是同步的：用到搜索 JS 的路径先 await 这里（幂等，并发共享同一次加载）。 */
export function prepareSearchJs(): Promise<void> {
  return preloadJsSandbox();
}
