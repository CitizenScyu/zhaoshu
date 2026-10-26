// read1027 可读性影子腿：只观测不判定——结论进 readability 汇总，rows/verdicts 与关闭时逐字相同。
// 传输层注入（按 path 分派的站点桩），校验函数（checkSourceUrl）不 mock。
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ADMISSION_READABILITY_SHADOW, READABILITY_MIN_CHARS, admissionReadabilityShadowMax, readabilityShadow,
  runAdmissionBatch, searchAdmission, type AdmissionTransport,
} from './admission';
import type { RawSource } from './compile-smoke';

const HOST = 'rd.example.com';
const BASE = `https://${HOST}`;
const hosts = new Set([HOST]);
const signal = () => new AbortController().signal;
const html = (body: string, status = 200) =>
  new Response(`<html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

function source(over: Partial<RawSource> = {}): RawSource {
  return {
    bookSourceUrl: BASE, bookSourceName: '合成源', searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
    ruleBookInfo: { tocUrl: '.tocl@href' },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
    ...over,
  } as RawSource;
}

const SEARCH = '<div class="i"><span class="t">别的书</span><a href="/b/9">x</a></div>'
  + '<div class="i"><span class="t">斗破苍穹</span><a href="/b/1">x</a></div>';
const toc = (n: number, host = HOST) => `<ul class="toc">${Array.from({ length: n }, (_, i) =>
  `<li><a href="https://${host}/c/${i}">第${i + 1}章</a></li>`).join('')}</ul>`;
const chapter = (chars: number) => `<div class="c">${'字'.repeat(chars)}</div>`;

/** path → 响应；未登记 path 一律 404。记录请求过的 path。 */
function site(routes: Record<string, () => Response>) {
  const paths: string[] = [];
  const fetchPage = vi.fn<AdmissionTransport>(async (input) => {
    const { pathname } = new URL(input);
    paths.push(pathname);
    return (routes[pathname] ?? (() => html('nf', 404)))();
  });
  return { fetchPage, paths };
}

const sample = { url: '/b/1', pageUrl: `${BASE}/s?q=x` };
const shadowOptions = (fetchPage: AdmissionTransport) => ({ fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0 });

describe('readabilityShadow 单本抽检', () => {
  it('详情 → tocUrl 目录 → 中间章正文足量 ⇒ readable，抽的是中间章', async () => {
    const stub = site({
      '/b/1': () => html('<a class="tocl" href="/b/1/toc">目录</a>'),
      '/b/1/toc': () => html(toc(10)),
      '/c/5': () => html(chapter(800)),
    });
    const result = await readabilityShadow(source(), sample, shadowOptions(stub.fetchPage));
    expect(result).toEqual({ verdict: 'readable', chapters: 10, chars: 800, error: '' });
    expect(stub.paths).toEqual(['/b/1', '/b/1/toc', '/c/5']);
  });

  it('无 tocUrl 规则 ⇒ 详情页即目录页，不重复请求', async () => {
    const stub = site({ '/b/1': () => html(toc(3)), '/c/1': () => html(chapter(600)) });
    const result = await readabilityShadow(source({ ruleBookInfo: {} }), sample, shadowOptions(stub.fetchPage));
    expect(result.verdict).toBe('readable');
    expect(stub.paths).toEqual(['/b/1', '/c/1']);
  });

  it('中间章只有预览字数（付费墙形态）⇒ content_short', async () => {
    const stub = site({ '/b/1': () => html(toc(4)), '/c/2': () => html(chapter(READABILITY_MIN_CHARS - 1)) });
    const result = await readabilityShadow(source({ ruleBookInfo: {} }), sample, shadowOptions(stub.fetchPage));
    expect(result).toMatchObject({ verdict: 'content_short', chapters: 4, chars: READABILITY_MIN_CHARS - 1 });
  });

  it('正文规则命中为空 ⇒ content_empty', async () => {
    const stub = site({ '/b/1': () => html(toc(1)), '/c/0': () => html('<div class="other">正文</div>') });
    const result = await readabilityShadow(source({ ruleBookInfo: {} }), sample, shadowOptions(stub.fetchPage));
    expect(result).toMatchObject({ verdict: 'content_empty', chapters: 1, chars: 0 });
  });

  it('目录页解析不出章节 ⇒ toc_empty，不请求正文', async () => {
    const stub = site({ '/b/1': () => html('<p>改版了</p>') });
    const result = await readabilityShadow(source({ ruleBookInfo: {} }), sample, shadowOptions(stub.fetchPage));
    expect(result).toEqual({ verdict: 'toc_empty', chapters: 0, chars: 0, error: '' });
    expect(stub.paths).toEqual(['/b/1']);
  });

  it('章节链接指向未声明 host ⇒ 过准入门被丢弃 ⇒ toc_empty，不向外站发请求', async () => {
    const stub = site({ '/b/1': () => html(toc(3, 'evil.example.net')) });
    const result = await readabilityShadow(source({ ruleBookInfo: {} }), sample, shadowOptions(stub.fetchPage));
    expect(result.verdict).toBe('toc_empty');
    expect(stub.fetchPage.mock.calls.every(([input]) => new URL(input).hostname === HOST)).toBe(true);
  });

  it('正文页 403 ⇒ challenge，error 带阶段前缀', async () => {
    const stub = site({ '/b/1': () => html(toc(2)), '/c/1': () => html('blocked', 403) });
    const result = await readabilityShadow(source({ ruleBookInfo: {} }), sample, shadowOptions(stub.fetchPage));
    expect(result).toEqual({ verdict: 'challenge', chapters: 2, chars: 0, error: 'content:403' });
  });

  it('详情页 5xx ⇒ http_error；样本 URL 越界 ⇒ url_invalid（零请求）', async () => {
    const down = site({ '/b/1': () => html('x', 502) });
    expect((await readabilityShadow(source(), sample, shadowOptions(down.fetchPage))).verdict).toBe('http_error');
    const none = site({});
    const result = await readabilityShadow(source(), { url: 'https://evil.example.net/b/1', pageUrl: sample.pageUrl }, shadowOptions(none.fetchPage));
    expect(result.verdict).toBe('url_invalid');
    expect(none.fetchPage).not.toHaveBeenCalled();
  });

  it('预算判否 ⇒ skipped，不再发请求；从不抛错', async () => {
    const stub = site({ '/b/1': () => html(toc(2)), '/c/1': () => html(chapter(800)) });
    let left = 1;
    const result = await readabilityShadow(source({ ruleBookInfo: {} }), sample, {
      ...shadowOptions(stub.fetchPage), canFetch: () => left-- > 0,
    });
    expect(result).toEqual({ verdict: 'skipped', chapters: 2, chars: 0, error: 'content:budget' });
    expect(stub.paths).toEqual(['/b/1']);
  });
});

describe('searchAdmission sampleBook', () => {
  it('开：ok 结果带书名含命中词的候选；关：结果形状逐字不变', async () => {
    const stub = site({ '/s': () => html(SEARCH) });
    const on = await searchAdmission(source(), { fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0, sampleBook: true });
    expect(on.sample).toEqual({ title: '斗破苍穹', url: `${BASE}/b/1`, pageUrl: expect.stringContaining(`${BASE}/s?q=`) });
    const off = await searchAdmission(source(), { fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0 });
    expect(off).toEqual({ verdict: 'ok', candidateCount: 2, status: 200, error: '' });
  });
});

describe('runAdmissionBatch 影子腿只观测', () => {
  const routes = {
    '/s': () => html(SEARCH),
    '/b/1': () => html('<a class="tocl" href="/b/1/toc">目录</a>'),
    '/b/1/toc': () => html(toc(4)),
    '/c/2': () => html(chapter(100)),
  };
  const batch = (fetchPage: AdmissionTransport, readabilityShadow?: number, canProbe?: () => boolean) => runAdmissionBatch({
    candidates: [{ url: BASE, source: source() }], declaredHosts: hosts, existing: new Map(), fetchPage, signal: signal(),
    throttleMs: 0, now: () => new Date('2026-10-27T00:00:00Z'), ...(readabilityShadow === undefined ? {} : { readabilityShadow }),
    ...(canProbe ? { canProbe } : {}),
  });

  it('关（缺省/0）：无 readability 字段、只发搜索请求', async () => {
    for (const value of [undefined, 0]) {
      const stub = site(routes);
      const result = await batch(stub.fetchPage, value);
      expect(result).not.toHaveProperty('readability');
      expect(stub.paths).toEqual(['/s']);
    }
  });

  it('开：rows/verdicts 与关时逐字相同，汇总带 host 级明细', async () => {
    const off = await batch(site(routes).fetchPage);
    const on = await batch(site(routes).fetchPage, 5);
    expect(on.rows).toEqual(off.rows);
    expect(on.verdicts).toEqual(off.verdicts);
    expect(on.readability).toEqual({
      checked: 1, verdicts: { content_short: 1 },
      samples: [{ host: HOST, verdict: 'content_short', chapters: 4, chars: 100, error: '' }],
    });
  });

  it('搜索后预算判否：不做影子检查（checked 0），写库行照常', async () => {
    let calls = 0;
    const result = await batch(site(routes).fetchPage, 5, () => calls++ === 0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].search_verdict).toBe('ok');
    expect(result.readability).toEqual({ checked: 0, verdicts: {}, samples: [] });
  });
});

describe('admissionReadabilityShadowMax', () => {
  it('缺失/非法/≤0 = 关；超上限夹到上限', () => {
    expect(admissionReadabilityShadowMax({})).toBe(0);
    expect(admissionReadabilityShadowMax({ ADMISSION_READABILITY_SHADOW_MAX: 'x' })).toBe(0);
    expect(admissionReadabilityShadowMax({ ADMISSION_READABILITY_SHADOW_MAX: '-3' })).toBe(0);
    expect(admissionReadabilityShadowMax({ ADMISSION_READABILITY_SHADOW_MAX: '20' })).toBe(20);
    expect(admissionReadabilityShadowMax({ ADMISSION_READABILITY_SHADOW_MAX: '999' })).toBe(MAX_ADMISSION_READABILITY_SHADOW);
  });
});
