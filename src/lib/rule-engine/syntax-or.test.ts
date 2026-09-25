// P1a || 组合子测试（task-syntax-p1a 验收矩阵）：
//  1) 开关 off：与旧 parser 逐字一致（|| 拒绝、诊断 unsupported_operator）；
//  2) 开关 on：tokenizer 切支 / OrNode / 转义 / 括号引号花括号 / 恶意分支预算；
//  3) 求值：空值短路、节点与标量不压扁、净化（##）在组合后生效、异常不吞；
//  4) 语义版本：engineSyntaxOrEnabled / engineSemanticsVersion / 缓存键联动；
//  5) 影子求值：off 态对照可跑、不改准入、开关 on 时拒绝冒充。
import { describe, expect, it } from 'vitest';
import { parseFieldRule, tokenizeOrBranches } from './parse';
import { RuleEngineError, MAX_OR_BRANCHES } from './types';
import {
  createHtmlScope, createJsonScope, evaluateField, evaluateFieldNodes, insideNode,
} from './evaluate';
import { compileSource, engineVersionedKey } from './compile';
import {
  engineSemanticsVersion, engineSyntaxOrEnabled, ENGINE_SEMANTICS_VERSION, ENGINE_SEMANTICS_VERSION_OR,
} from './syntax-flags';
import { shadowEvaluateSource } from './shadow-eval';

const on = { orEnabled: true } as const;
const field = (rule: string) => parseFieldRule(rule, on);

// ---------------------------------------------------------------- 开关矩阵
describe('ENGINE_SYNTAX_OR 开关', () => {
  it('默认 off（env 缺失）：engineSyntaxOrEnabled=false，|| 仍拒绝且诊断码不变', () => {
    expect(engineSyntaxOrEnabled({})).toBe(false);
    expect(engineSyntaxOrEnabled({ ENGINE_SYNTAX_OR: '' })).toBe(false);
    expect(engineSyntaxOrEnabled({ ENGINE_SYNTAX_OR: '0' })).toBe(false);
    expect(engineSyntaxOrEnabled({ ENGINE_SYNTAX_OR: 'false' })).toBe(false);
    expect(engineSyntaxOrEnabled({ ENGINE_SYNTAX_OR: 'yes' })).toBe(false); // 宽松词不认
    expect(() => parseFieldRule('a@text||b@text')).toThrowError(expect.objectContaining({
      code: 'RULE_UNSUPPORTED',
      diagnostic: { code: 'unsupported_operator', operator: '||' },
    }));
  });

  it('显式 1/true/on 才开', () => {
    expect(engineSyntaxOrEnabled({ ENGINE_SYNTAX_OR: '1' })).toBe(true);
    expect(engineSyntaxOrEnabled({ ENGINE_SYNTAX_OR: 'TRUE' })).toBe(true);
    expect(engineSyntaxOrEnabled({ ENGINE_SYNTAX_OR: ' On ' })).toBe(true);
  });

  it('off 态 parseFieldRule()（不传 options）与旧 parser 逐字一致——快照口径回归', () => {
    // 旧 M1 断言（parse.test.ts「顶层 || → RULE_UNSUPPORTED」同款规则文本）
    for (const rule of ['tag.a@href||href', 'a@text||b@text', 'a||b||c']) {
      let err: unknown;
      try { parseFieldRule(rule); } catch (e) { err = e; }
      expect(err, rule).toBeInstanceOf(RuleEngineError);
      const re = err as RuleEngineError;
      expect(re.diagnostic).toEqual({ code: 'unsupported_operator', operator: '||' });
      expect(re.message).toBe('规则含顶层 ||（T7）');
    }
  });

  it('语义版本联动：off=1（P0 基线），on=2；engineVersionedKey 缓存键随之失效', () => {
    expect(ENGINE_SEMANTICS_VERSION).toBe(1);
    expect(ENGINE_SEMANTICS_VERSION_OR).toBe(2);
    expect(engineSemanticsVersion(false)).toBe(1);
    expect(engineSemanticsVersion(true)).toBe(2);
    expect(engineVersionedKey('rev', 1)).not.toBe(engineVersionedKey('rev', 2));
    expect(engineVersionedKey('rev', 1)).toBe('1:rev');
    expect(engineVersionedKey('rev', 2)).toBe('2:rev');
  });
});

// ---------------------------------------------------------------- tokenizer
describe('P1a tokenizer（tokenizeOrBranches）', () => {
  it('顶层 || 切支；括号/引号内不切（旧 splitTopLevel 语义保持）', () => {
    expect(tokenizeOrBranches('a@text||b@text||c@text')).toEqual(['a@text', 'b@text', 'c@text']);
    expect(tokenizeOrBranches('a:has(x||y)@text')).toEqual(['a:has(x||y)@text']);
    expect(tokenizeOrBranches("a[x='p||q']@text")).toEqual(["a[x='p||q']@text"]);
  });

  it('花括号（JSONPath filter / {{}} 模板）内 || 不切（RuleAnalyzer 代码块感知，§3.7）', () => {
    expect(tokenizeOrBranches('$.a[?(@.x==1||@.y==2)]||$.b')).toEqual(['$.a[?(@.x==1||@.y==2)]', '$.b']);
    expect(tokenizeOrBranches('{{$..a}}||b')).toEqual(['{{$..a}}', 'b']);
  });

  it('反斜杠转义：\\| 后的 || 不构成操作符（§3.7 反斜杠感知）', () => {
    // `a\||b`：`\|` 是转义竖线，只剩单个 `|` → 不是 || 操作符，整串不切分。
    expect(tokenizeOrBranches('a\\||b')).toEqual(['a\\||b']);
    // `a\\||b`（`\\` 转义反斜杠本体）后的 `||` 仍是操作符 → 切分。
    expect(tokenizeOrBranches('a\\\\||b')).toEqual(['a\\\\', 'b']);
    expect(tokenizeOrBranches('a||b')).toEqual(['a', 'b']);
  });

  it('未配对括号宽容（不炸、不把括号内内容切出去）', () => {
    expect(tokenizeOrBranches('a(unclosed||b')).toEqual(['a(unclosed||b']);
  });
});

// ---------------------------------------------------------------- on 态编译
describe('on 态编译：OrNode 与防御预算', () => {
  it('a@text||b@text → rules:[{kind:"or", branches:[css×2]}]', () => {
    expect(parseFieldRule('a@text||b@text', on)).toEqual({
      rules: [{ kind: 'or', branches: [
        { kind: 'css', chain: [{ selector: 'a' }], terminal: { op: 'text' } },
        { kind: 'css', chain: [{ selector: 'b' }], terminal: { op: 'text' } },
      ] }],
    });
  });

  it('## 净化尾缀剥在组合层（legado 顺序：先组合后净化，§3.2/§3.7）', () => {
    const ir = parseFieldRule('a@text||b@text##言情|都市', on);
    expect(ir.rules).toHaveLength(1);
    expect(ir.rules[0].kind).toBe('or');
    expect(ir.regex).toEqual([{ pattern: '言情|都市', replacement: '', flags: undefined }]);
  });

  it('嵌套（支内括号里的 ||）不被切开；混合符号 &&/%% 仍拒（§5.1 不猜）', () => {
    expect(parseFieldRule('a:has(x||y)@text', on).rules[0].kind).toBe('css');
    for (const [rule, operator] of [
      ['a@text&&b@text', '&&'],
      ['a@text||b@text&&c@text', '&&'],
      ['.l@text%%.c@title', '%%'],
    ] as const) {
      expect(() => parseFieldRule(rule, on), rule).toThrowError(expect.objectContaining({
        diagnostic: { code: 'unsupported_operator', operator },
      }));
    }
  });

  it('后支非法构件不被前支掩盖：所有支都编译（§5.1）', () => {
    expect(() => parseFieldRule('a@text||b@get:{x}', on)).toThrowError(expect.objectContaining({
      diagnostic: { code: 'unsupported_var_get' },
    }));
    expect(() => parseFieldRule('a@text||{{book.name}}', on)).toThrowError(expect.objectContaining({
      diagnostic: { code: 'unsupported_template_var' },
    }));
    expect(() => parseFieldRule('a@text||@js:x', on)).toThrowError(expect.objectContaining({
      diagnostic: { code: 'unsupported_js' },
    }));
  });

  it('空支显式拒绝（a|| 不猜「跳过空支」语义）', () => {
    expect(() => parseFieldRule('a@text||', on)).toThrowError(expect.objectContaining({
      diagnostic: { code: 'empty_or_branch' },
    }));
    expect(() => parseFieldRule('||b@text', on)).toThrowError(expect.objectContaining({
      diagnostic: { code: 'empty_or_branch' },
    }));
  });

  it(`恶意分支预算：> ${MAX_OR_BRANCHES} 支 → or_branches_too_many`, () => {
    const bomb = Array.from({ length: MAX_OR_BRANCHES + 1 }, () => 'a').join('||');
    expect(() => parseFieldRule(bomb, on)).toThrowError(expect.objectContaining({
      diagnostic: { code: 'or_branches_too_many' },
    }));
    // 恰好在上限内可编译
    expect(() => parseFieldRule(Array.from({ length: MAX_OR_BRANCHES }, () => 'a').join('||'), on)).not.toThrow();
  });

  it('全局预算沿用：规则长度上限对组合规则整体生效', () => {
    const longBranch = 'a'.repeat(200);
    const bomb = Array.from({ length: MAX_OR_BRANCHES }, () => longBranch).join('||');
    expect(bomb.length).toBeGreaterThan(2048);
    expect(() => parseFieldRule(bomb, on)).toThrowError(expect.objectContaining({
      diagnostic: { code: 'rule_too_long' },
    }));
  });
});

// ---------------------------------------------------------------- on 态求值
const HTML = `<!DOCTYPE html><html><body>
<ul class="list1"><li id="one">甲条目</li><li id="two">乙条目</li></ul>
<ul class="list2"><li id="three">丙条目</li></ul>
<div class="missing"></div>
<div class="emptybox"><span></span><span>后备文本</span></div>
</body></html>`;
const URL = 'https://example.com/page';
const htmlScope = () => createHtmlScope(HTML, URL);

describe('on 态求值：空值短路（字符串字段）', () => {
  it('左支命中 → 不再求右支（短路）', () => {
    expect(evaluateField(field('ul.list1@li.0@text||ul.list2@li@text'), htmlScope())).toBe('甲条目');
    expect(evaluateField(field('ul.list2@li@text||ul.list1@li.0@text'), htmlScope())).toBe('丙条目');
  });

  it('左支空（选择器未命中/文本空）→ 试右支', () => {
    expect(evaluateField(field('div.missing@text||ul.list1@li.0@text'), htmlScope())).toBe('甲条目');
    expect(evaluateField(field('div.emptybox@span.0@text||div.emptybox@span.1@text'), htmlScope())).toBe('后备文本');
  });

  it('全支皆空 → 空串（未命中口径）', () => {
    expect(evaluateField(field('div.missing@text||div.nope@text'), htmlScope())).toBe('');
  });

  it('text（纯文本/绝对 URL）支参与短路', () => {
    expect(evaluateField(field('div.missing@text||https://example.com/abs'), htmlScope())).toBe('https://example.com/abs');
    // 首支非空即胜出：后面的 URL 不参与
    expect(evaluateField(field('ul.list1@li.0@text||https://example.com/abs'), htmlScope())).toBe('甲条目');
  });

  it('jsonpath 支在 JSON 作用域内短路；显式 CSS 支对 JSON 输入照旧抛错不吞', () => {
    const jsonScope = createJsonScope({ a: '', b: '值' }, 'https://api.example/');
    expect(evaluateField(field('$.a||$.b'), jsonScope)).toBe('值');
    expect(() => evaluateField(field('$.a||@css:div@text'), jsonScope)).toThrow(RuleEngineError);
    // 默认语法支在 JSON 输入上走 legado Json 模式（`b` → `$.b`，jsonbl41），参与短路
    expect(evaluateField(field('$.a||b'), jsonScope)).toBe('值');
  });

  it('求值异常上抛（坏选择器不因短路被吞，§5.1）', () => {
    expect(() => evaluateField(field('div[unclosed@text||ul.list1@li.0@text'), htmlScope())).toThrow(RuleEngineError);
  });

  it('## 净化在组合选定后对最终值生效（组合层尾缀）', () => {
    expect(evaluateField(field('div.missing@text||ul.list1@li.0@text##甲条目##净化后##'), htmlScope())).toBe('净化后');
  });
});

describe('on 态求值：列表字段（bookList/chapterList 口径）', () => {
  it('节点支空值短路：取首个非空节点集', () => {
    const nodes = evaluateFieldNodes(field('ul.list3@li||ul.list2@li'), htmlScope());
    expect(nodes.length).toBe(1);
    expect((nodes.get(0) as unknown as { attribs?: Record<string, string> }).attribs?.id).toBe('three');
  });

  it('首个非空支的节点身份保持（可继续 insideNode 求子字段，不压扁成文本）', () => {
    const nodes = evaluateFieldNodes(field('ul.list1@li||ul.list2@li'), htmlScope());
    expect(nodes.length).toBe(2);
    const item = insideNode(htmlScope(), nodes.get(0));
    expect(evaluateField(parseFieldRule('@text'), item)).toBe('甲条目');
    expect(evaluateField(parseFieldRule('@text', on), item)).toBe('甲条目'); // 裸 @text 两态一致
  });

  it('标量支不能献出节点集（节点与标量不压成一个 selector，§7 P1a 验收）', () => {
    // 首支是文本支（无节点身份）：列表口径下视为空支，仍取右支节点集
    const nodes = evaluateFieldNodes(field('https://example.com/abs||ul.list2@li'), htmlScope());
    expect(nodes.length).toBe(1);
    // 两支皆标量 → 空节点集（不把文本包装成节点）
    expect(evaluateFieldNodes(field('https://example.com/abs||fallback'), htmlScope()).length).toBe(0);
  });
});

describe('on 态求值：multi（正文拼接）', () => {
  it('正文口径 multi=true：节点支按拼接视图判空/胜出', () => {
    const CHAPTER = '<div id="content"><p>第一段。</p><p>第二段。</p></div><div id="alt"><p>备段。</p></div>';
    const scope = createHtmlScope(CHAPTER, URL);
    expect(evaluateField(field('id.content@p@text||id.alt@p@text'), scope, true)).toBe('第一段。\n第二段。');
    expect(evaluateField(field('id.missing@p@text||id.alt@p@text'), scope, true)).toBe('备段。');
  });
});

// ---------------------------------------------------------------- 缓存与门面
describe('compileSource：两态缓存隔离（语义版本化键）', () => {
  const source = {
    url: 'https://example.com/',
    searchUrl: 'https://example.com/s?key={{key}}',
    rules: { ruleToc: { chapterName: 'a@text||text' } } as Record<string, unknown>,
  };

  it('同一进程 on/off 两态产物共存互不污染', () => {
    const off = compileSource(source);
    const on = compileSource(source, { orEnabled: true });
    expect(off.get('ruleToc.chapterName')).toEqual({ skipped: 'unsupported' });
    const onEntry = on.get('ruleToc.chapterName');
    expect(onEntry && !('skipped' in onEntry) && onEntry.rules[0].kind).toBe('or');
    // 再取一次 off：缓存命中仍是 off 语义（键隔离生效）
    const offAgain = compileSource(source);
    expect(offAgain.get('ruleToc.chapterName')).toEqual({ skipped: 'unsupported' });
  });
});

// ---------------------------------------------------------------- 影子求值
describe('影子求值（shadowEvaluateSource）', () => {
  const source = {
    bookSourceUrl: 'https://shadow.example.com/',
    searchUrl: 'https://shadow.example.com/s?key={{key}}',
    ruleSearch: { bookList: '.list||ul li', name: 'h3@text||.title@text', bookUrl: 'a@href' },
    ruleContent: { content: '#content@html||.body@html' },
  };

  it('off 态可跑：current 列=off 结论（不改），shadow 列=on 编译结论', () => {
    const result = shadowEvaluateSource(source);
    // off 态：ruleSearch.name 含 || → compileAdmission 拒
    expect(result.currentCompileOk).toBe(false);
    // on 态：全部核心字段可解释（bookList/name/content 的 || 均成 OrNode）
    expect(result.shadowCompileOk).toBe(true);
    expect(result.shadowSemanticsVersion).toBe(2);
    const nameField = result.fields.find((f) => f.field === 'ruleSearch.name')!;
    expect(nameField.compiled).toBe(true);
    // 未提供页面 → value 留空（影子求值不替调用方发请求）
    expect(nameField.value).toBe('');
    expect(nameField.nodes).toBeUndefined();
  });

  it('提供页面文本时求值（列表字段给命中数，字符串字段给值）', () => {
    const page = {
      text: '<ul class="list"><li><h3>书名</h3><a href="/b/1">链</a></li></ul>',
      pageUrl: 'https://shadow.example.com/s?key=x',
    };
    const result = shadowEvaluateSource(source, {
      'ruleSearch.bookList': page,
      'ruleSearch.name': page,
      'ruleSearch.bookUrl': page,
    });
    const list = result.fields.find((f) => f.field === 'ruleSearch.bookList')!;
    expect(list.nodes).toBe(1); // 首支 .list 命中 1 节点
    expect(result.fields.find((f) => f.field === 'ruleSearch.name')!.value).toBe('书名');
    expect(result.fields.find((f) => f.field === 'ruleSearch.bookUrl')!.value).toBe('https://shadow.example.com/b/1');
  });

  it('on 态的规则在影子编译里产出 OrNode；off 态语义版本键不被污染', () => {
    const result = shadowEvaluateSource(source);
    expect(result.shadowCompileOk).toBe(true);
    // 与 compileSource 默认（off）对照：同源默认编译 name 应 skipped
    const off = compileSource({ url: source.bookSourceUrl, searchUrl: source.searchUrl, rules: source as unknown as Record<string, unknown> });
    expect(off.get('ruleSearch.name')).toEqual({ skipped: 'unsupported' });
  });

  it('影子求值模块纪律：无网络/定时器/DB/真实 env 读取（红线：不写库不改准入）', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.join(__dirname, 'shadow-eval.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const bad of ['fetch(', 'setTimeout', 'setInterval', 'sourceAbortable', 'process.env', 'neon', 'pglite']) {
      expect(src.includes(bad), `shadow-eval.ts 不得出现 ${bad}`).toBe(false);
    }
  });
});
