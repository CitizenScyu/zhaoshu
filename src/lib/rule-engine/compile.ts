// 源规则 → CompiledRules（逐字段编译 + 装饰字段 skip 标记 + LRU 缓存）。
// 设计依据：m1-engine-design.md §1 架构（compile.ts）、§7.1 的 EngineSource.compiled。
// 缓存键 = 语义版本化 sourceRevision（P0 引入 engineVersionedKey；P1a 起语义版本随
// ENGINE_SYNTAX_OR 联动——off=1 / on=2）：规则原文或引擎语义任一变化，键即变，旧编译
// 产物自然失效，不存在「|| 开关打开后仍复用 off 态编译缓存」的窗口。
import { searchOptionsMayUseWebView, searchOptionsNeedParity, searchTemplateNeedsJs } from '@/lib/source-parser';
import { upgradeSourceTemplateUrl } from '@/lib/source-policy';
import { sourceRevision } from '@/lib/source-revision';
import { engineSearchJsActive, engineSearchOptionsActive } from './compile-smoke';
import { AIO_LIST_FIELDS, aioGroups } from './aio-syntax';
import {
  initFieldSupported, initJsFieldSupported, initRuleTextSupported, jsChainFieldAllowed, listJsGroups, objectKeyOf, parseFieldRule, ruleHasJs,
  type ParseOptions, type SourceConsts,
} from './parse';
import type { CompiledRules, FieldIr, RuleIr } from './types';
import { analyzeJsLib, jsLibRuleProblem, type JsLib } from './js-lib';
import {
  engineSemanticsVersion, engineSyntaxAioEnabled, engineSyntaxAndEnabled, engineSyntaxInitEnabled, engineSyntaxJsBindEnabled, engineSyntaxJsEnabled,
  engineSyntaxJsExtEnabled, engineSyntaxJsGetEnabled, engineSyntaxJsonPathEnabled, engineSyntaxJsUtilEnabled, engineSyntaxListJsEnabled,
  engineSyntaxOrEnabled, engineSyntaxRegexEnabled, engineSyntaxVarsEnabled, engineSyntaxXPathEnabled, engineSyntaxXPathEvalEnabled, engineUrlOptionsEnabled,
  engineSearchWebViewEnabled, engineSyntaxInitJsEnabled, engineSyntaxJsoupEnabled, engineSyntaxVarsBagEnabled,
  engineSyntaxBookFieldsEnabled, engineSyntaxSearchVarsEnabled, engineSyntaxItemVarsEnabled, engineSyntaxListGetEnabled, ENGINE_SEMANTICS_VERSION,
  engineSyntaxBookVariableEnabled, engineSyntaxJsLibEnabled, engineSyntaxSourceBindEnabled, engineSyntaxInitJsoupEnabled,
} from './syntax-flags';
import { urlOptionFields } from './url-options';
import {
  ITEM_FIELD_ORDER, ITEM_JAVA_PUT_FIELDS, VAR_BAG_PUT_FIELDS, itemVarPlan, resolveSourceVars, ruleMayUseVars, searchVarPlan, varBagPlan,
  varPutRules, type ItemVarPlan, type SearchVarPlan,
} from './vars-subset';
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
  // jsoupEnabled（jsoup1028，ENGINE_SYNTAX_JSOUP）见 ParseOptions；compile 层另要求 JS 链对该源生效。
  // bookFieldsEnabled（book1028，ENGINE_SYNTAX_BOOK_FIELDS）见 ParseOptions；compile 层另要求 JS 链与宿主绑定对该源生效、canReName 为空。
  /** searchvars1028：搜索 URL put → 搜索字段 get 变量袋（ENGINE_SYNTAX_SEARCH_VARS，默认读 env；须 varsEnabled 与搜索 JS 同生效）。 */
  searchVarsEnabled?: boolean;
  /** itemvars1028：搜索条目袋（ENGINE_SYNTAX_ITEM_VARS，默认读 env；须搜索袋同生效）。 */
  itemVarsEnabled?: boolean;
  // listGetEnabled（listget1028，ENGINE_SYNTAX_LIST_GET）见 ParseOptions；compile 层另要求 JS 链对该源生效、列表 JS 与 getter 同开。
  /** bookvar1028：`book.getVariable`（ENGINE_SYNTAX_BOOK_VARIABLE，默认读 env；须 jsoup 与书籍成员同生效，源级键集见 sourceBookVariablePuts）。 */
  bookVariableEnabled?: boolean;
  /** jslib1028：jsLib 公共函数库（ENGINE_SYNTAX_JS_LIB，默认读 env；须 JS 链同开，库须过 js-lib.ts analyzeJsLib，见 sourceJsLib）。 */
  jsLibEnabled?: boolean;
  /** srcbind1028：书源常量代入（ENGINE_SYNTAX_SOURCE_BIND，默认读 env；须 JS 链对该源生效，见 sourceConstsOf）。变量袋/搜索袋/条目袋的字段不代入。 */
  sourceBindEnabled?: boolean;
  // initJsoupEnabled（initjsoup1028，ENGINE_SYNTAX_INIT_JSOUP）见 ParseOptions；compile 层另要求 JS init 与 jsoup 对该源同生效。
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
 * jsoup1028：ENGINE_SYNTAX_JSOUP on、JS 链对该源生效且有含 JS 的字段 off 态被拒、on 态编译通过（sourceUsesJsoupSyntax）时再加 jsoup 位（+4194304）。
 * book1028：ENGINE_SYNTAX_BOOK_FIELDS on、宿主绑定对该源生效、canReName 为空且有读 `book.` 成员的字段 off 态被拒、on 态编译通过
 * （sourceUsesBookSyntax）时再加书籍成员位（+8388608）。
 * searchvars1028：ENGINE_SYNTAX_VARS、ENGINE_SYNTAX_SEARCH_VARS 与搜索 JS 都生效且搜索袋对该源真生效（compileSearchVars 非 null）时
 * 再加搜索袋位（+16777216）。
 * itemvars1028：搜索袋各条件与 ENGINE_SYNTAX_ITEM_VARS 都生效且条目袋对该源真生效（compileItemVars 非 null）时再加条目袋位（+33554432）。
 * listget1028：ENGINE_SYNTAX_LIST_GET on、JS 链对该源生效、列表 JS 与 getter 同开且有列表字段 off 态被拒、on 态编译通过
 * （sourceUsesListGetSyntax）时再加列表 getter 位（+67108864）。其余位的探测不传本开关（读 env，与 compileSource 同口径）。
 * bookvar1028：ENGINE_SYNTAX_BOOK_VARIABLE on、jsoup 与书籍成员对该源生效且有字段 off 态被拒、on 态编译通过
 * （sourceUsesBookVariableSyntax）时再加书籍变量位（+134217728）。其余位的探测不传源级键集（同 listget1028 口径）。
 * jslib1028：ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JS_LIB 都 on 且库可复现（sourceJsLib 非 null）时，其余各位改在去掉 jsLib 的规则上判
 * （与 compileSource 开 JS 链同口径；内容 identity 仍按原规则），有字段带 JS（JS 段或 `{{}}`）时再加 jsLib 位（+268435456）。
 * srcbind1028：ENGINE_SYNTAX_SOURCE_BIND on、JS 链对该源生效且有字段不带书源常量被拒、带了编译通过（sourceUsesSourceBindSyntax）
 * 时再加书源常量位（+536870912）。
 * initjsoup1028：ENGINE_SYNTAX_INIT_JSOUP on、JS init 与 jsoup 对该源同生效且 init 只有经 jsoup 重编才是可复现 JS init
 * （sourceUsesInitJsoupSyntax）时再加 jsoup init 位（+1073741824，int4 最后一位）。其余位的探测不传本开关（读 env，同 listget1028 口径）。
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
  const libActive = sourceJsLib(source.rules, jsEnabled && (options.jsLibEnabled ?? engineSyntaxJsLibEnabled())) !== null;
  const rules = libActive ? withoutJsLib(source.rules) : source.rules;
  const probe = libActive ? { ...source, rules } : source;
  const jsChain = jsEnabled && !sourceHasJsLib(rules);
  // 下游 sourceUses* 的编译与 compileSource 同一组开关（jsBind/jsGet/jsUtil 只在 JS 链生效时有意义）。
  const jsBind = jsChain && jsBindEnabled;
  const jsGet = jsChain && jsGetEnabled;
  const jsUtil = jsChain && jsUtilEnabled;
  const jsoup = jsChain && (options.jsoupEnabled ?? engineSyntaxJsoupEnabled());
  const book = jsBind && (options.bookFieldsEnabled ?? engineSyntaxBookFieldsEnabled()) && !sourceCanReName(rules);
  const searchVars = varsEnabled && searchJsEnabled && (options.searchVarsEnabled ?? engineSyntaxSearchVarsEnabled());
  const itemVars = searchVars && (options.itemVarsEnabled ?? engineSyntaxItemVarsEnabled());
  const listGet = jsGet && listJsEnabled && (options.listGetEnabled ?? engineSyntaxListGetEnabled());
  const bookVariable = jsoup && book && (options.bookVariableEnabled ?? engineSyntaxBookVariableEnabled());
  const sourceBind = jsChain && (options.sourceBindEnabled ?? engineSyntaxSourceBindEnabled());
  const initJsoup = initJsEnabled && jsoup && (options.initJsoupEnabled ?? engineSyntaxInitJsoupEnabled());
  // jsoup1028：其余各位先按 jsoup 关判（与旧口径逐字相同），jsoup 开时再补判一次取并集——jsoup 重试能救活
  // 某开关的 off 态（如条目首段 JS 以 Element 起链），只按 jsoup 开判会把该位清掉、在池源 identity 白翻。
  // book1028 同理：书籍成员重试也能救活别的开关的 off 态，book 开时再按 book 开（jsoup 两态）补判。
  const soup = (probe: (jsoupEnabled: boolean, bookFieldsEnabled: boolean) => boolean) => probe(false, false)
    || (jsoup && probe(true, false)) || (book && (probe(false, true) || (jsoup && probe(true, true))));
  return engineVersionedKey(sourceRevision(source), engineSemanticsVersion(
    orEnabled && sourceUsesOrSyntax(rules),
    xpathEnabled && sourceUsesXPathSyntax(rules),
    varsEnabled && sourceUsesVarSyntax(rules),
    jsEnabled && sourceUsesJsSyntax(rules),
    xpathEnabled && xpathEval && soup((j, b) => sourceUsesXPathEval(rules, {
      orEnabled, varsEnabled, jsEnabled: jsChain, listJsEnabled, jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil,
      jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    regexEnabled && soup((j, b) => sourceUsesRegexSyntax(rules, {
      orEnabled, varsEnabled, jsEnabled: jsChain, xpathEnabled, xpathEvalEnabled: xpathEval, listJsEnabled, jsExtEnabled, jsBindEnabled: jsBind,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    orEnabled && andEnabled && soup((j, b) => sourceUsesAndSyntax(rules, {
      varsEnabled, jsEnabled: jsChain, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, listJsEnabled, jsExtEnabled, jsBindEnabled: jsBind,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    aioEnabled && sourceUsesAioSyntax(rules),
    searchJsEnabled && searchTemplateNeedsJs(source.searchUrl, upgradeSourceTemplateUrl(source.url)),
    jsChain && listJsEnabled && sourceUsesListJsSyntax(rules),
    jsChain && jsExtEnabled && soup((j, b) => sourceUsesJsExtSyntax(rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsBindEnabled: jsBind,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    jsBind && soup((j, b) => sourceUsesJsBindSyntax(rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    jsGet && soup((j, b) => sourceUsesJsGetSyntax(rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsBindEnabled: jsBind, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    jsUtil && soup((j, b) => sourceUsesJsUtilSyntax(rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    jsonPathEnabled && soup((j, b) => sourceUsesJsonPathSyntax(rules, {
      orEnabled, varsEnabled, jsEnabled: jsChain, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    initEnabled && soup((j, b) => sourceUsesInitSyntax(rules, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, jsEnabled: jsChain, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    searchOptionParity,
    urlOptionsEnabled && urlOptionFields(rules).size > 0,
    searchWebViewEnabled && searchOptionParity && searchOptionsMayUseWebView(source.searchUrl),
    initJsEnabled && jsChain && soup((j, b) => sourceUsesInitJsSyntax(rules, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    varsEnabled && (options.varBagEnabled ?? engineSyntaxVarsBagEnabled()) && compileVarBag(rules, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, jsEnabled: jsChain, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, initJsEnabled, jsoupEnabled: jsoup,
      bookFieldsEnabled: book, listGetEnabled: listGet,
    }) !== null,
    jsoup && [false, ...(book ? [true] : [])].some((b) => sourceUsesJsoupSyntax(rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, bookFieldsEnabled: b,
    })),
    book && sourceUsesBookSyntax(rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, initJsEnabled, jsoupEnabled: jsoup,
    }),
    searchVars && compileSearchVars(probe, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, jsEnabled: jsChain, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, initJsEnabled, jsoupEnabled: jsoup,
      bookFieldsEnabled: book, listGetEnabled: listGet,
    }) !== null,
    itemVars && compileItemVars(probe, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, jsEnabled: jsChain, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, initJsEnabled, jsoupEnabled: jsoup,
      bookFieldsEnabled: book, listGetEnabled: listGet,
    }) !== null,
    listGet && soup((j, b) => sourceUsesListGetSyntax(rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, jsExtEnabled,
      jsBindEnabled: jsBind, jsUtilEnabled: jsUtil, jsonPathEnabled, jsoupEnabled: j, bookFieldsEnabled: b,
    })),
    bookVariable && sourceUsesBookVariableSyntax(probe, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, initJsEnabled, listGetEnabled: listGet,
    }),
    libActive && someRule(rules, (rule) => ruleHasJs(rule) || rule.includes('{{')),
    sourceBind && sourceUsesSourceBindSyntax(source.rules, {
      orEnabled, varsEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
      jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, initJsEnabled, jsoupEnabled: jsoup,
      bookFieldsEnabled: book, listGetEnabled: listGet, bookVariablePuts: bookVariable ? sourceBookVariablePuts(source) ?? undefined : undefined,
    }),
    initJsoup && sourceUsesInitJsoupSyntax(rules, {
      orEnabled, xpathEnabled, xpathEvalEnabled: xpathEval, regexEnabled, andEnabled, aioEnabled, listJsEnabled,
      jsExtEnabled, jsBindEnabled: jsBind, jsGetEnabled: jsGet, jsUtilEnabled: jsUtil, jsonPathEnabled, bookFieldsEnabled: book,
      sourceConsts: sourceConstsOf(source.rules, sourceBind),
    }),
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

/** 源带 jsLib（公共函数库）：JS 段多半调用其中函数，沙箱不执行 jsLib，整源不开 JS 链（jslib1028 开且库可复现时除外，见 sourceJsLib）。 */
export function sourceHasJsLib(rules: Record<string, unknown>): boolean {
  return typeof rules.jsLib === 'string' && rules.jsLib.trim() !== '';
}

/**
 * jslib1028：`enabled`（ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JS_LIB 同开，由调用方判）且源带可复现的 jsLib（js-lib.ts analyzeJsLib）
 * 时返回库，该源照常开 JS 链、字段另过 jsLibRuleProblem；否则 null（带 jsLib 的源照旧整源不开 JS 链）。
 */
export function sourceJsLib(rules: Record<string, unknown>, enabled: boolean): JsLib | null {
  return enabled && sourceHasJsLib(rules) ? analyzeJsLib(rules.jsLib) : null;
}

/**
 * srcbind1028：`enabled`（开关与 JS 链对该源同生效，由调用方判）且 bookSourceUrl 是非空字符串时给出书源常量；带 jsLib 的源不代入
 * 注释（注释代码不过 jsLibRuleProblem，可能与库互相覆盖定义）。
 */
export function sourceConstsOf(rules: Record<string, unknown>, enabled: boolean): SourceConsts | undefined {
  const key = rules.bookSourceUrl;
  if (!enabled || typeof key !== 'string' || key === '') return undefined;
  const comment = rules.bookSourceComment;
  return typeof comment === 'string' && comment.trim() !== '' && !sourceHasJsLib(rules) ? { key, comment } : { key };
}

/** 去掉 jsLib 的规则视图（jslib1028：库可复现时，各语义位按开 JS 链的口径判）。 */
function withoutJsLib(rules: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...rules };
  delete rest.jsLib;
  return rest;
}

/**
 * jslib1028：编译产物按其规则文本过库（compileSource 后处理与准入求值同一口径）：任一文本不过 jsLibRuleProblem → undefined
 * （字段按不可解释处理）；有文本带 JS（JS 段或 `{{}}`）则挂库原文，否则原样。
 */
export function fieldWithJsLib(ir: FieldIr, texts: readonly (string | undefined)[], lib: JsLib): FieldIr | undefined {
  const present = texts.filter((t): t is string => typeof t === 'string');
  if (present.some((t) => jsLibRuleProblem(lib, t) !== undefined)) return undefined;
  return present.some((t) => ruleHasJs(t) || t.includes('{{')) ? { ...ir, jsLib: lib.code } : ir;
}

/** 字段全名（`组.字段`）在规则对象里的原文；不是非空字符串时 undefined。 */
export function ruleTextOf(rules: Record<string, unknown>, name: string): string | undefined {
  const dot = name.indexOf('.');
  const fields = rules[name.slice(0, dot)];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const rule = (fields as Record<string, unknown>)[name.slice(dot + 1)];
  return typeof rule === 'string' && rule.trim() ? rule : undefined;
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
    jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean; jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (!someRule(rules, ruleMayUseXPath)) return false;
  const listJsEnabled = options.listJsEnabled === true;
  const jsExtEnabled = options.jsExtEnabled === true;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.jsEnabled}:${listJsEnabled}:${jsExtEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
          jsBindEnabled, jsGetEnabled, jsUtilEnabled, jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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
    jsExtEnabled?: boolean; jsBindEnabled?: boolean; jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean; jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (!someRule(rules, (rule) => rule.includes('##'))) return false;
  const listJsEnabled = options.listJsEnabled === true;
  const jsExtEnabled = options.jsExtEnabled === true;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.jsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${listJsEnabled}:${jsExtEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
          jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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
    jsExtEnabled?: boolean; jsBindEnabled?: boolean; jsGetEnabled?: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean; jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (!someRule(rules, (rule) => rule.includes('&&'))) return false;
  const listJsEnabled = options.listJsEnabled === true;
  const jsExtEnabled = options.jsExtEnabled === true;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.varsEnabled}:${options.jsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${listJsEnabled}:${jsExtEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
        jsUtilEnabled, jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: name,
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
    jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleHasJs)) return false;
  const jsBindEnabled = options.jsBindEnabled === true;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${jsBindEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
        listJsEnabled: options.listJsEnabled, jsExtEnabled, jsBindEnabled, jsGetEnabled, jsUtilEnabled, jsonPathEnabled, jsoupEnabled,
        bookFieldsEnabled, field: `${group}.${field}`,
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
    jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleMayUseJsBind)) return false;
  const jsGetEnabled = options.jsGetEnabled === true;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${jsGetEnabled}:${jsUtilEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
        jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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
    jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleMayUseJsGet)) return false;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${jsUtilEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
        jsUtilEnabled, jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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

const listGetMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_LIST_GET 改变编译结果（listget1028）：on 态只放行列表 JS 里 off 态被拒的 getter 调用，所以对
 * bookList/chapterList（非 AllInOne 组、含 getter 字样）按两态（JS、列表 JS、getter 开，其余开关同 compileSource）各编译一次，
 * 有字段 off 拒、on 过即算。调用方须确认 JS 链对该源生效、列表 JS 与 getter 同开。
 */
export function sourceUsesListGetSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsUtilEnabled?: boolean; jsonPathEnabled?: boolean;
    jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleMayUseJsGet)) return false;
  const jsUtilEnabled = options.jsUtilEnabled === true;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${jsUtilEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
  let memo = listGetMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const [group, list] of Object.entries(AIO_LIST_FIELDS)) {
    const fields = sourceRules[group];
    if (uses || aio.has(group) || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    const rule = (fields as Record<string, unknown>)[list];
    if (typeof rule !== 'string' || !ruleMayUseJsGet(rule)) continue;
    const parse = (listGetEnabled: boolean) => parseFieldRule(rule, {
      orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
      regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: false,
      listJsEnabled: true, jsExtEnabled: options.jsExtEnabled, jsBindEnabled: options.jsBindEnabled, jsGetEnabled: true, listGetEnabled,
      jsUtilEnabled, jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${list}`,
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
    }
  }
  if (!memo) {
    memo = new Map();
    listGetMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const jsUtilMemo = new WeakMap<object, Map<string, boolean>>();

/** 可能受 jsutil1028 影响的规则：JS 规则里出现加解密帮手、toNumChapter 或 t2s（t2s1029）的名字。宁宽勿漏，实编译再判。 */
function ruleMayUseJsUtil(rule: string): boolean {
  return ruleHasJs(rule) && /java\s*\.\s*(?:createSymmetricCrypto|aes|des|tripleDES|toNumChapter|t2s)/.test(rule);
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
    jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleMayUseJsUtil)) return false;
  const jsonPathEnabled = options.jsonPathEnabled === true;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${jsonPathEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
        jsGetEnabled: options.jsGetEnabled, jsUtilEnabled, jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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

const jsoupMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_JSOUP 改变编译结果（jsoup1028）：on 态只重试 off 态被拒的含 JS 字段（parse.ts parseFieldRule 的
 * jsoupFrame 重试），所以对含 JS 的字段按两态（JS 开，其余开关同 compileSource）各编译一次，有字段 off 拒、on 过即算。
 * 调用方须确认 JS 链对该源生效（ENGINE_SYNTAX_JS on、无 jsLib）。
 */
export function sourceUsesJsoupSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean;
    jsonPathEnabled: boolean; bookFieldsEnabled?: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || !someRule(rules, ruleHasJs)) return false;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}:${bookFieldsEnabled}`;
  let memo = jsoupMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  const listJs = options.listJsEnabled ? listJsGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !ruleHasJs(rule)) continue;
      const parse = (jsoupEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, listJsGroup: listJs.has(group), jsExtEnabled: options.jsExtEnabled,
        jsBindEnabled: options.jsBindEnabled, jsGetEnabled: options.jsGetEnabled, jsUtilEnabled: options.jsUtilEnabled,
        jsonPathEnabled: options.jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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
    jsoupMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const bookMemo = new WeakMap<object, Map<string, boolean>>();

/** 可能受 book1028 影响的规则：出现 `book.` 成员访问（parse.ts bookRetryMembers 同一文本判据）。实编译再判。 */
function ruleMayUseBook(rule: string): boolean {
  return /(?<![\w$.])book\s*\./.test(rule);
}

/**
 * `ruleBookInfo.canReName` 非空（legado analyzeBookInfo 此时允许详情覆盖搜索带来的书名/作者，详情阶段 book.name/author 的值随之
 * 不定）：book1028 对这类源整源不生效。非字符串的非空值同样按非空算（宁严）。
 */
export function sourceCanReName(rules: Record<string, unknown>): boolean {
  const info = rules.ruleBookInfo;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
  const value = (info as Record<string, unknown>).canReName;
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null && value !== false;
}

/**
 * 源是否会因 ENGINE_SYNTAX_BOOK_FIELDS 改变编译结果（book1028）：on 态只重编 off 态（含 jsoup 重试）被拒的字段（parse.ts
 * bookFrame），所以对含 `book.` 的字段按两态（JS 与宿主绑定开，其余开关同 compileSource）各编译一次，有字段 off 拒、on 过即算。
 * 调用方须确认 JS 链与宿主绑定对该源生效；canReName 非空的源恒 false（compileSource 对它不开 book）。
 */
export function sourceUsesBookSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean; jsonPathEnabled: boolean;
    initJsEnabled: boolean; jsoupEnabled: boolean;
  },
): boolean {
  if (sourceHasJsLib(rules) || sourceCanReName(rules) || !someRule(rules, ruleMayUseBook)) return false;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}:${options.initJsEnabled}:${options.jsoupEnabled}`;
  let memo = bookMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  const listJs = options.listJsEnabled ? listJsGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !ruleMayUseBook(rule)) continue;
      const parse = (bookFieldsEnabled: boolean) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, listJsGroup: listJs.has(group), jsExtEnabled: options.jsExtEnabled, jsBindEnabled: true,
        jsGetEnabled: options.jsGetEnabled, jsUtilEnabled: options.jsUtilEnabled, jsonPathEnabled: options.jsonPathEnabled,
        initJsEnabled: options.initJsEnabled, jsoupEnabled: options.jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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
    bookMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const bookVariablePutsMemo = new WeakMap<object, { searchUrl: unknown; puts: ReadonlySet<string> | null }>();

/**
 * 放变量的调用：AnalyzeRule.put（有 book 时落 book.putVariable）、put(Big)Variable 与 putCustomVariable（键恒为 custom）。
 * 字面量键后须紧跟 `,`/`)`（putkey1029：`"k" + i`、`a ? "x" : "y"` 之类拼出的键不算字面量，按动态键整源 null）。
 */
const BOOK_VARIABLE_PUT_RE = /(?<![\w$])(java\s*\.\s*put|put(?:Big)?Variable|putCustomVariable)\s*\(\s*(?:("[^"\\\n]*"|'[^'\\\n]*')\s*(?=[,)]))?/g;
/**
 * 绕过上面字面量扫描的写法：`java` 被当值用（取别名、传参）、下标取 put、直接写 variable/variableMap、整包 setVariable
 * （`source.setVariable` 写的是源变量，不算）、eval/Function 拼代码。
 */
const BOOK_VARIABLE_OPAQUE_RE = /(?<![\w$.])java(?![\w$])(?!\s*\.)|\[\s*["'`]\s*put|\bvariableMap\b|\.\s*variable\s*=(?!=)|(?<!\bsource\s*\.\s*)\bsetVariable\b|(?<![\w$.])(?:eval|Function)\s*\(/;

/**
 * bookvar1028：源内会往 legado 书籍变量里放的键（`@put:{}` 的键按 `键:` 宁宽地收）。扫搜索地址与规则对象里的全部字符串（含 jsLib、
 * 发现、登录等——legado 跑到它们时同样能放，搜索时放进 SearchBook 的变量随 toBook 带进书架）。键不是不含转义的字面量、
 * `@put:` 后不是一层 `{}`、或命中 BOOK_VARIABLE_OPAQUE_RE 时返回 null（整源不放行 book.getVariable）。宁严勿漏。
 */
export function sourceBookVariablePuts(source: { searchUrl: unknown; rules: Record<string, unknown> }): ReadonlySet<string> | null {
  const hit = bookVariablePutsMemo.get(source.rules);
  if (hit && hit.searchUrl === source.searchUrl) return hit.puts;
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') texts.push(value);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  };
  walk(source.searchUrl);
  walk(source.rules);
  let puts: Set<string> | null = new Set();
  scan: for (const text of texts) {
    if (BOOK_VARIABLE_OPAQUE_RE.test(text)) {
      puts = null;
      break;
    }
    for (const match of text.matchAll(BOOK_VARIABLE_PUT_RE)) {
      if (match[1] === 'putCustomVariable') puts.add('custom');
      else if (match[2] === undefined) {
        puts = null;
        break scan;
      } else puts.add(match[2].slice(1, -1));
    }
    for (const match of text.matchAll(/@put:\s*(\{[^{}]*\})?/gi)) {
      if (match[1] === undefined) {
        puts = null;
        break scan;
      }
      for (const key of match[1].matchAll(/["']?([^"'{},:\s]+)["']?\s*:/g)) puts.add(key[1]);
    }
  }
  bookVariablePutsMemo.set(source.rules, { searchUrl: source.searchUrl, puts });
  return puts;
}

const bookVariableMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_BOOK_VARIABLE 改变编译结果（bookvar1028）：on 态只在 jsoup + 书籍成员重试帧里多放行 book.getVariable，
 * 所以对含 `getVariable` 的字段按两态（JS、宿主绑定、jsoup、书籍成员开，其余开关同 compileSource）各编译一次，有字段 off 拒、
 * on 过即算。调用方须确认 jsoup 与书籍成员对该源生效；源级扫描（sourceBookVariablePuts）为 null 时恒 false。
 */
export function sourceUsesBookVariableSyntax(
  source: { searchUrl: unknown; rules: Record<string, unknown> },
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean; jsonPathEnabled: boolean;
    initJsEnabled: boolean; listGetEnabled: boolean;
  },
): boolean {
  const rules = source.rules;
  if (sourceHasJsLib(rules) || sourceCanReName(rules) || !someRule(rules, (rule) => rule.includes('getVariable'))) return false;
  const puts = sourceBookVariablePuts(source);
  if (puts === null) return false;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}:${options.initJsEnabled}:${options.listGetEnabled}`;
  let memo = bookVariableMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  const listJs = options.listJsEnabled ? listJsGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !rule.includes('getVariable')) continue;
      const parse = (bookVariablePuts: ReadonlySet<string> | undefined) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, listJsGroup: listJs.has(group), jsExtEnabled: options.jsExtEnabled, jsBindEnabled: true,
        jsGetEnabled: options.jsGetEnabled, jsUtilEnabled: options.jsUtilEnabled, jsonPathEnabled: options.jsonPathEnabled,
        initJsEnabled: options.initJsEnabled, jsoupEnabled: true, bookFieldsEnabled: true, listGetEnabled: options.listGetEnabled,
        bookVariablePuts, field: `${group}.${field}`,
      });
      try {
        parse(puts);
      } catch {
        continue; // on 态也编译不过：两态都 skipped
      }
      try {
        parse(undefined);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    bookVariableMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

const sourceBindMemo = new WeakMap<object, Map<string, boolean>>();

/** 可能读到书源常量的规则（srcbind1028 预筛，宁宽勿漏）。 */
function ruleMayUseSourceConsts(rule: string): boolean {
  return /source\s*\.\s*(?:key|bookSourceUrl|getKey|getBookSourceUrl|bookSourceComment)/.test(rule);
}

/**
 * 源是否会因 ENGINE_SYNTAX_SOURCE_BIND 改变编译结果（srcbind1028）：不带书源常量时代码位置的 `source` 一律拒，代入只救活被拒的
 * 字段，所以对候选字段按 compileSource 主循环的同一组开关（JS 链开）带/不带书源常量各编译一次，有字段不带拒、带了过即算。
 * 调用方须确认 JS 链对该源生效；`rules` 为源原文（书源常量与主循环都取它）。
 */
export function sourceUsesSourceBindSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; varsEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean;
    jsonPathEnabled: boolean; initJsEnabled: boolean; jsoupEnabled: boolean; bookFieldsEnabled: boolean; listGetEnabled: boolean;
    bookVariablePuts?: ReadonlySet<string>;
  },
): boolean {
  const consts = sourceConstsOf(rules, true);
  if (consts === undefined || !someRule(rules, ruleMayUseSourceConsts)) return false;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}:${options.initJsEnabled}:${options.jsoupEnabled}:${options.bookFieldsEnabled}:${options.listGetEnabled}:${options.bookVariablePuts !== undefined}`;
  let memo = sourceBindMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  const sourceRules = options.varsEnabled ? resolveSourceVars(rules) : rules;
  const aio = options.aioEnabled ? aioGroups(sourceRules) : new Set<string>();
  const listJs = options.listJsEnabled ? listJsGroups(sourceRules) : new Set<string>();
  let uses = false;
  for (const group of RULE_GROUPS) {
    const fields = sourceRules[group];
    if (uses || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [field, rule] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !rule.trim() || !ruleMayUseSourceConsts(rule)) continue;
      const parse = (sourceConsts: SourceConsts | undefined) => parseFieldRule(rule, {
        orEnabled: options.orEnabled, xpathEnabled: options.xpathEnabled, xpathEvalEnabled: options.xpathEvalEnabled, jsEnabled: true,
        regexEnabled: options.regexEnabled, andEnabled: options.andEnabled, aioEnabled: options.aioEnabled, aioGroup: aio.has(group),
        listJsEnabled: options.listJsEnabled, listJsGroup: listJs.has(group), jsExtEnabled: options.jsExtEnabled,
        jsBindEnabled: options.jsBindEnabled, jsGetEnabled: options.jsGetEnabled, jsUtilEnabled: options.jsUtilEnabled,
        jsonPathEnabled: options.jsonPathEnabled, initJsEnabled: options.initJsEnabled, jsoupEnabled: options.jsoupEnabled,
        bookFieldsEnabled: options.bookFieldsEnabled, listGetEnabled: options.listGetEnabled, bookVariablePuts: options.bookVariablePuts,
        sourceConsts, field: `${group}.${field}`,
      });
      try {
        parse(consts);
      } catch {
        continue; // 带书源常量也编译不过：两态都 skipped
      }
      try {
        parse(undefined);
      } catch {
        uses = true;
        break;
      }
    }
  }
  if (!memo) {
    memo = new Map();
    sourceBindMemo.set(rules, memo);
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
    jsUtilEnabled: boolean; jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  if (!someRule(rules, ruleMayUseJsonPath)) return false;
  const jsoupEnabled = options.jsoupEnabled === true;
  const bookFieldsEnabled = options.bookFieldsEnabled === true;
  const memoKey = `${options.orEnabled}:${options.varsEnabled}:${options.jsEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${jsoupEnabled}:${bookFieldsEnabled}`;
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
        jsGetEnabled: options.jsGetEnabled, jsUtilEnabled: options.jsUtilEnabled, jsonPathEnabled, jsoupEnabled, bookFieldsEnabled, field: `${group}.${field}`,
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
    jsonPathEnabled: boolean; jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  const rule = initRuleOf(rules);
  if (!initRuleTextSupported(rule)) return false;
  const memoKey = `${options.orEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.jsEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}:${options.jsoupEnabled === true}:${options.bookFieldsEnabled === true}`;
  let memo = initMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  let field: FieldIr | undefined;
  try {
    field = parseFieldRule(rule as string, {
      ...options, jsoupEnabled: options.jsoupEnabled === true, bookFieldsEnabled: options.bookFieldsEnabled === true, field: 'ruleBookInfo.init',
    });
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
const initJsoupMemo = new WeakMap<object, Map<string, boolean>>();

/**
 * 源是否会因 ENGINE_SYNTAX_INIT_JSOUP 改变详情页求值（initjsoup1028）：init 原文含 JS、按 compileSource 同一组开关（JS 链、JS init、
 * jsoup 与本开关都开，书源常量同主循环）编译后是可复现的 JS init，且是 jsoup 重编出来的（FieldIr.jsoup：off 态口径被拒才会重编）。
 * 调用方还须确认 JS init 与 jsoup 对该源同生效。
 */
export function sourceUsesInitJsoupSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean;
    jsonPathEnabled: boolean; bookFieldsEnabled: boolean; sourceConsts?: SourceConsts;
  },
): boolean {
  const rule = initRuleOf(rules);
  if (typeof rule !== 'string' || !ruleHasJs(rule.trim())) return false;
  const memoKey = `${options.orEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}:${options.bookFieldsEnabled}:${options.sourceConsts !== undefined}`;
  let memo = initJsoupMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  let field: FieldIr | undefined;
  try {
    field = parseFieldRule(rule, {
      ...options, jsEnabled: true, initJsEnabled: true, jsoupEnabled: true, initJsoupEnabled: true, field: 'ruleBookInfo.init',
    });
  } catch {
    field = undefined;
  }
  const uses = field?.jsoup === true && initJsApplies(rule, field);
  if (!memo) {
    memo = new Map();
    initJsoupMemo.set(rules, memo);
  }
  memo.set(memoKey, uses);
  return uses;
}

/**
 * 源是否会因 ENGINE_SYNTAX_INIT_JS 改变详情页求值（initjs1028）：init 原文含 JS、按 compileSource 同一组开关（JS 链已开）编译后
 * 是可复现的 JS init。调用方还须确认 ENGINE_SYNTAX_INIT 与 JS 链（ENGINE_SYNTAX_JS on、无 jsLib）都生效。
 */
export function sourceUsesInitJsSyntax(
  rules: Record<string, unknown>,
  options: {
    orEnabled: boolean; xpathEnabled: boolean; xpathEvalEnabled: boolean; regexEnabled: boolean; andEnabled: boolean;
    aioEnabled: boolean; listJsEnabled: boolean; jsExtEnabled: boolean; jsBindEnabled: boolean; jsGetEnabled: boolean; jsUtilEnabled: boolean;
    jsonPathEnabled: boolean; jsoupEnabled?: boolean;
    bookFieldsEnabled?: boolean;
  },
): boolean {
  const rule = initRuleOf(rules);
  if (typeof rule !== 'string' || !ruleHasJs(rule.trim())) return false;
  const memoKey = `${options.orEnabled}:${options.xpathEnabled}:${options.xpathEvalEnabled}:${options.regexEnabled}:${options.andEnabled}:${options.aioEnabled}:${options.listJsEnabled}:${options.jsExtEnabled}:${options.jsBindEnabled}:${options.jsGetEnabled}:${options.jsUtilEnabled}:${options.jsonPathEnabled}:${options.jsoupEnabled === true}:${options.bookFieldsEnabled === true}`;
  let memo = initJsMemo.get(rules);
  const hit = memo?.get(memoKey);
  if (hit !== undefined) return hit;
  let field: FieldIr | undefined;
  try {
    field = parseFieldRule(rule, {
      ...options, jsEnabled: true, initJsEnabled: true, jsoupEnabled: options.jsoupEnabled === true,
      bookFieldsEnabled: options.bookFieldsEnabled === true, field: 'ruleBookInfo.init',
    });
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
  const base = bagParseBase(rules, options);
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

/** 变量袋编译（varbag1028 / searchvars1028）的语法开关基底：`options` 缺省的读 env（与 parseFieldRule 同口径）。 */
function bagParseBase(rules: Record<string, unknown>, options: ParseOptions): ParseOptions {
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
    jsoupEnabled: js && (options.jsoupEnabled ?? engineSyntaxJsoupEnabled()),
  };
  // book1028：同 compileSource（宿主绑定生效、canReName 为空才开）。
  base.bookFieldsEnabled = base.jsBindEnabled === true && (options.bookFieldsEnabled ?? engineSyntaxBookFieldsEnabled()) && !sourceCanReName(rules);
  // listget1028：同 compileSource（列表 JS 与 getter 同开才开）。
  base.listGetEnabled = base.listJsEnabled === true && base.jsGetEnabled === true && (options.listGetEnabled ?? engineSyntaxListGetEnabled());
  return base;
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

// ---- 搜索 URL put → 搜索字段 get 变量袋（searchvars1028）----
const searchVarsMemo = new WeakMap<object, Map<string, ReadonlyMap<string, FieldIr> | null>>();

/** 搜索袋实际生效：ENGINE_SYNTAX_VARS、ENGINE_SYNTAX_SEARCH_VARS 与搜索 JS（ENGINE_POST_SEARCH + ENGINE_SEARCH_JS）都开。 */
export function engineSearchVarsActive(): boolean {
  return engineSyntaxVarsEnabled() && engineSyntaxSearchVarsEnabled() && engineSearchJsActive();
}

/**
 * 搜索袋生效时要换掉的搜索字段（字段全名 → get 模式编译结果，挂 varGets），不生效返回 null（整源照旧）。
 * 先按 vars-subset.ts searchVarPlan 文本粗筛，且 searchUrl 须走搜索 JS（searchTemplateNeedsJs；旧口径构造得出的模板不跑 JS，
 * 袋恒空），再逐字段在 get 模式下编译核实：任一计划字段编译不过、收进来的键没被 searchUrl put、ruleSearch 是 AllInOne、
 * 或最后没有字段真读袋，一律 null。compileSource / compileAdmission / engineSourceRevision 同一判据；开关由调用方判
 * （engineSearchVarsActive），`options` 缺省的语法开关读 env。
 */
export function compileSearchVars(
  source: { url: string; searchUrl: unknown; rules: Record<string, unknown> }, options: ParseOptions = {},
): ReadonlyMap<string, FieldIr> | null {
  const plan = searchVarPlan(source.rules, source.searchUrl);
  if (!plan || !searchTemplateNeedsJs(source.searchUrl, upgradeSourceTemplateUrl(source.url))) return null;
  const base = bagParseBase(source.rules, options);
  const memoKey = JSON.stringify([base, source.searchUrl]); // put 键来自 searchUrl，可能不在 rules 对象里
  let memo = searchVarsMemo.get(source.rules);
  if (!memo) {
    memo = new Map();
    searchVarsMemo.set(source.rules, memo);
  }
  if (memo.has(memoKey)) return memo.get(memoKey)!;
  const out = buildSearchVars(source.rules, plan, base);
  memo.set(memoKey, out);
  return out;
}

function buildSearchVars(rules: Record<string, unknown>, plan: SearchVarPlan, base: ParseOptions): ReadonlyMap<string, FieldIr> | null {
  const sourceRules = resolveSourceVars(rules);
  if (base.aioEnabled && aioGroups(sourceRules).has('ruleSearch')) return null;
  const listJsGroup = base.jsEnabled === true && base.listJsEnabled === true && listJsGroups(sourceRules).has('ruleSearch');
  const search = (sourceRules.ruleSearch ?? {}) as Record<string, unknown>;
  const out = new Map<string, FieldIr>();
  try {
    for (const name of plan.gets.keys()) {
      const field = `ruleSearch.${name}`;
      const keys = new Set<string>();
      const ir = parseFieldRule(String(search[name]), { ...base, field, listJsGroup, varBag: { mode: 'get', keys } });
      if (keys.size === 0) continue; // get 只出现在字面量/注释里：字段不读袋，普通编译即可
      for (const key of keys) if (!plan.puts.has(key)) return null;
      out.set(field, { ...ir, varGets: true });
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

// ---- 搜索条目袋（itemvars1028）----
const itemVarsMemo = new WeakMap<object, Map<string, ReadonlyMap<string, FieldIr> | null>>();

/** 条目袋实际生效：搜索袋生效（engineSearchVarsActive）且 ENGINE_SYNTAX_ITEM_VARS 开。 */
export function engineItemVarsActive(): boolean {
  return engineSearchVarsActive() && engineSyntaxItemVarsEnabled();
}

/** 条目 put 值规则的编译口径：同 VAR_PUT_VALUE_FIELD，在条目上按非 URL 字符串字段编、不含 JS。 */
const ITEM_PUT_VALUE_FIELD = 'ruleSearch.name';

/**
 * 条目袋生效时要换掉的字段（字段全名 → 带 varPuts/varPut/varGets/itemVars 的编译结果），不生效返回 null（整源照旧）。
 * 先按 vars-subset.ts itemVarPlan 文本粗筛（searchUrl 有 put 时还须走搜索 JS），再逐字段编译核实：条目字段按 legado 顺序，
 * kind…coverUrl 的 `@put` 挪到 bookUrl 前面；读袋字段在 get 模式、放 `java.put` 的字段在 put 模式下编译（字段规则用
 * resolveSourceVars 改写过的，put 值规则另编）。任一字段编译不过、收进来的键不在计划里（条目字段只读 searchUrl 与更前字段的键，
 * 详情只读搜索侧且详情不放的键，目录读搜索侧或详情的键）、ruleSearch/ruleToc 是 AllInOne、或编译后没有字段真读搜索侧的键
 * （只有搜索字段读 searchUrl 的键不算），一律 null。compileSource / compileAdmission / engineSourceRevision 同一判据；开关由
 * 调用方判（engineItemVarsActive），`options` 缺省的语法开关读 env。
 */
export function compileItemVars(
  source: { url: string; searchUrl: unknown; rules: Record<string, unknown> }, options: ParseOptions = {},
): ReadonlyMap<string, FieldIr> | null {
  const plan = itemVarPlan(source.rules, source.searchUrl);
  if (!plan || (plan.urlPuts.size > 0 && !searchTemplateNeedsJs(source.searchUrl, upgradeSourceTemplateUrl(source.url)))) return null;
  const base = bagParseBase(source.rules, options);
  const memoKey = JSON.stringify([base, source.searchUrl]); // put 键来自 searchUrl，可能不在 rules 对象里
  let memo = itemVarsMemo.get(source.rules);
  if (!memo) {
    memo = new Map();
    itemVarsMemo.set(source.rules, memo);
  }
  if (memo.has(memoKey)) return memo.get(memoKey)!;
  const out = buildItemVars(source.rules, plan, base);
  memo.set(memoKey, out);
  return out;
}

function buildItemVars(rules: Record<string, unknown>, plan: ItemVarPlan, base: ParseOptions): ReadonlyMap<string, FieldIr> | null {
  const sourceRules = resolveSourceVars(rules);
  if (base.aioEnabled) {
    const aio = aioGroups(sourceRules);
    if (aio.has('ruleSearch') || aio.has('ruleToc')) return null;
  }
  const listJs = base.jsEnabled && base.listJsEnabled ? listJsGroups(sourceRules) : new Set<string>();
  const group = (from: Record<string, unknown>, name: string) => (from[name] ?? {}) as Record<string, unknown>;
  const ruleOf = (fields: Record<string, unknown>, name: string) => (typeof fields[name] === 'string' ? fields[name] as string : '');
  const searchKeys = new Set(plan.urlPuts);
  for (const keys of plan.searchPuts.values()) for (const key of keys) searchKeys.add(key);
  const infoKeys = new Set<string>();
  for (const keys of plan.infoPuts.values()) for (const key of keys) infoKeys.add(key);
  const putValues = (raw: string, field: string): Array<readonly [string, FieldIr]> => {
    const map = varPutRules(raw);
    if (!map) throw new Error('put');
    return [...map].map(([key, rule]) => [key, parseFieldRule(rule, { ...base, jsEnabled: false, field })] as const);
  };
  /** 一个字段换成袋口径：`gets` 有键走 get 模式，否则 put 模式（收 java.put 键）；`puts` 挂在字段规则之前求值。 */
  const bagField = (
    rule: string, field: string, listJsGroup: boolean, gets: ReadonlySet<string> | undefined, javaAllowed: ReadonlySet<string> | undefined,
    puts: Array<readonly [string, FieldIr]>,
  ): { ir: FieldIr; reads: ReadonlySet<string>; javaPut: boolean } | null => {
    const keys = new Set<string>();
    // 只剩 @put 的字段：legado 字段规则为空串，取值为空。
    const ir: FieldIr = rule.trim() === ''
      ? { rules: [{ kind: 'text', literal: '' }] }
      : parseFieldRule(rule, { ...base, field, listJsGroup, varBag: { mode: gets ? 'get' : 'put', keys } });
    if (gets) {
      for (const key of keys) if (!gets.has(key)) return null;
    } else {
      for (const key of keys) if (!javaAllowed?.has(key)) return null;
    }
    const bagged: FieldIr = { ...ir };
    if (puts.length > 0) bagged.varPuts = puts;
    if (!gets && keys.size > 0) bagged.varPut = true;
    if (gets && keys.size > 0) bagged.varGets = true;
    return { ir: bagged, reads: gets ? keys : new Set(), javaPut: !gets && keys.size > 0 };
  };
  const out = new Map<string, FieldIr>();
  let active = false;
  try {
    // 条目字段：门面求值 name/author/bookUrl（bookList 只读 searchUrl 的键），其余字段的 put 挪到 bookUrl 前。
    const search = group(sourceRules, 'ruleSearch');
    const rawSearch = group(rules, 'ruleSearch');
    const searchListJs = listJs.has('ruleSearch');
    const listGets = plan.gets.get('ruleSearch.bookList');
    if (listGets) {
      const done = bagField(ruleOf(search, 'bookList'), 'ruleSearch.bookList', searchListJs, listGets, undefined, []);
      if (!done) return null;
      if (done.reads.size > 0) out.set('ruleSearch.bookList', done.ir);
    }
    const pending: Array<readonly [string, FieldIr]> = [];
    for (const name of ITEM_FIELD_ORDER) {
      const field = `ruleSearch.${name}`;
      const putKeys = plan.searchPuts.get(name);
      const puts = putKeys ? putValues(ruleOf(rawSearch, name), ITEM_PUT_VALUE_FIELD) : [];
      if (!ITEM_JAVA_PUT_FIELDS.has(name)) {
        pending.push(...puts);
        continue;
      }
      if (name === 'bookUrl') puts.unshift(...pending);
      const gets = plan.gets.get(field);
      if (puts.length === 0 && !putKeys && !gets) continue;
      const done = bagField(ruleOf(search, name), field, searchListJs, gets, putKeys, puts);
      if (!done) return null;
      const readsItem = [...done.reads].some((key) => !plan.urlPuts.has(key));
      if (readsItem) active = true;
      if (puts.length === 0 && !done.javaPut && done.reads.size === 0) continue;
      out.set(field, puts.length > 0 || done.javaPut || readsItem ? { ...done.ir, itemVars: true } : done.ir);
    }
    // 详情字段：放的同 varbag1028，读的只认搜索侧放、详情不放的键。
    const info = group(sourceRules, 'ruleBookInfo');
    const rawInfo = group(rules, 'ruleBookInfo');
    const infoAllowed = new Set([...searchKeys].filter((key) => !infoKeys.has(key)));
    for (const name of VAR_BAG_PUT_FIELDS) {
      const field = `ruleBookInfo.${name}`;
      const putKeys = plan.infoPuts.get(name);
      const planGets = plan.gets.get(field);
      if (!putKeys && !planGets) continue;
      const gets = planGets ? new Set([...planGets].filter((key) => infoAllowed.has(key))) : undefined;
      const done = bagField(ruleOf(info, name), field, false, gets, putKeys, putKeys ? putValues(ruleOf(rawInfo, name), VAR_PUT_VALUE_FIELD) : []);
      if (!done) return null;
      if (done.reads.size > 0) active = true;
      if (done.ir.varPuts === undefined && !done.javaPut && done.reads.size === 0) continue;
      out.set(field, done.reads.size > 0 ? { ...done.ir, itemVars: true } : done.ir);
    }
    // 目录字段：读搜索侧或详情放的键；读到详情不覆盖的搜索侧键才要门面带袋。
    const toc = group(sourceRules, 'ruleToc');
    const tocAllowed = new Set([...searchKeys, ...infoKeys]);
    for (const [field, planGets] of plan.gets) {
      if (!field.startsWith('ruleToc.')) continue;
      const done = bagField(ruleOf(toc, field.slice('ruleToc.'.length)), field, listJs.has('ruleToc'), tocAllowed, undefined, []);
      if (!done) return null;
      if (done.reads.size === 0) continue;
      for (const key of done.reads) if (!planGets.has(key)) return null;
      if ([...done.reads].some((key) => searchKeys.has(key))) active = true;
      out.set(field, [...done.reads].some((key) => searchKeys.has(key) && !infoKeys.has(key)) ? { ...done.ir, itemVars: true } : done.ir);
    }
    return active ? out : null;
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
  // jsLib 源不开 JS 链（见 sourceHasJsLib）：字段里的 JS 照旧 unsupported_js；jslib1028 开且库可复现时照常开（见 sourceJsLib）。
  const jsRequested = options.jsEnabled ?? engineSyntaxJsEnabled();
  const jsLibEnabled = options.jsLibEnabled ?? engineSyntaxJsLibEnabled();
  const jsLib = sourceJsLib(source.rules, jsRequested && jsLibEnabled);
  const jsEnabled = jsRequested && (!sourceHasJsLib(source.rules) || jsLib !== null);
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
  const jsoupEnabled = jsEnabled && (options.jsoupEnabled ?? engineSyntaxJsoupEnabled());
  const bookFieldsEnabled = jsEnabled && jsBindEnabled && (options.bookFieldsEnabled ?? engineSyntaxBookFieldsEnabled())
    && !sourceCanReName(source.rules);
  const searchJsEnabled = options.searchJsEnabled ?? engineSearchJsActive();
  const searchVarsEnabled = varsEnabled && searchJsEnabled && (options.searchVarsEnabled ?? engineSyntaxSearchVarsEnabled());
  const itemVarsEnabled = searchVarsEnabled && (options.itemVarsEnabled ?? engineSyntaxItemVarsEnabled());
  const listGetEnabled = jsEnabled && listJsEnabled && jsGetEnabled && (options.listGetEnabled ?? engineSyntaxListGetEnabled());
  const bookVariableEnabled = jsoupEnabled && bookFieldsEnabled && (options.bookVariableEnabled ?? engineSyntaxBookVariableEnabled());
  // bookvar1028：源级键集为 null（有动态键的放变量写法等）时整源不放行。
  const bookVariablePuts = bookVariableEnabled ? sourceBookVariablePuts(source) ?? undefined : undefined;
  // srcbind1028：书源常量只进主循环（袋字段不代入）。
  const sourceBindEnabled = jsEnabled && (options.sourceBindEnabled ?? engineSyntaxSourceBindEnabled());
  const sourceConsts = sourceConstsOf(source.rules, sourceBindEnabled);
  // initjsoup1028：init 的 jsoup 重编须 JS init 与 jsoup 同生效。
  const initJsoupEnabled = initJsEnabled && jsoupEnabled && (options.initJsoupEnabled ?? engineSyntaxInitJsoupEnabled());
  const key = engineSourceRevision(source, {
    orEnabled, xpathEnabled, varsEnabled, jsEnabled, xpathEvalEnabled, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled,
    jsBindEnabled, jsGetEnabled, jsUtilEnabled, jsonPathEnabled, initEnabled, urlOptionsEnabled, initJsEnabled, varBagEnabled, jsoupEnabled,
    bookFieldsEnabled, searchJsEnabled, searchVarsEnabled, itemVarsEnabled, listGetEnabled, bookVariableEnabled, jsLibEnabled, sourceBindEnabled,
    initJsoupEnabled,
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
          jsoupEnabled, bookFieldsEnabled, listGetEnabled, bookVariablePuts, sourceConsts, initJsoupEnabled, field: name,
        }));
      } catch {
        compiled.set(name, { skipped: 'unsupported' });
      }
    }
  }
  // varbag1028：变量袋对该源生效时换掉详情 put 字段与目录 get 字段（判据与语义位同一个 compileVarBag）。
  const bag = varBagEnabled ? compileVarBag(source.rules, {
    orEnabled, xpathEnabled, xpathEvalEnabled, jsEnabled, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled, jsBindEnabled,
    jsGetEnabled, jsUtilEnabled, jsonPathEnabled, initJsEnabled, jsoupEnabled, bookFieldsEnabled, listGetEnabled,
  }) : null;
  if (bag) for (const [name, ir] of bag) compiled.set(name, ir);
  // searchvars1028：搜索袋对该源生效时换掉读袋的搜索字段（判据与语义位同一个 compileSearchVars）。
  const searchBag = searchVarsEnabled ? compileSearchVars(source, {
    orEnabled, xpathEnabled, xpathEvalEnabled, jsEnabled, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled, jsBindEnabled,
    jsGetEnabled, jsUtilEnabled, jsonPathEnabled, initJsEnabled, jsoupEnabled, bookFieldsEnabled, listGetEnabled,
  }) : null;
  if (searchBag) for (const [name, ir] of searchBag) compiled.set(name, ir);
  // itemvars1028：条目袋对该源生效时换掉放/读袋的搜索、详情、目录字段（判据与语义位同一个 compileItemVars；与搜索袋同时生效时后覆盖）。
  const itemBag = itemVarsEnabled ? compileItemVars(source, {
    orEnabled, xpathEnabled, xpathEvalEnabled, jsEnabled, regexEnabled, andEnabled, aioEnabled, listJsEnabled, jsExtEnabled, jsBindEnabled,
    jsGetEnabled, jsUtilEnabled, jsonPathEnabled, initJsEnabled, jsoupEnabled, bookFieldsEnabled, listGetEnabled,
  }) : null;
  if (itemBag) for (const [name, ir] of itemBag) compiled.set(name, ir);
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
  // jslib1028：字段按原文与 vars 改写后的文本过 jsLibRuleProblem（袋/init 等后处理换上的字段一并过），不过即 skipped；
  // 带 JS（JS 段或 `{{}}`）的字段挂库原文，求值时沙箱先求值库（js-sandbox.ts JsBindings.jsLib）。
  if (jsLib) {
    for (const [name, ir] of compiled) {
      if ('skipped' in ir) continue;
      compiled.set(name, fieldWithJsLib(ir, [ruleTextOf(source.rules, name), ruleTextOf(sourceRules, name)], jsLib) ?? { skipped: 'unsupported' });
    }
  }
  cache.set(key, compiled);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return compiled;
}
