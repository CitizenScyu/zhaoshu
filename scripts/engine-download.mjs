import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, fsyncSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { canonicalBookKey } from '../src/lib/book-identity.ts';
import { fetchSourceText, sourceAbortable } from '../src/lib/source-fetch.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const atomic = (path, data) => {
  const temp = path + '.tmp';
  const fd = openSync(temp, 'w');
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
};
const knownError = /^(identity_mismatch_or_no_candidate|empty_toc|empty_toc_page|pagination_cycle|toc_limit|unsupported_toc_rule|invalid_chapter|invalid_next_page|empty_content_page|content_page_limit|unsupported_content_rule|max_chapters|size_limit|toc_changed|missing_chapters|interrupted|budget_exhausted|operation_timeout|empty_content)$/;

// 发布侧整本上限(内存约束,分卷 v2)：15 MiB → 64 MiB。阅读侧已无整本上限(按卷懒取)，
// 这里只卡引擎与发布器把整本当字符串持有的内存峰值；二期按章流式写后解除。
const MAX_BOOK_BYTES = 64 * 1024 * 1024;
export function downloadOptions(args) {
  if (!args.source || !args.title?.trim() || !args.author?.trim()) throw new Error('download 需要 --source --title --author');
  const source = new URL(args.source.includes('://') ? args.source : `https://${args.source}`);
  if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash) throw new Error('--source 必须是 HTTPS URL 或 host');
  const options = { ...args, source: source.href };
  for (const [key, fallback, min, max] of [['max-chapters', 20000, 1, 20000], ['rate-ms', 800, 0, 60000], ['timeout-ms', 30000, 1, 600000], ['budget-ms', 19800000, 1, 19800000]]) {
    const n = args[key] === undefined ? fallback : Number(args[key]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`非法 --${key}`);
    options[key] = n;
  }
  return options;
}

// One shared request slot covers search/detail/toc/content, redirects and alternate hosts.
// hooks（T3 任务层接缝，全部可选、向后兼容）：
//   signal      —— 外部租约/截止信号：触发时等价 SIGINT，中断抓取并把 partial 检查点落盘；
//   onProgress  —— 每次清单检查点（目录解析后、每章后、收尾）回调最新计数；抛错（租约丢失）
//                  立即中断下载，不吞成单章失败。
export async function downloadBook(m, args, resolveSource, transport = fetchSourceText, hooks = {}) {
  const dir = resolve(args.out ?? 'engine-download', hash(args.source + canonicalBookKey(args.title, args.author)).slice(0, 24));
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'download.lock');
  const lock = openSync(lockPath, 'wx');
  const manifestPath = join(dir, 'manifest.json');
  let previous;
  try { previous = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first attempt */ }
  const manifest = { schemaVersion: 1, status: 'partial', title: args.title, author: args.author, source: args.source, chapters: previous?.chapters ?? [], errors: [], generated_at: new Date().toISOString() };
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('interrupted'));
  const external = hooks.signal;
  const onExternalAbort = () => controller.abort(external.reason ?? new Error('interrupted'));
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('budget_exhausted')), args['budget-ms']);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let nextAt = 0;
  let bytes = 0;
  let failureCode = 1;
  let lastCheckpoint = 0;
  // T3×P2 reconcile：两个节拍解耦——manifest 落盘按 5s 节流（P2-4 写放大修复），
  // onProgress 每次调用必发（T3 租约数据通道，每章上报；失权发现延迟不随写盘节流放大）。
  const checkpoint = async (force = true) => {
    manifest.chapters_done = manifest.chapters.filter(c => c.status === 'done').length;
    manifest.chars = manifest.chapters.reduce((n, c) => n + c.chars, 0);
    if (force || Date.now() - lastCheckpoint >= 5000) {
      atomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      lastCheckpoint = Date.now();
    }
    await hooks.onProgress?.({ chaptersDone: manifest.chapters_done, chaptersTotal: manifest.chapters_total ?? manifest.chapters.length, charsTotal: manifest.chars });
  };
  const operation = async fn => {
    const local = new AbortController();
    const timeout = setTimeout(() => local.abort(new Error('operation_timeout')), args['timeout-ms']);
    const signal = AbortSignal.any([controller.signal, local.signal]);
    const context = { signal, page: async url => {
      const page = await transport(url, { signal, timeoutMs: args['timeout-ms'], beforeRequest: async requestSignal => {
      requestSignal.throwIfAborted();
      const now = Date.now(), at = Math.max(now, nextAt);
      nextAt = at + args['rate-ms'];
      if (at > now) await pause(at - now, undefined, { signal: requestSignal });
      requestSignal.throwIfAborted();
      nextAt = Math.max(nextAt, Date.now() + args['rate-ms']);
      } });
      if (new URL(page.url).pathname !== new URL(url).pathname) throw new Error('response_path_mismatch');
      return page;
    } };
    try { signal.throwIfAborted(); return await sourceAbortable(Promise.resolve().then(() => fn(context)), signal); }
    finally { clearTimeout(timeout); local.abort(); }
  };
  try {
    const { source, builtin } = await operation(async ctx => {
      try { return await resolveSource(m, args.source, ctx.signal); }
      catch (error) { if (error.code === 2) failureCode = 2; throw error; }
    });
    manifest.sourceRevision = hash(JSON.stringify(source));
    const engine = builtin ? null : { url: source.url, name: source.name, searchUrl: source.searchUrl, compiled: m.compile.compileSource(source) };
    const candidates = await operation(async ctx => {
      if (!builtin) return m.api.engineSearchBook(engine, args.title, ctx);
      const page = await ctx.page(m.parser.sourceSearchUrl(source.searchUrl, args.title, source.url));
      return m.parser.parseSourceSearch(page.text, page.url, args.title).map(bookUrl => ({ bookUrl }));
    });
    let selected;
    for (const candidate of candidates) {
      const detail = await operation(async ctx => {
        if (!builtin) return m.api.engineFetchDetail(engine, candidate.bookUrl, ctx);
        return m.parser.parseSourceIdentity((await ctx.page(candidate.bookUrl)).text);
      });
      if (detail.title && detail.author && canonicalBookKey(detail.title, detail.author) === canonicalBookKey(args.title, args.author)) { selected = { ...candidate, ...detail }; break; }
    }
    if (!selected) throw new Error('identity_mismatch_or_no_candidate');
    manifest.bookUrl = selected.bookUrl;
    const toc = () => operation(async ctx => {
      if (!builtin) return (await m.api.engineFetchToc(engine, selected.tocUrl ?? selected.bookUrl, ctx, true)).chapters;
      const page = await ctx.page(selected.bookUrl);
      return m.parser.parseSourceChapters(page.text, page.url);
    });
    const chapters = await toc();
    if (!chapters.length) throw new Error('empty_toc');
    manifest.tocHash = hash(JSON.stringify(chapters));
    manifest.chapters_total = chapters.length;
    manifest.chapters = chapters.map((c, index) => ({ index, title: c.title, url: c.url, chars: 0, status: 'pending', file: `${index}.txt` }));
    await checkpoint();
    if (chapters.length > args['max-chapters']) throw new Error('max_chapters');
    const resume = previous?.sourceRevision === manifest.sourceRevision && previous?.tocHash === manifest.tocHash && previous?.bookUrl === manifest.bookUrl;
    for (const chapter of manifest.chapters) {
      controller.signal.throwIfAborted();
      try {
        const path = join(dir, chapter.file);
        const prior = resume && previous.chapters?.[chapter.index];
        let text;
        if (prior?.status === 'done' && existsSync(path)) {
          const cached = readFileSync(path, 'utf8');
          if (hash(cached) === prior.sha256 && cached.trim()) text = cached;
        }
        if (text === undefined) text = await operation(async ctx => {
          if (!builtin) return (await m.api.engineFetchContent(engine, chapter.url, ctx, true)).text;
          return m.parser.parseSourceChapterText((await ctx.page(chapter.url)).text, chapter.title);
        });
        if (!text.trim()) throw new Error('empty_content');
        bytes += Buffer.byteLength(chapter.title + '\n\n' + text + '\n\n');
        if (bytes > MAX_BOOK_BYTES) throw new Error('size_limit');
        atomic(path, text);
        Object.assign(chapter, { status: 'done', chars: [...text].length, sha256: hash(text) });
      } catch (error) {
        chapter.status = 'failed';
        // Do not persist upstream messages, URLs or credentials in diagnostics.
        chapter.error = knownError.test(error.message) ? error.message : 'chapter_failed';
        if (chapter.error === 'size_limit' || controller.signal.aborted) throw error;
      }
      await checkpoint(false);
    }
    if (hash(JSON.stringify(await toc())) !== manifest.tocHash) throw new Error('toc_changed');
    if (manifest.chapters.some(c => c.status !== 'done')) throw new Error('missing_chapters');
    const txt = manifest.chapters.map(c => `${c.title}\n\n${readFileSync(join(dir, c.file), 'utf8')}\n\n`).join('');
    atomic(join(dir, 'book.txt'), txt);
    manifest.artifact = { file: 'book.txt', sha256: hash(txt), bytes: Buffer.byteLength(txt) };
    manifest.status = 'done';
  } catch (error) {
    manifest.errors.push(failureCode === 2 ? 'source_unavailable' : knownError.test(error.message) ? error.message : 'download_failed');
  } finally {
    clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (external) external.removeEventListener?.('abort', onExternalAbort);
    try { await checkpoint(); } finally {
      closeSync(lock); unlinkSync(lockPath);
    }
  }
  return { manifest, manifestPath, code: manifest.status === 'done' ? 0 : failureCode };
}
