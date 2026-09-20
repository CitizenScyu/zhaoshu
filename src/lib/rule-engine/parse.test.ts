import { describe, expect, it } from 'vitest';
import dialects from './fixtures/dialects.json';
import { parseFieldRule, parseRule, splitTopLevel, stripRegexSuffix } from './parse';
import { RuleEngineError } from './types';

// 滤网 1 的验收仪表：全构件 IR 快照 + 不支持构件断言 RULE_UNSUPPORTED（设计 §8.2）。

describe('parse: 支持构件 → IR 快照', () => {
  it.each(dialects.supported)('$construct: $rule', ({ rule }) => {
    const ir = parseFieldRule(rule);
    expect(ir).toMatchSnapshot();
  });
});

describe('parse: 不支持构件 → RULE_UNSUPPORTED', () => {
  it.each(dialects.unsupported)('$construct: $rule', ({ rule }) => {
    let caught: unknown;
    try {
      parseFieldRule(rule);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuleEngineError);
    expect((caught as RuleEngineError).code).toBe('RULE_UNSUPPORTED');
  });
});

describe('parse: 结构化拒绝诊断', () => {
  it.each([
    ['.a||.b', { code: 'unsupported_operator', operator: '||' }],
    ['.a&&.b', { code: 'unsupported_operator', operator: '&&' }],
    ['.a%%.b', { code: 'unsupported_operator', operator: '%%' }],
    ['.a@get:x', { code: 'unsupported_var_get' }],
    ['.a@put:x', { code: 'unsupported_var_put' }],
    ['.a{{book.name}}', { code: 'unsupported_template_var' }],
    ['.a{{1+1}}', { code: 'unsupported_template_js' }],
    ['//div/a', { code: 'unsupported_xpath' }],
    ['##x##', { code: 'regex_only' }],
  ])('%s', (rule, diagnostic) => {
    expect(() => parseFieldRule(rule)).toThrowError(expect.objectContaining({ diagnostic }));
  });
});

describe('parse: 默认语法翻译细节', () => {
  it('tag.X → X', () => {
    const ir = parseRule('tag.a@text');
    expect(ir).toEqual({ kind: 'css', chain: [{ selector: 'a' }], terminal: { op: 'text' } });
  });

  it('class.X 多 class（空格）→ .X1.X2', () => {
    const ir = parseRule('class.book-list clearfix@li');
    expect(ir).toEqual({ kind: 'css', chain: [{ selector: '.book-list.clearfix' }, { selector: 'li' }], terminal: undefined });
  });

  it('id.X → #X', () => {
    const ir = parseRule('id.ret-list@li');
    expect(ir).toEqual({ kind: 'css', chain: [{ selector: '#ret-list' }, { selector: 'li' }], terminal: undefined });
  });

  it('text.关键字 → :contains + ownTextContains 复核标记', () => {
    const ir = parseRule('text.目录@href');
    expect(ir).toMatchObject({
      kind: 'css',
      chain: [{ selector: ':contains(目录)', ownTextContains: '目录' }],
      terminal: { op: 'href' },
    });
  });

  it('.class 简写保持 .class（不误判为索引）', () => {
    const ir = parseRule('.list-item-panel');
    expect(ir).toEqual({ kind: 'css', chain: [{ selector: '.list-item-panel' }] });
  });

  it('X.n 标签+索引 → selector + index', () => {
    const ir = parseRule('a.0@href');
    expect(ir).toMatchObject({ kind: 'css', chain: [{ selector: 'a', index: 0 }], terminal: { op: 'href' } });
  });

  it('负索引从尾数', () => {
    const ir = parseRule('class.pagebar@a.-1@href');
    expect(ir).toMatchObject({ kind: 'css', chain: [{ selector: '.pagebar' }, { selector: 'a', index: -1 }] });
  });

  it('切片 .a:b', () => {
    const ir = parseRule('id.list@dd.0:8');
    expect(ir).toMatchObject({ kind: 'css', chain: [{ selector: '#list' }, { selector: 'dd', slice: [0, 8] }] });
  });

  it('排除 !0', () => {
    const ir = parseRule('class.books-list@tag.div!0');
    expect(ir).toMatchObject({ kind: 'css', chain: [{ selector: '.books-list' }, { selector: 'div', excludes: [0] }] });
  });

  it('括号排除 [!1,3,5]', () => {
    const ir = parseRule('class.mid@p[!1,3,5]');
    expect(ir).toMatchObject({ kind: 'css', chain: [{ selector: '.mid' }, { selector: 'p', excludes: [1, 3, 5] }] });
  });

  it('裸 @text 合法（chain 空 + terminal）', () => {
    const ir = parseRule('@text');
    expect(ir).toEqual({ kind: 'css', chain: [], terminal: { op: 'text' } });
  });

  it('裸 @href 合法', () => {
    const ir = parseRule('@href');
    expect(ir).toEqual({ kind: 'css', chain: [], terminal: { op: 'href' } });
  });

  it('具名属性兜底 @data-id', () => {
    const ir = parseRule('span@data-id');
    expect(ir).toMatchObject({ kind: 'css', terminal: { op: 'attr', name: 'data-id' } });
  });

  it('纯绝对 URL → text', () => {
    const ir = parseRule('https://example.com/toc/1');
    expect(ir).toEqual({ kind: 'text', literal: 'https://example.com/toc/1' });
  });

  it('tpl_jsonpath URL → template（literal + jsonpath 段）', () => {
    const ir = parseRule('https://api.x.com/book/{{$.book_id}}');
    expect(ir).toMatchObject({
      kind: 'template',
      parts: [
        { kind: 'literal', text: 'https://api.x.com/book/' },
        { kind: 'jsonpath' },
      ],
    });
  });
});

describe('parse: 单段末端关键字（P0：段视为 op 而非 CSS 标签）', () => {
  it('单段 text → chain 空 + terminal text（不当 <text> 标签）', () => {
    expect(parseFieldRule('text')).toEqual({
      rules: [{ kind: 'css', chain: [], terminal: { op: 'text' } }],
    });
  });

  it('单段 href → chain 空 + terminal href', () => {
    expect(parseFieldRule('href')).toEqual({
      rules: [{ kind: 'css', chain: [], terminal: { op: 'href' } }],
    });
  });

  it('单段 html → chain 空 + terminal html', () => {
    expect(parseRule('html')).toEqual({ kind: 'css', chain: [], terminal: { op: 'html' } });
  });

  it('text##上次阅读 → chain 空 + terminal text，正则尾缀保留', () => {
    expect(parseFieldRule('text##上次阅读')).toEqual({
      rules: [{ kind: 'css', chain: [], terminal: { op: 'text' } }],
      regex: [{ pattern: '上次阅读', replacement: '', flags: undefined }],
    });
  });

  it('单段 div → 选择器步，无 terminal（回归：裸标签名不得误判为 attr/op）', () => {
    expect(parseFieldRule('div')).toEqual({
      rules: [{ kind: 'css', chain: [{ selector: 'div' }] }],
    });
  });

  it('单段 a / p → 选择器步（回归）', () => {
    expect(parseRule('a')).toEqual({ kind: 'css', chain: [{ selector: 'a' }] });
    expect(parseRule('p')).toEqual({ kind: 'css', chain: [{ selector: 'p' }] });
  });

  it('单段具名属性型 token（data-id）仍走选择器步（回归）', () => {
    expect(parseRule('data-id')).toEqual({ kind: 'css', chain: [{ selector: 'data-id' }] });
  });
});

describe('parse: 正则尾缀剥离', () => {
  it('单 ## = 删匹配（replacement 空）', () => {
    const { body, regex } = stripRegexSuffix('text##上次阅读', 'text##上次阅读');
    expect(body).toBe('text');
    expect(regex).toEqual([{ pattern: '上次阅读', replacement: '', flags: undefined }]);
  });

  it('三 ## = pattern/replacement，trailing ### flags 噪声被清洗为 undefined', () => {
    const { body, regex } = stripRegexSuffix("a.0@href##'([^']+)'##$1###", "a.0@href##'([^']+)'##$1###");
    expect(body).toBe('a.0@href');
    expect(regex[0].pattern).toBe("'([^']+)'");
    expect(regex[0].replacement).toBe('$1');
    expect(regex[0].flags).toBeUndefined();
  });

  it('非法正则 pattern → RULE_UNSUPPORTED', () => {
    expect(() => parseFieldRule('a@text##(unclosed##x##')).toThrow(RuleEngineError);
  });
});

describe('parse: 顶层切分（括号/引号感知）', () => {
  it('|| 顶层切分', () => {
    expect(splitTopLevel('a||b||c', '||')).toEqual(['a', 'b', 'c']);
  });

  it('括号内 || 不切', () => {
    expect(splitTopLevel('a:has(x||y)@text', '||')).toEqual(['a:has(x||y)@text']);
  });

  it('引号内 || 不切', () => {
    expect(splitTopLevel("a[x='p||q']", '||')).toEqual(["a[x='p||q']"]);
  });

  it('顶层 || → RULE_UNSUPPORTED（M1 期）', () => {
    expect(() => parseFieldRule('tag.a@href||href')).toThrow(RuleEngineError);
  });

  it('顶层 && → RULE_UNSUPPORTED', () => {
    expect(() => parseFieldRule('a@content&&b@content')).toThrow(RuleEngineError);
  });
});

describe('parse: 防御上限', () => {
  it('超长规则 → RULE_UNSUPPORTED', () => {
    expect(() => parseFieldRule('a'.repeat(3000))).toThrow(RuleEngineError);
  });

  it('空规则 → RULE_UNSUPPORTED', () => {
    expect(() => parseFieldRule('   ')).toThrow(RuleEngineError);
  });
});
