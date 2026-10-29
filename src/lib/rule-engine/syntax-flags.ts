// P1a 语法开关与引擎语义版本（task-syntax-p1a；rule-syntax-extension-design.md §7 P1a 行
// 与 §7「语义版本与失效」段）。独立放一个小模块：parse.ts 与 compile.ts 都要用，
// 而 compile.ts 已 import parse.ts——放 compile.ts 会成环。
//
// 开关只控制「顶层 || 组合规则可否编译」：
//   off（默认）= 旧 parser 行为逐字一致：|| 拒绝，诊断 { code:'unsupported_operator', operator:'||' }；
//   on         = tokenizer 切支 + OrNode 求值（空值短路，节点与标量不压扁）。
// 语义版本随之联动：off=1（P0 基线），on=2——compile 缓存键与准入 rules_hash 经
// engineVersionedKey 自动失效（P0 机制复用，不引入第二个口径）。

/** P0 观测引入的语义版本（structured diagnostics 时代的基线）。 */
export const ENGINE_SEMANTICS_VERSION = 1;

/** P1a || 组合语义版本：开关 on 时启用，缓存/准入 identity 按此版本失效。 */
export const ENGINE_SEMANTICS_VERSION_OR = 2;

/**
 * xpath1027：XPath 子集语义位。版本 = 1 + (|| ? 1 : 0) + (XPath ? 2 : 0)，即 1 基线 / 2 仅 || /
 * 3 仅 XPath / 4 两者——既有 1/2 行逐字不变，四种组合互不撞号。
 */
export const ENGINE_SEMANTICS_XPATH_BIT = 2;

/** vars1027：@put/@get 静态子集语义位。版本再 +4（5–8 = 含变量位的四种组合），1–4 逐字不变。 */
export const ENGINE_SEMANTICS_VARS_BIT = 4;

/** 语义版本随 || / XPath / 变量 / JS / XPath 求值 / 正则 / && / AllInOne / 搜索 JS / 列表 JS / JS 扩展 / 宿主绑定 / java.getString / 加解密帮手 / JSONPath 扩展 / 详情 init / 搜索选项 legado 口径 / URL 字段选项 / 搜索 webView / 详情 JS init / 详情→目录变量袋 / jsoup 直连 / 书籍成员 / 搜索 URL→搜索字段变量袋 / 搜索条目袋 / 列表 JS getter / 书籍变量 / jsLib / 书源常量 / jsoup JS init / 搜索联网 JS / 字段联网 JS / 搜索 java.connect / 搜索 java.get·post 开关联动（唯一口径，供 compile.ts 缓存键与 rulesHash 复用）。 */
export function engineSemanticsVersion(
  orEnabled: boolean, xpathEnabled = false, varsEnabled = false, jsEnabled = false, xpathEvalEnabled = false,
  regexEnabled = false, andEnabled = false, aioEnabled = false, searchJsEnabled = false, listJsEnabled = false,
  jsExtEnabled = false, jsBindEnabled = false, jsGetEnabled = false, jsUtilEnabled = false, jsonPathEnabled = false,
  initEnabled = false, searchOptionsEnabled = false, urlOptionsEnabled = false, searchWebViewEnabled = false, initJsEnabled = false,
  varBagEnabled = false, jsoupEnabled = false, bookFieldsEnabled = false, searchVarsEnabled = false, itemVarsEnabled = false,
  listGetEnabled = false, bookVariableEnabled = false, jsLibEnabled = false, sourceBindEnabled = false, initJsoupEnabled = false,
  searchNetJsEnabled = false, fieldNetJsEnabled = false, searchConnectJsEnabled = false, searchGetPostJsEnabled = false,
): number {
  return (orEnabled ? ENGINE_SEMANTICS_VERSION_OR : ENGINE_SEMANTICS_VERSION)
    + (xpathEnabled ? ENGINE_SEMANTICS_XPATH_BIT : 0) + (varsEnabled ? ENGINE_SEMANTICS_VARS_BIT : 0)
    + (jsEnabled ? ENGINE_SEMANTICS_JS_BIT : 0) + (xpathEvalEnabled ? ENGINE_SEMANTICS_XPATH_EVAL_BIT : 0)
    + (regexEnabled ? ENGINE_SEMANTICS_REGEX_BIT : 0) + (andEnabled ? ENGINE_SEMANTICS_AND_BIT : 0)
    + (aioEnabled ? ENGINE_SEMANTICS_AIO_BIT : 0) + (searchJsEnabled ? ENGINE_SEMANTICS_SEARCH_JS_BIT : 0)
    + (listJsEnabled ? ENGINE_SEMANTICS_LIST_JS_BIT : 0) + (jsExtEnabled ? ENGINE_SEMANTICS_JS_EXT_BIT : 0)
    + (jsBindEnabled ? ENGINE_SEMANTICS_JS_BIND_BIT : 0) + (jsGetEnabled ? ENGINE_SEMANTICS_JS_GET_BIT : 0)
    + (jsUtilEnabled ? ENGINE_SEMANTICS_JS_UTIL_BIT : 0) + (jsonPathEnabled ? ENGINE_SEMANTICS_JSON_PATH_BIT : 0)
    + (initEnabled ? ENGINE_SEMANTICS_INIT_BIT : 0) + (searchOptionsEnabled ? ENGINE_SEMANTICS_SEARCH_OPTIONS_BIT : 0)
    + (urlOptionsEnabled ? ENGINE_SEMANTICS_URL_OPTIONS_BIT : 0) + (searchWebViewEnabled ? ENGINE_SEMANTICS_SEARCH_WEBVIEW_BIT : 0)
    + (initJsEnabled ? ENGINE_SEMANTICS_INIT_JS_BIT : 0) + (varBagEnabled ? ENGINE_SEMANTICS_VAR_BAG_BIT : 0)
    + (jsoupEnabled ? ENGINE_SEMANTICS_JSOUP_BIT : 0) + (bookFieldsEnabled ? ENGINE_SEMANTICS_BOOK_FIELDS_BIT : 0)
    + (searchVarsEnabled ? ENGINE_SEMANTICS_SEARCH_VARS_BIT : 0) + (itemVarsEnabled ? ENGINE_SEMANTICS_ITEM_VARS_BIT : 0)
    + (listGetEnabled ? ENGINE_SEMANTICS_LIST_GET_BIT : 0) + (bookVariableEnabled ? ENGINE_SEMANTICS_BOOK_VARIABLE_BIT : 0)
    + (jsLibEnabled ? ENGINE_SEMANTICS_JS_LIB_BIT : 0) + (sourceBindEnabled ? ENGINE_SEMANTICS_SOURCE_BIND_BIT : 0)
    + (initJsoupEnabled ? ENGINE_SEMANTICS_INIT_JSOUP_BIT : 0) + (searchNetJsEnabled ? ENGINE_SEMANTICS_SEARCH_NET_JS_BIT : 0)
    + (fieldNetJsEnabled ? ENGINE_SEMANTICS_FIELD_NET_JS_BIT : 0) + (searchConnectJsEnabled ? ENGINE_SEMANTICS_SEARCH_CONNECT_JS_BIT : 0)
    + (searchGetPostJsEnabled ? ENGINE_SEMANTICS_SEARCH_GETPOST_JS_BIT : 0);
}

/**
 * ENGINE_SYNTAX_OR 独立开关（默认 off）。
 * 与 shuyuan.ts engineSourcesEnabled 同款严格口径：只有显式 `1`/`true`/`on` 才开；
 * 缺失/`0`/`false`/其他值一律关闭（回退效果 = 旧 parser）。
 * 参数化 env 便于单测注入，不改动真实 process.env。
 */
/** env 形状（宽松：process.env 与测试注入对象都可直接代入）。 */
interface OrEnv {
  ENGINE_SYNTAX_OR?: string | undefined;
  [key: string]: string | undefined;
}

export function engineSyntaxOrEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_OR?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * ENGINE_SYNTAX_XPATH 独立开关（xpath1027，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = 简单子集 XPath（逐级 / 与 //、属性等值/存在/contains 谓词、前置 [n] 下标、末尾 /text() 或 /@attr）
 * 编译期翻成 CSS 选择器；子集外的 XPath 照旧 unsupported_xpath。off = 旧 parser 逐字不变。
 */
export function engineSyntaxXPathEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_XPATH?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * ENGINE_SYNTAX_VARS 独立开关（vars1027，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = 编译前剥 @put、详情页内 init put → 同组整条 @get 内联（vars-subset.ts）；残留 @get 照旧拒。off = 逐字不变。
 */
export function engineSyntaxVarsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_VARS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * jsbox1027：规则 JS 段（`<js>…</js>` / `@js:`）沙箱执行语义位。版本再 +8（9–16），1–8 逐字不变。
 * 只对实际用到核心字段 JS 的源计入（compile.ts sourceUsesJsSyntax），其余源的 rules_hash 不因开关翻动。
 */
export const ENGINE_SEMANTICS_JS_BIT = 8;

/**
 * ENGINE_SYNTAX_JS 独立开关（jsbox1027，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = 阅读路径字段里通过编译期白名单的纯计算 JS 段在 QuickJS-wasm 沙箱执行（js-sandbox.ts）；off = 逐字不变。
 */
export function engineSyntaxJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * xpatheval1027：JsoupXpath 语义求值位。版本再 +16（17–32），1–16 逐字不变。
 * 只对实际有字段编译成 XPath 求值 IR 的源计入（compile.ts sourceUsesXPathEval），其余源 rules_hash 不翻动。
 */
export const ENGINE_SEMANTICS_XPATH_EVAL_BIT = 16;

/**
 * ENGINE_SYNTAX_XPATH_EVAL 独立开关（xpatheval1027，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on 且 ENGINE_SYNTAX_XPATH on 时，翻不成 CSS 的 legado XPath 段（`@XPath:` 前缀或 `/` 开头）交
 * xpath-eval.ts 按 JsoupXpath 语义求值；off = 逐字不变（子集外照旧 unsupported_xpath）。
 */
export function engineSyntaxXPathEvalEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_XPATH_EVAL?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * regex1027：legado `##` 正则语义位。版本再 +32（33–64），1–32 逐字不变。
 * 只对实际有字段编译出正则-only 规则或 replaceFirst 替换的源计入（compile.ts sourceUsesRegexSyntax）。
 */
export const ENGINE_SEMANTICS_REGEX_BIT = 32;

/**
 * ENGINE_SYNTAX_REGEX 独立开关（regex1027，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = 主体为空的正则-only 规则按 legado AnalyzeRule 对当前内容原文求值，`##` 切出 ≥4 段时 replaceFirst（只取首个匹配
 * 套替换，无匹配得空）；带选择器主体的 `##p##r###` 不变。off = 逐字不变（正则-only 拒 regex_only，第 3 段当 JS flags）。
 */
export function engineSyntaxRegexEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_REGEX?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * and1027：legado `&&` 合并语义位。版本再 +64（65–128），1–64 逐字不变。
 * 只对实际有字段编译结果因开关而变的源计入（compile.ts sourceUsesAndSyntax）。
 */
export const ENGINE_SEMANTICS_AND_BIT = 64;

/**
 * ENGINE_SYNTAX_AND 独立开关（and1027，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_OR 同开）。
 * on = 核心字段先剥 `##` 尾缀再切顶层 `&&`（尾缀里的 `&&` 不再误拒），各支结果按 legado 合并：字符串字段按行拼接、
 * URL 字段取首个非空、列表字段节点/条目按序拼接。off = 逐字不变（整串含顶层 && 即拒）。
 */
export function engineSyntaxAndEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_AND?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * aio1027：legado AllInOne 正则列表语义位。版本再 +128（129–256），1–128 逐字不变。
 * 只对 ruleSearch.bookList / ruleToc.chapterList 以 `:` 开头的源计入（compile.ts sourceUsesAioSyntax）。
 */
export const ENGINE_SEMANTICS_AIO_BIT = 128;

/**
 * ENGINE_SYNTAX_AIO 独立开关（aio1027，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = 列表规则 `:正则[&&正则…]`（legado splitSourceRule allInOne → AnalyzeByRegex.getElements）在 QuickJS 沙箱里跑正则，
 * 条目 = 捕获组列表；同组条目字段的 `$N` 引用捕获组（AnalyzeRule.splitRegex/makeUpRule）。off = 逐字不变（`:` 列表照旧拒）。
 */
export function engineSyntaxAioEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_AIO?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * searchjs1027：搜索模板 JS 语义位。版本再 +256（257–512），1–256 逐字不变。
 * 只对旧口径构造不出请求、且模板带 `@js:`/`<js>`/`{{表达式}}` 的源计入（source-parser searchTemplateNeedsJs）。
 */
export const ENGINE_SEMANTICS_SEARCH_JS_BIT = 256;

/**
 * ENGINE_SEARCH_JS 独立开关（searchjs1027，默认 off，口径同 ENGINE_SYNTAX_OR；只在 ENGINE_POST_SEARCH 开时生效）。
 * on = 旧口径构造不出的 searchUrl 按 legado AnalyzeUrl（analyzeJs → `{{js}}` → 页码 → 选项/编码）在 QuickJS 沙箱求值
 * （rule-engine/search-js.ts）；旧口径能构造的模板一律不走新路径。off = 逐字不变。
 */
export function engineSearchJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SEARCH_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * listjs1027：列表字段 JS 语义位。版本再 +512（513–1024），1–512 逐字不变。
 * 只对 ruleSearch.bookList / ruleToc.chapterList 含 JS 段、且 JS 链对该源生效（ENGINE_SYNTAX_JS on、无 jsLib）的源计入
 * （compile.ts sourceUsesListJsSyntax）。
 */
export const ENGINE_SEMANTICS_LIST_JS_BIT = 512;

/**
 * ENGINE_SYNTAX_LIST_JS 独立开关（listjs1027，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = 列表规则的 JS 段（legado AnalyzeRule.getElements 的 Js 模式）在 QuickJS 沙箱求值：JS 返回数组时逐项成为条目
 * （字符串项按页面重新解析，普通对象项按 legado NativeObject 键值直取），之后可再接一段规则重新解析 JS 产出的字符串。
 * off = 逐字不变（列表字段含 JS 照旧拒）。
 */
export function engineSyntaxListJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_LIST_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * jsext1028：JS 段扩展语义位。版本再 +1024（1025–2048），1–1024 逐字不变。
 * 只对 off 态因 eval / JS 段内 `##`、`{{}}` 被拒、on 态编译通过的字段所在源计入（compile.ts sourceUsesJsExtSyntax）。
 */
export const ENGINE_SEMANTICS_JS_EXT_BIT = 1024;

/**
 * ENGINE_SYNTAX_JS_EXT 独立开关（jsext1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = JS 段放行 `eval`（沙箱本身是安全边界），并按 legado SourceRule.makeUpRule 处理 JS 段内的 `{{规则}}`/`{{JS}}`
 * 与 `##正则##替换`：先求值占位拼回代码，再按 `##` 切出代码与替换。andor1029 起 JS 链的规则段另按所在字段收顶层 `&&`
 * （同 ENGINE_SYNTAX_AND 口径）并跳过 `||` 空支。off = 逐字不变（这些 JS 段照旧拒）。
 */
export function engineSyntaxJsExtEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JS_EXT?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * bind1028：宿主绑定与规则级 makeUp 语义位。版本再 +2048（2049–4096），1–2048 逐字不变。
 * 只对 off 态被拒、on 态编译通过的字段所在源计入（compile.ts sourceUsesJsBindSyntax）。
 */
export const ENGINE_SEMANTICS_JS_BIND_BIT = 2048;

/**
 * ENGINE_SYNTAX_JS_BIND 独立开关（bind1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = ① JS 里放行宿主只读绑定 `book.origin`（全部 JS 字段）与 `chapter.title`/`title`（chapterUrl 与正文两字段），
 * 值由门面按 legado 口径注入（书源地址、目录条目的章节名）；② 非 JS 规则里 legado 模板 `{{规则}}`/`{{JS}}` 按
 * SourceRule 的 Regex 模式（首个 `{{` 前没有 `##`）拼值、或作为 `##` 之后的动态正则/替换求值。off = 逐字不变。
 */
export function engineSyntaxJsBindEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JS_BIND?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * jsget1028：`java.getString`/`java.getStringList` 语义位。版本再 +4096（4097–8192），1–4096 逐字不变。
 * 只对 off 态被拒、on 态编译通过的字段所在源计入（compile.ts sourceUsesJsGetSyntax）。
 */
export const ENGINE_SEMANTICS_JS_GET_BIT = 4096;

/**
 * ENGINE_SYNTAX_JS_GET 独立开关（jsget1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = 字符串字段的 JS 链里放行 `java.getString("规则")`/`java.getStringList("规则")`（单个字符串字面量实参）：规则编译期
 * 按普通规则（不含 JS）编译进白名单，求值期在字段作用域（legado AnalyzeRule 的 content：整页或列表条目）上取值；
 * 实参不在白名单里的调用求值失败。off = 逐字不变。
 */
export function engineSyntaxJsGetEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JS_GET?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * jsutil1028：对称加解密 / toNumChapter 帮手语义位。版本再 +8192（8193–16384），1–8192 逐字不变。
 * 只对 off 态被拒、on 态编译通过的字段所在源计入（compile.ts sourceUsesJsUtilSyntax）；gbkjs1029 另计需 JS 的搜索模板里
 * 有 GBK 系 encodeURI 的源（source-parser.ts searchTemplateUsesCjkEncodeUri，须搜索 JS 同生效）；longjs1029 另计超 8192、
 * 64K 内的需 JS 搜索模板。
 */
export const ENGINE_SEMANTICS_JS_UTIL_BIT = 8192;

/**
 * ENGINE_SYNTAX_JS_UTIL 独立开关（jsutil1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = 字符串字段的 JS 链里放行 `java.createSymmetricCrypto(...)` 的 decryptStr/encryptBase64/encryptHex、几个等价的弃用
 * aes/des/3DES 包装与 `java.toNumChapter`，按 legado（hutool SymmetricCrypto、StringUtils.stringToInt）口径在宿主实现；
 * 口径不定的输入（非字符串实参、非 UTF-8 明文、奇数长 hex、CBC 缺 IV…）一律求值失败。t2s1029 另收 `java.t2s`（quick-transfer
 * 0.2.17 词典 + legado fixT2sDict 排除词，t2s.ts），结果在 Rhino 里是 Java String，只收完成值、字符串拼接与 String() 实参。
 * gbkjs1029：搜索模板 JS（搜索 JS 同开时）的 `java.encodeURI(文本, 'gbk'|'gb2312'|'gb18030')` 按 java.net.URLEncoder 口径编
 * GBK 系字节（source-charset.ts javaUrlEncodeCjk：ASCII 与 CJK 基本区汉字，其余字符致命失败、不回退 UTF-8）；规则字段不变。
 * longjs1029：需 JS 的搜索模板长度上限 8192 → 64K（search-js.ts searchJsTemplateLimit，收自带签名实现的模板）。
 * off = 逐字不变。
 */
export function engineSyntaxJsUtilEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JS_UTIL?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * jsonpath1028：JSONPath 扩展子集语义位。版本再 +16384（16385–32768），1–16384 逐字不变。
 * 只对 off 态被拒、on 态编译通过的字段所在源计入（compile.ts sourceUsesJsonPathSyntax）。
 */
export const ENGINE_SEMANTICS_JSON_PATH_BIT = 16384;

/**
 * ENGINE_SYNTAX_JSON_PATH 独立开关（jsonpath1028，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = off 态解析不了的 `$` 路径再试 Jayway 的 `.[`（单点后接方括号）与 `[?(表达式)]`（`@.a.b` 存在性 / 与字面量比较 /
 * && || ! 括号），按 Jayway 2.9.0 + legado SUPPRESS_EXCEPTIONS 口径求值；正则、`$` 路径、词运算符、转义等一律仍拒。
 * andor1029 起 `&&` 合并的首支带 `@json:` 前缀同样算 Json 模式。
 * off 态能解析的路径 IR 逐字不变。
 */
export function engineSyntaxJsonPathEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JSON_PATH?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * init1028：详情页 `ruleBookInfo.init` 语义位。版本再 +32768（32769–65536），1–32768 逐字不变。
 * 只对 init 形态可复现（parse.ts initRuleSupported）的源计入（compile.ts sourceUsesInitSyntax）。
 */
export const ENGINE_SEMANTICS_INIT_BIT = 32768;

/**
 * ENGINE_SYNTAX_INIT 独立开关（init1028，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = 详情页字段（name/author/tocUrl）按 legado BookInfo `setContent(getElement(init))` 先把内容换成 init 的结果再求值：
 * HTML 上默认语法/CSS 取节点集（Elements.toString 重新解析），JSON 上 JSONPath（含默认语法补 `$.`）取 Jayway getObject 的值；
 * 只收 parse.ts initRuleSupported 的形态，其余 init 照旧不生效。off = 逐字不变（init 一律不生效）。
 */
export function engineSyntaxInitEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_INIT?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * searchopt1028：搜索选项 legado 口径语义位。版本再 +65536（65537–131072），1–65536 逐字不变。
 * 只对旧口径因选项被拒、且新口径会接手的模板计入（source-parser searchOptionsNeedParity）。
 */
export const ENGINE_SEMANTICS_SEARCH_OPTIONS_BIT = 65536;

/**
 * ENGINE_SEARCH_OPTIONS 独立开关（searchopt1028，默认 off，口径同 ENGINE_SYNTAX_OR；只在 ENGINE_POST_SEARCH 开时生效）。
 * on = 旧口径因 `url,{选项}` 被拒的模板改按 legado AnalyzeUrl.UrlOption 口径重读选项：GSON 宽松 JSON（读不出则整段忽略、
 * 按 GET 请求 url 部分）、未知键忽略、空 charset 视同未声明、headers 可为 JSON 串、对象 body 按 GSON pretty 序列化；
 * webView/js/type/serverID 等仍拒。旧口径能构造的模板一律不走新口径。off = 逐字不变。
 */
export function engineSearchOptionsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SEARCH_OPTIONS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * urlopt1028：URL 字段选项后缀语义位。版本再 +131072（131073–262144），1–131072 逐字不变。
 * 只对 URL 字段原文像会产出 `,{选项}` 的源计入（url-options.ts urlOptionFields）。
 */
export const ENGINE_SEMANTICS_URL_OPTIONS_BIT = 131072;

/**
 * ENGINE_URL_OPTIONS 独立开关（urlopt1028，默认 off，口径同 ENGINE_SYNTAX_OR）。
 * on = 搜索 bookUrl、详情 tocUrl、目录 chapterUrl/nextTocUrl、正文 nextContentUrl 的值带 legado `url,{选项}` 后缀时，
 * 去掉后取页语义不变的选项（webView 当普通请求、未知键与 GET 的 body 忽略）先剥掉再过 host 门；POST/headers/非 utf-8
 * charset/js 等仍用原值。off = 逐字不变（带选项的值单引号/空白形态被 host 门丢弃，双引号形态被编码进路径）。
 */
export function engineUrlOptionsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_URL_OPTIONS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * searchwv1028：搜索选项 webView 语义位。版本再 +262144（262145–524288），1–262144 逐字不变。
 * 只对搜索选项 legado 口径生效、选项被旧口径拒、且 searchUrl 原文含 webView 键的源计入（compile.ts engineSourceRevision）。
 */
export const ENGINE_SEMANTICS_SEARCH_WEBVIEW_BIT = 262144;

/**
 * ENGINE_SEARCH_WEBVIEW 独立开关（searchwv1028，默认 off，口径同 ENGINE_SYNTAX_OR；只在搜索选项 legado 口径生效时起作用，
 * 即 ENGINE_POST_SEARCH 与 ENGINE_SEARCH_OPTIONS 同开）。on = legado UrlOption 的 webView 为真时按普通请求取搜索页
 * （同 method/body/headers/charset；legado 会在 WebView 里渲染后取 HTML，页面不靠 JS 出结果时两者同，靠 JS 时解析不出结果、
 * 由准入搜索探测判失败）；webView 配非空 webJs 仍拒。off = 逐字不变（webView 为真整条模板拒）。
 */
export function engineSearchWebViewEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SEARCH_WEBVIEW?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * initjs1028：详情页 JS init 语义位。版本再 +524288（524289–1048576），1–524288 逐字不变。
 * 只对 init 是整条 JS 且编译可复现的源计入（compile.ts sourceUsesInitJsSyntax）。
 */
export const ENGINE_SEMANTICS_INIT_JS_BIT = 524288;

/**
 * ENGINE_SYNTAX_INIT_JS 独立开关（initjs1028，默认 off，口径同 ENGINE_SYNTAX_OR；只在 ENGINE_SYNTAX_INIT 与 JS 链同开、
 * 源无 jsLib 时起作用）。on = `ruleBookInfo.init` 是整条 JS 时按 legado BookInfo `setContent(getElement(init))` 在沙箱里求值
 * （result = 详情页原文）：返回字符串即换成新页面，返回普通对象即详情字段按 legado getString 的 NativeObject 分支键值直取；
 * init 里 `X = (x) => java.getString(x)` 这类别名在 ENGINE_SYNTAX_JS_GET 开、且别名只以字面量实参调用时收进 getter 白名单。
 * 其余形态的 JS init 照旧整源拒。off = 逐字不变。
 */
export function engineSyntaxInitJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_INIT_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** initjs1028 实际生效（与 INIT 同开；JS 链与 jsLib 的判据由调用方另加）。 */
export function engineInitJsActive(env: OrEnv = process.env): boolean {
  return engineSyntaxInitEnabled(env) && engineSyntaxInitJsEnabled(env);
}

/**
 * varbag1028：详情页 put → 目录页 get 变量袋语义位。版本再 +2097152（1048576 留给 sget 记录分支），1–1048576 逐字不变。
 * 只对 vars-subset.ts varBagPlan 判出、且编译时真用上变量袋的源计入（compile.ts sourceUsesVarBagSyntax）。
 */
export const ENGINE_SEMANTICS_VAR_BAG_BIT = 2097152;

/**
 * ENGINE_SYNTAX_VARS_BAG 独立开关（varbag1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_VARS 同开才生效）。
 * on = legado 跨阶段变量的一个窄子集：详情页 name/author/tocUrl 里 `@put:{…}` 与 JS 里 `java.put('键', 值)`（键为字面量）
 * 按 legado BookInfo 求值顺序存进本书的变量袋，目录页非列表字段（chapterName/chapterUrl/nextTocUrl…）里整条 makeUp 形态的
 * `@get:{键}` 与 JS 里 `java.get('键')` 从袋里读；袋随门面 engineFetchDetail → engineFetchToc 显式传递，没带袋的目录求值失败。
 * 其余位置的 put/get 照旧拒。off = 逐字不变。
 */
export function engineSyntaxVarsBagEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_VARS_BAG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * jsoup1028：JS 段里直连 jsoup DOM 语义位。版本再 +4194304（1–2097152 逐字不变）。
 * 只对 off 态被拒、on 态编译通过的字段所在源计入（compile.ts sourceUsesJsoupSyntax）。
 */
export const ENGINE_SEMANTICS_JSOUP_BIT = 4194304;

/**
 * ENGINE_SYNTAX_JSOUP 独立开关（jsoup1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = 字符串/列表字段的 JS 链里放行 jsoup DOM 直连：`java.getElement(s)` 取 Elements、`org.jsoup.Jsoup.parse` 建文档，
 * Element/Elements 的 text/ownText/outerHtml/html/attr/select/selectFirst/size/get/toArray… 与条目级 `result`
 * 是 Element 的用法（jsoup-shim.ts 按 jsoup 1.16.2 语义实现）。选择器只收 QueryParser 的常规子集，
 * 正则类伪类、绝对 URL 属性、svg/math/template 序列化等口径不定的形态一律求值失败。off = 逐字不变。
 */
export function engineSyntaxJsoupEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JSOUP?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * book1028：JS 读 `book` 的书籍成员语义位。版本再 +8388608（1–4194304 逐字不变）。
 * 只对 off 态被拒、on 态编译通过（字段读到了 book 的书籍成员）的源计入（compile.ts sourceUsesBookSyntax）。
 */
export const ENGINE_SEMANTICS_BOOK_FIELDS_BIT = 8388608;

/**
 * ENGINE_SYNTAX_BOOK_FIELDS 独立开关（book1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JS_BIND
 * 同开才生效）。on = legado evalJS 的 `book`（搜索条目 SearchBook / 书籍 Book）除 origin 外再放行按阶段已求出的成员：
 * 搜索条目字段读本条已求的 name/author（legado getSearchItem 求值顺序），详情字段读 name/author/bookUrl，目录字段（含列表 JS）
 * 另读 tocUrl。值由门面按 legado 口径算好显式传递（engineSearchBook → engineFetchDetail → engineFetchToc），没带或为空即
 * 求值失败。Rhino 里这些成员是 Java String 包装，只收与 JS 字符串同结果的用法（拼接/传参/`==`），后接 `.`/`[`/`(`、`typeof`、
 * 与 `===`/`!==` 相邻一律拒；kind 等其余成员、`ruleBookInfo.canReName` 非空的源照旧拒。正文两字段自 bookcontent1029 起同目录
 * 口径（门面 engineFetchContent 收目录带出的 book，阅读器把它随目录会话存下）。off = 逐字不变。
 */
export function engineSyntaxBookFieldsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_BOOK_FIELDS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * searchvars1028：搜索 URL put → 搜索字段 get 变量袋语义位。版本再 +16777216（1–8388608 逐字不变）。
 * 只对搜索袋真生效（compile.ts compileSearchVars 非 null）的源计入。
 */
export const ENGINE_SEMANTICS_SEARCH_VARS_BIT = 16777216;

/**
 * ENGINE_SYNTAX_SEARCH_VARS 独立开关（searchvars1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_VARS 与搜索 JS
 * （ENGINE_POST_SEARCH + ENGINE_SEARCH_JS）同开才生效）。on = legado 搜索：searchUrl JS 里 `java.put('k', v)` 写进本次搜索的
 * RuleData，书籍列表（AnalyzeRule 同一份 RuleData）与条目字段（SearchBook 以它的变量为初值）的 `java.get('k')` / `@get:{k}`
 * 读回。只收字面量键、键都被 searchUrl put 过、ruleSearch 字段自身不 put（条目 put 写进各条 SearchBook，另一套语义）；
 * 只换 bookList/name/author/bookUrl。袋来自同一次搜索请求的 JS 求值（search-js.ts buildSearchRequestWithVars），
 * 旧口径构造得出的模板不跑 JS、不开。off = 逐字不变。
 */
export function engineSyntaxSearchVarsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_SEARCH_VARS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * itemvars1028：搜索条目袋语义位。版本再 +33554432（1–16777216 逐字不变）。
 * 只对条目袋真生效（compile.ts compileItemVars 非 null）的源计入。
 */
export const ENGINE_SEMANTICS_ITEM_VARS_BIT = 33554432;

/**
 * ENGINE_SYNTAX_ITEM_VARS 独立开关（itemvars1028，默认 off，口径同 ENGINE_SYNTAX_OR；须搜索袋（ENGINE_SYNTAX_SEARCH_VARS 及其
 * 前提）同生效）。on = legado 搜索条目袋：每条 SearchBook 以本次搜索 RuleData 的变量为初值，条目字段 `@put` / `java.put('k', v)`
 * 写进本条的袋，后面的条目字段、同一本书的详情字段（name/author/tocUrl）与目录字段（chapterName/chapterUrl/nextTocUrl）读回
 * （SearchBook.toBook 复制变量，详情/目录 setRuleData(book)）。只收字面量键、键放置位置唯一、读的键在求值顺序上已放过；
 * 书籍列表、目录列表、正文字段的 put/get 照旧拒。袋由门面按 legado 顺序算好显式传递（engineSearchBook → engineFetchDetail
 * → engineFetchToc），读条目袋的详情/目录没带袋即求值失败。off = 逐字不变。
 */
export function engineSyntaxItemVarsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_ITEM_VARS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * listget1028：列表 JS getter 语义位。版本再 +67108864（1–33554432 逐字不变）。
 * 只对有列表字段 off 态被拒、on 态编译通过（compile.ts sourceUsesListGetSyntax）的源计入。
 */
export const ENGINE_SEMANTICS_LIST_GET_BIT = 67108864;

/**
 * ENGINE_SYNTAX_LIST_GET 独立开关（listget1028，默认 off，口径同 ENGINE_SYNTAX_OR；须列表 JS 与 ENGINE_SYNTAX_JS_GET 同生效）。
 * on = 列表字段（bookList/chapterList）的 JS 段也收字面量实参的 `java.getString`/`java.getStringList`（legado getElements 时
 * `java` 即 AnalyzeRule，content 是整页）：实参规则编进 FieldIr.jsGets，求值期在页面作用域上取值，口径同字段 JS 的 getter。
 * off = 逐字不变。
 */
export function engineSyntaxListGetEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_LIST_GET?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * bookvar1028：书籍变量语义位。版本再 +134217728（1–67108864 逐字不变）。
 * 只对有字段 off 态被拒、on 态编译通过（compile.ts sourceUsesBookVariableSyntax）的源计入。
 */
export const ENGINE_SEMANTICS_BOOK_VARIABLE_BIT = 134217728;

/**
 * ENGINE_SYNTAX_BOOK_VARIABLE 独立开关（bookvar1028，默认 off，口径同 ENGINE_SYNTAX_OR；须书籍成员与 jsoup 直连同生效）。
 * on = jsoup + 书籍成员重试帧里放行字面量键的 `book.getVariable("键")`，得 Java 空串（legado BaseBook.getVariable 落空口径）——
 * 只在源内没有任何会往书籍变量里放该键的写法时（compile.ts sourceBookVariablePuts：java.put / @put / putVariable 等，键不是字面量
 * 即整源不放行）。off = 逐字不变。
 */
export function engineSyntaxBookVariableEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_BOOK_VARIABLE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * jslib1028：jsLib（公共函数库）语义位。版本再 +268435456（1–134217728 逐字不变）。
 * 只对带可复现 jsLib（js-lib.ts analyzeJsLib 非 null）且有 JS 段字段的源计入（compile.ts engineSourceRevision）。
 */
export const ENGINE_SEMANTICS_JS_LIB_BIT = 268435456;

/**
 * ENGINE_SYNTAX_JS_LIB 独立开关（jslib1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = 带 jsLib 的源不再整源关 JS 链：库能静态判定可复现时（js-lib.ts analyzeJsLib），JS 段字段在沙箱里先求值库原文再跑规则，
 * 引用库名字的字段另须库 pure（jsLibRuleProblem）。off = 逐字不变。
 */
export function engineSyntaxJsLibEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_JS_LIB?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * srcbind1028：书源常量语义位。版本再 +536870912（1–268435456 逐字不变）。
 * 只对有字段 off 态被拒、代入书源常量后编译通过的源计入（compile.ts engineSourceRevision / sourceUsesSourceBindSyntax）。
 */
export const ENGINE_SEMANTICS_SOURCE_BIND_BIT = 536870912;

/**
 * ENGINE_SYNTAX_SOURCE_BIND 独立开关（srcbind1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 同开才生效）。
 * on = JS 里的 `source.key`/`source.getKey()`/`source.bookSourceUrl`（legado BookSource，值 = 书源原文地址）与
 * `eval(String(source.bookSourceComment))` 在编译期代入书源常量（parse.ts bindSourceConsts），只收与 Rhino 同结果的用法。off = 逐字不变。
 */
export function engineSyntaxSourceBindEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_SOURCE_BIND?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * initjsoup1028：jsoup JS init 语义位。版本再 +1073741824（1–536870912 逐字不变）。
 * 只对 init 不经 jsoup 重编被拒、经 jsoup 重编是可复现 JS init 的源计入（compile.ts engineSourceRevision / sourceUsesInitJsoupSyntax）。
 * 注意：这是 int4（≤ 2147483647）能放下的最后一位。semver1029 起 source_admission.engine_semantics_version
 * 为 bigint（迁移 0009），再加位（2147483648 起）上限是 Number.MAX_SAFE_INTEGER，且上线前生产库须已跑 0009。
 */
export const ENGINE_SEMANTICS_INIT_JSOUP_BIT = 1073741824;

/**
 * netjs1029：搜索模板联网 JS 语义位。版本再 +2147483648（超出 int4，生产库须已跑迁移 0009；1–2147483647 逐字不变）。
 * 只对搜索联网 JS 生效（engineSearchNetJsEnabled 与搜索 JS、ENGINE_SYNTAX_JS、ENGINE_SYNTAX_JSOUP 同开）、searchUrl 需 JS 且
 * 带 `java.ajax(` 的源计入（compile.ts engineSourceRevision / source-parser.ts searchTemplateUsesAjax）。
 */
export const ENGINE_SEMANTICS_SEARCH_NET_JS_BIT = 2147483648;

/**
 * ENGINE_SYNTAX_INIT_JSOUP 独立开关（initjsoup1028，默认 off，口径同 ENGINE_SYNTAX_OR；须 JS init（ENGINE_SYNTAX_INIT 与
 * ENGINE_SYNTAX_INIT_JS）与 ENGINE_SYNTAX_JSOUP 同开才生效）。on = `ruleBookInfo.init` 的 JS 按 off 态口径被拒时再按 jsoup 口径重编
 * （`org.jsoup.Jsoup.parse` / `java.getElement(s)`，parse.ts jsoupRetryAllowed），求值走 jsoup 包装（js-sandbox.ts runJsoupInit：
 * 字符串与普通对象照收，返回 Element/Elements 失败）。off = 逐字不变。
 */
export function engineSyntaxInitJsoupEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SYNTAX_INIT_JSOUP?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * ENGINE_SEARCH_NET_JS 独立开关（netjs1029，默认 off，口径同 ENGINE_SYNTAX_OR；须搜索 JS（ENGINE_POST_SEARCH 与 ENGINE_SEARCH_JS）、
 * ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JSOUP 同开才生效，见 search-js.ts searchNetJsEnabled）。on = 需 JS 且带 `java.ajax(` 的 searchUrl
 * 在 jsoup 包装的沙箱里求值，`java.ajax(url)` 缺页即中止求值、由宿主取页（运行时 context.page，准入 admissionFetch）后整次重放，
 * 返回 Java 字符串（legado AnalyzeUrl.getStrResponse().body）。off = 逐字不变（java.ajax 不存在、求值失败判不支持）。
 */
export function engineSearchNetJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SEARCH_NET_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * fieldnet1029：规则字段联网 JS 语义位。版本再 +4294967296（1–4294967295 逐字不变，bigint 列）。只对有字段经 jsoup 重编、
 * 且重编帧里用到 `java.ajax` 才编得过（FieldIr.jsAjax）的源计入（compile.ts engineSourceRevision / sourceUsesFieldNetSyntax）。
 */
export const ENGINE_SEMANTICS_FIELD_NET_JS_BIT = 4294967296;

/**
 * ENGINE_FIELD_NET_JS 独立开关（fieldnet1029，默认 off，口径同 ENGINE_SYNTAX_OR；须 ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JSOUP 同开才生效）。
 * on = 规则字段的 JS 按 jsoup 口径重编时放行 `java.ajax(url)`（parse.ts jsoupFrame.net），求值时缺页即中止、由宿主取页（门面
 * context.page，准入 admissionFetch）后整段重放，返回 Java 字符串（legado JsExtensions.ajax）。off = 逐字不变（java.ajax 照旧拒）。
 */
export function engineFieldNetJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_FIELD_NET_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * connectnet1029：搜索模板 java.connect 语义位。版本再 +8589934592（1–8589934591 逐字不变，bigint 列）。只对搜索联网 JS 生效、
 * ENGINE_SEARCH_CONNECT_JS on、searchUrl 需 JS 且带 `java.connect(` 的源计入（compile.ts engineSourceRevision /
 * source-parser.ts searchTemplateUsesConnect）。
 */
export const ENGINE_SEMANTICS_SEARCH_CONNECT_JS_BIT = 8589934592;

/**
 * ENGINE_SEARCH_CONNECT_JS 独立开关（connectnet1029，默认 off，口径同 ENGINE_SYNTAX_OR；须搜索联网 JS 同生效，见 search-js.ts
 * searchConnectJsEnabled）。on = 需 JS 且带 `java.connect(` 的 searchUrl 走联网帧，`java.connect(url)`（单参）缺页即中止求值、由宿主
 * 取页（跟随跳转）后整次重放，返回 legado StrResponse 的子集（raw().request().url() 最终地址、url()、body()）。
 * off = 逐字不变（java.connect 不存在、求值失败判不支持）。
 */
export function engineSearchConnectJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SEARCH_CONNECT_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * getpost1029：搜索模板 java.get(url, headers) / java.post(url, body, headers) 语义位。版本再 +17179869184（1–17179869183 逐字不变，
 * bigint 列）。只对搜索联网 JS 生效、ENGINE_SEARCH_GETPOST_JS on、searchUrl 需 JS 且带 HTTP 形态 java.get/java.post 的源计入
 * （compile.ts engineSourceRevision / source-parser.ts searchTemplateUsesGetPost）。
 */
export const ENGINE_SEMANTICS_SEARCH_GETPOST_JS_BIT = 17179869184;

/**
 * ENGINE_SEARCH_GETPOST_JS 独立开关（getpost1029，默认 off，口径同 ENGINE_SYNTAX_OR；须搜索联网 JS 同生效，见 search-js.ts
 * searchGetPostJsEnabled）。on = 需 JS 且带 HTTP 形态 java.get/java.post 的 searchUrl 走联网帧：legado JsExtensions.get/post 是
 * Jsoup 不跟随跳转的请求，缺页即中止求值、由宿主取页（不跟随跳转，带回状态码与响应头）后整次重放，返回 jsoup Connection.Response
 * 的子集（header(name)/headers(name)/statusCode()/body()）。单参 java.get 照旧是变量袋读取。off = 逐字不变。
 */
export function engineSearchGetPostJsEnabled(env: OrEnv = process.env): boolean {
  const raw = env.ENGINE_SEARCH_GETPOST_JS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}
