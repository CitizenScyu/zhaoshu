// 打标线多源化 in-process 引擎 CLI（T4，A2 形态）。labeler 在 phoenix 上 shell out 到本脚本，
// 复用 M1 引擎库（rule-engine/api.ts 门面四函数）+ book15 内建适配器（source-parser），
// 直接取书，不走 serverless、无 55s 限制。每次进程冷启；跨进程只共享源池文件缓存（engine-pool-cache.mjs，xfer41）。
//
// 用法（labeler 逐级调用；`@/` 别名靠 ts-esm-loader.mjs，故必须带 --import）：
//   node --import ./scripts/ts-esm-loader.mjs scripts/engine-fetch.mjs search  --title "斗破苍穹" [--author "天蚕土豆"] [--no-builtin] [--skip-host <host>]… [--json]
//   node --import ./scripts/ts-esm-loader.mjs scripts/engine-fetch.mjs toc     --url <bookUrl>    [--json]
//   node --import ./scripts/ts-esm-loader.mjs scripts/engine-fetch.mjs content --url <chapterUrl> [--stop-urls-file <path>] [--json]
//   node --import ./scripts/ts-esm-loader.mjs scripts/engine-fetch.mjs doctor --json
//   （env：--env <file> 或环境变量 DATABASE_URL；--env 剥引号，参照 backfill_quality.mjs）
//
// 退出码契约：0=有结果（doctor=模块装配正常）；1=无候选/无章/空正文（stderr 原因）；2=无法尝试（无 DATABASE_URL、
//   DB 不可达、参数/URL 非法——含非 https:// scheme；stderr 原因）。stdout 只放数据（--json 时单行 JSON）。
// 出错时 --json 另在 stderr 第二行写 `{"errorKind":"…"}`（类别见 engine-error-kind.mjs；giveup41）。
// 🔴 凭据红线：任何输出（stdout/stderr）不得包含 DATABASE_URL 或密钥（见 safeReason）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exitAfterFlush } from './stdio-exit.mjs';
import { excludeSkippedSources, searchSources, SEARCH_SOURCE_SLICE_MS } from './engine-search-pool.mjs';
import { downloadErrorKind, engineErrorKind } from './engine-error-kind.mjs';
import { loadEnginePoolCached } from './engine-pool-cache.mjs';

// CLI 层宽上限（无 serverless 限制，但仍有界防挂死）。
const SEARCH_TIMEOUT_MS = 30_000;
const TOC_TIMEOUT_MS = 60_000;
const CONTENT_TIMEOUT_MS = 30_000;
const POOL_SIZE = 4; // 与 DEFAULT_READING_POOL_LIMIT 同量级；仅用于 context.openPool 抬全局兜底上限。

class ExitError extends Error {
  // kind：--json 错误行的 errorKind；缺省按退出码（2=用法错，1=无结果）。
  constructor(code, reason, kind = code === 2 ? 'usage' : 'empty') { super(reason); this.code = code; this.kind = kind; }
}

function parseArgs(argv) {
  const args = { _: [], json: false, env: null, title: null, author: null, url: null, noBuiltin: false, skipHosts: [], stopUrlsFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (['--source', '--out', '--max-chapters', '--rate-ms', '--timeout-ms', '--budget-ms'].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new ExitError(2, `缺少参数值：${a}`);
      args[a.slice(2)] = argv[++i];
    }
    else if (a === '--json') args.json = true;
    else if (a === '--env') args.env = argv[++i] ?? null;
    else if (a === '--title') args.title = argv[++i] ?? null;
    else if (a === '--author') args.author = argv[++i] ?? null;
    else if (a === '--url') args.url = argv[++i] ?? null;
    // espfix41：labeler 已自行搜过 book15（或已熔断），--no-builtin 免掉 CLI 里重复的一次；
    // --skip-host（可重复）跳过本轮已判「查询不敏感」的垃圾源。二者只用于 search。
    else if (a === '--no-builtin') args.noBuiltin = true;
    else if (a === '--skip-host') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new ExitError(2, `缺少参数值：${a}`);
      args.skipHosts.push(argv[++i]);
    }
    // lblqual41：content 的翻页停止点清单（每行一个 URL，labeler 写入整本目录）。只用于 content。
    else if (a === '--stop-urls-file') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new ExitError(2, `缺少参数值：${a}`);
      args.stopUrlsFile = argv[++i];
    }
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

// 停止点清单：每行一个 https URL，空行/其它行忽略；读不了 ⇒ 用法错退 2（DB 之前）。
const MAX_STOP_URLS = 20_000;
function readStopUrls(path) {
  let raw;
  try { raw = readFileSync(resolve(path), 'utf8'); } catch { throw new ExitError(2, '--stop-urls-file 无法读取'); }
  return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https:\/\//i.test(line)).slice(0, MAX_STOP_URLS);
}

// 🔴 脱敏：DB/连接错误的原文可能含连接串（含口令）。任何带 `://` 或 `@host` 形态的 token 一律抹掉，
// 只保留可读的错误类别。绝不把原始错误直接进 stderr。
function safeReason(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\S*:\/\/\S*/g, '[redacted-url]').replace(/\S+@\S+/g, '[redacted]').slice(0, 300);
}

// —— 模块与源池装配（env 设好后再动态 import，确保 db.ts 模块初始化读到 DATABASE_URL）——

async function loadModules() {
  const [api, compile, shuyuan, supported, policy, parser, reader, fetchLayer] = await Promise.all([
    import('../src/lib/rule-engine/api.ts'),
    import('../src/lib/rule-engine/compile.ts'),
    import('../src/lib/shuyuan.ts'),
    import('../src/lib/supported-sources.ts'),
    import('../src/lib/source-policy.ts'),
    import('../src/lib/source-parser.ts'),
    import('../src/lib/source-reader.ts'),
    import('../src/lib/source-fetch.ts'),
  ]);
  return { api, compile, shuyuan, supported, policy, parser, reader, fetchLayer };
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
// xfer41：进程内只读一次；跨进程 TTL 内走本机文件缓存（labeler 每章一个进程，见 engine-pool-cache.mjs）。
// 命中缓存时同样用缓存的 host 集合刷门——后续 validateSourceUrl 与改前同一口径。
let enginePoolOnce = null;
async function loadEnginePool(m, signal) {
  enginePoolOnce ??= loadEnginePoolCached(async () => {
    const hosts = await m.supported.engineHosts(signal);
    m.policy.refreshSupportedHosts(hosts);
    return { hosts, sources: await m.shuyuan.getEngineSources(signal) };
  }).catch((error) => { enginePoolOnce = null; throw error; });
  const { hosts, sources } = await enginePoolOnce;
  m.policy.refreshSupportedHosts(hosts);
  return sources;
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
    throw new ExitError(2, `引擎源池不可用：${safeReason(error)}`, 'pool');
  }
  // --skip-host 按源身份 host 过滤（与下面按请求 host 分组不是同一个键，理由见 excludeSkippedSources）。
  const sources = excludeSkippedSources(
    [...(args.noBuiltin ? [] : [builtinSource(m)]), ...enginePool], args.skipHosts);
  const context = new m.reader.SourceRequestContext(signal, 12);
  context.openPool(POOL_SIZE);
  // espfix41：改前逐源串行（墙钟=各源之和）；改后按目标站分组、组内串行、组间有界并发，
  // 每源一个切片子 context（卡死的源 SEARCH_SOURCE_SLICE_MS 放弃）。候选仍按池序输出。
  const candidates = await searchSources({
    sources,
    signal,
    hostKey: (source) => searchHostOf(m, source, args.title),
    searchOne: async (source) => {
      const scoped = context.child(hostOf(source.url), { sliceMs: SEARCH_SOURCE_SLICE_MS });
      if (isBuiltin(source)) {
        const searchUrl = m.parser.sourceSearchUrl(source.searchUrl, args.title, source.url);
        const page = await scoped.page(searchUrl);
        // book15 详情页即目录页；parseSourceSearch 按锚文本=书名精确匹配（身份校验留给 labeler）。
        return m.parser.parseSourceSearch(page.text, page.url, args.title)
          .map((bookUrl) => ({ source: hostOf(source.url), sourceName: source.name, title: args.title, author: '', bookUrl, tocUrl: bookUrl }));
      }
      const results = await m.api.engineSearchBook(engineSourceOf(m, source), args.title, scoped);
      return results.map((r) => ({ source: hostOf(source.url), sourceName: source.name, title: r.title, author: r.author, bookUrl: r.bookUrl }));
    },
    onError: (source, error) => process.stderr.write(`[warn] 源 ${hostOf(source.url)} 搜索失败：${safeReason(error)}\n`),
  });
  if (!candidates.length) throw new ExitError(1, `无候选：${args.title}`, 'miss');
  emit(args, candidates, () => candidates.map((c) => `[${c.source}] ${c.title}${c.author ? ' / ' + c.author : ''} -> ${c.bookUrl}`).join('\n'));
}

// 搜索请求实际打向的站（分组键）：searchUrl 展开后的 host；展开失败退回源声明 host。
function searchHostOf(m, source, title) {
  try { return hostOf(m.parser.sourceSearchUrl(source.searchUrl, title, source.url)) || hostOf(source.url); }
  catch { return hostOf(source.url); }
}

async function resolveSourceForUrl(m, url, signal) {
  // 用法错先行：http:// 等非 https scheme 的 URL 属「参数/用法错」退 2（交回默认门也会拒，
  // 但那会落进运行时兜底 code=1——与「无候选」同档，labeler 会误当正常 miss 重试整轮）。
  if (!/^https:\/\//i.test(url)) throw new ExitError(2, '--url 非法：仅支持 HTTPS 完整地址');
  const host = hostOf(url);
  if (!host) throw new ExitError(2, `--url 非法：无法解析 host`);
  if (isBuiltinHost(m, host)) return { source: builtinSource(m), builtin: true };
  // 非 builtin host ⇒ 需要引擎源池（DB）。DB 不可达 ⇒ 退 2。
  let enginePool;
  try {
    enginePool = await loadEnginePool(m, signal);
  } catch (error) {
    throw new ExitError(2, `引擎源池不可用：${safeReason(error)}`, 'pool');
  }
  const source = findSourceByHost(m, enginePool, host);
  if (!source) throw new ExitError(1, `没有匹配该 URL host 的可用引擎源：${host}`, 'no_source');
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
    // lblqual41：停止点 = 整本目录。站点「下一页」若是目录里的任一章（cuoceng 的 #linkNext 就是下一章，
    // 且目录序与下一章链序不同）即停，不再一路翻 20 页串进后续章节。未给清单时行为同改前。
    text = (await m.api.engineFetchContent(engineSource, args.url, context, false, args.stopUrls)).text;
  }
  if (!text) throw new ExitError(1, `空正文：${args.url}`);
  const out = { source: hostOf(source.url), url: args.url, text };
  emit(args, out, () => `[${out.source}] ${out.url}\n\n${out.text}`);
}

async function cmdDoctor(m, args) {
  // main 已完成 loader + 七个依赖模块的真实加载；不访问 DB/网络、不输出配置真值。
  const required = ['api', 'compile', 'shuyuan', 'supported', 'policy', 'parser', 'reader'];
  if (!required.every((name) => m[name])) throw new ExitError(2, '引擎模块装配不完整');
  emit(args, { ok: true }, () => 'ok');
}

function emit(args, data, human) {
  process.stdout.write(args.json ? JSON.stringify(data) + '\n' : human() + '\n');
}

async function cmdDownload(m, args) {
  const { downloadBook } = await import('./engine-download.mjs');
  const result = await downloadBook(m, args, resolveSourceForUrl);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.code) throw new ExitError(result.code, 'download partial', downloadErrorKind(result.code));
}

const COMMANDS = { doctor: cmdDoctor, download: cmdDownload, search: cmdSearch, toc: cmdToc, content: cmdContent };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const handler = COMMANDS[command];
  if (!handler) throw new ExitError(2, `未知子命令：${command ?? '(空)'}；支持 doctor|search|toc|content|download`);

  if (command !== 'search' && (args.noBuiltin || args.skipHosts.length)) {
    throw new ExitError(2, '--no-builtin/--skip-host 仅用于 search');
  }
  if (command !== 'content' && args.stopUrlsFile) throw new ExitError(2, '--stop-urls-file 仅用于 content');
  if (args.stopUrlsFile) args.stopUrls = readStopUrls(args.stopUrlsFile);
  if (command !== 'download') {
    for (const key of ['source', 'out', 'max-chapters', 'rate-ms', 'timeout-ms', 'budget-ms']) {
      if (args[key] !== undefined) throw new ExitError(2, `--${key} 仅用于 download`);
    }
  }
  if (command === 'download') {
    try { Object.assign(args, (await import('./engine-download.mjs')).downloadOptions(args)); }
    catch { throw new ExitError(2, 'download 参数非法：需要 --source --title --author；数值参数须在允许范围内'); }
  }

  // env：--env 文件的 DATABASE_URL 注入 process.env（db.ts 模块初始化读它）。绝不打印。
  if (args.env) {
    const env = loadEnvFile(resolve(args.env));
    if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
  }
  // doctor 只验证 loader/模块装配，不读取数据库；download 参数校验在 DB 前返回；其余命令仍要求连接串。
  if (command !== 'doctor' && command !== 'download' && !process.env.DATABASE_URL) {
    throw new ExitError(2, 'DATABASE_URL 未设置（用 --env <file> 或环境变量）');
  }

  const m = await loadModules();
  errorClasses = { SourcePolicyError: m.policy.SourcePolicyError, SourceHttpError: m.fetchLayer.SourceHttpError };
  await handler(m, args);
}

// 模块加载后才有错误类可比对（加载前抛的都是 ExitError，自带 kind）。
let errorClasses = {};

// 🔴 不得直接 process.exit：管道下 >64KB 的 --json 输出会被截断（见 stdio-exit.mjs）。
main().then(
  () => exitAfterFlush(0),
  (error) => {
    const code = error instanceof ExitError ? error.code : 1;
    process.stderr.write(`${safeReason(error)}\n`);
    if (process.argv.includes('--json')) {
      process.stderr.write(`${JSON.stringify({ errorKind: engineErrorKind(error, errorClasses) })}\n`);
    }
    return exitAfterFlush(code);
  },
);
