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

/** 语义版本随 || / XPath / 变量 / JS / XPath 求值 / 正则 / && / AllInOne / 搜索 JS / 列表 JS / JS 扩展 / 宿主绑定 / java.getString 开关联动（唯一口径，供 compile.ts 缓存键与 rulesHash 复用）。 */
export function engineSemanticsVersion(
  orEnabled: boolean, xpathEnabled = false, varsEnabled = false, jsEnabled = false, xpathEvalEnabled = false,
  regexEnabled = false, andEnabled = false, aioEnabled = false, searchJsEnabled = false, listJsEnabled = false,
  jsExtEnabled = false, jsBindEnabled = false, jsGetEnabled = false,
): number {
  return (orEnabled ? ENGINE_SEMANTICS_VERSION_OR : ENGINE_SEMANTICS_VERSION)
    + (xpathEnabled ? ENGINE_SEMANTICS_XPATH_BIT : 0) + (varsEnabled ? ENGINE_SEMANTICS_VARS_BIT : 0)
    + (jsEnabled ? ENGINE_SEMANTICS_JS_BIT : 0) + (xpathEvalEnabled ? ENGINE_SEMANTICS_XPATH_EVAL_BIT : 0)
    + (regexEnabled ? ENGINE_SEMANTICS_REGEX_BIT : 0) + (andEnabled ? ENGINE_SEMANTICS_AND_BIT : 0)
    + (aioEnabled ? ENGINE_SEMANTICS_AIO_BIT : 0) + (searchJsEnabled ? ENGINE_SEMANTICS_SEARCH_JS_BIT : 0)
    + (listJsEnabled ? ENGINE_SEMANTICS_LIST_JS_BIT : 0) + (jsExtEnabled ? ENGINE_SEMANTICS_JS_EXT_BIT : 0)
    + (jsBindEnabled ? ENGINE_SEMANTICS_JS_BIND_BIT : 0) + (jsGetEnabled ? ENGINE_SEMANTICS_JS_GET_BIT : 0);
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
 * 与 `##正则##替换`：先求值占位拼回代码，再按 `##` 切出代码与替换。off = 逐字不变（这些 JS 段照旧拒）。
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
