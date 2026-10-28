// andor1029：组合运算符边角 —— JS 链规则段的顶层 `&&` 与 `||` 空支（挂 ENGINE_SYNTAX_JS_EXT），`&&` 首支带 `@json:` 前缀算
// Json 模式（挂 ENGINE_SYNTAX_JSON_PATH）。legado 链里每段 SourceRule 同走 RuleAnalyzer.splitRule；getStringList 对空规则返回空表。
// 规则与页面均为合成形态。
import { beforeAll, describe, expect, it } from 'vitest';
import { engineSourceRevision } from './compile';
import { createJsonScope, createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { RuleEngineError, type FieldIr } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const BASE = { orEnabled: true, xpathEnabled: true, xpathEvalEnabled: true, regexEnabled: true, andEnabled: true, jsEnabled: true } as const;
const ON = { ...BASE, jsExtEnabled: true } as const;
const OFF = { ...BASE, jsExtEnabled: false } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const off = (rule: string, field: string) => parseFieldRule(rule, { ...OFF, field });
const stage = (field: FieldIr, i = 0) => {
  const s = field.chain?.[i];
  if (s?.kind !== 'rule') throw new Error('not a rule stage');
  return s.field;
};
const PAGE_URL = 'https://h.example/book/1';
const PAGE = '<div id="a">甲</div><div id="b">乙</div><a class="toc" href="/toc/1">目录</a>';
const scope = (html = PAGE) => createScope(normalizeBody(html), PAGE_URL);
const CONTENT = 'ruleContent.content';
const TOC_URL = 'ruleBookInfo.tocUrl';

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('JS 链规则段的 &&', () => {
  it('on：按所在字段收 &&；URL 字段取首个非空支；off 照旧拒', () => {
    expect(stage(on('#a@text&&#b@text@js:result + "!"', CONTENT)).rules[0]).toMatchObject({ kind: 'and' });
    expect(stage(on('#x@href&&.toc@href@js:result', TOC_URL)).rules[0]).toMatchObject({ kind: 'and', first: true });
    expect(codeOf(() => off('#a@text&&#b@text@js:result + "!"', CONTENT))).toBe('unsupported_operator');
  });

  it('不在 AND_FIELDS 的字段、混用 || 与 && 照旧拒', () => {
    expect(codeOf(() => on('#a@href&&#b@href@js:result', 'ruleContent.nextContentUrl'))).toBe('unsupported_operator');
    expect(codeOf(() => on('#a@text&&#b@text||@js:result', CONTENT))).toBe('unsupported_operator');
  });

  it('求值：非空支按行拼接后交 JS', () => {
    expect(evaluateField(on('#a@text&&#b@text@js:result + "!"', CONTENT), scope(), true)).toBe('甲\n乙!');
  });
});

describe('JS 链规则段的 || 空支', () => {
  it('on：空支跳过（单支剩下按单段编译）；off 照旧拒', () => {
    expect(stage(on('.toc@href||@js:result || baseUrl + "/t"', TOC_URL)).rules[0]).toMatchObject({ kind: 'css' });
    expect(stage(on('#x@text||#a@text||@js:result', CONTENT)).rules[0]).toMatchObject({ kind: 'or' });
    expect(codeOf(() => off('.toc@href||@js:result', TOC_URL))).toBe('empty_or_branch');
  });

  it('剩余支有 XPath、全是空支、非 JS 规则照旧拒', () => {
    expect(codeOf(() => on('//a/@href||@js:result', TOC_URL))).toBe('empty_or_branch');
    expect(codeOf(() => on('||@js:result', TOC_URL))).toBe('empty_or_branch');
    expect(codeOf(() => on('.toc@href||', TOC_URL))).toBe('empty_or_branch');
  });

  it('求值：剩下的支命中即用，全空时交 JS 兜底', () => {
    const field = on('.toc@href||@js:result || baseUrl + "/t"', TOC_URL);
    expect(evaluateField(field, scope())).toBe('https://h.example/toc/1');
    expect(evaluateField(field, scope('<p>无</p>'))).toBe(`${PAGE_URL}/t`);
  });
});

describe('&& 首支 @json: 前缀', () => {
  const RULE = '@json:$.list[?(@.n)]&&$.hot[?(@.n)]';
  const LIST = 'ruleSearch.bookList';

  it('JSON_PATH on：整条按 Json 模式合并；off 照旧拒', () => {
    expect(parseFieldRule(RULE, { ...BASE, jsonPathEnabled: true, field: LIST }).rules[0]).toMatchObject({
      kind: 'and', branches: [{ kind: 'jsonpath' }, { kind: 'jsonpath' }],
    });
    // off：过滤器本身不认，拒因落在 JSONPath；无过滤器的同形规则拒在 &&
    expect(codeOf(() => parseFieldRule(RULE, { ...BASE, jsonPathEnabled: false, field: LIST }))).toBe('unsupported_jsonpath');
    expect(codeOf(() => parseFieldRule('@json:$.list[*]&&$.hot[*]', { ...BASE, jsonPathEnabled: false, field: LIST }))).toBe('unsupported_operator');
    expect(codeOf(() => parseFieldRule('@json:list[*]&&$.hot[*]', { ...BASE, jsonPathEnabled: true, field: LIST }))).toBe('unsupported_operator');
  });

  it('求值：JSON 条目按支序拼接', () => {
    const json = createJsonScope({ list: [{ n: '乙' }, { x: 1 }], hot: [{ n: '甲' }] }, 'https://h.example/');
    const items = evaluateFieldList(parseFieldRule(RULE, { ...BASE, jsonPathEnabled: true, field: LIST }), json);
    const name = parseFieldRule('$.n', { ...BASE, field: 'ruleSearch.name' });
    expect(items.map((item) => evaluateField(name, item))).toEqual(['乙', '甲']);
  });
});

describe('按源判定', () => {
  const src = (rules: Record<string, unknown>) => ({ url: 'https://h.example', searchUrl: '/s?q={{key}}', rules });
  const rev = (s: ReturnType<typeof src>, extra: Record<string, boolean>) => engineSourceRevision(s, { ...BASE, ...extra });

  it('JS 链 && / || 空支的源随 JS_EXT 换版本；@json: && 的源随 JSON_PATH 换版本；无关源不动', () => {
    const chainAnd = src({ ruleContent: { content: '#a@text&&#b@text@js:result' } });
    const chainOr = src({ ruleBookInfo: { tocUrl: '.toc@href||@js:result' } });
    const jsonAnd = src({ ruleSearch: { bookList: '@json:$.list[*]&&$.hot[*]', name: '$.n' } });
    const plain = src({ ruleContent: { content: '#a@text@js:result' } });
    for (const s of [chainAnd, chainOr]) expect(rev(s, { jsExtEnabled: true })).not.toBe(rev(s, { jsExtEnabled: false }));
    expect(rev(jsonAnd, { jsonPathEnabled: true })).not.toBe(rev(jsonAnd, { jsonPathEnabled: false }));
    expect(rev(plain, { jsExtEnabled: true })).toBe(rev(plain, { jsExtEnabled: false }));
    expect(rev(plain, { jsonPathEnabled: true })).toBe(rev(plain, { jsonPathEnabled: false }));
  });
});
