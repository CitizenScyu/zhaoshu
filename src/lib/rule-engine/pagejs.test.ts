// pagejs1029：详情页 name/author/tocUrl 首段 JS 不读 result/src 时挂 detached（ENGINE_SYNTAX_PAGE_DETACHED）——init 收窄后作用域
// 没有页面原文，以空串起链；legado 那里 result 是 init 结果，代码不读它则产出相同。规则与页面均为合成形态。
import { beforeAll, describe, expect, it } from 'vitest';
import { compileSource } from './compile';
import { createScope, evaluateField, evaluateInitScope, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { engineSyntaxPageDetachedEnabled } from './syntax-flags';
import { RuleEngineError, type FieldIr } from './types';

const SITE = 'https://h.example';
const BOOK_URL = `${SITE}/book/1`;
const BASE = { jsEnabled: true, jsExtEnabled: true, jsonPathEnabled: true, regexEnabled: true } as const;
const on = (rule: string, field = 'ruleBookInfo.tocUrl', extra: ParseOptions = {}) =>
  parseFieldRule(rule, { ...BASE, ...extra, field, pageDetachedEnabled: true });
const off = (rule: string, field = 'ruleBookInfo.tocUrl') => parseFieldRule(rule, { ...BASE, field, pageDetachedEnabled: false });
const firstDetached = (field: FieldIr) => field.chain?.[0]?.kind === 'js' && field.chain[0].detached === true;
const scopeOf = (text: string) => createScope(normalizeBody(text), BOOK_URL);
const initOf = (init: string) => {
  const entry = compileSource({
    url: SITE, searchUrl: `${SITE}/s?q={{key}}`,
    rules: { ruleSearch: { bookList: '.b', name: 'a@text', bookUrl: 'a@href' }, ruleBookInfo: { init } },
  }, { initEnabled: true, jsonPathEnabled: true }).get('ruleBookInfo.init');
  if (!entry || 'skipped' in entry) throw new Error('fixture init did not compile');
  return entry;
};
const errOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? 'engine' : `non-engine:${String(err)}`;
  }
};

const JSON_PAGE = JSON.stringify({ code: 0, data: { bid: '7', name: '书' } });
const HTML_PAGE = '<h1>站点</h1><div class="info"><a class="toc" href="/toc/1.html">目录</a></div>';

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('开关', () => {
  it('engineSyntaxPageDetachedEnabled 严格口径', () => {
    expect(engineSyntaxPageDetachedEnabled({})).toBe(false);
    expect(engineSyntaxPageDetachedEnabled({ ENGINE_SYNTAX_PAGE_DETACHED: '0' })).toBe(false);
    expect(engineSyntaxPageDetachedEnabled({ ENGINE_SYNTAX_PAGE_DETACHED: 'yes' })).toBe(false);
    expect(engineSyntaxPageDetachedEnabled({ ENGINE_SYNTAX_PAGE_DETACHED: ' On ' })).toBe(true);
    expect(engineSyntaxPageDetachedEnabled({ ENGINE_SYNTAX_PAGE_DETACHED: '1' })).toBe(true);
  });
});

describe('编译挂位', () => {
  it('详情页 name/author/tocUrl 首段 JS 不读输入才挂', () => {
    for (const field of ['ruleBookInfo.name', 'ruleBookInfo.author', 'ruleBookInfo.tocUrl']) {
      expect(firstDetached(on('@js:"/toc?bid={{$.bid}}"', field))).toBe(true);
      expect(firstDetached(on('<js>"甲"</js>', field))).toBe(true);
      expect(firstDetached(off('@js:"甲"', field))).toBe(false);
    }
    expect(firstDetached(on('@js:result + "x"'))).toBe(false);
    expect(firstDetached(on('@js:src.length'))).toBe(false);
    expect(firstDetached(on('@js:"{{result}}"'))).toBe(false); // `{{JS}}` 以上一段结果为 result
  });

  it('其余字段、非首段、JS_EXT 关都不挂', () => {
    expect(firstDetached(on('@js:"甲"', 'ruleContent.content'))).toBe(false);
    expect(firstDetached(on('@js:"甲"', 'ruleToc.nextTocUrl'))).toBe(false);
    expect(on('a@href@js:"甲"').chain?.[1]).toEqual({ kind: 'js', code: '"甲"' });
    expect(firstDetached(on('@js:"甲"', 'ruleBookInfo.tocUrl', { jsExtEnabled: false }))).toBe(false);
  });
});

describe('求值', () => {
  it('JSON init 收窄后：on 以空串起链、模板占位在 init 结果上取值；off 求值失败', () => {
    const info = evaluateInitScope(initOf('$.data'), scopeOf(JSON_PAGE));
    expect(evaluateField(on('@js:"/toc?bid={{$.bid}}"'), info)).toBe('/toc?bid=7');
    expect(errOf(() => evaluateField(off('@js:"/toc?bid={{$.bid}}"'), info))).toBe('engine');
    expect(errOf(() => evaluateField(on('@js:result + "x"'), info))).toBe('engine'); // 读输入的照旧失败
  });

  it('HTML init 收窄后同样起链；后续规则段照旧在 JS 结果上求值', () => {
    const info = evaluateInitScope(initOf('class.info'), scopeOf(HTML_PAGE));
    expect(evaluateField(on('@js:"{{@@a.toc@href}}"'), info)).toBe(`${SITE}/toc/1.html`);
    expect(evaluateField(on('<js>"甲乙"</js>##乙'), info)).toBe('甲');
    expect(errOf(() => evaluateField(off('@js:"{{@@a.toc@href}}"'), info))).toBe('engine');
  });

  it('作用域有页面原文时原文优先，on/off 逐字相同', () => {
    const page = scopeOf(HTML_PAGE);
    for (const rule of ['@js:"{{@@a.toc@href}}"', '<js>"甲"</js>', '@js:"x" + "y"']) {
      expect(evaluateField(on(rule), page)).toBe(evaluateField(off(rule), page));
    }
  });
});
