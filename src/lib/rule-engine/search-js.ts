// searchjs1027（ENGINE_SEARCH_JS，默认关，须 ENGINE_POST_SEARCH 同开）：legado 搜索模板里的 JS 求值。
// 口径照 legado AnalyzeUrl.initUrl（Jer-Chao/legado@c2c4775）：analyzeJs（`<js>…</js>` / `@js:` 逐段求值，段间文本
// 替换 `@result`）→ replaceKeyPageJs（`{{表达式}}` 逐个求值、`<a,b>` 页码取首项）→ analyzeUrl（选项/编码，
// source-parser buildLegadoSearchRequest）。JS 一律在 js-sandbox 的 QuickJS 里跑：无网络/文件/定时器，
// 只绑定 key/page/baseUrl/result/source（只读：getKey/bookSourceUrl/getVariable→''）/cookie（空实现）/book=null，
// java 在纯计算帮手之外补 put/get（本次请求构造内的变量袋，见 SETUP）；
// java.ajax、cache、source.put 等依赖宿主状态的调用在沙箱里不存在 → 求值失败 → 判不支持。
// netjs1029（ENGINE_SEARCH_NET_JS，默认关）：含 java.ajax 的模板改在 jsoup 包装帧里跑，ajax 由宿主按缓存应答，
// 未命中则抛出待取地址、由异步入口（buildSearchRequestWithNet）联网取回后整段重放。
// 只对旧口径构造不出请求的模板生效（searchTemplateNeedsJs），旧口径能构造的模板逐字走旧路径。
// 本模块只在服务端用（js-sandbox 依赖 node:crypto 与 wasm），纯函数部分在 source-parser.ts。

import {
  buildLegadoSearchRequest, buildSourceSearchRequest, MAX_SEARCH_JS_LONG_TEMPLATE_LENGTH, MAX_SEARCH_JS_TEMPLATE_LENGTH,
  searchOptionsNeedParity, searchTemplateNeedsJs, searchTemplateUsesAjax, type SourceSearchRequest, type SourceUrlValidator,
} from '@/lib/source-parser';
import { checkSourceUrl, SourcePolicyError, validateSourceUrl } from '@/lib/source-policy';
import { MAX_JS_INPUT_CHARS, preloadJsSandbox, runJs, runJsoup, type JsBindings } from './js-sandbox';
import {
  engineSearchNetJsEnabled, engineSearchOptionsEnabled, engineSyntaxJsEnabled, engineSyntaxJsoupEnabled, engineSyntaxJsUtilEnabled,
} from './syntax-flags';
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
// get 读不到本次 put 过的键时 legado AnalyzeUrl.get 得空串（搜索用新建的 RuleData，不回查源变量）；读不到的键实测多出自
// 联网段或宿主状态，这里保守判不支持；
// 值只收字符串/布尔/无指数形态的数字（Rhino 转 String 与 JS 同形），其余形态不可复现即拒。
// netjs1029 联网帧（jsoup 包装下跑，java.ajax 返回 Java 字符串）：put/格式化先把 Java 字符串拆成原文（Rhino 里同是 String），
// get 照 legado 返回 Java 字符串；非联网帧的代码逐字不变。
const NET_UNWRAP = `if (typeof v === 'object' && v !== null) { var w = JSTR.un(v); if (w !== undefined) v = w; }
  `;
function setupCode(net: boolean): string {
  return `
  ${net ? 'var JSTR = globalThis.__jstr;\n  ' : ''}var k = globalThis.__sourceKey; delete globalThis.__sourceKey;
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
    ${net ? NET_UNWRAP : ''}var s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'boolean' || (typeof v === 'number' && isFinite(v) && !/e/i.test(String(v)))) s = String(v);
    else throw new TypeError('java.put 不支持的值类型：' + typeof v);
    vars[name] = s;
    return s;
  };
  nj.get = function(name){
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(vars, name)) throw new TypeError('java.get 读不到本次 put 的变量');
    return ${net ? 'JSTR.of(vars[name])' : 'vars[name]'};
  };
  globalThis.java = Object.freeze(nj);
`;
}
const SETUP = setupCode(false);
const SETUP_NET = setupCode(true);

// analyzeJs：legado `evalJS(code, result).toString()`。null → "null"（照抄）；数字在 Rhino 是 Double，toString 得 "1.0"，
// 与 JS 口径不一致，直接判不支持；对象/数组的 Java toString 形态不可复现，同样拒。
const SEGMENT_BODY = `
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  throw new TypeError('不支持的 JS 结果类型：' + typeof v);
`;

// `{{表达式}}`：legado `evalJS(it) ?: ""`，String 原样、整数 Double 按 "%.0f"，其余 toString。
// 非整数只放行 Java Double.toString 与 JS String 一致的范围（1e-3 ≤ |v| < 1e7），其余形态不可复现即拒。
const INLINE_BODY = `
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (typeof v === 'number' && isFinite(v)) {
    if (v % 1 === 0) { if (Math.abs(v) >= 1e21) throw new RangeError('数字过大'); return v.toFixed(0); }
    var a = Math.abs(v);
    if (a >= 1e-3 && a < 1e7) return String(v);
  }
  throw new TypeError('不支持的 JS 结果类型：' + typeof v);
`;
const formatCode = (body: string, net: boolean) => `(function(v){${net ? `\n  ${NET_UNWRAP.trimEnd()}` : ''}${body}})`;
const SEGMENT_FORMAT = formatCode(SEGMENT_BODY, false);
const INLINE_FORMAT = formatCode(INLINE_BODY, false);
const SEGMENT_FORMAT_NET = formatCode(SEGMENT_BODY, true);
const INLINE_FORMAT_NET = formatCode(INLINE_BODY, true);

/**
 * netjs1029：联网帧里 java.ajax 要的页面还没取到（net 缓存未命中）。只在本模块内流转：沙箱把宿主回调的
 * RuleEngineError 原样抛出，evalSearchJs 认出它直接上抛，withSearchJs 转成 SearchNetPendingError 交调用方去取。
 */
class SearchNetMissError extends RuleEngineError {
  constructor(readonly url: string) {
    super('RULE_EVAL_FAILED', 'java.ajax 页面未取');
    this.name = 'SearchNetMissError';
  }
}

/**
 * netjs1029：搜索模板的 java.ajax 要先联网取页面（legado JsExtensions.ajax → 新建 AnalyzeUrl 取 body）。`key` = JS 传进来的原串
 * （缓存键），`request` = 按 legado AnalyzeUrl 口径解析出的请求（地址已过 host 门）。buildSearchRequestWithNet 自动取、重放；
 * 同步入口原样抛给调用方（判「能否构造」类调用方视作能构造）。
 */
export class SearchNetPendingError extends Error {
  constructor(readonly key: string, readonly request: SourceSearchRequest) {
    super('搜索 JS 需联网取页面');
    this.name = 'SearchNetPendingError';
  }
}

/** netjs1029：联网取页面（运行时 context.page / 准入 admissionFetch），返回 body 原文；失败抛错。 */
export type SearchNetFetch = (request: SourceSearchRequest) => Promise<string>;

/** 一次请求构造最多联网取几页（legado 不限；这里有界，免得一个模板把请求预算吃光）。 */
const MAX_NET_FETCHES = 4;

/** net：联网帧的 ajax 页面缓存（url 原串 → body）；undefined = 非联网帧（无 ajax 回调，逐字走旧路径）。 */
interface EvalContext { title: string; baseUrl: string; vars: Record<string, string>; net?: ReadonlyMap<string, string> }

/**
 * netjs1029：搜索联网 JS（ENGINE_SEARCH_NET_JS 与 ENGINE_SYNTAX_JS、ENGINE_SYNTAX_JSOUP 同开；java.ajax 返回 Java 字符串，
 * 要 jsoup 包装）。搜索 JS 本身是否生效仍由调用方的 searchJs 参数判。
 */
export function searchNetJsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return engineSearchNetJsEnabled(env) && engineSyntaxJsEnabled(env) && engineSyntaxJsoupEnabled(env);
}

/** gbkjs1029：搜索模板里 `java.encodeURI(文本, 'gbk'|…)` 按 URLEncoder GBK 系口径编码（ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JS_UTIL 同开）。 */
function searchCjkEncodeUri(): boolean {
  return engineSyntaxJsEnabled() && engineSyntaxJsUtilEnabled();
}

/**
 * longjs1029：需 JS 的搜索模板长度上限（ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JS_UTIL 同开时放到 64K，收自带签名实现的模板；
 * 否则 8192）。运行时闸门、候选初筛与语义位共用。
 */
export function searchJsTemplateLimit(env: NodeJS.ProcessEnv = process.env): number {
  return engineSyntaxJsEnabled(env) && engineSyntaxJsUtilEnabled(env) ? MAX_SEARCH_JS_LONG_TEMPLATE_LENGTH : MAX_SEARCH_JS_TEMPLATE_LENGTH;
}

function evalSearchJs(code: string, ctx: EvalContext, result: string | null): string {
  const net = ctx.net;
  const format = result === null ? (net ? INLINE_FORMAT_NET : INLINE_FORMAT) : (net ? SEGMENT_FORMAT_NET : SEGMENT_FORMAT);
  const wrapper = `(function(){${net ? SETUP_NET : SETUP}${result === null ? 'globalThis.result = null;\n' : ''}`
    + `var out = ${format}((0, eval)(${JSON.stringify(code)}));\n`
    + 'return JSON.stringify([out, vars]);\n})()';
  const bindings: JsBindings = {
    result: result ?? '',
    baseUrl: ctx.baseUrl,
    globals: { key: ctx.title, page: SEARCH_PAGE, __sourceKey: ctx.baseUrl, __vars: JSON.stringify(ctx.vars) },
    ...(searchCjkEncodeUri() ? { cjkEncodeUri: true } : {}),
  };
  let packed: unknown;
  try {
    packed = net
      ? runJsoup(wrapper, {
        ...bindings,
        callbacks: {
          ajax: (url) => {
            const body = net.get(url);
            if (body === undefined) throw new SearchNetMissError(url);
            return body;
          },
        },
      }, 'final')
      : runJs(wrapper, bindings);
  } catch (error) {
    if (error instanceof SearchNetMissError) throw error;
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

/** vars：JS 段 `java.put` 写进本次搜索 RuleData 的变量（searchvars1028 给搜索字段读）。 */
interface EvaluatedSearchJs { ruleUrl: string; baseUrl: string; vars: Readonly<Record<string, string>> }

/** searchopt1028：求值后的选项按 legado UrlOption 口径重读（开关开、且静态模板的选项被旧口径拒时）。 */
function optionParity(template: string, base: string): boolean {
  return engineSearchOptionsEnabled() && searchOptionsNeedParity(template, base);
}

/** legado AnalyzeUrl 的 JS 段与 `{{…}}`/页码求值，得交给 buildLegadoSearchRequest 的 ruleUrl。base 带选项时照 legado 剥掉，作相对地址基准。 */
function evaluateSearchJs(template: string, title: string, base: string, net?: ReadonlyMap<string, string>): EvaluatedSearchJs {
  const split = OPTION_SPLIT.exec(base);
  const ctx: EvalContext = { title, baseUrl: split ? base.slice(0, split.index) : base, vars: {}, ...(net ? { net } : {}) };
  const ruleUrl = replacePages(replaceInline(analyzeJs(template, ctx), ctx));
  return { ruleUrl, baseUrl: ctx.baseUrl, vars: ctx.vars };
}

/** 该模板这次是否走联网帧（开关开且模板里有 java.ajax 调用）。 */
function netFrame(template: string): boolean {
  return searchNetJsEnabled() && searchTemplateUsesAjax(template);
}

/**
 * netjs1029：java.ajax 实参按 legado 新建 AnalyzeUrl(url, source) 口径解析成请求：那里 key/page 为 null、baseUrl 为空，
 * 只有展开好的绝对地址能用；`{{…}}`/JS 段/页码占位一律拒（不支持，不猜）。选项按 legado 口径读（与主模板同一开关）。
 */
function ajaxRequest(url: string, validate: SourceUrlValidator): SourceSearchRequest {
  const ruleUrl = url.trim();
  if (!/^https?:\/\//i.test(ruleUrl) || /\{\{|<js>|@js:|<[^>]*>/i.test(ruleUrl)) {
    throw new SourcePolicyError('不支持该书源的搜索 JS（java.ajax 地址须是展开好的绝对地址）');
  }
  return buildLegadoSearchRequest(ruleUrl, undefined, validate, engineSearchOptionsEnabled());
}

/** legado AnalyzeUrl 口径的整条搜索请求。base = 书源 bookSourceUrl。 */
export function buildSearchJsRequest(
  template: string, title: string, base: string, validate: SourceUrlValidator = validateSourceUrl,
): SourceSearchRequest {
  const { ruleUrl, baseUrl } = evaluateSearchJs(template, title, base);
  return buildLegadoSearchRequest(ruleUrl, baseUrl, validate, optionParity(template, base));
}

/** 搜索请求与本次求值得到的变量袋；旧口径构造出的请求不跑 JS，没有 vars。 */
export interface SearchRequestWithVars {
  request: SourceSearchRequest;
  vars?: Readonly<Record<string, string>>;
}

function withSearchJs(
  template: unknown, title: string, base: string | undefined, validate: SourceUrlValidator, searchJs: boolean,
  evaluate: (template: string, base: string, net: boolean) => EvaluatedSearchJs,
): SearchRequestWithVars {
  try {
    return { request: buildSourceSearchRequest(template, title, base, validate) };
  } catch (error) {
    if (!(error instanceof SourcePolicyError) || !searchJs || typeof template !== 'string' || base === undefined
      || !searchTemplateNeedsJs(template, base, searchJsTemplateLimit())) throw error;
    let evaluated: EvaluatedSearchJs;
    try {
      evaluated = evaluate(template, base, netFrame(template));
    } catch (miss) {
      if (!(miss instanceof SearchNetMissError)) throw miss;
      throw new SearchNetPendingError(miss.url, ajaxRequest(miss.url, validate));
    }
    const { ruleUrl, baseUrl, vars } = evaluated;
    return { request: buildLegadoSearchRequest(ruleUrl, baseUrl, validate, optionParity(template, base)), vars };
  }
}

/**
 * 运行时/准入统一入口：先走旧口径（buildSourceSearchRequest，逐字不变）；只有旧口径构造不出、开关开、
 * 且模板确实要 JS（searchTemplateNeedsJs）时才按 legado JS 口径求值。其余情况原样抛旧口径的错误。
 * 调用前须已 await prepareSearchJs()，否则抛 SearchJsNotReadyError。
 * 联网 JS 模板（searchNetJsEnabled）要取页面时抛 SearchNetPendingError；要真去取用 buildSearchRequestWithNet。
 */
export function buildSearchRequest(
  template: unknown, title: string, base: string | undefined,
  validate: SourceUrlValidator = validateSourceUrl, searchJs = false,
): SourceSearchRequest {
  return buildSearchRequestWithVars(template, title, base, validate, searchJs).request;
}

/** 同 buildSearchRequest，另带回 JS 段 put 的变量（searchvars1028：搜索字段读袋用；袋与请求出自同一次求值）。 */
export function buildSearchRequestWithVars(
  template: unknown, title: string, base: string | undefined,
  validate: SourceUrlValidator = validateSourceUrl, searchJs = false,
): SearchRequestWithVars {
  return withSearchJs(template, title, base, validate, searchJs, (t, b, net) => evaluateSearchJs(t, title, b, net ? new Map() : undefined));
}

/**
 * netjs1029：同 buildSearchRequestWithVars，java.ajax 要的页面经 fetchNet 取回后整段模板从头重放（legado 求值是同步阻塞取页，
 * 这里取回 body 记进缓存、再求一遍，同一地址不重取）；最多取 MAX_NET_FETCHES 页。fetchNet 的错误原样上抛。
 * 非联网帧的模板只求一遍，与 buildSearchRequestWithVars 逐字相同。
 */
export async function buildSearchRequestWithNet(
  template: unknown, title: string, base: string | undefined,
  validate: SourceUrlValidator, searchJs: boolean, fetchNet: SearchNetFetch,
): Promise<SearchRequestWithVars> {
  const net = new Map<string, string>();
  for (;;) {
    try {
      return withSearchJs(template, title, base, validate, searchJs, (t, b, on) => evaluateSearchJs(t, title, b, on ? net : undefined));
    } catch (error) {
      if (!(error instanceof SearchNetPendingError)) throw error;
      if (net.size >= MAX_NET_FETCHES) throw new SourcePolicyError('不支持该书源的搜索 JS（java.ajax 次数过多）');
      const body = await fetchNet(error.request);
      if (body.length > MAX_JS_INPUT_CHARS) throw new SourcePolicyError('不支持该书源的搜索 JS（java.ajax 页面过大）');
      net.set(error.key, body);
    }
  }
}

function allowAnyHost(value: unknown, base?: string): URL {
  return checkSourceUrl(value, base, { hostAllowed: () => true });
}

/** 判「模板能否构造」用的占位书名（与 source-usability / 候选口径同一个）。 */
export const SEARCH_PROBE_TITLE = '书';
const MAX_PROBE_CACHE = 512;
const probed = new Map<string, EvaluatedSearchJs | { rejected: string } | { pending: string }>();

/**
 * 占位书名下的 JS 段求值结果（ruleUrl 或策略拒原因）按 base+模板 LRU 记忆：候选筛与取书池每次请求都要判全部源，
 * 不能每次都起沙箱、吃共享 JS 预算（还会因单段预算耗尽让同一个源时好时坏）。只记忆求值结果，host 门/红线每次对
 * 结果重验；沙箱未就绪抛 SearchJsNotReadyError、不记忆。真实搜索（真书名）不走这里。
 * 联网帧（netjs1029）不联网：首个 java.ajax 未命中即记为 pending（地址每次重验），判定口径见各调用方。
 */
function probeSearchJs(template: string, base: string, net = false): EvaluatedSearchJs {
  const cacheKey = `${searchCjkEncodeUri() ? 1 : 0}${net ? '\0net' : ''}\0${base}\0${template}`;
  let entry = probed.get(cacheKey);
  if (entry !== undefined) {
    probed.delete(cacheKey);
  } else {
    try {
      entry = evaluateSearchJs(template, SEARCH_PROBE_TITLE, base, net ? new Map() : undefined);
    } catch (error) {
      if (error instanceof SearchNetMissError) entry = { pending: error.url };
      else if (!(error instanceof SourcePolicyError)) throw error;
      else entry = { rejected: error.message };
    }
  }
  probed.set(cacheKey, entry);
  while (probed.size > MAX_PROBE_CACHE) probed.delete(probed.keys().next().value!);
  if ('rejected' in entry) throw new SourcePolicyError(entry.rejected);
  if ('pending' in entry) throw new SearchNetMissError(entry.pending);
  return entry;
}

/** 同 buildSearchRequest，书名固定为 SEARCH_PROBE_TITLE、JS 段求值走 probeSearchJs 记忆：只给「能否构造」类判定用。 */
export function buildSearchProbeRequest(
  template: unknown, base: string | undefined, validate: SourceUrlValidator = validateSourceUrl, searchJs = false,
): SourceSearchRequest {
  return withSearchJs(template, SEARCH_PROBE_TITLE, base, validate, searchJs, probeSearchJs).request;
}

/**
 * 候选口径：该需 JS 的模板能否在沙箱里构造出请求（放开 host 白名单，红线照守；占位书名，求值结果记忆见 probeSearchJs）。
 * 联网 JS 模板到首个 java.ajax 为止：地址能解析成请求即算能构造（页面要联网才知道，交准入实测）。
 * 沙箱未就绪抛 SearchJsNotReadyError。调用方先确认 searchTemplateNeedsJs。
 */
export function searchJsConstructible(template: string, base: string): boolean {
  try {
    let evaluated: EvaluatedSearchJs;
    try {
      evaluated = probeSearchJs(template, base, netFrame(template));
    } catch (miss) {
      if (!(miss instanceof SearchNetMissError)) throw miss;
      ajaxRequest(miss.url, allowAnyHost);
      return true;
    }
    const { ruleUrl, baseUrl } = evaluated;
    buildLegadoSearchRequest(ruleUrl, baseUrl, allowAnyHost, optionParity(template, base));
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
