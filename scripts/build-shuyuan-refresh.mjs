#!/usr/bin/env node
// phoenix 书源刷新运行器打包脚本。
//
// 背景:上游 www.yckceo.com 从 Vercel 网络不可达(SNI 重置),refreshShuyuan 每轮走降级、
// 生产源池自 2026-09-15 冻结;phoenix 实测可达该上游。本脚本把仓库里**同一份**
// src/lib/shuyuan.ts 的 refreshShuyuan(含只读 dry-run)用 esbuild 打成自包含 ESM,
// 部署到 phoenix 定时跑,写同一个生产库。**不移植、不重写刷新语义**(由单测钉住)。
//
// 用法:node scripts/build-shuyuan-refresh.mjs
// 产出:shuyuan-refresh/dist/refresh-runner.mjs + .sha256(单文件,无内联凭据)
//
// 依赖策略:@neondatabase/serverless 打进产物(phoenix 无需 npm install),产物仍只在
// 运行时读 env DATABASE_URL。构建后自查产物不得含连接串/token 形态字面量。
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = join(repoRoot, 'shuyuan-refresh', 'dist');
const outFile = join(outDir, 'refresh-runner.mjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(repoRoot, 'scripts', 'shuyuan-refresh', 'entry.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  tsconfig: join(repoRoot, 'tsconfig.json'),
  logLevel: 'warning',
  // 压缩:一是产物更小,二是**剥离全部注释**——源码中文注释里含 "task-53"/"task-82"
  // 这类字样,裸 grep -cE "…|sk-" 会把 "ta**sk-**53" 误判成 OpenAI key 泄漏。
  // 剥离注释后产物自带判据即可归零,避免把注释误报成凭据。
  minify: true,
  legalComments: 'none',
  banner: {
    // 被打进来的 CJS 依赖(cheerio/domhandler/entities)在 ESM 里需要 require。
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

const text = readFileSync(outFile, 'utf8');
// 凭据红线(任务书判据):产物不得内联任何真实连接串 / GitHub / OpenAI key。
//
// 实测产物里出现 2 处 `postgresql://`,**都不匹配任务书的 `postgres://` 子串**,且逐条核实为
// @neondatabase/serverless 的非秘密文案/占位:错误提示 `postgresql://user:password@host.tld/dbname?option=value`
// 与连接串构造模板 `postgresql://${i.user}:${i.password}@...`。真实 DSN 的口令是长随机串,
// 故「真实 DSN」判据 = `postgresql://` 后跟「user:≥12 位口令@」(文档串口令 8 位,占位串是 ${,都不命中)。
const realCredentialPatterns = [
  ['postgres://', /postgres:\/\//],
  ['postgresql://user:<long-pass>@', /postgresql:\/\/[^@\s'"]*:[A-Za-z0-9_!@#$%^&*.\-]{12,}@/],
  ['ghp_', /ghp_/],
  ['github_pat_', /github_pat_/],
  ['sk-<key>', /sk-[A-Za-z0-9_-]{16,}/],
];
let dirty = false;
for (const [label, re] of realCredentialPatterns) {
  const count = (text.match(new RegExp(re.source, 'g')) || []).length;
  if (count > 0) { dirty = true; console.error(`产物含疑似真实凭据形态:${label} × ${count}`); }
}
if (dirty) {
  rmSync(outDir, { recursive: true, force: true });
  throw new Error('产物自查失败:疑似真实凭据,已删除产物');
}
// 任务书裸判据的实际命中数(应为 0;minify 已剥离源码注释)。
const cleanGrepCount = (text.match(/postgres:\/\/|ghp_|github_pat_|sk-/g) || []).length;
const pgAny = (text.match(/postgresql:\/\//g) || []).length;

const hash = createHash('sha256').update(readFileSync(outFile)).digest('hex');
writeFileSync(`${outFile}.sha256`, `${hash}  refresh-runner.mjs\n`, 'utf8');
if (!existsSync(outFile)) throw new Error('产物未生成');

console.log(JSON.stringify({
  outFile, sha256: hash, bytes: readFileSync(outFile).byteLength,
  cleanGrepCount, postgresqlAnyMatches: pgAny,
}, null, 2));