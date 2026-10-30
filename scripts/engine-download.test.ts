import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { peerOutRoots, seedFromPeers } from '../runtime-download/resume-seed';
import { breakerYield, chapterResume, contentFailStreak, contentRetryPasses, contentStopBookPages, downloadBook, downloadOptions, hostBurstPause, policyCodeOf, recheckYield } from './engine-download.mjs';

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
  it('opaque error degrades to download_failed with sanitized constructor name (dlfail42)', async () => {
    const f = setup();
    const result = await f.run(async () => { throw new TypeError('synthetic opaque detail'); });
    expect(result.code).toBe(1);
    expect(result.manifest.errors).toEqual(['download_failed']);
    // failure_name 同 failure_stage：catch 里补上的字段，JS 推断的字面量类型里没有。
    expect((result.manifest as { failure_name?: string }).failure_name).toBe('TypeError');
    // diag1030：同时记阶段（首个出网即搜索）；无 code 的错误不落 failure_code。
    expect((result.manifest as { failure_phase?: string }).failure_phase).toBe('search');
    expect((result.manifest as { failure_code?: string }).failure_code).toBeUndefined();
    // 上游消息原文绝不落盘；只有构造器名这个固定类别。
    expect(readFileSync(result.manifestPath, 'utf8')).not.toContain('synthetic opaque detail');
    expect(readFileSync(result.manifestPath, 'utf8')).toContain('TypeError');
  });
  it('diag1030：只记常量形态的 error.code，上游文本不落盘', async () => {
    const f = setup();
    const ruleError = (code: string) => Object.assign(new Error('synthetic upstream rule text'), { name: 'RuleEngineError', code });
    const result = await f.run(async () => { throw ruleError('RULE_EVAL_FAILED'); });
    const manifest = result.manifest as { failure_name?: string; failure_phase?: string; failure_code?: string };
    expect(result.manifest.errors).toEqual(['download_failed']);
    expect([manifest.failure_name, manifest.failure_code, manifest.failure_phase]).toEqual(['RuleEngineError', 'RULE_EVAL_FAILED', 'search']);
    expect(readFileSync(result.manifestPath, 'utf8')).not.toContain('synthetic upstream rule text');
    const odd = await f.run(async () => { throw ruleError('not a constant: x'); });
    expect((odd.manifest as { failure_code?: string }).failure_code).toBeUndefined();
    expect(readFileSync(odd.manifestPath, 'utf8')).not.toContain('not a constant');
  });
  it('diag1031：SourcePolicyError 按关键词归成固定码，原文不落盘', async () => {
    expect([
      '书源正文页被安全验证拦截，请重试或更换书源', '书源已退休：不再对该来源发起请求', '不支持该书源的字段 JS（java.ajax 页面过大）',
      '书源正文跳转到了目录中的其他章节，请重试或更换书源', '书源目录后续页未提供有效章节，请重试或更换书源', '书源跳转次数超限',
      '书源响应体积超限', '不支持该书源的搜索选项：webView', '来源仅支持 HTTPS 完整地址', '别的', undefined,
    ].map(policyCodeOf)).toEqual([
      'POLICY_CHALLENGE', 'POLICY_RETIRED', 'POLICY_FIELD_JS', 'POLICY_CONTENT', 'POLICY_TOC', 'POLICY_REDIRECT',
      'POLICY_SIZE', 'POLICY_SEARCH_RULE', 'POLICY_URL', 'POLICY_OTHER', 'POLICY_OTHER',
    ]);
    const f = setup();
    const policyError = Object.assign(new Error('不支持该书源的搜索 JS（synthetic upstream）'), { name: 'SourcePolicyError' });
    const result = await f.run(async () => { throw policyError; });
    const manifest = result.manifest as { failure_name?: string; failure_phase?: string; failure_code?: string };
    expect([manifest.failure_name, manifest.failure_code, manifest.failure_phase]).toEqual(['SourcePolicyError', 'POLICY_SEARCH_RULE', 'search']);
    expect(readFileSync(result.manifestPath, 'utf8')).not.toContain('synthetic upstream');
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

// dlstop42:下载器停止点 = 整本目录(manifest.chapters 全部 url)。三个场景对齐 rvreaderstop42 §1 的非阻断 1:
// a) 站点「下一章」链指向目录**非相邻**章(cuoceng《鬼吹灯》型,目录序 0→3→2→4)⇒ 只传目录下一章拦不住,
//    整本目录下每章文件只含本章;b) 真·章内分页(下一页不在目录)⇒ 仍拼页;c) 单章书行为不变(停止点含本章自身
//    也无害:engineFetchContent 对数组剔除本章,循环内不会导航回本章)。
describe('下载器逐章停止点 = 整本目录（dlstop42）', () => {
  const rules = {
    ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '#content@text', nextContentUrl: '#linkNext@href' },
  };
  const source = { url: 'https://book15.net/cc/', name: 'cuoceng 同型', searchUrl: 'https://book15.net/cc/so/{{key}}.html', rules };
  const chapter = (n: number) => `https://book15.net/cc/b/${n}.html`;
  const tocPage = (ns: number[]) => ns.map(n => `<li class="chapter"><a href="/cc/b/${n}.html">第${n}章</a></li>`).join('');
  const body = (text: string, next?: string) =>
    `<div id="content">${text}</div>` + (next === undefined ? '' : `<a id="linkNext" href="${next}">下一章</a>`);

  /** 夹具书:目录序 [0,1,2,3,4],正文页「下一章」链 0→3→2→4→(无)。第 0 章的下一章链指向目录第 3 章(非相邻)。 */
  function interleavedPages(): Map<string, string> {
    return new Map<string, string>([
      [`https://book15.net/cc/so/${encodeURIComponent('测试书')}.html`, '<div class="book"><span class="name">测试书</span><span class="author">作者甲</span><a href="/cc/b.html">x</a></div>'],
      ['https://book15.net/cc/b.html', '<h1 class="title">测试书</h1><span class="writer">作者甲</span><a class="toc" href="/cc/b/toc.html">目录</a>'],
      ['https://book15.net/cc/b/toc.html', tocPage([0, 1, 2, 3, 4])],
      [chapter(0), body('第0章正文', '/cc/b/3.html')],
      [chapter(3), body('第3章正文', '/cc/b/2.html')],
      [chapter(2), body('第2章正文', '/cc/b/4.html')],
      [chapter(4), body('第4章正文')],
      [chapter(1), body('第1章正文')],
    ]);
  }

  async function runDownload(pages: Map<string, string>) {
    const out = mkdtempSync(join(tmpdir(), 'dlstop-')); dirs.push(out);
    const options = downloadOptions({ source: source.url, title: '测试书', author: '作者甲', out, 'rate-ms': 0, 'timeout-ms': 1000 });
    const calls: string[] = [];
    const transport = async (url: string, opts: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) => {
      calls.push(url); await opts.beforeRequest?.(opts.signal);
      const text = pages.get(url);
      if (text === undefined) throw new Error('unexpected request');
      return { url, text };
    };
    vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
    const result = await downloadBook({ api, compile, parser }, options, async () => ({ source, builtin: false }), transport);
    return { result, calls, dir: dirname(result.manifestPath) };
  }
  const chapterCalls = (calls: string[]) => calls.filter(url => /\/cc\/b\/\d+(_\d+)?\.html$/.test(url));

  it('a) 目录序≠下一章链序:每章文件只含本章正文,每章只请求本章 1 页', async () => {
    const { result, calls, dir } = await runDownload(interleavedPages());
    expect(result.code).toBe(0);
    expect(result.manifest.status).toBe('done');
    // 目录序 [0,1,2,3,4]:第 0/1/2/3 章的 linkNext 都指向目录里的某章(0→3、3→2、2→4),必须在第 0 页后即停。
    expect([0, 1, 2, 3, 4].map(i => readFileSync(join(dir, `${i}.txt`), 'utf8'))).toEqual(['第0章正文', '第1章正文', '第2章正文', '第3章正文', '第4章正文']);
    expect(chapterCalls(calls)).toEqual([chapter(0), chapter(1), chapter(2), chapter(3), chapter(4)]);
    // 整本拼接:book.txt 也只有五章各自身。
    expect(readFileSync(join(dir, 'book.txt'), 'utf8')).toBe(
      ['第0章', '第1章', '第2章', '第3章', '第4章'].map((t, i) => `${t}\n\n第${i}章正文\n\n`).join(''));
  });

  it('b) 真章内分页(下一页不在目录)⇒ 仍照常拼页', async () => {
    const pages = interleavedPages();
    // 第 1 章拆成两页:第 1 页 linkNext 指向 1_2.html(目录里没有),第 2 页才指向第 2 章。
    pages.set(chapter(1), body('第1章上半', '/cc/b/1_2.html'));
    pages.set('https://book15.net/cc/b/1_2.html', body('第1章下半', '/cc/b/2.html'));
    const { result, calls, dir } = await runDownload(pages);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, '1.txt'), 'utf8')).toBe('第1章上半\n第1章下半');
    // 第 1 章请求两页(本章 + 章内第 2 页),其余章仍各 1 页。
    expect(chapterCalls(calls)).toEqual([chapter(0), chapter(1), 'https://book15.net/cc/b/1_2.html', chapter(2), chapter(3), chapter(4)]);
  });

  it('c) 单章书:行为不变(正常完成,不因停止点含本章自身而中断)', async () => {
    const pages = new Map<string, string>([
      [`https://book15.net/cc/so/${encodeURIComponent('测试书')}.html`, '<div class="book"><span class="name">测试书</span><span class="author">作者甲</span><a href="/cc/b.html">x</a></div>'],
      ['https://book15.net/cc/b.html', '<h1 class="title">测试书</h1><span class="writer">作者甲</span><a class="toc" href="/cc/b/toc.html">目录</a>'],
      ['https://book15.net/cc/b/toc.html', tocPage([7])],
      // 唯一章的 linkNext 回绕到自身(站点末章常回绕首章;这里首章=本章)。
      [chapter(7), body('第7章正文', '/cc/b/7.html')],
    ]);
    const { result, calls, dir } = await runDownload(pages);
    expect(result.code).toBe(0);
    expect(result.manifest.status).toBe('done');
    expect(readFileSync(join(dir, '0.txt'), 'utf8')).toBe('第7章正文');
    expect(chapterCalls(calls)).toEqual([chapter(7)]);
  });

  // stopbook1031：末章「下一章」指回详情页/目录页（m.cuoceng 实网形态）。开关关 = 旧口径（详情页按正文规则取空
  // → empty_content_page → 整本 missing_chapters）；开 = 停在详情/目录页，末章只含本章正文、整本 done。
  describe('stopbook1031 末章下一章回详情/目录页', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    const bookPage = 'https://book15.net/cc/b.html';
    const tocUrl = 'https://book15.net/cc/b/toc.html';
    const lastBackTo = (href: string) => { const pages = interleavedPages(); pages.set(chapter(4), body('第4章正文', href)); return pages; };
    // 落点页在正文阶段之外的固有请求次数：详情页 1 次（详情），目录页 2 次（目录 + 收尾复核目录）。
    const cases = [['详情页', '/cc/b.html', bookPage, 1], ['目录页', '/cc/b/toc.html', tocUrl, 2]] as const;

    it.each(cases)('关：末章回%s ⇒ empty_content_page 缺章（零行为变化）', async (_, href, landing, base) => {
      const { result, calls } = await runDownload(lastBackTo(href));
      expect(result.manifest.errors).toEqual(['missing_chapters']);
      expect((result.manifest.chapters[4] as { error?: string }).error).toBe('empty_content_page');
      expect(calls.filter(url => url === landing)).toHaveLength(base + 1);
    });

    it.each(cases)('开：末章回%s ⇒ 停在本章，整本 done', async (_, href, landing, base) => {
      vi.stubEnv('DOWNLOAD_CONTENT_STOP_BOOK_PAGES', '1');
      const { result, calls, dir } = await runDownload(lastBackTo(href));
      expect(result.code).toBe(0);
      expect(result.manifest.status).toBe('done');
      expect(readFileSync(join(dir, '4.txt'), 'utf8')).toBe('第4章正文');
      expect(calls.filter(url => url === landing)).toHaveLength(base);
    });

    it('开：单章书不并入（沿用旧口径字符串停止点）', async () => {
      vi.stubEnv('DOWNLOAD_CONTENT_STOP_BOOK_PAGES', '1');
      const pages = new Map<string, string>([
        [`https://book15.net/cc/so/${encodeURIComponent('测试书')}.html`, '<div class="book"><span class="name">测试书</span><span class="author">作者甲</span><a href="/cc/b.html">x</a></div>'],
        [bookPage, '<h1 class="title">测试书</h1><span class="writer">作者甲</span><a class="toc" href="/cc/b/toc.html">目录</a>'],
        [tocUrl, tocPage([7])],
        [chapter(7), body('第7章正文', '/cc/b/7.html')],
      ]);
      const { result, calls } = await runDownload(pages);
      expect(result.code).toBe(0);
      expect(chapterCalls(calls)).toEqual([chapter(7)]);
    });

    it.each([['1', true], [' 1 ', true], ['0', false], ['', false], ['true', false]] as const)('%j 解析为 %s', (value, on) => {
      vi.stubEnv('DOWNLOAD_CONTENT_STOP_BOOK_PAGES', value);
      expect(contentStopBookPages()).toBe(on);
    });
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

  // 41-src403：403/429 从「download_failed 终态」改判 source_unavailable（可重试退避）。
  // Cloudflare challenge 常阶段性放行（noveltri 详情页对 phoenix 出网 403、同刻搜索页 200），
  // 旧分类把这类书直接打 failed 且不退避。判别力：删掉 isSourceUnavailableError 的 403/429
  // 分支，本组回到 code=1 失败。
  it.each([
    ['HTTP 403', () => new SourceHttpError(403)],
    ['HTTP 429', () => new SourceHttpError(429)],
  ])('搜索阶段 %s ⇒ 改判 source_unavailable（code=2，41-src403）', async (_name, error) => {
    const f = setup(-1);
    const result = await f.run(failAt(f, 'search', error));
    expect(result.code).toBe(2);
    expect(result.manifest.errors).toEqual(['source_unavailable']);
    expect(stageOf(result)).toBe('search');
    expect(result.manifest.status).toBe('partial');
  });

  it('身份不符维持 identity_mismatch_or_no_candidate（code=1）', async () => {
    const f = setup(-1, 'identity');
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.manifest.errors).toEqual(['identity_mismatch_or_no_candidate']);
  });

  // 41-IDLENIENT（2026-10-07）：判据与阅读器 sourceBookMatches 同口径，修复旧严格判据把阅读器能读的书判成不符。
  describe('身份判据与阅读器同口径（41-IDLENIENT）', () => {
    function engineSetup(searchAuthor: string, detailHtml: string, title = '凡人修仙传', author = '忘语') {
      const out = mkdtempSync(join(tmpdir(), 'tidl-')); dirs.push(out);
      const rules: Record<string, Record<string, string>> = {};
      for (const [key, value] of Object.entries(fixtures[0].coreRules)) {
        const [group, field] = key.split('.'); (rules[group] ??= {})[field] = value as string;
      }
      const source = { url: 'https://book15.net/', name: 'synthetic', searchUrl: '/search?q={{key}}', rules };
      const options = downloadOptions({ source: source.url, title, author, out, 'rate-ms': 0, 'timeout-ms': 1000 });
      const book = 'https://book15.net/books/details1.html';
      const search = `<div class="list-item-panel"><h3><a href="${book}">${title}</a></h3><a class="author">${searchAuthor}</a></div>`;
      const catalog = '<div class="d-chapter-list" id="full-catalog"><dd><a href="/read/1">第1章</a></dd></div>';
      const transport = async (url: string) => {
        if (url.includes('/search')) return { url, text: search };
        if (url === book) return { url, text: detailHtml + catalog };
        return { url, text: '<li class="chapter-content" id="article-content"><p>合成正文，离线测试。</p></li>' };
      };
      vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
      return () => downloadBook({ api, compile, parser }, options, async () => ({ source, builtin: false }), transport);
    }

    it('站点详情页作者带「著」修饰 ⇒ 判为同一本书并完成下载', async () => {
      // book.qq 形态：详情页作者「忘语 著」，任务作者「忘语」。
      const run = engineSetup('忘语', '<h1>凡人修仙传</h1><div class="d-info-panel"><a href="/author/1">忘语 著</a></div>');
      const result = await run();
      expect(result.code).toBe(0);
      expect(result.manifest.status).toBe('done');
    });

    it('详情页无书名/作者规则（kxdu 形态 detail={}）⇒ 回落到搜索候选行，判为同一本书', async () => {
      const run = engineSetup('南派三叔', '<div class="d-info-panel"><p>简介…</p></div>', '盗墓笔记', '南派三叔');
      const result = await run();
      expect(result.code).toBe(0);
      expect(result.manifest.status).toBe('done');
    });

    it('详情页无书名/作者规则且搜索候选作者不符 ⇒ 仍判身份不符', async () => {
      const run = engineSetup('旁人甲', '<div class="d-info-panel"><p>简介…</p></div>', '盗墓笔记', '南派三叔');
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.manifest.errors).toEqual(['identity_mismatch_or_no_candidate']);
    });
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

describe('物理 host 占位门拒绝透传', () => {
  const gateError = (code: 'HOST_OCCUPIED' | 'HOST_OCCUPANCY_UNAVAILABLE') =>
    Object.assign(new Error('synthetic gate rejection'), { code });
  const dirOf = (f: ReturnType<typeof setup>): string => {
    const out = f.options.out as string;
    const sub = readdirSync(out).find(name => existsSync(join(out, name, 'manifest.json')));
    if (!sub) throw new Error('manifest dir missing');
    return join(out, sub);
  };

  it.each(['HOST_OCCUPIED', 'HOST_OCCUPANCY_UNAVAILABLE'] as const)('搜索阶段 %s 原样上抛', async code => {
    const f = setup(0);
    const error = gateError(code);
    await expect(f.run(async (url, opts) => {
      if (url.includes('/search')) throw error;
      return f.transport(url, opts);
    })).rejects.toBe(error);
    const saved = JSON.parse(readFileSync(join(dirOf(f), 'manifest.json'), 'utf8'));
    expect(saved.status).toBe('partial');
    expect(saved.chapters).toHaveLength(0);
    expect(saved.errors).toEqual([]);
  });

  it.each(['HOST_OCCUPIED', 'HOST_OCCUPANCY_UNAVAILABLE'] as const)('正文阶段 %s 停止，不标坏章、不请求下一章', async code => {
    const f = setup(0);
    const error = gateError(code);
    await expect(f.run(async (url, opts) => {
      if (url.endsWith('/read/1')) throw error;
      return f.transport(url, opts);
    })).rejects.toBe(error);
    expect(f.calls.some(url => url.endsWith('/read/2'))).toBe(false);
    const saved = JSON.parse(readFileSync(join(dirOf(f), 'manifest.json'), 'utf8'));
    expect(saved.chapters).toHaveLength(2);
    expect(saved.chapters.every((chapter: { status: string }) => chapter.status === 'pending')).toBe(true);
    expect(saved.errors).toEqual([]);
    expect(existsSync(join(dirOf(f), 'download.lock'))).toBe(false);
    expect((await f.run()).code).toBe(0);
  });

  it('同文案但无稳定 code 仍按普通章节失败收口', async () => {
    const f = setup(0);
    const result = await f.run(async (url, opts) => {
      if (url.endsWith('/read/1')) throw new Error('host occupied: synthetic.test');
      return f.transport(url, opts);
    });
    expect(result.code).toBe(1);
    expect(result.manifest.errors).toEqual(['missing_chapters']);
    expect(result.manifest.chapters[0].error).toBe('chapter_failed');
  });
});

describe('vipwall42 付费墙预览截断识别', () => {
  const bigCatalog = (n: number) => `<div class="d-chapter-list" id="full-catalog">${Array.from({ length: n }, (_, i) => `<dd><a href="/read/${i + 1}">第${i + 1}章</a></dd>`).join('')}</div>`;
  const previewText = '预'.repeat(280);
  const fullText = '正'.repeat(2200);
  const wrap = (f: ReturnType<typeof setup>, catalogChapters: number, body: string) => async (url: string, opts: { signal: AbortSignal; beforeRequest?: (s: AbortSignal) => Promise<void> }) => {
    if (url.includes('/search')) return { url, text: `<div class="list-item-panel"><h3><a href="https://book15.net/books/details1.html">测试书</a></h3><a class="author">作者甲</a></div>` };
    if (url === 'https://book15.net/books/details1.html') {
      return { url, text: `<h1>测试书</h1><div class="d-info-panel"><a href="/author/1">作者甲</a></div><meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者甲">` + bigCatalog(catalogChapters) };
    }
    if (url.includes('/read/')) return { url, text: `<li class="chapter-content" id="article-content"><p>${body}</p></li>` };
    return f.transport(url, opts);
  };
  it('60 章预览书（中位 280 字）按 preview_truncated partial 收口、零 book.txt', async () => {
    const f = setup();
    const r = await f.run(wrap(f, 60, previewText));
    expect(r.code).toBe(1);
    expect(r.manifest.status).toBe('partial');
    expect(r.manifest.errors).toEqual(['preview_truncated']);
    expect(existsSync(join(dirname(r.manifestPath), 'book.txt'))).toBe(false);
  });
  it('60 章正常书（中位 2200 字）不受闸门影响照常 done', async () => {
    const f = setup();
    const r = await f.run(wrap(f, 60, fullText));
    expect(r.code).toBe(0);
    expect(r.manifest.status).toBe('done');
  });
  it('小书短章（30 章 280 字）不触发闸门照常 done', async () => {
    const f = setup();
    const r = await f.run(wrap(f, 30, previewText));
    expect(r.code).toBe(0);
    expect(r.manifest.status).toBe('done');
  });
});

// failstreak1030：正文连续失败熔断（DOWNLOAD_CONTENT_FAIL_STREAK，缺省关）。
describe('failstreak1030 正文连续失败熔断', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const catalog = (n: number) => `<div class="d-chapter-list" id="full-catalog">${Array.from({ length: n }, (_, i) => `<dd><a href="/read/${i + 1}">第${i + 1}章</a></dd>`).join('')}</div>`;
  /** 40 章书；bad(n) 为真的章正文为空（strict 抛 empty_content_page）。 */
  const wrap = (f: ReturnType<typeof setup>, bad: (n: number) => boolean) => async (url: string, opts: { signal: AbortSignal; beforeRequest?: (s: AbortSignal) => Promise<void> }) => {
    if (url === 'https://book15.net/books/details1.html') {
      return { url, text: `<h1>测试书</h1><div class="d-info-panel"><a href="/author/1">作者甲</a></div><meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者甲">` + catalog(40) };
    }
    if (url.includes('/read/')) {
      f.calls.push(url);
      return { url, text: `<li class="chapter-content" id="article-content">${bad(Number(url.split('/read/')[1])) ? '' : '<p>合成正文，离线测试。</p>'}</li>` };
    }
    return f.transport(url, opts);
  };
  const reads = (f: ReturnType<typeof setup>) => f.calls.filter(url => url.includes('/read/')).length;

  it('缺省关：逐章抓完全书再按 missing_chapters 收口（零行为变化）', async () => {
    const f = setup();
    const r = await f.run(wrap(f, n => n >= 3));
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(reads(f)).toBe(40);
    expect((r.manifest as { content_fail_streak?: number }).content_fail_streak).toBeUndefined();
  });

  it('K=5：连续 5 章失败即停，剩余章保持 pending，终态码仍是 missing_chapters', async () => {
    vi.stubEnv('DOWNLOAD_CONTENT_FAIL_STREAK', '5');
    const f = setup();
    const r = await f.run(wrap(f, n => n >= 3));
    expect(r.code).toBe(1);
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(reads(f)).toBe(7);
    expect((r.manifest as { content_fail_streak?: number }).content_fail_streak).toBe(5);
    expect(r.manifest.chapters.filter((c: { status: string }) => c.status === 'done')).toHaveLength(2);
    expect(r.manifest.chapters.filter((c: { status: string }) => c.status === 'pending')).toHaveLength(33);
    expect(existsSync(join(dirname(r.manifestPath), 'download.lock'))).toBe(false);
  });

  it('K=2：成功章清零计数，隔章失败不触发熔断', async () => {
    vi.stubEnv('DOWNLOAD_CONTENT_FAIL_STREAK', '2');
    const f = setup();
    const r = await f.run(wrap(f, n => n % 2 === 0));
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(reads(f)).toBe(40);
  });

  it.each(['0', '', 'abc', '-3', '1e3'])('非正整数 %j 视为关', async value => {
    vi.stubEnv('DOWNLOAD_CONTENT_FAIL_STREAK', value);
    expect(contentFailStreak()).toBe(0);
  });
});

// retrypass1030：瞬时类失败章补抓（DOWNLOAD_CONTENT_RETRY_PASSES，缺省关）。
describe('retrypass1030 正文失败章补抓', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const catalog = (n: number) => `<div class="d-chapter-list" id="full-catalog">${Array.from({ length: n }, (_, i) => `<dd><a href="/read/${i + 1}">第${i + 1}章</a></dd>`).join('')}</div>`;
  /** 10 章书；flaky(n, 第几次读) 为 'http' 抛 502、'blank' 给空正文，否则正常。 */
  const wrap = (f: ReturnType<typeof setup>, flaky: (n: number, attempt: number) => string) => {
    const seen = new Map<number, number>();
    return async (url: string, opts: { signal: AbortSignal; beforeRequest?: (s: AbortSignal) => Promise<void> }) => {
      if (url === 'https://book15.net/books/details1.html') {
        return { url, text: `<h1>测试书</h1><div class="d-info-panel"><a href="/author/1">作者甲</a></div><meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者甲">` + catalog(10) };
      }
      if (url.includes('/read/')) {
        f.calls.push(url);
        const n = Number(url.split('/read/')[1]);
        const attempt = (seen.get(n) ?? 0) + 1;
        seen.set(n, attempt);
        const mode = flaky(n, attempt);
        if (mode === 'http') throw new SourceHttpError(502);
        return { url, text: `<li class="chapter-content" id="article-content">${mode === 'blank' ? '' : '<p>合成正文，离线测试。</p>'}</li>` };
      }
      return f.transport(url, opts);
    };
  };
  const reads = (f: ReturnType<typeof setup>) => f.calls.filter(url => url.includes('/read/')).length;
  const firstTry502 = (n: number, attempt: number) => (n % 3 === 0 && attempt === 1 ? 'http' : '');

  it('缺省关：首轮 502 的章直接 missing_chapters，不补抓（零行为变化）', async () => {
    const f = setup();
    const r = await f.run(wrap(f, firstTry502));
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(reads(f)).toBe(10);
    expect(r.manifest.chapters.filter((c: { error?: string }) => c.error === 'chapter_failed')).toHaveLength(3);
  });

  it('R=1：首轮 502 的 3 章补抓成功，整本 done，失败码不残留', async () => {
    vi.stubEnv('DOWNLOAD_CONTENT_RETRY_PASSES', '1');
    const f = setup();
    const r = await f.run(wrap(f, firstTry502));
    expect(r.code).toBe(0);
    expect(r.manifest.status).toBe('done');
    expect(reads(f)).toBe(13);
    expect(r.manifest.chapters.some((c: { error?: string }) => 'error' in c)).toBe(false);
  });

  it('R=2：持续 502 的章补抓 2 轮后仍按 missing_chapters 收口', async () => {
    vi.stubEnv('DOWNLOAD_CONTENT_RETRY_PASSES', '2');
    const f = setup();
    const r = await f.run(wrap(f, n => (n === 4 ? 'http' : '')));
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(reads(f)).toBe(12);
  });

  it('规则类失败（empty_content_page）不补抓', async () => {
    vi.stubEnv('DOWNLOAD_CONTENT_RETRY_PASSES', '3');
    const f = setup();
    const r = await f.run(wrap(f, n => (n === 5 ? 'blank' : '')));
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(reads(f)).toBe(10);
    expect((r.manifest.chapters[4] as { error?: string }).error).toBe('empty_content_page');
  });

  it('补抓轮连败同受 failstreak 熔断（轮内从 0 计）', async () => {
    vi.stubEnv('DOWNLOAD_CONTENT_RETRY_PASSES', '1');
    vi.stubEnv('DOWNLOAD_CONTENT_FAIL_STREAK', '2');
    const f = setup();
    // 首轮隔章 502（不触发 K=2）；补抓轮这 5 章全 502 ⇒ 连败 2 即停，只补抓 2 章。
    const r = await f.run(wrap(f, n => (n % 2 === 0 ? 'http' : '')));
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(reads(f)).toBe(12);
    expect((r.manifest as { content_fail_streak?: number }).content_fail_streak).toBe(2);
  });

  it.each(['0', '', 'abc', '-1', '4', '1.5'])('非 0..3 的 %j 视为关', value => {
    vi.stubEnv('DOWNLOAD_CONTENT_RETRY_PASSES', value);
    expect(contentRetryPasses()).toBe(0);
  });
  it.each([['1', 1], [' 3 ', 3]] as const)('%j 解析为 %d 轮', (value, passes) => {
    vi.stubEnv('DOWNLOAD_CONTENT_RETRY_PASSES', value);
    expect(contentRetryPasses()).toBe(passes);
  });
});

// breakeryield1031：限速器熔断让出（DOWNLOAD_BREAKER_YIELD，缺省关）。
describe('breakeryield1031 限速器熔断让出', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const catalog = (n: number) => `<div class="d-chapter-list" id="full-catalog">${Array.from({ length: n }, (_, i) => `<dd><a href="/read/${i + 1}">第${i + 1}章</a></dd>`).join('')}</div>`;
  const breaker = () => Object.assign(new Error('源 book15.net 熔断中'), { name: 'CircuitOpenError' });
  /** 10 章书；open() 为真时第 ≥4 章按熔断拒绝（请求未出网，不计入 calls）。 */
  const wrap = (f: ReturnType<typeof setup>, open: () => boolean, error: () => Error = breaker) =>
    async (url: string, opts: { signal: AbortSignal; beforeRequest?: (s: AbortSignal) => Promise<void> }) => {
      if (url === 'https://book15.net/books/details1.html') {
        return { url, text: `<h1>测试书</h1><div class="d-info-panel"><a href="/author/1">作者甲</a></div><meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者甲">` + catalog(10) };
      }
      if (url.includes('/read/')) {
        if (open() && Number(url.split('/read/')[1]) >= 4) throw error();
        f.calls.push(url);
        return { url, text: '<li class="chapter-content" id="article-content"><p>合成正文，离线测试。</p></li>' };
      }
      return f.transport(url, opts);
    };
  const reads = (f: ReturnType<typeof setup>) => f.calls.filter(url => url.includes('/read/')).length;
  const extra = (r: { manifest: object }) => r.manifest as { failure_stage?: string; retry_cause?: string };
  const statuses = (r: { manifest: { chapters: { status: string }[] } }) => r.manifest.chapters.map(c => c.status[0]).join('');

  it('缺省关：熔断后余下章逐章判 chapter_failed，missing_chapters 收口（零行为变化）', async () => {
    const f = setup();
    const r = await f.run(wrap(f, () => true));
    expect(r.code).toBe(1);
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(statuses(r)).toBe('dddfffffff');
    expect(extra(r).retry_cause).toBeUndefined();
  });

  it('开：首个熔断即停，当前章不判失败，code=2 source_unavailable + retry_cause=host_breaker', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const f = setup();
    const r = await f.run(wrap(f, () => true));
    expect(r.code).toBe(2);
    expect(r.manifest.errors).toEqual(['source_unavailable']);
    expect(extra(r)).toMatchObject({ failure_stage: 'content', retry_cause: 'host_breaker' });
    expect(statuses(r)).toBe('dddppppppp');
    expect(existsSync(join(dirname(r.manifestPath), 'download.lock'))).toBe(false);
  });

  it('开：熔断恢复后同源续传，只抓余下 7 章', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const f = setup();
    let open = true;
    const transport = wrap(f, () => open);
    expect((await f.run(transport)).code).toBe(2);
    open = false;
    const r = await f.run(transport);
    expect(r.code).toBe(0);
    expect(r.manifest.status).toBe('done');
    expect(reads(f)).toBe(10);
    expect(extra(r).retry_cause).toBeUndefined();
  });

  it('开：日请求上限同样让出；真实 502 不让出（照旧判章失败）', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const daily = setup();
    const budget = () => Object.assign(new Error('源 book15.net 当日请求预算触顶（20000）'), { name: 'DailyRequestBudgetError' });
    const r1 = await daily.run(wrap(daily, () => true, budget));
    expect(r1.code).toBe(2);
    expect(extra(r1).retry_cause).toBe('host_breaker');
    const http = setup();
    const r2 = await http.run(wrap(http, () => true, () => new SourceHttpError(502)));
    expect(r2.code).toBe(1);
    expect(r2.manifest.errors).toEqual(['missing_chapters']);
    expect(extra(r2).retry_cause).toBeUndefined();
  });

  it('开：搜索阶段熔断同样带 retry_cause（failure_stage=search）', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const f = setup();
    const r = await f.run(async (url, opts) => { if (url.includes('/search')) throw breaker(); return f.transport(url, opts); });
    expect(r.code).toBe(2);
    expect(extra(r)).toMatchObject({ failure_stage: 'search', retry_cause: 'host_breaker' });
  });

  it.each([['1', true], [' 1 ', true], ['0', false], ['', false], ['true', false]] as const)('%j ⇒ %s', (value, on) => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', value);
    expect(breakerYield()).toBe(on);
  });

  it('breakerguard1031：续传轮零新抓且已有章失败（熔断是本轮自己连败打开的）⇒ 不让出，照关开关口径', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const f = setup();
    expect((await f.run(wrap(f, () => true))).code).toBe(2);
    // 续传轮：第 4、5 章真实 502，之后熔断拒绝。
    const r = await f.run(async (url, opts) => {
      const n = url.includes('/read/') ? Number(url.split('/read/')[1]) : 0;
      if (n === 4 || n === 5) throw new SourceHttpError(502);
      return wrap(f, () => true)(url, opts);
    });
    expect(r.code).toBe(1);
    expect(r.manifest.errors).toEqual(['missing_chapters']);
    expect(statuses(r)).toBe('dddfffffff');
    expect(extra(r).retry_cause).toBeUndefined();
  });

  it('breakerguard1031：续传轮零新抓但也零失败（熔断仍开着、本轮没真试）⇒ 仍让出', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const f = setup();
    const transport = wrap(f, () => true);
    expect((await f.run(transport)).code).toBe(2);
    const r = await f.run(transport);
    expect(r.code).toBe(2);
    expect(extra(r).retry_cause).toBe('host_breaker');
    expect(statuses(r)).toBe('dddppppppp');
  });
});

// recheckyield1031：收尾目录复核抖动不判源失败（DOWNLOAD_RECHECK_YIELD，缺省关）。
describe('recheckyield1031 收尾复核抖动', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const BOOK = 'https://book15.net/books/details1.html';
  const timeout = () => new DOMException('书源连接超时', 'ConnectTimeoutError');
  /** builtin 两章书（style -1：详情=1、目录=2、收尾复核=3 次读详情页）；failAt 次读详情页时超时，badChapters 章 500。 */
  const wrap = (f: ReturnType<typeof setup>, failAt: number, badChapters = false) => {
    let bookReads = 0;
    return async (url: string, opts: Parameters<typeof f.transport>[1]) => {
      if (url === BOOK && ++bookReads === failAt) throw timeout();
      if (badChapters && url.includes('/chapter/')) throw new SourceHttpError(500);
      return f.transport(url, opts);
    };
  };
  const extra = (r: { manifest: object }) => r.manifest as { failure_stage?: string; retry_cause?: string };

  it('缺省关：复核超时 ⇒ code=2 toc，无 retry_cause（零行为变化）', async () => {
    const f = setup(-1);
    const r = await f.run(wrap(f, 3));
    expect(r.code).toBe(2);
    expect(extra(r)).toMatchObject({ failure_stage: 'toc' });
    expect(extra(r).retry_cause).toBeUndefined();
  });

  it('开：全章已抓、复核超时 ⇒ retry_cause=recheck_unavailable', async () => {
    vi.stubEnv('DOWNLOAD_RECHECK_YIELD', '1');
    const f = setup(-1);
    const r = await f.run(wrap(f, 3));
    expect(r.code).toBe(2);
    expect(r.manifest.errors).toEqual(['source_unavailable']);
    expect(extra(r)).toMatchObject({ failure_stage: 'toc', retry_cause: 'recheck_unavailable' });
  });

  it('开：首取目录超时（没进正文）或已抓不足一半 ⇒ 不带 retry_cause', async () => {
    vi.stubEnv('DOWNLOAD_RECHECK_YIELD', '1');
    const first = setup(-1);
    const r1 = await first.run(wrap(first, 2));
    expect(r1.code).toBe(2);
    expect(extra(r1).retry_cause).toBeUndefined();
    const bad = setup(-1);
    const r2 = await bad.run(wrap(bad, 3, true));
    expect(r2.code).toBe(2);
    expect(extra(r2).retry_cause).toBeUndefined();
  });

  it.each([['1', true], ['0', false], ['', false]] as const)('%j ⇒ %s', (value, on) => {
    vi.stubEnv('DOWNLOAD_RECHECK_YIELD', value);
    expect(recheckYield()).toBe(on);
  });
});

// hostburst1030：按站「连抓 N 次即静置 M 毫秒」（DOWNLOAD_HOST_BURST_PAUSE，缺省关）。
describe('chapterresume1031 目录变动后逐章续传', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const breaker = () => Object.assign(new Error('源 book15.net 熔断中'), { name: 'CircuitOpenError' });
  /** n 章书（n 可变 = 连载追加）；open() 为真时第 ≥4 章熔断拒绝；search() 为假时搜索不可达。 */
  const book = (f: ReturnType<typeof setup>, s: { n: number; open: boolean; search?: boolean; title?: (i: number) => string }) =>
    async (url: string, opts: { signal: AbortSignal; beforeRequest?: (s: AbortSignal) => Promise<void> }) => {
      if (url.includes('/search') && s.search === false) throw new SourceHttpError(503);
      if (url === 'https://book15.net/books/details1.html') {
        const list = Array.from({ length: s.n }, (_, i) => `<dd><a href="/read/${i + 1}">${s.title?.(i + 1) ?? `第${i + 1}章`}</a></dd>`).join('');
        return { url, text: `<h1>测试书</h1><div class="d-info-panel"><a href="/author/1">作者甲</a></div><meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者甲"><div class="d-chapter-list" id="full-catalog">${list}</div>` };
      }
      if (url.includes('/read/')) {
        if (s.open && Number(url.split('/read/')[1]) >= 4) throw breaker();
        f.calls.push(url);
        return { url, text: '<li class="chapter-content" id="article-content"><p>合成正文，离线测试。</p></li>' };
      }
      return f.transport(url, opts);
    };
  const reads = (f: ReturnType<typeof setup>) => f.calls.filter(url => url.includes('/read/')).length;

  async function grow(on: boolean, title?: (i: number) => string) {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    if (on) vi.stubEnv('DOWNLOAD_RESUME_BY_CHAPTER', '1');
    const f = setup();
    const s = { n: 10, open: true };
    expect((await f.run(book(f, s))).code).toBe(2); // 抓到 3 章后让出
    const r = await f.run(book(f, { n: 11, open: false, title }));
    return { f, r };
  }

  it('缺省关：目录追加一章 ⇒ 整本从头抓（零行为变化）', async () => {
    const { f, r } = await grow(false);
    expect(r.code).toBe(0);
    expect(reads(f)).toBe(3 + 11);
  });

  it('开：目录追加一章 ⇒ 前 3 章走缓存，只抓 8 章', async () => {
    const { f, r } = await grow(true);
    expect(r.code).toBe(0);
    expect(r.manifest.chapters).toHaveLength(11);
    expect(reads(f)).toBe(3 + 8);
  });

  it('开：同序号章名变了 ⇒ 该章不复用', async () => {
    const { f, r } = await grow(true, i => i === 2 ? '第2章（修订）' : `第${i}章`);
    expect(r.code).toBe(0);
    expect(reads(f)).toBe(3 + 9);
  });

  it('开：搜索阶段失败的检查点保留续传判据，下一轮仍可续传', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    vi.stubEnv('DOWNLOAD_RESUME_BY_CHAPTER', '1');
    const f = setup();
    expect((await f.run(book(f, { n: 10, open: true }))).code).toBe(2);
    const down = await f.run(book(f, { n: 10, open: false, search: false }));
    expect(down.code).toBe(2);
    expect(down.manifest).toMatchObject({ failure_stage: 'search' });
    expect(typeof (down.manifest as { tocHash?: unknown }).tocHash).toBe('string');
    const r = await f.run(book(f, { n: 10, open: false }));
    expect(r.code).toBe(0);
    expect(reads(f)).toBe(10);
  });

  it('关：搜索阶段失败的检查点不带续传判据（现状），下一轮从头抓', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const f = setup();
    expect((await f.run(book(f, { n: 10, open: true }))).code).toBe(2);
    expect((await f.run(book(f, { n: 10, open: false, search: false }))).code).toBe(2);
    const r = await f.run(book(f, { n: 10, open: false }));
    expect(r.code).toBe(0);
    expect(reads(f)).toBe(3 + 10);
  });

  it.each([['1', true], [' 1 ', true], ['0', false], ['', false], ['on', false]] as const)('%j ⇒ %s', (value, on) => {
    vi.stubEnv('DOWNLOAD_RESUME_BY_CHAPTER', value);
    expect(chapterResume()).toBe(on);
  });

  it('resumeseed1031 端到端：实例 A 抓 3 章让出 → 种子种入实例 B → B 只抓余下 7 章', async () => {
    vi.stubEnv('DOWNLOAD_BREAKER_YIELD', '1');
    const f = setup();
    const base = mkdtempSync(join(tmpdir(), 't4-seed-')); dirs.push(base);
    const outOf = (inst: string) => join(base, inst, 'download', 'out');
    const task = 'synthetictaskkey'; // adapter 的任务键目录（真实为 sha256 前 24 位）
    const runIn = (inst: string, s: { n: number; open: boolean }) => downloadBook({ api, compile, parser },
      { ...f.options, out: join(outOf(inst), task) }, async () => ({ source: f.source, builtin: f.builtin }), book(f, s));
    expect((await runIn('inst-2', { n: 10, open: true })).code).toBe(2);
    mkdirSync(outOf('inst-1'), { recursive: true });
    expect(seedFromPeers(join(outOf('inst-1'), task), peerOutRoots(outOf('inst-1')))).toEqual({ chapters: 3, unlocked: 0 });
    const r = await runIn('inst-1', { n: 10, open: false });
    expect(r.code).toBe(0);
    expect(r.manifestPath.startsWith(outOf('inst-1'))).toBe(true);
    expect(reads(f)).toBe(10);
  });
});

describe('hostburst1030 按站连抓静置', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const catalog = (n: number) => `<div class="d-chapter-list" id="full-catalog">${Array.from({ length: n }, (_, i) => `<dd><a href="/read/${i + 1}">第${i + 1}章</a></dd>`).join('')}</div>`;
  /** 20 章书，记录每次请求（beforeRequest 之后）的时刻。 */
  const wrap = (f: ReturnType<typeof setup>, times: number[]) => async (url: string, opts: { signal: AbortSignal; beforeRequest?: (s: AbortSignal) => Promise<void> }) => {
    if (url === 'https://book15.net/books/details1.html') {
      await opts.beforeRequest?.(opts.signal); times.push(Date.now());
      return { url, text: `<h1>测试书</h1><div class="d-info-panel"><a href="/author/1">作者甲</a></div><meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="作者甲">` + catalog(20) };
    }
    if (url.includes('/read/')) {
      await opts.beforeRequest?.(opts.signal); times.push(Date.now());
      return { url, text: '<li class="chapter-content" id="article-content"><p>合成正文，离线测试。</p></li>' };
    }
    const page = await f.transport(url, opts); times.push(Date.now()); return page;
  };
  /** 相邻请求间隔 < gapMs 的连续段长度。 */
  const runs = (times: number[], gapMs: number) => {
    const out = [1];
    for (let i = 1; i < times.length; i++) times[i] - times[i - 1] >= gapMs ? out.push(1) : out[out.length - 1]++;
    return out;
  };

  it('命中站（m. 前缀互认）：任意两次静置之间不超过 N 次请求，整本照常完成', async () => {
    vi.stubEnv('DOWNLOAD_HOST_BURST_PAUSE', 'other.example=1/9000, m.book15.net=5/80');
    const f = setup(); const times: number[] = [];
    const r = await f.run(wrap(f, times));
    expect(r.code).toBe(0);
    const segments = runs(times, 70);
    expect(segments.length).toBeGreaterThanOrEqual(4);
    for (const n of segments) expect(n).toBeLessThanOrEqual(5);
    expect(segments.reduce((a, b) => a + b, 0)).toBe(times.length);
  });

  it('静置中收到中断：立即按 interrupted 收口，不等满 M', async () => {
    vi.stubEnv('DOWNLOAD_HOST_BURST_PAUSE', 'book15.net=1/600000');
    const f = setup(); const times: number[] = [];
    const t0 = Date.now();
    const timer = setTimeout(() => process.emit('SIGINT'), 50);
    const r = await f.run(wrap(f, times)); clearTimeout(timer);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.code).toBe(1);
    expect(r.manifest.errors).toEqual(['interrupted']);
    expect(r.manifest.chapters.filter((c: { status: string }) => c.status === 'done')).toHaveLength(0);
  });

  it('解析：缺省/非法项/未命中为 null，命中取值且 M 封顶 600000', () => {
    const src = 'https://www.book15.net/';
    const env = (value?: string) => (value === undefined ? {} : { DOWNLOAD_HOST_BURST_PAUSE: value }) as NodeJS.ProcessEnv;
    expect(hostBurstPause(src, env())).toBeNull();
    expect(hostBurstPause(src, env('other.example=10/62000'))).toBeNull();
    expect(hostBurstPause(src, env('book15.net=10,book15.net=a/1'))).toBeNull();
    expect(hostBurstPause(src, env('book15.net=0/62000'))).toBeNull();
    expect(hostBurstPause(src, env('so.book15.net=10/62000'))).toBeNull();
    expect(hostBurstPause(src, env(' x.example=1/1 , M.Book15.net = 10 / 62000 '))).toEqual({ every: 10, pauseMs: 62000 });
    expect(hostBurstPause(src, env('book15.net=3/9999999'))).toEqual({ every: 3, pauseMs: 600000 });
    expect(hostBurstPause('not a url', env('book15.net=3/100'))).toBeNull();
  });
});

// authbridge42：下载腿作者名回退轮（主会话 2026-10-15 裁定扩范围到本文件）。
// 背景：QQ 系别名书在镜像站按通行书名收录，选源/预检按作者名命中后，下载腿若仍只按书名搜，
// 会把同一个源又判成 identity_mismatch_or_no_candidate → markFailure 淘汰，选源的改动等于白烧出网。
describe('authbridge42 下载腿作者名回退轮', () => {
  const bookUrl = (n: number) => `https://book15.net/books/details${n}.html`;
  /** 标题搜索恒空、作者搜索返回 pageTitles 各占一个详情页（通行名形态）。pageAuthor 可与任务作者不同。 */
  function aliasSetup(pageTitles: string[], pageAuthor: string, taskAuthor = '为尹染墨红尘', title = '少年羽皇') {
    const out = mkdtempSync(join(tmpdir(), 'ab42-')); dirs.push(out);
    const rules: Record<string, Record<string, string>> = {};
    for (const [key, value] of Object.entries(fixtures[0].coreRules)) {
      const [group, field] = key.split('.'); (rules[group] ??= {})[field] = value as string;
    }
    rules.ruleToc.nextTocUrl = '.next@href';
    const source = { url: 'https://book15.net/', name: 'synthetic', searchUrl: '/search?q={{key}}', rules };
    const options = downloadOptions({ source: source.url, title, author: taskAuthor, out, 'rate-ms': 0, 'timeout-ms': 1000 });
    const calls: string[] = [];
    const transport = async (url: string, opts: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) => {
      calls.push(url); await opts.beforeRequest?.(opts.signal);
      if (url.includes('/search')) {
        const key = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
        if (key !== taskAuthor) return { url, text: '<div class="empty">没有找到</div>' };
        return {
          url,
          text: pageTitles.map((t, i) =>
            `<div class="list-item-panel"><h3><a href="${bookUrl(i + 1)}">${t}</a></h3><a class="author">${pageAuthor}</a></div>`
            + `<li itemprop="mainEntity"><a itemprop="url" href="${bookUrl(i + 1)}"><h2 itemprop="name">${t}</h2></a><p itemprop="author">${pageAuthor}</p></li>`).join(''),
        };
      }
      const n = Number(/details(\d+)\.html$/.exec(url)?.[1] ?? '1') - 1;
      const pageTitle = pageTitles[n] ?? pageTitles[0];
      if (/^https:\/\/book15\.net\/books\/details\d+\.html$/.test(url)) {
        return {
          url,
          text: `<h1>${pageTitle}</h1><div class="d-info-panel"><a href="/author/1">${pageAuthor}</a></div>`
            + `<meta property="og:novel:book_name" content="${pageTitle}"><meta property="og:novel:author" content="${pageAuthor}">`
            + `<div class="d-chapter-list" id="full-catalog"><dd><a href="/read/1">第1章</a></dd></div>`,
        };
      }
      return { url, text: '<li class="chapter-content" id="article-content"><p>合成正文。</p></li>' };
    };
    vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
    const run = () => downloadBook({ api, compile, parser }, options, async () => ({ source, builtin: false }), transport);
    return { run, calls, options };
  }

  it('别名桥接：书名搜空 → 作者轮唯一候选 + 作者门过 ⇒ 真的下载完成', async () => {
    const f = aliasSetup(['帝临鸿蒙'], '为尹染墨红尘');
    const r = await f.run();
    expect(r.code).toBe(0);
    expect(r.manifest.status).toBe('done');
    expect((r.manifest as { bookUrl?: string }).bookUrl).toBe(bookUrl(1));
    // 书名搜索确实先打了一次且没结果，作者轮是补上去的。
    expect(f.calls.filter(url => url.includes('/search')).length).toBe(2);
  });

  it('作者轮候选 >1（同作者多本）⇒ 仍 identity_mismatch_or_no_candidate，且不抓详情', async () => {
    const f = aliasSetup(['诡事录1', '诡事录2'], '魏风华');
    const r = await f.run();
    expect(r.manifest.errors).toEqual(['identity_mismatch_or_no_candidate']);
    expect(f.calls.filter(url => /details\d+\.html$/.test(url))).toEqual([]);
  });

  it('唯一候选但详情页作者门对不上 ⇒ identity_mismatch_or_no_candidate', async () => {
    const f = aliasSetup(['帝临鸿蒙'], '别人');
    const r = await f.run();
    expect(r.manifest.errors).toEqual(['identity_mismatch_or_no_candidate']);
    expect(f.calls.filter(url => /details\d+\.html$/.test(url))).toEqual([bookUrl(1)]);
  });

  it('纯增量：书名候选已选上时一次都不补搜', async () => {
    const f = setup(0);
    const r = await f.run();
    expect(r.code).toBe(0);
    expect(f.calls.filter(url => url.includes('/search'))).toHaveLength(1);
  });
});
