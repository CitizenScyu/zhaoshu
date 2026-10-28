// objkey1029：JS 与 ENGINE_SYNTAX_JS_BIND 同开时，宿主绑定名（book/chapter/title）作对象字面量键不算引用。规则均为合成形态。
import { describe, expect, it } from 'vitest';
import { sourceUsesJsBindSyntax } from './compile';
import { parseFieldRule } from './parse';
import { RuleEngineError } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const TOC = 'ruleToc.chapterList';
const parse = (rule: string, jsBindEnabled: boolean, field = TOC) =>
  parseFieldRule(rule, { jsEnabled: true, listJsEnabled: true, jsBindEnabled, field });
const LIST = '@js:var out = []; out.push({title: "一", url: "/1"}, { title : "二", url: "/2"}); out';

describe('对象字面量键', () => {
  it('bind 关拒、开过', () => {
    expect(codeOf(() => parse(LIST, false))).toBe('unsupported_js');
    expect(codeOf(() => parse(LIST, true))).toBeUndefined();
    expect(codeOf(() => parse('@js:[{book: 1, chapter: 2}]', true))).toBeUndefined();
  });

  it('不是键的照旧拒', () => {
    for (const code of [
      '[{title}]', // 简写是引用
      '[{a: title}]',
      '[title ? {a: 1} : {a: 2}]',
      'switch (1) { case 0, title: break; } [{title: 1}]', // 含 case 一律不认
      '[{source: 1}]', // 非宿主绑定名
      '[{a: 1, title}]',
    ]) expect(codeOf(() => parse(`@js:${code}`, true)), code).toBe('unsupported_js');
  });

  it('bind 位按源判定覆盖得到', () => {
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: true, jsExtEnabled: false,
    };
    expect(sourceUsesJsBindSyntax({ ruleToc: { chapterList: LIST } }, flags)).toBe(true);
    expect(sourceUsesJsBindSyntax({ ruleToc: { chapterList: '@js:[{a: "x"}]' } }, flags)).toBe(false);
  });
});
