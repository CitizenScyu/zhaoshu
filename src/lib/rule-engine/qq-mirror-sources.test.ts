import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { refreshSupportedHosts, validateSourceUrl } from '@/lib/source-policy';
import { engineFetchContent, engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { compileSource } from './compile';
import type { RawSource } from './compile-smoke';

// qqsrc42：QQ 系镜像站书源（public/qq-mirror-sources.json，作为 SHUYUAN_EXTRA_FEEDS 直链），
// 页面全部为 2026-10-16 出网实采（fixtures/qq-mirror/），本文件离线跑真实 HTML 断言。
// 落盘形状是硬约束（src/lib/shuyuan.ts mergeIntoPool 只收：isRecord + bookSourceUrl 是 string +
// normalizeUrl 非空 + cleanJson 过），所以文件必须是裸数组而不是对象包一层。

const feed = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../public/qq-mirror-sources.json'), 'utf8'),
) as RawSource[];

// 运行时 host 门常态只放内建集合；两站上线要靠 cron 准入批次把 ok 态 host 并进来
// （refreshSupportedHosts，source-policy §6.1）。测试按同一入口开门，不绕过门本身。
refreshSupportedHosts(feed.map((s) => new URL(String(s.bookSourceUrl)).hostname));

const fixture = (name: string) => readFileSync(path.resolve(__dirname, 'fixtures/qq-mirror', name), 'utf8');

const sourceOf = (host: string): RawSource => {
  const found = feed.find((s) => String(s.bookSourceUrl).includes(host));
  if (!found) throw new Error(`feed 缺源 ${host}`);
  return found;
};

function engineSource(raw: RawSource): EngineSource {
  const url = String(raw.bookSourceUrl);
  const searchUrl = String(raw.searchUrl);
  const rules = {
    ruleSearch: raw.ruleSearch, ruleBookInfo: raw.ruleBookInfo,
    ruleToc: raw.ruleToc, ruleContent: raw.ruleContent,
  } as Record<string, unknown>;
  return { url, name: String(raw.bookSourceName), searchUrl, compiled: compileSource({ url, searchUrl, rules }) };
}

/** 假 context：只按「URL 后缀/精确串」回放已存页面，未登记的 URL 直接抛（引擎取页路径本身也成了断言）。 */
function context(pages: Map<string, string>): SourceRequestContext {
  return {
    page: async (url: string) => {
      const exact = pages.get(url);
      if (exact !== undefined) return { url, text: exact };
      for (const [prefix, text] of pages) {
        if (url.startsWith(prefix)) return { url, text };
      }
      throw new Error('Unexpected engine request: ' + url);
    },
  } as unknown as SourceRequestContext;
}

describe('feed 文件形状（mergeIntoPool 入池过滤条件）', () => {
  it('是裸 JSON 数组，恰好两条源，bookSourceUrl 分属两站', () => {
    expect(Array.isArray(feed)).toBe(true);
    expect(feed.map((s) => s.bookSourceUrl).sort()).toEqual([
      'https://leesven.com',
      'https://www.shidaxiaoshuo.com',
    ]);
  });

  it('每条都是 record、bookSourceUrl 是非空 string、且过 cleanJson/normalizeUrl 口径', () => {
    for (const item of feed) {
      expect(typeof item).toBe('object');
      expect(item).not.toBeNull();
      expect(Array.isArray(item)).toBe(false);
      expect(typeof item.bookSourceUrl).toBe('string');
      expect(new URL(String(item.bookSourceUrl)).href).not.toBe('');
      expect(JSON.parse(JSON.stringify(item))).toEqual(item); // cleanJson 往返稳定
    }
  });

  it('每条 compileSource 不抛（核心字段无 RULE_UNSUPPORTED）', () => {
    for (const raw of feed) {
      const compiled = engineSource(raw).compiled;
      expect([...compiled.keys()].some((k) => k.startsWith('ruleSearch.bookList'))).toBe(true);
      for (const [key, ir] of compiled) {
        expect(ir, `${raw.bookSourceUrl} ${key}`).not.toHaveProperty('skipped');
      }
    }
  });

  it('validateSourceUrl 过 bookSourceUrl 与 searchUrl 展开后的地址（源级三级门同款判据）', () => {
    for (const raw of feed) {
      const base = String(raw.bookSourceUrl);
      expect(validateSourceUrl(base).hostname).toBe(new URL(base).hostname);
      const searchUrl = String(raw.searchUrl).replace(/\{\{\w+\}\}/g, 'x');
      expect(validateSourceUrl(searchUrl, `${base}/`).protocol).toBe('https:');
      // 反例钉死：http 明文与裸 IP 仍被同一把锁拒（source-policy 41-urlfix 只升级模板字面 http）
      expect(() => validateSourceUrl(`http://${new URL(base).hostname}/x`, base)).toThrow();
      expect(() => validateSourceUrl('https://127.0.0.1/x', base)).toThrow();
    }
  });

  it('每条带 checkKeyWord（准入搜索判据）与近期 lastUpdateTime（extra feed 版本取舍）', () => {
    for (const raw of feed) {
      expect(String(raw.checkKeyWord).trim().length).toBeGreaterThan(0);
      expect(Number(raw.lastUpdateTime)).toBeGreaterThan(0);
    }
    // checkKeyWord 必须是本站确定收录的书名：lee=《绝品邪少》（作者陨落星辰），sdx=《唐朝诡事录》（作者魏风华）
    expect(String(sourceOf('leesven.com').checkKeyWord)).toBe('绝品邪少');
    expect(String(sourceOf('shidaxiaoshuo.com').checkKeyWord)).toBe('唐朝诡事录');
  });
});

describe('shidaxiaoshuo.com 离线真实 HTML 断言', () => {
  const raw = sourceOf('shidaxiaoshuo.com');
  const source = engineSource(raw);
  const base = String(raw.bookSourceUrl);

  it('搜索「魏风华」→ 3 条候选，name/author/bookUrl 全非空且绝对化', async () => {
    const pages = new Map([[`${base}/search/?searchkey=${encodeURIComponent('魏风华')}`, fixture('sdx-search.html')]]);
    const results = await engineSearchBook(source, '魏风华', context(pages));
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.author).toBe('魏风华');
      expect(r.bookUrl.startsWith(`${base}/book/`)).toBe(true);
    }
    expect(results.map((r) => r.title)).toEqual([
      '唐朝诡事录', '唐朝诡事录2：长安鬼迹', '唐朝诡事录3：骇人听闻大结局',
    ]);
  });

  it('搜索判据：checkKeyWord「唐朝诡事录」在搜作者时不会被回显带偏（链接文本命中）', async () => {
    const pages = new Map([[`${base}/search/?searchkey=${encodeURIComponent('魏风华')}`, fixture('sdx-search.html')]]);
    const results = await engineSearchBook(source, '魏风华', context(pages));
    expect(results.some((r) => r.title.includes('唐朝诡事录'))).toBe(true);
  });

  it('详情页 → name/author/tocUrl 三项非空，tocUrl 落到 /index/ 目录页', async () => {
    const bookUrl = `${base}/book/VzpHw/`;
    const detail = await engineFetchDetail(source, bookUrl, context(new Map([[bookUrl, fixture('sdx-detail.html')]])));
    expect(detail.title).toBe('唐朝诡事录');
    expect(detail.author).toBe('魏风华');
    expect(detail.tocUrl).toBe(`${base}/index/VzpHw/`);
  });

  it('目录页 → 章节列表非空，翻页（nextTocUrl）收满该书全部 58 章', async () => {
    const tocUrl = `${base}/index/VzpHw/`;
    const { chapters } = await engineFetchToc(source, tocUrl, context(new Map([
      [tocUrl, fixture('sdx-toc.html')],
      [`${base}/index/VzpHw/2/`, fixture('sdx-toc2.html')],
    ])));
    expect(chapters.length).toBe(58);
    expect(chapters[0]).toEqual({
      title: '唐朝诡事录 自序 古人倦夜长',
      url: `${base}/read/VzpHw/357684.html`,
    });
    expect(chapters.at(-1)).toEqual({
      title: '撒马尔罕的金桃',
      url: `${base}/read/VzpHw/357917.html`,
    });
    expect(chapters.every((c) => c.url.startsWith(`${base}/read/`))).toBe(true);
  });

  it('正文页 → 正文非空（该章为「自序」，实抽 1937 字），且不含导航/推荐噪声', async () => {
    const chapterUrl = `${base}/read/VzpHw/357684.html`;
    const { text } = await engineFetchContent(source, chapterUrl, context(new Map([[chapterUrl, fixture('sdx-content.html')]])));
    expect(text.length).toBeGreaterThan(1500);
    expect(text).toContain('志怪笔记');
    expect(text).not.toContain('好书推荐');
    expect(text).not.toContain('下一章');
  });
  it('正文页（叙述章，非自序）→ 正文非空且无导航/推荐噪声', async () => {
    const chapterUrl = `${base}/read/VzpHw/357692.html`;
    const { text } = await engineFetchContent(source, chapterUrl, context(new Map([[chapterUrl, fixture('sdx-content2.html')]])));
    expect(text.length).toBeGreaterThan(1500);
    expect(text).toContain('安史之乱');
    expect(text).not.toContain('好书推荐');
    expect(text).not.toContain('下一章');
  });
});

describe('leesven.com 离线真实 HTML 断言（搜索段可用、正文段结构性缺失）', () => {
  const raw = sourceOf('leesven.com');
  const source = engineSource(raw);
  const base = String(raw.bookSourceUrl);

  it('搜索「绝品邪少」→ 候选非空，author 为作者名，bookUrl 指向 /leebook/', async () => {
    const pages = new Map([[`${base}/search/?searchkey=${encodeURIComponent('绝品邪少')}`, fixture('leesven-search2.html')]]);
    const results = await engineSearchBook(source, '绝品邪少', context(pages));
    expect(results.length).toBe(3);
    expect(results[0]).toEqual({
      title: '绝品邪少', author: '我爱吃番茄', bookUrl: `${base}/leebook/108906.html`,
    });
    expect(results.some((r) => r.author === '陨落星辰')).toBe(true);
  });

  it('详情页 → name/author 取到（og:novel:author 与 h1 两条都可用）', async () => {
    const bookUrl = `${base}/leebook/1752.html`;
    const detail = await engineFetchDetail(source, bookUrl, context(new Map([[bookUrl, fixture('leesven-detail.html')]])));
    expect(detail.title).toBe('绝品邪少');
    expect(detail.author).toBe('陨落星辰');
    // 目录页不输出章节链接 ⇒ tocUrl 无值（引擎按缺省回退用详情页当目录页）
    expect(detail.tocUrl).toBeUndefined();
  });

  it('目录页实测零章节（转码展示站）：引擎解析出空列表 —— 这是站侧事实，不是规则缺陷', async () => {
    const tocUrl = `${base}/leebook/1752.html`;
    const { chapters } = await engineFetchToc(source, tocUrl, context(new Map([[tocUrl, fixture('leesven-toc.html')]])));
    expect(chapters).toEqual([]);
  });
});
