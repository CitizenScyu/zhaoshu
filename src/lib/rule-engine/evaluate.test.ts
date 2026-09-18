// 求值层测试（设计 v3 §8.2）：
//  - 合成 DOM 覆盖 §3.2 四步求值、TerminalOp 全表、§3.3 正则、§3.4 失败隔离、§3.1 归一化、JSON 输入；
//  - book15 端到端对拍（§8.2①，自动化门禁）：真实页面脱敏存档，引擎输出 vs source-parser 内建适配器。

import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { parseFieldRule } from './parse';
import { RuleEngineError, type FieldIr, type TerminalOp } from './types';
import {
  CORE_FIELDS,
  createHtmlScope,
  createJsonScope,
  createScope,
  evaluateField,
  evaluateFieldNodes,
  evaluateFieldSafe,
  insideNode,
  normalizeBody,
} from './evaluate';
import {
  parseSourceChapterText,
  parseSourceChapters,
  parseSourceIdentity,
  parseSourceSearch,
  sourceSearchUrl,
} from '../source-parser';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const field = (rule: string): FieldIr => parseFieldRule(rule);

/**
 * 裸 `@op`（chain 为空、只对当前 scope 节点套末端操作）的规则对象。
 * 上游 parse.ts 目前对 `@text`/`@href` 抛「空选择器」（见实施报告 §8，已上报主会话）；
 * 求值层本身支持 `chain: []` + terminal，这里在 parse 拒绝时退回等价的手工 IR，
 * 以便对拍用例能验证完整求值路径。parse 修好后本兜底自动不再触发。
 */
function bareTerminal(op: Exclude<TerminalOp['op'], 'attr'>): FieldIr {
  try {
    return field(`@${op}`);
  } catch (error) {
    if (error instanceof RuleEngineError && error.code === 'RULE_UNSUPPORTED') {
      return { rules: [{ kind: 'css', chain: [], terminal: { op } }] };
    }
    throw error;
  }
}

// 合成 DOM：覆盖链式选择、索引/切片/排除、text./ownText 复核、全 TerminalOp、坏 URL。
const PAGE_URL = 'https://book15.net/books/details42.html';
const SYNTH = `<!DOCTYPE html><html><body>
<div class="t1">甲<b>乙</b>丙</div>
<div class="t2">只有文本</div>
<ul class="rows">
  <li class="row"><a href="/x/1.html" class="link" title="一号" alt="a1" value="v1" content="c1" data="d1" data-x="dx" srcset="s1.jpg 1x, s2.jpg 2x" src="/s/1.jpg">第一条</a><em class="kind">玄幻</em></li>
  <li class="row"><a href="https://other.example/x/2.html" class="link">第二条</a><em class="kind">都市</em></li>
  <li class="row"><a href="/x/3.html" class="link">第三条</a><em class="kind">科幻</em></li>
</ul>
<div class="outer"><i>关键词C</i></div>
<div class="wrap"><p class="leaf">关键词A</p><p class="parent"><span>关键词A</span></p></div>
<a class="broken" href="http://[invalid">坏链接</a>
</body></html>`;

const synthScope = () => createHtmlScope(SYNTH, PAGE_URL);

describe('evaluate：CSS 链求值（§3.2 四步）', () => {
  it('逐段 find + 末端操作：多命中按换行连接', () => {
    expect(evaluateField(field('ul@li@a@text'), synthScope())).toBe('第一条\n第二条\n第三条');
  });

  it('索引与负数索引从尾数（.0 / .-1）', () => {
    expect(evaluateField(field('ul@li.0@a@text'), synthScope())).toBe('第一条');
    expect(evaluateField(field('ul@li.-1@a@text'), synthScope())).toBe('第三条');
  });

  it('切片 .a:b 与超出范围不报错', () => {
    expect(evaluateField(field('ul@li.0:2@a@text'), synthScope())).toBe('第一条\n第二条');
    expect(evaluateField(field('ul@li.5:9@a@text'), synthScope())).toBe('');
  });

  it('排除 !n / !-n', () => {
    expect(evaluateField(field('ul@li!1@a@text'), synthScope())).toBe('第一条\n第三条');
    expect(evaluateField(field('ul@li!-1@a@text'), synthScope())).toBe('第一条\n第二条');
  });

  it('索引越界 → 空字段（不抛异常）', () => {
    expect(evaluateField(field('ul@li.9@a@text'), synthScope())).toBe('');
  });
});

describe('evaluate：TerminalOp 语义表（§3.2）', () => {
  it('text=textContent、ownText=自身文本、textNodes=直接子文本节点（换行连接）', () => {
    const $ = synthScope();
    expect(evaluateField(field('div.t1@text'), $)).toBe('甲乙丙');
    expect(evaluateField(field('div.t1@ownText'), $)).toBe('甲丙');
    expect(evaluateField(field('div.t1@textNodes'), $)).toBe('甲\n丙');
    expect(evaluateField(field('div.t2@text'), $)).toBe('只有文本');
    expect(evaluateField(field('div.t2@ownText'), $)).toBe('只有文本');
    expect(evaluateField(field('div.t2@textNodes'), $)).toBe('只有文本');
  });

  it('html=innerHTML、all=outerHTML', () => {
    const $ = synthScope();
    expect(evaluateField(field('div.t1@html'), $)).toBe('甲<b>乙</b>丙');
    expect(evaluateField(field('div.t2@html'), $)).toBe('只有文本');
    expect(evaluateField(field('ul@li.0@a@all'), $)).toContain('<a href="/x/1.html"');
  });

  it('URL 类属性绝对化（href/src），相对与绝对都归一', () => {
    const $ = synthScope();
    expect(evaluateField(field('ul@li@a@href'), $)).toBe('https://book15.net/x/1.html\nhttps://other.example/x/2.html\nhttps://book15.net/x/3.html');
    expect(evaluateField(field('ul@li.0@a@src'), $)).toBe('https://book15.net/s/1.jpg');
  });

  it('URL 绝对化失败 → 该值丢弃（字段落空）', () => {
    expect(evaluateField(field('a.broken@href'), synthScope())).toBe('');
  });

  it('非 URL 属性不做绝对化（title/alt/content/value/data/srcset 原样）', () => {
    const $ = synthScope();
    expect(evaluateField(field('a.link@title'), $)).toBe('一号');
    expect(evaluateField(field('a.link@alt'), $)).toBe('a1');
    expect(evaluateField(field('a.link@content'), $)).toBe('c1');
    expect(evaluateField(field('a.link@value'), $)).toBe('v1');
    expect(evaluateField(field('a.link@data'), $)).toBe('d1');
    expect(evaluateField(field('a.link@srcset'), $)).toBe('s1.jpg 1x, s2.jpg 2x');
    // 具名属性兜底 @attr
    expect(evaluateField(field('a.link@data-x'), $)).toBe('dx');
  });

  it('属性不存在 → 该节点贡献被丢弃，不留空行', () => {
    expect(evaluateField(field('ul@li@a@title'), synthScope())).toBe('一号');
  });

  it('text. 关键字的 ownText 复核剔除「文本在子孙而非自身」的假命中', () => {
    const $ = synthScope();
    const nodes = evaluateFieldNodes(field('text.关键词C'), $);
    expect(nodes.length).toBe(1);
    expect((nodes.get(0) as { tagName?: string }).tagName).toBe('i');
    // 未加复核时 :contains() 会同时命中 div.outer（其 ownText 为空）
    const hit = evaluateFieldNodes(field('text.关键词A'), $);
    expect(hit.length).toBe(2);
    const classes = hit.toArray().map((node) => (node as { attribs?: Record<string, string> }).attribs?.class);
    expect(classes).not.toContain('parent');
  });
});

describe('evaluate：正则替换（§3.3）', () => {
  it('##p## 删除匹配、##p##r## 替换、##p##r##flags## 带 flags', () => {
    const $ = synthScope();
    expect(evaluateField(field('div.t2@text##只有##'), $)).toBe('文本');
    expect(evaluateField(field('div.t2@text##只有文本##全部文本##'), $)).toBe('全部文本');
    expect(evaluateField(field('div.t1@text##[甲乙丙]##-##g##'), $)).toBe('---');
  });

  it('字段输出统一 trim()，空字符串 = 未命中', () => {
    const html = '<div class="pad">  空格环绕  </div><div class="empty"></div>';
    const $ = createHtmlScope(html, PAGE_URL);
    expect(evaluateField(field('div.pad@text'), $)).toBe('空格环绕');
    expect(evaluateField(field('div.empty@text'), $)).toBe('');
  });
});

describe('evaluate：JSON 输入与输入归一化（§3.1）', () => {
  const json = { data: { list: [{ name: '甲', id: 1 }, { name: '乙', id: 2 }] } };
  const jsonScope = () => createJsonScope(json, 'https://api.example/v1');

  it('jsonpath 子集：通配/递归/下标/下标列表/切片/等值过滤', () => {
    const $ = jsonScope();
    expect(evaluateField(field('$.data.list[*].name'), $)).toBe('甲\n乙');
    expect(evaluateField(field('$..name'), $)).toBe('甲\n乙');
    expect(evaluateField(field('$.data.list[0].id'), $)).toBe('1');
    expect(evaluateField(field('$.data.list[1,0].name'), $)).toBe('乙\n甲');
    expect(evaluateField(field('$.data.list[0:1].name'), $)).toBe('甲');
    expect(evaluateField(field('$.data.list[?(@.name == 乙)].id'), $)).toBe('2');
    // 缺字段 / 越界 = 空，不抛异常
    expect(evaluateField(field('$.data.missing.x'), $)).toBe('');
    expect(evaluateField(field('$.data.list[9].id'), $)).toBe('');
  });

  it('{{$.x}} 模板规则：字面段 + 求值段（取首个命中）', () => {
    const $ = jsonScope();
    expect(evaluateField(field('https://api.example/book/{{$.data.list[0].id}}.html'), $)).toBe('https://api.example/book/1.html');
  });

  it('输入形态与规则类型不匹配 → RULE_EVAL_FAILED', () => {
    expect(() => evaluateField(field('$.data.list[*].name'), synthScope())).toThrow(RuleEngineError);
    expect(() => evaluateField(field('div.t2@text'), jsonScope())).toThrow(RuleEngineError);
  });

  it('normalizeBody：JSON/HTML 判定与 inte_base64 解包', () => {
    expect(normalizeBody('<html><body>x</body></html>').kind).toBe('html');
    expect(normalizeBody('{"a":1}', 'application/json; charset=utf-8')).toMatchObject({ kind: 'json' });
    expect(normalizeBody('\n  [1,2]').kind).toBe('json');
    expect(normalizeBody('{不是合法 json').kind).toBe('html');
    const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    expect(normalizeBody(`inte_base64:${b64('<div>x</div>')}`)).toMatchObject({ kind: 'html', text: '<div>x</div>' });
    expect(normalizeBody(`inte_base64:${b64('{"a":1}')}`)).toMatchObject({ kind: 'json' });
    expect(normalizeBody('inte_base64:!!!not-base64!!!').kind).toBe('html');
    expect(createScope(normalizeBody('{"a":1}'), PAGE_URL).kind).toBe('json');
  });
});

describe('evaluate：失败隔离（§3.4）', () => {
  const broken = () => field('div[unclosed@text');

  it('求值异常 → RuleEngineError(RULE_EVAL_FAILED)', () => {
    let caught: unknown;
    try {
      evaluateField(broken(), synthScope());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuleEngineError);
    expect((caught as RuleEngineError).code).toBe('RULE_EVAL_FAILED');
  });

  it('核心字段上抛（该源 miss），装饰字段置空继续', () => {
    const $ = synthScope();
    expect(() => evaluateFieldSafe('ruleContent.content', broken(), $)).toThrow(RuleEngineError);
    expect(() => evaluateFieldSafe('ruleSearch.bookList', broken(), $)).toThrow(RuleEngineError);
    expect(evaluateFieldSafe('ruleBookInfo.intro', broken(), $)).toBe('');
    expect(evaluateFieldSafe('ruleSearch.wordCount', broken(), $)).toBe('');
  });

  it('T7 组合规则（&& / %%）：M1 未实现 → RULE_EVAL_FAILED，不静默返回错值', () => {
    const withJoin: FieldIr = { rules: [{ kind: 'text', literal: 'x' }], joins: [''] };
    const withConcat: FieldIr = { rules: [{ kind: 'text', literal: 'x' }], concats: ' ' };
    expect(() => evaluateField(withJoin, synthScope())).toThrow(RuleEngineError);
    expect(() => evaluateField(withConcat, synthScope())).toThrow(RuleEngineError);
  });

  it('CORE_FIELDS 为 survey 的 13 字段（与滤网 1 同口径）', () => {    expect([...CORE_FIELDS].sort()).toEqual([
      'ruleBookInfo.author', 'ruleBookInfo.name', 'ruleBookInfo.tocUrl',
      'ruleContent.content', 'ruleContent.nextContentUrl',
      'ruleSearch.author', 'ruleSearch.bookList', 'ruleSearch.bookUrl', 'ruleSearch.name',
      'ruleToc.chapterList', 'ruleToc.chapterName', 'ruleToc.chapterUrl', 'ruleToc.nextTocUrl',
    ]);
  });
});

// ---------------------------------------------------------------- book15 端到端对拍（§8.2①）
// fixture 为 book15 真实页面（脱敏：已删全部 <script>/noscript/iframe 与第三方 beacon）。
const BOOK15_SEARCH_URL = sourceSearchUrl('/books/search.html?kw={{key}}', '长生界', 'https://book15.net/');
const BOOK15_DETAIL_URL = 'https://book15.net/books/details6728.html';
const BOOK15_CHAPTER_URL = 'https://book15.net/chapter/index3168-3742303.html';

/** 正文比较口径：去标签 + 折叠全部空白（两侧同一口径）。 */
const flatten = (html: string) => load(`<div class="__w">${html}</div>`)('.__w').text().replace(/\s+/gu, '');

describe('book15 对拍：搜索（引擎 vs parseSourceSearch）', () => {
  const html = fixture('book15-search.html');
  const scope = createHtmlScope(html, BOOK15_SEARCH_URL);
  const rules = {
    bookList: '.list-item-panel',
    bookUrl: 'h3 a@href',
    name: 'h3 a@text',
    author: 'a.author@text',
    coverUrl: 'img@src',
    intro: '.nowrap-2@text',
    kind: 'a[href*=list-t]@text',
  };
  const items = evaluateFieldNodes(field(rules.bookList), scope);

  it('bookList 命中 1 条，字段逐项与站点页面一致', () => {
    expect(items.length).toBe(1);
    const item = insideNode(scope, items.get(0));
    expect(evaluateField(field(rules.name), item)).toBe('长生界');
    expect(evaluateField(field(rules.author), item)).toBe('辰东');
    expect(evaluateField(field(rules.kind), item)).toBe('玄幻奇幻');
    expect(evaluateField(field(rules.coverUrl), item)).toBe('https://book15.net/uploads/20230219/1df1077a9208f4718a6605f7a1c5680c.jpeg');
    expect(evaluateField(field(rules.intro), item).startsWith('世上谁人能不死')).toBe(true);
    expect(evaluateField(field(rules.bookUrl), item)).toBe('https://book15.net/books/details7488.html');
  });

  it('bookUrl 与内建适配器 parseSourceSearch 输出逐项相等', () => {
    const engineUrls = items.toArray().map((node) => evaluateField(field(rules.bookUrl), insideNode(scope, node)));
    expect(engineUrls).toEqual(parseSourceSearch(html, BOOK15_SEARCH_URL, '长生界'));
  });
});

describe('book15 对拍：详情 + 目录（引擎 vs parseSourceIdentity / parseSourceChapters）', () => {
  const html = fixture('book15-detail.html');
  const scope = createHtmlScope(html, BOOK15_DETAIL_URL);
  const identity = parseSourceIdentity(html);

  it('标题/作者与内建适配器 equal', () => {
    expect(evaluateField(field('h1@text'), scope)).toBe(identity.title);
    expect(evaluateField(field('.d-info-panel a[href*=author]@text'), scope)).toBe(identity.author);
    expect(evaluateField(field('meta[property="og:novel:latest_chapter_name"]@content'), scope)).toBe(
      '始与终　4、良性与恶性的群众运动',
    );
  });

  it('章节列表（url+title）与 parseSourceChapters 逐项 equal', () => {
    const nodes = evaluateFieldNodes(field('.d-chapter-list dd a'), scope);
    const engineChapters = nodes.toArray().map((node) => {
      const item = insideNode(scope, node);
      return {
        url: evaluateField(bareTerminal('href'), item),
        title: evaluateField(bareTerminal('text'), item),
      };
    });
    expect(engineChapters.length).toBeGreaterThan(10);
    expect(engineChapters).toEqual(parseSourceChapters(html, BOOK15_DETAIL_URL));
  });
});

describe('book15 对拍：正文（引擎 vs parseSourceChapterText）', () => {
  const html = fixture('book15-chapter.html');
  const scope = createHtmlScope(html, BOOK15_CHAPTER_URL);

  it('正文归一化后相等，nextContentUrl 正确绝对化', () => {
    const engineHtml = evaluateField(field('.chapter-content@html##<!--[\\s\\S]*?-->##'), scope);
    expect(engineHtml.length).toBeGreaterThan(1000);
    expect(flatten(engineHtml)).toBe(flatten(parseSourceChapterText(html, '第1章 绯红')));
    expect(evaluateField(field('#after_link@href'), scope)).toBe('https://book15.net/chapter/index3168-3742304.html');
  });
});

// ---------------------------------------------------------------- §7.3 接口纪律
describe('引擎接口纪律（§7.3）', () => {
  it('求值层不含任何请求路径/定时器/预算逻辑', () => {
    const sources = ['dom-ops.ts', 'evaluate.ts', 'normalize-body.ts']
      .map((name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
      .join('\n')
      // 只看代码，注释里提到 fetch/source-fetch 属说明性文字，不算请求路径
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const forbidden of ['fetch(', 'setTimeout', 'setInterval', 'source-fetch', 'source-reader', 'source-policy', 'AbortSignal', 'nextRequestAt']) {
      expect(sources.includes(forbidden), `求值层不得出现 ${forbidden}`).toBe(false);
    }
  });
});
