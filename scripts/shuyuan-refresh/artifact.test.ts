import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

// 打包产物必须能真跑:import 单文件、被判据无内联凭据。这里只做「可加载性」冒烟,
// 不触发网络/DB(不调 run())——真正跑刷新在 phoenix 上由 systemd oneshot 执行。
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const dist = resolve(repoRoot, 'shuyuan-refresh', 'dist', 'refresh-runner.mjs');

// 子进程环境隔离(53 验收要求):共享最小系统环境白名单,不展开 process.env——
// NODE_OPTIONS/NODE_PRELOAD 等注入面与应用配置(env 里的 *.env 注入键)一概不继承。
// Windows 上 node 仍需 SystemRoot/ComSpec 等基础键才能 spawn;PATH 保留以找到系统
// 工具,但产物是单文件 bundle,不依赖 PATH 里的任何 node_modules。
// 定义须先于下方按需构建分支(冷启动时构建 spawn 就要用它,顺序反了会 TDZ)。
const MINIMAL_ENV_KEYS = ['SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH',
  'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERPROFILE', 'OS', 'NUMBER_OF_PROCESSORS'] as const;
function minimalEnv(): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// dist/ 是 gitignored 的构建产物,干净 checkout/CI 上不存在。此文件的两条断言是
// 安全相关的(无内联凭据 + 单文件可加载),不该在 CI 里消失,故按需构建一次:
// esbuild 是 devDependency,CI 的 npm ci 会装;用 import.meta.url 推脚本绝对路径,
// 不依赖 cwd。构建失败即显式失败并打印原始 stderr(不静默通过)。
// 构建与干跑共用 minimalEnv;构建 spawn 亦有有限超时(esbuild 真挂死时不让测试
// 无限期阻塞——testTimeout 打不断同步子进程)。
if (!existsSync(dist)) {
  const buildScript = resolve(repoRoot, 'scripts', 'build-shuyuan-refresh.mjs');
  const r = spawnSync(process.execPath, [buildScript],
    { encoding: 'utf8', env: minimalEnv(), timeout: 120_000 });
  if (r.status !== 0) {
    throw new Error(
      `产物缺失且按需构建失败(status=${r.status}${r.signal ? `, signal=${r.signal}` : ''}):\n` +
      `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
}

describe('refresh-runner 产物', () => {
  it('grep 判据:无 postgres://|ghp_|github_pat_|sk- 字面量', () => {
    const text = readFileSync(dist, 'utf8');
    expect(/postgres:\/\/|ghp_|github_pat_|sk-/.test(text)).toBe(false);
  });

  it('产物是自包含 ESM:单文件可被 node 加载并执行(隔离网络,失败路径确定性触发)', async () => {
    // 产物跑失败即证明整包已加载、main() 已执行(bundle 内所有依赖解析成功)。
    // 用 --dry-run 且刻意不给 DB env,避免触碰真库;fetch 用同目录 preload 夹具
    // (artifact-fetch-fail.preload.mjs)替换为立即抛 TypeError('fetch failed')的桩——
    // 原版「不拦截网络、赌上游不可达」在慢失败网络下 >5s 撞 testTimeout(环境敏感红)。
    // 桩注入后不实际外呼任何地址,失败前缀与退出码确定性出现。
    // 环境用 minimalEnv 白名单:子进程不继承 NODE_OPTIONS/应用配置(53 验收要求)。
    const { spawnSync } = await import('node:child_process');
    const preload = pathToFileURL(resolve(here, 'artifact-fetch-fail.preload.mjs')).href;
    // spawnSync 有限超时:testTimeout 打不断同步子进程,真挂死时由此兜底(桩注入下
    // 实测 ~350ms,30s 只是不会触发的保险丝)。
    const r = spawnSync(process.execPath, ['--import', preload, dist, '--dry-run'],
      { encoding: 'utf8', env: minimalEnv(), timeout: 30_000 });
    expect(r.stderr).toContain('shuyuan refresh runner failed: fetch failed');
    expect(r.status).toBe(1);
  });

  it('41-poolimpl --pool-artifact:缺 SHUYUAN_POOL_ARTIFACT_PATH 即失败退 1,只报键名(不碰库)', () => {
    const r = spawnSync(process.execPath, [dist, '--pool-artifact'],
      { encoding: 'utf8', env: minimalEnv(), timeout: 30_000 });
    expect(r.stderr).toContain('shuyuan refresh runner failed: 缺少 env SHUYUAN_POOL_ARTIFACT_PATH');
    expect(r.status).toBe(1);
  });

  it('admrunner42 --admission:缺 DATABASE_URL 即失败退 1,只报键名(不回显值、不碰库)', () => {
    const r = spawnSync(process.execPath, [dist, '--admission'],
      { encoding: 'utf8', env: minimalEnv(), timeout: 30_000 });
    // getSql 只抛键名「DATABASE_URL is not set」,不回显任何连接串。
    expect(r.stderr).toContain('shuyuan refresh runner failed: DATABASE_URL is not set');
    expect(/postgres:\/\//.test(r.stderr)).toBe(false);
    expect(r.status).toBe(1);
  });
});