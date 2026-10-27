// searchjs1027（ENGINE_SEARCH_JS，默认关，须 ENGINE_POST_SEARCH 同开）：legado 搜索模板里的 JS 求值。
// 口径照 legado AnalyzeUrl.initUrl（Jer-Chao/legado@c2c4775）：analyzeJs（`<js>…</js>` / `@js:` 逐段求值，段间文本
// 替换 `@result`）→ replaceKeyPageJs（`{{表达式}}` 逐个求值、`<a,b>` 页码取首项）→ analyzeUrl（选项/编码，
// source-parser buildLegadoSearchRequest）。JS 一律在 js-sandbox 的 QuickJS 里跑：无网络/文件/定时器，
// 只绑定 key/page/baseUrl/result/source（只读：getKey/bookSourceUrl/getVariable→''）/cookie（空实现）/book=null；
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

// 沙箱里的 legado 绑定。source/cookie 冻结；__sourceKey 用完即删，规则代码看不到。
const SETUP = `(function(){
  var k = globalThis.__sourceKey; delete globalThis.__sourceKey;
  globalThis.source = Object.freeze({
    key: k, bookSourceUrl: k, variable: '',
    getKey: function(){ return k; }, getBookSourceUrl: function(){ return k; }, getVariable: function(){ return ''; }
  });
  globalThis.cookie = Object.freeze({ getCookie: function(){ return ''; }, removeCookie: function(){} });
  globalThis.book = null;
})();`;

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

interface EvalContext { title: string; baseUrl: string }

function evalSearchJs(code: string, ctx: EvalContext, result: string | null): string {
  const wrapper = `${SETUP}\n${result === null ? 'globalThis.result = null;\n' : ''}`
    + `${result === null ? INLINE_FORMAT : SEGMENT_FORMAT}((0, eval)(${JSON.stringify(code)}))`;
  let value: unknown;
  try {
    value = runJs(wrapper, {
      result: result ?? '',
      baseUrl: ctx.baseUrl,
      globals: { key: ctx.title, page: SEARCH_PAGE, __sourceKey: ctx.baseUrl },
    });
  } catch (error) {
    if (error instanceof RuleEngineError) {
      if (/未就绪|预算耗尽|沙箱异常/.test(error.message)) throw new SearchJsNotReadyError(error.message);
      throw new SourcePolicyError(`不支持该书源的搜索 JS（${error.message}）`);
    }
    throw error;
  }
  if (typeof value !== 'string') throw new SourcePolicyError('不支持该书源的搜索 JS（结果非字符串）');
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

/** legado AnalyzeUrl 的 JS 段与 `{{…}}` 求值 → 交 buildLegadoSearchRequest。base = 书源 bookSourceUrl（带选项时照 legado 剥掉，作相对地址基准）。 */
export function buildSearchJsRequest(
  template: string, title: string, base: string, validate: SourceUrlValidator = validateSourceUrl,
): SourceSearchRequest {
  const split = OPTION_SPLIT.exec(base);
  const ctx: EvalContext = { title, baseUrl: split ? base.slice(0, split.index) : base };
  const ruleUrl = replacePages(replaceInline(analyzeJs(template, ctx), ctx));
  return buildLegadoSearchRequest(ruleUrl, ctx.baseUrl, validate);
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
  try {
    return buildSourceSearchRequest(template, title, base, validate);
  } catch (error) {
    if (!(error instanceof SourcePolicyError) || !searchJs || typeof template !== 'string' || base === undefined
      || !searchTemplateNeedsJs(template, base)) throw error;
    return buildSearchJsRequest(template, title, base, validate);
  }
}

function allowAnyHost(value: unknown, base?: string): URL {
  return checkSourceUrl(value, base, { hostAllowed: () => true });
}

const PROBE_TITLE = '书';
const MAX_CONSTRUCTIBLE_CACHE = 512;
const constructible = new Map<string, boolean>();

/**
 * 候选口径：该需 JS 的模板能否在沙箱里构造出请求（放开 host 白名单，红线照守；占位书名）。结论按
 * base+模板 LRU 记忆；沙箱未就绪抛 SearchJsNotReadyError、不记忆。调用方先确认 searchTemplateNeedsJs。
 */
export function searchJsConstructible(template: string, base: string): boolean {
  const cacheKey = `${base}\0${template}`;
  const hit = constructible.get(cacheKey);
  if (hit !== undefined) {
    constructible.delete(cacheKey);
    constructible.set(cacheKey, hit);
    return hit;
  }
  let ok: boolean;
  try {
    buildSearchJsRequest(template, PROBE_TITLE, base, allowAnyHost);
    ok = true;
  } catch (error) {
    if (!(error instanceof SourcePolicyError)) throw error;
    ok = false;
  }
  constructible.set(cacheKey, ok);
  while (constructible.size > MAX_CONSTRUCTIBLE_CACHE) constructible.delete(constructible.keys().next().value!);
  return ok;
}

/** 求值是同步的：用到搜索 JS 的路径先 await 这里（幂等，并发共享同一次加载）。 */
export function prepareSearchJs(): Promise<void> {
  return preloadJsSandbox();
}
