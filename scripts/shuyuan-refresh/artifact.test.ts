import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// 打包产物必须能真跑:import 单文件、被判据无内联凭据。这里只做「可加载性」冒烟,
// 不触发网络/DB(不调 run())——真正跑刷新在 phoenix 上由 systemd oneshot 执行。
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', '..', 'shuyuan-refresh', 'dist', 'refresh-runner.mjs');

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