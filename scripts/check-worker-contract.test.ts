import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./check-worker-contract.mjs', import.meta.url), 'utf8');
// 执行原检查器第六组完整路径；仅把外部模块加载替换为无文件/网络副作用的预算桩。
const start = source.indexOf('const shellBudgetPath =');
if (start < 0) throw new Error('未找到原检查器 runtime 预算/限速器契约');
const contract = source.slice(start).replaceAll('await import(', 'await importModule(');
const workerRoot = resolve('synthetic-worker');
const names = ['runtime/lib/daily-budget.mjs', 'runtime/lib/rate-limiter.mjs'];

async function runRuntimeContract(missing: string[]) {
  const imported = vi.fn();
  const removed = vi.fn();
  const temporary = vi.fn(() => resolve('synthetic-budget-state'));
  const log = vi.fn();
  const absent = new Set(missing.map(name => resolve(workerRoot, name)));
  const context = {
    assert, workerRoot, resolve, relative, join, pathToFileURL, tmpdir: () => '/synthetic-temp',
    existsSync: (file: string) => !absent.has(file),
    mkdtempSync: temporary, rmSync: removed, imported, console: { log },
  };
  // 桩对象与原契约在同一 VM 中创建，让原 assert.deepEqual 保留真实语义。
  const modules = `
    let used = 0, refunded = false;
    const date = '2026-09-24';
    class CircuitOpenError extends Error { name = 'CircuitOpenError'; }
    class DailyRequestBudgetError extends Error { name = 'DailyRequestBudgetError'; }
    async function importModule(specifier) {
      imported(specifier);
      if (specifier.endsWith('/daily-budget.mjs')) return {
        createDailyBudget: () => ({
          consume: async () => ({ allowed: true, used: ++used, date }),
          read: async () => ({ date, used }),
        }),
      };
      if (specifier.endsWith('/budget-refund.ts')) return {
        createBudgetRefund: () => async () => {
          if (refunded) return 'duplicate';
          refunded = true; used--; return 'refunded';
        },
      };
      if (specifier.endsWith('/rate-limiter.mjs')) return { CircuitOpenError, DailyRequestBudgetError };
      if (specifier.endsWith('/engine-download.mjs')) return {
        isSourceUnavailableError: error => ['CircuitOpenError', 'DailyRequestBudgetError'].includes(error.name),
      };
      throw new Error('Unexpected synthetic module');
    }
  `;
  let error: Error | undefined;
  try { await runInNewContext(`(async () => { ${modules}\n${contract} })()`, context, { timeout: 1_000 }); }
  catch (failure) { error = failure as Error; }
  return { error, imported, removed, temporary, log };
}

describe('跨仓 runtime 必需文件', () => {
  it('文件齐全时继续执行原预算往返与限速器契约', async () => {
    const result = await runRuntimeContract([]);
    expect(result.error).toBeUndefined();
    expect(result.imported).toHaveBeenCalledTimes(4);
    expect(result.removed).toHaveBeenCalledTimes(1);
    expect(result.log).toHaveBeenCalledWith(expect.stringContaining('refund round-trip + 2 limiter error names passed'));
  });

  it.each([[names[0]], [names[1]], names])('缺少必需文件 %j 必须拒绝，不能以 skip 通过', async (...missing) => {
    const result = await runRuntimeContract(missing);
    expect(result.error?.message).toContain('缺少必需文件');
    for (const name of missing) expect(result.error?.message).toContain(name);
    expect(result.imported).not.toHaveBeenCalled();
    expect(result.temporary).not.toHaveBeenCalled();
    expect(result.removed).not.toHaveBeenCalled();
    expect(result.log).not.toHaveBeenCalled();
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
