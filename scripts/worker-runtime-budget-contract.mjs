import assert from 'node:assert/strict';
import { existsSync as fsExistsSync, mkdtempSync as fsMkdtempSync, rmSync as fsRmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 第六组跨仓契约的可注入实现：runtime 日预算退还往返 + 限速器错误名。
 *
 * 为什么单独成模块（2026-10-23）：这条契约原先只能这样测——读 check-worker-contract.mjs 的源码文本、
 * 从锚点 `const shellBudgetPath =` 切到**文件尾**、丢进 VM 里 eval，再把 `await import(` 全局替换成桩。
 * 切片对文件结构零容忍：锚点一旦被包进 `if (shellPresent) { … }`，切出来的尾巴就多一个不配对的 `}`，
 * 整段 SyntaxError，4 个用例全红（实测挡下了一次 push）。同一类脆弱此前已咬过一次——第五组的锚点搬进
 * template 后永久失配，而那条契约因为从没被执行过，红了 17 天没人发现。所以这里把逻辑抽成纯函数、
 * 依赖全部注入，检查器与测试**调同一个函数**：不再有第三份源码解析，也没有「切片边界」这个概念。
 *
 * 「跳过 vs 拒绝」的策略集中在本函数里，因为它正是测试要钉住的东西：
 *   shellPresent=false（兄弟仓没有 runtime/ 源目录）→ 返回 'skipped'。这是**无法验证**，不等于验证
 *     通过，由调用方负责 warn 说清影响；
 *   runtime/ 在、但缺 daily-budget.mjs / rate-limiter.mjs → **抛错**，不按可选契约放行（残缺状态
 *     会让打包出的执行器在运行期才炸，比 push 时红一次贵得多）。
 *
 * 契约本体（41-EXEC-SRCUNAVAIL）：runtime-download/budget-refund.ts 与兄弟仓 runtime/lib/daily-budget.mjs
 * 读写同一份状态文件；scripts/engine-download.mjs 的 isSourceUnavailableError 按 name 识别兄弟仓限速器的
 * 两类错误。任一侧改了文件格式或类名，这里在 push 时就红，而不是上线后静默漏退、或把瞬时错误落成终态。
 */

/** 兄弟仓 runtime/ 里本组契约必需的两个文件（相对 workerRoot，斜杠分隔）。 */
export const RUNTIME_BUDGET_FILE = 'runtime/lib/daily-budget.mjs';
export const RUNTIME_LIMITER_FILE = 'runtime/lib/rate-limiter.mjs';
export const REQUIRED_RUNTIME_FILES = [RUNTIME_BUDGET_FILE, RUNTIME_LIMITER_FILE];

/** 跑通时的返回值，与 'skipped' 区分开——调用方/测试据此判断契约是真跑过还是没跑。 */
export const CONTRACT_PASSED = 'passed';
export const CONTRACT_SKIPPED = 'skipped';

// 默认导入器：相对说明符按**本模块**解析，而本模块与 check-worker-contract.mjs 同在 scripts/，
// 所以 '../runtime-download/budget-refund.ts' 与 './engine-download.mjs' 的落点与抽取前逐字相同。
const importEsm = (specifier) => import(specifier);

/**
 * @param {object} deps
 * @param {string} deps.workerRoot 兄弟仓根目录（绝对路径）。
 * @param {boolean} deps.shellPresent 兄弟仓是否有 runtime/ 源目录。
 * @param {(file: string) => boolean} [deps.existsSync] 文件存在性判定（测试注入）。
 * @param {(dir: string) => string} [deps.mkdtempSync] 建临时目录（测试注入，避免真落盘）。
 * @param {(dir: string, opts: object) => void} [deps.rmSync] 删临时目录（测试注入）。
 * @param {() => string} [deps.tmpdir] 临时根目录（测试注入）。
 * @param {(specifier: string) => Promise<object>} [deps.importModule] 模块加载（测试注入桩模块）。
 * @param {(line: string) => void} [deps.log] 成功摘要行（测试注入以断言原文）。
 * @returns {Promise<'passed'|'skipped'>}
 */
export async function runRuntimeBudgetContract({
  workerRoot,
  shellPresent,
  existsSync = fsExistsSync,
  mkdtempSync = fsMkdtempSync,
  rmSync = fsRmSync,
  tmpdir = osTmpdir,
  importModule = importEsm,
  log = console.log,
}) {
  if (!shellPresent) return CONTRACT_SKIPPED;

  const shellBudgetPath = resolve(workerRoot, RUNTIME_BUDGET_FILE);
  const shellLimiterPath = resolve(workerRoot, RUNTIME_LIMITER_FILE);
  // 兄弟仓**整体**缺席由 pre-push 的目录检查决定跳过；进入此处时 runtime/ 已存在（第五组已放行）。
  // 这两个文件分别是 shell 的静态依赖与打包器注入的依赖，缺失不能按可选契约放行。
  const missingRuntimeFiles = [shellBudgetPath, shellLimiterPath].filter((file) => !existsSync(file));
  if (missingRuntimeFiles.length) {
    throw new Error(`跨仓 runtime 契约失败：缺少必需文件 ${missingRuntimeFiles
      .map((file) => relative(workerRoot, file).replaceAll('\\', '/')).join(', ')}`);
  }

  const { createDailyBudget } = await importModule(pathToFileURL(shellBudgetPath).href);
  const { createBudgetRefund } = await importModule('../runtime-download/budget-refund.ts');
  const dir = mkdtempSync(join(tmpdir(), 'budget-contract-'));
  try {
    const statePath = join(dir, 'daily-budget.json');
    const now = () => Date.parse('2026-09-24T03:00:00.000Z');
    const budget = createDailyBudget({ statePath, limit: 3, now });
    const first = await budget.consume();
    await budget.consume();
    const refund = createBudgetRefund({ statePath, now });
    assert.equal(await refund({ key: 'contract:1', date: first.date }), 'refunded');
    assert.deepEqual(await budget.read(), { date: first.date, used: 1 });
    assert.equal(await refund({ key: 'contract:1', date: first.date }), 'duplicate');
    assert.deepEqual(await budget.read(), { date: first.date, used: 1 });
    assert.equal((await budget.consume()).used, 2); // shell 在退还后的文件上照常续扣
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const limiter = await importModule(pathToFileURL(shellLimiterPath).href);
  const { isSourceUnavailableError } = await importModule('./engine-download.mjs');
  assert.ok(isSourceUnavailableError(new limiter.CircuitOpenError('book15.net', Date.now())), 'CircuitOpenError 必须归 source_unavailable');
  assert.ok(isSourceUnavailableError(new limiter.DailyRequestBudgetError('book15.net', 20_000)), 'DailyRequestBudgetError 必须归 source_unavailable');
  log('Cross-repository runtime budget/limiter contract: refund round-trip + 2 limiter error names passed');
  return CONTRACT_PASSED;
}
