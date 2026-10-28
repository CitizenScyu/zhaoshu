// 源规则 → CompiledRules（逐字段编译 + 装饰字段 skip 标记 + LRU 缓存）。
// 设计依据：m1-engine-design.md §1 架构（compile.ts）、§7.1 的 EngineSource.compiled。
// 缓存键 = 语义版本化 sourceRevision（P0 引入 engineVersionedKey；P1a 起语义版本随
// ENGINE_SYNTAX_OR 联动——off=1 / on=2）：规则原文或引擎语义任一变化，键即变，旧编译
// 产物自然失效，不存在「|| 开关打开后仍复用 off 态编译缓存」的窗口。
import { searchOptionsMayUseWebView, searchOptionsNeedParity, searchTemplateNeedsJs } from '@/lib/source-parser';
import { upgradeSourceTemplateUrl } from '@/lib/source-policy';
import { sourceRevision } from '@/lib/source-revision';
import { engineSearchJsActive, engineSearchOptionsActive } from './compile-smoke';
import { aioGroups } from './aio-syntax';
import {
  initFieldSupported, initJsFieldSupported, initRuleTextSupported, jsChainFieldAllowed, listJsGroups, objectKeyOf, parseFieldRule, ruleHasJs,
  type ParseOptions,
} from './parse';
import type { CompiledRules, FieldIr, RuleIr } from './types';
import {
  engineSemanticsVersion, engineSyntaxAioEnabled, engineSyntaxAndEnabled, engineSyntaxInitEnabled, engineSyntaxJsBindEnabled, engineSyntaxJsEnabled,
  engineSyntaxJsExtEnabled, engineSyntaxJsGetEnabled, engineSyntaxJsonPathEnabled, engineSyntaxJsUtilEnabled, engineSyntaxListJsEnabled,
  engineSyntaxOrEnabled, engineSyntaxRegexEnabled, engineSyntaxVarsEnabled, engineSyntaxXPathEnabled, engineSyntaxXPathEvalEnabled, engineUrlOptionsEnabled,
  engineSearchWebViewEnabled, engineSyntaxInitJsEnabled, engineSyntaxVarsBagEnabled,
  ENGINE_SEMANTICS_VERSION,
} from './syntax-flags';
import { urlOptionFields } from './url-options';
import { resolveSourceVars, ruleMayUseVars, varBagPlan, varPutRules } from './vars-subset';
import { ruleMayUseXPath } from './xpath-subset';

export { ENGINE_SEMANTICS_VERSION };

/** 编译选项：parse 层两开关 + 源级改写开关（vars1027，ENGINE_SYNTAX_VARS，默认读 env）。 */
export interface CompileOptions extends ParseOptions {
  varsEnabled?: boolean;
  /** searchjs1027：搜索模板 JS（缺省 = ENGINE_POST_SEARCH 与 ENGINE_SEARCH_JS 都开）。只影响语义版本位，不影响编译产物。 */
  searchJsEnabled?: boolean;
  /** init1028：详情页 init 生效（ENGINE_SYNTAX_INIT，默认读 env）。只给可复现的 init 挂 FieldIr.initScope。 */
  initEnabled?: boolean;
  /** searchopt1028：搜索选项 legado 口径（缺省 = ENGINE_POST_SEARCH 与 ENGINE_SEARCH_OPTIONS 都开）。只影响语义版本位。 */
  searchOptionsEnabled?: boolean;
  /** urlopt1028：URL 字段选项后缀（ENGINE_URL_OPTIONS，默认读 env）。只给 urlOptionFields 判出的字段挂 FieldIr.urlOptions。 */
  urlOptionsEnabled?: boolean;
  /** searchwv1028：搜索选项 webView 当普通请求（ENGINE_SEARCH_WEBVIEW，默认读 env；须搜索选项 legado 口径同生效）。只影响语义版本位。 */
  searchWebViewEnabled?: boolean;
  // initJsEnabled（initjs1028，ENGINE_SYNTAX_INIT_JS）见 ParseOptions；compile 层另要求 initEnabled 同开。
  /** varbag1028：详情页 put → 目录页 get 变量袋（ENGINE_SYNTAX_VARS_BAG，默认读 env；须 varsEnabled 同开）。 */
  varBagEnabled?: boolean;
}

/** 版本化缓存键（P0 口径）：semanticsVersion:contentRevision。 */
export function engineVersionedKey(contentRevision: string, semanticsVersion = ENGINE_SEMANTICS_VERSION): string {
  return `${semanticsVersion}:${contentRevision}`;
}

/**
 * 内容 identity 与引擎语义 identity 的唯一组合口径（语义版本随 || 开关联动，P1a）。
 * orsrc1027：语义版本按源判定——开关 on 且规则组里出现 `||` 的源才是版本 2，其余源恒为 1。
 * xpath1027：同理，ENGINE_SYNTAX_XPATH on 且规则组可能含 XPath 段的源再加 XPath 位（3/4），其余源不变。
 * vars1027：ENGINE_SYNTAX_VARS on 且规则组含 @put/@get 的源再加变量位（5–8）。
 * jsbox1027：ENGINE_SYNTAX_JS on 且可编译成 JS 链的字段里有 JS、源无 jsLib 时再加 JS 位（9–16）。
 * xpatheval1027：ENGINE_SYNTAX_XPATH 与 ENGINE_SYNTAX_XPATH_EVAL 都 on 且有字段编译出 XPath 求值 IR 时再加求值位（17–32）。
 * regex1027：ENGINE_SYNTAX_REGEX on 且有字段编译出正则-only 规则或 replaceFirst 替换时再加正则位（33–64）。
 * and1027：ENGINE_SYNTAX_AND（须 OR）on 且有 off 态因 && 被拒的字段在 on 态编译通过时再加 && 位（65–128）。
 * aio1027：ENGINE_SYNTAX_AIO on 且 bookList/chapterList 以 `:` 开头时再加 AllInOne 位（129–256）。
 * searchjs1027：搜索模板 JS 生效且该源 searchUrl 旧口径构造不出、需 JS（searchTemplateNeedsJs）时再加搜索 JS 位（257–512）。
 * listjs1027：ENGINE_SYNTAX_LIST_JS on、JS 链对该源生效（ENGINE_SYNTAX_JS on、无 jsLib）且 bookList/chapterList 含 JS 段时再加列表 JS 位（513–1024）。
 * jsext1028：ENGINE_SYNTAX_JS_EXT on、JS 链对该源生效且有字段 off 态被拒、on 态编译通过时再加 JS 扩展位（1025–2048）。
 * bind1028：ENGINE_SYNTAX_JS_BIND on、JS 链对该源生效且有字段 off 态被拒、on 态编译通过时再加宿主绑定位（2049–4096）。
 * jsget1028：ENGINE_SYNTAX_JS_GET on、JS 链对该源生效且有字段 off 态被拒、on 态编译通过时再加 getter 位（4097–8192）。
 * jsutil1028：ENGINE_SYNTAX_JS_UTIL on、JS 链对该源生效且有字段 off 态被拒、on 态编译通过时再加加解密帮手位（8193–16384）。
 * jsonpath1028：ENGINE_SYNTAX_JSON_PATH on 且有字段 off 态被拒、on 态编译通过时再加 JSONPath 扩展位（16385–32768）。
 * init1028：ENGINE_SYNTAX_INIT on 且 ruleBookInfo.init 可复现（sourceUsesInitSyntax）时再加 init 位（32769–65536）。
 * searchopt1028：搜索选项 legado 口径生效且该源 searchUrl 的选项被旧口径拒（searchOptionsNeedParity）时再加选项位（65537–131072）。
 * urlopt1028：ENGINE_URL_OPTIONS on 且有 URL 字段原文像会产出 `,{选项}`（urlOptionFields 非空）时再加 URL 选项位（131073–262144）。
 * searchwv1028：ENGINE_SEARCH_WEBVIEW on、搜索选项位条件成立且选项可能让 webView 为真（searchOptionsMayUseWebView）时再加搜索 webView 位（262145–524288）。
 * initjs1028：ENGINE_SYNTAX_INIT 与 ENGINE_SYNTAX_INIT_JS 都 on、JS 链对该源生效且 init 是可复现的 JS（sourceUsesInitJsSyntax）时再加 JS init 位（524289–1048576）。
 * varbag1028：ENGINE_SYNTAX_VARS 与 ENGINE_SYNTAX_VARS_BAG 都 on 且变量袋对该源真生效（compileVarBag 非 null）时再加变量袋位（+2097152）。
 */
export function engineSourceRevision(
  source: { url: string; searchUrl: unknown; rules: Record<string, unknown> },
  options: CompileOptions = {},
): string {
  const orEnabled = options.orEnabled ?? engineSyntaxOrEnabled();
  const xpathEnabled = options.xpathEnabled ?? engineSyntaxXPathEnabled();
  const varsEnabled = options.varsEnabled ?? engineSyntaxVarsEnabled();
  const jsEnabled = options.jsEnabled ?? engineSyntaxJsEnabled();
  const xpathEval = options.xpathEvalEnabled ?? engineSyntaxXPathEvalEnabled();
  const regexEnabled = options.regexEnabled ?? engineSyntaxRegexEnabled();
  const andEnabled = options.andEnabled ?? engineSyntaxAndEnabled();
  const aioEnabled = options.aioEnabled ?? engineSyntaxAioEnabled();
  const searchJsEnabled = options.searchJsEnabled ?? engineSearchJsActive();
  const listJsEnabled = options.listJsEnabled ?? engineSyntaxListJsEnabled();
  const jsExtEnabled = options.jsExtEnabled ?? engineSyntaxJsExtEnabled();
  const jsBindEnabled = options.jsBindEnabled ?? engineSyntaxJsBindEnabled();
  const jsGetEnabled = options.jsGetEnabled ?? engineSyntaxJsGetEnabled();
  const jsUtilEnabled = options.jsUtilEnabled ?? engineSyntaxJsUtilEnabled();
  const jsonPathEnabled = options.jsonPathEnabled ?? engineSyntaxJsonPathEnabled();
  const initEnabled = options.initEnabled ?? engineSyntaxInitEnabled();
  const searchOptionsEnabled = options.searchOptionsEnabled ?? engineSearchOptionsActive();
  const urlOptionsEnabled = options.urlOptionsEnabled ?? engineUrlOptionsEnabled();
  const searchWebViewEnabled = options.searchWebViewEnabled ?? engineSearchWebViewEnabled();
  const initJsEnabled = initEnabled && (options.initJsEnabled ?? engineSyntaxInitJsEnabled());
  const searchOptionParity = searchOptionsEnabled && searchOptionsNeedParity(source.searchUrl, upgradeSourceTemplateUrl(source.url));
  const jsChain = jsEnabled && !sourceHasJsLib(source.rules);
  // 下游 sourceUses* 的编译与 compileSource 同一组开关（jsBind/jsGet/jsUtil 只在 JS 链生效时有意义）。
  const jsBind = jsChain && jsBindEnabled;
  const jsGet = jsChain && jsGetEnabled;
  const jsUtil = jsChain && jsUtilEnabled;
  return engineVersionedKey(sourceRevision(source), engineSemanticsVersion(
    orEnabled && sourceUsesOrSyntax(source.rules),
    xpathEnabled && sourceUsesXPathSyntax(source.rules),
    varsEnabled && sourceUsesVarSyntax(source.rules),
    jsEnabled && sourceUsesJsSyntax(source.rules),
    xpathEnabled && xpathEval && sourceUsesXPathEval(source.rules, {
      orEnabled, varsEnabled, jsEnabled: jsChain, listJsEnabled, jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil,
      jsonPathEnabled,
    }),
    regexEnabled && sourceUsesRegexSyntax(source.rules, {
      orEnabled, varsEnabled, jsEnabled: jsChain, xpathEnabled, xpathEvalEnabled: xpathEval, listJsEnabled, jsExtEnabled, jsBindEnabled: jsBind,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled,
    }),
    orEnabled && andEnabled && sourceUsesAndSyntax(source.rules, {
      varsEnabled, jsEnabled: jsChain, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, listJsEnabled, jsExtEnabled, jsBindEnabled: jsBind,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled,
    }),
    aioEnabled && sourceUsesAioSyntax(source.rules),
    searchJsEnabled && searchTemplateNeedsJs(source.searchUrl, upgradeSourceTemplateUrl(source.url)),
    jsChain && listJsEnabled && sourceUsesListJsSyntax(source.rules),
    jsChain && jsExtEnabled && sourceUsesJsExtSyntax(source.rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsBindEnabled: jsBind,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled,
    }),
    jsBind && sourceUsesJsBindSyntax(source.rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled,
    }),
    jsGet && sourceUsesJsGetSyntax(source.rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsBindEnabled: jsBind, jsUtilEnabled: jsUtil, jsonPathEnabled,
    }),
    jsUtil && sourceUsesJsUtilSyntax(source.rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsonPathEnabled,
    }),
    jsonPathEnabled && sourceUsesJsonPathSyntax(source.rules, {
      orEnabled, varsEnabled, jsEnabled: jsChain, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil,
    }),
    initEnabled && sourceUsesInitSyntax(source.rules, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, jsEnabled: jsChain, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled,
    }),
    searchOptionParity,
    urlOptionsEnabled && urlOptionFields(source.rules).size > 0,
    searchWebViewEnabled && searchOptionParity && searchOptionsMayUseWebView(source.searchUrl),
    initJsEnabled && jsChain && sourceUsesInitJsSyntax(source.rules, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled,
    }),
    varsEnabled && (options.varBagEnabled ?? engineSyntaxVarsBagEnabled()) && compileVarBag(source.rules, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, jsEnabled: jsChain, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, initJsEnabled,
    }) !== null,
  ));
}

const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleContent', 'ruleToc', 'ruleExplore'] as const;

function someRule(rules: Record<string, unknown>, test: (rule: string) => boolean): boolean {
  for (const group of RULE_GROUPS) {
    const fields = rules[group];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const rule of Object.values(fields as Record<string, unknown>)) {
      if (typeof rule === 'string' && test(rule)) return true;
    }
  }
  return false;
}

/**
 * 源的规则组里是否有字段文本含 `||`（orsrc1027）。不含 `||` 的规则 on/off 两态编译逐字同路
 * （off 的 splitTopLevel 与 on 的 tokenizeOrBranches 都只切出一段），语义没变，identity 就不该变：
 * 否则开闸会把全部准入行判成「规则已变」，清掉 conn_fail 退避并整池重探。只看子串、宁宽勿漏——
 * 括号/引号内的 `||` 也算，多算只是多重探一次。
 */
export function sourceUsesOrSyntax(rules: Record<string, unknown>): boolean {
  return someRule(rules, (rule) => rule.includes('||'));
}

/** 源的规则组里是否可能有 XPath 段（xpath1027，口径见 ruleMayUseXPath；理由同 sourceUsesOrSyntax）。 */
export function sourceUsesXPathSyntax(rules: Record<string, unknown>): boolean {
  return someRule(rules, ruleMayUseXPath);
}

/** 源的规则组里是否有 @put/@get（vars1027；不涉及变量的源 resolveSourceVars 原样返回，identity 不该变）。 */
export function sourceUsesVarSyntax(rules: Record<string, unknown>): boolean {
  return someRule(rules, ruleMayUseVars);
}

/** 源带 jsLib（公共函数库）：JS 段多半调用其中函数，沙箱不执行 jsLib，整源不开 JS 链。 */
export function sourceHasJsLib(rules: Record<string, unknown>): boolean {
  return typeof rules.jsLib === 'string' && rules.jsLib.trim() !== '';
}

/**
 * 源是否会因 ENGINE_SYNTAX_JS 改变编译结果（jsbox1027）：无 jsLib，且 JS 链白名单字段（parse.ts
 * jsChainFieldAllowed）里有含 JS 的规则。装饰字段/列表字段的 JS 开关前后同样不编译，identity 不该变。
 */
export function sourceUsesJsSyntax(rules: Record<string, unknown>): boolean {
  if (sourceHasJsLib(rules)) return false;
  for (const group of RULE_GROUPS) {
    const fields = rules[group];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [name, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule === 'string' && jsChainFieldAllowed(`${group}.${name}`) && ruleHasJs(rule)) return true;
    }
  }
  return false;
}

function irUsesXPathEval(ir: RuleIr): boolean {
  if (ir.kind === 'xpath') return true;
  return ir.kind === 'or' && ir.branches.some(irUsesXPathEval);
}

function fieldUsesXPathEval(field: FieldIr): boolean {
  if (field.rules.some(irUsesXPathEval)) return true;
  return (field.chain ?? []).some((stage) => stage.kind === 'rule' && fieldUsesXPathEval(stage.field))
    || [...(field.jsGets?.values() ?? [])].some(fieldUsesXPathEval);
}

/** 按规则对象 + 开关组合记忆（rulesHash 与 compileSource 各算一次键；规则对象在读缓存 TTL 内不变）。 */
const xpathEvalMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_XPATH_EVAL 改变编译结果（xpatheval1027）：按 eval on 实际编译可能含 XPath 的字段，
 * 有字段产出 `kind:'xpath'` IR 才算。子集内 XPath（翻成 CSS）、eval 下仍拒的段两态编译一致，identity 不该变。
 */
export function sourceUsesXPathEval(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; jsEnabled: boolean; listJsEnabled?: boolean; jsExtEnabled?: boolean; jsBindEnabled?: boolean;
    jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean;
  },
): boolean {
  if (!someRule(rules, ruleMayUseXPath)) return false;
  const listJsEnabled = options.listJsEnabled === true;
  const jsExtEnabled = options.jsExtEnabled === true;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.jsEnabled}:${listJsEnabled}:${jsExtEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}`;
  let memo = xpathEvalMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !rule.trim() || !ruleMayUseXPath(rule)) continue;
      try {
        const ir = parseFieldRule(rule, {
          orEnabled: options.orEnabled, xpathEnabled: true, xpathEvalEnabled: true, jsEnabled: options.jsEnabled, listJsEnabled, jsExtEnabled,
          jsBindEnabled, jsGetEnabled, jsUtilEnabled, jsonPathEnabled, field: `${group}.${field}`,
        });
        if (fieldUsesXPathEval(ir)) {
          uses = true;
          break;
        }
      } catch {
        // eval on 也编译不过：两态都 skipped，不影响 identity
      }
    }
  }
  if (!memo) {
    memo = new Map();
    xpathEvalMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

function fieldUsesRegexSyntax(field: FieldIr): boolean {
  if (field.rules.some((ir) => ir.kind === 'self') || (field.regex ?? []).some((sub) => sub.first)) return true;
  return (field.chain ?? []).some((stage) => (stage.kind === 'rule' && fieldUsesRegexSyntax(stage.field))
    || (stage.kind === 'regex' && stage.regex.some((sub) => sub.first)))
    || [...(field.jsGets?.values() ?? [])].some(fieldUsesRegexSyntax);
}

const regexMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_REGEX 改变编译结果（regex1027）：按 on 态（其余开关同 compileSource）实际编译含 `##` 的字段，
 * 产出正则-only 规则或 replaceFirst 替换才算。带选择器主体的 `##` 替换两态同 IR，identity 不该变。
 */
export function sourceUsesRegexSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; jsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; listJsEnabled?: boolean;
    jsExtEnabled?: boolean; jsBindEnabled?: boolean; jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean;
  },
): boolean {
  if (!someRule(rules, (rule) => rule.includes('##'))) return false;
  const listJsEnabled = options.listJsEnabled === true;
  const jsExtEnabled = options.jsExtEnabled === true;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.jsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${listJsEnabled}:${jsExtEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}`;
  let memo = regexMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !rule.includes('##')) continue;
      try {
        const ir = parseFieldRule(rule, {
          orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled,
          jsEnabled: options.jsEnabled, regexEnabled: true, listJsEnabled, jsExtEnabled, jsBindEnabled, jsGetEnabled, jsUtilEnabled,
          jsonPathEnabled, field: `${group}.${field}`,
        });
        if (fieldUsesRegexSyntax(ir)) {
          uses = true;
          break;
        }
      } catch {
        // on 态也编译不过：两态都 skipped，不影响 identity
      }
    }
  }
  if (!memo) {
    memo = new Map();
    regexMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

/**
 * 源是否会因 ENGINE_SYNTAX_AIO 改变编译结果（aio1027）：列表规则以 `:` 开头才走 AllInOne，其余源两态逐字同路。
 * off 态这类源读不出目录/搜索结果（`:` 列表被当伪选择器、求值失败，`$N` 条目按 JSONPath 编译失败），identity 只在它们身上翻动。
 */
export function sourceUsesAioSyntax(rules: Record<string, unknown>): boolean {
  return aioGroups(rules).size > 0;
}

/**
 * 源是否会因 ENGINE_SYNTAX_LIST_JS 改变编译结果（listjs1027）：无 jsLib 且 bookList/chapterList 含 JS 段（AllInOne `:` 列表不算）。
 * off 态这类列表恒编译失败；on 态列表与同组条目字段（另挂 objectKey）都换了编译产物。调用方还须确认 ENGINE_SYNTAX_JS on。
 */
export function sourceUsesListJsSyntax(rules: Record<string, unknown>): boolean {
  return !sourceHasJsLib(rules) && listJsGroups(rules).size > 0;
}

const andMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_AND 改变编译结果（and1027）：off 态只有「整串含顶层 &&」才走拒绝分支，on 态也只改这些规则
 * （parse.ts offAnd 门），所以按 on 态（OR 开、其余开关同 compileSource）实际编译这类字段，有一个编译通过即算——
 * off 态它必是 skipped。on 态仍被拒的字段两态都 skipped，identity 不该变。
 */
export function sourceUsesAndSyntax(
  rules: Record<string, unknown>,
  options: {
    varsEnabled: boolean; jsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; listJsEnabled?: boolean;
    jsExtEnabled?: boolean; jsBindEnabled?: boolean; jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean;
  },
): boolean {
  if (!someRule(rules, (rule) => rule.includes('&&'))) return false;
  const listJsEnabled = options.listJsEnabled === true;
  const jsExtEnabled = options.jsExtEnabled === true;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const memoKey = `${options.varsEnabled}:${options.jsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${listJsEnabled}:${jsExtEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}`;
  let memo = andMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !rule.includes('&&')) continue;
      const name = `${group}.${field}`;
      const parse = (andEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: true, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled,
        jsEnabled: options.jsEnabled, regexEnabled: options.regexEnabled, andEnabled, listJsEnabled, jsExtEnabled, jsBindEnabled, jsGetEnabled,
        jsUtilEnabled, jsonPathEnabled, field: name,
      });
      try {
        parse(true);
      } catch {
        continue; // on 态也编译不过：两态都 skipped
      }
      try {
        parse(false);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    andMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const jsExtMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_JS_EXT 改变编译结果（jsext1028）：on 态只改写 off 态被拒的 JS 段（eval、段内 `##`/`{{}}`，
 * parse.ts parseJsExtStage），所以对含 JS 的字段按两态（JS 开，其余开关同 compileSource）各编译一次，有字段 off 拒、on 过即算。
 * 两态都过（段里没有这些构件）或都拒的字段 identity 不该变。调用方须确认 JS 链对该源生效（ENGINE_SYNTAX_JS on、无 jsLib）。
 */
export function sourceUsesJsExtSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsBindEnabled?: boolean; jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleHasJs)) return false;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}`;
  let memo = jsExtMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !ruleHasJs(rule)) continue;
      const parse = (jsExtEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, jsExtEnabled, jsBindEnabled, jsGetEnabled, jsUtilEnabled, jsonPathEnabled, field: `${group}.${field}`,
      });
      try {
        parse(true);
      } catch {
        continue; // on 态也编译不过：两态都 skipped
      }
      try {
        parse(false);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    jsExtMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const jsBindMemo = new WeakMap<object, Map<string, boolean>>();

/** 可能受 bind1028 影响的规则：含 `{{`（规则级 makeUp），或 JS 规则里出现宿主绑定名（book/chapter/title）。宁宽勿漏，实编译再判。 */
function ruleMayUseJsBind(rule: string): boolean {
  return rule.includes('{{') || (ruleHasJs(rule) && /(?<![\w$])(?:book|chapter|title)(?![\w$])/.test(rule));
}

/**
 * 源是否会因 ENGINE_SYNTAX_JS_BIND 改变编译结果（bind1028）：on 态只放行 off 态被拒的规则（宿主绑定名 off 态是禁用标识符，
 * makeUp 只接旧路径拒收的 `{{}}`，见 parse.ts parseMakeUpField），所以对候选字段按两态（JS 开，其余开关同 compileSource）
 * 各编译一次，有字段 off 拒、on 过即算。调用方须确认 JS 链对该源生效（ENGINE_SYNTAX_JS on、无 jsLib）。
 */
export function sourceUsesJsBindSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleMayUseJsBind)) return false;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}`;
  let memo = jsBindMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !ruleMayUseJsBind(rule)) continue;
      const parse = (jsBindEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, jsExtEnabled: options.jsExtEnabled, jsBindEnabled, jsGetEnabled, jsUtilEnabled,
        jsonPathEnabled, field: `${group}.${field}`,
      });
      try {
        parse(true);
      } catch {
        continue; // on 态也编译不过：两态都 skipped
      }
      try {
        parse(false);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    jsBindMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const jsGetMemo = new WeakMap<object, Map<string, boolean>>();

/** 可能受 jsget1028 影响的规则：JS 规则里出现 `java.getString`/`java.getStringList`。宁宽勿漏，实编译再判。 */
function ruleMayUseJsGet(rule: string): boolean {
  return ruleHasJs(rule) && /java\s*\.\s*getString/.test(rule);
}

/**
 * 源是否会因 ENGINE_SYNTAX_JS_GET 改变编译结果（jsget1028）：on 态只放行 off 态被拒的调用（java.getString 不在 off 态白名单里，
 * 见 parse.ts collectJavaGets），所以对候选字段按两态（JS 开，其余开关同 compileSource）各编译一次，有字段 off 拒、on 过即算。
 * 调用方须确认 JS 链对该源生效（ENGINE_SYNTAX_JS on、无 jsLib）。
 */
export function sourceUsesJsGetSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleMayUseJsGet)) return false;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${jsUtilEnabled}:${jsonPathEnabled}`;
  let memo = jsGetMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !ruleMayUseJsGet(rule)) continue;
      const parse = (jsGetEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, jsExtEnabled: options.jsExtEnabled, jsBindEnabled: options.jsBindEnabled, jsGetEnabled,
        jsUtilEnabled, jsonPathEnabled, field: `${group}.${field}`,
      });
      try {
        parse(true);
      } catch {
        continue; // on 态也编译不过：两态都 skipped
      }
      try {
        parse(false);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    jsGetMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const jsUtilMemo = new WeakMap<object, Map<string, boolean>>();

/** 可能受 jsutil1028 影响的规则：JS 规则里出现加解密帮手或 toNumChapter 的名字。宁宽勿漏，实编译再判。 */
function ruleMayUseJsUtil(rule: string): boolean {
  return ruleHasJs(rule) && /java\s*\.\s*(?:createSymmetricCrypto|aes|des|tripleDES|toNumChapter)/.test(rule);
}

/**
 * 源是否会因 ENGINE_SYNTAX_JS_UTIL 改变编译结果（jsutil1028）：on 态只放行 off 态被拒的调用（这批帮手不在 off 态白名单里，
 * 见 parse.ts checkJsCode），所以对候选字段按两态（JS 开，其余开关同 compileSource）各编译一次，有字段 off 拒、on 过即算。
 * 调用方须确认 JS 链对该源生效（ENGINE_SYNTAX_JS on、无 jsLib）。
 */
export function sourceUsesJsUtilSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean; jsonPathEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleMayUseJsUtil)) return false;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${jsonPathEnabled}`;
  let memo = jsUtilMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !ruleMayUseJsUtil(rule)) continue;
      const parse = (jsUtilEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, jsExtEnabled: options.jsExtEnabled, jsBindEnabled: options.jsBindEnabled,
        jsGetEnabled: options.jsGetEnabled, jsUtilEnabled, jsonPathEnabled, field: `${group}.${field}`,
      });
      try {
        parse(true);
      } catch {
        continue; // on 态也编译不过：两态都 skipped
      }
      try {
        parse(false);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    jsUtilMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const jsonPathMemo = new WeakMap<object, Map<string, boolean>>();

/** 可能受 jsonpath1028 影响的规则：含 `$` 且出现 `.[` 或 `[?`。宁宽勿漏，实编译再判。 */
function ruleMayUseJsonPath(rule: string): boolean {
  return rule.includes('$') && /\.\s*\[|\[\s*\?/.test(rule);
}

/**
 * 源是否会因 ENGINE_SYNTAX_JSON_PATH 改变编译结果（jsonpath1028）：on 态只接 off 态解析不了的路径（parse.ts → jsonpath.ts
 * parseJsonPath 先试 off 子集），所以对候选字段按两态（其余开关同 compileSource）各编译一次，有字段 off 拒、on 过即算。
 * 与 JS 链无关：JS 链里的规则段同样经 parseFieldRule。
 */
export function sourceUsesJsonPathSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; jsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean;
    andEnabled: boolean; aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean;
    jsUtilEnabled: boolean;
  },
): boolean {
  if (!someRule(rules, ruleMayUseJsonPath)) return false;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.jsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}`;
  let memo = jsonPathMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !ruleMayUseJsonPath(rule)) continue;
      const parse = (jsonPathEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled,
        jsEnabled: options.jsEnabled, regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled,
        aioGroup: aio.has(group), listJsEnabled: options.listJsEnabled, jsExtEnabled: options.jsExtEnabled, jsBindEnabled: options.jsBindEnabled,
        jsGetEnabled: options.jsGetEnabled, jsUtilEnabled: options.jsUtilEnabled, jsonPathEnabled, field: `${group}.${field}`,
      });
      try {
        parse(true);
      } catch {
        continue; // on 态也编译不过：两态都 skipped
      }
      try {
        parse(false);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    jsonPathMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

/** 源的 `ruleBookInfo.init` 原文（非字符串/缺组 = undefined）。 */
function initRuleOf(rules: Record<string, unknown>): unknown {
  const info = rules.ruleBookInfo;
  return info && typeof info === 'object' && !Array.isArray(info) ? (info as Record<string, unknown>).init : undefined;
}

/** compileSource 编出的 init 是否挂 initScope（init1028）：原文过 initRuleTextSupported、编译结果过 initFieldSupported。 */
function initApplies(rule: unknown, field: FieldIr | { skipped: string } | undefined): field is FieldIr {
  return field !== undefined && !('skipped' in field) && initRuleTextSupported(rule) && initFieldSupported(field);
}

const initMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_INIT 改变详情页求值（init1028）：init 原文与编译结果（其余开关同 compileSource）都可复现才算。
 * init 不受 vars-subset 改写（文本判据已拒 @put/@get），按原文编译即与 compileSource 同口径。
 */
export function sourceUsesInitSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; jsEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean;
    jsonPathEnabled: boolean;
  },
): boolean {
  const rule = initRuleOf(rules);
  if (!initRuleTextSupported(rule)) return false;
  const memoKey = `${options.orEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.jsEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}`;
  let memo = initMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  let field: FieldIr | undefined;
  try {
    field = parseFieldRule(rule as string, { ...options, field: 'ruleBookInfo.init' });
  } catch {
    field = undefined;
  }
  const uses = initApplies(rule, field);
  if (!memo) {
    memo = new Map();
    initMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

/** compileSource 编出的 init 是否按 JS init 挂 initScope（initjs1028）：原文含 JS、编译结果过 initJsFieldSupported。 */
function initJsApplies(rule: unknown, field: FieldIr | { skipped: string } | undefined): field is FieldIr {
  return typeof rule === 'string' && ruleHasJs(rule.trim()) && field !== undefined && !('skipped' in field) && initJsFieldSupported(field);
}

const initJsMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_INIT_JS 改变详情页求值（initjs1028）：init 原文含 JS、按 compileSource 同一组开关（JS 链已开）编译后
 * 是可复现的 JS init。调用方还须确认 ENGINE_SYNTAX_INIT 与 JS 链（ENGINE_SYNTAX_JS on、无 jsLib）都生效。
 */
export function sourceUsesInitJsSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean;
    jsonPathEnabled: boolean;
  },
): boolean {
  const rule = initRuleOf(rules);
  if (typeof rule !== 'string' || !ruleHasJs(rule.trim())) return false;
  const memoKey = `${options.orEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}`;
  let memo = initJsMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  let field: FieldIr | undefined;
  try {
    field = parseFieldRule(rule, { ...options, jsEnabled: true, initJsEnabled: true, field: 'ruleBookInfo.init' });
  } catch {
    field = undefined;
  }
  const uses = initJsApplies(rule, field);
  if (!memo) {
    memo = new Map();
    initJsMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

// ---- 详情页 put → 目录页 get 变量袋（varbag1028）----
const varBagMemo = new WeakMap<object, Map<string, ReadonlyMap<string, FieldIr> | null>>();

/** put 值规则的编译口径：legado `put(key, getString(value))`，按非 URL 字符串字段编、不含 JS。 */
const VAR_PUT_VALUE_FIELD = 'ruleBookInfo.name';

/**
 * 变量袋生效时要换掉的字段（字段全名 → 带 varPuts/varPut/varGets 的编译结果），不生效返回 null（整源照旧）。
 * 先按 vars-subset.ts varBagPlan 文本粗筛，再逐字段编译核实：详情 put 字段在 put 模式下编译（字段规则用 resolveSourceVars
 * 剥过 @put 的、put 值规则另编），目录 get 字段在 get 模式下编译；任一字段编译不过、编译收进来的 java.put 键与 @put 键重叠
 * 或跨字段重键、get 的键没被 put、目录组是 AllInOne、或最后没有字段真读袋，一律 null。
 * compileSource / compileAdmission 用它覆盖普通编译结果，engineSourceRevision 按非 null 计语义位——三处同一判据。
 * `options` 缺省的开关读 env（与 parseFieldRule 同口径）。
 */
export function compileVarBag(rules: Record<string, unknown>, options: ParseOptions = {}): ReadonlyMap<string, FieldIr> | null {
  const js = options.jsEnabled ?? engineSyntaxJsEnabled();
  const xpathEnabled = options.xpathEnabled ?? engineSyntaxXPathEnabled();
  const base: ParseOptions = {
    orEnabled: options.orEnabled ?? engineSyntaxOrEnabled(),
    xpathEnabled,
    xpathEvalEnabled: xpathEnabled && (options.xpathEvalEnabled ?? engineSyntaxXPathEvalEnabled()),
    jsEnabled: js,
    regexEnabled: options.regexEnabled ?? engineSyntaxRegexEnabled(),
    andEnabled: options.andEnabled ?? engineSyntaxAndEnabled(),
    aioEnabled: options.aioEnabled ?? engineSyntaxAioEnabled(),
    listJsEnabled: js && (options.listJsEnabled ?? engineSyntaxListJsEnabled()),
    jsExtEnabled: js && (options.jsExtEnabled ?? engineSyntaxJsExtEnabled()),
    jsBindEnabled: js && (options.jsBindEnabled ?? engineSyntaxJsBindEnabled()),
    jsGetEnabled: js && (options.jsGetEnabled ?? engineSyntaxJsGetEnabled()),
    jsUtilEnabled: js && (options.jsUtilEnabled ?? engineSyntaxJsUtilEnabled()),
    jsonPathEnabled: options.jsonPathEnabled ?? engineSyntaxJsonPathEnabled(),
    initJsEnabled: js && (options.initJsEnabled ?? (engineSyntaxInitEnabled() && engineSyntaxInitJsEnabled())),
  };
  const memoKey = JSON.stringify(base);
  let memo = varBagMemo.get(rules);
  if (!memo) {
    memo = new Map();
    varBagMemo.set(rules, memo);
  }
  if (memo.has(memoKey)) return memo.get(memoKey)!;
  const out = buildVarBag(rules, base);
  memo.set(memoKey, out);
  return out;
}

function buildVarBag(rules: Record<string, unknown>, base: ParseOptions): ReadonlyMap<string, FieldIr> | null {
  const plan = varBagPlan(rules);
  if (!plan) return null;
  const sourceRules = resolveSourceVars(rules);
  if (base.aioEnabled && aioGroups(sourceRules).has('ruleToc')) return null;
  const listJs = base.jsEnabled && base.listJsEnabled ? listJsGroups(sourceRules) : new Set<string>();
  const info = (sourceRules.ruleBookInfo ?? {}) as Record<string, unknown>;
  const rawInfo = (rules.ruleBookInfo ?? {}) as Record<string, unknown>;
  const toc = (sourceRules.ruleToc ?? {}) as Record<string, unknown>;
  const out = new Map<string, FieldIr>();
  const owner = new Set<string>();
  try {
    for (const name of plan.puts.keys()) {
      const field = `ruleBookInfo.${name}`;
      const map = varPutRules(String(rawInfo[name]));
      if (!map) return null;
      const varPuts: Array<readonly [string, FieldIr]> = [];
      for (const [key, rule] of map) {
        varPuts.push([key, parseFieldRule(rule, { ...base, jsEnabled: false, field: VAR_PUT_VALUE_FIELD })]);
      }
      const javaKeys = new Set<string>();
      const rule = typeof info[name] === 'string' ? (info[name] as string) : '';
      // 只剩 @put 的字段：legado 字段规则为空串，取值为空。
      const ir: FieldIr = rule.trim() === ''
        ? { rules: [{ kind: 'text', literal: '' }] }
        : parseFieldRule(rule, { ...base, field, varBag: { mode: 'put', keys: javaKeys } });
      for (const key of [...map.keys(), ...javaKeys]) {
        if (owner.has(key) || (map.has(key) && javaKeys.has(key))) return null;
        owner.add(key);
      }
      const bagged: FieldIr = { ...ir };
      if (varPuts.length > 0) bagged.varPuts = varPuts;
      if (javaKeys.size > 0) bagged.varPut = true;
      out.set(field, bagged);
    }
    let reads = false;
    for (const name of plan.gets.keys()) {
      const field = `ruleToc.${name}`;
      const keys = new Set<string>();
      const ir = parseFieldRule(String(toc[name]), { ...base, field, listJsGroup: listJs.has('ruleToc'), varBag: { mode: 'get', keys } });
      if (keys.size === 0) continue; // get 只出现在字面量/注释里：字段不读袋，普通编译即可
      for (const key of keys) if (!owner.has(key)) return null;
      out.set(field, { ...ir, varGets: true });
      reads = true;
    }
    return reads ? out : null;
  } catch {
    return null;
  }
}

/** LRU 上限：单测/低并发下足够；无关热路径，只防规则对象无限积累。 */
const CACHE_LIMIT = 64;
const cache = new Map<string, CompiledRules>();

/**
 * 把一个源的规则原文编译成 `字段全名 → FieldIr`（设计 §7.1）。
 * 单字段编译失败（RULE_UNSUPPORTED）不抛出，标 `skipped:'unsupported'`——核心/装饰字段的
 * 阻断语义由准入（滤网 1）与字段层（§3.4）决定，此处只做无异常的物化。
 * `orEnabled`（默认读 ENGINE_SYNTAX_OR，off）/`xpathEnabled`（默认读 ENGINE_SYNTAX_XPATH，off）/
 * `varsEnabled`（默认读 ENGINE_SYNTAX_VARS，off；on 时先 resolveSourceVars 改写再逐字段编译）逐次求值：
 * 切换开关会换缓存键，各态编译产物在同一进程内共存互不污染。
 */
export function compileSource(
  source: { url: string; searchUrl: unknown; rules: Record<string, unknown> },
  options: CompileOptions = {},
): CompiledRules {
  const orEnabled = options.orEnabled ?? engineSyntaxOrEnabled();
  const xpathEnabled = options.xpathEnabled ?? engineSyntaxXPathEnabled();
  const varsEnabled = options.varsEnabled ?? engineSyntaxVarsEnabled();
  // jsLib 源不开 JS 链（见 sourceHasJsLib）：字段里的 JS 照旧 unsupported_js。
  const jsEnabled = (options.jsEnabled ?? engineSyntaxJsEnabled()) && !sourceHasJsLib(source.rules);
  const xpathEvalEnabled = options.xpathEvalEnabled ?? engineSyntaxXPathEvalEnabled();
  const regexEnabled = options.regexEnabled ?? engineSyntaxRegexEnabled();
  const andEnabled = options.andEnabled ?? engineSyntaxAndEnabled();
  const aioEnabled = options.aioEnabled ?? engineSyntaxAioEnabled();
  const listJsEnabled = options.listJsEnabled ?? engineSyntaxListJsEnabled();
  const jsExtEnabled = options.jsExtEnabled ?? engineSyntaxJsExtEnabled();
  const jsBindEnabled = options.jsBindEnabled ?? engineSyntaxJsBindEnabled();
  const jsGetEnabled = options.jsGetEnabled ?? engineSyntaxJsGetEnabled();
  const jsUtilEnabled = options.jsUtilEnabled ?? engineSyntaxJsUtilEnabled();
  const jsonPathEnabled = options.jsonPathEnabled ?? engineSyntaxJsonPathEnabled();
  const initEnabled = options.initEnabled ?? engineSyntaxInitEnabled();
  const urlOptionsEnabled = options.urlOptionsEnabled ?? engineUrlOptionsEnabled();
  const initJsEnabled = initEnabled && (options.initJsEnabled ?? engineSyntaxInitJsEnabled());
  const varBagEnabled = varsEnabled && (options.varBagEnabled ?? engineSyntaxVarsBagEnabled());
  const key = engineSourceRevision(source, {
    orEnabled, xpathEnabled, varsEnabled, jsEnabled, xpathEvalEnabled, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
    jsBindEnabled, jsGetEnabled, jsUtilEnabled, jsonPathEnabled, initEnabled, urlOptionsEnabled, initJsEnabled, varBagEnabled,
  });
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // 触达即续期（Map 插入序 = LRU 序）
    cache.set(key, hit);
    return hit;
  }
  const compiled: CompiledRules = new Map();
  const sourceRules = varsEnabled ? resolveSourceVars(source.rules) : source.rules;
  const aio = aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  // listjs1027：列表规则含 JS 的组，条目字段另挂对象条目键值直取（parse.ts objectKeyOf）。
  const listJs = jsEnabled && listJsEnabled ? listJsGroups(sourceRules) : new Set<string>();
  for (const group of RULE_GROUPS) {
    const rules = sourceRules[group];
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) continue;
    for (const [field, rule] of Object.entries(rules as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !rule.trim()) continue;
      const name = `${group}.${field}`;
      try {
        compiled.set(name, parseFieldRule(rule, {
          orEnabled, xpathEnabled, xpathEvalEnabled, jsEnabled, regexEnabled, andEnabled, aioEnabled, aioGroup: aio.has(group),
          listJsEnabled, listJsGroup: listJs.has(group), jsExtEnabled, jsBindEnabled, jsGetEnabled, jsUtilEnabled, jsonPathEnabled, initJsEnabled,
          field: name,
        }));
      } catch {
        compiled.set(name, { skipped: 'unsupported' });
      }
    }
  }
  // varbag1028：变量袋对该源生效时换掉详情 put 字段与目录 get 字段（判据与语义位同一个 compileVarBag）。
  const bag = varBagEnabled ? compileVarBag(source.rules, {
    orEnabled, xpathEnabled, xpathEvalEnabled, jsEnabled, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled, jsBindEnabled,
    jsGetEnabled, jsUtilEnabled, jsonPathEnabled, initJsEnabled,
  }) : null;
  if (bag) for (const [name, ir] of bag) compiled.set(name, ir);
  // init1028：可复现的 init 挂 initScope（详情字段改在 init 结果上求值，见 evaluate.ts bookInfoScope）；判据看原文，不看 vars 改写后的。
  const init = compiled.get('ruleBookInfo.init');
  const initRule = initRuleOf(source.rules);
  if (initEnabled && initApplies(initRule, init)) compiled.set('ruleBookInfo.init', { ...init, initScope: true });
  // initjs1028：可复现的 JS init 同样挂 initScope；init 可能返回对象，详情字段另挂键值直取（parse.ts objectKeyOf，看编译所用原文）。
  if (initJsEnabled && initJsApplies(initRule, init)) {
    compiled.set('ruleBookInfo.init', { ...init, initScope: true });
    for (const [name, rule] of Object.entries(sourceRules.ruleBookInfo as Record<string, unknown>)) {
      const ir = compiled.get(`ruleBookInfo.${name}`);
      if (name === 'init' || typeof rule !== 'string' || !ir || 'skipped' in ir) continue;
      compiled.set(`ruleBookInfo.${name}`, { ...ir, objectKey: objectKeyOf(rule) });
    }
  }
  // urlopt1028：URL 字段挂 urlOptions（值进 host 门前剥 legado 选项后缀，见 url-options.ts）；判据同样看原文。
  if (urlOptionsEnabled) {
    for (const name of urlOptionFields(source.rules)) {
      const ir = compiled.get(name);
      if (ir && !('skipped' in ir)) compiled.set(name, { ...ir, urlOptions: true });
    }
  }
  cache.set(key, compiled);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return compiled;
}
