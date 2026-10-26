// vars1027：ENGINE_SYNTAX_VARS @put/@get 静态子集（vars-subset.ts）+ compile/准入接线 + 语义版本。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileSource, engineSourceRevision, sourceUsesVarSyntax } from './compile';
import { compileAdmission, rulesHash } from './admission';
import { engineSemanticsVersion, engineSyntaxVarsEnabled } from './syntax-flags';
import { parsePutMap, resolveSourceVars, ruleMayUseVars } from './vars-subset';
import { createHtmlScope, evaluateField } from './evaluate';
import { sourceRevision } from '@/lib/source-revision';

// 合成源（形态取自 10-27 离线统计里最常见的模板：详情页 init 只 put meta，name/author 整条 @get）。
const SRC = {
  bookSourceUrl: 'https://vars.example',
  bookSourceName: '变量测试源',
  searchUrl: '/search?q={{key}}',
  ruleSearch: { bookList: '.item', name: 'h3@text', author: '.author@text', bookUrl: 'a@href@put:{u:"a@href"}' },
  ruleBookInfo: {
    init: '@put:{n:"[property$=book_name]@content",\n\ta:\'[property$=author]@content\',\nl:"[property$=latest_chapter_name]@content"}',
    name: '@get:{n}',
    author: ' @get:{a} ',
    lastChapter: '@get:{l}',
  },
  ruleToc: { chapterList: '#list a', chapterName: '@text', chapterUrl: '@href' },
  ruleContent: { content: '#content@html' },
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('parsePutMap（GSON 宽松子集）', () => {
  it.each([
    ['{n:"a@text", a:\'b@text\'}', [['n', 'a@text'], ['a', 'b@text']]],
    ['{"n":"[property$=book_name]@content"}', [['n', '[property$=book_name]@content']]],
    ['{bid:$.book.id}', [['bid', '$.book.id']]],
    ['{ x : $..x_id , y:"q\\"r" }', [['x', '$..x_id'], ['y', 'q"r']]],
    ['{k:"\\u4e66\\n"}', [['k', '书\n']]],
    ['{}', []],
  ])('%s', (text, entries) => {
    expect([...(parsePutMap(text) ?? new Map([['__null__', '']]))]).toEqual(entries);
  });

  it.each(['', 'n:"a"', '{n "a"}', '{n:"a"', '{n:"a"} x', '{n:}', '{n:"a",,}', '{n:a/b}', '{n:"a\\u12"}'])('拒：%s', (text) => {
    expect(parsePutMap(text)).toBeNull();
  });
});

describe('resolveSourceVars 改写', () => {
  it('剥各组 @put；详情页 init put → 同组整条 @get 内联（两侧空白容忍）；init 本身剥空', () => {
    const out = resolveSourceVars(SRC);
    expect(out.ruleSearch.bookUrl).toBe('a@href');
    expect(out.ruleBookInfo).toEqual({
      init: '',
      name: '[property$=book_name]@content',
      author: '[property$=author]@content',
      lastChapter: '[property$=latest_chapter_name]@content',
    });
    expect(out.ruleToc).toBe(SRC.ruleToc); // 不涉及变量的组原样
  });

  it('不改入参；不涉及变量的源返回同一对象', () => {
    const before = JSON.stringify(SRC);
    resolveSourceVars(SRC);
    expect(JSON.stringify(SRC)).toBe(before);
    const plain = { ...SRC, ruleSearch: { ...SRC.ruleSearch, bookUrl: 'a@href' }, ruleBookInfo: { name: 'h1@text' } };
    expect(resolveSourceVars(plain)).toBe(plain);
  });

  it('子集外不内联、残留 @get：init 带剩余规则 / put 解析失败 / 键缺失 / 内置键 / 非整条 / 跨阶段', () => {
    const variant = (bookInfo: Record<string, string>, extra: Record<string, unknown> = {}) =>
      resolveSourceVars({ ...SRC, ruleBookInfo: bookInfo, ...extra }) as typeof SRC & Record<string, Record<string, string>>;
    expect(variant({ init: '.box@put:{n:"h1@text"}', name: '@get:{n}' }).ruleBookInfo.name).toBe('@get:{n}');
    expect(variant({ init: '@put:{n:a/b}', name: '@get:{n}' }).ruleBookInfo.name).toBe('@get:{n}');
    expect(variant({ init: '@put:{n:"h1@text"}', name: '@get:{m}' }).ruleBookInfo.name).toBe('@get:{m}');
    expect(variant({ init: '@put:{bookName:"h1@text"}', name: '@get:{bookName}' }).ruleBookInfo.name).toBe('@get:{bookName}');
    expect(variant({ init: '@put:{n:"h1@text"}', name: '@get:{n}##书名：' }).ruleBookInfo.name).toBe('@get:{n}##书名：');
    const cross = variant({ name: 'h1@text@put:{bid:"[data-id]@data-id"}' }, {
      ruleToc: { chapterList: '#list a', chapterName: '@text', chapterUrl: '/read/@get:{bid}/{{$.id}}' },
    });
    expect(cross.ruleBookInfo.name).toBe('h1@text');
    expect(cross.ruleToc.chapterUrl).toBe('/read/@get:{bid}/{{$.id}}');
  });

  it('多个 put 块依次合并、后者覆盖前者（同 legado 依次 put）', () => {
    const out = resolveSourceVars({ ruleBookInfo: { init: '@put:{n:"a@text",a:"b@text"}\n@PUT:{n:"c@text"}', name: '@get:{n}', author: '@get:{a}' } });
    expect(out.ruleBookInfo).toMatchObject({ name: 'c@text', author: 'b@text' });
  });
});

describe('开关与语义版本', () => {
  it('engineSemanticsVersion：1–4 不变，变量位 +4 → 5–8', () => {
    expect([engineSemanticsVersion(false), engineSemanticsVersion(true), engineSemanticsVersion(false, true), engineSemanticsVersion(true, true)]).toEqual([1, 2, 3, 4]);
    expect([
      engineSemanticsVersion(false, false, true), engineSemanticsVersion(true, false, true),
      engineSemanticsVersion(false, true, true), engineSemanticsVersion(true, true, true),
    ]).toEqual([5, 6, 7, 8]);
  });

  it('engineSyntaxVarsEnabled 严格口径', () => {
    for (const on of ['1', 'true', 'on', ' ON ']) expect(engineSyntaxVarsEnabled({ ENGINE_SYNTAX_VARS: on })).toBe(true);
    for (const off of [undefined, '', '0', 'false', 'yes']) expect(engineSyntaxVarsEnabled({ ENGINE_SYNTAX_VARS: off })).toBe(false);
  });

  it('ruleMayUseVars / sourceUsesVarSyntax', () => {
    expect(ruleMayUseVars('a@href@put:{u:"a@href"}')).toBe(true);
    expect(ruleMayUseVars('@GET:{n}')).toBe(true);
    expect(ruleMayUseVars('a@href')).toBe(false);
    expect(sourceUsesVarSyntax(SRC as unknown as Record<string, unknown>)).toBe(true);
  });

  it('按源判定：只有含 @put/@get 的源在开关 on 时加变量位，其余源 identity 不变', () => {
    const vars = { url: SRC.bookSourceUrl, searchUrl: SRC.searchUrl, rules: SRC as unknown as Record<string, unknown> };
    const plainRules = { ...SRC, ruleSearch: { ...SRC.ruleSearch, bookUrl: 'a@href' }, ruleBookInfo: { name: 'h1@text' } };
    const plain = { url: SRC.bookSourceUrl, searchUrl: SRC.searchUrl, rules: plainRules as unknown as Record<string, unknown> };
    const on = { orEnabled: true, xpathEnabled: true, varsEnabled: true };
    expect(engineSourceRevision(plain, on)).toBe(`1:${sourceRevision(plain)}`);
    expect(engineSourceRevision(vars, { ...on, varsEnabled: false })).toBe(`1:${sourceRevision(vars)}`);
    expect(engineSourceRevision(vars, on)).toBe(`5:${sourceRevision(vars)}`);
  });
});

describe('compile / 准入接线', () => {
  const engineSource = { url: SRC.bookSourceUrl, searchUrl: SRC.searchUrl, rules: SRC as unknown as Record<string, unknown> };

  it('compileSource：off 时 @get/@put 字段 skipped；on 时内联后可编译，两态缓存互不污染', () => {
    const off = compileSource(engineSource, { varsEnabled: false });
    const on = compileSource(engineSource, { varsEnabled: true });
    expect(off.get('ruleBookInfo.name')).toEqual({ skipped: 'unsupported' });
    expect(off.get('ruleSearch.bookUrl')).toEqual({ skipped: 'unsupported' });
    expect(on.get('ruleBookInfo.name')).not.toHaveProperty('skipped');
    expect(on.get('ruleSearch.bookUrl')).not.toHaveProperty('skipped');
    expect(on.get('ruleBookInfo.init')).toBeUndefined(); // 剥空 = 字段不在
    expect(compileSource(engineSource, { varsEnabled: false })).toBe(off);
  });

  it('内联后在详情页上求值与 legado put→get 同值', () => {
    const page = createHtmlScope(`<html><head><meta property="og:novel:book_name" content="书名甲">
<meta property="og:novel:author" content="作者乙"><meta property="og:novel:latest_chapter_name" content="第九章"></head><body></body></html>`, 'https://vars.example/b/1');
    const on = compileSource(engineSource, { varsEnabled: true });
    const value = (name: string) => evaluateField(on.get(name) as Parameters<typeof evaluateField>[0], page);
    expect([value('ruleBookInfo.name'), value('ruleBookInfo.author'), value('ruleBookInfo.lastChapter')]).toEqual(['书名甲', '作者乙', '第九章']);
  });

  it('compileAdmission / rulesHash 读 env：off 拒 @get，on 通过且版本前缀为 5', () => {
    vi.stubEnv('ENGINE_SYNTAX_OR', '0');
    vi.stubEnv('ENGINE_SYNTAX_XPATH', '0');
    vi.stubEnv('ENGINE_SYNTAX_VARS', '0');
    const off = compileAdmission(SRC);
    expect(off.ok).toBe(false);
    expect(off.reason).toContain('@get');
    expect(rulesHash(SRC).startsWith('1:')).toBe(true);
    vi.stubEnv('ENGINE_SYNTAX_VARS', '1');
    expect(compileAdmission(SRC)).toMatchObject({ ok: true });
    expect(rulesHash(SRC).startsWith('5:')).toBe(true);
  });

  it('on 时跨阶段 @get 照旧拒（目录 chapterUrl 引用搜索页 put）', () => {
    vi.stubEnv('ENGINE_SYNTAX_VARS', '1');
    const cross = { ...SRC, ruleToc: { ...SRC.ruleToc, chapterUrl: '/read/@get:{u}/1.html' } };
    const res = compileAdmission(cross);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('ruleToc.chapterUrl');
  });
});
