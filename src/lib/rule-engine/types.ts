// M1 规则引擎 IR 类型定义。字段语义全部对齐 legado 默认语法。
// 设计依据：m1-engine-design.md v3 §2.2。任务 1 只交付 types/parse/jsonpath——
// evaluate/dom-ops/compile/admission 属后续任务，本文件只声明解析层需要的类型。
import type { XPathProgram } from './xpath-eval';

/** 引擎支持档位。M1 = 默认语法 + 显式 CSS + JSONPath + ##正则##。 */
export type Tier = 'M1' | 'T7';

/** 引擎错误码。编译期不支持构件 → RULE_UNSUPPORTED；求值期异常 → RULE_EVAL_FAILED。 */
export type RuleEngineErrorCode = 'RULE_UNSUPPORTED' | 'RULE_EVAL_FAILED';

/** 编译拒绝的稳定观测维度；message 只供人读，统计必须使用这里的 code。 */
export type RuleDiagnostic = {
  code: string;
  /** 组合运算符共用一个 code，以 operator 保留细分桶。 */
  operator?: '||' | '&&' | '%%';
};

export class RuleEngineError extends Error {
  readonly code: RuleEngineErrorCode;
  /** 触发错误的规则片段（诊断用，脱敏无害）。 */
  readonly rule?: string;
  readonly diagnostic?: RuleDiagnostic;

  constructor(code: RuleEngineErrorCode, message: string, rule?: string, diagnostic?: RuleDiagnostic) {
    super(message);
    this.name = 'RuleEngineError';
    this.code = code;
    this.rule = rule;
    this.diagnostic = diagnostic;
  }
}

/** 一段选择器 + 后缀索引/切片/排除。默认语法逐段编译；@css: 整体走 css-select。 */
export interface CssStep {
  /** 合法 css-select 表达式（tag./class./id./text. 已翻译，见 §2.3）。 */
  selector: string;
  /** .0 → 0；负数=从尾数（legado 语义）。 */
  index?: number;
  /** .0:2 → [0, 2]。 */
  slice?: [number, number];
  /** !0、!-1、!0:1:2 → 排除下标列表。 */
  excludes?: number[];
  /**
   * text.关键字 翻译成 :contains() 后，求值层需用该关键字对命中做 ownText 复核，
   * 剔除「文本在子孙而非自身」的假命中（legado text. 语义，§3.2）。
   */
  ownTextContains?: string;
  /**
   * bracket1029：legado `[…]` 索引集（ElementsSingle.findIndexSet，ENGINE_SYNTAX_BRACKET_INDEX on 才产出）。`exclude` = `[!…]`；
   * 项按书写顺序，单个下标或 `[start, end, step]` 闭区间（端点 null = 省略）。
   */
  indexSet?: { exclude: boolean; items: CssIndexItem[] };
  /** selfmatch1029：子孙一个不中时改取上下文自身匹配的节点（legado Jsoup 选择含自身，ENGINE_SYNTAX_SELF_MATCH on 才产出）。 */
  selfFallback?: true;
}

/** bracket1029：索引集的一项。 */
export type CssIndexItem = number | [number | null, number | null, number];

/**
 * 末端操作符。对齐 legado AnalyzeByDefault：
 * @text/@textNodes/@ownText/@html/@all/@href/@src/@content/@value/@title/@alt/@data/@srcset。
 */
export type TerminalOp =
  | {
      op:
        | 'text'
        | 'textNodes'
        | 'ownText'
        | 'html'
        | 'all'
        | 'content'
        | 'href'
        | 'src'
        | 'title'
        | 'alt'
        | 'data'
        | 'srcset'
        | 'value';
    }
  | { op: 'attr'; name: string }; // @property 之外的具名属性兜底

/** JSONPath 子集 IR（jsonpath.ts 自写求值器消费）。 */
export type JsonPathSegment =
  | { kind: 'root' } //                       $
  | { kind: 'child'; name: string } //        .name / ['name']
  | { kind: 'recursive'; name: string } //    ..name
  | { kind: 'wildcard' } //                   [*] / .*
  | { kind: 'index'; index: number } //       [n]（负数从尾）
  | { kind: 'indexList'; indexes: number[] } // [n,m]
  | { kind: 'slice'; start?: number; end?: number } // [a:b]
  | { kind: 'filterEq'; name: string; value: string | number | boolean } // [?(@.x==y)]
  // ..[n] / ..[n,m] / ..[a:b]（Jayway ScanPathToken + 数组 token）：elements=false 时产出每个数组本身
  // （后接下标段），elements=true 时产出每个数组的全部元素（数组 token 不是末段，Jayway 略过下标）。
  | { kind: 'arrayScan'; elements: boolean }
  // [?(表达式)]（jsonpath1028，ENGINE_SYNTAX_JSON_PATH 下 off 态解析不了的路径才产出）：Jayway PredicatePathToken——
  // 对象节点判它自身、数组节点逐元素判，标量节点不产出
  | { kind: 'filter'; expr: JsonPathFilterExpr };

/** jsonpath1028 过滤器字面量（Jayway FilterCompiler.readLiteral 子集）。number 另带 BigDecimal.toString 口径的 canonical。 */
export type JsonPathFilterLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; canonical: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

/** jsonpath1028 过滤器表达式：`@.a.b` 存在性、`@.a.b <op> 字面量`、`&&`/`||`/`!`/括号。 */
export type JsonPathFilterExpr =
  | { kind: 'exists'; path: string[]; negate: boolean }
  | { kind: 'cmp'; path: string[]; op: '==' | '!=' | '<' | '<=' | '>' | '>='; value: JsonPathFilterLiteral }
  | { kind: 'and'; items: JsonPathFilterExpr[] }
  | { kind: 'or'; items: JsonPathFilterExpr[] }
  | { kind: 'not'; item: JsonPathFilterExpr };

export interface JsonPathIr {
  segments: JsonPathSegment[];
}

/** 一条规则编译后的中间表示。 */
export type RuleIr =
  // 默认语法与 @css:/css: 统一到 CSS 选择器链
  | { kind: 'css'; chain: CssStep[]; terminal?: TerminalOp }
  // $.x / $..x / [*] / [n] / [a:b] / [?(==)]
  | { kind: 'jsonpath'; path: JsonPathIr }
  // 含 {{$.x}} jsonpath 占位的字面模板（tpl_jsonpath，如 bookUrl 拼接 URL）；
  // 设计 §2.2 的三 kind 草图未含 tpl_jsonpath，但 §2.1 明确 M1 支持——补此 kind。
  | { kind: 'template'; parts: TemplatePart[] }
  // 纯文本规则（如 tocUrl 的绝对 URL）
  | { kind: 'text'; literal: string }
  // || 组合节点（P1a，ENGINE_SYNTAX_OR 开启时产出；设计 §3.7/§5.1 与 §7 P1a 行）：
  // 空值短路——逐支求值到首个非空（文本非空白 / 节点集非空）；每支各自保持
  // css/jsonpath/template/text 形态，**节点支与标量支不互相压扁、不跨支合并**。
  // 求值语义见 evaluate.ts evaluateOr；分支预算见 MAX_OR_BRANCHES。
  | { kind: 'or'; branches: RuleIr[] }
  // && 合并节点（and1027，ENGINE_SYNTAX_AND）：每支都求值，legado 合并口径——字符串按行拼接非空支、
  // first（URL 字段，legado getString0）取首个非空支；列表上下文节点/JSON 条目按支序拼接（保序保重复）。
  // 支只会是 css / jsonpath（模式前缀、XPath、字面量、模板支编译期拒），求值见 evaluate.ts evaluateAnd。
  | { kind: 'and'; branches: RuleIr[]; first?: true }
  // JsoupXpath 语义求值（xpatheval1027，ENGINE_SYNTAX_XPATH_EVAL）：翻不成 CSS 的 legado XPath 段。
  // program=null 仅限「`/` 开头、含 `{$.` 内嵌规则、解析不了」的段（legado 在 JSON 输入上按 Json 模式读它）。
  // source = 段原文（JSON 输入上交 jsonRuleString）；forced = 带 `@XPath:` 前缀（JSON 输入上也强制 XPath）。
  | { kind: 'xpath'; program: XPathProgram | null; source: string; forced: boolean }
  // 当前内容原文（regex1027，ENGINE_SYNTAX_REGEX）：正则-only 规则（`##p##r###`，剥尾缀后主体为空）的输入。
  // legado getString 主体为空时不跑解析器，直接对 content.toString() 做替换：整页作用域 = 页面原文，
  // 条目作用域 = 元素 outerHtml（jsoup 带缩进美化，这里是 cheerio 原样序列化，见 evaluate.ts selfText）。
  | { kind: 'self' }
  // AllInOne 列表（aio1027，ENGINE_SYNTAX_AIO）：`:正则[&&正则…]` 在沙箱里按 legado AnalyzeByRegex.getElements 级联求值，
  // 条目 = 末级每个匹配的捕获组列表（见 aio-syntax.ts、evaluate.ts aioListScopes）。只出现在列表字段。
  | { kind: 'regexList'; stages: AioRegexStage[] }
  // AllInOne 条目模板（aio1027）：字面量与 `$N` 捕获组引用拼接（legado makeUpRule），只在 AllInOne 条目作用域求值。
  | { kind: 'groupRef'; parts: GroupRefPart[] };

/** AllInOne 一级正则（已译成 JS 源串；flags 不含 g）。 */
export interface AioRegexStage {
  pattern: string;
  flags: string;
}

export type GroupRefPart = { kind: 'literal'; text: string } | { kind: 'group'; index: number };

export type TemplatePart =
  | { kind: 'literal'; text: string }
  | { kind: 'jsonpath'; path: JsonPathIr }
  // legado 模板变量窄口子：只放行 {{baseUrl}}（当前页 URL）。
  // 见 parse.ts rejectUnsupportedTemplates / tryParseTemplate 的窄口与 evaluate.ts renderTemplate。
  | { kind: 'var'; name: 'baseUrl' };

/** ##pattern##replacement##flags## 正则替换。 */
export interface RegexSub {
  pattern: string;
  replacement: string;
  flags?: string;
  /**
   * legado replaceFirst（regex1027，ENGINE_SYNTAX_REGEX）：正则-only 段（主体为空）`##` 切出 ≥4 段（如 `##p##r###`）时
   * 只取首个匹配，结果 = 该匹配串套一次替换，匹配外的文本丢弃；无匹配得空串。off 态与带选择器主体的段不产出此键。
   */
  first?: true;
  /**
   * 求值期才拼出的正则（bind1028 规则级 makeUp）：编译期校验不了。legado replaceRegex 的失败口径——非 first 时 pattern
   * 编译失败按字面量整串替换，first 时直接得 replacement。
   */
  dynamic?: true;
}

/**
 * 含 JS 段字段的 legado 链式求值（jsbox1027，ENGINE_SYNTAX_JS）：按 `<js>…</js>` / `@js:` 切出的各段依次执行，
 * 上一段的字符串结果作为下一段输入（见 parse.ts parseJsChain、evaluate.ts evaluateChain）。
 */
export type ChainStage =
  /**
   * `mode`（listjs1027，只出现在列表字段的链里）：该段在 legado 里的解析模式——SourceRule 按段前缀与**原页面**是否
   * JSON 定，不看 JS 产出的文本长什么样：`json` = `$.`/`$[`/`@Json:`；`html` = `@CSS:`/`@@`/`@XPath:`/`/`（强制 jsoup/XPath）；
   * `default` = 无前缀（原页面是 JSON 时按 Json 模式）。见 evaluate.ts listChainScopes。
   * `nullSkip`（nullskip1029，ENGINE_SYNTAX_NULL_SKIP，只出现在字符串字段的链里）：该段在 HTML 作用域上取空 = legado getString 的
   * null，整条链得空（见 parse.ts nullSkipStage、evaluate.ts evaluateChain）。
   */
  | { kind: 'rule'; field: FieldIr; mode?: 'json' | 'html' | 'default'; nullSkip?: true }
  /**
   * `template` / `regex`（jsext1028，ENGINE_SYNTAX_JS_EXT）：legado SourceRule.makeUpRule 对 JS 段的改写。`template` = 段内
   * `{{}}` 切出的片段，求值时拼回代码后再按 `##` 切（此时 code 是段原文，只作预算键）；无 `{{}}` 时编译期已切好，
   * code = 首段 trim，`regex` = 其后的替换，作用在 JS 结果上。`detached`（jsext1028）：条目级字段首段 JS 不读 result/src，
   * 作用域没有原文时以空串起链（legado 首段 result 是 Element/Map，代码不碰它则产出相同）。pagejs1029 另给详情页 name/author/
   * tocUrl 挂（init 收窄后的作用域，ENGINE_SYNTAX_PAGE_DETACHED）。
   */
  | { kind: 'js'; code: string; template?: JsTemplatePart[]; regex?: RegexSub; detached?: true }
  /** 剥掉 ## 尾缀后主体为空的段（如 `</js>##广告##`）：只对上一段结果做替换。 */
  | { kind: 'regex'; regex: RegexSub[] };

/**
 * JS 段 makeUp 模板的片段（jsext1028）：字面代码、`{{规则}}`（legado isRule：`@`/`$.`/`$[`/`//` 开头，在字段作用域上取字符串）、
 * `{{JS}}`（以上一段结果为 result 在沙箱求值，结果按字符串拼回代码）、`@get:{键}`（varbag1028，只出现在规则级 makeUp：
 * 从本书变量袋取值，键原样不 trim）。
 */
export type JsTemplatePart =
  | { kind: 'text'; text: string } | { kind: 'rule'; field: FieldIr } | { kind: 'js'; code: string } | { kind: 'get'; key: string };

/** 一条字段规则的顶层组合。 */
export interface FieldIr {
  /** || 分隔的候选项，逐个尝试到首个非空（T7；M1 期数组长度=1）。 */
  rules: RuleIr[];
  /** 含 JS 段的链式字段（jsbox1027）。存在时 rules 为空数组，求值只走链。 */
  chain?: ChainStage[];
  /** && 分隔时的连接符（T7；M1 期 undefined）。 */
  joins?: string[];
  /** %% 分隔的拼接符（仅 2 源，T7；M1 期 undefined）。 */
  concats?: string;
  /** ##pattern##replacement##flags## 尾缀，可多段。 */
  regex?: RegexSub[];
  /**
   * 列表 JS 条目的键值直取（listjs1027，只挂在列表字段含 JS 的组的条目核心字段上）：legado getString 遇 NativeObject
   * 条目时只取首个 SourceRule、以其规则文本为键直接读对象属性，再套该段 `##` 替换。`unsupported` = 该规则在对象条目上
   * 不可复现（模板/@get/$N/首段即 JS），对象条目上求值失败；字符串条目照常按 rules/chain 求值。
   */
  objectKey?: { key: string; regex?: RegexSub } | { unsupported: string };
  /** 目录列表规则以 `-` 开头（listjs1027，legado BookChapterList 剥前缀后整表反转）。 */
  reverse?: true;
  /**
   * 规则级 makeUp（bind1028，ENGINE_SYNTAX_JS_BIND）：legado SourceRule 对非 JS 规则里 `{{}}` 的处理。`regexMode`（首个 `{{`
   * 前没有 `##`）= 整条按片段拼值后 `split("##")`，首段即结果（rules 为空）；否则 rules 是首个 `##` 之前的规则主体，`parts`
   * 只是从首个 `##` 起的尾巴，拼出后切成动态正则与替换（见 evaluate.ts makeUpValue）。
   */
  makeUp?: { parts: JsTemplatePart[]; regexMode: boolean };
  /**
   * JS 链里 `java.getString`/`java.getStringList` 的实参白名单（jsget1028，ENGINE_SYNTAX_JS_GET）：字面量规则文本 → 编译结果
   * （不含 JS）。求值期宿主回调只认这里的键，在字段作用域上取值（见 evaluate.ts jsBindings）。列表字段的 JS 链（listget1028，
   * ENGINE_SYNTAX_LIST_GET）同样挂，在页面作用域上取值（evaluate.ts listBookBindings）。
   */
  jsGets?: ReadonlyMap<string, FieldIr>;
  /**
   * JS 链用到了对称加解密 / toNumChapter / t2s 帮手（jsutil1028，ENGINE_SYNTAX_JS_UTIL；列表 JS 自 listutil1029 起）：求值期只给
   * 这样的字段装这批帮手，其余字段的沙箱逐字不变（见 js-sandbox.ts JsBindings.utilHelpers）。
   */
  jsUtil?: true;
  /**
   * 详情页 init 生效（init1028，ENGINE_SYNTAX_INIT，只挂在 `ruleBookInfo.init` 上，且形态过了 parse.ts initRuleSupported）：
   * 详情字段先在 init 的结果上求值（evaluate.ts bookInfoScope）。未挂 = init 不生效（off 态口径）。
   */
  initScope?: true;
  /**
   * URL 字段值剥 legado `,{选项}` 后缀（urlopt1028，ENGINE_URL_OPTIONS，只挂在 url-options.ts urlOptionFields 判出的字段上）：
   * 值进 host 门前先过 urlOptionHead（api.ts absoluteUrl / admission.ts）。未挂 = 原值进门（off 态口径）。
   */
  urlOptions?: true;
  /**
   * 详情页 put（varbag1028，ENGINE_SYNTAX_VARS_BAG，只挂在 ruleBookInfo.name/author/tocUrl 上）：`varPuts` = 字段 `@put:{…}` 的
   * 键 → 规则（不含 JS），legado putRule 先于字段规则在同一内容上求值；`varPut` = 字段 JS 里有字面量键的 `java.put`，字段本身
   * 也要求值才能填袋（evaluate.ts detailVarBag）。
   */
  varPuts?: ReadonlyArray<readonly [string, FieldIr]>;
  varPut?: true;
  /** 目录字段读本书变量袋（varbag1028）：`@get:{键}` makeUp 片段或 JS 里的 `java.get('键')`。求值时作用域没带袋即失败。 */
  varGets?: true;
  /**
   * 搜索条目袋（itemvars1028，ENGINE_SYNTAX_ITEM_VARS）：搜索字段放/读本条的袋，或详情/目录字段读搜索侧（searchUrl / 条目）
   * 放的键。门面据此按 legado 顺序逐条建袋、把袋随结果带给详情（evaluate.ts compiledUsesItemVars / compiledDetailNeedsItemVars）。
   */
  itemVars?: true;
  /**
   * JS 链直连 jsoup DOM（jsoup1028，ENGINE_SYNTAX_JSOUP）：沙箱装 Element/Elements/Java 字符串包装（js-sandbox.ts runJsoup），
   * 条目级首段 JS 的 result/src 是条目 Element、列表链首段规则的结果以 Elements 交给后面的 JS（evaluate.ts evaluateJsoupChain）。
   * 未挂 = 旧链路逐字不变。
   */
  jsoup?: true;
  /**
   * jsoup 重编帧里用到了 `java.ajax`（fieldnet1029，ENGINE_FIELD_NET_JS）：求值期只给这样的字段装 ajax 回调，页面由宿主按
   * evaluate.ts withFieldNet 的缓存应答，未取到即抛 FieldNetMissError（门面/准入取页后重放）。未挂 = 旧链路逐字不变。
   */
  jsAjax?: true;
  /** `java.getElement(s)("规则")` 的实参白名单（jsoup1028）：字面量规则文本 → 编译结果（不含 JS，须是取节点的规则）。 */
  jsElements?: ReadonlyMap<string, FieldIr>;
  /**
   * JS 读到的 `book` 成员（book1028，ENGINE_SYNTAX_BOOK_FIELDS；parse.ts bookFrame 重编通过才挂，可能含 origin）。求值时作用域的
   * ScopeHost 须带齐且非空，否则求值失败（evaluate.ts）；列表 JS 只在挂了它时注入宿主绑定。未挂 = 旧链路逐字不变。
   */
  bookMembers?: readonly string[];
  /**
   * JS 读到的书籍变量键（bookvar1028，ENGINE_SYNTAX_BOOK_VARIABLE；只在 jsoup + 书籍成员重试帧里挂）：编译期已核键是字面量、
   * 源内没有往书籍变量放该键的写法，求值时沙箱 `book.getVariable` 得 Java 空串（jsoup-shim.ts）。未挂 = 旧链路逐字不变。
   */
  bookVars?: readonly string[];
  /**
   * 源的 jsLib 原文（jslib1028，ENGINE_SYNTAX_JS_LIB；只挂在带 JS 段的字段上，库已过 js-lib.ts analyzeJsLib、字段已过 jsLibRuleProblem）：
   * 求值时沙箱在规则代码前先求值库，失败即字段求值失败（legado 共享作用域口径）。未挂 = 旧链路逐字不变。
   */
  jsLib?: string;
  /**
   * 翻页字段（nextTocUrl/nextContentUrl）的非链 CSS 规则按 legado getStringList 取值（parse.ts nextListShape）：用到末段裸名 attr
   * （lastattr1029，ENGINE_SYNTAX_LAST_ATTR）或 ENGINE_SYNTAX_NEXT_LIST on（nextlist1029）时挂。逐节点取全部值、逐项套 `##` 替换
   * （evaluate.ts evaluateFieldStrings），api.ts 照 JS 链口径取 1 个串行/多个并发。未挂 = 旧链路逐字不变。
   */
  nextList?: true;
}

/** 装饰字段编译失败不阻断，标 skip 的占位。 */
export interface SkippedField {
  skipped: 'unsupported' | 'decorative';
}

/** 规则字段名 → 编译结果。 */
export type CompiledRules = Map<string, FieldIr | SkippedField>;

// ---- 编译期防御上限（防规则炸弹，§2.3）----
export const MAX_RULE_LENGTH = 2048; //          规则串长度上限，对齐 sourceSearchUrl
/** 含 JS 段的整条规则长度上限（jsbox1027）：JS 段常见 1–4K 字符，非 JS 段仍各自受 MAX_RULE_LENGTH 约束。 */
export const MAX_JS_RULE_LENGTH = 8192;
/** 沙箱提供的 java.* 纯计算帮手（jsbox1027）：parse.ts 编译期白名单与 js-sandbox.ts 宿主实现共用这一份。 */
export const JS_JAVA_HELPERS: ReadonlySet<string> = new Set([
  'base64Decode', 'base64Encode', 'md5Encode', 'md5Encode16', 'encodeURI', 'hexDecodeToString', 'log', 'toast', 'longToast',
]);
/** 读字段作用域的 java.* 宿主回调（jsget1028）：不在 JS_JAVA_HELPERS 里，只在 ENGINE_SYNTAX_JS_GET on 且实参是字面量时放行。 */
export const JS_JAVA_GETTERS: ReadonlySet<string> = new Set(['getString', 'getStringList']);
/**
 * 对称加解密与章节号帮手（jsutil1028）：不在 JS_JAVA_HELPERS 里，只在 ENGINE_SYNTAX_JS_UTIL on 时放行。弃用的 aes/des/3DES 包装
 * 只收 legado 里等价于 createSymmetricCrypto(...).decryptStr/encryptBase64 的几个（js-sandbox.ts UTIL_PRELUDE 同名单）。
 * t2s1029 另收繁转简 `t2s`（结果只许按字符串用，见 parse.ts checkT2sCall）。
 */
export const JS_JAVA_UTIL_HELPERS: ReadonlySet<string> = new Set([
  'createSymmetricCrypto', 'aesBase64DecodeToString', 'aesDecodeToString', 'aesEncodeToBase64String', 'desDecodeToString',
  'desBase64DecodeToString', 'desEncodeToBase64String', 'tripleDESDecodeStr', 'tripleDESEncodeBase64Str', 'toNumChapter', 't2s',
]);
export const MAX_CSS_CHAIN_DEPTH = 8; //         CssStep 链深上限
export const MAX_REGEX_PATTERN_LENGTH = 256; //  正则 pattern 长度上限
/** || 组合分支数上限（P1a，设计 §5.1 建议 16 的保守起点；2048 字符规则串最多也就 ~1024 支，预算前置防滥用）。 */
export const MAX_OR_BRANCHES = 16;
