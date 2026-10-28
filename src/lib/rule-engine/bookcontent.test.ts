// bookcontent1029：ENGINE_SYNTAX_BOOK_FIELDS 的书籍成员在正文两字段（content / nextContentUrl）按目录口径放行（legado BookContent
// 的 AnalyzeRule 带着同一本 Book）：编译期成员集、按源判定、门面 engineFetchContent 收 book、准入影子腿正文带 book。
// 规则与页面均为合成形态。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { readabilityShadow, type AdmissionTransport } from './admission';
import { engineFetchContent, type EngineSource } from './api';
import { compileSource, engineSourceRevision } from './compile';
import type { RawSource } from './compile-smoke';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { RuleEngineError } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const SITE = 'https://book15.net';
const CONTENT = 'ruleContent.content';
const NEXT = 'ruleContent.nextContentUrl';
const ON = { jsEnabled: true, jsBindEnabled: true, bookFieldsEnabled: true } as const;
const OFF = { ...ON, bookFieldsEnabled: false } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const AD = '#c@text##本站{{book.name}}.*';
const BOOK = { name: '斗破苍穹', author: '天蚕土豆', bookUrl: `${SITE}/b/1.html`, tocUrl: `${SITE}/toc/1.html` };

/** 环境开关：保存 → 设置 → 恢复（pageScope / readabilityShadow 读 env）。 */
function withEnv(values: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [key, next] of Object.entries(values)) {
      saved[key] = process.env[key];
      process.env[key] = next;
    }
  });
  afterEach(() => {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('编译', () => {
  it('正文两字段见 name/author/bookUrl/tocUrl（含 ## 正则里的 {{}}）；kind 等与 Java String 当 JS 字符串用照旧拒', () => {
    expect(on(AD, CONTENT).bookMembers).toEqual(['name']);
    expect(on('#c@text@js:result + book.author + book.tocUrl', CONTENT).bookMembers).toEqual(['author', 'tocUrl']);
    expect(on('#c@text@js:book.bookUrl + result', CONTENT).bookMembers).toEqual(['bookUrl']);
    expect(on('a.n@href@js:result + "?n=" + String(book.name).length', NEXT).bookMembers).toEqual(['name']);
    expect(codeOf(() => on('#c@text@js:result + book.kind', CONTENT))).toBe('unsupported_js');
    expect(codeOf(() => on('#c@text@js:result + book.name.length', CONTENT))).toBe('unsupported_js');
  });

  it('off 态、宿主绑定关照旧拒', () => {
    expect(codeOf(() => parseFieldRule(AD, { ...OFF, field: CONTENT }))).toBe('unsupported_js');
    expect(codeOf(() => on('#c@text@js:result + book.name', CONTENT, { jsBindEnabled: false }))).toBe('unsupported_js');
  });

  it('按源判定：正文读成员的源换版本；canReName 源不开', () => {
    const rev = (s: ReturnType<typeof raw>, bookFieldsEnabled: boolean) =>
      engineSourceRevision(s, { jsEnabled: true, jsBindEnabled: true, bookFieldsEnabled, jsoupEnabled: false });
    const content = raw({ ruleContent: { content: AD } });
    const reName = raw({ ruleBookInfo: { canReName: '1' }, ruleContent: { content: AD } });
    expect(rev(content, true)).not.toBe(rev(content, false));
    expect(rev(reName, true)).toBe(rev(reName, false));
    expect(compileSource(reName, ON).get(CONTENT)).toEqual({ skipped: 'unsupported' });
  });
});

describe('门面 engineFetchContent', () => {
  withEnv({ ENGINE_SYNTAX_JS_BIND: '1' });
  const engine = (rules: Record<string, unknown>): EngineSource => ({
    url: SITE, name: '正文成员源', searchUrl: `${SITE}/s?q={{key}}`, compiled: compileSource(raw(rules), ON),
  });
  const context = (pages: Record<string, string>): SourceRequestContext => ({
    page: async (url: string) => {
      const { pathname, search } = new URL(url);
      const text = pages[pathname + search];
      if (text === undefined) throw new Error('Unexpected request: ' + url);
      return { url, text };
    },
  } as unknown as SourceRequestContext);
  const URL1 = `${SITE}/c/1.html`;
  const rules = {
    ruleContent: { content: AD, nextContentUrl: 'a.n@href@js:result ? result + "?a=" + String(book.author).length : ""' },
  };
  const pages = {
    '/c/1.html': '<div id="c">正文一本站斗破苍穹最新章节</div><a class="n" href="/c/1_2.html">下一页</a>',
    '/c/1_2.html?a=4': '<div id="c">正文二本站斗破苍穹</div>',
  };

  it('书名拼进正则去广告；下一页读作者', async () => {
    const { text } = await engineFetchContent(engine(rules), URL1, context(pages), false, undefined, '第1章', BOOK);
    expect(text).toBe('正文一\n正文二');
  });

  it('不传 book、成员为空：读成员的正文求值失败（不猜值）', async () => {
    await expect(engineFetchContent(engine(rules), URL1, context(pages))).rejects.toThrow(RuleEngineError);
    await expect(engineFetchContent(engine(rules), URL1, context(pages), false, undefined, undefined, { ...BOOK, name: '' }))
      .rejects.toThrow(RuleEngineError);
  });

  it('不读成员的源：传不传 book 结果相同', async () => {
    const plain = engine({ ruleContent: { content: '#c@text' } });
    const one = { '/c/1.html': '<div id="c">正文一</div>' };
    const withBook = await engineFetchContent(plain, URL1, context(one), false, undefined, undefined, BOOK);
    expect(withBook).toEqual(await engineFetchContent(plain, URL1, context(one)));
  });
});

describe('准入影子腿正文带 book', () => {
  withEnv({ ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JS_BIND: '1', ENGINE_SYNTAX_BOOK_FIELDS: '1' });
  const HOST = 'rd.example.com';
  const BASE = `https://${HOST}`;
  const html = (body: string, status = 200) =>
    new Response(`<html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const fetchPage = vi.fn<AdmissionTransport>(async (input) => {
    const body = ({
      '/b/1': '<a class="tocl" href="/b/1/toc">目录</a>',
      '/b/1/toc': `<ul class="toc">${[0, 1, 2, 3].map((i) => `<li><a href="${BASE}/c/${i}">第${i + 1}章</a></li>`).join('')}</ul>`,
      '/c/2': `<div class="c">${'字'.repeat(800)}本站斗破苍穹${'广'.repeat(300)}</div>`,
    } as Record<string, string>)[new URL(input).pathname];
    return body === undefined ? html('nf', 404) : html(body);
  });
  const options = { fetchPage, declaredHosts: new Set([HOST]), signal: new AbortController().signal, throttleMs: 0 };
  const source = {
    bookSourceUrl: BASE, bookSourceName: '合成源', searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: '.t@text', author: '.a@text', bookUrl: 'a@href' },
    ruleBookInfo: { tocUrl: '.tocl@href' },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c@text##本站{{book.name}}.*' },
  } as unknown as RawSource;

  it('样本带 book：正文按书名去尾巴后计字', async () => {
    const book = { name: '斗破苍穹', author: '天蚕土豆', bookUrl: '/b/1' };
    const result = await readabilityShadow(source, { url: '/b/1', pageUrl: `${BASE}/s?q=x`, book }, options);
    expect(result).toEqual({ verdict: 'readable', chapters: 4, chars: 800, error: '' });
  });

  it('样本没带 book：正文求值失败，不算可读', async () => {
    const result = await readabilityShadow(source, { url: '/b/1', pageUrl: `${BASE}/s?q=x` }, options);
    expect(result.verdict).toBe('eval_error');
    expect(result.error).toContain('book.name');
  });
});
