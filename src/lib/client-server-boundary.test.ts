import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

// 客户端/服务端模块边界守卫（41-q402build）。
//
// 背景：db.ts 经 db-quota-guard.ts 静态 import 了 `node:async_hooks`。任何被客户端组件
// 静态（且非纯类型）引入闭包拉到 db.ts / db-quota-guard.ts 的路径，都会让 Turbopack 构建
// 报 “chunking context does not support external modules (request: node:async_hooks)”。
// 合并 825a4fd 时 ModelSettingsTab 值引入 app-settings（→db）就是这样弄挂了 next build。
//
// 动态 import 仍由打包器解析，不能当作客户端/服务端隔离边界。
// 用 TypeScript AST 跟随运行时 import/export、动态 import 和 require；只跳过纯类型。
// 从所有 use client 入口遍历依赖，拒绝数据库与 Node 内置模块。

const SRC_ROOT = path.resolve(__dirname, '..'); // src/lib/*.test.ts -> src
const FORBIDDEN = ['lib/db.ts', 'lib/db-quota-guard.ts', 'lib/supported-sources-server.ts'].map((p) => path.join(SRC_ROOT, p));

// Node 内置模块名集合（含 `node:` 前缀写法与裸名写法）。
// 用 node:module 的 builtinModules 判定，别手写清单：漏一个名字就等于留一个放行口。
// 这里不处理 `node:test` 等带 `node:` 前缀但不在 builtinModules 裸表里的项——见 :crypto 早退。
const NODE_BUILTIN_NAMES = new Set<string>(builtinModules);

// 判断某个 specifier 是否是 Node 内置模块。
// - `node:xxx`：直接判前缀（builtinModules 里多数同时有裸名，但 `node:test` 等只有前缀写法）。
// - `xxx`：裸名，且命中 builtinModules（'fs'、'crypto'、'async_hooks' …）。
// - `xxx/yyy`：内置子路径（如 'fs/promises'、'stream/web'），取首段判定。
// 非内置的第三方包（react、next …）一律返回 false。
function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true; // node:crypto / node:fs / node:test …
  const head = spec.split('/')[0];
  return NODE_BUILTIN_NAMES.has(head);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
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

// AST 区分类型导入、动态导入和注释/字符串，避免正则漏过动态依赖。
function runtimeSpecs(code: string): string[] {
  const source = ts.createSourceFile('boundary.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly));
      if (!typesOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typesOnly = node.isTypeOnly || (clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every((item) => item.isTypeOnly));
      if (!typesOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && ts.isStringLiteralLike(node.arguments[0])) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

function isClientModule(code: string): boolean {
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(code);
}

describe('客户端组件不得触达服务端 db 模块', () => {
  const allFiles = walk(SRC_ROOT);
  const clientRoots = allFiles.filter((f) => isClientModule(readFileSync(f, 'utf8')));

  it('动态导入仍进入客户端依赖图，纯类型与注释不进入', () => {
    expect(runtimeSpecs(`
      import type { Sql } from './types-only';
      import { type Shape } from './also-types';
      export type { Entry } from './export-types';
      import DefaultValue, { type Other } from './runtime-default';
      export { type Shape, value } from './runtime-export';
      const load = () => import('./db');
      const withOptions = () => import('./dynamic-options', { with: { type: 'json' } });
      const required = require('node:async_hooks');
      // import('./comment-only')
      const example = "import('./string-only')";
      type Lazy = import('./type-query').Value;
    `)).toEqual(['./runtime-default', './runtime-export', './db', './dynamic-options', 'node:async_hooks']);
  });

  it('存在客户端入口，且包含 page.tsx 与 ModelSettingsTab', () => {
    expect(clientRoots.length).toBeGreaterThan(0);
    expect(clientRoots.some((f) => f.endsWith(path.join('app', 'page.tsx')))).toBe(true);
    expect(clientRoots.some((f) => f.endsWith(path.join('components', 'ModelSettingsTab.tsx')))).toBe(true);
  });

  it('从所有 use client 模块出发的运行时引入闭包不触达 db.ts / db-quota-guard.ts，且不引入任何 Node 内置模块', () => {
    const visited = new Set<string>();
    const queue = [...clientRoots];
    // 记录抵达违规文件的最短路径，失败时便于定位（列出上一跳）。
    const via = new Map<string, string>();
    // 记录每个客户端闭包内被引入的 Node 内置模块 → 引入它的文件（首个命中即可）。
    const builtinHits = new Map<string, string>();
    while (queue.length) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of runtimeSpecs(readFileSync(file, 'utf8'))) {
        if (isNodeBuiltin(spec)) {
          if (!builtinHits.has(spec)) builtinHits.set(spec, file);
          continue;
        }
        const resolved = resolveSpec(spec, file);
        if (!resolved || visited.has(resolved)) continue;
        if (!via.has(resolved)) via.set(resolved, file);
        queue.push(resolved);
      }
    }
    const breached = FORBIDDEN.filter((f) => visited.has(f));
    const detail = breached.map((f) => `${path.relative(SRC_ROOT, f)} <= ${path.relative(SRC_ROOT, via.get(f) ?? '?')}`);
    expect(breached, `客户端闭包触达服务端模块：\n${detail.join('\n')}`).toEqual([]);

    const builtinDetail = [...builtinHits].map(
      ([spec, file]) => `${spec} <= ${path.relative(SRC_ROOT, file)}`,
    );
    expect(
      builtinDetail,
      `'use client' 运行时闭包内不得出现 Node 内置模块（Turbopack 打包到浏览器会报 "chunking context does not support external modules"）：\n${builtinDetail.join('\n')}`,
    ).toEqual([]);
  });
});
