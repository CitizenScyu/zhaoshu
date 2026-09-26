import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// 客户端/服务端模块边界守卫（41-q402build）。
//
// 背景：db.ts 经 db-quota-guard.ts 静态 import 了 `node:async_hooks`。任何被客户端组件
// 静态（且非纯类型）引入闭包拉到 db.ts / db-quota-guard.ts 的路径，都会让 Turbopack 构建
// 报 “chunking context does not support external modules (request: node:async_hooks)”。
// 合并 825a4fd 时 ModelSettingsTab 值引入 app-settings（→db）就是这样弄挂了 next build。
//
// 用 `import 'server-only'` 阻断在本仓不可行：supported-sources.ts 特意用**动态** import('./db')
// 把 db 挡在静态客户端 bundle 外（见该文件顶部注释），而 supported-sources 又在客户端闭包内，
// server-only 会把这条本就安全的动态路径也判成违规。故改用静态扫描：只跟随**静态、含运行时
// 语义**的 import/export-from 边（跳过 `import type`、纯类型具名、以及 `import('...')` 动态导入），
// 从所有 'use client' 模块出发做闭包，断言不触达 db.ts / db-quota-guard.ts。

const SRC_ROOT = path.resolve(__dirname, '..'); // src/lib/*.test.ts -> src
const FORBIDDEN = ['lib/db.ts', 'lib/db-quota-guard.ts'].map((p) => path.join(SRC_ROOT, p));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// 去掉块注释与行注释，避免命中注释里的示例 import（如 supported-sources.ts 的 “不得静态 import './db'”）。
// 行注释用前导非冒号守卫，别误删字符串里的 `https://`。
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // 第三方包，不跟随
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`,
    path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

// 返回该文件的运行时引入 specifier（跳过纯类型与动态导入）。
function runtimeSpecs(code: string): string[] {
  let clean = stripComments(code);
  const specs: string[] = [];
  // 副作用导入 `import '...'`；先收集，再从正文剔除，免得干扰下面的 from 匹配。
  for (const m of clean.matchAll(/(?:^|\n)[ \t]*import[ \t]+['"]([^'"]+)['"][ \t]*;?/g)) specs.push(m[1]);
  clean = clean.replace(/(?:^|\n)[ \t]*import[ \t]+['"][^'"]+['"][ \t]*;?/g, '\n');
  // `import ... from '...'` / `export ... from '...'`（含跨行具名列表）。
  for (const m of clean.matchAll(/(?:^|\n)[ \t]*(?:import|export)\b([\s\S]*?)\bfrom[ \t]*['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    if (/^\s*type\b/.test(clause)) continue; // import type / export type ... 整条擦除
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      const parts = braced[1].split(',').map((s) => s.trim()).filter(Boolean);
      // 具名列表里全是 `type X` ⇒ 整体擦除；只要有一个值导入就算运行时边。
      if (parts.length > 0 && parts.every((p) => /^type\b/.test(p))) continue;
    }
    specs.push(m[2]);
  }
  return specs;
}

function isClientModule(code: string): boolean {
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(code);
}

describe('客户端组件不得静态触达服务端 db 模块', () => {
  const allFiles = walk(SRC_ROOT);
  const clientRoots = allFiles.filter((f) => isClientModule(readFileSync(f, 'utf8')));

  it('存在客户端入口，且包含 page.tsx 与 ModelSettingsTab', () => {
    expect(clientRoots.length).toBeGreaterThan(0);
    expect(clientRoots.some((f) => f.endsWith(path.join('app', 'page.tsx')))).toBe(true);
    expect(clientRoots.some((f) => f.endsWith(path.join('components', 'ModelSettingsTab.tsx')))).toBe(true);
  });

  it('从所有 use client 模块出发的运行时引入闭包不触达 db.ts / db-quota-guard.ts', () => {
    const visited = new Set<string>();
    const queue = [...clientRoots];
    // 记录抵达违规文件的最短路径，失败时便于定位（列出上一跳）。
    const via = new Map<string, string>();
    while (queue.length) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of runtimeSpecs(readFileSync(file, 'utf8'))) {
        const resolved = resolveSpec(spec, file);
        if (!resolved || visited.has(resolved)) continue;
        if (!via.has(resolved)) via.set(resolved, file);
        queue.push(resolved);
      }
    }
    const breached = FORBIDDEN.filter((f) => visited.has(f));
    const detail = breached.map((f) => `${path.relative(SRC_ROOT, f)} <= ${path.relative(SRC_ROOT, via.get(f) ?? '?')}`);
    expect(breached, `客户端闭包触达服务端模块：\n${detail.join('\n')}`).toEqual([]);
  });
});
