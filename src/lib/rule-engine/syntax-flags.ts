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

/** 语义版本随 || 开关联动（唯一口径，供 compile.ts 缓存键与 rulesHash 复用）。 */
export function engineSemanticsVersion(orEnabled: boolean): number {
  return orEnabled ? ENGINE_SEMANTICS_VERSION_OR : ENGINE_SEMANTICS_VERSION;
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
