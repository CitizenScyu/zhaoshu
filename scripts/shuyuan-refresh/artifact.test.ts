import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// 打包产物必须能真跑:import 单文件、被判据无内联凭据。这里只做「可加载性」冒烟,
// 不触发网络/DB(不调 run())——真正跑刷新在 phoenix 上由 systemd oneshot 执行。
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const dist = resolve(repoRoot, 'shuyuan-refresh', 'dist', 'refresh-runner.mjs');

// dist/ 是 gitignored 的构建产物,干净 checkout/CI 上不存在。此文件的两条断言是
// 安全相关的(无内联凭据 + 单文件可加载),不该在 CI 里消失,故按需构建一次:
// esbuild 是 devDependency,CI 的 npm ci 会装;用 import.meta.url 推脚本绝对路径,
// 不依赖 cwd。构建失败即显式失败并打印原始 stderr(不静默通过)。
if (!existsSync(dist)) {
  const buildScript = resolve(repoRoot, 'scripts', 'build-shuyuan-refresh.mjs');
  const r = spawnSync(process.execPath, [buildScript], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      `产物缺失且按需构建失败(status=${r.status}):\n` +
      `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
}

describe('refresh-runner 产物', () => {
  it('grep 判据:无 postgres://|ghp_|github_pat_|sk- 字面量', () => {
    const text = readFileSync(dist, 'utf8');
    expect(/postgres:\/\/|ghp_|github_pat_|sk-/.test(text)).toBe(false);
  });

  it('产物是自包含 ESM:单文件可被 node 加载并执行(无 DATABASE_URL 时走失败路径)', async () => {
    // 产物无 DATABASE_URL 时会失败,但「失败」本身证明整包已加载、main() 已执行
    // (bundle 内所有依赖解析成功)。用 --dry-run 且刻意不给 DB env,避免触碰真库;
    // 无论本机能否连上游,失败前缀都必然出现,故判据与网络无关。
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r = spawnSync(process.execPath, [dist, '--dry-run'], { encoding: 'utf8', env });
    expect(r.stderr).toContain('shuyuan refresh runner failed:');
    expect(r.status).toBe(1);
  });
});