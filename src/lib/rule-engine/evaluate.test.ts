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
  decodeBase64Layer,
  evaluateField,
  evaluateFieldNodes,
  evaluateFieldSafe,
  insideNode,
  INTE_BASE64_PREFIX,
  MAX_DECODED_BYTES,
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
 * 裸 `@op`（chain 为空、只对当前 scope 节点套末端操作）——legado 列表字段的标准写法，
 * 如 ruleToc.chapterName="@text" / chapterUrl="@href"（book15 自身即此形态）。
 * 上游 `parse.ts` 曾把它判成「空选择器」误拒（归任务 1 修，已随 fd2372c 修复并 merge 进来）。
 * 这里**不再兜底**：直接断言 parse 产出 `chain: [] + terminal`，上游若回归则本用例立刻变红。
 */
function bareTerminal(op: Exclude<TerminalOp['op'], 'attr'>): FieldIr {
  const parsed = field(`@${op}`);
  expect(parsed).toEqual({ rules: [{ kind: 'css', chain: [], terminal: { op } }] });
  return parsed;
}

describe('裸 @op 规则（列表字段对 scope 节点本身求值）', () => {
  it('对单个节点（bookList 条目）求值：取自身文本 / 绝对化自身 href', () => {
    const scope = synthScope();
    const item = insideNode(scope, evaluateFieldNodes(field('a.link'), scope).get(0));
    expect(evaluateField(bareTerminal('text'), item)).toBe('第一条');
    expect(evaluateField(bareTerminal('href'), item)).toBe('https://book15.net/x/1.html');
    expect(evaluateField(bareTerminal('title'), item)).toBe('一号');
  });
});

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
  // 单值字段默认取首个非空（applyTerminal multi=false，等价 legado 单值字段 first()）。
  // 旧行为是把多命中按 \n 全量拼接——这正是 yingsx 一类 `li` 含多个 a 时把 URL 拼坏、
  // 整条候选被丢的根因（fix/engine-first-match）。正文的多节点拼接见「正文多段拼接」用例。
  it('多命中取首个非空（不再 \\n 拼接）', () => {
    expect(evaluateField(field('ul@li@a@text'), synthScope())).toBe('第一条');
  });

  it('索引与负数索引从尾数（.0 / .-1）', () => {
    expect(evaluateField(field('ul@li.0@a@text'), synthScope())).toBe('第一条');
    expect(evaluateField(field('ul@li.-1@a@text'), synthScope())).toBe('第三条');
  });

  it('切片 .a:b 与超出范围不报错（切片后仍取首个非空）', () => {
    expect(evaluateField(field('ul@li.0:2@a@text'), synthScope())).toBe('第一条');
    expect(evaluateField(field('ul@li.5:9@a@text'), synthScope())).toBe('');
  });

  it('排除 !n / !-n（排除后仍取首个非空）', () => {
    expect(evaluateField(field('ul@li!1@a@text'), synthScope())).toBe('第一条');
    expect(evaluateField(field('ul@li!-1@a@text'), synthScope())).toBe('第一条');
  });

  it('索引越界 → 空字段（不抛异常）', () => {
    expect(evaluateField(field('ul@li.9@a@text'), synthScope())).toBe('');
  });
});

// yingsx 复现：bookList 的 li 内含「标题a + 最新章节a」，name=a@text / bookUrl=a@href。
// 修前两个 a 被 \n 拼接 → bookUrl 多行 → 绝对化/校验失败 → 整条候选被丢 → 全池 0。
// 修后取首个非空 → 拿到标题与书链接（首个 a 是书本身，次个是最新章节）。
describe('首命中复现：列表条目内多个 a（yingsx 普遍结构）', () => {
  const YINGSX = `<ul class="novelslist2">
    <li class="row">
      <a href="/137_137506/">末日成神：我的都是我的异能</a>
      <a href="/137_137506/49994452.html">第69章 魔师</a>
    </li>
  </ul>`;
  const url = 'https://www.yingsx.com/xiaoshuo/1_1/';
  it('name 取首个 a 的文本，bookUrl 取首个 a 的 href（不再拼接）', () => {
    const scope = createHtmlScope(YINGSX, url);
    const item = insideNode(scope, evaluateFieldNodes(field('class.novelslist2@li'), scope).get(0));
    expect(evaluateField(field('a@text'), item)).toBe('末日成神：我的都是我的异能');
    expect(evaluateField(field('a@href'), item)).toBe('https://www.yingsx.com/137_137506/');
  });

  // 首命中取「首个非空」：首个 a 是封面图壳（@text 得 ''），书名在次个 a。
  // 若只判 null 会卡在空串返回 ''；空串跳过后才取到书名。
  it('首节点为空壳（封面图在前）→ 跳过空串取到书名', () => {
    const COVER_FIRST = `<ul class="novelslist2"><li>
      <a href="/b/1"><img src="/cover.jpg"></a><a href="/b/1">书名</a>
    </li></ul>`;
    const scope = createHtmlScope(COVER_FIRST, 'https://www.yingsx.com/');
    const item = insideNode(scope, evaluateFieldNodes(field('class.novelslist2@li'), scope).get(0));
    expect(evaluateField(field('a@text'), item)).toBe('书名');
  });
});

// 正文是唯一 multi=true 字段：@p@text 类规则靠拼接把多段落拼成整章（40/174 源依赖）。
describe('正文多段拼接：multi=true 保留 \\n 拼接，multi=false 只取首段', () => {
  const CHAPTER = `<div id="content"><p>第一段。</p><p>第二段。</p><p>第三段。</p></div>`;
  const url = 'https://example.com/c/1.html';
  it('multi=true → 三段以换行拼接（正文门面口径）', () => {
    const scope = createHtmlScope(CHAPTER, url);
    expect(evaluateField(field('id.content@p@text'), scope, true)).toBe('第一段。\n第二段。\n第三段。');
  });
  it('multi=false（默认）→ 只取首段（证明单值字段不会误拼正文）', () => {
    const scope = createHtmlScope(CHAPTER, url);
    expect(evaluateField(field('id.content@p@text'), scope)).toBe('第一段。');
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
    // 首命中：多个 li 的 a@href 只取首个绝对化成功的值（不再 \n 拼接多条 URL）。
    expect(evaluateField(field('ul@li@a@href'), $)).toBe('https://book15.net/x/1.html');
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
    // 非法 payload → 回落原文（不得把宽容解码的乱码当 HTML）。
    expect(normalizeBody('inte_base64:!!!not-base64!!!')).toMatchObject({ kind: 'html', text: '!!!not-base64!!!' });
    expect(createScope(normalizeBody('{"a":1}'), PAGE_URL).kind).toBe('json');
  });

  it('inte_base64 层：非法/非 UTF-8 payload 必须回落原文（C.11）', () => {
    // 合法：decodeBase64Layer 直出明文；normalizeBody 文本相等（不再只断 kind）。
    const plain = '<html><body>第1章 开端</body></html>';
    const payload = INTE_BASE64_PREFIX + Buffer.from(plain, 'utf8').toString('base64');
    expect(decodeBase64Layer(payload.slice(INTE_BASE64_PREFIX.length))).toBe(plain);
    expect(normalizeBody(payload)).toEqual({ kind: 'html', text: plain });

    // 非法 base64：Node 宽容解码会产出乱码，修复后必须回落原文。
    const bad = '!!!not-base64!!!';
    expect(decodeBase64Layer(bad)).toBe(bad);

    // 前缀误伤：以 inte_base64: 开头的正常正文不得被解码毁掉。
    const prose = 'this is normal chapter text about encoding';
    expect(decodeBase64Layer(prose)).toBe(prose);
    expect(decodeBase64Layer(prose).includes('�')).toBe(false);

    // UTF-8 有效性用「解码 → 重编码」字节往返判定：原文本就含 U+FFFD 的**合法**文本必须通过。
    // （反例：若扫 `decoded.includes('�')`，下面这条合法 payload 会被误判成非法回落。）
    expect(decodeBase64Layer('aGVsbG/vv713b3JsZA==')).toBe('hello�world');
    // 非法 UTF-8（JPEG 头 ff d8 ff）→ 字节往返不等 → 回落原文。
    expect(decodeBase64Layer('/9j/4AAQSkZJRg==')).toBe('/9j/4AAQSkZJRg==');

    // 超限：长度粗筛 → 原文（保留既有约束）。
    const oversized = 'A'.repeat(Math.ceil(((MAX_DECODED_BYTES + 16) * 4) / 3));
    expect(decodeBase64Layer(oversized)).toBe(oversized);

    // 空串 → 空串。
    expect(decodeBase64Layer('')).toBe('');

    // 无 padding 的合法 base64（长度 %4==0）正常解码。
    const noPadPlain = 'abc';
    const noPad = Buffer.from(noPadPlain, 'utf8').toString('base64');
    expect(noPad.includes('=')).toBe(false);
    expect(noPad.length % 4).toBe(0);
    expect(decodeBase64Layer(noPad)).toBe(noPadPlain);
  });

  it('inte_base64 层：往返校验 / 规范 padding 的判别力（P1-2）', () => {
    // 往返层独有：非规范 padding 位（Node 宽容解码成 a / ab），重编码后与原串不等 → 回落原文。
    // 字符集正则放过这两条，只有往返比对能拦下，专门覆盖第 65 行的判别力。
    expect(decodeBase64Layer('YR==')).toBe('YR==');
    expect(decodeBase64Layer('YWJ=')).toBe('YWJ=');

    // 无 / 少 padding 的规范形正常解码（现有只测了 %4==0 的 YWJj）。
    expect(decodeBase64Layer('YWI')).toBe('ab');
    expect(decodeBase64Layer('YQ')).toBe('a');
    expect(decodeBase64Layer('YQ=')).toBe('a'); // 少一个 = ：去 pad 后往返相等，接受
    expect(decodeBase64Layer('YWJj')).toBe('abc');
    expect(decodeBase64Layer('YWJ')).toBe('YWJ'); // 长度 3、非规范 2 字节编码 → 往返 fail → 原文

    // 空白剥离契约：base64 内部空白被剥掉后正常解码（MIME/折行）。
    expect(decodeBase64Layer('YW Jj')).toBe('abc');
    // 已知边角：正文去空白后恰好是规范 base64 会被解成别的字（与前缀误伤同类，接受现状并文档化）。
    expect(decodeBase64Layer('S E l U')).toBe('HIT');
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
    const sources = ['dom-ops.ts', 'evaluate.ts']
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
