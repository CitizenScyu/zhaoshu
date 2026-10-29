// doctype1029：ENGINE_SYNTAX_JSOUP_DOCTYPE —— jsoup 层按 jsoup 文档模式放行带 public/system id 的 doctype；parse5 判 quirks 时
// 「table 落在 p 内」整篇 fatal；doctype 按 DocumentType.outerHtmlHead 序列化。规则与页面均为合成形态。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineSourceRevision } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule } from './parse';
import { ENGINE_SEMANTICS_JSOUP_DOCTYPE_BIT, engineSemanticsVersion, engineSyntaxJsoupDoctypeEnabled } from './syntax-flags';
import { RuleEngineError } from './types';

const SITE = 'https://dt29.test';
const ON = { jsEnabled: true, jsoupEnabled: true, listJsEnabled: true } as const;
const XHTML_T = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';
const HTML4_T = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">'; // 无 system id → parse5 quirks
const BODY = '<div class="zw"><a href="/b/1">我的书一</a></div><div class="zw"><a href="/b/2">别的书</a></div>'
  + '<div class="zw"><a href="/b/3">我的书二</a></div>';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};
const value = (rule: string, page: string) =>
  evaluateField(parseFieldRule(rule, { ...ON, field: 'ruleContent.content' }), createScope(normalizeBody(page), `${SITE}/p`));
const list = (rule: string, page: string) =>
  evaluateFieldList(parseFieldRule(rule, { ...ON, field: 'ruleSearch.bookList' }), createScope(normalizeBody(page), `${SITE}/s`));
// wenxue 形态：首段规则交 Elements，JS 按关键字正则筛 toArray（Element 转串 = outerHtml），拼回 HTML 串再取 a。
const FILTER = 'class.zw\n<js>\nlist = result.toArray();\nre = new RegExp("我的");\nhtml = "";\nfor(i in list){\n\tre.test(list[i])?html+=list[i]:""\n\t}\nresult = String(html)\n</js>\na';

beforeAll(async () => {
  await preloadJsSandbox();
});
afterEach(() => vi.unstubAllEnvs());

describe('开关与语义位', () => {
  it('engineSyntaxJsoupDoctypeEnabled 严格口径', () => {
    expect(engineSyntaxJsoupDoctypeEnabled({})).toBe(false);
    expect(engineSyntaxJsoupDoctypeEnabled({ ENGINE_SYNTAX_JSOUP_DOCTYPE: '0' })).toBe(false);
    expect(engineSyntaxJsoupDoctypeEnabled({ ENGINE_SYNTAX_JSOUP_DOCTYPE: 'yes' })).toBe(false);
    expect(engineSyntaxJsoupDoctypeEnabled({ ENGINE_SYNTAX_JSOUP_DOCTYPE: ' On ' })).toBe(true);
    expect(engineSyntaxJsoupDoctypeEnabled({ ENGINE_SYNTAX_JSOUP_DOCTYPE: 'true' })).toBe(true);
  });

  it('语义位 2^41，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_JSOUP_DOCTYPE_BIT).toBe(2199023255552);
    const call = (...args: boolean[]) => (engineSemanticsVersion as (...a: boolean[]) => number)(...args);
    const all = Array.from({ length: 40 }, () => true) as boolean[];
    expect(call(...all, true) - call(...all, false)).toBe(2199023255552);
    expect(call(...all, false)).toBe(call(...all));
  });

  it('revision：jsoup 位已计入的源才计位；开关关不计', () => {
    const mk = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
    const soup = mk({ ruleSearch: { bookList: '.item', name: '@js:result.selectFirst("a").text()', bookUrl: 'a@href' } });
    const plain = mk({ ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' } });
    const v = (s: ReturnType<typeof mk>, jsoupDoctypeEnabled: boolean, jsoupEnabled = true) => Number(engineSourceRevision(s, {
      jsEnabled: true, listJsEnabled: true, jsoupEnabled, jsoupDoctypeEnabled,
    }).split(':')[0]);
    expect(v(soup, true) - v(soup, false)).toBe(2199023255552);
    expect(v(plain, true)).toBe(v(plain, false));
    expect(v(soup, true, false)).toBe(v(soup, false, false));
  });

  it('revision：袋字段经 jsoup 重编（jsoup 位不计）也计位', () => {
    // wenxue 形态：searchUrl put 关键字，bookList 首段取节点、JS 读袋筛条目——只在搜索袋编译里走 jsoup 帧。
    const src = {
      url: SITE,
      searchUrl: `${SITE}#{{java.put("key",key)}}`,
      rules: { ruleSearch: { bookList: FILTER.replace('new RegExp("我的")', 'new RegExp(java.get("key"))'), name: 'text', bookUrl: 'href' } },
    };
    const v = (jsoupDoctypeEnabled: boolean) => Number(engineSourceRevision(src, {
      jsEnabled: true, listJsEnabled: true, jsoupEnabled: true, varsEnabled: true, searchJsEnabled: true, searchVarsEnabled: true,
      jsoupDoctypeEnabled,
    }).split(':')[0]);
    expect(v(true) - v(false)).toBe(2199023255552);
  });
});

describe('带 id 的 doctype', () => {
  it('off 整篇 fatal（旧口径）；on 放行（XHTML transitional = limited-quirks）', () => {
    const page = `${XHTML_T}<html><head><title>t</title></head><body>${BODY}</body></html>`;
    vi.stubEnv('ENGINE_SYNTAX_JSOUP_DOCTYPE', '0');
    expect(codeOf(() => value('@js:java.getElements("a").text()', page))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => list(FILTER, page))).toBe('RULE_EVAL_FAILED');
    vi.stubEnv('ENGINE_SYNTAX_JSOUP_DOCTYPE', '1');
    expect(value('@js:java.getElements("a").text()', page)).toBe('我的书一 别的书 我的书二');
    expect(list(FILTER, page)).toHaveLength(2);
    const items = list(FILTER, page);
    expect(items.map((it) => evaluateField(parseFieldRule('text', { ...ON, field: 'ruleSearch.name' }), it))).toEqual(['我的书一', '我的书二']);
  });

  it('parse5 quirks：table 不在 p 内照常；p 内的 table（含无 doctype）整篇 fatal', () => {
    vi.stubEnv('ENGINE_SYNTAX_JSOUP_DOCTYPE', '1');
    const ok = `${HTML4_T}<p>甲</p><table><tr><td><p>乙</p></td></tr></table>`;
    expect(value('@js:java.getElements("p").text()', ok)).toBe('甲 乙');
    for (const page of [`${HTML4_T}<p>甲<table><tr><td>乙</td></tr></table>`, '<p>甲<span><table><tr><td>乙</td></tr></table></span>']) {
      expect(codeOf(() => value('@js:java.getElements("p").text()', page))).toBe('RULE_EVAL_FAILED');
    }
    // button 是 scope 边界：p 不在 button scope 内，两边都不关 p。
    expect(value('@js:java.getElements("td").text()', '<p><button><table><tr><td>丙</td></tr></table></button></p>')).toBe('丙');
    // no-quirks / limited-quirks 下 parse5 与 jsoup 同样先关 p。
    expect(value('@js:java.getElements("p").size()', `${XHTML_T}<p>甲<table><tr><td>乙</td></tr></table>`)).toBe('1');
    vi.stubEnv('ENGINE_SYNTAX_JSOUP_DOCTYPE', '0');
    expect(value('@js:java.getElements("p").text()', '<p>甲<table><tr><td>乙</td></tr></table>')).toBe('甲 乙');
  });
});

describe('doctype 序列化（DocumentType.outerHtmlHead）', () => {
  const head = (doc: string) => value(`@js:org.jsoup.Jsoup.parse(${JSON.stringify(`${doc}<p>x</p>`)}).outerHtml()`, '<p>页</p>').split('\n')[0];

  it('有 id 大写 DOCTYPE + 关键字 + 引号 id；无 id 小写', () => {
    vi.stubEnv('ENGINE_SYNTAX_JSOUP_DOCTYPE', '1');
    expect(head(XHTML_T)).toBe(XHTML_T);
    expect(head('<!DOCTYPE HTML>')).toBe('<!doctype html>');
    expect(head('<!doctype html system "about:legacy-compat">')).toBe('<!DOCTYPE html SYSTEM "about:legacy-compat">');
    expect(head('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">'))
      .toBe('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">');
    // 关键字在、id 为空：jsoup 照出关键字（pubSysKey 取分词器读到的值）。
    expect(head('<!DOCTYPE html PUBLIC "">')).toBe('<!doctype html PUBLIC>');
  });

  it('quirks 文档的 doctype 不猜；off 照旧 fatal', () => {
    vi.stubEnv('ENGINE_SYNTAX_JSOUP_DOCTYPE', '1');
    expect(codeOf(() => head(HTML4_T))).toBe('RULE_EVAL_FAILED');
    vi.stubEnv('ENGINE_SYNTAX_JSOUP_DOCTYPE', '0');
    expect(codeOf(() => head('<!DOCTYPE html>'))).toBe('RULE_EVAL_FAILED');
  });
});
