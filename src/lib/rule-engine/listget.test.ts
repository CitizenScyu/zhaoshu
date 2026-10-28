// listget1028：ENGINE_SYNTAX_LIST_GET —— 列表字段（bookList / chapterList）的 JS 链放行 legado `java.getString`/`java.getStringList`
// （getElements 时 java 即 AnalyzeRule、content 是整页，所以在页面作用域上取值）；语义版本位、按源判定、编译与门面求值。
// 规则均为合成形态。
import { beforeAll, describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesListGetSyntax } from './compile';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_LIST_GET_BIT, engineSemanticsVersion, engineSyntaxListGetEnabled } from './syntax-flags';
import { RuleEngineError } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const TOC_URL = `${SITE}/book/1/`;
const ON = { jsEnabled: true, listJsEnabled: true, jsGetEnabled: true, listGetEnabled: true } as const;
const OFF = { ...ON, listGetEnabled: false } as const;
const TOC = 'ruleToc.chapterList';
const list = (rule: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field: TOC });
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });

// girl-love 形态：从页面上取首章链接与总章数，JS 拼出 {text, href} 对象条目
const PAGE = '<ul class="chapterList"><li><a href="/c/5.html">x</a></li><li><a href="/c/6.html">y</a></li></ul><p class="n">共3章节</p>';
const GEN = "start=java.getString('@@class.chapterList@tag.li.0@a@href').match(/(\\d+)\\.html/)[1];"
  + 'page=result.match(/共(\\d+)章节/)[1];list=[];'
  + "for(i=0;i<page;i++){list.push({text:'第'+(i+1),href:'/c/'+(Number(start)+i)+'.html'})}list";
const tocRules = (chapterList: string) => ({ ruleToc: { chapterList, chapterName: 'text', chapterUrl: 'href' } });

function source(rules: Record<string, unknown>, options: ParseOptions = ON): EngineSource {
  const r = raw(rules);
  return { url: SITE, name: '列表 getter 源', searchUrl: r.searchUrl, compiled: compileSource(r, options) };
}

const anyPage = (text: string) => ({ page: async (url: string) => ({ url, text }) } as unknown as SourceRequestContext);

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('开关与语义版本', () => {
  it('engineSyntaxListGetEnabled 严格口径', () => {
    expect(engineSyntaxListGetEnabled({})).toBe(false);
    expect(engineSyntaxListGetEnabled({ ENGINE_SYNTAX_LIST_GET: '0' })).toBe(false);
    expect(engineSyntaxListGetEnabled({ ENGINE_SYNTAX_LIST_GET: 'yes' })).toBe(false);
    expect(engineSyntaxListGetEnabled({ ENGINE_SYNTAX_LIST_GET: ' On ' })).toBe(true);
    expect(engineSyntaxListGetEnabled({ ENGINE_SYNTAX_LIST_GET: 'TRUE' })).toBe(true);
    expect(engineSyntaxListGetEnabled({ ENGINE_SYNTAX_LIST_GET: '1' })).toBe(true);
  });

  it('列表 getter 位 +67108864，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_LIST_GET_BIT).toBe(67108864);
    const t = true;
    const f = false;
    const base = engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, f)).toBe(base);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t)).toBe(base + 67108864);
    expect(engineSemanticsVersion(f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, t))
      .toBe(engineSemanticsVersion(false) + 67108864);
  });

  it('按源判定：只有列表 JS 里 off 拒、on 过的源换版本', () => {
    const opts = (listGetEnabled: boolean, jsGetEnabled = true, listJsEnabled = true) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled: true, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled, jsExtEnabled: false, jsBindEnabled: false,
      jsGetEnabled, listGetEnabled,
    });
    const tocGet = raw(tocRules(`@js:${GEN}`));
    const searchGet = raw({ ruleSearch: { bookList: '@js:java.getStringList("li@text").toArray().map(function(t){return {n:String(t)}})', name: 'n' } });
    const plainList = raw(tocRules('@js:[{text:"一",href:"/c/1"}]'));
    const dynamic = raw(tocRules('@js:var r="li@text";java.getString(r);[]'));
    const fieldGet = raw({ ruleBookInfo: { name: '@js:java.getString("#t@text")' } }); // 字段 getter 归 jsget 位
    const withLib = raw({ ...tocGet.rules, jsLib: 'function f(){}' });
    for (const s of [plainList, dynamic, fieldGet, withLib]) {
      expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    }
    for (const s of [tocGet, searchGet]) {
      expect(engineSourceRevision(s, opts(true))).not.toBe(engineSourceRevision(s, opts(false)));
      // 依赖开关任一关：本位不生效
      expect(engineSourceRevision(s, opts(true, false))).toBe(engineSourceRevision(s, opts(false, false)));
      expect(engineSourceRevision(s, opts(true, true, false))).toBe(engineSourceRevision(s, opts(false, true, false)));
    }
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, jsExtEnabled: false, jsBindEnabled: false,
    };
    expect(sourceUsesListGetSyntax(tocGet.rules, flags)).toBe(true);
    expect(sourceUsesListGetSyntax(searchGet.rules, flags)).toBe(true);
    for (const s of [plainList, dynamic, fieldGet, withLib]) expect(sourceUsesListGetSyntax(s.rules, flags)).toBe(false);
  });

  it('compileSource：off 态照旧 skipped，on 态编译并挂 jsGets；两态缓存互不污染', () => {
    const compiled = (options: ParseOptions) => compileSource(raw(tocRules(`@js:${GEN}`)), options).get(TOC);
    expect(compiled(OFF)).toEqual({ skipped: 'unsupported' });
    const on = compiled(ON);
    expect(on).not.toHaveProperty('skipped');
    expect([...((on as { jsGets?: Map<string, unknown> }).jsGets?.keys() ?? [])]).toEqual(['@@class.chapterList@tag.li.0@a@href']);
    expect(compiled({ ...ON, jsGetEnabled: false })).toEqual({ skipped: 'unsupported' });
    expect(compiled(OFF)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse', () => {
  it('off：列表 JS 里的 getter 照旧拒；任一依赖开关关也拒', () => {
    expect(codeOf(() => list(`@js:${GEN}`, { listGetEnabled: false }))).toBe('unsupported_js');
    expect(codeOf(() => list(`@js:${GEN}`, { jsGetEnabled: false }))).toBe('unsupported_js');
    expect(codeOf(() => list(`@js:${GEN}`))).toBeUndefined();
  });

  it('只收字面量实参：动态实参、多参照旧拒；不用 getter 的列表 JS 不挂键', () => {
    expect(codeOf(() => list('@js:var r="li@text";java.getString(r)'))).toBe('unsupported_js');
    expect(codeOf(() => list('@js:java.getString("li@text", true)'))).toBe('unsupported_js');
    expect(list('@js:[{text:"一",href:"/c/1"}]').jsGets).toBeUndefined();
    expect([...(list('<js>java.getStringList("p@text").toArray()</js><js>result</js>').jsGets?.keys() ?? [])]).toEqual(['p@text']);
    // 首段是规则的列表链照旧拒（listjs1027 口径，与 getter 无关）
    expect(codeOf(() => list('li@text@js:java.getStringList("p@text").toArray()'))).toBe('unsupported_js');
  });
});

describe('求值', () => {
  it('engineFetchToc：girl-love 形态在页面上取 getString，产出对象条目', async () => {
    const toc = await engineFetchToc(source(tocRules(`@js:${GEN}`)), TOC_URL, anyPage(PAGE));
    expect(toc.chapters).toEqual([
      { url: `${SITE}/c/5.html`, title: '第1' },
      { url: `${SITE}/c/6.html`, title: '第2' },
      { url: `${SITE}/c/7.html`, title: '第3' },
    ]);
  });

  it('engineFetchToc：off 态列表 skipped，无章节', async () => {
    const toc = await engineFetchToc(source(tocRules(`@js:${GEN}`), OFF), TOC_URL, anyPage(PAGE)).catch(() => undefined);
    expect(toc?.chapters ?? []).toEqual([]);
  });

  it('getStringList：多值在页面上取；多段 JS 共用白名单，后段的取值作用域仍是页面', async () => {
    const rule = '<js>java.getString("class.n@text")</js><js>var hs=java.getStringList("class.chapterList@tag.a@href");var out=[];'
      + 'for(var i=0;i<hs.size();i++){out.push({text:result+"-"+i,href:String(hs.get(i))})}out</js>';
    const toc = await engineFetchToc(source(tocRules(rule)), TOC_URL, anyPage(PAGE));
    expect(toc.chapters).toEqual([
      { url: `${SITE}/c/5.html`, title: '共3章节-0' },
      { url: `${SITE}/c/6.html`, title: '共3章节-1' },
    ]);
  });

  it('engineSearchBook：搜索 bookList 同样可用', async () => {
    const rules = {
      ruleSearch: {
        bookList: '@js:var ns=java.getStringList("li@text");var out=[];for(var i=0;i<ns.size();i++){out.push({n:String(ns.get(i)),u:"/b/"+i})}out',
        name: 'n', bookUrl: 'u',
      },
    };
    expect(await engineSearchBook(source(rules), '书', anyPage('<ul><li>甲</li><li>乙</li></ul>'))).toEqual([
      { title: '甲', author: '', bookUrl: `${SITE}/b/0` },
      { title: '乙', author: '', bookUrl: `${SITE}/b/1` },
    ]);
  });

  it('getString 多值按行拼接、含 & 时解码（与字段 getter 同口径）', async () => {
    const rule = '@js:var t=java.getString("li@text");[{text:t,href:"/c/1"}]';
    const toc = await engineFetchToc(source(tocRules(rule)), TOC_URL, anyPage('<ul><li>甲&amp;</li><li>乙</li></ul>'));
    expect(toc.chapters).toEqual([{ url: `${SITE}/c/1`, title: '甲&\n乙' }]);
  });
});
