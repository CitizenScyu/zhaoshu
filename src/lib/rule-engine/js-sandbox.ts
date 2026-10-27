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

export interface JsBindings {
  /** 上一段的结果（首段为页面原文）；数组按 legado 列表注入，带 size()/get()。 */
  result: JsValue;
  /** 页面原文（legado `src`）；条目级字段没有。 */
  src?: string;
  baseUrl: string;
  /** 额外的全局变量（searchjs1027 搜索模板的 key/page 等）；与 result/src/baseUrl/java 同名的被它们覆盖。 */
  globals?: Readonly<Record<string, string | number>>;
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

// log/toast 在 legado 里返回入参（log 可串在表达式中间），沙箱内直接用 JS 实现；result 列表补 legado
// NativeJavaList 的 size()/get()。
const PRELUDE = `(function(){
  var j = globalThis.java;
  j.log = function(m){ return m; }; j.toast = function(m){ return m; }; j.longToast = function(m){ return m; };
  Object.freeze(j);
  var r = globalThis.result;
  if (Array.isArray(r)) {
    Object.defineProperty(r, 'size', { value: function(){ return this.length; } });
    Object.defineProperty(r, 'get', { value: function(i){ return this[i]; } });
  }
})();`;

// ---------------------------------------------------------------- 求值
/**
 * 同步执行一段规则 JS，返回值按 legado 口径转换：null/undefined → null（legado RhinoScriptEngine 把 Undefined
 * 解包成 null，getString 链随即中止得空串）；数组 → 字符串数组（逐项 String，null/undefined 项为 ''）；
 * 其余 String(value)。任何失败（语法错、运行时异常、超时、超内存、预算耗尽、未加载）都是 RULE_EVAL_FAILED。
 */
export function runJs(code: string, bindings: JsBindings): JsValue | null {
  const module = ready;
  if (!module) return evalFailed('JS 沙箱未就绪');
  // 首段 result 就是 src（installGlobals 复用同一句柄），只计一次。
  const results = typeof bindings.result === 'string'
    ? (bindings.result === bindings.src ? [] : [bindings.result])
    : bindings.result;
  const inputs = [...results, bindings.src ?? '', bindings.baseUrl];
  for (const value of Object.values(bindings.globals ?? {})) if (typeof value === 'string') inputs.push(value);
  if (inputs.reduce((sum, text) => sum + text.length, 0) > MAX_JS_INPUT_CHARS * 2
    || inputs.some((text) => text.length > MAX_JS_INPUT_CHARS)) return evalFailed('JS 输入过大');
  const started = Date.now();
  const startedPrecise = performance.now();
  checkBudget(code, started);
  try {
    return runInFreshRuntime(module, code, bindings, started + EVAL_DEADLINE_MS);
  } catch (error) {
    if (error instanceof RuleEngineError) throw error;
    discardModule();
    return evalFailed(`JS 沙箱异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    chargeBudget(code, started, Date.now(), performance.now() - startedPrecise);
  }
}

function runInFreshRuntime(module: QuickJSWASMModule, code: string, bindings: JsBindings, deadline: number): JsValue | null {
  const runtime = module.newRuntime();
  try {
    runtime.setMemoryLimit(RUNTIME_MEMORY_LIMIT);
    runtime.setMaxStackSize(RUNTIME_STACK_LIMIT);
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const context = runtime.newContext();
    try {
      installGlobals(context, bindings);
      const prelude = context.evalCode(PRELUDE, 'prelude.js');
      if (prelude.error) {
        prelude.error.dispose();
        return evalFailed('JS 沙箱初始化失败');
      }
      prelude.value.dispose();
      const evaluated = context.evalCode(code, 'rule.js');
      if (evaluated.error) {
        const message = describeError(context, evaluated.error);
        evaluated.error.dispose();
        return evalFailed(`JS 执行失败：${message}`);
      }
      try {
        return exportValue(context, evaluated.value);
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

function installGlobals(context: QuickJSContext, bindings: JsBindings): void {
  const setGlobal = (name: string, handle: QuickJSHandle) => {
    context.setProp(context.global, name, handle);
  };
  for (const [name, value] of Object.entries(bindings.globals ?? {})) {
    const handle = typeof value === 'number' ? context.newNumber(value) : context.newString(value);
    setGlobal(name, handle);
    handle.dispose();
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
      const out = impl(texts);
      if (out.length > MAX_JS_OUTPUT_CHARS) throw new Error(`java.${name} 输出过大`);
      return context.newString(out);
    });
    context.setProp(java, name, fn);
    fn.dispose();
  }
  setGlobal('java', java);
  java.dispose();
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
