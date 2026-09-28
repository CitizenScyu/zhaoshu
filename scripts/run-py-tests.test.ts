import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

type ChildResult = { status: number | null; signal?: string | null; error?: Error; stdout?: string; stderr?: string };
const scriptUrl = new URL('./run-py-tests.mjs', import.meta.url).href;
// 原 runner 整体执行，只替换 OS 边界；不复制汇总解析、逐文件判定或最终退出逻辑。
const source = readFileSync(new URL(scriptUrl), 'utf8')
  .replace(/^import .+;\r?$/gm, '')
  .replaceAll('import.meta.url', 'scriptUrl');
const okOutput = '\nRan 35 tests in 0.001s\n\nOK\n';
const valid: ChildResult = { status: 0, signal: null, stdout: '', stderr: okOutput };

function runGate(result: ChildResult) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitSignal = {};
  let code = 0;
  const context = {
    scriptUrl, basename, dirname, join, sep, fileURLToPath,
    existsSync: () => true,
    spawnSync: (command: string, args: string[]) => {
      if (command === 'git') return { status: 0, stdout: Array.from({ length: 10 }, (_, n) => `scripts/test_case_${n}.py`).join('\0') };
      if (args.includes('--version')) return { status: 0, stdout: 'Python 3.12.0' };
      return result;
    },
    process: { env: {}, exit: (status: number) => { code = status; throw exitSignal; } },
    console: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) },
  };
  try { runInNewContext(source, context, { timeout: 1_000 }); }
  catch (error) { if (error !== exitSignal) throw error; }
  return { code, logs: logs.join('\n'), errors: errors.join('\n') };
}

function realPythonResult(exitAfterSuite = 0): ChildResult {
  const candidates = [{ command: 'python3', args: [] }, { command: 'python', args: [] }, { command: 'py', args: ['-3'] }];
  const python = candidates.find(({ command, args }) => spawnSync(command, [...args, '--version'], { timeout: 5_000 }).status === 0);
  if (!python) throw new Error('Python 门禁的回归测试需要现有 Python 解释器');
  const fixture = [
    'import atexit, os, unittest',
    'class Smoke(unittest.TestCase): pass',
    'for n in range(35): setattr(Smoke, "test_%02d" % n, lambda self: self.assertTrue(True))',
    ...(exitAfterSuite ? [`atexit.register(lambda: os._exit(${exitAfterSuite}))`] : []),
    'unittest.main()',
  ].join('\n');
  return spawnSync(python.command, [...python.args, '-I', '-B', '-c', fixture], { encoding: 'utf8', timeout: 5_000 });
}

describe('Python 门禁必须同时确认进程正常退出与用例真实通过', () => {
  it('真实 unittest 通过且正常退出 0 时整道门放行', () => {
    const result = realPythonResult();
    expect(result.status).toBe(0);
    const gate = runGate(result);
    expect(gate.code, gate.errors).toBe(0);
    expect(gate.logs).toContain('实际通过 350 例');
  });

  it('真实 unittest 输出 OK 后退出阶段以 23 结束时必须判红', () => {
    const result = realPythonResult(23);
    expect(result.status).toBe(23);
    expect(result.stderr).toMatch(/\nOK\s*$/);
    const gate = runGate(result);
    expect(gate.code).toBe(1);
    expect(gate.errors).toContain('退出码 23');
    expect(gate.logs).not.toContain('▶ 汇总:');
  });

  it('已有 OK 但被信号终止不能放行', () => {
    const gate = runGate({ ...valid, status: null, signal: 'SIGTERM' });
    expect(gate.code).toBe(1);
    expect(gate.errors).toContain('SIGTERM');
  });

  it('缺失退出码不能作为正常结束', () => {
    const gate = runGate({ ...valid, status: null });
    expect(gate.code).toBe(1);
    expect(gate.errors).toContain('未获得子进程退出码');
  });

  it('spawn.error 仍判红，即使其他字段像成功', () => {
    const gate = runGate({ ...valid, error: new Error('synthetic spawn failure') });
    expect(gate.code).toBe(1);
    expect(gate.errors).toContain('启动失败');
  });

  it.each([
    ['跳过', 'OK (skipped=1)'],
    ['预期失败', 'OK (expected failures=1)'],
    ['意外成功', 'FAILED (unexpected successes=1)'],
    ['失败断言', 'FAILED (failures=1)'],
    ['重复汇总', 'OK\nOK'],
    ['没有汇总', ''],
  ])('退出 0 仍不能掩盖%s', (_name, verdict) => {
    expect(runGate({ ...valid, stderr: `\nRan 35 tests in 0.001s\n\n${verdict}\n` }).code).toBe(1);
  });
});
