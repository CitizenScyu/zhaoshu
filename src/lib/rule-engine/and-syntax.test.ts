// and1027：ENGINE_SYNTAX_AND —— legado `&&` 合并语义的 parse/compile/evaluate 接线与语义版本。
// 样例规则取自离线池里单一拒因为 && 的真实源（or-sim and-samples）。
import { describe, expect, it } from 'vitest';
import { parseFieldRule } from './parse';
import { RuleEngineError } from './types';
import { compileSource, engineSourceRevision, sourceUsesAndSyntax } from './compile';
import { contentNeedsHtmlToText } from './content-html';
import { engineSemanticsVersion, engineSyntaxAndEnabled } from './syntax-flags';
import { createJsonScope, createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { sourceRevision } from '@/lib/source-revision';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const ON = { orEnabled: true, xpathEnabled: true, xpathEvalEnabled: true, regexEnabled: true, andEnabled: true } as const;
const OFF = { ...ON, andEnabled: false } as const;
const f = (rule: string, field = 'ruleContent.content') => parseFieldRule(rule, { ...ON, field });
const off = (rule: string, field = 'ruleContent.content') => parseFieldRule(rule, { ...OFF, field });

const PAGE = `<html><body>
<h1>第一章 起</h1>
<div id="content"><p>正文一</p><p>正文二</p></div>
<div class="extra"><p>续一</p></div>
<div class="a"><li><a href="/b/1">甲</a></li><li><a href="/b/2">乙</a></li></div>
<div class="b"><li><a href="/b/3">丙</a></li></div>
<a class="u1" href="">空</a><a class="u2" href="/toc/9">目录</a>
</body></html>`;
const pageScope = () => createScope(normalizeBody(PAGE), 'https://h.example/book/1');

describe('开关与语义版本', () => {
  it('engineSyntaxAndEnabled 严格口径', () => {
    expect(engineSyntaxAndEnabled({})).toBe(false);
    expect(engineSyntaxAndEnabled({ ENGINE_SYNTAX_AND: '0' })).toBe(false);
    expect(engineSyntaxAndEnabled({ ENGINE_SYNTAX_AND: 'yes' })).toBe(false);
    expect(engineSyntaxAndEnabled({ ENGINE_SYNTAX_AND: ' On ' })).toBe(true);
    expect(engineSyntaxAndEnabled({ ENGINE_SYNTAX_AND: 'TRUE' })).toBe(true);
  });

  it('&& 位 +64，1–64 逐字不变', () => {
    expect(engineSemanticsVersion(true, true, true, true, true, true)).toBe(64);
    expect(engineSemanticsVersion(false, false, false, false, false, false, true)).toBe(65);
    expect(engineSemanticsVersion(true, true, true, true, true, true, true)).toBe(128);
  });

  const plain = { url: 'https://a.example', searchUrl: '/s?q={{key}}', rules: { ruleContent: { content: 'id.content@text' } } };
  const andContent = { url: 'https://b.example', searchUrl: '/s?q={{key}}', rules: { ruleContent: { content: 'tag.h1@text&&id.content@text' } } };
  // 尾缀正则里的 && 是 off 态误拒，on 态按单段编译
  const tailOnly = { url: 'https://c.example', searchUrl: '/s?q={{key}}', rules: { ruleContent: { content: 'id.content@html##\\&&lt;|&&gt;' } } };
  // 装饰字段的 && 两态都拒
  const decorative = { url: 'https://d.example', searchUrl: '/s?q={{key}}', rules: { ruleBookInfo: { intro: 'class.a@text&&class.b@text' } } };
  const opts = { varsEnabled: true, jsEnabled: false, xpathEnabled: true, xpathEvalEnabled: true, regexEnabled: true };

  it('按源判定：只有 off 态因 && 被拒、on 态编译通过的源换版本', () => {
    expect(sourceUsesAndSyntax(plain.rules, opts)).toBe(false);
    expect(sourceUsesAndSyntax(andContent.rules, opts)).toBe(true);
    expect(sourceUsesAndSyntax(tailOnly.rules, opts)).toBe(true);
    expect(sourceUsesAndSyntax(decorative.rules, opts)).toBe(false);
    const rev = (src: typeof plain, andEnabled: boolean, orEnabled = true) => engineSourceRevision(src, { orEnabled, andEnabled });
    expect(rev(andContent, false)).toBe(`1:${sourceRevision(andContent)}`);
    expect(rev(andContent, true)).toBe(`65:${sourceRevision(andContent)}`);
    expect(rev(andContent, true, false)).toBe(`1:${sourceRevision(andContent)}`); // 须 OR 同开
    expect(rev(plain, true)).toBe(`1:${sourceRevision(plain)}`);
    expect(engineSourceRevision(decorative, { orEnabled: true, andEnabled: true })).toBe(`1:${sourceRevision(decorative)}`);
  });

  it('compileSource：off 照旧 skipped，on 编译成 and IR，两态缓存互不污染', () => {
    const offC = compileSource(andContent, { orEnabled: true, andEnabled: false });
    const onC = compileSource(andContent, { orEnabled: true, andEnabled: true });
    expect(offC.get('ruleContent.content')).toEqual({ skipped: 'unsupported' });
    expect(onC.get('ruleContent.content')).toMatchObject({ rules: [{ kind: 'and', branches: [{ kind: 'css' }, { kind: 'css' }] }] });
  });
});

describe('parseFieldRule 接线', () => {
  it('off / OR 关 / 非开放字段 / 未给字段名：顶层 && 照旧 unsupported_operator', () => {
    for (const rule of ['tag.h1@text&&id.content@text', 'id.content@html##\\&&lt;']) {
      expect(codeOf(() => off(rule))).toBe('unsupported_operator');
      expect(codeOf(() => parseFieldRule(rule, { ...ON, orEnabled: false, field: 'ruleContent.content' }))).toBe('unsupported_operator');
      expect(codeOf(() => parseFieldRule(rule, { ...ON }))).toBe('unsupported_operator');
      for (const field of ['ruleBookInfo.intro', 'ruleContent.nextContentUrl', 'ruleToc.nextTocUrl', 'ruleExplore.bookList']) {
        expect(codeOf(() => f(rule, field))).toBe('unsupported_operator');
      }
    }
  });

  it('on：不含顶层 && 的规则与 off 逐字一致', () => {
    for (const rule of ['id.content@text', 'class.a@text||class.b@text##x', 'tag.p@text##a##b###']) {
      expect(f(rule)).toEqual(off(rule));
    }
    // 括号内的 && 不是顶层运算符：两态同一拒因（JSONPath 过滤器子集不认 &&）
    expect(codeOf(() => f('$.data[?(@.a && @.b)].name'))).toBe(codeOf(() => off('$.data[?(@.a && @.b)].name')));
  });

  it('on：尾缀正则里的 && 不再误拒，按单段编译（与去掉 && 的同形规则同 IR 结构）', () => {
    const ir = f('id.nr1@html||.chapter_content@html\n##\\&&lt;|&&gt;|/');
    expect(ir.rules[0].kind).toBe('or');
    expect(ir.regex).toEqual([{ pattern: '\\&&lt;|&&gt;|/', replacement: '', flags: undefined }]);
    expect(f('id.content@html##\\&&lt;').rules[0]).toMatchObject({ kind: 'css', terminal: { op: 'html' } });
  });

  it('on：主体顶层 && 产出 and IR，字段级 ## 挂在 FieldIr.regex；URL 字段标 first', () => {
    const ir = f('class.arc_content@html&&id.wz_jx@tbody@html##广告');
    expect(ir.rules).toHaveLength(1);
    expect(ir.rules[0]).toMatchObject({ kind: 'and', branches: [{ kind: 'css' }, { kind: 'css' }] });
    expect(ir.rules[0]).not.toHaveProperty('first');
    expect(ir.regex).toEqual([{ pattern: '广告', replacement: '', flags: undefined }]);
    expect(f('tag.a.0@href&&tag.a.1@href', 'ruleToc.chapterUrl').rules[0]).toMatchObject({ kind: 'and', first: true });
    expect(f('$.attributes.title&&$.attributes.intro', 'ruleSearch.name').rules[0]).toMatchObject({
      kind: 'and', branches: [{ kind: 'jsonpath' }, { kind: 'jsonpath' }],
    });
    // 首支 JSONPath 时后支默认语法可用（legado 整条 Json 模式，补 $.）
    expect(f('$.a&&b', 'ruleSearch.name').rules[0]).toMatchObject({ kind: 'and', branches: [{ kind: 'jsonpath' }, { kind: 'css' }] });
  });

  it('on：拒绝不能逐支对齐 legado 的形态', () => {
    expect(codeOf(() => f('http://novel.tingroom.com/wap/&& tag.a@href', 'ruleSearch.bookUrl'))).toBe('unsupported_operator');
    expect(codeOf(() => f('@css:h1@text&&div@text'))).toBe('unsupported_operator');
    expect(codeOf(() => f('tag.h1@text&&$.x'))).toBe('unsupported_operator');
    expect(codeOf(() => f('a@text&&b@text||c@text'))).toBe('unsupported_operator');
    expect(codeOf(() => f('a@text||b@text&&c@text'))).toBe('unsupported_operator');
    expect(codeOf(() => f('//div[1]/text()&&tag.p@text'))).toBe('unsupported_operator');
    expect(codeOf(() => f('class.a@li@text&&class.b@li', 'ruleSearch.bookList'))).toBe('unsupported_operator');
    // AllInOne 正则列表（legado `:` 前缀，&& 是正则级联）
    expect(codeOf(() => f(':正文卷[\\s\\S]*?/dl&&href ="([^"]+)">([^<]+)', 'ruleToc.chapterList'))).toBe('unsupported_operator');
    expect(codeOf(() => f('tag.h1@text&&'))).toBe('empty_and_branch');
    expect(codeOf(() => f(Array.from({ length: 17 }, (_, i) => `tag.p.${i}@text`).join('&&')))).toBe('or_branches_too_many');
  });
});

describe('求值', () => {
  it('字符串字段：非空支按行拼接（单值字段每支取首个非空）', () => {
    expect(evaluateField(f('tag.h1@text&&class.extra@text&&class.none@text', 'ruleBookInfo.name'), pageScope())).toBe('第一章 起\n续一');
  });

  it('正文（multi）：每支按 multi 取值后按行拼接；字段级 ## 在拼接后套用', () => {
    const field = f('tag.h1@text&&id.content@tag.p@text&&class.extra@tag.p@text##续');
    expect(evaluateField(field, pageScope(), true)).toBe('第一章 起\n正文一\n正文二\n一');
  });

  it('URL 字段：HTML 上取首个非空支', () => {
    expect(evaluateField(f('class.u1@href&&class.u2@href', 'ruleBookInfo.tocUrl'), pageScope())).toBe('https://h.example/toc/9');
  });

  it('URL 字段：JSON 上只有一支命中时取它，多支命中求值失败（legado 按行拼成坏 URL）', () => {
    const field = f('$.a&&$.b', 'ruleSearch.bookUrl');
    expect(evaluateField(field, createJsonScope({ b: '/x/2' }, 'https://h.example/'))).toBe('/x/2');
    expect(codeOf(() => evaluateField(field, createJsonScope({ a: '/x/1', b: '/x/2' }, 'https://h.example/')))).toBe('RULE_EVAL_FAILED');
  });

  it('JSON 字符串字段：各支（含默认语法补 $.）按行拼接', () => {
    const scope = createJsonScope({ attributes: { title: '标题', intro: '简介' }, extra: '附' }, 'https://h.example/');
    expect(evaluateField(f('$.attributes.title&&$.attributes.intro', 'ruleSearch.name'), scope)).toBe('标题\n简介');
    expect(evaluateField(f('$.attributes.title&&extra', 'ruleSearch.name'), scope)).toBe('标题\n附');
  });

  it('列表字段：HTML 节点集按支序拼接，保序保重复', () => {
    const items = evaluateFieldList(f('class.a@tag.li&&class.b@tag.li&&class.a@tag.li.0', 'ruleSearch.bookList'), pageScope());
    const name = parseFieldRule('tag.a@text', { ...ON, field: 'ruleSearch.name' });
    expect(items.map((item) => evaluateField(name, item))).toEqual(['甲', '乙', '丙', '甲']);
  });

  it('列表字段：JSON 条目按支序拼接', () => {
    const scope = createJsonScope({ hot: [{ n: '甲' }], list: [{ n: '乙' }, { n: '丙' }] }, 'https://h.example/');
    const items = evaluateFieldList(f('$.list[*]&&$.hot[*]', 'ruleSearch.bookList'), scope);
    const name = parseFieldRule('$.n', { ...ON, field: 'ruleSearch.name' });
    expect(items.map((item) => evaluateField(name, item))).toEqual(['乙', '丙', '甲']);
  });

  it('正文 HTML→纯文本判定：全部支是文本末端才透传', () => {
    expect(contentNeedsHtmlToText(f('tag.h1@text&&id.content@text'))).toBe(false);
    expect(contentNeedsHtmlToText(f('tag.h1@text&&id.content@html'))).toBe(true);
  });
});
