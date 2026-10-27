// 174 源 compile 冒烟支撑：把 survey.py 的初筛函数移植为 TS（select_candidates），
// 并对核心字段口径跑 parseFieldRule。供 admission-smoke.test.ts 消费。
// 设计依据：m1-engine-design.md v3 §8.2；移植逻辑参考 .rule-survey/survey.py。

import { upgradeSourceTemplateUrl } from '@/lib/source-policy';
import { searchOptionsConstructible, searchTemplateNeedsJs } from '@/lib/source-parser';
import { jsChainFieldAllowed, parseFieldRule, ruleHasJs, type ParseOptions } from './parse';
import { aioGroupsFlat, ruleGroupOf } from './aio-syntax';
import { searchJsConstructible } from './search-js';
import { engineSearchJsEnabled, engineSyntaxAioEnabled, engineSyntaxJsEnabled } from './syntax-flags';
import { RuleEngineError, type RuleDiagnostic } from './types';

// survey.py CORE_FIELDS（阅读路径必需字段）
export const CORE_FIELDS = [
  'ruleSearch.bookList',
  'ruleSearch.bookUrl',
  'ruleSearch.name',
  'ruleSearch.author',
  'ruleBookInfo.name',
  'ruleBookInfo.author',
  'ruleBookInfo.tocUrl',
  'ruleToc.chapterList',
  'ruleToc.chapterName',
  'ruleToc.chapterUrl',
  'ruleToc.nextTocUrl',
  'ruleContent.content',
  'ruleContent.nextContentUrl',
] as const;

const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleContent', 'ruleToc', 'ruleExplore'] as const;

/** ENGINE_POST_SEARCH 开关（41-postsearch）：开时引擎搜索支持 POST/body/charset、口径放开安全选项源。默认关，关时行为逐字不变。 */
export function enginePostSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENGINE_POST_SEARCH === '1' || env.ENGINE_POST_SEARCH === 'true';
}

/** 搜索模板 JS（searchjs1027）实际生效：ENGINE_SEARCH_JS 只在 ENGINE_POST_SEARCH 开时起作用（新路径产出的是结构化请求）。 */
export function engineSearchJsActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return enginePostSearchEnabled(env) && engineSearchJsEnabled(env);
}

/**
 * ADMISSION_NONCORE_JS 开关（js-1026）：开时初筛的「无 JS」只查阅读路径字段（CORE_FIELDS + 下面的阻断字段），
 * 装饰字段（coverUrl/intro/kind/lastChapter、ruleExplore.* 等）带 JS 不再整源拒——引擎本就从不执行 JS
 * （parse.ts 判 unsupported、compileSource 标 skipped，§3.4 装饰字段置空继续），运行时可用性门
 * （source-usability missingEngineFields）也只看必需字段。2026-10-26 现网 538 源只因装饰字段 JS 被拒。
 * 默认关，关时行为逐字不变；web/runner/download 三处 env 须同开同关，否则确认轮会把对侧放行的源判回 T7。
 */
export function admissionNoncoreJsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADMISSION_NONCORE_JS === '1' || env.ADMISSION_NONCORE_JS === 'true';
}

/**
 * 非核心但改变阅读路径结果的字段：详情页预处理、正文 webView 脚本、资源嗅探、目录前置脚本。
 * 引擎不实现这些语义，其中带 JS 说明源依赖脚本才能读出核心内容——开关开时照旧整源拒。
 */
export const READING_PATH_JS_FIELDS = [
  'ruleBookInfo.init', 'ruleContent.webJs', 'ruleContent.sourceRegex', 'ruleToc.preUpdateJs',
] as const;

export interface RawSource {
  bookSourceUrl?: unknown;
  bookSourceName?: unknown;
  bookSourceType?: unknown;
  searchUrl?: unknown;
  ruleSearch?: Record<string, unknown>;
  ruleBookInfo?: Record<string, unknown>;
  ruleToc?: Record<string, unknown>;
  ruleContent?: Record<string, unknown>;
  ruleExplore?: Record<string, unknown>;
  [k: string]: unknown;
}

/** yield [字段全名, 规则字符串] for every non-empty string rule value. */
export function* iterRulePairs(src: RawSource): Generator<[string, string]> {
  for (const group of RULE_GROUPS) {
    const g = src[group];
    if (g && typeof g === 'object' && !Array.isArray(g)) {
      for (const [k, v] of Object.entries(g)) {
        if (typeof v === 'string' && v.trim()) yield [`${group}.${k}`, v];
      }
    }
  }
}

const READING_PATH_FIELDS: ReadonlySet<string> = new Set([...CORE_FIELDS, ...READING_PATH_JS_FIELDS]);

/** 源带 jsLib（公共函数库）：引擎沙箱不执行 jsLib，含 JS 段照样判拒（与 compile.ts sourceHasJsLib 同口径）。 */
export function hasJsLib(src: RawSource): boolean {
  const lib = src.jsLib;
  return typeof lib === 'string' && lib.trim() !== '';
}

/**
 * 该源此刻是否开 JS 链（jsbox1027）：ENGINE_SYNTAX_JS on 且无 jsLib。编译（compile.ts）、准入初筛
 * （selectCandidates 的 coreJs）、准入求值（admission.ts）三处必须同一判据，否则会把对侧拒的源放进来。
 */
export function jsChainEnabledFor(src: RawSource, env: NodeJS.ProcessEnv = process.env): boolean {
  return engineSyntaxJsEnabled(env) && !hasJsLib(src);
}

/** 该源是否有字段会走 JS 链（白名单字段里含 JS 段）——用来决定要不要预加载沙箱。 */
export function sourceHasJsChainField(src: RawSource): boolean {
  for (const [field, rule] of iterRulePairs(src)) {
    if (jsChainFieldAllowed(field) && ruleHasJs(rule)) return true;
  }
  return false;
}

/**
 * 准入初筛选项的唯一口径：compileAdmission（滤网 1）与 shuyuan admitRows 候选筛必须同一判据。
 * 2026-10-27 修：admitRows 只传 postSearch/noncoreJs、漏了 coreJs，ENGINE_SYNTAX_JS 开时核心字段带 JS 的源
 * 在候选筛就被拒、根本进不了评估环（离线 sim 直接调 compileAdmission，量不出这个缺口）。
 */
export function admissionSurveyOptions(
  src: RawSource, env: NodeJS.ProcessEnv = process.env,
): { postSearch: boolean; noncoreJs: boolean; coreJs: boolean; searchJs: boolean } {
  return {
    postSearch: enginePostSearchEnabled(env),
    noncoreJs: admissionNoncoreJsEnabled(env),
    coreJs: jsChainEnabledFor(src, env),
    searchJs: engineSearchJsActive(env),
  };
}

/**
 * readingPathOnly（ADMISSION_NONCORE_JS 开）：只查阅读路径字段；关时查全部规则组（逐字原口径）。
 * coreJs（ENGINE_SYNTAX_JS on）：无 jsLib 的源里，JS 链白名单字段（parse.ts jsChainFieldAllowed）的 JS
 * 不再整源拒——引擎改由沙箱执行；READING_PATH_JS_FIELDS 与列表字段（bookList/chapterList，链不支持）
 * 照旧拒。coreJs 关时逐字原口径。
 */
function rulesNoJs(src: RawSource, options: { noncoreJs?: boolean; coreJs?: boolean } = {}): boolean {
  const readingPathOnly = options.noncoreJs === true;
  const jsOk = options.coreJs === true && !hasJsLib(src);
  for (const [field, v] of iterRulePairs(src)) {
    if (readingPathOnly && !READING_PATH_FIELDS.has(field)) continue;
    if (!ruleHasJs(v)) continue;
    if (jsOk && jsChainFieldAllowed(field)) continue;
    return false;
  }
  return true;
}

/** 搜索为纯 GET 模板：含 {{key}}，无 POST/JSON 选项/@ 动词。 */
function searchIsPureGet(su: unknown): boolean {
  if (typeof su !== 'string') return false;
  if (!su.includes('{{key}}')) return false;
  const base = su.split('##')[0];
  if (/,\s*\{/.test(base)) return false;
  if (/@[a-zA-Z]/.test(base)) return false;
  return true;
}

/**
 * 复现主会话初筛（survey.py select_candidates），预期 174 条。
 * 41-srcfix 改法2：bookSourceUrl 写死 `http://` 的源先经 upgradeSourceTemplateUrl 升 https 再判——只改 scheme，
 * host/端口/userinfo 逐字不变，之后准入与运行时照旧过同一把 checkSourceUrl 锁（端口/IP/userinfo 仍被拒）。
 * 无协议（书源名当 URL）与其它 scheme 升级后仍非 https，照旧丢弃。
 *
 * 41-admpost F1：postSearch 开时的放开分支改用 `searchOptionsConstructible`——与运行时 `buildSourceSearchRequest`
 * **同一判据函数**（展开 {{key}} + rejectUnexpanded + 类型校验，只放开 host 白名单），消除「候选放行 / 运行时抛」的
 * 22 源分歧（{{cookie}} 等展不开的模板、空 charset、非串 body、非对象 headers 一律判不支持）。postSearch 关时逐字不变。
 *
 * js-1026：`noncoreJs`（ADMISSION_NONCORE_JS）开时 JS 判据只查阅读路径字段，见 admissionNoncoreJsEnabled。
 * 源类型按 legado BookSourceType（0 文本 / 1 音频 / 2 图片 / 3 文件 / 4 视频）只放行文本源：原判据只拒 2
 * 且注释误作「听书源」，音频（猫耳FM/喜马拉雅）与文件源（Zlibrary/知轩藏书）可漏进文本池。缺省按文本，非数值拒。
 *
 * searchjs1027：`searchJs`（postSearch 同开才生效）时，旧口径构造不出、需 JS 的模板改在沙箱里按 legado 口径试构造
 * （search-js.ts searchJsConstructible，与运行时同一函数）。须先 await prepareSearchJs()，沙箱未就绪抛 SearchJsNotReadyError。
 */
export function selectCandidates(
  data: RawSource[], options: { postSearch?: boolean; noncoreJs?: boolean; coreJs?: boolean; searchJs?: boolean } = {},
): RawSource[] {
  const out: RawSource[] = [];
  for (const s of data) {
    const upgradedBase = upgradeSourceTemplateUrl(String(s.bookSourceUrl ?? ''));
    if (!upgradedBase.startsWith('https://')) continue;
    if (!rulesNoJs(s, options)) continue;
    // 默认口径 = 纯 GET；postSearch 开时额外放行「可构造出 POST/GET 请求」的源（与运行时同一判据，webView/未知键/展不开仍拒）。
    if (!searchIsPureGet(s.searchUrl)
      && !(options.postSearch && searchOptionsConstructible(s.searchUrl, upgradedBase))
      && !(options.postSearch && options.searchJs && searchTemplateNeedsJs(s.searchUrl, upgradedBase)
        && searchJsConstructible(s.searchUrl as string, upgradedBase))) continue;
    const rs = (s.ruleSearch ?? {}) as Record<string, unknown>;
    const rc = (s.ruleContent ?? {}) as Record<string, unknown>;
    if (!(rs && typeof rs === 'object' && rs.bookList)) continue;
    if (!(rc && typeof rc === 'object' && rc.content)) continue;
    if (!isTextSourceType(s.bookSourceType)) continue;
    out.push(s);
  }
  return out;
}

/** legado BookSourceType 0 = 文本；缺省（老源无此字段）按文本。数字串同数字处理。 */
function isTextSourceType(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return Number(value) === 0;
}

export interface CompileResult {
  /** 核心字段全部编译成功（无 RULE_UNSUPPORTED）。 */
  ok: boolean;
  /** 编译失败的核心字段 → 原因。 */
  failures: { field: string; rule: string; message: string; diagnostic: RuleDiagnostic }[];
}

/** 对一个源的核心字段跑 parseFieldRule；任一核心字段 RULE_UNSUPPORTED → ok=false。 */
export function compileCoreFields(src: RawSource, options: ParseOptions = {}): CompileResult {
  const core: Record<string, string> = {};
  const coreSet = new Set<string>(CORE_FIELDS);
  for (const [field, rule] of iterRulePairs(src)) {
    if (coreSet.has(field)) core[field] = rule;
  }
  return compileCoreFieldsFromRules(core, options);
}

/**
 * 对「字段名→规则文本」映射（核心字段冻结 fixture smoke-174.json 的 coreRules）跑编译。
 * 任一核心字段 RULE_UNSUPPORTED → ok=false。
 * `orEnabled`（P1a，默认 off）/`xpathEnabled`（xpath1027，默认 off）透传 parseFieldRule：on 态顶层 || 编译成 OrNode、
 * 简单子集 XPath 翻成 CSS。
 */
export function compileCoreFieldsFromRules(
  coreRules: Record<string, string>, options: ParseOptions = {},
): CompileResult {
  const failures: CompileResult['failures'] = [];
  // aio1027：与 compileSource 同一判据（列表规则以 `:` 开头的组整组按 AllInOne 解释）。
  const aio = (options.aioEnabled ?? engineSyntaxAioEnabled()) ? aioGroupsFlat(coreRules) : new Set<string>();
  for (const [field, rule] of Object.entries(coreRules)) {
    if (typeof rule !== 'string' || !rule.trim()) continue;
    try {
      parseFieldRule(rule, { ...options, field, aioGroup: aio.has(ruleGroupOf(field)) });
    } catch (err) {
      if (err instanceof RuleEngineError && err.code === 'RULE_UNSUPPORTED') {
        failures.push({ field, rule, message: err.message, diagnostic: err.diagnostic ?? { code: 'unsupported_rule' } });
      } else {
        failures.push({ field, rule, message: `非 RULE_UNSUPPORTED: ${String(err)}`, diagnostic: { code: 'unexpected_compile_error' } });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
