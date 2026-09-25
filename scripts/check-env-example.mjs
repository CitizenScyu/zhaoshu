import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py)$/;

// env 键的读取写法有六类，合成一条正则、按捕获组区分（见每行注释）。KEY 一律要求
// 全大写下划线（[A-Z][A-Z0-9_]*），这本身就滤掉了绝大多数「同名非环境对象」的属性。
//
// 判定边界（避免把无关对象的点式 env 误当环境变量）：
//   · 组 3–6 只认「独立标识符 env」——前面用 (?<![\w.$]) 挡掉 `process.env.<K>`、
//     `x.env.<K>`、`child_env['<K>']` 这类属性访问 / 派生变量；纯 process.env 由组 1 负责。
//   · 组 3/4（点式/方括号）额外排除「写入」——`env.<K> = …`（赋值，非 == / => / ===）
//     与 `delete env.<K>`：这类键是代码自己塞给子进程的（如 PYTHONIOENCODING），不由
//     部署者提供，列进样例反而误导。比较（`env.<K> === '0'`）仍算读取，不排除。
const ENV_READ = new RegExp([
  String.raw`\bprocess\.env\.([A-Z][A-Z0-9_]*)`,                       // 1: process.env.<K>
  String.raw`\bos\.environ(?:\.get\(|\[)\s*['"]([A-Z][A-Z0-9_]*)['"]`, // 2: os.environ.get('<K>') / os.environ['<K>']（Python）
  String.raw`(?<![\w.$])env\.([A-Z][A-Z0-9_]*)`,                       // 3: env.<K>（形参式对象，点式）
  String.raw`(?<![\w.$])env\[\s*['"]([A-Z][A-Z0-9_]*)['"]`,           // 4: env['<K>'] / env["<K>"]（JS 与 Python 字典通用）
  String.raw`(?<![\w.$])env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]`,      // 5: env.get('<K>')（Python 字典）
  String.raw`\{([^{}]*)\}\s*=\s*env(?![\w.$])`,                       // 6: 解构 const { <K>, <K2> } = env
].join('|'), 'g');

// 从解构体 `<K>, <ORIG>: local, <DEF> = '…'` 里取环境键名：每个逗号段的首个大写标识符
// 即环境侧键（重命名取冒号左边、带默认值取等号左边）；小写项是普通解构，忽略。
function destructuredKeys(body) {
  return body.split(',').map(part => part.trim().match(/^([A-Z][A-Z0-9_]*)/)?.[1]).filter(Boolean);
}

export function checkEnvExample(root) {
  const example = readFileSync(join(root, '.env.local.example'), 'utf8');
  const documented = new Set([...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]));
  const missing = new Map();
  function record(key, where) {
    if (key && !documented.has(key) && !missing.has(key)) missing.set(key, where);
  }
  function collect(text, where) {
    for (const match of text.matchAll(ENV_READ)) {
      if (match[6] !== undefined) { for (const key of destructuredKeys(match[6])) record(key, where); continue; }
      // 组 3/4 的写入排除：紧跟单个 `=`（非 ==/=>/===）算赋值；前缀 `delete ` 算删除。
      if (match[3] !== undefined || match[4] !== undefined) {
        const after = text.slice(match.index + match[0].length);
        if (/^\s*=(?![=>])/.test(after)) continue;
        if (/\bdelete\s+$/.test(text.slice(Math.max(0, match.index - 8), match.index))) continue;
      }
      record(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], where);
    }
  }
  function scan(path) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory() && !['dist', 'node_modules', '.next'].includes(entry.name)) scan(full);
      else if (entry.isFile() && CODE_EXTENSIONS.test(entry.name)) collect(readFileSync(full, 'utf8'), relative(root, full).split(sep).join('/'));
    }
  }
  for (const directory of ['src', 'scripts', 'runtime-download', 'shuyuan-refresh']) scan(join(root, directory));
  for (const config of ['next.config.ts', 'next.config.mjs', 'next.config.js']) {
    const path = join(root, config);
    if (existsSync(path)) collect(readFileSync(path, 'utf8'), config);
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
