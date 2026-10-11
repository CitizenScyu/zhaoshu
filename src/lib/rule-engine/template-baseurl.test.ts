import { describe, expect, it } from 'vitest';
import { parseFieldRule, parseRule } from './parse';
import { createHtmlScope, createJsonScope, evaluateField } from './evaluate';
import { RuleEngineError } from './types';

// tocfix：引擎窄支持 {{baseUrl}} 模板变量。
//
// 为什么需要：chuangshi.qq.com# 的 ruleBookInfo.tocUrl 是 JS 模板
// `{{baseUrl.replace(/detail/,"chapter")}}`，JS 模板被编译期拒 → 字段 skipped →
// 求值空 → 调用方回退详情页（无目录）。本口子只放行 `{{baseUrl}}` 这一种模板变量，
// 使引擎语法下的等价改写可用：
//   ruleBookInfo.tocUrl = {{baseUrl}}##/detail/##/chapter/
//
// legado 语义对照：legado 的 BaseAnalysis/AnalyzeUrl 展开规则时把内置变量 `baseUrl`
// 替换为**当前页 URL 字符串**（非对象、非表达式），故引擎侧取 scope.pageUrl。
// JS 求值（baseUrl.replace(...)）不在本口内，仍编译期拒。

const DETAIL_URL = 'https://chuangshi.qq.com/detail/35089307';

function evalOnHtml(rule: string, pageUrl: string, html = '<html><body><div class="x">正文</div></body></html>'): string {
  return evaluateField(parseFieldRule(rule), createHtmlScope(html, pageUrl));
}

// ---- c1：{{baseUrl}} 单独 → 渲染为 pageUrl ----
describe('c1 {{baseUrl}} 单独渲染为当前页 URL', () => {
  it('编译为 template（var part，非 text）', () => {
    expect(parseRule('{{baseUrl}}')).toEqual({ kind: 'template', parts: [{ kind: 'var', name: 'baseUrl' }] });
  });

  it('html scope 求值 = pageUrl', () => {
    expect(evalOnHtml('{{baseUrl}}', DETAIL_URL)).toBe(DETAIL_URL);
  });

  it('带首尾空白的 {{ baseUrl }} 也放行（trim 后恰为 baseUrl）', () => {
    expect(parseRule('{{ baseUrl }}')).toEqual({ kind: 'template', parts: [{ kind: 'var', name: 'baseUrl' }] });
  });

  it('pageUrl 换成别的页时跟着换（证明取的是 scope.pageUrl 而非常量）', () => {
    expect(evalOnHtml('{{baseUrl}}', 'https://example.com/chapter/9')).toBe('https://example.com/chapter/9');
  });
});

// ---- c2：{{baseUrl}}##/detail/##/chapter/ → detail 页 URL 变 chapter 页 URL ----
describe('c2 {{baseUrl}} + ## 正则尾缀（chuangshi 等价改写）', () => {
  const RULE = '{{baseUrl}}##/detail/##/chapter/';

  it('编译：template(var) + field.regex 尾缀都在', () => {
    expect(parseFieldRule(RULE)).toEqual({
      rules: [{ kind: 'template', parts: [{ kind: 'var', name: 'baseUrl' }] }],
      regex: [{ pattern: '/detail/', replacement: '/chapter/', flags: undefined }],
    });
  });

  it('求值：detail → chapter', () => {
    expect(evalOnHtml(RULE, DETAIL_URL)).toBe('https://chuangshi.qq.com/chapter/35089307');
  });

  it('只替换首个（无 g flag 时 ## 尾缀按既有语义，//m → //www 形态见 dialects fixture）', () => {
    expect(evalOnHtml('{{baseUrl}}##//m##//www', 'https://m.example.com/toc/1')).toBe('https://www.example.com/toc/1');
  });
});

// ---- c3（反向/安全）：JS 模板仍必须被拒 ----
describe('c3 反向：{{baseUrl.replace(...)}} 等 JS 模板仍编译期拒', () => {
  const jsRules = [
    '{{baseUrl.replace(/detail/,"chapter")}}',
    "{{baseUrl.replace('?paging=0','')}}/{{$.chapter_id}}",
    '{{baseUrl.match(/(\\d+)/)[1]}}',
    '{{baseUrl.toUpperCase()}}',
  ];

  it.each(jsRules)('%s → RULE_UNSUPPORTED / unsupported_template_js', (rule) => {
    let caught: unknown;
    try {
      parseFieldRule(rule);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuleEngineError);
    expect((caught as RuleEngineError).code).toBe('RULE_UNSUPPORTED');
    expect((caught as RuleEngineError).diagnostic).toMatchObject({ code: 'unsupported_template_js' });
  });

  it('整串扫描入口也拒（rejectUnsupportedConstructs 先行，编译期不会先落到 var 分支）', () => {
    expect(() => parseFieldRule('{{baseUrl.replace(/detail/,"chapter")}}')).toThrowError(
      expect.objectContaining({ diagnostic: { code: 'unsupported_template_js' } }),
    );
  });
});

// ---- c4：其余 {{变量}} 照旧拒 ----
describe('c4 其余 {{变量}} 仍按 tpl_var 拒', () => {
  it.each([
    '{{result}}',
    '{{book}}',
    '{{book.title}}',
    '{{chapter.title}}',
    '{{headerMap}}',
    'x{{baseUrl2}}y',
    '{{BaseUrl}}',
    '{{base_url}}',
  ])('%s → RULE_UNSUPPORTED / unsupported_template_var', (rule) => {
    expect(() => parseFieldRule(rule)).toThrowError(
      expect.objectContaining({ diagnostic: { code: 'unsupported_template_var' } }),
    );
  });
});

// ---- c5：既有 jsonpath 模板行为不变 ----
describe('c5 jsonpath 模板 {{$.x}} 行为不变', () => {
  it('IR 形态不变（literal + jsonpath 段）', () => {
    expect(parseRule('https://api.x.com/book/{{$.book_id}}')).toMatchObject({
      kind: 'template',
      parts: [{ kind: 'literal', text: 'https://api.x.com/book/' }, { kind: 'jsonpath' }],
    });
  });

  it('json scope 求值不变', () => {
    const scope = createJsonScope({ book_id: '77' }, 'https://api.x.com/s');
    expect(evaluateField(parseFieldRule('https://api.x.com/book/{{$.book_id}}'), scope))
      .toBe('https://api.x.com/book/77');
  });

  it('json scope 下 {{baseUrl}} 取 pageUrl（与输入类型无关，与 legado 一致）', () => {
    const scope = createJsonScope({ x: 1 }, DETAIL_URL);
    expect(evaluateField(parseFieldRule('{{baseUrl}}'), scope)).toBe(DETAIL_URL);
  });

  it('json scope 下 baseUrl 与 jsonpath 混排可行', () => {
    const scope = createJsonScope({ chapter_id: 9 }, 'https://api.x.com/base?q=1');
    expect(evaluateField(parseFieldRule('{{baseUrl}}/c/{{$.chapter_id}}'), scope))
      .toBe('https://api.x.com/base?q=1/c/9');
  });
});

// ---- c6：html scope 下含 jsonpath 段的模板仍 evalFailed ----
describe('c6 html scope 下 jsonpath 段模板仍 RULE_EVAL_FAILED', () => {
  it('纯 jsonpath 模板在 html scope 抛错', () => {
    expect(() => evalOnHtml('https://api.x.com/book/{{$.book_id}}', DETAIL_URL)).toThrowError(
      expect.objectContaining({ code: 'RULE_EVAL_FAILED' }),
    );
  });

  it('baseUrl + jsonpath 混排（含 var 段）在 html scope 也抛错——窄口子不放宽 jsonpath', () => {
    expect(() => evalOnHtml('{{baseUrl}}/c/{{$.chapter_id}}', DETAIL_URL)).toThrowError(
      expect.objectContaining({ code: 'RULE_EVAL_FAILED' }),
    );
  });
});

// ---- c7：编译层共用，非 tocUrl 字段同样放行 ----
describe('c7 编译层共用：非 tocUrl 字段同样放行', () => {
  it('ruleSearch.bookUrl 形态 {{baseUrl}}/x 可编译', () => {
    expect(parseFieldRule('{{baseUrl}}/search')).toEqual({
      rules: [{ kind: 'template', parts: [{ kind: 'var', name: 'baseUrl' }, { kind: 'literal', text: '/search' }] }],
    });
  });

  it('{{baseUrl}} 与 {{baseUrl}}##regex## 的裸 @baseUrl 具名属性口径不受影响（@baseUrl 仍拒）', () => {
    expect(() => parseFieldRule('@baseUrl')).toThrowError(
      expect.objectContaining({ diagnostic: { code: 'unsupported_special_var' } }),
    );
  });
});