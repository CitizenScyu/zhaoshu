// nullskip1029：JS 链的 Default 模式规则段在 HTML 作用域上取空即整条链得空（ENGINE_SYNTAX_NULL_SKIP）。legado AnalyzeRule.getString
// 的 `result ?: continue`：AnalyzeByJSoup.getString 对空表返回 null，其后 JS/正则段都不跑，字段得 ""。规则与页面均为合成形态。
import { beforeAll, describe, expect, it } from 'vitest';
import { createJsonScope, createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { RuleEngineError, type FieldIr } from './types';

const BASE = { orEnabled: true, xpathEnabled: true, xpathEvalEnabled: true, regexEnabled: true, andEnabled: true, jsEnabled: true, jsExtEnabled: true } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...BASE, ...extra, field, nullSkipEnabled: true });
const off = (rule: string, field: string) => parseFieldRule(rule, { ...BASE, field, nullSkipEnabled: false });
const flags = (field: FieldIr) => (field.chain ?? []).map((s) => (s.kind === 'rule' ? s.nullSkip === true : null));
const PAGE_URL = 'https://h.example/book/1';
const scope = (html: string) => createScope(normalizeBody(html), PAGE_URL);
const errOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? 'engine' : `non-engine:${String(err)}`;
  }
};

const CH_URL = 'ruleToc.chapterUrl';
const CONTENT = 'ruleContent.content';
// 目录有一行不带链接（如分卷标题行），chapterUrl 的 JS 对空输入会抛错。
const TOC = '<table><tr><td><a href="/c/11.html">一</a></td></tr><tr><td>分卷</td></tr><tr><td><a data-rel="/c/12.html">二</a></td></tr></table>';
const URL_RULE = 'tag.a.0@href||tag.a.0@data-rel<js>var id = result.match(/(\\d+)\\.html/); "/r/" + id[1]</js>';

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('编译：哪些规则段挂 nullSkip', () => {
  it('on：Default 段（无前缀 / @CSS: / @@，可含 ||、&&、## 尾缀）挂；off 不挂', () => {
    expect(flags(on(URL_RULE, CH_URL))).toEqual([true, null]);
    expect(flags(on('@css:a@href<js>result</js>', CH_URL))).toEqual([true, null]);
    expect(flags(on('#a@text&&#b@text<js>result</js>', CONTENT))).toEqual([true, null]);
    expect(flags(on('#a@text##甲##乙<js>result</js>', CONTENT))).toEqual([true, null]);
    expect(flags(off(URL_RULE, CH_URL))).toEqual([false, null]);
  });

  it('JS 后的规则段同样挂', () => {
    expect(flags(on('<js>"<p></p>"</js>p@text<js>String(result.length)</js>', CONTENT))).toEqual([null, true, null]);
  });

  it('isUrl / getStringList / init 字段不挂', () => {
    for (const field of ['ruleSearch.bookUrl', 'ruleBookInfo.tocUrl', 'ruleSearch.kind', 'ruleBookInfo.kind', 'ruleContent.nextContentUrl']) {
      let ir: FieldIr | undefined;
      try { ir = on('a@href<js>result</js>', field); } catch { continue; } // 字段不收该 JS 形态时编译即拒，同样不挂
      expect(flags(ir)).not.toContain(true);
    }
  });

  it('Json / XPath 模式段、@all 末端不挂', () => {
    expect(flags(on('$.a<js>result</js>', CONTENT))).toEqual([false, null]);
    expect(flags(on('@json:$.a<js>result</js>', CONTENT))).toEqual([false, null]);
    expect(flags(on('//div[@id="a"]/text()<js>result</js>', CONTENT))).toEqual([false, null]);
    expect(flags(on('@xpath://div[@id="a"]/text()<js>result</js>', CONTENT))).toEqual([false, null]);
    expect(flags(on('#a@all<js>result</js>', CONTENT))).toEqual([false, null]);
  });
});

describe('求值', () => {
  const items = (html: string) => evaluateFieldList(on('tr', 'ruleToc.chapterList'), scope(html));

  it('目录行没有链接：on 得空、JS 不跑；有链接的行两态相同', () => {
    const rows = items(TOC);
    expect(rows).toHaveLength(3);
    const onIr = on(URL_RULE, CH_URL);
    const offIr = off(URL_RULE, CH_URL);
    expect(rows.map((row) => evaluateField(onIr, row))).toEqual(['/r/11', '', '/r/12']);
    expect(evaluateField(offIr, rows[0])).toBe('/r/11');
    expect(evaluateField(offIr, rows[2])).toBe('/r/12');
    expect(errOf(() => evaluateField(offIr, rows[1]))).toBe('engine'); // off：空串照旧喂给 JS，JS 抛错 = 求值失败
  });

  it('选中了元素但文本为空同样算 null（getResultLast 只收非空 text）', () => {
    const page = scope('<div id="e"></div><div id="f">丙</div>');
    expect(evaluateField(on('#e@text<js>"X" + result</js>', CONTENT), page, true)).toBe('');
    expect(evaluateField(off('#e@text<js>"X" + result</js>', CONTENT), page, true)).toBe('X');
    expect(evaluateField(on('#f@text<js>"X" + result</js>', CONTENT), page, true)).toBe('X丙');
  });

  it('JS 之后的规则段取空也中止', () => {
    const page = scope('<div>x</div>');
    const rule = '<js>"<p></p>"</js>p@text<js>String(result.length)</js>';
    expect(evaluateField(on(rule, CONTENT), page, true)).toBe('');
    expect(evaluateField(off(rule, CONTENT), page, true)).toBe('0');
  });

  it('|| 全空支才中止；任一支非空照常', () => {
    const page = scope('<a data-rel="/c/9.html">九</a>');
    expect(evaluateField(on(URL_RULE, CH_URL), page)).toBe('/r/9');
    expect(evaluateField(on('#x@text||#y@text<js>"X"</js>', CONTENT), page, true)).toBe('');
  });

  it('JSON 页上不中止（legado isJSON 时 Default 段走 JSONPath，取空得 ""）', () => {
    const ir = on('#x@text<js>"X" + result</js>', CONTENT);
    const json = createJsonScope({ a: 1 }, PAGE_URL);
    let out: string | undefined;
    try { out = evaluateField(ir, json, true); } catch { out = undefined; }
    expect(out).not.toBe(''); // 不论 CSS 段在 JSON 作用域上怎么求值，都不因 nullSkip 得空
  });
});
