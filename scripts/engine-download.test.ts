import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../src/lib/rule-engine/api';
import * as compile from '../src/lib/rule-engine/compile';
import * as parser from '../src/lib/source-parser';
import fixtures from '../src/lib/rule-engine/fixtures/smoke-174.json';
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
  const run = () => downloadBook({ api, compile, parser }, options, async () => ({ source, builtin: style < 0 }), transport);
  return { run, options, calls, times };
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
  it('max chapters fails before fetching chapters', async () => {
    const f = setup(); f.options['max-chapters'] = 1;
    const r = await f.run(); expect(r.code).toBe(1); expect(r.manifest.errors).toContain('max_chapters');
    expect(f.calls.some(url => url.includes('/read/'))).toBe(false);
  });
  it('total budget preserves partial checkpoint', async () => {
    const f = setup(0, 'timeout'); f.options['budget-ms'] = 30;
    expect((await f.run()).manifest.status).toBe('partial');
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
});
