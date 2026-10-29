// tplhash1029：首个 `##` 落在 `{{…}}` 内的规则走 legado makeUp（ENGINE_SYNTAX_TEMPLATE_HASH）——模板内的 `##` 归内层规则。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { engineSourceRevision, sourceUsesTemplateHashSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { parseFieldRule, ruleHashInTemplate } from './parse';
import { ENGINE_SEMANTICS_TEMPLATE_HASH_BIT, engineSemanticsVersion, engineSyntaxTemplateHashEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成模板验证不能访问数据库'); } }));

const SITE = 'https://cc53.test';
const opts = { orEnabled: true, regexEnabled: true, andEnabled: true, jsonPathEnabled: true };
const on = (rule: string, field = 'ruleSearch.bookUrl') => parseFieldRule(rule, { ...opts, field, templateHashEnabled: true });
const off = (rule: string, field = 'ruleSearch.bookUrl') => parseFieldRule(rule, { ...opts, field, templateHashEnabled: false });
const JSON_PAGE = JSON.stringify({ data: { books: [{ title: '甲', docId: 'x_b1', tag: '仙侠\n完本' }, { title: '乙', docId: 'x_b2', tag: '都市' }] } });
const item = () => evaluateFieldList(parseFieldRule('$.data.books[*]', { ...opts, field: 'ruleSearch.bookList' }),
  createScope(normalizeBody(JSON_PAGE), `${SITE}/s`))[0];

describe('开关', () => {
  it('engineSyntaxTemplateHashEnabled 严格口径', () => {
    expect(engineSyntaxTemplateHashEnabled({})).toBe(false);
    expect(engineSyntaxTemplateHashEnabled({ ENGINE_SYNTAX_TEMPLATE_HASH: '0' })).toBe(false);
    expect(engineSyntaxTemplateHashEnabled({ ENGINE_SYNTAX_TEMPLATE_HASH: 'yes' })).toBe(false);
    expect(engineSyntaxTemplateHashEnabled({ ENGINE_SYNTAX_TEMPLATE_HASH: ' On ' })).toBe(true);
    expect(engineSyntaxTemplateHashEnabled({ ENGINE_SYNTAX_TEMPLATE_HASH: '1' })).toBe(true);
  });

  it('语义位 2^37，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_TEMPLATE_HASH_BIT).toBe(137438953472);
    const f = false;
    const flags = (prefix: boolean, hash: boolean) => engineSemanticsVersion(
      f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, prefix, hash);
    expect(flags(false, true) - flags(false, false)).toBe(137438953472);
    expect(flags(true, true) - flags(true, false)).toBe(137438953472);
  });
});

describe('编译与求值', () => {
  it('URL 里的 {{规则##正则}}：on 内层规则带正则、拼出整条链接；off 模板被切开', () => {
    const rule = `${SITE}/b?id={{$.docId##.*_}}&c=1`;
    expect(on(rule).makeUp?.regexMode).toBe(true);
    expect(evaluateField(on(rule), item())).toBe(`${SITE}/b?id=b1&c=1`);
    expect(off(rule).makeUp).toBeUndefined();
    expect(evaluateField(off(rule), item())).not.toBe(`${SITE}/b?id=b1&c=1`);
  });

  it('多个模板拼接，内层 && 与 ## 替换', () => {
    const rule = '{{$.title}}{{$.tag##\\n##•}}';
    expect(evaluateField(on(rule, 'ruleSearch.name'), item())).toBe('甲仙侠•完本');
    expect(evaluateField(on('{{$.title&&$.docId##_##-}}', 'ruleSearch.name'), item())).toBe('甲\nx-b1');
  });

  it('## 在模板外、无模板、非自取字段、JS 规则：两态 IR 相同', () => {
    for (const [rule, field] of [
      ['x{{$.title}}y##z', 'ruleSearch.bookUrl'], ['{{$.title}}##甲', 'ruleSearch.name'], ['$.title##甲', 'ruleSearch.name'],
      ['{{$.tag##\\n##,}}', 'ruleSearch.kind'], ['{{$.tag##\\n##,}}', 'ruleBookInfo.intro'],
    ] as const) {
      expect(on(rule, field)).toEqual(off(rule, field));
    }
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成模板源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: '$.data.books[*]', name: '$.title', bookUrl: `${SITE}/b?id={{$.docId##.*_}}` },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const seen: string[] = [];
  const run = () => searchAdmission(raw, {
    fetchPage: async (url: string) => {
      seen.push(url);
      return new Response(JSON_PAGE, { headers: { 'Content-Type': 'application/json' } });
    },
    declaredHosts: new Set(['cc53.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 候选链接是拼好的整条 URL', async () => {
    vi.stubEnv('ENGINE_SYNTAX_TEMPLATE_HASH', '1');
    const out = await run();
    expect(out).toMatchObject({ verdict: 'ok', candidateCount: 2 });
    expect(JSON.stringify(out)).not.toContain('{{');
  });
});

describe('语义位判据', () => {
  it('ruleHashInTemplate：首个 ## 被某个 {{…}} 包住', () => {
    expect(ruleHashInTemplate('u{{$.a##x}}')).toBe(true);
    expect(ruleHashInTemplate('{{$.a}}{{$.b##x}}##y')).toBe(true);
    expect(ruleHashInTemplate('u{{$.a}}##x')).toBe(false);
    expect(ruleHashInTemplate('a##{{$.b}}')).toBe(false);
    expect(ruleHashInTemplate('{{$.a')).toBe(false);
    expect(ruleHashInTemplate('$.a')).toBe(false);
  });

  it('只有搜索 name/author/bookUrl 计位；开关关不计', () => {
    const mk = (search: Record<string, string>, toc: Record<string, string> = {}) => ({
      url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: { ruleSearch: { bookList: '$.list', name: '$.n', bookUrl: '$.u', ...search }, ruleToc: toc },
    });
    const hit = mk({ bookUrl: `${SITE}/b?id={{$.docId##.*_}}` });
    const tocOnly = mk({ kind: '{{$.k##\\n##,}}' }, { chapterUrl: '{{$.id##_}}' });
    expect(sourceUsesTemplateHashSyntax(hit.rules)).toBe(true);
    expect(sourceUsesTemplateHashSyntax(tocOnly.rules)).toBe(false);
    const v = (s: ReturnType<typeof mk>, templateHashEnabled: boolean) => Number(engineSourceRevision(s, { templateHashEnabled }).split(':')[0]);
    expect(v(hit, true) - v(hit, false)).toBe(137438953472);
    expect(v(tocOnly, true)).toBe(v(tocOnly, false));
  });
});
