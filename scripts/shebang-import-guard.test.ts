// 被其它模块导入的 scripts/*.mjs 不得带 shebang（41-DBPROD N3）。
//
// 本机 core.autocrlf=true，检出后首行是 `#!/usr/bin/env node\r`：Node 原生导入没问题，但 vitest 的模块
// 转换管道会在导入该文件时报 `SyntaxError: Invalid or unexpected token`，导入它的测试文件整体红、0 用例执行
// （a5c1f73 在 migrate-auth-prod.mjs 上踩过）。入口脚本一律写作 `node scripts/x.mjs` 调用，不依赖 shebang；
// 仍带 shebang 的只能是没有任何模块导入的纯入口。这里按导入图检查，与工作区是 LF 还是 CRLF 无关。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = join(root, 'scripts');
const SCAN_DIRS = ['scripts', 'src', 'tests', 'runtime-download', 'shuyuan-refresh'];
const SOURCE_EXT = /\.(?:[cm]?js|tsx?)$/;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE_EXT.test(name)) yield path;
  }
}

function importedScripts() {
  const edges: { from: string; target: string }[] = [];
  for (const dir of SCAN_DIRS) {
    let files: string[];
    try { files = [...walk(join(root, dir))]; } catch { continue; }
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_SPEC)) {
        const target = resolve(dirname(file), match[1]);
        if (dirname(target) === scriptsDir) edges.push({ from: relative(root, file), target });
      }
    }
  }
  return edges;
}

it('被导入的 scripts/*.mjs 首行不是 shebang', () => {
  const edges = importedScripts();
  // 护栏自身要有牙：已知的导入边必须被扫到，否则正则失效时会「零违规」地假绿。
  const targets = new Set(edges.map((edge) => relative(root, edge.target).replaceAll('\\', '/')));
  for (const known of ['scripts/db-migration-lib.mjs', 'scripts/migrate-auth-prod.mjs', 'scripts/import_labels.mjs', 'scripts/genre_map.mjs']) {
    expect(targets, known).toContain(known);
  }
  const offenders = edges
    .filter((edge) => { try { return readFileSync(edge.target).subarray(0, 2).toString() === '#!'; } catch { return false; } })
    .map((edge) => `${relative(root, edge.target).replaceAll('\\', '/')} ← ${edge.from.replaceAll('\\', '/')}`);
  expect(offenders).toEqual([]);
});
