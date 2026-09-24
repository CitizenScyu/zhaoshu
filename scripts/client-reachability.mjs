// 客户端可达性判定(供 eslint.config.mjs 的浏览器基线规则使用)。
//
// 本仓的客户端组件(`'use client'`)与纯服务端 lib 混在 src/lib 下,按目录分不出
// 「会进浏览器 bundle 的代码」。这里用 import 图算:从 `'use client'` 边界出发做正向
// BFS,只走**运行时**边——type-only 导入会被编译器擦除,不算边;动态 import()/require()
// 算边(bundler 会另切 chunk)。
//
// 用法:`node scripts/client-reachability.mjs` 打印可达文件清单;eslint 配置 import
// `clientReachableFiles()` 拿同一份判定,规则与判定永远同源。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'src';

function listSourceFiles() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(path.relative(repoRoot, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(repoRoot, SRC));
  return files;
}

/** `@/x` → `src/x`;`./x` → 相对解析。只解析仓内文件,裸包名一律返回 null。 */
export function resolveLocal(from, spec, fileSet) {
  if (!spec) return null;
  let p;
  if (spec.startsWith('@/')) p = `${SRC}/${spec.slice(2)}`;
  else if (spec.startsWith('.')) p = path.posix.join(path.posix.dirname(from), spec);
  else return null;
  for (const candidate of [`${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`, p]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/** 一个文件的运行时本地依赖。type-only 声明被跳过(擦除后不进 bundle)。 */
export function runtimeEdges(file, fileSet) {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = [];
  const add = (spec) => {
    const target = resolveLocal(file, spec, fileSet);
    if (target) out.push(target);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const clause = node.importClause;
      const wholeStatementTypeOnly = Boolean(clause && clause.isTypeOnly);
      const allNamedTypeOnly = Boolean(
        clause
        && !clause.name
        && clause.namedBindings
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((el) => el.isTypeOnly),
      );
      if (!wholeStatementTypeOnly && !allNamedTypeOnly
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isClientBoundary(file) {
  const head = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n').slice(0, 3).join('\n');
  return /^['"]use client['"]/m.test(head);
}

/** 会进入客户端 bundle 的仓内文件(相对路径,posix 分隔)。 */
export function clientReachableFiles() {
  const files = listSourceFiles();
  const fileSet = new Set(files);
  const forward = new Map(files.map((f) => [f, runtimeEdges(f, fileSet)]));
  const seen = new Set();
  for (const boundary of files.filter(isClientBoundary)) {
    if (seen.has(boundary)) continue;
    const queue = [boundary];
    while (queue.length) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const dep of forward.get(current) ?? []) if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = clientReachableFiles();
  for (const f of list) console.log(f);
  console.log(`\n${list.length} client-reachable files`);
}
