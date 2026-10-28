// pkgalias1029：ENGINE_SYNTAX_JSOUP 帧内的 jsoup 类别名 `var J = [Packages.]org.jsoup.Jsoup;`（只许 J.parse）与
// `var D = ….nodes.Document|Element;`（定义后不许再用）。规则与页面均为合成形态。
import { describe, expect, it } from 'vitest';
import { createScope, evaluateField, normalizeBody, type EvalScope } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule } from './parse';
import { RuleEngineError, type FieldIr } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const PAGE_URL = 'https://book15.net/p/1.html';
const CONTENT = 'ruleContent.content';
const on = (rule: string) => parseFieldRule(rule, { jsEnabled: true, jsoupEnabled: true, field: CONTENT });
const off = (rule: string) => parseFieldRule(rule, { jsEnabled: true, jsoupEnabled: false, field: CONTENT });
const scopeOf = (text: string): EvalScope => createScope(normalizeBody(text), PAGE_URL);
const value = (field: FieldIr, text: string) => evaluateField(field, scopeOf(text));
const PAGE = '<div id="c"><p data-i="2">乙</p><p data-i="1">甲</p></div>';
const HEAD = 'var J = Packages.org.jsoup.Jsoup;\nvar Document = Packages.org.jsoup.nodes.Document;\n'
  + 'var Element = org.jsoup.nodes.Element;\n';

describe('编译期', () => {
  it('off 拒、on 过：Jsoup 别名 + nodes 占位别名', () => {
    for (const body of [
      'var d = J.parse(src); d.select("p").text()',
      'var d = J . parse(String(result)); d.select("p").size()',
    ]) {
      const rule = `<js>${HEAD}${body}</js>`;
      expect(codeOf(() => off(rule))).toBe('unsupported_js');
      expect(on(rule).jsoup).toBe(true);
    }
    expect(on('@js:var Jsoup = org.jsoup.Jsoup; Jsoup.parse(result).text()').jsoup).toBe(true);
  });

  it('不收的形态照旧拒', () => {
    for (const code of [
      'var J = org.jsoup.Jsoup; J.connect("x")', // parse 以外的成员
      'var J = org.jsoup.Jsoup; var f = J; f.parse(result).text()', // 别名被传递
      'var J = org.jsoup.Jsoup; var J = org.jsoup.Jsoup; J.parse(result).text()', // 重定义
      'var J = org.jsoup.Jsoup\nJ.parse(result).text()', // 无分号
      'let J = org.jsoup.Jsoup; J.parse(result).text()', // 只认 var
      'var source = org.jsoup.Jsoup; source.parse(result).text()', // 遮住保留名
      'var D = org.jsoup.nodes.Document; new D("x")', // nodes 别名定义后再用
      'var D = org.jsoup.nodes.Document; D.parse(result)',
      'var T = org.jsoup.nodes.TextNode; org.jsoup.Jsoup.parse(result).text()', // 别的类
      'var J = org.jsoup.Jsoup; J.parse(result).text() + java.ajax("x")',
    ]) expect(codeOf(() => on(`@js:${code}`)), code).toBe('unsupported_js');
  });
});

describe('求值', () => {
  it('Jsoup 别名的 parse 建文档；nodes 占位别名不影响结果', async () => {
    await preloadJsSandbox();
    expect(value(on(`<js>${HEAD}var d = J.parse(src); d.select("p").text()</js>`), PAGE)).toBe('乙 甲');
    const sorted = `<js>${HEAD}var ps = J.parse(src).select("p"); var a = [];\n`
      + 'for (var i = 0; i < ps.size(); i++) a.push(ps.get(i));\n'
      + 'a.sort(function (x, y) { return parseInt(x.attr("data-i"), 10) - parseInt(y.attr("data-i"), 10); });\n'
      + 'var out = []; for (var k = 0; k < a.length; k++) out.push(String(a[k].text())); out.join("|")</js>';
    expect(value(on(sorted), PAGE)).toBe('甲|乙');
  });
});
