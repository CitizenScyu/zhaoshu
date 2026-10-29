// 规则 JS 段的隔离执行（jsbox1027，ENGINE_SYNTAX_JS）：QuickJS 编译成 wasm，跑在独立线性内存里——
// 没有文件/网络/进程/定时器，宿主只注入纯计算的 java.* 帮手（编解码/摘要）。parse.ts 编译期先按白名单
// 拒掉依赖宿主状态的代码（book/source/cookie/java.ajax…），这里是第二道：资源上限 + 每次求值新建 runtime。
//
// 资源上限（2026-10-27 quickjs-emscripten 0.32.0 实测，见 RESEARCH-20261026.md）：
// - wasm 线性内存 maximum=64MB 是硬上限：QuickJS 的 setMemoryLimit 可被绕过（Array.fill 循环实测涨到
//   1.5GB），超出时 malloc 返回 NULL、QuickJS 报 out of memory，模块之后照常可用；
// - 栈 128KB：512KB 会先撑爆宿主 V8 栈（宿主 RangeError），64–256KB 都在 QuickJS 内报 stack overflow；
// - 单次 250ms 中断；同一 runtime 过了 deadline 再复用会挂起，所以每次求值都新建 runtime/context（≈0–1ms）。
// 模块加载是异步的（≈20ms），求值是同步的：调用方先 await preloadJsSandbox()，未就绪时求值直接失败。

import { createHash } from 'node:crypto';
import type { QuickJSContext, QuickJSHandle, QuickJSSyncVariant, QuickJSWASMModule } from 'quickjs-emscripten-core';
import { javaCjkCharset, javaUrlEncodeCjk } from '@/lib/source-charset';
import { symmetricCrypt, toNumChapter, type SymOp } from './js-util';
import { t2s } from './t2s';
import type { JElement } from './jsoup-dom';
import {
  decodeJsoupInit, decodeJsoupItems, decodeJsoupValue, exportJsoup, installJsoupHost, JSOUP_PRELUDE, type JsoupListItem, type JsoupMode,
  JsoupSession,
} from './jsoup-shim';
import { RuleEngineError } from './types';

const WASM_INITIAL_PAGES = 256; // 16MB
const WASM_MAXIMUM_PAGES = 1024; // 64MB
const RUNTIME_MEMORY_LIMIT = 16 << 20;
const RUNTIME_STACK_LIMIT = 128 << 10;
const EVAL_DEADLINE_MS = 250;
/** 注入沙箱的单个字符串上限（字符数）。正文页通常 50–200K 字符；超出按求值失败，不截断喂进去。 */
export const MAX_JS_INPUT_CHARS = 1 << 20;
/** 沙箱产出的总字符上限。 */
export const MAX_JS_OUTPUT_CHARS = 2 << 20;
/**
 * 同一段代码在滚动窗口内的累计耗时上限：目录逐条求值时一段死循环代码每条都要等满 250ms，
 * 千章目录就是几分钟。按代码文本计账，超了窗口内直接失败，不再进沙箱。
 */
const CODE_BUDGET_MS = 3_000;
/** 进程内全部 JS 的累计耗时上限（同一窗口）：多源同时撞上慢代码时兜住整个进程。 */
const GLOBAL_BUDGET_MS = 20_000;
/**
 * 每次调用的免计账额度：新建 runtime/context 本身约 0.2–0.5ms（2026-10-27 实测，context 占大头），
 * 万章目录逐条求值光固定开销就有数秒，全额计账会让正常源在大书上撞预算。只记超出额度的部分：
 * 快调用不占预算，慢代码（每次数 ms 起）与死循环照旧按上面两条上限截停；固定开销由章节/页数上限兜住。
 */
const PER_CALL_ALLOWANCE_MS = 1;
const BUDGET_WINDOW_MS = 60_000;
const MAX_TRACKED_CODES = 256;

export type JsValue = string | string[];

/**
 * 列表 JS 的一个条目（listjs1027，runJsItems）：字符串项原样；普通对象项是「自有数据属性 → 值」表——字符串原样、
 * 布尔按 Java Boolean.toString，null/undefined 不入表（legado 键值直取得 null ⇒ 空串），其余值（数字、对象、数组、
 * 函数、访问器）记 null：Rhino 里它们的 toString 口径（Double `1.0`、`[object Object]`…）这里不复现，取到即失败。
 */
export type JsListItem = string | ReadonlyMap<string, string | null>;

export interface JsBindings {
  /** 上一段的结果（首段为页面原文）；数组按 legado 列表注入，带 size()/get()。 */
  result: JsValue;
  /** 页面原文（legado `src`）；条目级字段没有。 */
  src?: string;
  baseUrl: string;
  /** 额外的全局变量（searchjs1027 搜索模板的 key/page 等）；与 result/src/baseUrl/java 同名的被它们覆盖。 */
  globals?: Readonly<Record<string, string | number>>;
  /** 宿主只读对象（bind1028 的 `book`/`chapter`）：名 → 字符串属性表，沙箱里冻结；与 result/src/baseUrl/java 同名的被它们覆盖。 */
  objects?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * 读宿主状态的 java.* 回调（jsget1028 的 getString/getStringList）：实参按字符串传入（缺省/非字符串按 String 转），
   * 返回字符串、字符串数组（带 size()/get()）或 null。同名覆盖纯计算帮手。`extra` = 其后的实参（initjs1028；字符串原样，
   * 其余类型记 null），回调自行决定收不收。
   */
  callbacks?: Readonly<Record<string, (arg: string, extra: readonly (string | null)[]) => JsValue | null>>;
  /**
   * 装对称加解密 / toNumChapter 帮手（jsutil1028，名单见 types.ts JS_JAVA_UTIL_HELPERS）：只给编译期标了 FieldIr.jsUtil 的字段开，
   * 其余求值的沙箱逐字不变。帮手失败与回调一样致命。
   */
  utilHelpers?: boolean;
  /**
   * gbkjs1029：`java.encodeURI(文本, 'gbk'|'gb2312'|'gb18030')` 按 java.net.URLEncoder 的 GBK 系口径编码（source-charset.ts
   * javaUrlEncodeCjk；只给搜索模板求值开，规则字段逐字不变）。不可复现的字符致命失败（try/catch 吞掉也不算数）。
   */
  cjkEncodeUri?: boolean;
  /**
   * jsoup1028 直连 DOM（只经 runJsoup/runJsoupItems 生效）：`result`/`src` 换成 Element/Elements 包装（缺省用上面的字符串），
   * `getElements` 是 `java.getElement(s)("规则")` 的取节点回调（编译期白名单里的规则）。
   */
  jsoup?: {
    readonly result?: JElement | readonly JElement[];
    readonly src?: JElement;
    readonly getElements?: (rule: string) => readonly JElement[];
    /** bookvar1028：`book.getVariable` 得 Java 空串（见 JsoupInit.bookVariables）。 */
    readonly bookVariables?: boolean;
  };
  /**
   * 源的 jsLib 原文（jslib1028，只给编译期挂了 FieldIr.jsLib 的字段传）：prelude 之后、规则代码之前在全局作用域求值，
   * 失败即本次求值失败（legado 共享作用域求值 jsLib 抛错，该源 JS 全部失败）。
   */
  jsLib?: string;
}

let ready: QuickJSWASMModule | undefined;
let loading: Promise<QuickJSWASMModule> | undefined;

/** 加载 wasm 模块（幂等、并发共享同一个 promise；失败后下次调用重试）。 */
export function preloadJsSandbox(): Promise<void> {
  if (ready) return Promise.resolve();
  loading ??= loadModule().then((module) => {
    ready = module;
    return module;
  }, (error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading.then(() => undefined);
}

export function jsSandboxReady(): boolean {
  return ready !== undefined;
}

async function loadModule(): Promise<QuickJSWASMModule> {
  const [core, variantModule] = await Promise.all([
    import('quickjs-emscripten-core'),
    import('@jitl/quickjs-singlefile-cjs-release-sync'),
  ]);
  // CJS 变体经 ESM 导入会被包一到两层 default；必须拆到真正的 variant 对象，否则 newVariant 的
  // `{...baseVariant}` 丢掉 importModuleLoader，wasmMemory 选项被静默忽略（实测踩过）。
  let variant: unknown = variantModule;
  for (let depth = 0; depth < 3 && variant && typeof variant === 'object' && !('importModuleLoader' in variant); depth += 1) {
    variant = (variant as { default?: unknown }).default;
  }
  if (!variant || typeof variant !== 'object' || !('importModuleLoader' in variant)) throw new Error('QuickJS 变体加载失败');
  const memory = new WebAssembly.Memory({ initial: WASM_INITIAL_PAGES, maximum: WASM_MAXIMUM_PAGES });
  return core.newQuickJSWASMModuleFromVariant(
    core.newVariant(variant as QuickJSSyncVariant, { wasmMemory: memory }),
  );
}

/** 宿主级异常（wasm trap 等）后实例状态不可信：丢弃并在后台重新加载。 */
function discardModule(): void {
  ready = undefined;
  loading = undefined;
  void preloadJsSandbox().catch(() => undefined);
}

// ---------------------------------------------------------------- 预算
const codeSpent = new Map<string, { since: number; ms: number }>();
let globalSpent = { since: 0, ms: 0 };

function checkBudget(code: string, now: number): void {
  if (now - globalSpent.since > BUDGET_WINDOW_MS) globalSpent = { since: now, ms: 0 };
  if (globalSpent.ms > GLOBAL_BUDGET_MS) evalFailed('JS 执行预算耗尽（进程）');
  const entry = codeSpent.get(code);
  if (entry && now - entry.since <= BUDGET_WINDOW_MS && entry.ms > CODE_BUDGET_MS) evalFailed('JS 执行预算耗尽（该段代码）');
}

function chargeBudget(code: string, started: number, now: number, elapsed: number): void {
  const ms = Math.max(0, elapsed - PER_CALL_ALLOWANCE_MS);
  globalSpent.ms += ms;
  let entry = codeSpent.get(code);
  if (!entry || now - entry.since > BUDGET_WINDOW_MS) entry = { since: started, ms: 0 };
  entry.ms += ms;
  codeSpent.delete(code); // 触达即续期（Map 插入序 = LRU 序）
  codeSpent.set(code, entry);
  while (codeSpent.size > MAX_TRACKED_CODES) codeSpent.delete(codeSpent.keys().next().value!);
}

// ---------------------------------------------------------------- java.* 纯计算帮手
// 名单见 types.ts JS_JAVA_HELPERS（parse.ts 编译期白名单同源）；log/toast/longToast 在 PRELUDE 里实现。

function utf8Only(charset: string | undefined, helper: string): void {
  if (charset !== undefined && !/^utf-?8$/i.test(charset.trim())) throw new Error(`java.${helper} 只支持 UTF-8`);
}

/** legado JsExtensions.encodeURI = java.net.URLEncoder.encode(str, enc)：表单编码，空格→`+`，只保留 `A-Za-z0-9.-*_`。 */
function urlEncoderEncode(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9.\-*_]/.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const HOST_HELPERS: Record<string, (args: (string | undefined)[]) => string> = {
  base64Decode: ([text = '', charset]) => {
    utf8Only(charset, 'base64Decode');
    return Buffer.from(text, 'base64').toString('utf8');
  },
  base64Encode: ([text = '']) => Buffer.from(text, 'utf8').toString('base64'),
  md5Encode: ([text = '']) => createHash('md5').update(text, 'utf8').digest('hex'),
  md5Encode16: ([text = '']) => createHash('md5').update(text, 'utf8').digest('hex').slice(8, 24),
  encodeURI: ([text = '', charset]) => {
    utf8Only(charset, 'encodeURI');
    return urlEncoderEncode(text);
  },
  hexDecodeToString: ([hex = '']) => Buffer.from(hex, 'hex').toString('utf8'),
};

// log/toast 在 legado 里返回入参（log 可串在表达式中间），沙箱内直接用 JS 实现；result 列表与 getStringList（jsget1028）
// 的结果补 legado NativeJavaList 的 size()/get()；宿主只读对象（bind1028 book/chapter）冻结。
const PRELUDE = `(function(){
  var j = globalThis.java;
  j.log = function(m){ return m; }; j.toast = function(m){ return m; }; j.longToast = function(m){ return m; };
  function asList(r) {
    Object.defineProperty(r, 'size', { value: function(){ return this.length; } });
    Object.defineProperty(r, 'get', { value: function(i){ return this[i]; } });
    return r;
  }
  if (typeof j.getStringList === 'function') {
    var g = j.getStringList;
    j.getStringList = function(rule){ var r = g(rule); return Array.isArray(r) ? asList(r) : r; };
  }
  Object.freeze(j);
  if (typeof globalThis.book === 'object' && globalThis.book) Object.freeze(globalThis.book);
  if (typeof globalThis.chapter === 'object' && globalThis.chapter) Object.freeze(globalThis.chapter);
  if (Array.isArray(globalThis.result)) asList(globalThis.result);
})();`;

// jsutil1028：加解密 / toNumChapter / t2s（t2s1029）帮手，排在 PRELUDE 前（PRELUDE 末尾冻结 java）。宿主函数藏在 __jsutil 里，闭包取走后删掉全局。
// 实参严格按 legado 的 Kotlin 签名：个数不对、非字符串（null 只在可空处放行）、含孤立代理项一律经 bad() 致命失败。
// createSymmetricCrypto 返回代理：只有 decryptStr/encryptBase64/encryptHex 三个方法，碰其他属性（decrypt/encrypt、toString…）致命。
const UTIL_PRELUDE = `(function(){
  var u = globalThis.__jsutil, j = globalThis.java;
  delete globalThis.__jsutil;
  var bad = u.bad, sym = u.sym, num = u.num, t2 = u.t2s, P = Proxy, S = String;
  var cca = Function.prototype.call.bind(String.prototype.charCodeAt);
  var hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  function str(v, what) {
    if (typeof v !== 'string') bad(what + ' 不是字符串');
    for (var i = 0; i < v.length; i++) {
      var c = cca(v, i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        var d = cca(v, i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { i++; continue; }
        bad(what + ' 含孤立代理项');
      }
      if (c >= 0xDC00 && c <= 0xDFFF) bad(what + ' 含孤立代理项');
    }
    return v;
  }
  function arity(n, want, name) { if (n !== want) bad(name + ' 的参数个数不对'); }
  j.createSymmetricCrypto = function(t, key, iv) {
    var n = arguments.length;
    if (n !== 2 && n !== 3) bad('createSymmetricCrypto 的参数个数不对');
    str(t, 'transformation'); str(key, 'key');
    var v = n === 3 && iv !== null ? str(iv, 'iv') : '';
    sym('check', t, key, v, '');
    function op(name) {
      return function(data) { arity(arguments.length, 1, name); return sym(name, t, key, v, str(data, 'data')); };
    }
    var ops = { decryptStr: op('decryptStr'), encryptBase64: op('encryptBase64'), encryptHex: op('encryptHex') };
    function deny(o, p) { bad('SymmetricCrypto.' + S(p)); }
    return new P(ops, {
      get: function(o, p) { if (typeof p === 'string' && hasOwn(o, p)) return o[p]; deny(o, p); },
      set: deny, defineProperty: deny, deleteProperty: deny,
    });
  };
  function dep(name, op) {
    j[name] = function(data, key, t, iv) {
      arity(arguments.length, 4, name);
      return sym(op, str(t, 'transformation'), str(key, 'key'), str(iv, 'iv'), str(data, 'data'));
    };
  }
  dep('aesBase64DecodeToString', 'decryptStr'); dep('aesDecodeToString', 'decryptStr');
  dep('desDecodeToString', 'decryptStr'); dep('desBase64DecodeToString', 'decryptStr');
  dep('aesEncodeToBase64String', 'encryptBase64'); dep('desEncodeToBase64String', 'encryptBase64');
  function dep3(name, op) {
    j[name] = function(data, key, mode, padding, iv) {
      arity(arguments.length, 5, name);
      var t = 'DESede/' + str(mode, 'mode') + '/' + str(padding, 'padding');
      return sym(op, t, str(key, 'key'), str(iv, 'iv'), str(data, 'data'));
    };
  }
  dep3('tripleDESDecodeStr', 'decryptStr'); dep3('tripleDESEncodeBase64Str', 'encryptBase64');
  j.toNumChapter = function(s) {
    arity(arguments.length, 1, 'toNumChapter');
    return s === null ? null : num(str(s, 'toNumChapter 实参'));
  };
  j.t2s = function(s) {
    arity(arguments.length, 1, 't2s');
    return t2(str(s, 't2s 实参'));
  };
})();
`;

const SYM_OPS: ReadonlySet<string> = new Set<SymOp | 'check'>(['check', 'decryptStr', 'encryptBase64', 'encryptHex']);

// ---------------------------------------------------------------- 求值
/**
 * 同步执行一段规则 JS，返回值按 legado 口径转换：null/undefined → null（legado RhinoScriptEngine 把 Undefined
 * 解包成 null，getString 链随即中止得空串）；数组 → 字符串数组（逐项 String，null/undefined 项为 ''）；
 * 其余 String(value)。任何失败（语法错、运行时异常、超时、超内存、预算耗尽、未加载）都是 RULE_EVAL_FAILED。
 */
export function runJs(code: string, bindings: JsBindings, budgetKey = code): JsValue | null {
  return execute(code, bindings, exportValue, budgetKey);
}

/**
 * 列表字段的 JS 段（listjs1027，legado AnalyzeRule.getElements 的 `evalJS(...) as List<Any>`）：null/undefined → null
 * （legado 得空列表）；数组 → 逐项 JsListItem；字符串、数字、非数组对象 → 求值失败（legado 强转 List 抛 ClassCastException）；
 * 数组里有字符串/普通对象以外的项 → 求值失败（legado 拿它 setContent，按 toString 再解析，口径不复现）。
 * 沙箱里只做序列化，形状由宿主逐项校验，不信任沙箱产出。资源上限、预算与 runJs 同一套。
 */
export function runJsItems(code: string, bindings: JsBindings): JsListItem[] | null {
  return execute(code, bindings, exportItems);
}

/**
 * 详情页 JS init（initjs1028，legado BookInfo `setContent(getElement(init))` 的 `evalJS`）：字符串原样；普通对象 → 键值表
 * （口径同 runJsItems 的对象项）；null/undefined（legado setContent(null) 断言失败）、数组、数字等一律求值失败。
 */
export function runJsInit(code: string, bindings: JsBindings, budgetKey = code): string | ReadonlyMap<string, string | null> {
  return execute(code, bindings, exportInitValue, budgetKey) ?? evalFailed('init JS 返回了 null/undefined（legado setContent(null)）');
}

/**
 * jsoup1028 字符串链的 JS 段：沙箱里装 jsoup 包装（jsoup-shim.ts）。`mode` 决定 Element/Java 字符串能否流出本段：
 * final（末段/后接正则）按 legado getString 口径转字符串；mid（后接规则）与 midjs（后接 JS）遇 Element 失败，midjs 遇 Java 字符串也失败。
 */
export function runJsoup(code: string, bindings: JsBindings, mode: JsoupMode, budgetKey = code): JsValue | null {
  const session = new JsoupSession(bindings.jsoup?.getElements);
  return execute(code, bindings, (context, handle) => decodeJsoupValue(exportJsoup(context, handle, session, mode)), budgetKey, session);
}

/**
 * initjsoup1028 详情页 JS init 的 jsoup 口径（FieldIr.jsoup）：沙箱装 jsoup 包装，返回值口径见 jsoup-shim.ts decodeJsoupInit
 * （字符串含 Java 字符串原样、普通对象 → 键值表、Element/Elements 失败）；null/undefined 同 runJsInit 失败。
 */
export function runJsoupInit(code: string, bindings: JsBindings, budgetKey = code): string | ReadonlyMap<string, string | null> {
  const session = new JsoupSession(bindings.jsoup?.getElements);
  return execute(code, bindings, (context, handle) => decodeJsoupInit(exportJsoup(context, handle, session, 'init'), session), budgetKey, session)
    ?? evalFailed('init JS 返回了 null/undefined（legado setContent(null)）');
}

/** jsoup1028 列表字段末段 JS：Elements 与数组里的 Element 逐个成为条目，其余口径同 runJsItems。 */
export function runJsoupItems(code: string, bindings: JsBindings): JsoupListItem[] | null {
  const session = new JsoupSession(bindings.jsoup?.getElements);
  return execute(code, bindings, (context, handle) => decodeJsoupItems(exportJsoup(context, handle, session, 'items'), session), code, session);
}

/** `budgetKey`：按哪段代码记预算（jsext1028 makeUp 后的代码随占位值变，按段原文记，免得每次换键绕过单段预算）。 */
function execute<T>(
  code: string, bindings: JsBindings, exporter: (context: QuickJSContext, handle: QuickJSHandle) => T | null,
  budgetKey = code, session?: JsoupSession,
): T | null {
  const wasm = ready;
  if (!wasm) return evalFailed('JS 沙箱未就绪');
  // 首段 result 就是 src（installGlobals 复用同一句柄），只计一次。
  const results = typeof bindings.result === 'string'
    ? (bindings.result === bindings.src ? [] : [bindings.result])
    : bindings.result;
  const inputs = [...results, bindings.src ?? '', bindings.baseUrl];
  for (const value of Object.values(bindings.globals ?? {})) if (typeof value === 'string') inputs.push(value);
  for (const props of Object.values(bindings.objects ?? {})) inputs.push(...Object.values(props));
  if (inputs.reduce((sum, text) => sum + text.length, 0) > MAX_JS_INPUT_CHARS * 2
    || inputs.some((text) => text.length > MAX_JS_INPUT_CHARS)) return evalFailed('JS 输入过大');
  const started = Date.now();
  const startedPrecise = performance.now();
  checkBudget(budgetKey, started);
  try {
    return runInFreshRuntime(wasm, code, bindings, started + EVAL_DEADLINE_MS, exporter, session);
  } catch (error) {
    if (error instanceof RuleEngineError) throw error;
    discardModule();
    return evalFailed(`JS 沙箱异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    chargeBudget(budgetKey, started, Date.now(), performance.now() - startedPrecise);
  }
}

function runInFreshRuntime<T>(
  module: QuickJSWASMModule, code: string, bindings: JsBindings, deadline: number,
  exporter: (context: QuickJSContext, handle: QuickJSHandle) => T | null, session?: JsoupSession,
): T | null {
  const runtime = module.newRuntime();
  try {
    runtime.setMemoryLimit(RUNTIME_MEMORY_LIMIT);
    runtime.setMaxStackSize(RUNTIME_STACK_LIMIT);
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const context = runtime.newContext();
    try {
      const host = installGlobals(context, bindings);
      if (session) installJsoupHost(context, session, host, bindings.jsoup);
      const prelude = context.evalCode(session
        ? (bindings.utilHelpers ? UTIL_PRELUDE : '') + JSOUP_PRELUDE + PRELUDE
        : bindings.utilHelpers ? UTIL_PRELUDE + PRELUDE : PRELUDE, 'prelude.js');
      if (prelude.error) {
        prelude.error.dispose();
        return evalFailed('JS 沙箱初始化失败');
      }
      prelude.value.dispose();
      if (bindings.jsLib !== undefined) {
        const lib = context.evalCode(bindings.jsLib, 'lib.js');
        if (lib.error) {
          const message = describeError(context, lib.error);
          lib.error.dispose();
          return evalFailed(`jsLib 求值失败：${message}`);
        }
        lib.value.dispose();
      }
      const evaluated = context.evalCode(code, 'rule.js');
      // 宿主回调失败（jsget1028）一律致命：JS 里 try/catch 吞掉也不算数，免得规则拿兜底分支冒充 legado 产出。
      if (host.failure !== undefined) {
        (evaluated.error ?? evaluated.value).dispose();
        if (host.failure instanceof RuleEngineError) throw host.failure;
        return evalFailed(`JS 宿主回调失败：${host.failure instanceof Error ? host.failure.message : String(host.failure)}`);
      }
      if (evaluated.error) {
        const message = describeError(context, evaluated.error);
        evaluated.error.dispose();
        return evalFailed(`JS 执行失败：${message}`);
      }
      try {
        return exporter(context, evaluated.value);
      } finally {
        evaluated.value.dispose();
      }
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

/** 返回宿主回调的失败记录（runInFreshRuntime 执行后检查）。 */
function installGlobals(context: QuickJSContext, bindings: JsBindings): { failure?: unknown } {
  const host: { failure?: unknown } = {};
  const setGlobal = (name: string, handle: QuickJSHandle) => {
    context.setProp(context.global, name, handle);
  };
  for (const [name, value] of Object.entries(bindings.globals ?? {})) {
    const handle = typeof value === 'number' ? context.newNumber(value) : context.newString(value);
    setGlobal(name, handle);
    handle.dispose();
  }
  for (const [name, props] of Object.entries(bindings.objects ?? {})) {
    const object = context.newObject();
    for (const [key, value] of Object.entries(props)) {
      const handle = context.newString(value);
      context.setProp(object, key, handle);
      handle.dispose();
    }
    setGlobal(name, object);
    object.dispose();
  }
  const baseUrl = context.newString(bindings.baseUrl);
  setGlobal('baseUrl', baseUrl);
  baseUrl.dispose();
  const src = bindings.src === undefined ? undefined : context.newString(bindings.src);
  if (src) setGlobal('src', src);
  if (typeof bindings.result === 'string') {
    // 首段 result 就是页面原文：复用同一个句柄，不在沙箱里存两份。
    const result = src && bindings.result === bindings.src ? src : context.newString(bindings.result);
    setGlobal('result', result);
    if (result !== src) result.dispose();
  } else {
    const list = context.newArray();
    bindings.result.forEach((item, index) => {
      const value = context.newString(item);
      context.setProp(list, index, value);
      value.dispose();
    });
    setGlobal('result', list);
    list.dispose();
  }
  src?.dispose();
  const java = context.newObject();
  for (const [name, impl] of Object.entries(HOST_HELPERS)) {
    const fn = context.newFunction(name, (...args) => {
      const texts = args.map((arg) => (context.typeof(arg) === 'undefined' ? undefined : context.getString(arg)));
      const cjk = bindings.cjkEncodeUri && name === 'encodeURI' ? javaCjkCharset(texts[1]) : null;
      let out: string;
      if (cjk) {
        try {
          out = javaUrlEncodeCjk(texts[0] ?? '', cjk);
        } catch (error) {
          host.failure ??= error;
          throw error;
        }
      } else {
        out = impl(texts);
      }
      if (out.length > MAX_JS_OUTPUT_CHARS) throw new Error(`java.${name} 输出过大`);
      return context.newString(out);
    });
    context.setProp(java, name, fn);
    fn.dispose();
  }
  for (const [name, impl] of Object.entries(bindings.callbacks ?? {})) {
    const fn = context.newFunction(name, (arg, ...rest) => {
      let out: JsValue | null;
      try {
        const extra = rest.map((handle) => (context.typeof(handle) === 'string' ? context.getString(handle) : null));
        out = impl(arg === undefined ? 'undefined' : context.getString(arg), extra);
        const size = out === null ? 0 : typeof out === 'string' ? out.length : out.reduce((sum, item) => sum + item.length, 0);
        if (size > MAX_JS_OUTPUT_CHARS) throw new Error(`java.${name} 输出过大`);
      } catch (error) {
        host.failure ??= error;
        throw error;
      }
      if (out === null) return context.null;
      if (typeof out === 'string') return context.newString(out);
      const list = context.newArray();
      out.forEach((item, index) => {
        const value = context.newString(item);
        context.setProp(list, index, value);
        value.dispose();
      });
      return list;
    });
    context.setProp(java, name, fn);
    fn.dispose();
  }
  setGlobal('java', java);
  java.dispose();
  if (bindings.utilHelpers) installUtilHost(context, host);
  return host;
}

/** jsutil1028 的宿主函数（UTIL_PRELUDE 包装）：失败记进 host.failure，与 getter 回调一样致命。 */
function installUtilHost(context: QuickJSContext, host: { failure?: unknown }): void {
  const util = context.newObject();
  const add = (name: string, impl: (args: string[]) => string) => {
    const fn = context.newFunction(name, (...args) => {
      try {
        const out = impl(args.map((arg) => context.getString(arg)));
        if (out.length > MAX_JS_OUTPUT_CHARS) throw new Error(`java 帮手 ${name} 输出过大`);
        return context.newString(out);
      } catch (error) {
        host.failure ??= error;
        throw error;
      }
    });
    context.setProp(util, name, fn);
    fn.dispose();
  };
  add('sym', ([op, transformation, key, iv, data]) => {
    if (!SYM_OPS.has(op)) throw new Error('未知的加解密操作');
    return symmetricCrypt(op as SymOp | 'check', transformation, key, iv, data);
  });
  add('num', ([text]) => toNumChapter(text));
  add('t2s', ([text]) => t2s(text));
  add('bad', ([what]) => {
    throw new Error(`java 帮手不支持：${what}`);
  });
  context.setProp(context.global, '__jsutil', util);
  util.dispose();
}

function exportValue(context: QuickJSContext, handle: QuickJSHandle): JsValue | null {
  const type = context.typeof(handle);
  if (type === 'undefined') return null;
  if (type === 'string') return checkedOutput(context.getString(handle));
  if (type === 'object') {
    if (isNull(context, handle)) return null;
    if (isArray(context, handle)) {
      const lengthHandle = context.getProp(handle, 'length');
      const length = context.getNumber(lengthHandle);
      lengthHandle.dispose();
      const items: string[] = [];
      let total = 0;
      for (let index = 0; index < length; index += 1) {
        const item = context.getProp(handle, index);
        try {
          const text = exportScalar(context, item);
          total += text.length;
          if (total > MAX_JS_OUTPUT_CHARS) return evalFailed('JS 输出过大');
          items.push(text);
        } finally {
          item.dispose();
        }
      }
      return items;
    }
  }
  return exportScalar(context, handle);
}

/**
 * 列表 JS 结果的沙箱内序列化（listjs1027）：只读自有属性描述符（不触发 getter），对象项建成无原型对象（`__proto__`
 * 键也落成自有属性）。返回 JSON 文本：`null` / `"string"` / `"other"` / `"item"` / 条目数组（对象项的不可复现值记 0）。
 */
const ITEMS_SERIALIZER = `(function(v){
  if (v === undefined || v === null) return 'null';
  if (!Array.isArray(v)) return typeof v === 'string' ? '"string"' : '"other"';
  var out = [], getProto = Object.getPrototypeOf, own = Object.getOwnPropertyDescriptor, names = Object.getOwnPropertyNames;
  var OP = Object.prototype, make = Object.create, len = v.length;
  for (var i = 0; i < len; i++) {
    var it = v[i];
    if (typeof it === 'string') { out.push(it); continue; }
    if (it === null || typeof it !== 'object' || Array.isArray(it)) return '"item"';
    var p = getProto(it);
    if (p !== OP && p !== null) return '"item"';
    var o = make(null), keys = names(it);
    for (var k = 0; k < keys.length; k++) {
      var d = own(it, keys[k]), x = d.value;
      if (d.get || d.set) o[keys[k]] = 0;
      else if (typeof x === 'string') o[keys[k]] = x;
      else if (typeof x === 'boolean') o[keys[k]] = x ? 'true' : 'false';
      else if (x !== null && x !== undefined) o[keys[k]] = 0;
    }
    out.push(o);
  }
  return JSON.stringify(out);
})`;

/** runJsInit 的导出：套成单元素数组走 ITEMS_SERIALIZER，宿主照旧逐项校验。 */
function exportInitValue(context: QuickJSContext, handle: QuickJSHandle): string | ReadonlyMap<string, string | null> | null {
  const type = context.typeof(handle);
  if (type === 'undefined' || (type === 'object' && isNull(context, handle))) return null;
  if (type === 'string') return checkedOutput(context.getString(handle));
  if (type !== 'object' || isArray(context, handle)) return evalFailed('init JS 返回的不是字符串/普通对象');
  const wrapper = context.newArray();
  try {
    context.setProp(wrapper, 0, handle);
    const items = exportItems(context, wrapper, 'init JS');
    const item = items?.[0];
    if (items?.length !== 1 || item === undefined || typeof item === 'string') return evalFailed('init JS 结果异常');
    return item;
  } finally {
    wrapper.dispose();
  }
}

function exportItems(context: QuickJSContext, handle: QuickJSHandle, what = '列表 JS'): JsListItem[] | null {
  const serializer = context.evalCode(ITEMS_SERIALIZER, 'items.js');
  if (serializer.error) {
    serializer.error.dispose();
    return evalFailed('JS 沙箱初始化失败');
  }
  let text: string;
  try {
    const called = context.callFunction(serializer.value, context.undefined, handle);
    if (called.error) {
      const message = describeError(context, called.error);
      called.error.dispose();
      return evalFailed(`${what} 结果无法读取：${message}`);
    }
    try {
      text = context.typeof(called.value) === 'string' ? checkedOutput(context.getString(called.value)) : '';
    } finally {
      called.value.dispose();
    }
  } finally {
    serializer.value.dispose();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return evalFailed('列表 JS 结果异常');
  }
  if (parsed === null) return null;
  if (parsed === 'string') return evalFailed('列表 JS 返回了字符串（legado getElements 强转 List 失败）');
  if (parsed === 'other') return evalFailed('列表 JS 返回的不是数组（legado getElements 强转 List 失败）');
  if (parsed === 'item') return evalFailed(`${what === '列表 JS' ? '列表 JS 数组含' : `${what} 返回了`}字符串/普通对象以外的项`);
  if (!Array.isArray(parsed)) return evalFailed('列表 JS 结果异常');
  return parsed.map((item: unknown): JsListItem => {
    if (typeof item === 'string') return item;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return evalFailed('列表 JS 结果异常');
    const entries = new Map<string, string | null>();
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'string') entries.set(key, value);
      else if (value === 0) entries.set(key, null);
      else return evalFailed('列表 JS 结果异常');
    }
    return entries;
  });
}

function exportScalar(context: QuickJSContext, handle: QuickJSHandle): string {
  const type = context.typeof(handle);
  if (type === 'undefined' || (type === 'object' && isNull(context, handle))) return '';
  // getString 走 JS_ToCString（即 String(v)）：对象调其 toString，数字按 JS 口径。
  return checkedOutput(context.getString(handle));
}

function checkedOutput(text: string): string {
  return text.length > MAX_JS_OUTPUT_CHARS ? evalFailed('JS 输出过大') : text;
}

function isNull(context: QuickJSContext, handle: QuickJSHandle): boolean {
  return context.sameValue(handle, context.null);
}

function isArray(context: QuickJSContext, handle: QuickJSHandle): boolean {
  const arrayCtor = context.getProp(context.global, 'Array');
  const isArrayFn = context.getProp(arrayCtor, 'isArray');
  try {
    const result = context.callFunction(isArrayFn, arrayCtor, handle);
    if (result.error) {
      result.error.dispose();
      return false;
    }
    const value = context.typeof(result.value) === 'boolean' && context.dump(result.value) === true;
    result.value.dispose();
    return value;
  } finally {
    isArrayFn.dispose();
    arrayCtor.dispose();
  }
}

/** 错误只取 name: message 前 200 字，不回显代码与页面内容。 */
function describeError(context: QuickJSContext, error: QuickJSHandle): string {
  let text: string;
  try {
    const dumped: unknown = context.dump(error);
    if (dumped && typeof dumped === 'object') {
      const { name, message } = dumped as { name?: unknown; message?: unknown };
      text = `${typeof name === 'string' ? name : 'Error'}: ${typeof message === 'string' ? message : ''}`;
    } else {
      text = String(dumped);
    }
  } catch {
    text = 'unknown error';
  }
  return text.slice(0, 200);
}

function evalFailed(message: string): never {
  throw new RuleEngineError('RULE_EVAL_FAILED', message);
}
