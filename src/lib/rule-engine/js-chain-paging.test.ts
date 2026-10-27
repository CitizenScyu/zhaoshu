// JS 链翻页单测（jsbox1027，legado 并发分支）：nextTocUrl / nextContentUrl 一次给出多个 URL 时
// 全部抓取、这些页不再取下一页；单个 URL 时顺序跟随；非法 URL 在 strict 下抛错。非链路径逐字不变。

import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchContent, engineFetchToc, type EngineSource } from './api';
import { compileSource } from './compile';
import { preloadJsSandbox } from './js-sandbox';

const SITE = 'https://book15.net';
const TOC_URL = `${SITE}/toc/1.html`;
const CHAPTER_URL = `${SITE}/c/1.html`;

function source(rules: Record<string, unknown>): EngineSource {
  const base = {
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@html' },
  };
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(rules)) {
    merged[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? { ...(base[k as keyof typeof base] as Record<string, unknown> ?? {}), ...(v as Record<string, unknown>) }
      : v;
  }
  return {
    url: SITE,
    name: 'JS 翻页源',
    searchUrl: `${SITE}/s?q={{key}}`,
    compiled: compileSource({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: merged }, { jsEnabled: true }),
  };
}

function context(pages: Map<string, string>, seen: string[] = []): SourceRequestContext {
  return {
    page: async (url: string) => {
      seen.push(url);
      const text = pages.get(url);
      if (text === undefined) throw new Error('Unexpected request: ' + url);
      return { url, text };
    },
  } as unknown as SourceRequestContext;
}

const ch = (n: number) => `<li class="ch"><a href="/c/${n}.html">第${n}章</a></li>`;

describe('engineFetchToc: nextTocUrl JS 链', () => {
  it('单个 URL：顺序跟随（与普通规则同口径）', async () => {
    await preloadJsSandbox();
    const src = source({ ruleToc: { nextTocUrl: '.next@href@js:result' } });
    const pages = new Map([
      [TOC_URL, `${ch(1)}<a class="next" href="/toc/2.html">x</a>`],
      [`${SITE}/toc/2.html`, ch(2)],
    ]);
    const result = await engineFetchToc(src, TOC_URL, context(pages));
    expect(result.chapters.map((c) => c.title)).toEqual(['第1章', '第2章']);
  });

  it('多个 URL：全部抓取，且这些页不再取下一页', async () => {
    await preloadJsSandbox();
    const src = source({ ruleToc: { nextTocUrl: '.next@href<js>[result, result + "?p=3"]</js>' } });
    const pages = new Map([
      [TOC_URL, `${ch(1)}<a class="next" href="/toc/2.html">x</a>`],
      [`${SITE}/toc/2.html`, ch(2)],
      [`${SITE}/toc/2.html?p=3`, ch(3)],
    ]);
    const result = await engineFetchToc(src, TOC_URL, context(pages));
    expect(result.chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第3章']);
  });

  it('fanout 页即使自身有 next 也不再跟随（legado 并发分支口径）', async () => {
    await preloadJsSandbox();
    const src = source({ ruleToc: { nextTocUrl: '.next@href<js>[result, result + "?p=3"]</js>' } });
    const pages = new Map([
      [TOC_URL, `${ch(1)}<a class="next" href="/toc/2.html">x</a>`],
      [`${SITE}/toc/2.html`, `${ch(2)}<a class="next" href="/toc/9.html">x</a>`],
      [`${SITE}/toc/2.html?p=3`, ch(3)],
    ]);
    const seen: string[] = [];
    const result = await engineFetchToc(src, TOC_URL, context(pages, seen));
    expect(result.chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第3章']);
    expect(seen).toEqual([TOC_URL, `${SITE}/toc/2.html`, `${SITE}/toc/2.html?p=3`]);
  });

  it('相对 URL 绝对化、与当前页相同的项剔除', async () => {
    await preloadJsSandbox();
    const src = source({ ruleToc: { nextTocUrl: '@js:""' } });
    const pages = new Map([[TOC_URL, ch(1)]]);
    const result = await engineFetchToc(src, TOC_URL, context(pages));
    expect(result.chapters).toHaveLength(1);
  });

  it('strict 下非法 URL 抛 invalid_next_page', async () => {
    await preloadJsSandbox();
    const src = source({ ruleToc: { nextTocUrl: '@js:["/toc/2.html", "http://evil.test/x"]' } });
    const pages = new Map([
      [TOC_URL, ch(1)],
      [`${SITE}/toc/2.html`, ch(2)],
    ]);
    await expect(engineFetchToc(src, TOC_URL, context(pages), true)).rejects.toThrowError(/invalid_next_page|host/i);
  });

  it('strict：fanout 超过页数上限报 toc_limit', async () => {
    await preloadJsSandbox();
    const src = source({ ruleToc: { nextTocUrl: '@js:Array.from({ length: 30 }, (_, i) => "/toc/1.html?p=" + (i + 1))' } });
    const pages = new Map([[TOC_URL, ch(1)]]);
    for (let i = 1; i <= 30; i += 1) pages.set(`${TOC_URL}?p=${i}`, ch(i + 1));
    await expect(engineFetchToc(src, TOC_URL, context(pages), true)).rejects.toThrowError('toc_limit');
  });
});

describe('engineFetchContent: nextContentUrl JS 链', () => {
  it('多个 URL：全部抓取并按顺序拼接', async () => {
    await preloadJsSandbox();
    const src = source({ ruleContent: { nextContentUrl: '.next@href<js>[result[0], result[0].replace("p=1", "p=2")]</js>' } });
    const pages = new Map([
      [CHAPTER_URL, `<div class="content"><p>一</p></div><a class="next" href="/c/1.html?p=1">x</a>`],
      [`${CHAPTER_URL}?p=1`, `<div class="content"><p>二</p></div>`],
      [`${CHAPTER_URL}?p=2`, `<div class="content"><p>三</p></div>`],
    ]);
    const result = await engineFetchContent(src, CHAPTER_URL, context(pages));
    expect(result.text).toBe(['一', '二', '三'].join('\n'));
  });

  it('命中下一章地址的项被剔除（stops）', async () => {
    await preloadJsSandbox();
    const src = source({ ruleContent: { nextContentUrl: '.next@href<js>[result, "/c/2.html"]</js>' } });
    const pages = new Map([
      [CHAPTER_URL, `<div class="content"><p>一</p></div><a class="next" href="/c/1.html?p=1">x</a>`],
      [`${CHAPTER_URL}?p=1`, `<div class="content"><p>二</p></div>`],
    ]);
    const result = await engineFetchContent(src, CHAPTER_URL, context(pages), false, `${SITE}/c/2.html`);
    expect(result.text).toBe('一\n二');
  });

  it('单个 URL：顺序跟随；指回当前页的项按 legado 剔除，正常收尾（不当成环）', async () => {
    await preloadJsSandbox();
    const src = source({ ruleContent: { nextContentUrl: '.next@href@js:result' } });
    const pages = new Map([
      [CHAPTER_URL, `<div class="content"><p>一</p></div><a class="next" href="/c/1.html?p=1">x</a>`],
      [`${CHAPTER_URL}?p=1`, `<div class="content"><p>二</p></div><a class="next" href="/c/1.html?p=1">x</a>`],
    ]);
    const result = await engineFetchContent(src, CHAPTER_URL, context(pages), true);
    expect(result.text).toBe('一\n二');
  });

  it('strict：fanout 超过页数上限报 content_page_limit', async () => {
    await preloadJsSandbox();
    const src = source({ ruleContent: { nextContentUrl: '@js:Array.from({ length: 30 }, (_, i) => "/c/1.html?p=" + (i + 1))' } });
    const pages = new Map([[CHAPTER_URL, `<div class="content"><p>一</p></div>`]]);
    for (let i = 1; i <= 30; i += 1) pages.set(`${CHAPTER_URL}?p=${i}`, `<div class="content"><p>${i}</p></div>`);
    await expect(engineFetchContent(src, CHAPTER_URL, context(pages), true)).rejects.toThrowError('content_page_limit');
  });
});
