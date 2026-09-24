import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkDeployConfig, triggersPerDay } from './check-deploy-config.mjs';

// 部署配置门禁（MS-09）的反例测试：护栏本身必须有「坏配置一定红」的用例，
// 否则它会像当年没激活的 pre-push 一样静默失效而没人知道。
// 每个用例在临时目录里搭一个最小仓库，只改一处制造违规；不触网、不读 .env*。

const GOOD_FILES: Record<string, string> = {
  'vercel.json': JSON.stringify({
    crons: [
      { path: '/api/shuyuan', schedule: '0 2 * * *' },
      { path: '/api/download/reclaim', schedule: '0 21 * * *' },
    ],
  }),
  'src/lib/deadline.ts': 'export const MODEL_ROUTE_INTERNAL_BUDGET_MS = 285_000;\n',
  'src/lib/shuyuan.ts': 'export const REFRESH_BUDGET_MS = 180_000;\n',
  'src/app/api/shuyuan/route.ts': 'export const maxDuration = 295;\nexport async function GET() {}\n',
  'src/app/api/download/reclaim/route.ts': 'export const maxDuration = 30;\nexport async function GET() {}\n',
  'src/app/api/find/route.ts':
    "import { MODEL_ROUTE_INTERNAL_BUDGET_MS } from '@/lib/deadline';\nexport const maxDuration = 295;\n" +
    'export async function POST() { return MODEL_ROUTE_INTERNAL_BUDGET_MS; }\n',
  'src/app/api/find/exact/route.ts':
    'export const maxDuration = 30;\nconst EXACT_BUDGET_MS = 25_000;\nexport async function GET() { return EXACT_BUDGET_MS; }\n',
  'next.config.ts': 'const nextConfig = {};\nexport default nextConfig;\n',
};

const roots: string[] = [];

function repo(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'deploy-config-'));
  roots.push(root);
  for (const [rel, content] of Object.entries({ ...GOOD_FILES, ...overrides })) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function withCrons(crons: unknown[]): string {
  return JSON.stringify({ crons });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-deploy-config：真实配置', () => {
  it('当前仓库配置通过（零违规）', () => {
    expect(checkDeployConfig(process.cwd())).toEqual([]);
  });

  it('命令行对当前仓库退出 0，并打印通过信息（不是静默绿）', () => {
    const run = spawnSync(process.execPath, ['scripts/check-deploy-config.mjs'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('✔ check-deploy-config');
  });

  it('最小合法样例仓库通过（下面每个反例都只改它一处）', () => {
    expect(checkDeployConfig(repo())).toEqual([]);
  });
});

describe('check-deploy-config：cron 频率与解析（Hobby 每条每天最多一次）', () => {
  it.each([
    ['0 2 * * *', 1],
    ['30 21 * * 1-5', 1],
    ['0 2,8,14,20 * * *', 4],
    ['*/10 * * * *', 144],
    ['0 */6 * * *', 4],
    ['0,30 3 * * *', 2],
  ])('"%s" 每天触发 %i 次', (schedule, perDay) => {
    expect(triggersPerDay(schedule)).toBe(perDay);
  });

  it.each(['0 2,8,14,20 * * *', '*/10 * * * *', '0 0-23 * * *'])('坏样例 "%s" 判红', (schedule) => {
    const errors = checkDeployConfig(repo({ 'vercel.json': withCrons([{ path: '/api/shuyuan', schedule }]) }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/超过 Hobby 上限 1 次\/日/);
  });

  it.each(['@daily', '0 2 * *', '60 2 * * *', '0 2 32 * *', '0 2 * JAN *', 'a b c d e'])(
    '无法解析的 "%s" 判红（fail-closed，不静默放过）',
    (schedule) => {
      const errors = checkDeployConfig(repo({ 'vercel.json': withCrons([{ path: '/api/shuyuan', schedule }]) }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/无法按 5 段 crontab 解析/);
    },
  );
});

describe('check-deploy-config：vercel.json 结构', () => {
  it('非法 JSON 判红', () => {
    expect(checkDeployConfig(repo({ 'vercel.json': '{ "crons": [ }' }))[0]).toMatch(/不是合法 JSON/);
  });

  it('vercel.json 缺失判红', () => {
    expect(checkDeployConfig(repo({ 'vercel.json': null }))[0]).toMatch(/文件不存在/);
  });

  it('crons 不是数组判红', () => {
    expect(checkDeployConfig(repo({ 'vercel.json': '{"crons":{}}' }))[0]).toMatch(/crons 必须是数组/);
  });

  it('cron 缺 schedule 判红', () => {
    const errors = checkDeployConfig(repo({ 'vercel.json': withCrons([{ path: '/api/shuyuan' }]) }));
    expect(errors[0]).toMatch(/必须是 \{ path: string, schedule: string \}/);
  });

  it('cron 条数超过 100 判红', () => {
    const crons = Array.from({ length: 101 }, () => ({ path: '/api/shuyuan', schedule: '0 2 * * *' }));
    expect(checkDeployConfig(repo({ 'vercel.json': withCrons(crons) }))).toEqual([
      expect.stringMatching(/共 101 条 cron，超过每项目上限 100 条/),
    ]);
  });
});

describe('check-deploy-config：cron 路由存在且导出 GET', () => {
  it('cron 指向不存在的路由判红（部署成功但每天静默 404）', () => {
    const errors = checkDeployConfig(repo({ 'vercel.json': withCrons([{ path: '/api/shuyuan-old', schedule: '0 2 * * *' }]) }));
    expect(errors).toEqual([expect.stringMatching(/找不到对应路由.*src\/app\/api\/shuyuan-old\/route\.ts/)]);
  });

  it('cron 路由只导出 POST 判红（Vercel cron 以 GET 调用）', () => {
    const errors = checkDeployConfig(repo({ 'src/app/api/download/reclaim/route.ts': 'export const maxDuration = 30;\nexport async function POST() {}\n' }));
    expect(errors).toEqual([expect.stringMatching(/没有导出 GET/)]);
  });

  it('cron path 不以 / 开头判红', () => {
    const errors = checkDeployConfig(repo({ 'vercel.json': withCrons([{ path: 'api/shuyuan', schedule: '0 2 * * *' }]) }));
    expect(errors).toEqual([expect.stringMatching(/必须以 \/ 开头/)]);
  });
});

describe('check-deploy-config：函数时限', () => {
  it('maxDuration = 400 判红（超 Hobby Fluid Compute 300s 上限）', () => {
    const errors = checkDeployConfig(repo({ 'src/app/api/download/reclaim/route.ts': 'export const maxDuration = 400;\nexport async function GET() {}\n' }));
    expect(errors).toEqual([expect.stringMatching(/maxDuration = 400s，超出 Hobby Fluid Compute 单函数上限 1–300s/)]);
  });

  it('maxDuration 不是整数字面量判红', () => {
    const errors = checkDeployConfig(repo({ 'src/app/api/download/reclaim/route.ts': 'const LIMIT = 30;\nexport const maxDuration = LIMIT;\nexport async function GET() {}\n' }));
    expect(errors).toEqual([expect.stringMatching(/maxDuration = LIMIT 不是整数字面量/)]);
  });

  it('引用 MODEL_ROUTE_INTERNAL_BUDGET_MS 的路由把 maxDuration 降到 60 判红', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/find/route.ts': GOOD_FILES['src/app/api/find/route.ts'].replace('maxDuration = 295', 'maxDuration = 60'),
    }));
    expect(errors).toEqual([expect.stringMatching(/MODEL_ROUTE_INTERNAL_BUDGET_MS = 285000ms.*≥ maxDuration 60s/)]);
  });

  it('把模型预算调到 300_000（≥ 295s 路由）判红', () => {
    const errors = checkDeployConfig(repo({ 'src/lib/deadline.ts': 'export const MODEL_ROUTE_INTERNAL_BUDGET_MS = 300_000;\n' }));
    expect(errors).toEqual([expect.stringMatching(/src\/app\/api\/find\/route\.ts: MODEL_ROUTE_INTERNAL_BUDGET_MS = 300000ms/)]);
  });

  it('引用模型预算却没声明 maxDuration 判红', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/find/route.ts': GOOD_FILES['src/app/api/find/route.ts'].replace('export const maxDuration = 295;\n', ''),
    }));
    expect(errors).toEqual([expect.stringMatching(/使用 MODEL_ROUTE_INTERNAL_BUDGET_MS 却没声明 maxDuration/)]);
  });

  it('路由内预算常量 EXACT_BUDGET_MS = 30_000 等于 maxDuration 30s 判红', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/find/exact/route.ts': GOOD_FILES['src/app/api/find/exact/route.ts'].replace('25_000', '30_000'),
    }));
    expect(errors).toEqual([expect.stringMatching(/EXACT_BUDGET_MS = 30000ms.*≥ maxDuration 30s/)]);
  });

  it('跨文件登记的 REFRESH_BUDGET_MS 超过 /api/shuyuan 的 maxDuration 判红', () => {
    const errors = checkDeployConfig(repo({ 'src/lib/shuyuan.ts': 'export const REFRESH_BUDGET_MS = 295_000;\n' }));
    expect(errors).toEqual([expect.stringMatching(/src\/app\/api\/shuyuan\/route\.ts: REFRESH_BUDGET_MS = 295000ms/)]);
  });

  it('跨文件登记的常量被改成非字面量判红（不静默跳过）', () => {
    const errors = checkDeployConfig(repo({ 'src/lib/shuyuan.ts': 'export const REFRESH_BUDGET_MS = 3 * 60_000;\n' }));
    expect(errors).toEqual([expect.stringMatching(/读不到 REFRESH_BUDGET_MS 的数字字面量/)]);
  });
});

describe('check-deploy-config：next.config', () => {
  it('typescript.ignoreBuildErrors: true 判红', () => {
    const errors = checkDeployConfig(repo({
      'next.config.ts': 'const nextConfig = { typescript: { ignoreBuildErrors: true } };\nexport default nextConfig;\n',
    }));
    expect(errors).toEqual([expect.stringMatching(/ignoreBuildErrors = true/)]);
  });
});
