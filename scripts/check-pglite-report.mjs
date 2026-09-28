import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 保留旧门禁对 PGlite 名称的大小写与位置兼容性；只判断仓库相对路径，
// 不让工作树目录名（例如 pglite-report-gate-wt）把所有普通用例也归入此类。
const isPgliteTest = (name) => /\.test\.tsx?$/.test(name) && /pglite/i.test(name);

// 与 node:test / Python 门禁一样，清点已跟踪及尚未提交的用例；不扫描依赖或读取环境文件。
export function discoverPgliteTests(root = repoRoot) {
  const listed = spawnSync('git', [
    '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    '*.test.ts', '*.test.tsx',
  ], { encoding: 'utf8', timeout: 10_000 });
  if (listed.error || listed.status !== 0) throw new Error('无法用 git 清点 PGlite 测试文件，拒绝放行');
  // 全仓清点：移入 Vitest include 之外的 PGlite 测试也必须报告，不能同时从两边消失。
  const files = [...new Set(listed.stdout.split('\0').filter(isPgliteTest))].sort();
  // 保留原门禁的最低底线；实际覆盖要求是下面逐文件核对，不能仅靠此数量放行。
  if (files.length < 2) throw new Error('仓库 PGlite 测试文件不足 2 个，拒绝放行');
  return files;
}

function reportPath(name, root) {
  if (typeof name !== 'string' || !name) throw new Error('测试报告缺少有效的文件名');
  const local = relative(resolve(root), resolve(root, name.replaceAll('\\', '/')));
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
    throw new Error('测试报告包含仓库之外的文件，拒绝放行');
  }
  return local.split(sep).join('/');
}

/** 仅校验报告结构和执行状态，不输出用例内容或错误原文。 */
export function checkPgliteReport(report, expectedFiles, root = repoRoot) {
  if (!report || report.success !== true || !Array.isArray(report.testResults)) {
    throw new Error('Vitest 报告无效或未成功完成');
  }
  const expected = new Set(expectedFiles.map(name => reportPath(name, root)));
  if (expected.size < 2 || [...expected].some(name => !isPgliteTest(name))) {
    throw new Error('PGlite 预期文件清单无效');
  }
  const seen = new Set();
  let passed = 0;
  for (const result of report.testResults) {
    const name = reportPath(result?.name, root);
    if (!isPgliteTest(name)) continue; // 非 PGlite 的显式离线/联网基准 skip 不受影响。
    if (!expected.has(name)) throw new Error(`报告包含清单之外的 PGlite 文件：${name}`);
    if (seen.has(name)) throw new Error(`PGlite 文件报告重复：${name}`);
    seen.add(name);
    if (result.status !== 'passed') throw new Error(`PGlite 文件未通过：${name}`);
    if (!Array.isArray(result.assertionResults) || result.assertionResults.length === 0) {
      throw new Error(`PGlite 文件没有实际执行的用例：${name}`);
    }
    if (result.assertionResults.some(assertion => assertion?.status !== 'passed')) {
      throw new Error(`PGlite 文件存在跳过、待办或失败用例：${name}`);
    }
    passed += result.assertionResults.length;
  }
  const missing = [...expected].filter(name => !seen.has(name));
  if (missing.length) throw new Error(`报告缺少 ${missing.length} 个 PGlite 测试文件：\n${missing.join('\n')}`);
  return { files: seen.size, passed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('用法：node scripts/check-pglite-report.mjs [报告路径]');
    let report;
    try {
      report = JSON.parse(readFileSync(resolve(process.argv[2] || '.vitest-report.json'), 'utf8'));
    } catch {
      throw new Error('无法读取有效的 Vitest JSON 报告');
    }
    const summary = checkPgliteReport(report, discoverPgliteTests());
    console.log(`PGlite 报告完整：${summary.files} 个文件，${summary.passed} 个用例通过，0 跳过`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PGlite 报告校验失败');
    process.exitCode = 1;
  }
}
