import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { checkPgliteReport, discoverPgliteTests } from './check-pglite-report.mjs';

const root = process.cwd();
const expected = ['src/lib/first.pglite.test.ts', 'runtime-download/second.pglite.test.ts', 'src/app/api/third.pglite.test.ts'];
const file = (name: string) => ({ name, status: 'passed', assertionResults: [{ status: 'passed' }] });
const report = (names = expected) => ({ success: true, testResults: names.map(file) });

describe('PGlite 报告完整性', () => {
  it('完整报告通过，接受绝对路径和 Windows 分隔符', () => {
    const input = report();
    input.testResults[0].name = resolve(root, expected[0]);
    input.testResults[1].name = resolve(root, expected[1]).replaceAll('/', '\\');
    expect(checkPgliteReport(input, expected, root)).toEqual({ files: 3, passed: 3 });
  });

  it('原门禁会放行的仅两个文件报告必须拒绝', () => {
    expect(() => checkPgliteReport(report(expected.slice(0, 2)), expected, root)).toThrow(/缺少 1 个.*PGlite/);
  });

  it('重复报告不能代替缺失文件', () => {
    const input = report([expected[0], expected[1], expected[0]]);
    input.testResults[2].name = resolve(root, expected[0]);
    expect(() => checkPgliteReport(input, expected, root)).toThrow(/重复/);
  });

  it.each(['failed', 'pending', 'skipped', 'todo', 'disabled', 'unknown'])(
    '拒绝断言状态 %s', status => {
      const input = report();
      input.testResults[1].assertionResults.push({ status });
      expect(() => checkPgliteReport(input, expected, root)).toThrow(/跳过、待办或失败/);
    },
  );

  it('beforeAll/afterAll 失败即使所有断言通过也拒绝', () => {
    const input = report();
    input.testResults[0].status = 'failed';
    expect(() => checkPgliteReport(input, expected, root)).toThrow(/文件未通过/);
  });

  it('空断言文件不能代替真正执行', () => {
    const input = report();
    input.testResults[0].assertionResults = [];
    expect(() => checkPgliteReport(input, expected, root)).toThrow(/没有实际执行/);
  });

  it('缺失断言数组时拒绝', () => {
    const input = { success: true, testResults: [{ name: expected[0], status: 'passed' }] };
    expect(() => checkPgliteReport(input, expected, root)).toThrow(/没有实际执行/);
  });

  it.each([null, {}, { success: true }, { success: false, testResults: [] }])('拒绝畸形或失败报告 %#', input => {
    expect(() => checkPgliteReport(input, expected, root)).toThrow(/报告无效或未成功完成/);
  });

  it('允许非 PGlite 基准用例显式跳过', () => {
    const input = { ...report(), numPendingTests: 1 };
    input.testResults.push({ name: 'scripts/coverage-bench.run.test.ts', status: 'passed', assertionResults: [{ status: 'pending' }] });
    expect(checkPgliteReport(input, expected, root)).toEqual({ files: 3, passed: 3 });
  });

  it('拒绝清单之外的 PGlite 文件', () => {
    expect(() => checkPgliteReport(report([...expected, 'src/lib/unknown.pglite.test.ts']), expected, root)).toThrow(/清单之外/);
  });

  it('拒绝其他工作树同名报告', () => {
    expect(() => checkPgliteReport(report(['../other/src/lib/first.pglite.test.ts']), expected, root)).toThrow(/仓库之外/);
  });

  it('仓库真实清单包含运行时、路由及库用例，完整合成报告可通过', () => {
    const files = discoverPgliteTests(root);
    expect(files).toContain('runtime-download/executor.pglite.test.ts');
    expect(files).toContain('src/app/api/auth/register/route.e2e.pglite.test.ts');
    expect(files).toContain('src/lib/user-data.shelf.pglite.test.ts');
    expect(checkPgliteReport(report(files), files, root).files).toBe(files.length);
  });

  it('CI 同款 CLI 对完整报告退出 0、缺文件及非法 JSON 退出非 0', () => {
    const output = join(tmpdir(), `pglite-report-${randomUUID()}.json`);
    const files = discoverPgliteTests(root);
    const run = (content: string) => {
      writeFileSync(output, content);
      return spawnSync(process.execPath, ['scripts/check-pglite-report.mjs', output], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    };
    try {
      const valid = run(JSON.stringify(report(files)));
      expect(valid.status, valid.stderr).toBe(0);
      const incomplete = run(JSON.stringify(report(files.slice(0, 2))));
      expect(incomplete.status).toBe(1);
      expect(incomplete.stderr).toContain('报告缺少');
      const malformed = run('{invalid');
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain('无法读取有效');
    } finally {
      unlinkSync(output);
    }
  }, 30_000);
});
