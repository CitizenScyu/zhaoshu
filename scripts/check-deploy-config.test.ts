import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkDeployConfig, CROSS_FILE_BUDGETS, triggersPerDay } from './check-deploy-config.mjs';

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
  // 下面几组对应 CROSS_FILE_BUDGETS 的登记项：lib 里定义、由对应路由间接消耗的超时/预算常量。
  'src/lib/github.ts': 'const DISPATCH_TIMEOUT_MS = 10_000;\n',
  'src/app/api/download/route.ts': 'export const maxDuration = 60;\nexport async function POST() {}\n',
  'src/lib/reader-server.ts': 'const METADATA_TIMEOUT_MS = 15_000;\nconst TEXT_TIMEOUT_MS = 60_000;\n',
  'src/app/api/read/[id]/[resource]/route.ts': 'export const maxDuration = 120;\nexport async function GET() {}\n',
  'src/lib/source-reader.ts': 'export const SOFT_BUDGET_MS = 45_000;\nexport const SOURCE_PROBE_BUDGET_MS = 15_000;\n',
  'src/app/api/read/source/[resource]/route.ts': 'export const maxDuration = 60;\nexport async function GET() {}\n',
  'src/app/api/read/source-probe/route.ts': 'export const maxDuration = 25;\nexport async function GET() {}\n',
  'src/lib/llm.ts': 'export const MODEL_PROBE_TIMEOUT_MS = 30_000;\n',
  'src/app/api/admin/llm/route.ts': 'export const maxDuration = 60;\nexport async function PUT() {}\n',
  'src/lib/find-sse.ts': 'export const FIND_FETCH_TIMEOUT_MS = 290_000;\n',
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

  // Next 16.3.5 对同目录多个 route 文件不报错：Turbopack 按 read_dir 顺序后者覆盖（顺序未定义），
  // webpack 排序后后者覆盖。哪个生效静态无法确定，只能判红让人删掉多余的一个。
  it('cron 路由目录同时有 route.ts 与 route.js 判红（.ts 好、.js 坏也不放过）', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/download/reclaim/route.js': 'export const maxDuration = 30;\nexport async function POST() {}\n',
    }));
    expect(errors).toEqual([
      expect.stringMatching(/src\/app\/api\/download\/reclaim: 同一目录有多个 route 文件（route\.js、route\.ts）/),
      expect.stringMatching(/src\/app\/api\/download\/reclaim\/route\.js 没有导出 GET/),
    ]);
  });

  it('非 cron 路由目录有多个 route 文件同样判红', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/find/exact/route.tsx': GOOD_FILES['src/app/api/find/exact/route.ts'],
    }));
    expect(errors).toEqual([expect.stringMatching(/src\/app\/api\/find\/exact: 同一目录有多个 route 文件（route\.ts、route\.tsx）/)]);
  });

  it('cron 路由写成 route.tsx 能被找到（Next 默认 pageExtensions 含 tsx）', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/download/reclaim/route.ts': null,
      'src/app/api/download/reclaim/route.tsx': GOOD_FILES['src/app/api/download/reclaim/route.ts'],
    }));
    expect(errors).toEqual([]);
  });

  it('cron 路由只有 route.mjs 判红（.mjs 不在 Next 默认 pageExtensions 里，不是路由）', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/download/reclaim/route.ts': null,
      'src/app/api/download/reclaim/route.mjs': GOOD_FILES['src/app/api/download/reclaim/route.ts'],
    }));
    expect(errors).toEqual([expect.stringMatching(/path "\/api\/download\/reclaim" 找不到对应路由/)]);
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
    expect(errors).toEqual([
      expect.stringMatching(/MODEL_ROUTE_INTERNAL_BUDGET_MS = 285000ms.*≥ maxDuration 60s/),
      // 前端等流式结果的 290s 超时同样越过 60s（CROSS_FILE_BUDGETS 登记项）。
      expect.stringMatching(/FIND_FETCH_TIMEOUT_MS = 290000ms.*≥ maxDuration 60s/),
    ]);
  });

  it('把模型预算调到 300_000（≥ 295s 路由）判红', () => {
    const errors = checkDeployConfig(repo({ 'src/lib/deadline.ts': 'export const MODEL_ROUTE_INTERNAL_BUDGET_MS = 300_000;\n' }));
    expect(errors).toEqual([expect.stringMatching(/src\/app\/api\/find\/route\.ts: MODEL_ROUTE_INTERNAL_BUDGET_MS = 300000ms/)]);
  });

  it('引用模型预算却没声明 maxDuration 判红', () => {
    const errors = checkDeployConfig(repo({
      'src/app/api/find/route.ts': GOOD_FILES['src/app/api/find/route.ts'].replace('export const maxDuration = 295;\n', ''),
    }));
    expect(errors).toEqual([
      expect.stringMatching(/使用 MODEL_ROUTE_INTERNAL_BUDGET_MS 却没声明 maxDuration/),
      expect.stringMatching(/src\/app\/api\/find\/route\.ts: 找不到或未声明整数 maxDuration（CROSS_FILE_BUDGETS 登记了 FIND_FETCH_TIMEOUT_MS）/),
    ]);
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

  // 41-MS09B 盘点补登记：每项把 lib 常量调到恰好等于路由 maxDuration，必须判红。
  it.each([
    ['src/app/api/download/route.ts', 'src/lib/github.ts', 'DISPATCH_TIMEOUT_MS', 60],
    ['src/app/api/read/[id]/[resource]/route.ts', 'src/lib/reader-server.ts', 'TEXT_TIMEOUT_MS', 120],
    ['src/app/api/read/[id]/[resource]/route.ts', 'src/lib/reader-server.ts', 'METADATA_TIMEOUT_MS', 120],
    ['src/app/api/read/source/[resource]/route.ts', 'src/lib/source-reader.ts', 'SOFT_BUDGET_MS', 60],
    ['src/app/api/admin/llm/route.ts', 'src/lib/llm.ts', 'MODEL_PROBE_TIMEOUT_MS', 60],
    ['src/app/api/find/route.ts', 'src/lib/find-sse.ts', 'FIND_FETCH_TIMEOUT_MS', 295],
    ['src/app/api/read/source-probe/route.ts', 'src/lib/source-reader.ts', 'SOURCE_PROBE_BUDGET_MS', 25],
  ])('%s 间接消耗的 %s 里的 %s 调到 ≥ maxDuration %is 判红', (route, file, name, seconds) => {
    const source = GOOD_FILES[file].replace(new RegExp(`(const ${name} = )[\\d_]+`), `$1${seconds * 1000}`);
    expect(source).not.toBe(GOOD_FILES[file]);
    const errors = checkDeployConfig(repo({ [file]: source }));
    expect(errors).toEqual([expect.stringContaining(`${route}: ${name} = ${seconds * 1000}ms（${file}）≥ maxDuration ${seconds}s`)]);
  });

  it('登记表里每一项在最小样例仓库里都真的被检查（调到 ≥ maxDuration 必红）', () => {
    for (const { route, file, name } of CROSS_FILE_BUDGETS) {
      const seconds = Number(GOOD_FILES[route].match(/maxDuration = (\d+)/)?.[1]);
      const source = GOOD_FILES[file].replace(new RegExp(`(const ${name} = )[\\d_]+`), `$1${seconds * 1000}`);
      expect(source, `${file} 里找不到 ${name}`).not.toBe(GOOD_FILES[file]);
      expect(checkDeployConfig(repo({ [file]: source })), `${name}`).toEqual([expect.stringContaining(`${route}: ${name} = `)]);
    }
  });
});

describe('check-deploy-config：next.config', () => {
  it('typescript.ignoreBuildErrors: true 判红', () => {
    const errors = checkDeployConfig(repo({
      'next.config.ts': 'const nextConfig = { typescript: { ignoreBuildErrors: true } };\nexport default nextConfig;\n',
    }));
    expect(errors).toEqual([expect.stringMatching(/ignoreBuildErrors = true/)]);
  });

  const withNextConfig = (source: string) => checkDeployConfig(repo({ 'next.config.ts': source }));

  it.each([
    ['行注释', '// 别写 typescript: { ignoreBuildErrors: true }\nconst nextConfig = {};\nexport default nextConfig;\n'],
    ['块注释', '/* ignoreBuildErrors: true 会关掉类型门 */\nconst nextConfig = {};\nexport default nextConfig;\n'],
    ['字符串', 'const note = "ignoreBuildErrors: true";\nconst nextConfig = {};\nexport default nextConfig;\n'],
    ['模板字符串', 'const note = `typescript: { ignoreBuildErrors: true }`;\nconst nextConfig = {};\nexport default nextConfig;\n'],
    ['显式 false', 'const nextConfig = { typescript: { ignoreBuildErrors: false } };\nexport default nextConfig;\n'],
  ])('%s里出现 ignoreBuildErrors: true 不误报', (_label, source) => {
    expect(withNextConfig(source)).toEqual([]);
  });

  it.each([
    ['引号键', "const nextConfig = { typescript: { 'ignoreBuildErrors': true } };\nexport default nextConfig;\n"],
    ['属性赋值', 'const nextConfig: any = { typescript: {} };\nnextConfig.typescript.ignoreBuildErrors = true;\nexport default nextConfig;\n'],
    ['as 断言', 'const nextConfig = { typescript: { ignoreBuildErrors: true as boolean } };\nexport default nextConfig;\n'],
  ])('%s写法的 ignoreBuildErrors: true 判红', (_label, source) => {
    expect(withNextConfig(source)).toEqual([expect.stringMatching(/ignoreBuildErrors = true/)]);
  });

  it('ignoreBuildErrors 取非字面量（如环境变量）判红（fail-closed，构建时可能为 true）', () => {
    const errors = withNextConfig(
      "const nextConfig = { typescript: { ignoreBuildErrors: process.env.SKIP_TYPES === '1' } };\nexport default nextConfig;\n",
    );
    expect(errors).toEqual([expect.stringMatching(/ignoreBuildErrors 不是字面量 false/)]);
  });
});
