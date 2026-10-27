// xpatheval1027：ENGINE_SYNTAX_XPATH_EVAL —— JsoupXpath 语义求值器（xpath-eval.ts）+ parse/compile/evaluate 接线 + 语义版本。
// 样例规则取自离线池里因 unsupported_xpath 被拒的真实源（or-sim reject-samples）。
import { describe, expect, it } from 'vitest';
import { parseFieldRule } from './parse';
import { RuleEngineError } from './types';
import { compileSource, engineSourceRevision, sourceUsesXPathEval } from './compile';
import { contentNeedsHtmlToText } from './content-html';
import { engineSemanticsVersion, engineSyntaxXPathEvalEnabled } from './syntax-flags';
import { compileXPath, XPathSyntaxError } from './xpath-eval';
import { createHtmlScope, createJsonScope, evaluateField, evaluateFieldList } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { sourceRevision } from '@/lib/source-revision';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const ON = { orEnabled: true, xpathEnabled: true, xpathEvalEnabled: true } as const;
const OFF = { orEnabled: true, xpathEnabled: true, xpathEvalEnabled: false } as const;
const f = (rule: string) => parseFieldRule(rule, ON);

const HTML = `<html><head><title>站名</title></head><body>
<div class="info"><h2><a href="/b/1">书<b>名</b></a></h2>
<p>作者：张三</p><p>类别：玄幻</p>
<a href="/read/1">全文阅读</a>
<span>最新</span><a href="/c/9">第九章</a>
</div>
<select><option value="/p/1" selected="selected">1</option><option value="/p/2">2</option><option value="/p/3">3</option></select>
<div id="list"><dl><dt>最新章节</dt><dd><a href="/c/9">九</a></dd><dt>正文</dt><dd><a href="/c/1">一</a></dd><dd><a href="/c/2">二</a></dd></dl></div>
<ul><li><span>x</span><a href="/u/1">u1</a></li><li><a href="/u/2">u2</a></li><li><em><a href="/u/3">u3</a></em></li></ul>
<table><tr><td id="text"><p>段一</p><p>段二</p><p>广告1</p><p>广告2</p></td></tr></table>
<font><a href="/next">下一页<font>点击阅读</font></a></font>
</body></html>`;
const scope = () => createHtmlScope(HTML, 'https://h.example/book/1');

describe('compileXPath 语法面', () => {
  it.each([
    "//p[contains(text(),'作者：')]/text()",
    "//a[text()='全文阅读']/@href",
    '//h2/a//text()',
    "//td[@id='text']/p[position() < last()-1]",
    '//div[@class="tb_con"][position()>1]//tr',
    '//span/following-sibling::a/@href',
    '//select/option[not(@selected)]/@value',
    '//*[@id="list"]//dt[2]/following-sibling::dd',
    '//li[span]/a',
    '//a[last()-2]//text()',
    '//ul/li[.//a]',
    '//font[contains(text(), "点击阅读")]/../@href',
    '//title/text() | //h2/a/text()',
    "//div[@id='c']/allText()",
  ])('可编译：%s', (expr) => {
    expect(() => compileXPath(expr)).not.toThrow();
  });

  it.each([
    '//option/@value@*',
    '//a/@href@href',
    '//div[3]@html',
    '//a/@*',
    '//div/node()',
    '//div/comment()',
    '//xhtml:div',
    '//a/@href/text()',
    '//div[foo()]',
    '//div/namespace::x',
    '//div[contains(@a)]',
    '(//a)/@href',
    '',
  ])('拒绝：%s', (expr) => {
    expect(() => compileXPath(expr)).toThrow(XPathSyntaxError);
  });

  it('plainText：text()/allText()/@attr 末步为纯文本，元素结果不是', () => {
    expect(compileXPath('//p/text()').plainText).toBe(true);
    expect(compileXPath('//p/@title').plainText).toBe(true);
    expect(compileXPath('//td/p[position()>1]').plainText).toBe(false);
  });
});

describe('开关与语义版本', () => {
  it('engineSyntaxXPathEvalEnabled 严格口径', () => {
    expect(engineSyntaxXPathEvalEnabled({})).toBe(false);
    expect(engineSyntaxXPathEvalEnabled({ ENGINE_SYNTAX_XPATH_EVAL: '0' })).toBe(false);
    expect(engineSyntaxXPathEvalEnabled({ ENGINE_SYNTAX_XPATH_EVAL: 'yes' })).toBe(false);
    expect(engineSyntaxXPathEvalEnabled({ ENGINE_SYNTAX_XPATH_EVAL: ' On ' })).toBe(true);
    expect(engineSyntaxXPathEvalEnabled({ ENGINE_SYNTAX_XPATH_EVAL: 'TRUE' })).toBe(true);
  });

  it('求值位 +16，1–16 逐字不变', () => {
    expect(engineSemanticsVersion(false, true, false, false, false)).toBe(3);
    expect(engineSemanticsVersion(false, true, false, false, true)).toBe(19);
    expect(engineSemanticsVersion(true, true, true, true, true)).toBe(32);
  });

  const subset = { url: 'https://a.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: "//div[@class='item']", name: 'tag.a@text' } } };
  const evalSrc = { url: 'https://b.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: '//li[span]', name: 'tag.a@text' } } };
  const stillBad = { url: 'https://c.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: '//option/@value@*', name: 'tag.a@text' } } };

  it('按源判定：只有实际编译出 XPath 求值 IR 的源换版本', () => {
    const opts = { orEnabled: false, varsEnabled: false, jsEnabled: false };
    expect(sourceUsesXPathEval(subset.rules, opts)).toBe(false);
    expect(sourceUsesXPathEval(evalSrc.rules, opts)).toBe(true);
    expect(sourceUsesXPathEval(stillBad.rules, opts)).toBe(false);
    expect(engineSourceRevision(evalSrc, { orEnabled: false, xpathEnabled: true, xpathEvalEnabled: false })).toBe(`3:${sourceRevision(evalSrc)}`);
    expect(engineSourceRevision(evalSrc, { orEnabled: false, xpathEnabled: true, xpathEvalEnabled: true })).toBe(`19:${sourceRevision(evalSrc)}`);
    // 求值开关须 ENGINE_SYNTAX_XPATH 同开
    expect(engineSourceRevision(evalSrc, { orEnabled: false, xpathEnabled: false, xpathEvalEnabled: true })).toBe(`1:${sourceRevision(evalSrc)}`);
    expect(engineSourceRevision(subset, { orEnabled: false, xpathEnabled: true, xpathEvalEnabled: true })).toBe(`3:${sourceRevision(subset)}`);
    expect(engineSourceRevision(stillBad, { orEnabled: false, xpathEnabled: true, xpathEvalEnabled: true })).toBe(`3:${sourceRevision(stillBad)}`);
  });

  it('compileSource：off 照旧 skipped，on 编译成 xpath IR，两态缓存互不污染', () => {
    const off = compileSource(evalSrc, { orEnabled: false, xpathEnabled: true, xpathEvalEnabled: false });
    const on = compileSource(evalSrc, { orEnabled: false, xpathEnabled: true, xpathEvalEnabled: true });
    expect(off.get('ruleSearch.bookList')).toEqual({ skipped: 'unsupported' });
    expect((on.get('ruleSearch.bookList') as { rules: { kind: string }[] }).rules[0].kind).toBe('xpath');
  });
});

describe('parseFieldRule 接线', () => {
  it('eval off：子集外照旧 unsupported_xpath（与改动前逐字一致）', () => {
    for (const rule of ['//li[span]/a', "//a[text()='全文阅读']/@href", '//span/following-sibling::a/@href', '//h2/a//text()']) {
      expect(codeOf(() => parseFieldRule(rule, OFF))).toBe('unsupported_xpath');
      expect(codeOf(() => parseFieldRule(rule, { orEnabled: true, xpathEnabled: false, xpathEvalEnabled: true }))).toBe('unsupported_xpath');
    }
  });

  it('eval on：子集内仍翻 CSS；子集外编译成 xpath IR；JsoupXpath 不认的仍拒', () => {
    expect(f("//div[@class='x']/a/@href").rules[0].kind).toBe('css');
    expect(f('//li[span]/a').rules[0]).toMatchObject({ kind: 'xpath', source: '//li[span]/a', forced: false });
    expect(f('@XPath://li[span]/a').rules[0]).toMatchObject({ kind: 'xpath', forced: true });
    expect(f('class.a@text||//li[span]/a/text()').rules[0].kind).toBe('or');
    for (const rule of ['//option/@value@*', '//a/@href@href', '//div[3]@html', '//div/node()']) {
      expect(codeOf(() => f(rule))).toBe('unsupported_xpath');
    }
  });

  it('## 尾缀照常挂字段层', () => {
    const field = f("//p[contains(text(),'作者')]/text()##作者：");
    expect(field.regex).toEqual([{ pattern: '作者：', replacement: '', flags: undefined }]);
    expect(evaluateField(field, scope())).toBe('张三');
  });
});

describe('求值（JsoupXpath 语义）', () => {
  it('函数谓词、轴、父步、属性绝对化', () => {
    expect(evaluateField(f("//p[contains(text(),'作者：')]/text()"), scope())).toBe('作者：张三');
    expect(evaluateField(f("//a[text()='全文阅读']/@href"), scope())).toBe('https://h.example/read/1');
    expect(evaluateField(f('//span/following-sibling::a/@href'), scope())).toBe('https://h.example/c/9');
    expect(evaluateField(f('//font[contains(text(), "点击阅读")]/../@href'), scope())).toBe('https://h.example/next');
    expect(evaluateField(f('//li[span]/a'), scope())).toBe('u1');
    expect(evaluateField(f('@XPath://li[a]/a/text()'), scope())).toBe('u1');
  });

  it('非 URL 属性不绝对化；multi 逐行拼接', () => {
    expect(evaluateField(f('//select/option[not(@selected)]/@value'), scope())).toBe('/p/2');
    expect(evaluateField(f('//select/option[not(@selected)]/@value'), scope(), true)).toBe('/p/2\n/p/3');
    // JsoupXpath 口径：@attr 取值为空串即假——裸布尔属性 `selected` 在谓词里不算存在（legado 同样踩）
    const bare = createHtmlScope('<select><option value="1" selected>1</option><option value="2">2</option></select>', 'https://h.example/');
    expect(evaluateField(f('//option[not(@selected)]/@value'), bare, true)).toBe('1\n2');
  });

  it('//text() 递归文本：单值取首个非空，multi 全部', () => {
    expect(evaluateField(f('//h2/a//text()'), scope())).toBe('书');
    expect(evaluateField(f('//h2/a//text()'), scope(), true)).toBe('书\n名');
  });

  it('position()/last() 谓词：正文去尾两段（content 口径 outerHtml，需 HTML→文本）', () => {
    const field = f("//td[@id='text']/p[position() < last()-1]");
    expect(evaluateField(field, scope(), true)).toBe('<p>段一</p>\n<p>段二</p>');
    expect(evaluateField(field, scope())).toBe('段一');
    expect(contentNeedsHtmlToText(field)).toBe(true);
    expect(contentNeedsHtmlToText(f("//td[@id='text']/p[position()>2]/text()"))).toBe(false);
  });

  it('列表：following-sibling 轴、子元素谓词、position 过滤；条目内相对 XPath', () => {
    const toc = evaluateFieldList(f('//*[@id="list"]//dt[2]/following-sibling::dd'), scope());
    expect(toc.map((s) => evaluateField(f('a/text()'), s))).toEqual(['一', '二']);
    expect(toc.map((s) => evaluateField(f('@XPath:./a/@href'), s))).toEqual(['https://h.example/c/1', 'https://h.example/c/2']);
    expect(evaluateFieldList(f('//ul/li[.//a]'), scope())).toHaveLength(3);
    const tail = evaluateFieldList(f('//ul/li[position()>1]'), scope());
    expect(tail.map((s) => evaluateField(f('.//a/text()'), s))).toEqual(['u2', 'u3']);
  });

  it('并集按文档序取首个非空', () => {
    expect(evaluateField(f('//title/text() | //h2/a/text()'), scope())).toBe('站名');
  });

  it('JSON 输入：`/` 开头段走 Json 模式；@XPath: 前缀强制 XPath → 失败', () => {
    const json = createJsonScope({ id: 7 }, 'https://h.example/');
    const lenient = f('/b/{$.id}.html');
    expect(lenient.rules[0]).toMatchObject({ kind: 'xpath', program: null });
    expect(evaluateField(lenient, json)).toBe('/b/7.html');
    expect(codeOf(() => evaluateField(f('@XPath://li[span]/a'), json))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => evaluateField(lenient, scope()))).toBe('RULE_EVAL_FAILED');
  });

  it('访问预算：二次方爆炸的谓词按求值失败处理，不卡死', () => {
    const big = createHtmlScope(`<html><body>${'<div>x</div>'.repeat(3000)}</body></html>`, 'https://h.example/');
    expect(codeOf(() => evaluateField(f('//div[count(//div)>0]/text()'), big))).toBe('RULE_EVAL_FAILED');
  });

  it('JS 链里的 XPath 段同样按开关编译', async () => {
    await preloadJsSandbox();
    const rule = "//p[contains(text(),'类别')]/text()<js>result.replace('类别：','')</js>";
    const field = parseFieldRule(rule, { ...ON, jsEnabled: true, field: 'ruleBookInfo.name' });
    expect(evaluateField(field, scope())).toBe('玄幻');
    expect(codeOf(() => parseFieldRule(rule, { ...OFF, jsEnabled: true, field: 'ruleBookInfo.name' }))).toBe('unsupported_xpath');
  });
});
