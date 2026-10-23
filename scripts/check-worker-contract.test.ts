import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_PASSED,
  CONTRACT_SKIPPED,
  REQUIRED_RUNTIME_FILES,
  RUNTIME_BUDGET_FILE,
  RUNTIME_LIMITER_FILE,
  runRuntimeBudgetContract,
} from './worker-runtime-budget-contract.mjs';

// 第六组契约（runtime 日预算退还往返 + 限速器错误名）直接调生产函数、依赖注入假模块。
//
// 这里**曾经**是「读 check-worker-contract.mjs 源码 → 从锚点 `const shellBudgetPath =` 切到文件尾 →
// 把 `await import(` 全替换成桩 → 丢进 runInNewContext 里 eval」。那种写法测的是源码文本的形状，不是
// 行为：锚点被包进 `if (shellPresent) { … }` 之后，切到文件尾就多出一个不配对的 `}`，整段 SyntaxError，
// 4 个用例全红并挡下一次 push（2026-10-23 实测）。同一类脆弱此前已咬过一次——第五组的锚点搬进
// template 后永久失配，而那条契约从没被执行过，红了 17 天没人发现。抽取成可注入模块后，检查器与本
// 测试调同一个函数，没有切片边界可言；「检查器是否真的还在调它」由下面最后一条接线钉负责。

const workerRoot = resolve('synthetic-worker');
const LIMITER_ERRORS = ['CircuitOpenError', 'DailyRequestBudgetError'];

type HarnessOptions = {
  /** isSourceUnavailableError 的判定；默认按错误名认这两类（与真 shell 同语义）。 */
  classify?: (error: Error) => boolean;
  /** 'always-duplicate' = 退还器首次就谎报「已退过」，用来钉住契约里那句 assert.equal(…, 'refunded')。 */
  refundMode?: 'normal' | 'always-duplicate';
};

/** 假模块表：与真 shell 的导出面同名同形，且记录每次 import 的说明符与每次错误名判定。 */
function syntheticModules(record: (specifier: string) => void, classified: (error: Error) => boolean,
                          refundMode: 'normal' | 'always-duplicate') {
  let used = 0;
  let refunded = false;
  const date = '2026-09-24';
  class CircuitOpenError extends Error { name = 'CircuitOpenError'; }
  class DailyRequestBudgetError extends Error { name = 'DailyRequestBudgetError'; }
  return async (specifier: string) => {
    record(specifier);
    if (specifier.endsWith('/daily-budget.mjs')) {
      return {
        createDailyBudget: () => ({
          consume: async () => ({ allowed: true, used: ++used, date }),
          read: async () => ({ date, used }),
        }),
      };
    }
    if (specifier.endsWith('/budget-refund.ts')) {
      return {
        createBudgetRefund: () => async () => {
          if (refundMode === 'always-duplicate' || refunded) return 'duplicate';
          refunded = true; used--; return 'refunded';
        },
      };
    }
    if (specifier.endsWith('/rate-limiter.mjs')) return { CircuitOpenError, DailyRequestBudgetError };
    if (specifier.endsWith('/engine-download.mjs')) return { isSourceUnavailableError: classified };
    throw new Error(`Unexpected synthetic module: ${specifier}`);
  };
}

/** 装配一轮注入依赖；missing 里的相对路径会被判为「不存在」。 */
function harness(missing: string[], shellPresent = true, options: HarnessOptions = {}) {
  const imported = vi.fn();
  const removed = vi.fn();
  const temporary = vi.fn(() => resolve('synthetic-budget-state'));
  const log = vi.fn();
  const classify = vi.fn(options.classify ?? ((error: Error) => LIMITER_ERRORS.includes(error.name)));
  const absent = new Set(missing.map(name => resolve(workerRoot, name)));
  return {
    imported, removed, temporary, log, classified: classify,
    deps: {
      workerRoot,
      shellPresent,
      existsSync: (file: string) => !absent.has(file),
      mkdtempSync: temporary,
      rmSync: removed,
      tmpdir: () => '/synthetic-temp',
      importModule: syntheticModules(imported, classify, options.refundMode ?? 'normal'),
      log,
    },
  };
}

/** 跑一轮并把异常收进返回值（与断言「必须拒绝」的用例配合，一次调用拿到全部证据）。 */
async function capture(deps: Parameters<typeof runRuntimeBudgetContract>[0]) {
  try {
    return { status: await runRuntimeBudgetContract(deps), error: undefined as Error | undefined };
  } catch (error) {
    return { status: undefined, error: error as Error };
  }
}

describe('跨仓 runtime 必需文件', () => {
  it('文件齐全时继续执行原预算往返与限速器契约', async () => {
    const run = harness([]);
    const { status, error } = await capture(run.deps);
    expect(error, error?.message).toBeUndefined();
    expect(status).toBe(CONTRACT_PASSED);
    // 四个模块一个都不能少：shell 预算 / 本仓退还器 / shell 限速器 / 本仓错误分类。
    expect(run.imported).toHaveBeenCalledTimes(4);
    expect(run.removed).toHaveBeenCalledTimes(1);   // 临时目录必须清（finally）
    expect(run.log).toHaveBeenCalledWith(expect.stringContaining('refund round-trip + 2 limiter error names passed'));
  });

  it.each([[RUNTIME_BUDGET_FILE], [RUNTIME_LIMITER_FILE], REQUIRED_RUNTIME_FILES])(
    '缺少必需文件 %j 必须拒绝，不能以 skip 通过', async (...missing) => {
      const run = harness(missing);
      const { status, error } = await capture(run.deps);
      expect(status, '残缺状态被当成可选契约放行了').toBeUndefined();
      expect(error?.message).toContain('缺少必需文件');
      for (const name of missing) expect(error?.message).toContain(name);
      // 拒绝必须发生在任何副作用之前：不加载模块、不建临时目录、不打成功摘要。
      expect(run.imported).not.toHaveBeenCalled();
      expect(run.temporary).not.toHaveBeenCalled();
      expect(run.removed).not.toHaveBeenCalled();
      expect(run.log).not.toHaveBeenCalled();
    });

  it('兄弟仓没有 runtime/ 源：明确 skipped，不抛也不碰文件系统', async () => {
    // 与上一条是一体两面：整体缺席 = 无法验证（skipped，由检查器 warn 说清影响）；
    // runtime/ 在但缺文件 = 验证失败（抛错）。这两种策略若被合并成一种，其中一条用例必然变红。
    const run = harness([], false);
    const { status, error } = await capture(run.deps);
    expect(error, error?.message).toBeUndefined();
    expect(status).toBe(CONTRACT_SKIPPED);
    expect(run.imported).not.toHaveBeenCalled();
    expect(run.temporary).not.toHaveBeenCalled();
    expect(run.log).not.toHaveBeenCalled();
  });

  it('退还器首次就报 duplicate 时契约必须红（钉住 assert.equal(…, \'refunded\')）', async () => {
    // 负向对照：契约里那句「首次退还必须真的退还」若被删掉，上面所有用例照绿——
    // 因为桩的 used 计数与 log 行都不依赖它。这里让桩撒谎，红才算钉住。
    const run = harness([], true, { refundMode: 'always-duplicate' });
    const { error } = await capture(run.deps);
    expect(error?.message, '退还器谎报 duplicate 却没被判出来').toContain('refunded');
    expect(run.log).not.toHaveBeenCalled();
  });

  it.each(LIMITER_ERRORS)('限速器 %s 未被归为 source_unavailable 时契约必须红', async (denied) => {
    // 同上：钉住两条 assert.ok(isSourceUnavailableError(...)) 真的在、且各自带得出是哪一类错了。
    const run = harness([], true, { classify: (error: Error) => error.name !== denied });
    const { error } = await capture(run.deps);
    expect(error?.message).toContain(`${denied} 必须归 source_unavailable`);
    expect(run.log).not.toHaveBeenCalled();
  });

  it('两类限速器错误都被送去判定过', async () => {
    const run = harness([]);
    await capture(run.deps);
    expect(run.classified.mock.calls.map(([error]) => (error as Error).name)).toEqual(LIMITER_ERRORS);
  });

  it('检查器真的调用本函数，且没有留下第二份契约正文', () => {
    // 接线钉：抽取成模块后，「检查器忘了调」不会让上面任何一条变红——契约会静默消失，
    // 而测试全绿（与 backfill_quality 端点接线同型的洞）。这里直接把检查器源码当断言对象。
    const source = readFileSync(new URL('./check-worker-contract.mjs', import.meta.url), 'utf8');
    expect(source).toContain("from './worker-runtime-budget-contract.mjs'");
    expect(source).toMatch(/runRuntimeBudgetContract\(\{\s*workerRoot,\s*shellPresent\s*\}\)/);
    // 旧锚点/旧正文一旦回来，说明契约又被内联了一份：两份拷贝必然漂移，本模块就成了死代码。
    expect(source, '第六组正文又被内联回检查器了').not.toContain('const shellBudgetPath =');
    expect(source).not.toContain(RUNTIME_BUDGET_FILE);
    expect(source).not.toContain(RUNTIME_LIMITER_FILE);
    expect(source).not.toContain('refund round-trip + 2 limiter error names passed');
  });

  it('兄弟仓整体缺席仍由原 pre-push contracts-only 入口跳过', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-contract-'));
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    try {
      expect(existsSync(join(root, 'zhaoshu-books'))).toBe(false);
      let shell = 'sh';
      if (process.platform === 'win32') {
        const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 5_000 });
        expect(git.status).toBe(0);
        shell = resolve(git.stdout.trim(), '../../../usr/bin/sh.exe');
      }
      const hook = resolve('.githooks/pre-push');
      const result = spawnSync(shell, [hook, 'contracts-only'], { cwd: checkout, encoding: 'utf8', timeout: 5_000 });
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      expect(result.stdout).toContain('跳过跨仓契约');
    } finally {
      rmdirSync(checkout);
      rmdirSync(root);
    }
  });
});
