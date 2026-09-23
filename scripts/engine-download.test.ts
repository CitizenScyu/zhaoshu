import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as api from '../src/lib/rule-engine/api';
import * as compile from '../src/lib/rule-engine/compile';
import * as parser from '../src/lib/source-parser';
import fixtures from '../src/lib/rule-engine/fixtures/smoke-174.json';
import { SourceHttpError } from '../src/lib/source-fetch';
import { SourcePolicyError } from '../src/lib/source-policy';
import { downloadBook, downloadOptions } from './engine-download.mjs';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(style = 0, failure = '') {
  const out = mkdtempSync(join(tmpdir(), 't4-')); dirs.push(out);
  const rules: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(fixtures[style < 0 ? 0 : style].coreRules)) {
    const [group, field] = key.split('.'); (rules[group] ??= {})[field] = value as string;
  }
  rules.ruleToc.nextTocUrl = '.next@href';
  const source = { url: 'https://book15.net/', name: 'synthetic', searchUrl: '/search?q={{key}}', rules };
  const options = downloadOptions({ source: source.url, title: '测试书', author: '作者甲', out, 'rate-ms': 0, 'timeout-ms': 1000 });
  const book = 'https://book15.net/books/details1.html';
  const author = failure === 'identity' ? '作者乙' : '作者甲';
  const identity = `<h1>测试书</h1><div class="d-info-panel"><a href="/author/1">${author}</a></div><meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="${author}">`;
  const chapter = (n: number) => style < 0 ? `/chapter/index1-${n}.html` : `/read/${n}`;
  const catalog = (n: number) => `<div class="d-chapter-list" id="full-catalog"><dd><a href="${chapter(n)}">第${n}章</a></dd></div>`;
  const search = `<div class="list-item-panel"><h3><a href="${book}">测试书</a></h3><a class="author">作者甲</a></div><li itemprop="mainEntity"><a itemprop="url" href="${book}"><h2 itemprop="name">测试书</h2></a><p itemprop="author">作者甲</p></li>`;
  let tocReads = 0;
  const calls: string[] = [];
  const times: number[] = [];
  const transport = async (url: string, opts: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) => {
    calls.push(url); await opts.beforeRequest?.(opts.signal); times.push(Date.now());
    if (url.includes('/search')) return { url, text: search };
    if (url === book) {
      tocReads++;
      return { url, text: identity + (failure === 'empty' ? '' : catalog(1)) + (style >= 0 ? '<a class="next" href="/page2">next</a>' : catalog(2)) };
    }
    if (url.endsWith('/page2')) return { url, text: failure === 'changed' ? '<div>new layout</div>' : catalog(failure === 'cycle' ? 1 : failure === 'toc_changed' && tocReads > 2 ? 3 : 2) + (failure === 'cycle' ? '<a class="next" href="/page2">next</a>' : '') };
    if (failure === 'timeout' && url.endsWith('/2')) return new Promise<{url: string; text: string}>((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    return { url, text: `<li class="chapter-content" id="article-content">${failure === 'blank' ? '' : '<p>合成正文，离线测试。</p>'}</li>` };
  };
  vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
  const builtin = style < 0;
  const run = (selectedTransport = transport) => downloadBook({ api, compile, parser }, options, async () => ({ source, builtin }), selectedTransport);
  return { run, options, calls, times, transport, source, builtin };
}

describe('download offline full books', () => {
  it.each([-1, 0, 1])('builtin / fixture source %s completes and resumes', async style => {
    const f = setup(style); const result = await f.run();
    expect(result.code).toBe(0); expect(result.manifest.chapters.filter((c: {status: string}) => c.status === 'done').length).toBe(2);
    expect(readFileSync(result.manifestPath, 'utf8')).toContain('done');
    f.calls.length = 0; expect((await f.run()).code).toBe(0);
    expect(f.calls.some(url => /\/read\/|\/chapter\//.test(url))).toBe(false);
  });
  it.each(['identity', 'empty', 'cycle', 'changed', 'blank', 'timeout', 'toc_changed'])('%s never returns done', async failure => {
    const f = setup(0, failure); if (failure === 'timeout') f.options['timeout-ms'] = 20;
    const r = await f.run(); expect(r.code).toBe(1); expect(r.manifest.status).toBe('partial');
    expect(JSON.parse(readFileSync(r.manifestPath, 'utf8')).status).toBe('partial');
  });
  it.each(['invalid_chapter', 'invalid_next_page', 'empty_content_page', 'content_page_limit', 'unsupported_content_rule'])('preserves safe diagnostic %s', async reason => {
    const f = setup();
    const result = await f.run(async () => { throw new Error(reason); });
    expect(result.manifest.errors).toEqual([reason]);
    const chapters = await f.run(async (url, opts) => {
      if (url.includes('/read/')) throw new Error(reason);
      return f.transport(url, opts);
    });
    expect(chapters.manifest.chapters.every((c: {error: string}) => c.error === reason)).toBe(true);
  });
  it('accepts a fully overlapping catalog page and continues to a new page', async () => {
    const f = setup();
    const result = await f.run(async (url, opts) => {
      const page = await f.transport(url, opts);
      if (url.endsWith('/page2')) return { url, text: '<div class="d-chapter-list"><dd><a href="/read/1">第1章</a></dd></div><a class="next" href="/page3">next</a>' };
      if (url.endsWith('/page3')) return { url, text: '<div class="d-chapter-list"><dd><a href="/read/2">第2章</a></dd></div>' };
      return page;
    });
    expect(result.code).toBe(0);
    expect(result.manifest.chapters).toHaveLength(2);
  });
  it('source resolution inability returns 2 without persisting upstream details', async () => {
    const f = setup();
    const result = await downloadBook({}, f.options, async () => {
      throw Object.assign(new Error('synthetic private connection detail'), { code: 2 });
    });
    expect(result.code).toBe(2);
    expect(result.manifest.errors).toEqual(['source_unavailable']);
    expect(readFileSync(result.manifestPath, 'utf8')).not.toContain('private connection');
  });
  it('max chapters fails before fetching chapters', async () => {
    const f = setup(); f.options['max-chapters'] = 1;
    const r = await f.run(); expect(r.code).toBe(1); expect(r.manifest.errors).toContain('max_chapters');
    expect(f.calls.some(url => url.includes('/read/'))).toBe(false);
  });
  it('total budget preserves partial checkpoint', async () => {
    const f = setup(0, 'timeout'); f.options['budget-ms'] = 30;
    expect((await f.run()).manifest.status).toBe('partial');
  });
  it('pre-toc interruption preserves previous completed chapter records', async () => {
    const f = setup();
    const first = await f.run();
    expect(first.code).toBe(0);
    f.options['budget-ms'] = 20;
    const interrupted = await f.run((_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    }));
    expect(interrupted.code).toBe(1);
    const saved = JSON.parse(readFileSync(first.manifestPath, 'utf8'));
    expect(saved.chapters).toHaveLength(2);
    expect(saved.chapters.every((chapter: {status: string}) => chapter.status === 'done')).toBe(true);
  });
  it('rejects builtin chapter redirects to another book path', async () => {
    const f = setup(-1);
    const redirected = async (url: string, opts: Parameters<typeof f.transport>[1]) => {
      const page = await f.transport(url, opts);
      return url.includes('/chapter/') ? { ...page, url: 'https://book15.net/other-book/chapter.html' } : page;
    };
    const result = await f.run(redirected);
    expect(result.code).toBe(1);
    expect(result.manifest.status).toBe('partial');
  });
  it('rejects toc pagination redirects to another book path', async () => {
    const f = setup();
    const redirected = async (url: string, opts: Parameters<typeof f.transport>[1]) => {
      const page = await f.transport(url, opts);
      return url.endsWith('/page2') ? { ...page, url: 'https://book15.net/other-book/catalog.html' } : page;
    };
    const result = await f.run(redirected);
    expect(result.code).toBe(1);
    expect(result.manifest.status).toBe('partial');
  });
  it('SIGINT preserves partial checkpoint and removes listeners', async () => {
    const f = setup(0, 'timeout'); const before = process.listenerCount('SIGINT');
    const timer = setTimeout(() => process.emit('SIGINT'), 30);
    const r = await f.run(); clearTimeout(timer);
    expect(r.code).toBe(1); expect(process.listenerCount('SIGINT')).toBe(before);
  });
  it('shared limiter spans every phase and both catalog passes', async () => {
    const f = setup(); f.options['rate-ms'] = 15;
    expect((await f.run()).code).toBe(0);
    for (let i = 1; i < f.times.length; i++) expect(f.times[i] - f.times[i - 1]).toBeGreaterThanOrEqual(12);
  });
  it('hanging child operation terminates with partial and exit 1', () => {
    const out = mkdtempSync(join(tmpdir(), 't4-child-')); dirs.push(out);
    const runner = join(out, 'runner.mjs');
    writeFileSync(runner, `import { downloadBook, downloadOptions } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/engine-download.mjs')).href)};
      const args = downloadOptions({source:'book15.net',title:'x',author:'y',out:${JSON.stringify(out)},'timeout-ms':25});
      const m = { compile: { compileSource: () => new Map() }, api: { engineSearchBook: () => new Promise(() => {}) } };
      const r = await downloadBook(m,args,async () => ({source:{url:args.source,rules:{}},builtin:false}));
      console.log(JSON.stringify(r)); process.exit(r.code);`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'scripts/ts-esm-loader.mjs')).href, runner], { encoding: 'utf8', timeout: 5000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout).manifest.status).toBe('partial');
  });
  it('strict facade rejects page caps and invalid next links', async () => {
    const source = { url: 'https://book15.net/', name:'fixture', searchUrl:'', compiled: compile.compileSource({url:'https://book15.net/',searchUrl:'',rules:{ruleToc:{chapterList:'a.chapter',chapterName:'@text',chapterUrl:'@href',nextTocUrl:'a.next@href'}}}) };
    let n = 0;
    const context = { page: async (url: string) => ({url,text:`<a class="chapter" href="/c${++n}">章</a><a class="next" href="/page${n}">next</a>`}) };
    await expect(api.engineFetchToc(source,source.url,context as unknown as Parameters<typeof api.engineFetchToc>[2],true)).rejects.toThrow('toc_limit');
    expect(n).toBe(20);
  });
  it('validates numeric limits and required identity', () => {
    expect(() => downloadOptions({})).toThrow();
    expect(() => downloadOptions({ source: 'book15.net', title: 'x', author: 'y', 'max-chapters': -1 })).toThrow();
  });
  it('onProgress 每章必发；<5s 章级 checkpoint 不落盘；finally 强制落盘', async () => {
    const f = setup();
    const progress: { chaptersDone: number; diskChaptersDone: number | null; mtimeMs: number | null; content: string | null }[] = [];
    const findManifest = () => {
      const sub = readdirSync(f.options.out as string).find(name => existsSync(join(f.options.out as string, name, 'manifest.json')));
      return sub ? join(f.options.out as string, sub, 'manifest.json') : null;
    };
    const result = await downloadBook({ api, compile, parser }, f.options, async () => ({ source: f.source, builtin: f.builtin }), f.transport, {
      onProgress: async (update: { chaptersDone: number; chaptersTotal: number; charsTotal: number }) => {
        const path = findManifest();
        const content = path && existsSync(path) ? readFileSync(path, 'utf8') : null;
        progress.push({
          chaptersDone: update.chaptersDone,
          diskChaptersDone: content ? JSON.parse(content).chapters_done : null,
          mtimeMs: path && existsSync(path) ? statSync(path).mtimeMs : null,
          content,
        });
      },
    });
    expect(result.code).toBe(0);
    // toc 解析 + 2 章 + finally 收尾：删掉「onProgress 在节流外必发」即少两次章级回调。
    expect(progress).toHaveLength(4);
    expect(progress.map(p => p.chaptersDone)).toEqual([0, 1, 2, 2]);
    // 相邻两次章级 checkpoint 间隔 <<5s：磁盘内容/mtime 相对 toc 落盘不变，回调计数仍递增。
    expect(progress[1].content).toBe(progress[0].content);
    expect(progress[2].content).toBe(progress[0].content);
    expect(progress[1].mtimeMs).toBe(progress[0].mtimeMs);
    expect(progress[2].mtimeMs).toBe(progress[0].mtimeMs);
    expect(progress[1].diskChaptersDone).toBe(0);
    expect(progress[2].diskChaptersDone).toBe(0);
    // finally 强制落盘：最后一次磁盘计数与内存一致。
    expect(progress[3].diskChaptersDone).toBe(2);
    expect(progress[3].content).not.toBe(progress[0].content);
    const saved = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    expect(saved.chapters_done).toBe(2);
    expect(saved.chapters.filter((c: { status: string }) => c.status === 'done')).toHaveLength(2);
  });
});

// 41-PAGEFIX:cuoceng 同型源(每章一页,#linkNext 指向下一章;末章回绕到首章)——正文翻页遇下一章即停。
describe('engine content pagination stops at the next chapter (41-PAGEFIX)', () => {
  it('⑥ 下载 3 章 ⇒ 每章正文正确、不串章，每章只请求本章 1 页(末章按 legado 回退第 0 章判据停止)', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pagefix-')); dirs.push(out);
    const rules = {
      ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
      ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
      ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '#content@text', nextContentUrl: '#linkNext@href' },
    };
    const source = { url: 'https://book15.net/cc/', name: 'cuoceng 同型', searchUrl: 'https://book15.net/cc/so/{{key}}.html', rules };
    const options = downloadOptions({ source: source.url, title: '测试书', author: '作者甲', out, 'rate-ms': 0, 'timeout-ms': 1000 });
    const chapter = (n: number) => `https://book15.net/cc/b/${n}.html`;
    const pages = new Map<string, string>([
      [`https://book15.net/cc/so/${encodeURIComponent('测试书')}.html`, '<div class="book"><span class="name">测试书</span><span class="author">作者甲</span><a href="/cc/b.html">x</a></div>'],
      ['https://book15.net/cc/b.html', '<h1 class="title">测试书</h1><span class="writer">作者甲</span><a class="toc" href="/cc/b/toc.html">目录</a>'],
      ['https://book15.net/cc/b/toc.html', [1, 2, 3].map(n => `<li class="chapter"><a href="/cc/b/${n}.html">第${n}章</a></li>`).join('')],
      // 第 1、2 章的 linkNext 指向下一章;第 3 章(末章)回绕到第 1 章。
      ...[1, 2, 3].map(n => [chapter(n), `<div id="content">第${n}章正文</div><a id="linkNext" href="/cc/b/${n === 3 ? 1 : n + 1}.html">下一章</a>`] as [string, string]),
    ]);
    const calls: string[] = [];
    const transport = async (url: string, opts: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) => {
      calls.push(url); await opts.beforeRequest?.(opts.signal);
      const text = pages.get(url);
      if (text === undefined) throw new Error('unexpected request');
      return { url, text };
    };
    vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
    const result = await downloadBook({ api, compile, parser }, options, async () => ({ source, builtin: false }), transport);
    expect(result.code).toBe(0);
    expect(result.manifest.status).toBe('done');
    const dir = dirname(result.manifestPath);
    expect([0, 1, 2].map(i => readFileSync(join(dir, `${i}.txt`), 'utf8'))).toEqual(['第1章正文', '第2章正文', '第3章正文']);
    // 正文页各请求一次，从不为「下一章」多抓一页。
    expect(calls.filter(url => /\/cc\/b\/\d+\.html$/.test(url))).toEqual([chapter(1), chapter(2), chapter(3)]);
  });
});

// 41-EXEC-SRCUNAVAIL：搜索/详情/目录阶段的传输层失败与源站 5xx 归 code=2 source_unavailable
// （与 resolveSource code=2 同档：可重试、零发布）；4xx、策略拒绝、其余异常与正文阶段维持原分类。
describe('书源不可达分类（41-EXEC-SRCUNAVAIL）', () => {
  const BOOK = 'https://book15.net/books/details1.html';
  // failure_stage 是 catch 里补上的 manifest 字段，JS 推断的字面量类型里没有。
  const stageOf = (result: { manifest: object }) => (result.manifest as { failure_stage?: string }).failure_stage;
  const unavailable: [string, () => unknown][] = [
    ['ConnectTimeoutError', () => new DOMException('书源连接超时', 'ConnectTimeoutError')],
    ['TimeoutError', () => new DOMException('书源请求及正文读取超时', 'TimeoutError')],
    ['fetch failed（DNS）', () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })],
    ['fetch failed（reset）', () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })],
    ['HTTP 500', () => new SourceHttpError(500)],
    ['HTTP 503', () => new SourceHttpError(503)],
    ['Cloudflare 522', () => new SourceHttpError(522)],
    ['限速器熔断', () => Object.assign(new Error('源 book15.net 熔断中'), { name: 'CircuitOpenError' })],
    ['限速器每源日请求上限', () => Object.assign(new Error('源 book15.net 当日请求预算触顶（20000）'), { name: 'DailyRequestBudgetError' })],
  ];
  // 第 n 次请求详情页 URL：builtin/引擎两腿的详情与目录都取同一页（1=详情，2=目录，3=收尾复核目录）。
  const failAt = (f: ReturnType<typeof setup>, stage: 'search' | 'detail' | 'toc' | 'recheck', error: () => unknown) => {
    let bookReads = 0;
    return async (url: string, opts: Parameters<typeof f.transport>[1]) => {
      if (url === BOOK) bookReads += 1;
      const hit = stage === 'search' ? url.includes('/search')
        : url === BOOK && bookReads === { detail: 1, toc: 2, recheck: 3 }[stage];
      if (hit) throw error();
      return f.transport(url, opts);
    };
  };

  it.each(unavailable.flatMap(([name, error]) => [-1, 0].map(style => [name, style, error] as const)))(
    '搜索阶段 %s（style %s）⇒ code=2、source_unavailable、零章', async (_name, style, error) => {
      const f = setup(style);
      const result = await f.run(failAt(f, 'search', error));
      expect(result.code).toBe(2);
      expect(result.manifest.errors).toEqual(['source_unavailable']);
      expect(stageOf(result)).toBe('search');
      expect(result.manifest.status).toBe('partial');
      expect(result.manifest.chapters).toHaveLength(0);
    });

  it.each((['detail', 'toc', 'recheck'] as const).flatMap(stage => [
    [stage, 'ConnectTimeoutError', () => new DOMException('书源连接超时', 'ConnectTimeoutError')],
    [stage, 'Cloudflare 522', () => new SourceHttpError(522)],
    [stage, 'fetch failed', () => new TypeError('fetch failed')],
  ] as const))('%s 阶段 %s ⇒ code=2、source_unavailable', async (stage, _name, error) => {
    const f = setup(-1);
    const result = await f.run(failAt(f, stage, error));
    expect(result.code).toBe(2);
    expect(result.manifest.errors).toEqual(['source_unavailable']);
    expect(stageOf(result)).toBe(stage === 'recheck' ? 'toc' : stage);
    expect(result.manifest.status).toBe('partial');
  });

  it.each([
    ['HTTP 404', () => new SourceHttpError(404)],
    ['HTTP 403', () => new SourceHttpError(403)],
    ['HTTP 429', () => new SourceHttpError(429)],
    ['策略拒绝', () => new SourcePolicyError('书源跳转次数超限')],
    ['未归类异常', () => new Error('boom')],
    ['非传输 TypeError', () => new TypeError('The encoded data was not valid for encoding utf-8')],
  ])('搜索阶段 %s ⇒ 维持 download_failed（code=1）', async (_name, error) => {
    const f = setup(-1);
    const result = await f.run(failAt(f, 'search', error));
    expect(result.code).toBe(1);
    expect(result.manifest.errors).toEqual(['download_failed']);
    expect(stageOf(result)).toBeUndefined();
  });

  it('身份不符维持 identity_mismatch_or_no_candidate（code=1）', async () => {
    const f = setup(-1, 'identity');
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.manifest.errors).toEqual(['identity_mismatch_or_no_candidate']);
  });

  it('正文阶段的传输层失败不改判：逐章失败后仍是 missing_chapters（code=1）', async () => {
    const f = setup(-1);
    const result = await f.run(async (url, opts) => {
      if (url.includes('/chapter/')) throw new DOMException('书源连接超时', 'ConnectTimeoutError');
      return f.transport(url, opts);
    });
    expect(result.code).toBe(1);
    expect(result.manifest.errors).toEqual(['missing_chapters']);
  });
});
