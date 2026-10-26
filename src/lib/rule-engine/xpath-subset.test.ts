// xpath1027：ENGINE_SYNTAX_XPATH 简单子集翻译（xpath-subset.ts）+ parse/compile 接线 + 语义版本。
import { describe, expect, it } from 'vitest';
import { parseFieldRule } from './parse';
import { RuleEngineError } from './types';
import { engineSourceRevision, compileSource, sourceUsesXPathSyntax } from './compile';
import { engineSemanticsVersion, engineSyntaxXPathEnabled } from './syntax-flags';
import { ruleMayUseXPath, xpathSegmentBody, xpathToCss } from './xpath-subset';
import { createHtmlScope, evaluateField, evaluateFieldList } from './evaluate';
import { sourceRevision } from '@/lib/source-revision';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code : `non-engine:${String(err)}`;
  }
};

describe('xpathToCss 子集翻译', () => {
  it.each([
    ["//meta[@property='og:title']/@content", { selector: 'meta[property="og:title"]', terminal: 'content' }],
    ["//div[@class='info']/h1/text()", { selector: 'div[class="info"] > h1', terminal: 'textNodes' }],
    ['//*[@id="list"]//a', { selector: '*[id="list"] a' }],
    ["//div[contains(@class,'item')]/a/@href", { selector: 'div[class*="item"] > a', terminal: 'href' }],
    ['//ul[2]/li[1]/a', { selector: 'ul:nth-of-type(2) > li:nth-of-type(1) > a' }],
    ['//*[3]', { selector: '*:nth-child(3)' }],
    ['//li[last()]', { selector: 'li:last-of-type' }],
    ['//div[2][@class="x"]', { selector: 'div:nth-of-type(2)[class="x"]' }],
    ['//a[@title]', { selector: 'a[title]' }],
    ['/html/body/div', { selector: 'html > body > div' }],
    ['/body/div', { selector: '> body > div' }],
    ['./a/@href', { selector: '> a', terminal: 'href' }],
    ['.//span', { selector: 'span' }],
    ['/text()', { selector: '', terminal: 'textNodes' }],
    ['div/a', { selector: '> div > a' }],
    [`//a[@title='say "hi"']`, { selector: 'a[title="say \\"hi\\""]' }],
  ])('%s', (expr, expected) => {
    expect(xpathToCss(expr)).toEqual(expected);
  });

  it.each([
    "//div[@class='x'][2]", // 属性谓词之后的位次 = 过滤后位次，CSS 表达不了
    '//li[1][2]',
    '//li[0]',
    '//div//text()',
    '//a//@href',
    "//div[@id='a']/following-sibling::div",
    "//div[starts-with(@id,'a')]",
    "//div[contains(@class,'')]",
    "//a[text()='下一页']",
    '//div | //span',
    '//xhtml:div',
    '//div[@a=\'x\' and @b=\'y\']',
    '//div[@a][[1]]',
    '/',
    '',
  ])('子集外 → null：%s', (expr) => {
    expect(xpathToCss(expr)).toBeNull();
  });
});

describe('XPath 段判别与语义版本口径', () => {
  it('xpathSegmentBody：@XPath: 前缀（大小写不敏感）、/ 开头、旧判别命中', () => {
    expect(xpathSegmentBody('@XPath://ul/li')).toBe('//ul/li');
    expect(xpathSegmentBody('@xpath: //ul/li')).toBe('//ul/li');
    expect(xpathSegmentBody('/html/body')).toBe('/html/body');
    expect(xpathSegmentBody("div[@id='x']")).toBe("div[@id='x']");
    expect(xpathSegmentBody('class.list@li@text')).toBeNull();
    expect(xpathSegmentBody('https://example.com/x')).toBeNull();
  });

  it('ruleMayUseXPath 覆盖开头/|| 后的 /、@XPath:、旧判别；普通默认语法不命中', () => {
    expect(ruleMayUseXPath('//div/a')).toBe(true);
    expect(ruleMayUseXPath('  /html/body')).toBe(true);
    expect(ruleMayUseXPath('class.a@text|| /x/y')).toBe(true);
    expect(ruleMayUseXPath('@XPath:div/a')).toBe(true);
    expect(ruleMayUseXPath("div[@id='x']##abc")).toBe(true);
    expect(ruleMayUseXPath('class.list@li@a@href')).toBe(false);
    expect(ruleMayUseXPath('https://example.com/a/b')).toBe(false);
    expect(ruleMayUseXPath('$.data.list[*]')).toBe(false);
  });

  it('engineSemanticsVersion：1 基线 / 2 仅 || / 3 仅 XPath / 4 两者', () => {
    expect(engineSemanticsVersion(false)).toBe(1);
    expect(engineSemanticsVersion(true)).toBe(2);
    expect(engineSemanticsVersion(false, true)).toBe(3);
    expect(engineSemanticsVersion(true, true)).toBe(4);
  });

  it('engineSyntaxXPathEnabled 严格口径', () => {
    expect(engineSyntaxXPathEnabled({})).toBe(false);
    expect(engineSyntaxXPathEnabled({ ENGINE_SYNTAX_XPATH: '0' })).toBe(false);
    expect(engineSyntaxXPathEnabled({ ENGINE_SYNTAX_XPATH: 'yes' })).toBe(false);
    expect(engineSyntaxXPathEnabled({ ENGINE_SYNTAX_XPATH: '1' })).toBe(true);
    expect(engineSyntaxXPathEnabled({ ENGINE_SYNTAX_XPATH: ' On ' })).toBe(true);
    expect(engineSyntaxXPathEnabled({ ENGINE_SYNTAX_OR: '1' })).toBe(false); // 两开关互不牵连
  });

  const plain = { url: 'https://a.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: 'class.item', name: 'tag.a@text' } } };
  const xp = { url: 'https://b.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: "//div[@class='item']", name: 'tag.a@text' } } };
  const both = { url: 'https://c.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: "//div[@class='item']", name: 'tag.a@text||tag.b@text' } } };

  it('按源判定：只有含 XPath 段的源在开关 on 时换版本，其余源 identity 不变', () => {
    expect(sourceUsesXPathSyntax(plain.rules)).toBe(false);
    expect(sourceUsesXPathSyntax(xp.rules)).toBe(true);
    const off = { orEnabled: false, xpathEnabled: false };
    expect(engineSourceRevision(plain, off)).toBe(`1:${sourceRevision(plain)}`);
    expect(engineSourceRevision(xp, off)).toBe(`1:${sourceRevision(xp)}`);
    expect(engineSourceRevision(plain, { orEnabled: true, xpathEnabled: true })).toBe(`1:${sourceRevision(plain)}`);
    expect(engineSourceRevision(xp, { orEnabled: false, xpathEnabled: true })).toBe(`3:${sourceRevision(xp)}`);
    expect(engineSourceRevision(xp, { orEnabled: true, xpathEnabled: true })).toBe(`3:${sourceRevision(xp)}`);
    expect(engineSourceRevision(both, { orEnabled: true, xpathEnabled: false })).toBe(`2:${sourceRevision(both)}`);
    expect(engineSourceRevision(both, { orEnabled: true, xpathEnabled: true })).toBe(`4:${sourceRevision(both)}`);
  });

  it('compileSource：on/off 两态缓存互不污染', () => {
    const off = compileSource(xp, { orEnabled: false, xpathEnabled: false });
    const on = compileSource(xp, { orEnabled: false, xpathEnabled: true });
    expect(off.get('ruleSearch.bookList')).toEqual({ skipped: 'unsupported' });
    expect(on.get('ruleSearch.bookList')).toEqual({ rules: [{ kind: 'css', chain: [{ selector: 'div[class="item"]' }], terminal: undefined }] });
  });
});

describe('parseFieldRule 接线', () => {
  const off = { orEnabled: true, xpathEnabled: false };
  const on = { orEnabled: true, xpathEnabled: true };

  it('off：与旧 parser 一致（XPath 拒绝；@XPath: 前缀无判别特征时照旧落默认语法）', () => {
    expect(codeOf(() => parseFieldRule("//div[@class='x']/text()", off))).toBe('unsupported_xpath');
    expect(codeOf(() => parseFieldRule('//ul/li', off))).toBe('unsupported_xpath');
    expect(parseFieldRule('@XPath:ul/li', off).rules[0].kind).toBe('css');
    expect(parseFieldRule('class.a@text', off)).toEqual(parseFieldRule('class.a@text', on));
  });

  it('on：子集翻成 css IR；末端 /@href 走 toTerminal（绝对化），/text() → textNodes', () => {
    expect(parseFieldRule("//div[@class='x']/a/@href", on)).toEqual({
      rules: [{ kind: 'css', chain: [{ selector: 'div[class="x"] > a' }], terminal: { op: 'href' } }],
    });
    expect(parseFieldRule('@XPath://h1/text()##第.*章##', on)).toEqual({
      rules: [{ kind: 'css', chain: [{ selector: 'h1' }], terminal: { op: 'textNodes' } }],
      regex: [{ pattern: '第.*章', replacement: '', flags: undefined }],
    });
    expect(parseFieldRule("//meta[@name='x']/@data-id", on).rules[0]).toEqual({
      kind: 'css', chain: [{ selector: 'meta[name="x"]' }], terminal: { op: 'attr', name: 'data-id' },
    });
  });

  it('on：子集外、legado 特殊变量末端、|| 支内的子集外 XPath 都拒', () => {
    expect(codeOf(() => parseFieldRule("//div[@id='a']/following-sibling::div", on))).toBe('unsupported_xpath');
    expect(codeOf(() => parseFieldRule('//a/@baseUrl', on))).toBe('unsupported_special_var');
    expect(codeOf(() => parseFieldRule("class.a@text||//div[starts-with(@id,'a')]", on))).toBe('unsupported_xpath');
    expect(codeOf(() => parseFieldRule('//div/@js:result', on))).toBe('unsupported_js');
  });

  it('on + OR off：单段 XPath 照样翻译', () => {
    expect(parseFieldRule('//li/a', { orEnabled: false, xpathEnabled: true }).rules[0]).toEqual({
      kind: 'css', chain: [{ selector: 'li > a' }], terminal: undefined,
    });
  });
});

describe('翻译后求值（cheerio）', () => {
  const HTML = `<html><head><meta property="og:title" content="书名甲"><meta property="og:novel:author" content="作者乙"></head>
<body><div class="info"><h1>标题<em>附注</em>尾</h1></div>
<ul class="list"><li><a href="/b/1">一</a></li><li><a href="/b/2">二</a></li></ul>
<ul class="list"><li><a href="/b/3">三</a></li></ul>
<div id="content">第一段<br>第二段</div></body></html>`;
  const scope = () => createHtmlScope(HTML, 'https://h.example/s?q=1');
  const on = { orEnabled: true, xpathEnabled: true };
  const f = (rule: string) => parseFieldRule(rule, on);

  it('meta 属性、文本节点、绝对化 href', () => {
    expect(evaluateField(f("//meta[@property='og:title']/@content"), scope())).toBe('书名甲');
    expect(evaluateField(f("//meta[@property='og:novel:author']/@content"), scope())).toBe('作者乙');
    expect(evaluateField(f("//div[@class='info']/h1/text()"), scope())).toBe('标题\n尾');
    expect(evaluateField(f("//ul[@class='list']/li/a/@href"), scope())).toBe('https://h.example/b/1');
    expect(evaluateField(f("//div[@id='content']/text()"), scope(), true)).toBe('第一段\n第二段');
  });

  it('列表：节点集 + 列表内相对 XPath；/html 起始的绝对路径与 [n]', () => {
    const items = evaluateFieldList(f("//ul[@class='list']/li"), scope());
    expect(items).toHaveLength(3);
    expect(items.map((s) => evaluateField(f('//a/text()'), s))).toEqual(['一', '二', '三']);
    expect(items.map((s) => evaluateField(f('@XPath:./a/@href'), s))).toEqual(['https://h.example/b/1', 'https://h.example/b/2', 'https://h.example/b/3']);
    expect(evaluateField(f('/html/body/ul[2]/li/a/text()'), scope())).toBe('三');
    expect(evaluateField(f('//ul[1]/li[last()]/a/text()'), scope())).toBe('二');
  });
});
