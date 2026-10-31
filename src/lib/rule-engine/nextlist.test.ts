// nextlist1029：翻页字段非链 CSS 规则按 legado getStringList 取全部值（ENGINE_SYNTAX_NEXT_LIST）——分页下拉 `option@value`。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchContent, engineFetchToc, type EngineSource } from './api';
import { compileSource } from './compile';
import { createScope, evaluateField, evaluateFieldStrings, normalizeBody } from './evaluate';
import { parseFieldRule } from './parse';
import { engineSyntaxNextListEnabled, engineTocFanoutFollowEnabled, engineTocNextSkipChapterEnabled } from './syntax-flags';

const SITE = 'https://book15.net'; // 过 host 门（.example 保留域取页被拒）
const on = (rule: string, field = 'ruleToc.nextTocUrl', extra = {}) => parseFieldRule(rule, { field, nextListEnabled: true, ...extra });
const off = (rule: string, field = 'ruleToc.nextTocUrl', extra = {}) => parseFieldRule(rule, { field, nextListEnabled: false, ...extra });
const select = (cur: number) => `<select class="pg">${[1, 2, 3].map((n) => `<option value="/t/${n}.html"${n === cur ? ' selected' : ''}>第${n}页</option>`).join('')}</select>`;
const ch = (n: number) => `<li class="ch"><a href="/c/${n}.html">第${n}章</a></li>`;
const tocPage = (n: number) => `<ul>${ch(n)}</ul>${select(n)}`;
const scope = (html: string, url = `${SITE}/t/1.html`) => createScope(normalizeBody(html), url);

describe('开关', () => {
  it('engineSyntaxNextListEnabled 严格口径', () => {
    expect(engineSyntaxNextListEnabled({})).toBe(false);
    expect(engineSyntaxNextListEnabled({ ENGINE_SYNTAX_NEXT_LIST: '0' })).toBe(false);
    expect(engineSyntaxNextListEnabled({ ENGINE_SYNTAX_NEXT_LIST: 'yes' })).toBe(false);
    expect(engineSyntaxNextListEnabled({ ENGINE_SYNTAX_NEXT_LIST: ' On ' })).toBe(true);
    expect(engineSyntaxNextListEnabled({ ENGINE_SYNTAX_NEXT_LIST: 'true' })).toBe(true);
    expect(engineTocNextSkipChapterEnabled({})).toBe(false);
    expect(engineTocNextSkipChapterEnabled({ ENGINE_TOC_NEXT_SKIP_CHAPTER: 'yes' })).toBe(false);
    expect(engineTocNextSkipChapterEnabled({ ENGINE_TOC_NEXT_SKIP_CHAPTER: ' On ' })).toBe(true);
    expect(engineTocFanoutFollowEnabled({})).toBe(false);
    expect(engineTocFanoutFollowEnabled({ ENGINE_TOC_FANOUT_FOLLOW: 'yes' })).toBe(false);
    expect(engineTocFanoutFollowEnabled({ ENGINE_TOC_FANOUT_FOLLOW: ' On ' })).toBe(true);
  });
});

describe('编译', () => {
  it('next* 的 CSS 规则（含全 CSS 支的 ||）on 挂 nextList，off 逐字不变', () => {
    for (const field of ['ruleToc.nextTocUrl', 'ruleContent.nextContentUrl']) {
      for (const rule of ['option@value', 'class.pg@option@value', 'text.下一页@href', '@css:select.pg option@value', 'option@value##/t/##/p/']) {
        const o = off(rule, field);
        expect(o.nextList).toBeUndefined();
        expect(on(rule, field)).toEqual({ ...o, nextList: true });
      }
    }
    const or = on('option@value||text.下一页@href', 'ruleToc.nextTocUrl', { orEnabled: true });
    expect(or.nextList).toBe(true);
    expect(or.rules[0]?.kind).toBe('or');
  });

  it('非翻页字段、XPath、正则-only、字面量、模板、JS 链不挂', () => {
    expect(on('option@value', 'ruleToc.chapterUrl').nextList).toBeUndefined();
    expect(on('option@value', 'ruleBookInfo.tocUrl').nextList).toBeUndefined();
    // 能翻成 CSS 的 XPath 同 CSS 口径；翻不了、走 JsoupXpath 求值的不挂。
    const xp = { xpathEnabled: true, xpathEvalEnabled: true };
    expect(on('//select/option/@value', 'ruleToc.nextTocUrl', xp).nextList).toBe(true);
    expect(on('//option[position()>1]/@value', 'ruleToc.nextTocUrl', xp).rules[0]?.kind).toBe('xpath');
    expect(on('//option[position()>1]/@value', 'ruleToc.nextTocUrl', xp).nextList).toBeUndefined();
    expect(on('option@value||//option[position()>1]/@value', 'ruleToc.nextTocUrl', { orEnabled: true, ...xp }).nextList).toBeUndefined();
    expect(on('##下页="([^"]+)"##$1###', 'ruleToc.nextTocUrl', { regexEnabled: true }).nextList).toBeUndefined();
    expect(on(`${SITE}/t/2.html`, 'ruleToc.nextTocUrl').nextList).toBeUndefined();
    expect(on('option@value@js:result', 'ruleToc.nextTocUrl', { jsEnabled: true }).nextList).toBeUndefined();
  });
});

describe('求值', () => {
  it('on 逐节点取全部值、## 逐项替换；off 只取首个', () => {
    expect(evaluateFieldStrings(on('option@value'), scope(tocPage(1)))).toEqual(['/t/1.html', '/t/2.html', '/t/3.html']);
    expect(evaluateFieldStrings(on('option@value##/t/##/p/'), scope(tocPage(1)))).toEqual(['/p/1.html', '/p/2.html', '/p/3.html']);
    expect(evaluateField(off('option@value'), scope(tocPage(1)))).toBe('/t/1.html');
    const or = on('class.none@option@value||text.下一页@href', 'ruleToc.nextTocUrl', { orEnabled: true });
    expect(evaluateFieldStrings(or, scope('<a href="/t/2.html">下一页</a><p><a href="/t/2.html">下一页</a></p>')))
      .toEqual([`${SITE}/t/2.html`, `${SITE}/t/2.html`]); // @href 终端本就绝对化；去重交门面
  });
});

describe('门面', () => {
  afterEach(() => vi.unstubAllEnvs());
  const src = (rules: Record<string, unknown>): EngineSource => {
    const merged = { ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' }, ruleContent: { content: '.content@html' }, ...rules };
    return { url: SITE, name: '合成源', searchUrl: `${SITE}/s?q={{key}}`, compiled: compileSource({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: merged }) };
  };
  const ctx = (pages: Map<string, string>, seen: string[]): SourceRequestContext => ({
    page: async (url: string) => {
      seen.push(url);
      const text = pages.get(url);
      if (text === undefined) throw new Error('Unexpected request: ' + url);
      return { url, text };
    },
  }) as unknown as SourceRequestContext;
  const tocPages = new Map([1, 2, 3].map((n) => [`${SITE}/t/${n}.html`, tocPage(n)]));

  it('目录：下拉分页 on 全抓（已读页静默收尾）；off 只有首页', async () => {
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '1');
    const seen: string[] = [];
    const toc = await engineFetchToc(src({ ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'option@value' } }),
      `${SITE}/t/1.html`, ctx(tocPages, seen), true);
    expect(toc.chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第3章']);
    expect(seen).toEqual([1, 2, 3].map((n) => `${SITE}/t/${n}.html`));
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '0');
    const offSeen: string[] = [];
    // 换个规则文本避开编译缓存（toc 字段不计语义位，缓存键开关两态相同）。
    const offToc = await engineFetchToc(src({ ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'tag.option@value' } }),
      `${SITE}/t/1.html`, ctx(tocPages, offSeen));
    expect(offToc.chapters.map((c) => c.title)).toEqual(['第1章']);
    expect(offSeen).toEqual([`${SITE}/t/1.html`]);
  });

  it('目录：非 strict 下拉并发页按本源余量截断、交已读页；strict 不截断', async () => {
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '1');
    const rules = { ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'class.pg@option@value' } };
    const budgeted = (seen: string[], limit: number) => Object.assign(ctx(tocPages, seen), { remainingFor: (reserve: number) => Math.max(0, limit - seen.length - reserve) });
    const seen: string[] = [];
    const toc = await engineFetchToc(src(rules), `${SITE}/t/1.html`, budgeted(seen, 2));
    expect(toc.chapters.map((c) => c.title)).toEqual(['第1章', '第2章']);
    expect(seen).toEqual([1, 2].map((n) => `${SITE}/t/${n}.html`));
    const strictSeen: string[] = [];
    // strict（准入/下载）照旧全抓：余量只在门面放宽口径里截断，不能让准入把半本目录当完整。
    await engineFetchToc(src(rules), `${SITE}/t/1.html`, budgeted(strictSeen, 2), true);
    expect(strictSeen).toHaveLength(3);
  });

  it('目录：页码条只列后一页时 on 照旧串行', async () => {
    const pages = new Map([
      [`${SITE}/t/1.html`, `<ul>${ch(1)}</ul><a href="/t/2.html">下一页</a><p><a href="/t/2.html">下一页</a></p>`],
      [`${SITE}/t/2.html`, `<ul>${ch(2)}</ul><a href="/t/3.html">下一页</a>`],
      [`${SITE}/t/3.html`, `<ul>${ch(3)}</ul>`],
    ]);
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '1');
    const seen: string[] = [];
    const toc = await engineFetchToc(src({ ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'text.下一页@href' } }),
      `${SITE}/t/1.html`, ctx(pages, seen), true);
    expect(toc.chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第3章']);
    expect(seen).toEqual([1, 2, 3].map((n) => `${SITE}/t/${n}.html`));
  });

  it('目录：翻页规则命中标题含「下一」的章节链接（tocself1030）on 剔除收尾；off strict 抓章节页得 empty_toc_page', async () => {
    const named = (n: number, title: string) => `<li class="ch"><a href="/c/${n}.html">${title}</a></li>`;
    const pages = new Map([
      [`${SITE}/t/1.html`, `<ul>${named(1, '第1章 下一站')}</ul><a href="/t/2.html">下一页</a>`],
      [`${SITE}/t/2.html`, `<ul>${ch(2)}${named(3, '第3章 下一步')}</ul>`],
      [`${SITE}/c/1.html`, `<div class="content">一</div><a href="/c/2.html">下一章</a>`],
      [`${SITE}/c/3.html`, `<div class="content">三</div><a href="/c/4.html">下一章</a>`],
    ]);
    const rules = (next: string) => ({ ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: next } });
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '1');
    vi.stubEnv('ENGINE_TOC_NEXT_SKIP_CHAPTER', '1');
    const seen: string[] = [];
    const toc = await engineFetchToc(src(rules('text.下一@href')), `${SITE}/t/1.html`, ctx(pages, seen), true);
    expect(toc.chapters.map((c) => c.title)).toEqual(['第1章 下一站', '第2章', '第3章 下一步']);
    expect(seen).toEqual([`${SITE}/t/1.html`, `${SITE}/t/2.html`]);
    vi.stubEnv('ENGINE_TOC_NEXT_SKIP_CHAPTER', '0');
    await expect(engineFetchToc(src(rules('text.下一@href')), `${SITE}/t/1.html`, ctx(pages, []), true)).rejects.toThrow('empty_toc_page');
  });

  it('目录：窗口式页码条（tocfollow1031）on 并发页补抓中间页并按页码排序；off 截断', async () => {
    // sfwx 形态：目录首页 /b/ 只列 1/2/3/>/末页，第 k 页列 k-1..k+1、>、末页；首页与第 1 页同内容。
    const last = 6;
    const bar = (k: number) => {
      const nums = k === 0 ? [1, 2, 3] : [k - 1, k, k + 1].filter((n) => n >= 1 && n <= last);
      const link = (n: number, label: string) => `<a href="/b/index_${n}.html">${label}</a>`;
      return `<div class="pg">${nums.map((n) => link(n, String(n))).join('')}${k < last ? link(Math.max(k, 1) + 1, '&gt;') : ''}${link(last, '')}</div>`;
    };
    const pages = new Map([[`${SITE}/b/`, `<ul>${ch(1)}</ul>${bar(0)}`],
      ...Array.from({ length: last }, (_, i) => [`${SITE}/b/index_${i + 1}.html`, `<ul>${ch(i + 1)}</ul>${bar(i + 1)}`] as [string, string])]);
    const rules = { ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'class.pg@tag.a@href' } };
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '1');
    const offToc = await engineFetchToc(src(rules), `${SITE}/b/`, ctx(pages, []), true);
    expect(offToc.chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第3章', '第6章']);
    vi.stubEnv('ENGINE_TOC_FANOUT_FOLLOW', '1');
    const seen: string[] = [];
    const toc = await engineFetchToc(src(rules), `${SITE}/b/`, ctx(pages, seen), true);
    expect(toc.chapters.map((c) => c.title)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `第${n}章`));
    expect(seen).toHaveLength(last + 1);
    expect(new Set(seen).size).toBe(last + 1);
  });

  it('目录：tocfollow1031 补抓页 URL 排不出页序时 strict 抛 toc_limit，非 strict 按取回顺序', async () => {
    const pages = new Map([
      [`${SITE}/b/`, `<ul>${ch(1)}</ul><div class="pg"><a href="/t/2.html">2</a><a href="/u/9.html">末</a></div>`],
      [`${SITE}/t/2.html`, `<ul>${ch(2)}</ul><div class="pg"><a href="/t/3.html">3</a></div>`],
      [`${SITE}/t/3.html`, `<ul>${ch(3)}</ul>`],
      [`${SITE}/u/9.html`, `<ul>${ch(9)}</ul>`],
    ]);
    const rules = { ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'class.pg@tag.a@href' } };
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '1');
    vi.stubEnv('ENGINE_TOC_FANOUT_FOLLOW', '1');
    await expect(engineFetchToc(src(rules), `${SITE}/b/`, ctx(pages, []), true)).rejects.toThrow('toc_limit');
    const toc = await engineFetchToc(src(rules), `${SITE}/b/`, ctx(pages, []));
    expect(toc.chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第9章', '第3章']);
  });

  it('正文：下一页最后指向下一章时停，与 off 同结果', async () => {
    const body = (t: string, nextUrl: string) => `<div class="content"><p>${t}</p></div><a href="${nextUrl}">下一页</a><p><a href="${nextUrl}">下一页</a></p>`;
    const pages = new Map([[`${SITE}/c/1.html`, body('一', '/c/1_2.html')], [`${SITE}/c/1_2.html`, body('二', '/c/2.html')]]);
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '1');
    const seen: string[] = [];
    const out = await engineFetchContent(src({ ruleContent: { content: '.content@html', nextContentUrl: 'text.下一页@href' } }),
      `${SITE}/c/1.html`, ctx(pages, seen), true, `${SITE}/c/2.html`);
    expect(out.text).toBe('一\n二');
    expect(seen).toEqual([`${SITE}/c/1.html`, `${SITE}/c/1_2.html`]);
    vi.stubEnv('ENGINE_SYNTAX_NEXT_LIST', '0');
    const offSeen: string[] = [];
    const offOut = await engineFetchContent(src({ ruleContent: { content: '.content@html', nextContentUrl: 'tag.a.0@href' } }),
      `${SITE}/c/1.html`, ctx(pages, offSeen), true, `${SITE}/c/2.html`);
    expect(offOut.text).toBe(out.text);
    expect(offSeen).toEqual(seen);
  });
});
