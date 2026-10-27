// regex1027：ENGINE_SYNTAX_REGEX —— legado `##` 正则语义（replaceFirst + 正则-only 规则）的 parse/compile/evaluate 接线与语义版本。
// 样例规则取自离线池里单一拒因为 regex_only 的真实源（or-sim bucket-samples）。
import { describe, expect, it } from 'vitest';
import { parseFieldRule } from './parse';
import { RuleEngineError } from './types';
import { compileSource, engineSourceRevision, sourceUsesRegexSyntax } from './compile';
import { engineSemanticsVersion, engineSyntaxRegexEnabled } from './syntax-flags';
import {
  applyRegexSubs, createHtmlScope, createJsonScope, createScope, evaluateField, evaluateFieldList, normalizeBody,
} from './evaluate';
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

const ON = { orEnabled: true, xpathEnabled: true, xpathEvalEnabled: true, regexEnabled: true } as const;
const OFF = { orEnabled: true, xpathEnabled: true, xpathEvalEnabled: true, regexEnabled: false } as const;
const f = (rule: string, field = 'ruleBookInfo.author') => parseFieldRule(rule, { ...ON, field });

const PAGE = `<html><body>
<div class="info"><h1>书名甲</h1><p>作者：张三&amp;李四</p><p>最近更新：2026-10-01</p></div>
<ul class="list"><li><a href="/b/1">甲</a><span>作者:王五</span></li><li><a href="/b/2">乙</a></li></ul>
</body></html>`;
const pageScope = () => createScope(normalizeBody(PAGE), 'https://h.example/book/1');

describe('开关与语义版本', () => {
  it('engineSyntaxRegexEnabled 严格口径', () => {
    expect(engineSyntaxRegexEnabled({})).toBe(false);
    expect(engineSyntaxRegexEnabled({ ENGINE_SYNTAX_REGEX: '0' })).toBe(false);
    expect(engineSyntaxRegexEnabled({ ENGINE_SYNTAX_REGEX: 'yes' })).toBe(false);
    expect(engineSyntaxRegexEnabled({ ENGINE_SYNTAX_REGEX: ' On ' })).toBe(true);
    expect(engineSyntaxRegexEnabled({ ENGINE_SYNTAX_REGEX: 'TRUE' })).toBe(true);
  });

  it('正则位 +32，1–32 逐字不变', () => {
    expect(engineSemanticsVersion(true, true, true, true, true)).toBe(32);
    expect(engineSemanticsVersion(false, false, false, false, false, true)).toBe(33);
    expect(engineSemanticsVersion(true, true, true, true, true, true)).toBe(64);
  });

  const plain = { url: 'https://a.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: 'class.item', name: 'tag.a@text##\\s+' } } };
  const onlyRe = { url: 'https://b.example', searchUrl: '/s?q={{key}}', rules: { ruleBookInfo: { author: '##作者：([^<]+)<##$1###' } } };
  // 带选择器主体的 `###` 不改语义（已在池源按旧语义实测通过），identity 不变
  const selFirst = { url: 'https://c.example', searchUrl: '/s?q={{key}}', rules: { ruleBookInfo: { author: 'class.info@text##作者：(\\S+)##$1###' } } };
  const listRe = { url: 'https://d.example', searchUrl: '/s?q={{key}}', rules: { ruleSearch: { bookList: '##<li>(.*?)</li>' } } };
  const opts = { orEnabled: true, varsEnabled: true, jsEnabled: false, xpathEnabled: true, xpathEvalEnabled: true };

  it('按源判定：只有编译出正则-only 或 replaceFirst 的源换版本', () => {
    expect(sourceUsesRegexSyntax(plain.rules, opts)).toBe(false);
    expect(sourceUsesRegexSyntax(onlyRe.rules, opts)).toBe(true);
    expect(sourceUsesRegexSyntax(selFirst.rules, opts)).toBe(false);
    expect(sourceUsesRegexSyntax(listRe.rules, opts)).toBe(false); // 列表字段 on 态照旧拒
    const rev = (src: typeof plain | typeof onlyRe, regexEnabled: boolean) => engineSourceRevision(src, { orEnabled: false, regexEnabled });
    expect(rev(onlyRe, false)).toBe(`1:${sourceRevision(onlyRe)}`);
    expect(rev(onlyRe, true)).toBe(`33:${sourceRevision(onlyRe)}`);
    expect(rev(plain, true)).toBe(`1:${sourceRevision(plain)}`);
    expect(engineSourceRevision(listRe, { orEnabled: false, regexEnabled: true })).toBe(`1:${sourceRevision(listRe)}`);
  });

  it('compileSource：off 照旧 skipped，on 编译成 self IR，两态缓存互不污染', () => {
    const off = compileSource(onlyRe, { orEnabled: false, regexEnabled: false });
    const on = compileSource(onlyRe, { orEnabled: false, regexEnabled: true });
    expect(off.get('ruleBookInfo.author')).toEqual({ skipped: 'unsupported' });
    expect(on.get('ruleBookInfo.author')).toEqual({ rules: [{ kind: 'self' }], regex: [{ pattern: '作者：([^<]+)<', replacement: '$1', first: true }] });
  });
});

describe('parseFieldRule 接线', () => {
  it('off：正则-only 照旧 regex_only，第 3 段照旧当 flags（与改动前逐字一致）', () => {
    for (const rule of ['##作者：([^<]+)<##$1###', '##<h1>(.*)</h1>##$1']) {
      expect(codeOf(() => parseFieldRule(rule, OFF))).toBe('regex_only');
      expect(codeOf(() => parseFieldRule(rule, { orEnabled: false }))).toBe('regex_only');
    }
    expect(parseFieldRule('tag.p@text##a##b###', OFF).regex).toEqual([{ pattern: 'a', replacement: 'b', flags: undefined }]);
    expect(parseFieldRule('tag.p@text##a##b##i', OFF).regex).toEqual([{ pattern: 'a', replacement: 'b', flags: 'i' }]);
  });

  it('on：正则-only 段 ≥4 段即 replaceFirst（含 `##p##r##` 与 `##p##r##i`），1–3 段不变', () => {
    expect(f('##a##b###').regex).toEqual([{ pattern: 'a', replacement: 'b', first: true }]);
    expect(f('##a##b##').regex).toEqual([{ pattern: 'a', replacement: 'b', first: true }]);
    expect(f('##a##b##i').regex).toEqual([{ pattern: 'a', replacement: 'b', first: true }]);
    expect(f('##a##b').regex).toEqual([{ pattern: 'a', replacement: 'b', flags: undefined }]);
    expect(f('##a').regex).toEqual([{ pattern: 'a', replacement: '', flags: undefined }]);
  });

  it('on：带选择器主体的 `##` 替换与 off 逐字一致（不换 replaceFirst）', () => {
    for (const rule of ['tag.p@text##a##b###', 'tag.p@text##a##b##', 'tag.p@text##a##b##i', 'tag.p@text##a##b']) {
      expect(f(rule)).toEqual(parseFieldRule(rule, OFF));
    }
  });

  it('on：列表字段、装饰字段、未给字段名的正则-only 照旧拒', () => {
    expect(codeOf(() => parseFieldRule('##<li>(.*?)</li>', ON))).toBe('regex_only');
    for (const field of ['ruleSearch.bookList', 'ruleExplore.bookList', 'ruleToc.chapterList', 'ruleBookInfo.intro', 'ruleSearch.coverUrl']) {
      expect(codeOf(() => f('##<li>(.*?)</li>', field))).toBe('regex_only');
    }
    expect(f('##<li>(.*?)</li>', 'ruleSearch.name').rules).toEqual([{ kind: 'self' }]);
  });

  it('on：|| 支内的正则-only 照旧拒（空支诊断不变）', () => {
    expect(codeOf(() => f('class.x@text||##作者：(.*)##$1###'))).toBe('empty_or_branch');
  });
});

describe('applyRegexSubs replaceFirst', () => {
  const first = (pattern: string, replacement: string) => [{ pattern, replacement, first: true as const }];
  it('只取首个匹配，匹配外文本丢弃；无匹配得空', () => {
    expect(applyRegexSubs('前缀 作者：张三 作者：李四 后缀', first('作者：(\\S+)', '$1'))).toBe('张三');
    expect(applyRegexSubs('abc', first('x(\\d)', '$1'))).toBe('');
  });
  it('全局替换（非 first）行为不变', () => {
    expect(applyRegexSubs('a1b2', [{ pattern: '\\d', replacement: '' }])).toBe('ab');
  });
});

describe('求值', () => {
  it('整页作用域：对页面原文求值并解 HTML 实体', () => {
    expect(evaluateField(f('##作者：([^<]+)<##$1###'), pageScope())).toBe('张三&李四');
    expect(evaluateField(f('##<h1>([^<]+)</h1>##$1###'), pageScope())).toBe('书名甲');
    // 全局替换形态：整页原文删掉匹配后原样返回（legado 同样）
    expect(evaluateField(f('##[\\s\\S]*最近更新：|<[\\s\\S]*'), pageScope())).toBe('2026-10-01');
  });

  it('条目作用域：对元素 outerHtml 求值', () => {
    const items = evaluateFieldList(f('class.list@tag.li'), pageScope());
    expect(items).toHaveLength(2);
    const author = f('##作者:([^<]+)##$1###');
    expect(evaluateField(author, items[0])).toBe('王五');
    expect(evaluateField(author, items[1])).toBe('');
    expect(evaluateField(f('##href="([^"]+)"##$1###'), items[1])).toBe('/b/2');
  });

  it('作用域没有原文：HTML 文档序列化，JSON 条目求值失败', () => {
    expect(evaluateField(f('##<h1>([^<]+)</h1>##$1###'), createHtmlScope(PAGE, 'https://h.example/'))).toBe('书名甲');
    expect(codeOf(() => evaluateField(f('##a##b###'), createJsonScope({ a: 1 }, 'https://h.example/')))).toBe('RULE_EVAL_FAILED');
  });

  it('正文（multi）不解实体，交 content-html', () => {
    expect(evaluateField(f('##<p>作者：([^<]+)</p>##$1###'), pageScope(), true)).toBe('张三&amp;李四');
  });

  it('JS 链正则段同样按 replaceFirst', async () => {
    await preloadJsSandbox();
    const field = parseFieldRule('<js>result + "|作者：甲|作者：乙"</js>##作者：(\\S)##$1###', { ...ON, jsEnabled: true, field: 'ruleBookInfo.author' });
    const scope = createScope(normalizeBody('x'), 'https://h.example/');
    expect(evaluateField(field, scope)).toBe('甲');
    const offField = parseFieldRule('<js>result + "|作者：甲|作者：乙"</js>##作者：(\\S)##$1###', { ...OFF, jsEnabled: true, field: 'ruleBookInfo.author' });
    expect(evaluateField(offField, scope)).toBe('x|甲|乙');
  });
});
