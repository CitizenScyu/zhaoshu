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

/** 语义版本随 || / XPath / 变量开关联动（唯一口径，供 compile.ts 缓存键与 rulesHash 复用）。 */
export function engineSemanticsVersion(orEnabled: boolean, xpathEnabled = false, varsEnabled = false): number {
  return (orEnabled ? ENGINE_SEMANTICS_VERSION_OR : ENGINE_SEMANTICS_VERSION)
    + (xpathEnabled ? ENGINE_SEMANTICS_XPATH_BIT : 0) + (varsEnabled ? ENGINE_SEMANTICS_VARS_BIT : 0);
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
