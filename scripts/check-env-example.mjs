import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py)$/;
const ENV_READ = /\bprocess\.env\.([A-Z][A-Z0-9_]*)|\bos\.environ(?:\.get\(|\[)\s*['"]([A-Z][A-Z0-9_]*)['"]/g;

export function checkEnvExample(root) {
  const example = readFileSync(join(root, '.env.local.example'), 'utf8');
  const documented = new Set([...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]));
  const missing = new Map();
  function scan(path) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.isFile() && CODE_EXTENSIONS.test(entry.name)) {
        const text = readFileSync(full, 'utf8');
        for (const match of text.matchAll(ENV_READ)) {
          const key = match[1] ?? match[2];
          if (!documented.has(key) && !missing.has(key)) missing.set(key, relative(root, full));
        }
      }
    }
  }
  for (const directory of ['src', 'scripts', 'runtime-download', 'shuyuan-refresh']) scan(join(root, directory));
  for (const config of ['next.config.ts', 'next.config.mjs', 'next.config.js']) {
    const path = join(root, config);
    if (existsSync(path)) {
      for (const match of readFileSync(path, 'utf8').matchAll(ENV_READ)) {
        const key = match[1] ?? match[2];
        if (!documented.has(key) && !missing.has(key)) missing.set(key, config);
      }
    }
  }
  return [...missing].sort(([left], [right]) => left.localeCompare(right)).map(([key, path]) =>
    `.env.local.example: 缺少 ${key}（读取于 ${path}）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkEnvExample(resolve(fileURLToPath(new URL('..', import.meta.url))));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log('✔ 环境变量样例覆盖代码读取的键');
}
