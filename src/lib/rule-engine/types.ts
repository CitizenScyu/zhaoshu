// M1 规则引擎 IR 类型定义。字段语义全部对齐 legado 默认语法。
// 设计依据：m1-engine-design.md v3 §2.2。任务 1 只交付 types/parse/jsonpath——
// evaluate/dom-ops/compile/admission 属后续任务，本文件只声明解析层需要的类型。

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
}

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
  | { kind: 'filterEq'; name: string; value: string | number | boolean }; // [?(@.x==y)]

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
  | { kind: 'text'; literal: string };

export type TemplatePart =
  | { kind: 'literal'; text: string }
  | { kind: 'jsonpath'; path: JsonPathIr };

/** ##pattern##replacement##flags## 正则替换。 */
export interface RegexSub {
  pattern: string;
  replacement: string;
  flags?: string;
}

/** 一条字段规则的顶层组合。 */
export interface FieldIr {
  /** || 分隔的候选项，逐个尝试到首个非空（T7；M1 期数组长度=1）。 */
  rules: RuleIr[];
  /** && 分隔时的连接符（T7；M1 期 undefined）。 */
  joins?: string[];
  /** %% 分隔的拼接符（仅 2 源，T7；M1 期 undefined）。 */
  concats?: string;
  /** ##pattern##replacement##flags## 尾缀，可多段。 */
  regex?: RegexSub[];
}

/** 装饰字段编译失败不阻断，标 skip 的占位。 */
export interface SkippedField {
  skipped: 'unsupported' | 'decorative';
}

/** 规则字段名 → 编译结果。 */
export type CompiledRules = Map<string, FieldIr | SkippedField>;

// ---- 编译期防御上限（防规则炸弹，§2.3）----
export const MAX_RULE_LENGTH = 2048; //          规则串长度上限，对齐 sourceSearchUrl
export const MAX_CSS_CHAIN_DEPTH = 8; //         CssStep 链深上限
export const MAX_REGEX_PATTERN_LENGTH = 256; //  正则 pattern 长度上限
