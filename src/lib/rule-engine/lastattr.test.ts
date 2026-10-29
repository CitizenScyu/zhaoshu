// lastattr1029：字符串字段多段规则的末段裸名按属性取（ENGINE_SYNTAX_LAST_ATTR）——legado getResultList 的 lastRule 口径。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchContent, engineFetchToc, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesLastAttrSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldStrings, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, ruleMayUseLastAttr } from './parse';
import { ENGINE_SEMANTICS_LAST_ATTR_BIT, engineSemanticsVersion, engineSyntaxLastAttrEnabled } from './syntax-flags';
import type { FieldIr, RuleIr } from './types';

const SITE = 'https://h.example';
const on = (rule: string, field = 'ruleBookInfo.name') => parseFieldRule(rule, { field, lastAttrEnabled: true });
const off = (rule: string, field = 'ruleBookInfo.name') => parseFieldRule(rule, { field, lastAttrEnabled: false });
const css = (field: FieldIr): Extract<RuleIr, { kind: 'css' }> => {
  const ir = field.rules[0];
  if (ir?.kind !== 'css') throw new Error('not css');
  return ir;
};
const PAGE = '<div class="info"><a class="next" rel="nofollow" onclick="go(\'/b/2.html\')" href="/b/1.html">下一页</a>'
  + '<span>甲</span></div>';
const scope = () => createScope(normalizeBody(PAGE), `${SITE}/b/1.html`);

describe('开关', () => {
  it('engineSyntaxLastAttrEnabled 严格口径', () => {
    expect(engineSyntaxLastAttrEnabled({})).toBe(false);
    expect(engineSyntaxLastAttrEnabled({ ENGINE_SYNTAX_LAST_ATTR: '0' })).toBe(false);
    expect(engineSyntaxLastAttrEnabled({ ENGINE_SYNTAX_LAST_ATTR: 'yes' })).toBe(false);
    expect(engineSyntaxLastAttrEnabled({ ENGINE_SYNTAX_LAST_ATTR: ' On ' })).toBe(true);
    expect(engineSyntaxLastAttrEnabled({ ENGINE_SYNTAX_LAST_ATTR: '1' })).toBe(true);
  });

  it('语义位 2^35，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_LAST_ATTR_BIT).toBe(34359738368);
    const f = false;
    const base = engineSemanticsVersion(f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f);
    expect(engineSemanticsVersion(f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, true))
      .toBe(base + 34359738368);
  });
});

describe('编译', () => {
  it('末段非关键字、非标签名的裸名 on 编成 attr，off 照旧是选择器步', () => {
    for (const name of ['onclick', 'rel', 'class', 'style', 'id']) {
      expect(css(on(`class.info@a@${name}`)).terminal).toEqual({ op: 'attr', name });
      expect(css(on(`class.info@a@${name}`)).chain.map((s) => s.selector)).toEqual(['.info', 'a']);
      const o = css(off(`class.info@a@${name}`));
      expect(o.terminal).toBeUndefined();
      expect(o.chain.map((s) => s.selector)).toEqual(['.info', 'a', name]);
    }
    expect(css(on('@css:div.info a@rel')).terminal).toEqual({ op: 'attr', name: 'rel' });
    expect(css(off('@css:div.info a@rel')).terminal).toBeUndefined();
  });

  it('标签名、关键字、单段、带后缀的末段与列表字段不变', () => {
    for (const rule of ['class.info@a', 'class.info@SPAN', 'class.info@a@text', 'class.info@a@data-id', 'onclick', 'class.info@a.0', 'class.info@a!0']) {
      expect(on(rule)).toEqual(off(rule));
    }
    expect(on('class.info@a@rel', 'ruleToc.chapterList')).toEqual(off('class.info@a@rel', 'ruleToc.chapterList'));
    expect(on('class.info@a@rel', 'ruleBookInfo.intro')).toEqual(off('class.info@a@rel', 'ruleBookInfo.intro'));
    expect(parseFieldRule('class.info@a@rel', { lastAttrEnabled: true })).toEqual(off('class.info@a@rel')); // 无字段名（嵌套段）不开
    expect(() => on('class.info@a@baseUrl')).toThrow(); // legado 特殊变量照旧拒
  });

  it('|| 支、## 尾缀同口径', () => {
    const f = parseFieldRule('class.x@a@onclick||class.info@a@rel##no##NO', { field: 'ruleBookInfo.name', lastAttrEnabled: true, orEnabled: true });
    const or = f.rules[0];
    expect(or?.kind).toBe('or');
    if (or?.kind === 'or') expect(or.branches.map((b) => (b.kind === 'css' ? b.terminal : undefined)))
      .toEqual([{ op: 'attr', name: 'onclick' }, { op: 'attr', name: 'rel' }]);
  });
});

describe('求值', () => {
  it('on 取属性值，off 取不到节点得空', () => {
    expect(evaluateField(on('class.info@a@rel'), scope())).toBe('nofollow');
    expect(evaluateField(off('class.info@a@rel'), scope())).toBe('');
    expect(evaluateField(on("class.info@a@onclick##.*'(.+)'.*##$1", 'ruleContent.nextContentUrl'), scope())).toBe('/b/2.html');
    expect(evaluateField(on('class.info@span'), scope())).toBe(evaluateField(off('class.info@span'), scope()));
  });

  it('JS 链规则段沿用所在字段口径；前导 @ 的单名（legado trim 后单段）对当前元素取属性', async () => {
    await preloadJsSandbox();
    const js = { jsEnabled: true, jsExtEnabled: true };
    const rule = "class.info@a@onclick@js:result.match(/'(.+)'/)[1]";
    const onIr = parseFieldRule(rule, { ...js, field: 'ruleContent.nextContentUrl', lastAttrEnabled: true });
    expect(evaluateField(onIr, scope())).toBe('/b/2.html');
    const offIr = parseFieldRule(rule, { ...js, field: 'ruleContent.nextContentUrl', lastAttrEnabled: false });
    expect(() => evaluateField(offIr, scope())).toThrow(); // off：onclick 当子选择器，result 为空，match 得 null
    const lead = parseFieldRule('@onclick@js:result', { ...js, field: 'ruleSearch.bookUrl', lastAttrEnabled: true });
    expect(css(lead.chain?.[0]?.kind === 'rule' ? lead.chain[0].field : { rules: [] }).terminal).toEqual({ op: 'attr', name: 'onclick' });
    // 装饰字段的 JS 链本就不收，规则段也不带口径。
    expect(() => parseFieldRule(rule, { ...js, field: 'ruleBookInfo.intro', lastAttrEnabled: true })).toThrow();
  });
});

describe('翻页字段列表口径（legado getStringList）', () => {
  afterEach(() => vi.unstubAllEnvs());
  const PSITE = 'https://book15.net'; // 过 host 门（.example 保留域取页被拒）
  const opt = (n: number) => `<a rel="/t/${n}.html">${n}</a>`;
  const select = `<div class="pg">${opt(1)}${opt(2)}${opt(3)}</div>`;
  const ch = (n: number) => `<li class="ch"><a href="/c/${n}.html">第${n}章</a></li>`;
  const tocScope = () => createScope(normalizeBody(`${ch(1)}${select}`), `${PSITE}/t/1.html`);

  it('next* 非链规则末段 attr 挂 nextList、逐节点取值、## 逐项替换；off / 非 next* / 关键字末段不挂', () => {
    const f = on('class.pg@a@rel', 'ruleToc.nextTocUrl');
    expect(f.nextList).toBe(true);
    expect(evaluateFieldStrings(f, tocScope())).toEqual(['/t/1.html', '/t/2.html', '/t/3.html']);
    expect(evaluateFieldStrings(on('class.pg@a@rel##/t/##/p/', 'ruleContent.nextContentUrl'), tocScope()))
      .toEqual(['/p/1.html', '/p/2.html', '/p/3.html']);
    expect(off('class.pg@a@rel', 'ruleToc.nextTocUrl').nextList).toBeUndefined();
    expect(on('class.pg@a@rel', 'ruleToc.chapterUrl').nextList).toBeUndefined();
    expect(on('class.pg@a@href', 'ruleToc.nextTocUrl').nextList).toBeUndefined();
    const or = parseFieldRule('class.pg@a@rel||class.next@href', { field: 'ruleToc.nextTocUrl', lastAttrEnabled: true, orEnabled: true });
    expect(or.nextList).toBe(true);
    expect(evaluateFieldStrings(or, tocScope())).toEqual(['/t/1.html', '/t/2.html', '/t/3.html']);
  });

  const src = (rules: Record<string, unknown>): EngineSource => {
    const merged = { ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' }, ruleContent: { content: '.content@html' }, ...rules };
    return { url: PSITE, name: '合成源', searchUrl: `${PSITE}/s?q={{key}}`, compiled: compileSource({ url: PSITE, searchUrl: `${PSITE}/s?q={{key}}`, rules: merged }) };
  };
  const ctx = (pages: Map<string, string>, seen: string[]): SourceRequestContext => ({
    page: async (url: string) => {
      seen.push(url);
      const text = pages.get(url);
      if (text === undefined) throw new Error('Unexpected request: ' + url);
      return { url, text };
    },
  }) as unknown as SourceRequestContext;

  it('目录：下拉分页一次给出全部页，去掉当前页后并发抓、这些页不再取下一页；off 只有首页', async () => {
    const pages = new Map([
      [`${PSITE}/t/1.html`, `${ch(1)}${select}`],
      [`${PSITE}/t/2.html`, `${ch(2)}${select}`],
      [`${PSITE}/t/3.html`, `${ch(3)}${select}`],
    ]);
    vi.stubEnv('ENGINE_SYNTAX_LAST_ATTR', '1');
    const seen: string[] = [];
    const toc = await engineFetchToc(src({ ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'class.pg@a@rel' } }),
      `${PSITE}/t/1.html`, ctx(pages, seen), true);
    expect(toc.chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第3章']);
    expect(seen).toEqual([`${PSITE}/t/1.html`, `${PSITE}/t/2.html`, `${PSITE}/t/3.html`]);
    vi.stubEnv('ENGINE_SYNTAX_LAST_ATTR', '0');
    const offSeen: string[] = [];
    // 换个规则文本避开编译缓存（toc 字段不计语义位，缓存键开关两态相同）。
    const offToc = await engineFetchToc(src({ ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: 'class.pg@tag.a@rel' } }),
      `${PSITE}/t/1.html`, ctx(pages, offSeen));
    expect(offToc.chapters.map((c) => c.title)).toEqual(['第1章']);
    expect(offSeen).toEqual([`${PSITE}/t/1.html`]);
  });

  it('正文：下拉分页全部抓取拼接；命中下一章的项剔除', async () => {
    const body = (t: string) => `<div class="content"><p>${t}</p></div><div class="pg">${opt(1)}${opt(2)}<a rel="/c/2.html">x</a></div>`;
    const pages = new Map([[`${PSITE}/t/1.html`, body('一')], [`${PSITE}/t/2.html`, body('二')]]);
    vi.stubEnv('ENGINE_SYNTAX_LAST_ATTR', '1');
    const seen: string[] = [];
    const out = await engineFetchContent(src({ ruleContent: { content: '.content@html', nextContentUrl: 'class.pg@a@rel' } }),
      `${PSITE}/t/1.html`, ctx(pages, seen), true, `${PSITE}/c/2.html`);
    expect(out.text).toBe('一\n二');
    expect(seen).toEqual([`${PSITE}/t/1.html`, `${PSITE}/t/2.html`]);
  });
});

describe('语义位判据', () => {
  it('ruleMayUseLastAttr 只看 @裸名 紧跟串尾/尾缀/组合符', () => {
    expect(ruleMayUseLastAttr('class.b@a@onclick')).toBe(true);
    expect(ruleMayUseLastAttr('class.b@a@rel##x##')).toBe(true);
    expect(ruleMayUseLastAttr('class.b@a@rel||a@href')).toBe(true);
    expect(ruleMayUseLastAttr('class.b@a@href')).toBe(false);
    expect(ruleMayUseLastAttr('class.b@a')).toBe(false);
    expect(ruleMayUseLastAttr('class.b@a@data-id')).toBe(false);
    expect(ruleMayUseLastAttr('$.data.url')).toBe(false);
  });

  it('只有搜索 name/author/bookUrl 计位；开关关不计', () => {
    const mk = (search: Record<string, string>, toc: Record<string, string> = {}) => ({
      url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: { ruleSearch: { bookList: '.b', name: 'a@text', ...search }, ruleToc: toc },
    });
    const hit = mk({ bookUrl: 'class.b@a@onclick##(\\d+)##/b/$1' });
    const tocOnly = mk({ bookUrl: 'a@href' }, { chapterList: 'li', chapterUrl: 'a@rel' });
    expect(sourceUsesLastAttrSyntax(hit.rules)).toBe(true);
    expect(sourceUsesLastAttrSyntax(tocOnly.rules)).toBe(false);
    const v = (s: ReturnType<typeof mk>, lastAttrEnabled: boolean) => Number(engineSourceRevision(s, { lastAttrEnabled }).split(':')[0]);
    expect(v(hit, true) - v(hit, false)).toBe(34359738368);
    expect(v(tocOnly, true)).toBe(v(tocOnly, false));
  });
});
