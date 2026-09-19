// 打标线多源化 in-process 引擎 CLI（T4，A2 形态）。labeler 在 phoenix 上 shell out 到本脚本，
// 复用 M1 引擎库（rule-engine/api.ts 门面四函数）+ book15 内建适配器（source-parser），
// 直接取书，不走 serverless、无 55s 限制。每次进程冷启，不做跨进程状态。
//
// 用法（labeler 逐级调用；`@/` 别名靠 ts-alias-hook.mjs，故必须带 --import）：
//   node --import ./scripts/ts-alias-hook.mjs scripts/engine-fetch.mjs search  --title "斗破苍穹" [--author "天蚕土豆"] [--json]
//   node --import ./scripts/ts-alias-hook.mjs scripts/engine-fetch.mjs toc     --url <bookUrl>    [--json]
//   node --import ./scripts/ts-alias-hook.mjs scripts/engine-fetch.mjs content --url <chapterUrl> [--json]
//   （env：--env <file> 或环境变量 DATABASE_URL；--env 剥引号，参照 backfill_quality.mjs）
//
// 退出码契约：0=有结果；1=无候选/无章/空正文（stderr 原因）；2=无法尝试（无 DATABASE_URL、
//   DB 不可达、参数/URL 非法；stderr 原因）。stdout 只放数据（--json 时单行 JSON）。
// 🔴 凭据红线：任何输出（stdout/stderr）不得包含 DATABASE_URL 或密钥（见 safeReason）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CLI 层宽上限（无 serverless 限制，但仍有界防挂死）。
const SEARCH_TIMEOUT_MS = 30_000;
const TOC_TIMEOUT_MS = 60_000;
const CONTENT_TIMEOUT_MS = 30_000;
const POOL_SIZE = 4; // 与 DEFAULT_READING_POOL_LIMIT 同量级；仅用于 context.openPool 抬全局兜底上限。

class ExitError extends Error {
  constructor(code, reason) { super(reason); this.code = code; }
}

function parseArgs(argv) {
  const args = { _: [], json: false, env: null, title: null, author: null, url: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--env') args.env = argv[++i] ?? null;
    else if (a === '--title') args.title = argv[++i] ?? null;
    else if (a === '--author') args.author = argv[++i] ?? null;
    else if (a === '--url') args.url = argv[++i] ?? null;
    else if (a.startsWith('--')) throw new ExitError(2, `未知参数：${a}`);
    else args._.push(a);
  }
  return args;
}

// env 文件加载（剥引号，参照 scripts/backfill_quality.mjs：vercel env pull 写的值带引号）。
function loadEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// 🔴 脱敏：DB/连接错误的原文可能含连接串（含口令）。任何带 `://` 或 `@host` 形态的 token 一律抹掉，
// 只保留可读的错误类别。绝不把原始错误直接进 stderr。
function safeReason(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\S*:\/\/\S*/g, '[redacted-url]').replace(/\S+@\S+/g, '[redacted]').slice(0, 300);
}

// —— 模块与源池装配（env 设好后再动态 import，确保 db.ts 模块初始化读到 DATABASE_URL）——

async function loadModules() {
  const [api, compile, shuyuan, supported, policy, parser, reader] = await Promise.all([
    import('../src/lib/rule-engine/api.ts'),
    import('../src/lib/rule-engine/compile.ts'),
    import('../src/lib/shuyuan.ts'),
    import('../src/lib/supported-sources.ts'),
    import('../src/lib/source-policy.ts'),
    import('../src/lib/source-parser.ts'),
    import('../src/lib/source-reader.ts'),
  ]);
  return { api, compile, shuyuan, supported, policy, parser, reader };
}

// builtin book15 条目（ReadingSource 形态；rules 空 ⇒ 走 source-parser 适配器）。
function builtinSource(m) {
  const b = m.supported.BUILTIN_SOURCES[0];
  return { url: b.url, name: b.name, searchUrl: b.searchUrl, rules: {}, tier: 'builtin' };
}

const isBuiltin = (source) => source.tier === 'builtin' || !source.rules || Object.keys(source.rules).length === 0;

// 复刻 source-reader 的 engineSourceOf（未导出）：编译走 compile.ts 的 LRU。
function engineSourceOf(m, source) {
  return {
    url: source.url, name: source.name,
    searchUrl: typeof source.searchUrl === 'string' ? source.searchUrl : '',
    compiled: m.compile.compileSource({ url: source.url, searchUrl: source.searchUrl, rules: source.rules }),
  };
}

// 引擎源池：先按 getReadingPool 的合成意图刷新运行时 host 门（否则 canProbe 会把引擎源全滤掉），
// 再读 getEngineSources。任一步 DB 失败 ⇒ 抛出，由调用方按子命令决定降级/退 2。
async function loadEnginePool(m, signal) {
  m.policy.refreshSupportedHosts(await m.supported.engineHosts(signal));
  return await m.shuyuan.getEngineSources(signal);
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

// URL 的 host 是否属于 builtin（book15 双 host，静态、恒在门内，无需 DB）。
function isBuiltinHost(m, host) {
  return m.supported.BUILTIN_SOURCE_HOSTS.includes(host);
}

// 在池里按 host 找源（含同站备用 host，参照 resolveSourceBook 的 §3.7 反查）。
function findSourceByHost(m, sources, host) {
  return sources.find((s) => {
    const h = hostOf(s.url);
    return h === host || (h.length > 0 && m.policy.alternateSourceHost?.(host) === h);
  });
}

// —— 子命令 ——

async function cmdSearch(m, args) {
  if (!args.title) throw new ExitError(2, 'search 需要 --title');
  const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  let enginePool;
  try {
    enginePool = await loadEnginePool(m, signal);
  } catch (error) {
    // search 的价值就是全池；DB 不可达 ⇒ 退 2，labeler 回退自有 book15 路径。
    throw new ExitError(2, `引擎源池不可用：${safeReason(error)}`);
  }
  const sources = [builtinSource(m), ...enginePool];
  const context = new m.reader.SourceRequestContext(signal, 12);
  context.openPool(POOL_SIZE);
  const candidates = [];
  for (const source of sources) {
    try {
      if (isBuiltin(source)) {
        const searchUrl = m.parser.sourceSearchUrl(source.searchUrl, args.title, source.url);
        const page = await context.page(searchUrl);
        // book15 详情页即目录页；parseSourceSearch 按锚文本=书名精确匹配（身份校验留给 labeler）。
        for (const bookUrl of m.parser.parseSourceSearch(page.text, page.url, args.title)) {
          candidates.push({ source: hostOf(source.url), sourceName: source.name, title: args.title, author: '', bookUrl, tocUrl: bookUrl });
        }
      } else {
        const engineSource = engineSourceOf(m, source);
        const results = await m.api.engineSearchBook(engineSource, args.title, context);
        for (const r of results) {
          candidates.push({ source: hostOf(source.url), sourceName: source.name, title: r.title, author: r.author, bookUrl: r.bookUrl });
        }
      }
    } catch (error) {
      if (signal.aborted) break; // 整体超时：停止，交付已收集的
      process.stderr.write(`[warn] 源 ${hostOf(source.url)} 搜索失败：${safeReason(error)}\n`);
    }
  }
  if (!candidates.length) throw new ExitError(1, `无候选：${args.title}`);
  emit(args, candidates, () => candidates.map((c) => `[${c.source}] ${c.title}${c.author ? ' / ' + c.author : ''} -> ${c.bookUrl}`).join('\n'));
}

async function resolveSourceForUrl(m, url, signal) {
  const host = hostOf(url);
  if (!host) throw new ExitError(2, `--url 非法：无法解析 host`);
  if (isBuiltinHost(m, host)) return { source: builtinSource(m), builtin: true };
  // 非 builtin host ⇒ 需要引擎源池（DB）。DB 不可达 ⇒ 退 2。
  let enginePool;
  try {
    enginePool = await loadEnginePool(m, signal);
  } catch (error) {
    throw new ExitError(2, `引擎源池不可用：${safeReason(error)}`);
  }
  const source = findSourceByHost(m, enginePool, host);
  if (!source) throw new ExitError(1, `没有匹配该 URL host 的可用引擎源：${host}`);
  return { source, builtin: false };
}

async function cmdToc(m, args) {
  if (!args.url) throw new ExitError(2, 'toc 需要 --url');
  const signal = AbortSignal.timeout(TOC_TIMEOUT_MS);
  const { source, builtin } = await resolveSourceForUrl(m, args.url, signal);
  const context = new m.reader.SourceRequestContext(signal, 12);
  context.openPool(POOL_SIZE);
  let title = '';
  let author = '';
  let chapters = [];
  if (builtin) {
    const page = await context.page(m.policy.validateSourceUrl(args.url).href);
    const identity = m.parser.parseSourceIdentity(page.text);
    title = identity.title;
    author = identity.author;
    try {
      chapters = m.parser.parseSourceChapters(page.text, page.url);
    } catch (error) {
      throw new ExitError(1, `无法解析目录：${safeReason(error)}`);
    }
  } else {
    const engineSource = engineSourceOf(m, source);
    const detail = await m.api.engineFetchDetail(engineSource, args.url, context);
    title = detail.title ?? '';
    author = detail.author ?? '';
    const toc = await m.api.engineFetchToc(engineSource, detail.tocUrl ?? args.url, context);
    chapters = toc.chapters;
  }
  if (!chapters.length) throw new ExitError(1, `无章节：${args.url}`);
  const out = {
    source: hostOf(source.url), title, author,
    chapters: chapters.map((c, index) => ({ index, title: c.title, url: c.url })),
  };
  emit(args, out, () => `${out.title}${out.author ? ' / ' + out.author : ''}（${out.chapters.length} 章）\n`
    + out.chapters.slice(0, 5).map((c) => `  ${c.index}. ${c.title}`).join('\n')
    + (out.chapters.length > 5 ? `\n  … 共 ${out.chapters.length} 章` : ''));
}

async function cmdContent(m, args) {
  if (!args.url) throw new ExitError(2, 'content 需要 --url');
  const signal = AbortSignal.timeout(CONTENT_TIMEOUT_MS);
  const { source, builtin } = await resolveSourceForUrl(m, args.url, signal);
  const context = new m.reader.SourceRequestContext(signal, 12);
  context.openPool(POOL_SIZE);
  let text = '';
  if (builtin) {
    const page = await context.page(m.policy.validateSourceUrl(args.url).href);
    try {
      text = m.parser.parseSourceChapterText(page.text); // 无 expectedTitle：CLI 不做标题校验
    } catch (error) {
      throw new ExitError(1, `空正文：${safeReason(error)}`);
    }
  } else {
    const engineSource = engineSourceOf(m, source);
    text = (await m.api.engineFetchContent(engineSource, args.url, context)).text;
  }
  if (!text) throw new ExitError(1, `空正文：${args.url}`);
  const out = { source: hostOf(source.url), url: args.url, text };
  emit(args, out, () => `[${out.source}] ${out.url}\n\n${out.text}`);
}

function emit(args, data, human) {
  process.stdout.write(args.json ? JSON.stringify(data) + '\n' : human() + '\n');
}

const COMMANDS = { search: cmdSearch, toc: cmdToc, content: cmdContent };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const handler = COMMANDS[command];
  if (!handler) throw new ExitError(2, `未知子命令：${command ?? '(空)'}；支持 search|toc|content`);

  // env：--env 文件的 DATABASE_URL 注入 process.env（db.ts 模块初始化读它）。绝不打印。
  if (args.env) {
    const env = loadEnvFile(resolve(args.env));
    if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
  }
  if (!process.env.DATABASE_URL) throw new ExitError(2, 'DATABASE_URL 未设置（用 --env <file> 或环境变量）');

  const m = await loadModules();
  await handler(m, args);
}

main().then(
  () => process.exit(0),
  (error) => {
    const code = error instanceof ExitError ? error.code : 1;
    process.stderr.write(`${safeReason(error)}\n`);
    process.exit(code);
  },
);
