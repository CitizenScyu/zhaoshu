// JS 链单测（jsbox1027，ENGINE_SYNTAX_JS）：编译期形状与白名单、链式求值口径（null 中止、$n、正则段）、
// 开关关时零变化。翻页多 URL（fanout）在 js-chain-paging.test.ts。

import { describe, expect, it } from 'vitest';
import { compileSource, sourceUsesJsSyntax } from './compile';
import { createHtmlScope, createScope, evaluateField, evaluateFieldStrings, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule } from './parse';
import { RuleEngineError, type FieldIr } from './types';

const URL_ = 'https://example.com/list/1.html';
const HTML = `
  <div class="item"><h2 class="name">书名一</h2><a href="/b/1.html">链接</a></div>
  <div class="item"><h2 class="name">书名二</h2><a href="/b/2.html">链接</a></div>
  <div class="content"><p>第一段</p><p>第二段</p></div>
  <a class="next" href="/list/2.html">下一页</a>
`;

const ON = { jsEnabled: true } as const;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof RuleEngineError) return error.diagnostic?.code ?? error.code;
    throw error;
  }
  return undefined;
}

function chain(rule: string, field: string): FieldIr {
  return parseFieldRule(rule, { ...ON, field });
}

/** 直接编译整个源，取某字段的链（验证 compileSource 的接线）。 */
function compiledField(rules: Record<string, unknown>, field: string): FieldIr | undefined {
  const compiled = compileSource({ url: 'https://example.com/', searchUrl: 'https://example.com/s?q={{key}}', rules }, { jsEnabled: true });
  const ir = compiled.get(field);
  return ir && !('skipped' in ir) ? ir : undefined;
}

describe('parse: JS 链编译', () => {
  it('开关关时含 JS 照旧 unsupported_js（零变化）', () => {
    expect(codeOf(() => parseFieldRule('.a@js:result+1', { field: 'ruleContent.content' }))).toBe('unsupported_js');
    expect(codeOf(() => parseFieldRule('.a@js:result+1'))).toBe('unsupported_js');
  });

  it('<js> 段与 @js: 段都切成 js stage，前后非空段成 rule stage', () => {
    const ir = chain('.name@text<js>result.trim()</js>##^《|》$##', 'ruleSearch.name');
    expect(ir.chain?.map((s) => s.kind)).toEqual(['rule', 'js', 'regex']);
  });

  it('首段是纯 CSS：先取规则再交 JS', () => {
    const ir = chain('.name@text@js:result.replace("书名","")', 'ruleSearch.name');
    expect(ir.chain).toHaveLength(2);
    expect(ir.chain?.[0].kind).toBe('rule');
  });

  it('页面级字段允许首段直接是 JS（可用 src）', () => {
    const ir = chain('@js:src.split("<title>")[1]', 'ruleContent.content');
    expect(ir.chain).toEqual([{ kind: 'js', code: 'src.split("<title>")[1]' }]);
  });

  it.each([
    ['条目级字段首段是 JS', '@js:result.trim()', 'ruleSearch.name'],
    ['列表字段不开放', '.item<js>result</js>', 'ruleSearch.bookList'],
    ['非白名单字段', '.a@js:result', 'ruleBookInfo.intro'],
    ['未知字段（无 field）', '.a@js:result', undefined],
    ['空 JS 段', '.a@js:', 'ruleContent.content'],
    ['含 ##', '.a@js:result##x', 'ruleContent.content'],
    ['含 {{}}', '.a@js:{{x}}', 'ruleContent.content'],
    ['含 @get:', '.a@js:result@get:k', 'ruleContent.content'],
  ])('拒绝：%s', (_label, rule, field) => {
    expect(codeOf(() => parseFieldRule(rule, { jsEnabled: true, field }))).toBe('unsupported_js');
  });

  it.each([
    ['book', 'book.name'],
    ['source', 'source.getKey()'],
    ['cookie', 'cookie.getCookie("a")'],
    ['ajax', 'java.ajax("http://x")'],
    ['get 之外的 java', 'java.get("http://x")'],
    ['eval', 'eval("1")'],
    ['fetch', 'fetch("http://x")'],
    ['item 级 src', 'src'],
  ])('拒绝依赖宿主能力的标识符：%s', (_label, code) => {
    const field = _label === 'item 级 src' ? 'ruleSearch.name' : 'ruleContent.content';
    expect(codeOf(() => parseFieldRule(`.a@js:${code}`, { jsEnabled: true, field }))).toBe('unsupported_js');
  });

  it('字符串/注释里出现黑名单词不算引用', () => {
    expect(parseFieldRule('.a@js:"book cookie".length + result.length', { ...ON, field: 'ruleContent.content' }).chain)
      .toEqual([
        { kind: 'rule', field: expect.objectContaining({ rules: expect.any(Array) }) },
        { kind: 'js', code: '"book cookie".length + result.length' },
      ]);
    expect(codeOf(() => parseFieldRule('.a@js:result // book\n', { ...ON, field: 'ruleContent.content' }))).toBeUndefined();
  });

  it('property access 不算裸标识符：x.book / java.base64Decode 放行', () => {
    expect(codeOf(() => parseFieldRule('.a@js:({"book":1}).book', { ...ON, field: 'ruleContent.content' }))).toBeUndefined();
    expect(codeOf(() => parseFieldRule('.a@js:java.base64Decode(result)', { ...ON, field: 'ruleContent.content' }))).toBeUndefined();
  });

  it('规则超长拒绝', () => {
    expect(codeOf(() => parseFieldRule('.a@js:1'.padEnd(9000, '+1'), { ...ON, field: 'ruleContent.content' }))).toBe('rule_too_long');
  });
});

describe('compileSource: JS 接线', () => {
  const rules = {
    ruleSearch: { bookList: '.item', name: '.name@text@js:result.trim()', bookUrl: 'a@href' },
    ruleBookInfo: { name: '.name@text', author: '.author@text', tocUrl: '@js:baseUrl' },
    ruleToc: { chapterList: '.item', chapterName: '.name@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@html' },
  };

  it('jsEnabled off：带 JS 的字段被 skipped，其余照常', () => {
    const compiled = compileSource({ url: 'https://example.com/', searchUrl: 'https://example.com/s?q={{key}}', rules }, { jsEnabled: false });
    expect(compiled.get('ruleSearch.name')).toEqual(expect.objectContaining({ skipped: 'unsupported' }));
    expect(compiled.get('ruleSearch.bookUrl')).toEqual(expect.objectContaining({ rules: expect.any(Array) }));
  });

  it('jsEnabled on：白名单字段编译成 chain', () => {
    expect(compiledField(rules, 'ruleSearch.name')?.chain).toHaveLength(2);
    expect(compiledField(rules, 'ruleBookInfo.tocUrl')?.chain).toEqual([{ kind: 'js', code: 'baseUrl' }]);
  });

  it('源带 jsLib：整源不开 JS 链（沙箱不执行 jsLib）', () => {
    expect(compiledField({ ...rules, jsLib: 'function f(){return 1}' }, 'ruleSearch.name')).toBeUndefined();
    expect(compiledField({ ...rules, jsLib: '   ' }, 'ruleSearch.name')?.chain).toHaveLength(2);
  });

  it('装饰字段带 JS 不参与语义版本判定（只看白名单字段）', () => {
    // 基线 rules 的两处 JS 都在白名单字段上（ruleSearch.name / ruleBookInfo.tocUrl）。
    const noCoreJs = {
      ...rules,
      ruleSearch: { ...rules.ruleSearch, name: '.name@text' },
      ruleBookInfo: { ...rules.ruleBookInfo, tocUrl: '.toc@href' },
    };
    expect(sourceUsesJsSyntax(rules)).toBe(true);
    expect(sourceUsesJsSyntax(noCoreJs)).toBe(false);
    // 只在装饰字段上挂 JS：不升版本位。
    expect(sourceUsesJsSyntax({ ...noCoreJs, ruleBookInfo: { ...noCoreJs.ruleBookInfo, intro: '.intro@js:result' } })).toBe(false);
    // 源带 jsLib：整源不开 JS 链，语义位也不该变。
    expect(sourceUsesJsSyntax({ ...rules, jsLib: 'function f(){return 1}' })).toBe(false);
  });
});

describe('evaluate: 链式求值', () => {
  const scope = () => createScope(normalizeBody(HTML), URL_);

  it('规则段 → JS 段：字符串逐段传递', async () => {
    await preloadJsSandbox();
    const ir = chain('.name@text@js:result.replace("书名","")', 'ruleSearch.name');
    expect(evaluateField(ir, createHtmlScope(HTML, URL_))).toBe('一');
  });

  it('首段 JS 拿整页原文（src），条目级没有 src', async () => {
    await preloadJsSandbox();
    const ir = chain('@js:src.length', 'ruleContent.content');
    expect(evaluateField(ir, scope())).toBe(String(HTML.length));
    // 收窄到条目后 source 为 undefined → 求值失败，不静默返回空
    const item = createHtmlScope(HTML, URL_);
    const narrowed = { ...item, source: undefined };
    expect(() => evaluateField(ir, narrowed)).toThrowError(RuleEngineError);
  });

  it('JS 返回 null → 整链中止得空串', async () => {
    await preloadJsSandbox();
    const ir = chain('.name@text@js:null', 'ruleSearch.name');
    expect(evaluateField(ir, createHtmlScope(HTML, URL_))).toBe('');
  });

  it('列表结果喂 JS 前做 $n 替换（n≥1 取第 n 项，越界删去，$0 原样）', async () => {
    await preloadJsSandbox();
    const ir = chain('.name@text<js>"$1|$2|$0"</js>', 'ruleSearch.name');
    // getString 口径规则段是字符串（不触发替换）；列表口径才拆行喂数组（legado makeUpRule）。
    expect(evaluateField(ir, createHtmlScope(HTML, URL_))).toBe('$1|$2|$0');
    expect(evaluateFieldStrings(ir, createHtmlScope(HTML, URL_))).toEqual(['书名二||$0']);
  });

  it('列表口径：JS 返回数组 → 逐项字符串，已去空与 trim', async () => {
    await preloadJsSandbox();
    const ir = chain('@js:(src.match(/书名./g) || [])', 'ruleBookInfo.name');
    expect(evaluateFieldStrings(ir, scope())).toEqual(['书名一', '书名二']);
  });

  it('regex 段（## 尾缀主体为空）对上一段结果做替换', async () => {
    await preloadJsSandbox();
    // 注意：`@js:` 吞到串尾，后跟的 ## 会被当成 JS 代码（编译期拒）；正则段只能用 <js>…</js> 结尾的写法。
    const ir = chain('.name@text<js>result</js>##^书名##', 'ruleSearch.name');
    expect(evaluateField(ir, createHtmlScope(HTML, URL_))).toBe('一');
  });

  it('非正文字段在含 & 时解 HTML 实体；正文（multi）不解', async () => {
    await preloadJsSandbox();
    const ir = chain('@js:"a &amp; b"', 'ruleBookInfo.name');
    expect(evaluateField(ir, scope())).toBe('a & b');
    expect(evaluateField(ir, scope(), true)).toBe('a &amp; b');
  });

  it('非法/超时 JS 抛 RULE_EVAL_FAILED（不返回半成品）', async () => {
    await preloadJsSandbox();
    const ir = chain('.name@text@js:while(true){}', 'ruleSearch.name');
    expect(() => evaluateField(ir, createHtmlScope(HTML, URL_))).toThrowError(RuleEngineError);
  });
});
