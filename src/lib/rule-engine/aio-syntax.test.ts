// aio1027：ENGINE_SYNTAX_AIO —— legado AllInOne 正则列表（`:` 前缀）的编译、Java→JS 正则翻译、沙箱求值与语义版本。
// 样例规则取自离线池里列表规则以 `:` 开头的真实源（or-sim allinone-dump）。
import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { sourceRevision } from '@/lib/source-revision';
import { engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { aioGroups, aioGroupsFlat, translateJavaRegex } from './aio-syntax';
import { compileSource, engineSourceRevision, sourceUsesAioSyntax } from './compile';
import { compileCoreFieldsFromRules } from './compile-smoke';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule } from './parse';
import { engineSemanticsVersion, engineSyntaxAioEnabled } from './syntax-flags';
import { RuleEngineError } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const ON = { aioEnabled: true, aioGroup: true } as const;
const f = (rule: string, field: string) => parseFieldRule(rule, { ...ON, field });
const tr = (pattern: string) => translateJavaRegex(pattern, pattern);

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const TOC_URL = `${SITE}/book/1/`;

const SHUSHUN_TOC = {
  chapterUrl: '$1##章节目录', chapterList: ':<dd><a href="([^"]*)[^>]*>([^<]*)', chapterName: '$2',
};

function source(rules: Record<string, unknown>, aioEnabled = true, url = SITE): EngineSource {
  const raw = { url, searchUrl: `${url}/s?q={{key}}`, rules };
  return { url, name: 'AllInOne 源', searchUrl: raw.searchUrl, compiled: compileSource(raw, { aioEnabled }) };
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

describe('开关与语义版本', () => {
  it('engineSyntaxAioEnabled 严格口径', () => {
    expect(engineSyntaxAioEnabled({})).toBe(false);
    expect(engineSyntaxAioEnabled({ ENGINE_SYNTAX_AIO: '0' })).toBe(false);
    expect(engineSyntaxAioEnabled({ ENGINE_SYNTAX_AIO: 'yes' })).toBe(false);
    expect(engineSyntaxAioEnabled({ ENGINE_SYNTAX_AIO: ' On ' })).toBe(true);
    expect(engineSyntaxAioEnabled({ ENGINE_SYNTAX_AIO: 'TRUE' })).toBe(true);
  });

  it('AllInOne 位 +128，1–128 逐字不变', () => {
    expect(engineSemanticsVersion(true, true, true, true, true, true, true)).toBe(128);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, true)).toBe(129);
    expect(engineSemanticsVersion(true, true, true, true, true, true, true, true)).toBe(256);
  });

  const plain = { url: 'https://a.example', searchUrl: '/s?q={{key}}', rules: { ruleToc: { chapterList: '.ch', chapterName: 'a@text' } } };
  const aio = { url: 'https://b.example', searchUrl: '/s?q={{key}}', rules: { ruleToc: SHUSHUN_TOC } };
  // legado 只认原文以 `:` 开头（不 trim）
  const spaced = { url: 'https://c.example', searchUrl: '/s?q={{key}}', rules: { ruleToc: { ...SHUSHUN_TOC, chapterList: ' :<dd>(x)' } } };

  it('按源判定：只有列表规则以 `:` 开头的源换版本', () => {
    expect(sourceUsesAioSyntax(plain.rules)).toBe(false);
    expect(sourceUsesAioSyntax(aio.rules)).toBe(true);
    expect(sourceUsesAioSyntax(spaced.rules)).toBe(false);
    expect([...aioGroups({ ruleSearch: { bookList: ':(a)' }, ruleToc: { chapterList: '.x' } })]).toEqual(['ruleSearch']);
    expect([...aioGroupsFlat({ 'ruleToc.chapterList': ':(a)', 'ruleSearch.bookList': '.x' })]).toEqual(['ruleToc']);
    const rev = (src: typeof plain, aioEnabled: boolean) => engineSourceRevision(src, { aioEnabled });
    expect(rev(aio, false)).toBe(`1:${sourceRevision(aio)}`);
    expect(rev(aio, true)).toBe(`129:${sourceRevision(aio)}`);
    expect(rev(plain, true)).toBe(`1:${sourceRevision(plain)}`);
  });

  it('compileSource：off 态 $N 条目照旧 skipped，on 编译成 regexList/groupRef，两态缓存互不污染', () => {
    const offC = compileSource(aio, { aioEnabled: false });
    const onC = compileSource(aio, { aioEnabled: true });
    expect(offC.get('ruleToc.chapterName')).toEqual({ skipped: 'unsupported' });
    expect(onC.get('ruleToc.chapterList')).toMatchObject({ rules: [{ kind: 'regexList', stages: [{ flags: '' }] }] });
    expect(onC.get('ruleToc.chapterName')).toEqual({ rules: [{ kind: 'groupRef', parts: [{ kind: 'group', index: 2 }] }] });
    expect(compileSource(aio, { aioEnabled: false }).get('ruleToc.chapterName')).toEqual({ skipped: 'unsupported' });
  });

  it('compileCoreFieldsFromRules：on 态整组按 AllInOne，off 态 `:` 列表照旧失败', () => {
    const core = { 'ruleToc.chapterList': SHUSHUN_TOC.chapterList, 'ruleToc.chapterName': '$2', 'ruleToc.chapterUrl': '$1' };
    expect(compileCoreFieldsFromRules(core, { aioEnabled: true }).ok).toBe(true);
    expect(compileCoreFieldsFromRules(core, { aioEnabled: false }).ok).toBe(false);
  });
});

describe('parseFieldRule 接线', () => {
  it('off：aioGroup 也不生效，与不带 AllInOne 选项逐字一致', () => {
    expect(parseFieldRule('tag.a@href', { aioEnabled: false, aioGroup: true, field: 'ruleToc.chapterUrl' }))
      .toEqual(parseFieldRule('tag.a@href', { field: 'ruleToc.chapterUrl' }));
    expect(codeOf(() => parseFieldRule('$2', { aioEnabled: false, aioGroup: true, field: 'ruleToc.chapterName' })))
      .toBe(codeOf(() => parseFieldRule('$2', { field: 'ruleToc.chapterName' })));
    expect(codeOf(() => parseFieldRule(SHUSHUN_TOC.chapterList, { aioEnabled: false, field: 'ruleToc.chapterList' })))
      .toBe(codeOf(() => parseFieldRule(SHUSHUN_TOC.chapterList, { field: 'ruleToc.chapterList' })));
  });

  it('on：非 `:` 列表规则、非 AllInOne 组字段照旧', () => {
    expect(parseFieldRule('.ch', { aioEnabled: true, field: 'ruleToc.chapterList' }))
      .toEqual(parseFieldRule('.ch', { field: 'ruleToc.chapterList' }));
    expect(parseFieldRule('$.a', { aioEnabled: true, field: 'ruleToc.chapterName' }))
      .toEqual(parseFieldRule('$.a', { field: 'ruleToc.chapterName' }));
  });

  it('列表：`&&` 切级（逐级 trim、去空段），开头 `(?s)` 转 flags', () => {
    expect(f(':正文卷[\\s\\S]*?/dl&& href ="([^"]+)">([^<]+) &&', 'ruleToc.chapterList')).toEqual({
      rules: [{ kind: 'regexList', stages: [{ pattern: '正文卷[\\s\\S]*?/dl', flags: '' }, { pattern: 'href ="([^"]+)">([^<]+)', flags: '' }] }],
    });
    expect(f(':(?s)(\\d+)" class="(isvip)?[^"]*name[^>]*>([^<]*)', 'ruleToc.chapterList').rules[0])
      .toMatchObject({ stages: [{ pattern: '(\\d+)" class="(isvip)?[^"]*name[^>]*>([^<]*)', flags: 's' }] });
    expect(codeOf(() => f(':(a)##b', 'ruleToc.chapterList'))).toBe('aio_list_shape');
    expect(codeOf(() => f(': && ', 'ruleToc.chapterList'))).toBe('aio_list_shape');
  });

  it('条目：$N（1–2 位贪婪）取组、$0 字面量，`##` 尾缀照常', () => {
    expect(f('$1##章节目录', 'ruleToc.chapterUrl')).toEqual({
      rules: [{ kind: 'groupRef', parts: [{ kind: 'group', index: 1 }] }],
      regex: [{ pattern: '章节目录', replacement: '', flags: 'g' }],
    });
    expect(f('第$2页', 'ruleToc.chapterName').rules[0]).toEqual({
      kind: 'groupRef', parts: [{ kind: 'literal', text: '第' }, { kind: 'group', index: 2 }, { kind: 'literal', text: '页' }],
    });
    expect(f('$12$0', 'ruleToc.chapterName').rules[0]).toEqual({
      kind: 'groupRef', parts: [{ kind: 'group', index: 12 }, { kind: 'literal', text: '$0' }],
    });
    expect(f('$1##(\\d+)##[$1]###', 'ruleToc.chapterName').regex).toEqual([{ pattern: '(\\d+)', replacement: '[$1]', flags: '', first: true }]);
    expect(f('$1##a##$0', 'ruleToc.chapterName').regex).toEqual([{ pattern: 'a', replacement: '$&', flags: 'g' }]);
  });

  it('条目：拒绝不能对齐 legado 的形态', () => {
    expect(codeOf(() => f('##作者：?(.+)##$1###', 'ruleSearch.author'))).toBe('aio_item_shape');
    expect(codeOf(() => f('tag.a@href,{"webView":true}', 'ruleSearch.bookUrl'))).toBe('aio_item_shape');
    expect(codeOf(() => f('https://h.example/x', 'ruleToc.chapterUrl'))).toBe('aio_item_shape');
    expect(codeOf(() => f('$1<js>result</js>', 'ruleToc.chapterUrl'))).toBe('unsupported_js');
    expect(codeOf(() => f('$1@js:result', 'ruleToc.isVolume'))).toBe('unsupported_js');
    expect(codeOf(() => f('{{baseUrl}}$1', 'ruleToc.chapterUrl'))).toBe('aio_dynamic');
    expect(codeOf(() => f('$1@put:{a:$1}', 'ruleToc.chapterUrl'))).toBe('aio_dynamic');
    expect(codeOf(() => f('$1##a##\\n', 'ruleToc.chapterName'))).toBe('aio_replacement');
    expect(codeOf(() => f('$1##a##$2', 'ruleToc.chapterName'))).toBe('aio_replacement');
    expect(codeOf(() => f('$1##(a)##$11', 'ruleToc.chapterName'))).toBe('aio_replacement');
    expect(codeOf(() => f('$1##a##${x}', 'ruleToc.chapterName'))).toBe('aio_replacement');
    expect(codeOf(() => f('x'.repeat(2049), 'ruleToc.chapterName'))).toBe('rule_too_long');
  });

  it('目录下一页：只收正则-only 形态', () => {
    expect(f('##<a href="([^"]+)" class="onclick">下一页##$1###', 'ruleToc.nextTocUrl')).toEqual({
      rules: [{ kind: 'self' }],
      regex: [{ pattern: '<a href="([^"]+)" class="onclick">下一页', replacement: '$1', flags: '', first: true }],
    });
    expect(codeOf(() => f('$1', 'ruleToc.nextTocUrl'))).toBe('aio_next_toc');
    expect(codeOf(() => f('##', 'ruleToc.nextTocUrl'))).toBe('aio_next_toc');
  });
});

describe('translateJavaRegex', () => {
  it.each([
    ['<dd><a href="([^"]*)[^>]*>([^<]*)', 2],
    ["p_(\\d+)::after\\{content:'([^']+)'\\}", 2],
    ['li>[^<]*<li>[^<]*<span class="s1">(?:[^>]*>){2}[^"]*"([^"]*)"[^>]*>([^<]*)<(?:[^>]*>){4}([^<]*)', 3],
    ['a href="(.*?)"\\s+target="_blank">(.*?)<', 2],
    ['(?<name>a)(?=b)(?!c)(?<=d)(?<!e)[\\]\\-x]{1,}?\\x41\\u4e00\\/', 1],
    ['[\\u4e00-\\u9fa5]+', 0],
  ])('放行 %s', (pattern, groups) => {
    expect(tr(pattern).groups).toBe(groups);
  });

  it('开头内联标志：s/i/m 转 flags，u 丢弃', () => {
    expect(tr('(?si)a').flags).toBe('si');
    expect(tr('(?iu)a')).toEqual({ pattern: 'a', flags: 'i', groups: 0 });
    expect(codeOf(() => tr('(?x)a'))).toBe('aio_regex_unsupported');
    expect(codeOf(() => tr('(?s)'))).toBe('aio_regex_unsupported');
  });

  it.each([
    ['\\w+'], ['\\bx'], ['\\Aa'], ['a\\z'], ['\\Qa\\E'], ['\\p{L}'], ['\\1'], ['\\0'], ['\\x{41}'], ['\\h'],
    ['a*+'], ['a++'], ['a?+'], ['a{2}+'], ['a**'], ['a{2}{3}'], ['(?>a)'], ['a(?i)b'], ['(?i:a)'],
    ['[a[b]]'], ['[a&&b]'], ['[]a]'], ['[^]a]'], ['[ab'], ['a{'], ['a{x}'], ['a\\'],
  ])('拒 %s', (pattern) => {
    expect(codeOf(() => tr(pattern))).toBe('aio_regex_unsupported');
  });

  it('JS 编译不过的拒为 aio_regex_invalid', () => {
    expect(codeOf(() => tr('(a'))).toBe('aio_regex_invalid');
    expect(codeOf(() => tr('a)'))).toBe('aio_regex_invalid');
  });
});

describe('求值', () => {
  it('evaluateFieldList：末级每个匹配一条，组值 trim、实体解码；无匹配得空', async () => {
    await preloadJsSandbox();
    const list = f(':<dd><a href="([^"]*)[^>]*>([^<]*)', 'ruleToc.chapterList');
    const name = f('$2', 'ruleToc.chapterName');
    const page = '<dl><dd><a href="/1.html">第一章 甲&amp;乙 </a></dd><dd><a href="/2.html" x>第二章</a></dd></dl>';
    const items = evaluateFieldList(list, createScope(normalizeBody(page), TOC_URL));
    expect(items.map((item) => evaluateField(name, item))).toEqual(['第一章 甲&乙', '第二章']);
    expect(evaluateFieldList(list, createScope(normalizeBody('<p>无</p>'), TOC_URL))).toEqual([]);
  });

  it('整页作用域以外（条目作用域）求值 regexList 失败', async () => {
    await preloadJsSandbox();
    const list = f(':(a)', 'ruleToc.chapterList');
    const scope = createScope(normalizeBody('<p>a</p>'), TOC_URL);
    const [item] = evaluateFieldList(list, scope);
    expect(codeOf(() => evaluateFieldList(list, item))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => evaluateField(f('$1', 'ruleToc.chapterName'), scope))).toBe('RULE_EVAL_FAILED');
  });

  it('回溯爆炸的正则被沙箱中断，按求值失败', async () => {
    await preloadJsSandbox();
    const list = f(':(a+)+$', 'ruleToc.chapterList');
    const scope = createScope(normalizeBody(`${'a'.repeat(40)}b`), TOC_URL);
    const started = Date.now();
    expect(codeOf(() => evaluateFieldList(list, scope))).toBe('RULE_EVAL_FAILED');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('engineFetchToc：shushun 形态（条目 URL 带 ## 替换）', async () => {
    const page = '<dl><dd><a href="/book/1/1.html" title="t">第1章 起</a></dd><dd><a href="/book/1/2.html">第2章 承</a></dd></dl>';
    const result = await engineFetchToc(source({ ruleToc: SHUSHUN_TOC }), TOC_URL, context(new Map([[TOC_URL, page]])));
    expect(result.chapters).toEqual([
      { url: `${SITE}/book/1/1.html`, title: '第1章 起' },
      { url: `${SITE}/book/1/2.html`, title: '第2章 承' },
    ]);
  });

  it('engineFetchToc：off 态行为不变（`:` 列表被当选择器编译，求值失败）', async () => {
    const page = '<dl><dd><a href="/book/1/1.html">第1章</a></dd></dl>';
    await expect(engineFetchToc(source({ ruleToc: SHUSHUN_TOC }, false), TOC_URL, context(new Map([[TOC_URL, page]]))))
      .rejects.toThrow('选择器无法求值');
  });

  it('engineFetchToc：kyxsw 两级级联（中间级拼接整段匹配），条目名 ## 去尾', async () => {
    const page = [
      '<dl>最新章节<dd><a href ="/9.html">第9章</a></dd></dl>',
      '<dl>正文卷<dd><a href ="/1.html">第1章（求月票）</a></dd><dd><a href ="/2.html">第2章</a></dd></dl>',
    ].join('');
    const rules = {
      ruleToc: {
        chapterUrl: '$1',
        chapterList: ':正文卷[\\s\\S]*?/dl&&href ="([^"]+)">([^<]+)',
        chapterName: '$2##[\\(（【].*?[求更谢乐发订合补加].*?[】）\\)]',
      },
    };
    const result = await engineFetchToc(source(rules), TOC_URL, context(new Map([[TOC_URL, page]])));
    expect(result.chapters).toEqual([{ url: `${SITE}/1.html`, title: '第1章' }, { url: `${SITE}/2.html`, title: '第2章' }]);
  });

  it('engineFetchToc：hen0 形态（nextTocUrl 正则-only 对页面原文 replaceFirst）', async () => {
    const page2 = `${SITE}/book/1/2/`;
    const pages = new Map([
      [TOC_URL, "<style>p_11::after{content:'第1章'}p_12::after{content:'第2章'}</style><a href=\"/book/1/2/\" class=\"onclick\">下一页</a>"],
      [page2, "<style>p_13::after{content:'第3章'}</style>"],
    ]);
    const rules = {
      ruleToc: {
        chapterUrl: '$1.html',
        nextTocUrl: '##<a href="([^"]+)" class="onclick">下一页##$1###',
        chapterList: ":p_(\\d+)::after\\{content:'([^']+)'\\}",
        chapterName: '$2',
      },
    };
    const seen: string[] = [];
    const result = await engineFetchToc(source(rules), TOC_URL, context(pages, seen));
    expect(seen).toEqual([TOC_URL, page2]);
    expect(result.chapters).toEqual([
      { url: `${SITE}/book/1/11.html`, title: '第1章' },
      { url: `${SITE}/book/1/12.html`, title: '第2章' },
      { url: `${SITE}/book/1/2/13.html`, title: '第3章' },
    ]);
  });

  it('engineFetchToc：ruoxia 形态（(?s)、未参与匹配的组记空）', async () => {
    const page = '<li><a href="/c/101" class="isvip name"\n>第1章</a></li><li><a href="/c/102" class="free name">第2章</a></li>';
    const rules = {
      ruleToc: {
        chapterUrl: `${SITE}/ajax/chapter/content/$1`,
        chapterList: ':(?s)(\\d+)" class="(isvip)?[^"]*name[^>]*>([^<]*)',
        chapterName: '$2$3',
      },
    };
    const result = await engineFetchToc(source(rules), TOC_URL, context(new Map([[TOC_URL, page]])));
    expect(result.chapters).toEqual([
      { url: `${SITE}/ajax/chapter/content/101`, title: 'isvip第1章' },
      { url: `${SITE}/ajax/chapter/content/102`, title: '第2章' },
    ]);
  });

  it('engineSearchBook：51tuz 形态（字面量拼多个组，http 升 https）', async () => {
    const site = SITE;
    const page = [
      '<p class="sone"><a href="http://book15.net/12_345/">甲书</a></p><p>作者_<b>张三</b></p>',
      '<p class="sone"><a href="http://book15.net/12_678/">乙书</a></p><p>作者_<b>李四</b></p>',
    ].join('');
    const seen: string[] = [];
    const anyPage = { page: async (url: string) => { seen.push(url); return { url, text: page }; } } as unknown as SourceRequestContext;
    const rules = {
      ruleSearch: {
        name: '$3', author: '$4', bookUrl: 'http://book15.net/$1_$2/',
        bookList: ':sone[^.]*[^\\/]*\\/(\\d+)_(\\d+)[^>]*>([^<]*)[^_]*[^>]*>([^<]*)',
      },
    };
    const results = await engineSearchBook(source(rules, true, site), '书', anyPage);
    expect(seen).toHaveLength(1);
    expect(results).toEqual([
      { title: '甲书', author: '张三', bookUrl: `${site}/12_345/` },
      { title: '乙书', author: '李四', bookUrl: `${site}/12_678/` },
    ]);
  });
});
