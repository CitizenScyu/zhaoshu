// 部署配置离线门禁（review-42 MS-09）：只读本仓文件做静态校验，不联网、不读 .env*。
//
// 为什么需要：typecheck / lint / test / build 四道门全部作用在源码上，部署配置错了照样全绿。
// 本仓已有的真实事故与风险面：
//   - vercel.json cron 每天多次触发 → Vercel Hobby 在部署前校验阶段拒绝整次部署，且不留部署记录
//     （b89f575、6f157f5/c26c3b8 两次上 master；频率校验另见 src/lib/vercel-cron.test.ts，与本脚本共用解析）；
//   - cron 指向的路由被改名/删除或不再导出 GET → 部署成功，但 cron 每天静默 404/405；
//   - maxDuration 超 Hobby Fluid Compute 单函数上限 300s（README「注意：Hobby 档…」一段）→ 超出计划档位；
//   - 路由内部预算常量 ≥ 该路由 maxDuration → 平台先把函数杀掉，内部 deadline 的优雅收尾（写回、
//     DEADLINE_EXCEEDED 响应）永远轮不到执行；
//   - next.config 打开 typescript.ignoreBuildErrors → Vercel 构建这最后一道类型门被关掉。
// 安全响应头已由 src/next.config.test.ts 钉住，这里不重复。
//
// 平台约束写成下面的具名常量：升级计划档位时改这里，改动会出现在 diff 里被审到。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Hobby：每条 cron 每天最多触发一次（违反即整次部署被拒）。 */
export const MAX_CRON_RUNS_PER_DAY = 1;
/** Hobby 每项目 cron 条数上限（Vercel 文档 100；b89f575 提交信息的「2 条」是误传，见 vercel-cron.test.ts）。 */
export const MAX_CRON_JOBS = 100;
/** Hobby Fluid Compute 单函数时限上限（秒），出处 README 部署一节。 */
export const MAX_FUNCTION_SECONDS = 300;
/**
 * 路由文件扩展名 = Next 16.3.5 默认 pageExtensions（node_modules/next/dist/server/config-shared.js）。
 * `.mjs` 不在其中，`route.mjs` 不是路由；next.config 若改 pageExtensions，这里要同步。
 */
export const ROUTE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];

/**
 * 路由以外文件里定义、但由该路由消耗的超时/预算常量（常量须是顶层数字字面量，否则判红）。路由文件内直接定义的
 * `*_BUDGET_MS` / `*_TIMEOUT_MS` 与引用 MODEL_ROUTE_INTERNAL_BUDGET_MS 的路由会被自动发现，不必登记。
 * 只登记「本身就能把一次调用拖到这么久」的常量；已被请求 deadline 夹住的子超时（llm.ts 的 chatRobust 上限、
 * shuyuan.ts 刷新内的单次探测等）不登记。盘点口径与未登记理由见 41-MS09B 报告。
 */
export const CROSS_FILE_BUDGETS = [
  // refreshShuyuan() 整份刷新共用这一预算，cron 与 owner 手动刷新都走 GET /api/shuyuan。
  { route: 'src/app/api/shuyuan/route.ts', file: 'src/lib/shuyuan.ts', name: 'REFRESH_BUDGET_MS' },
  // triggerDownloadWorkflow() 的 dispatch 请求实际用的是它；同文件导出的 GITHUB_TIMEOUT_MS 目前没有任何调用方。
  { route: 'src/app/api/download/route.ts', file: 'src/lib/github.ts', name: 'DISPATCH_TIMEOUT_MS' },
  // githubFetch() 取正文 / 取元数据的单次请求超时，readBookPart / readBookIndex 都经过它。
  { route: 'src/app/api/read/[id]/[resource]/route.ts', file: 'src/lib/reader-server.ts', name: 'TEXT_TIMEOUT_MS' },
  { route: 'src/app/api/read/[id]/[resource]/route.ts', file: 'src/lib/reader-server.ts', name: 'METADATA_TIMEOUT_MS' },
  // 在线换源阅读的软预算（resolveSourceBook / readSourceChapter / 换源都按它止损）。
  { route: 'src/app/api/read/source/[resource]/route.ts', file: 'src/lib/source-reader.ts', name: 'SOFT_BUDGET_MS' },
  // probeModel() 两次尝试共享的墙钟上限，owner 保存模型设置时同步探测。
  { route: 'src/app/api/admin/llm/route.ts', file: 'src/lib/llm.ts', name: 'MODEL_PROBE_TIMEOUT_MS' },
  // 前端等 /api/find 流式结果的超时：须短于路由上限，否则平台先掐断连接，前端的超时提示轮不到出现。
  { route: 'src/app/api/find/route.ts', file: 'src/lib/find-sse.ts', name: 'FIND_FETCH_TIMEOUT_MS' },
  // 41-fanout：单源 probe 的内部墙钟预算，只由 /api/read/source-probe 消耗（路由内另有 20s 总预算）。
  { route: 'src/app/api/read/source-probe/route.ts', file: 'src/lib/source-reader.ts', name: 'SOURCE_PROBE_BUDGET_MS' },
];

const MODEL_BUDGET = { file: 'src/lib/deadline.ts', name: 'MODEL_ROUTE_INTERNAL_BUDGET_MS' };

/**
 * 展开单个 crontab 字段，返回命中的取值个数；非法写法抛错（fail-closed）。
 * @param {string} field @param {number} lo @param {number} hi @returns {number}
 */
export function fieldCardinality(field, lo, hi) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`非法步进: ${part}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`非法步进: ${part}`);
    let start = lo;
    let end = hi;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      if (bounds.length > 2 || bounds.some((b) => !/^\d+$/.test(b))) throw new Error(`非法取值: ${part}`);
      start = Number(bounds[0]);
      end = bounds.length > 1 ? Number(bounds[1]) : start;
    }
    if (start < lo || end > hi || start > end) throw new Error(`越界取值: ${part}`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size;
}

/**
 * 该 cron 表达式一天内触发几次 = 分钟取值数 × 小时取值数。
 * 日/月/周三段只会把触发减少到更低频，不可能造成同一天多次，故不参与计算（也借此避开 dom/dow 的 OR 语义）；
 * 但仍校验它们合法，免得坏表达式被当成「每天一次」放过去。
 * @param {string} schedule @returns {number}
 */
export function triggersPerDay(schedule) {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 字段数应为 5，实为 ${fields.length}: ${schedule}`);
  fieldCardinality(fields[2], 1, 31);
  fieldCardinality(fields[3], 1, 12);
  fieldCardinality(fields[4], 0, 7);
  return fieldCardinality(fields[0], 0, 59) * fieldCardinality(fields[1], 0, 23);
}

function readText(root, rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function listRouteFiles(root) {
  const appDir = join(root, 'src', 'app');
  if (!existsSync(appDir)) return [];
  const out = [];
  const routeName = new RegExp(`^route\\.(?:${ROUTE_EXTENSIONS.join('|')})$`);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (routeName.test(entry.name)) out.push(toPosix(relative(root, full)));
    }
  };
  walk(appDir);
  return out.sort();
}

/**
 * 同一目录只能有一个 route 文件。Next 16.3.5 对此不报错：Turbopack（app_structure.rs）按 read_dir
 * 顺序后者覆盖前者，顺序由文件系统决定；webpack 构建排序后后者覆盖；dev 只打 Duplicate page 警告。
 * 哪一个真正上线无法静态确定，下面的 GET / maxDuration 检查也就可能查错文件。
 */
function checkRouteFiles(root, errors) {
  const byDir = new Map();
  for (const file of listRouteFiles(root)) {
    const dir = file.slice(0, file.lastIndexOf('/'));
    byDir.set(dir, [...(byDir.get(dir) ?? []), file.slice(dir.length + 1)]);
  }
  for (const [dir, names] of byDir) {
    if (names.length > 1) {
      errors.push(
        `${dir}: 同一目录有多个 route 文件（${names.join('、')}）。Next 不报错，按目录遍历顺序静默取其一，` +
          `上线的是哪个无法确定；只保留一个`,
      );
    }
  }
}

/** 数字字面量（允许 `_` 分隔）→ number；不是纯字面量返回 null。 */
function parseNumericLiteral(text) {
  const t = text.trim();
  return /^\d[\d_]*$/.test(t) ? Number(t.replace(/_/g, '')) : null;
}

/** 读 `export const maxDuration = …`：无声明返回 undefined；有声明但不是整数字面量返回 { raw }。 */
function readMaxDuration(source) {
  const m = source.match(/^export\s+const\s+maxDuration\s*(?::\s*\w+\s*)?=\s*([^;\n]+)/m);
  if (!m) return undefined;
  return { raw: m[1].trim(), seconds: parseNumericLiteral(m[1]) };
}

/** 读顶层 `const NAME = <数字字面量>`（可带 export）。找不到或不是字面量返回 null。 */
function readTopLevelConst(source, name) {
  const m = source.match(new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*(?::\\s*\\w+\\s*)?=\\s*([^;\\n]+)`, 'm'));
  return m ? parseNumericLiteral(m[1]) : null;
}

function checkVercelJson(root, errors) {
  const rel = 'vercel.json';
  if (!existsSync(join(root, rel))) {
    errors.push(`${rel}: 文件不存在（cron 全部随之消失）`);
    return;
  }
  let config;
  try {
    config = JSON.parse(readText(root, rel));
  } catch (e) {
    errors.push(`${rel}: 不是合法 JSON（${e instanceof Error ? e.message : e}）——Vercel 会拒绝整次部署`);
    return;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    errors.push(`${rel}: 顶层必须是对象`);
    return;
  }
  if (config.crons === undefined) return;
  if (!Array.isArray(config.crons)) {
    errors.push(`${rel}: crons 必须是数组`);
    return;
  }
  if (config.crons.length > MAX_CRON_JOBS) {
    errors.push(`${rel}: 共 ${config.crons.length} 条 cron，超过每项目上限 ${MAX_CRON_JOBS} 条`);
  }
  const routes = new Set(listRouteFiles(root));
  config.crons.forEach((cron, i) => {
    const where = `${rel} crons[${i}]`;
    if (cron === null || typeof cron !== 'object' || typeof cron.path !== 'string' || typeof cron.schedule !== 'string') {
      errors.push(`${where}: 每条 cron 必须是 { path: string, schedule: string }`);
      return;
    }
    const { path, schedule } = cron;
    let perDay;
    try {
      perDay = triggersPerDay(schedule);
    } catch (e) {
      errors.push(`${where} ${path}: schedule "${schedule}" 无法按 5 段 crontab 解析（${e.message}）。本脚本 fail-closed，不认的写法一律判错`);
    }
    if (perDay !== undefined && perDay > MAX_CRON_RUNS_PER_DAY) {
      errors.push(
        `${where} ${path}: schedule "${schedule}" 每天触发 ${perDay} 次，超过 Hobby 上限 ${MAX_CRON_RUNS_PER_DAY} 次/日。` +
          `Vercel 会在部署前校验阶段拒绝整次部署（"Hobby accounts are limited to daily cron jobs"），且不生成部署记录。` +
          `改回每天一次；确需更频繁请用外部定时器，或确认已升级计划后改本脚本顶部 MAX_CRON_RUNS_PER_DAY`,
      );
    }
    if (!path.startsWith('/')) {
      errors.push(`${where}: path "${path}" 必须以 / 开头`);
      return;
    }
    const pathname = path.split('?')[0].replace(/\/+$/, '');
    const routeDir = `src/app${pathname}`;
    // 多个同名 route 文件已由 checkRouteFiles 判红；这里每个都查 GET，不猜哪个生效。
    const routeFiles = ROUTE_EXTENSIONS.map((ext) => `${routeDir}/route.${ext}`).filter((c) => routes.has(c));
    if (routeFiles.length === 0) {
      errors.push(
        `${where}: path "${path}" 找不到对应路由（期望 ${routeDir}/route.ts，或同名 .tsx/.jsx/.js）。部署会成功，但 cron 每天静默 404`,
      );
      return;
    }
    for (const routeFile of routeFiles) {
      const source = readText(root, routeFile);
      if (!/export\s+(?:async\s+)?function\s+GET\b|export\s+const\s+GET\b|export\s*\{[^}]*\bGET\b[^}]*\}/.test(source)) {
        errors.push(`${where}: ${routeFile} 没有导出 GET。Vercel cron 以 GET 调用，部署会成功，但 cron 每天静默 405`);
      }
    }
  });
}

function checkFunctionDurations(root, errors) {
  const modelBudget = existsSync(join(root, MODEL_BUDGET.file))
    ? readTopLevelConst(readText(root, MODEL_BUDGET.file), MODEL_BUDGET.name)
    : null;
  const durations = new Map();
  for (const routeFile of listRouteFiles(root)) {
    const source = readText(root, routeFile);
    const declared = readMaxDuration(source);
    if (declared === undefined) {
      if (source.includes(MODEL_BUDGET.name)) {
        errors.push(`${routeFile}: 使用 ${MODEL_BUDGET.name} 却没声明 maxDuration，平台默认时限与内部预算无从对齐`);
      }
      continue;
    }
    const seconds = declared.seconds;
    if (seconds === null || !Number.isInteger(seconds)) {
      errors.push(`${routeFile}: maxDuration = ${declared.raw} 不是整数字面量（Next 路由段配置须可静态分析）`);
      continue;
    }
    durations.set(routeFile, seconds);
    if (seconds < 1 || seconds > MAX_FUNCTION_SECONDS) {
      errors.push(`${routeFile}: maxDuration = ${seconds}s，超出 Hobby Fluid Compute 单函数上限 1–${MAX_FUNCTION_SECONDS}s`);
    }
    const limitMs = seconds * 1000;
    const budgets = [];
    if (source.includes(MODEL_BUDGET.name)) {
      if (modelBudget === null) {
        errors.push(`${MODEL_BUDGET.file}: 读不到 ${MODEL_BUDGET.name} 的数字字面量（${routeFile} 依赖它）`);
      } else {
        budgets.push({ name: MODEL_BUDGET.name, ms: modelBudget, from: MODEL_BUDGET.file });
      }
    }
    for (const m of source.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_(?:BUDGET|TIMEOUT)_MS)\s*=\s*([^;\n]+)/gm)) {
      const ms = parseNumericLiteral(m[2]);
      if (ms !== null) budgets.push({ name: m[1], ms, from: routeFile });
    }
    for (const b of budgets) {
      if (b.ms >= limitMs) {
        errors.push(
          `${routeFile}: ${b.name} = ${b.ms}ms（${b.from}）≥ maxDuration ${seconds}s。平台会先杀函数，` +
            `内部 deadline 的写回与超时响应永远轮不到执行；调高 maxDuration 或调低预算`,
        );
      }
    }
  }
  for (const pair of CROSS_FILE_BUDGETS) {
    if (!existsSync(join(root, pair.file))) {
      errors.push(`${pair.file}: 文件不存在（CROSS_FILE_BUDGETS 登记了 ${pair.name}，请同步更新登记表）`);
      continue;
    }
    const ms = readTopLevelConst(readText(root, pair.file), pair.name);
    if (ms === null) {
      errors.push(`${pair.file}: 读不到 ${pair.name} 的数字字面量（CROSS_FILE_BUDGETS 登记项）`);
      continue;
    }
    const seconds = durations.get(pair.route);
    if (seconds === undefined) {
      errors.push(`${pair.route}: 找不到或未声明整数 maxDuration（CROSS_FILE_BUDGETS 登记了 ${pair.name}）`);
      continue;
    }
    if (ms >= seconds * 1000) {
      errors.push(
        `${pair.route}: ${pair.name} = ${ms}ms（${pair.file}）≥ maxDuration ${seconds}s。平台会先杀函数，` +
          `内部 deadline 的写回与超时响应永远轮不到执行`,
      );
    }
  }
}

function checkNextConfig(root, errors) {
  const rel = ['next.config.ts', 'next.config.mjs', 'next.config.js'].find((f) => existsSync(join(root, f)));
  if (!rel) return;
  // 用 TypeScript 解析成 AST 再找属性：注释与字符串里的字样不算，引号键与 `x.ignoreBuildErrors = …` 赋值也认得出。
  const file = ts.createSourceFile(rel, readText(root, rel), ts.ScriptTarget.Latest, false, rel.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const keyText = (name) =>
    ts.isIdentifier(name) || ts.isStringLiteralLike(name)
      ? name.text
      : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
        ? name.expression.text
        : undefined;
  const unwrap = (expr) =>
    ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)
      ? unwrap(expr.expression)
      : expr;
  const values = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && keyText(node.name) === 'ignoreBuildErrors') values.push(node.initializer);
    else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'ignoreBuildErrors') values.push(node.name);
    else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'ignoreBuildErrors') ||
        (ts.isElementAccessExpression(node.left) && keyText(node.left.argumentExpression) === 'ignoreBuildErrors'))
    ) {
      values.push(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const value of values.map(unwrap)) {
    if (value.kind === ts.SyntaxKind.FalseKeyword) continue;
    errors.push(
      value.kind === ts.SyntaxKind.TrueKeyword
        ? `${rel}: typescript.ignoreBuildErrors = true 会让带类型错误的代码照样在 Vercel 构建上线，关掉了最后一道类型门`
        : `${rel}: ignoreBuildErrors 不是字面量 false（${value.getText(file)}），构建时可能为 true 而关掉类型门；本脚本 fail-closed，改成字面量或删掉`,
    );
  }
}

/**
 * 对仓库根目录 root 跑全部检查，返回错误列表（空 = 通过）。
 * @param {string} root @returns {string[]}
 */
export function checkDeployConfig(root) {
  const errors = [];
  checkRouteFiles(root, errors);
  checkVercelJson(root, errors);
  checkFunctionDurations(root, errors);
  checkNextConfig(root, errors);
  return errors;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const errors = checkDeployConfig(root);
  if (errors.length > 0) {
    console.error(`✖ check-deploy-config：${errors.length} 处部署配置违规`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `✔ check-deploy-config：vercel.json 合法、cron 每条 ≤${MAX_CRON_RUNS_PER_DAY} 次/日且路由存在并导出 GET、` +
      `maxDuration ≤${MAX_FUNCTION_SECONDS}s 且大于路由内部预算、未关构建类型门。`,
  );
}
