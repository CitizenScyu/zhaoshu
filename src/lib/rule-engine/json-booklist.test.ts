import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import corpus from './fixtures/admission-174.json';
import sfacgSearch from './fixtures/json-booklist/sfacg-search.json';
import ihuabenSearch from './fixtures/json-booklist/ihuaben-search.json';
import ihuabenSearchEmpty from './fixtures/json-booklist/ihuaben-search-empty.json';
import { searchAdmission } from './admission';
import { engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { compileSource } from './compile';
import type { RawSource } from './compile-smoke';
import {
  createHtmlScope, createJsonScope, evaluateField, evaluateFieldList, evaluateFieldNodes, insideNode,
} from './evaluate';
import { evalJsonPathList, parseJsonPath } from './jsonpath';
import { parseFieldRule } from './parse';

// jsonbl41：JSON 搜索页 bookList 取不出候选（准入 no_result、真站 200+JSON 含书）。
// 语义对齐 legado：AnalyzeByJSonPath.getList（Jayway read<ArrayList>）、SourceRule 按内容定模式
// （JSON 内容上无前缀规则走 Json 模式，Jayway 对不以 $/@ 开头的路径补 `$.`）、innerRule("{$.")。
// sfacg / ihuaben 响应为 2026-09-25 公开 GET 实采后裁剪（只留规则用到的字段）；其余形态为合成。

const sources = corpus as unknown as RawSource[];
const corpusSource = (url: string): RawSource => {
  const found = sources.find((source) => source.bookSourceUrl === url);
  if (!found) throw new Error(`corpus 缺源 ${url}`);
  return found;
};

async function admit(source: RawSource, body: unknown, contentType = 'application/json') {
  const hosts = new Set([
    new URL(String(source.bookSourceUrl)).hostname,
    new URL(String(source.searchUrl).replace(/\{\{\w+\}\}/g, 'x')).hostname,
  ]);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return searchAdmission(source, {
    fetchPage: async () => new Response(text, { status: 200, headers: { 'content-type': contentType } }),
    declaredHosts: hosts, signal: new AbortController().signal, throttleMs: 0,
  });
}

function synthetic(ruleSearch: Record<string, string>, host = 'api.example.com'): RawSource {
  return {
    bookSourceUrl: `https://${host}`, bookSourceName: '合成 JSON 源',
    searchUrl: `https://${host}/search?q={{key}}`, checkKeyWord: '测试书',
    ruleSearch,
    ruleToc: { chapterList: '$.list[*]', chapterName: '$.title', chapterUrl: '$.url' },
    ruleContent: { content: '$.content' },
  } as RawSource;
}

describe('根因 1：列表字段在 JSON 输入上恒为空（evaluateFieldNodes 只认 HTML）', () => {
  it('确定路径 `$.Novels` 命中数组 → 数组元素即候选（sfacg 实采，Content-Type 是 text/html）', async () => {
    const result = await admit(corpusSource('https://m.sfacg.com'), sfacgSearch, 'text/html; charset=utf-8');
    expect(result).toMatchObject({ verdict: 'ok', candidateCount: 3 });
  });

  it('确定路径 `$.pageUtil.pageList`（ihuaben 实采）→ ok；站内真无结果（pageList=[]）仍是 no_result', async () => {
    const source = corpusSource('https://www.ihuaben.com#🎃');
    expect(await admit(source, ihuabenSearch)).toMatchObject({ verdict: 'ok', candidateCount: 3 });
    expect(await admit(source, ihuabenSearchEmpty)).toMatchObject({ verdict: 'no_result', candidateCount: 0 });
  });

  it('不确定路径 `$..books[*]`：递归下降 + 通配，命中值逐个成为列表项（fengduxiaoshuo 形态，合成）', async () => {
    const body = { code: 0, data: { result: { books: [
      { bookTitle: '斗破苍穹（完本）', bookAuthor: '天蚕土豆', bookId: 101 },
      { bookTitle: '斗破苍穹之异界', bookAuthor: '某人', bookId: 102 },
    ] } } };
    const source = corpusSource('https://fiction.fengduxiaoshuo.com');
    expect(await admit(source, body)).toMatchObject({ verdict: 'ok', candidateCount: 2 });
  });

  it('不确定路径 `$.books[*]`（wnreader 形态，合成）', async () => {
    const source = synthetic({ bookList: '$.books[*]', name: '$.name', author: '$.author', bookUrl: 'https://api.example.com/book/{{$.id}}' });
    const body = { books: [{ name: '测试书', author: '甲', id: 1 }, { name: '测试书二', author: '乙', id: 2 }] };
    expect(await admit(source, body)).toMatchObject({ verdict: 'ok', candidateCount: 2 });
  });

  it('engineSearchBook / engineFetchToc 在 JSON 页上同样取出列表（阅读链路与准入同口径）', async () => {
    const searchUrl = 'https://book15.net/api/search?q={{key}}';
    const rules = {
      ruleSearch: { bookList: '$.Novels', name: '$.NovelName', author: '$.AuthorName', bookUrl: 'https://book15.net/api/novel/{{$.NovelID}}' },
      ruleToc: { chapterList: '$.data.volumeList[*].chapterList[*]', chapterName: '$.title', chapterUrl: 'https://book15.net/api/chap/{{$.chapId}}' },
      ruleContent: { content: '$.data.content' },
    };
    const source: EngineSource = {
      url: 'https://book15.net', name: 'JSON 源', searchUrl,
      compiled: compileSource({ url: 'https://book15.net', searchUrl, rules }),
    };
    const tocUrl = 'https://book15.net/api/toc/249775';
    const pages = new Map([
      ['https://book15.net/api/search?q=' + encodeURIComponent('斗破苍穹'), JSON.stringify(sfacgSearch)],
      [tocUrl, JSON.stringify({ data: { volumeList: [
        { chapterList: [{ title: '第一章', chapId: 11 }, { title: '第二章', chapId: 12 }] },
        { chapterList: [{ title: '第三章', chapId: 21 }] },
      ] } })],
    ]);
    const context = {
      page: async (url: string) => {
        const text = pages.get(url);
        if (text === undefined) throw new Error('Unexpected engine request: ' + url);
        return { url, text };
      },
    } as unknown as SourceRequestContext;
    expect(await engineSearchBook(source, '斗破苍穹', context)).toEqual([
      { title: '斗破苍穹之魂玉', author: '赤月之瞳', bookUrl: 'https://book15.net/api/novel/249775' },
      { title: '斗破苍穹之冰雪绝恋', author: '溯源轮回', bookUrl: 'https://book15.net/api/novel/136931' },
      { title: '斗破苍穹之魂清', author: '江韶云', bookUrl: 'https://book15.net/api/novel/392410' },
    ]);
    expect((await engineFetchToc(source, tocUrl, context, true)).chapters).toEqual([
      { title: '第一章', url: 'https://book15.net/api/chap/11' },
      { title: '第二章', url: 'https://book15.net/api/chap/12' },
      { title: '第三章', url: 'https://book15.net/api/chap/21' },
    ]);
  });
});

describe('根因 2：无前缀规则在 JSON 输入上被当 CSS（legado 走 Json 模式、补 `$.`）', () => {
  it('bookList `.bookList[*]` → `$..bookList[*]`，子规则 `title`/`author` → `$.title`/`$.author`（book.qq.com 形态，合成）', async () => {
    const source = synthetic({ bookList: '.bookList[*]', name: 'title', author: 'author', bookUrl: 'https://api.example.com/book/{{$.bid}}' });
    const body = { code: 0, data: { bookList: [{ title: '测试书', author: '甲', bid: 7 }, { title: '别的书', author: '乙', bid: 8 }] } };
    expect(await admit(source, body)).toMatchObject({ verdict: 'ok', candidateCount: 2 });
  });

  it('子规则裸字段名（idejian 形态 `bookName`/`author`）在 JSON 列表项上取值', () => {
    const scope = createJsonScope({ data: { books: [{ bookName: '书一', author: '甲', bookId: 5 }] } }, 'https://wechat.idejian.com/');
    const items = evaluateFieldList(parseFieldRule('$..books[*]'), scope);
    expect(items).toHaveLength(1);
    expect(evaluateField(parseFieldRule('bookName'), items[0])).toBe('书一');
    expect(evaluateField(parseFieldRule('author'), items[0])).toBe('甲');
    expect(evaluateField(parseFieldRule('https://wechat.idejian.com/api/wechat/book/{{$..bookId}}'), items[0]))
      .toBe('https://wechat.idejian.com/api/wechat/book/5');
  });

  it('JSON 模式读不到/解析不了 → 空串不抛（legado 吞 Jayway 异常）；显式 @css: 仍拒绝', () => {
    const scope = createJsonScope({ a: 1 }, 'https://api.example.com/');
    expect(evaluateField(parseFieldRule('div.t2@text'), scope)).toBe('');
    expect(evaluateField(parseFieldRule('@text'), scope)).toBe('');
    expect(() => evaluateField(parseFieldRule('@css:div@text'), scope)).toThrow();
    expect(evaluateFieldList(parseFieldRule('@css:.list li'), scope)).toEqual([]);
  });
});

describe('根因 3：字面量里的 `{$.x}` 内嵌规则原样输出（legado innerRule("{$.") 会替换）', () => {
  it('sma.yueyouxs 形态 bookUrl `http://…/b/{$.wapBookId}.html` 在 JSON 列表项上替换出真实 id', () => {
    const rule = String((corpusSource('https://sma.yueyouxs.com/').ruleSearch as Record<string, string>).bookUrl);
    const item = createJsonScope({ bookName: '书', wapBookId: 9527 }, 'https://sma.yueyouxs.com/');
    expect(evaluateField(parseFieldRule(rule), item)).toBe('http://sma.yueyouxs.com/b/9527.html');
  });

  it('内嵌规则求值为空时不替换；全部为空则字面量原样（保守：不改无内嵌规则的字面量）', () => {
    const item = createJsonScope({ id: 3 }, 'https://api.example.com/');
    expect(evaluateField(parseFieldRule('https://h.example/{$.id}/{$.nope}.html'), item)).toBe('https://h.example/3/{$.nope}.html');
    expect(evaluateField(parseFieldRule('https://h.example/{$.nope}.html'), item)).toBe('https://h.example/{$.nope}.html');
    expect(evaluateField(parseFieldRule('https://h.example/plain.html'), item)).toBe('https://h.example/plain.html');
  });

  // jsonblfix41：复审把「内嵌规则求值为空时继续扫描后续 {$.」列为阻断，建议改 break。
  // 复核 legado 原实现（RuleAnalyzer.kt innerRule("{$.", startStep/endStep=1，jer-chao@c2c4775 /
  // gedoor master / GEd520 fork 三份一致）：循环体**没有 break**——求值为空时走
  // `pos += inner.length`（注释「拉出字段不平衡，inner 只是个普通字串，跳到此 inner 后继续匹配」），
  // 即「跳过 3 个字符后继续找下一处」。故「失败即中止」不成立，按 break 改反而会偏离上游。
  // 下面两条把真实语义钉死：一条是「失败后仍替换后面的 {$.」（break 版会漏替换），
  // 一条是「紧贴失败项 `}` 之后（余量 < 3 字符）的 {$. 因 3 字符步进被略过」。
  it('失败的内嵌规则不中止：跳过 3 字符后继续替换后续 {$.（对齐 legado 无 break）', () => {
    const item = createJsonScope({ 存在: 5 }, 'https://api.example.com/');
    // 第二个 {$. 距失败项 `}` 之后有 5 个字符（"字面量里的"）≥ 3 ⇒ 被替换（legado 同样替换）。
    expect(evaluateField(parseFieldRule('https://h.example/{$.不存在}字面量里的{$.存在}'), item))
      .toBe('https://h.example/{$.不存在}字面量里的5');
  });

  it('失败项 `}` 之后余量不足 3 字符时，紧随的 {$. 被跳过（legado 的 inner.length 步进）', () => {
    const item = createJsonScope({ 存在: 5 }, 'https://api.example.com/');
    // 第二个 {$. 紧贴失败项 `}`（余量 0 < 3）⇒ 被跳过，一处都没替换成功 ⇒ 回退原文。
    // 改前「失败后从失败项起点 +3 继续扫」会命中它并替换成 5，与本断言相反。
    expect(evaluateField(parseFieldRule('https://h.example/{$.不存在}{$.存在}.html'), item))
      .toBe('https://h.example/{$.不存在}{$.存在}.html');
  });
});

describe('列表语义细节（Jayway getList）与 HTML 零变化', () => {
  // jsonblfix41：复审 §1 把「`.x` 无条件补 `$.` 得到递归 `$..x`」列为非阻断偏差。
  // 复核 Jayway PathCompiler.compile（json-path 主仓）：首字符非 `$`/`@` 时字面拼 `"$." + path`，
  // **没有**「`.` 开头视为相对当前节点」的分支 ⇒ `.x` 的上游语义就是 `$..x`（递归）。
  // 故这里**保留**该行为，只修正本引擎子集解析器不接受的两种等价形态（`[0]` → `$[0]`）。
  it('前缀形态：`x` → `$.x`；`.x` → `$..x`（递归，对齐 Jayway 字面拼接）', () => {
    const nested = { title: '外层', data: { books: [{ title: '内层' }] } };
    const bare = createJsonScope(nested, 'https://api.example.com/');
    // 裸 `title` → `$.title`：只取根上的 title。
    expect(evaluateField(parseFieldRule('title'), bare)).toBe('外层');
    // `.title` → `$..title`：递归下降命中所有层级（含内层）。与 `.bookList[*]` → `$..bookList[*]` 同源。
    expect(evaluateField(parseFieldRule('.title'), bare)).toBe(`外层${'\n'}内层`);
  });

  it('前缀形态：`[0]` → `$[0]`（根上下标；`$.[0]` 本引擎子集不收，回写等价形式）', () => {
    const arr = [{ title: '第一' }, { title: '第二' }];
    const scope = createJsonScope(arr, 'https://api.example.com/');
    expect(evaluateField(parseFieldRule('[0].title'), scope)).toBe('第一');
  });

  it('前缀形态：`..x` → `$...x`（Jayway 非法）⇒ 求值空串、不抛', () => {
    const scope = createJsonScope({ a: { x: 1 } }, 'https://api.example.com/');
    expect(evaluateField(parseFieldRule('..x'), scope)).toBe('');
  });

  it('确定路径命中对象/标量 → 空列表；不确定路径的命中值不再展平', () => {
    const json = { page: { list: [1, 2] }, groups: [{ books: [{ n: 'a' }] }, { books: [{ n: 'b' }, { n: 'c' }] }] };
    expect(evalJsonPathList(parseJsonPath('$.page'), json)).toEqual([]);
    expect(evalJsonPathList(parseJsonPath('$.page.list'), json)).toEqual([1, 2]);
    expect(evalJsonPathList(parseJsonPath('$..books[*]'), json)).toEqual([{ n: 'a' }, { n: 'b' }, { n: 'c' }]);
    expect(evalJsonPathList(parseJsonPath('$..books'), json)).toEqual([[{ n: 'a' }], [{ n: 'b' }, { n: 'c' }]]);
  });

  it('`||` 列表规则在 JSON 上取首个非空支', () => {
    const scope = createJsonScope({ a: [], b: [{ t: 'x' }] }, 'https://api.example.com/');
    const items = evaluateFieldList(parseFieldRule('$.a||$.b', { orEnabled: true }), scope);
    expect(items).toHaveLength(1);
    expect(evaluateField(parseFieldRule('$.t'), items[0])).toBe('x');
  });

  it('HTML 输入：evaluateFieldList ≡ evaluateFieldNodes + insideNode（逐条同值）', () => {
    const scope = createHtmlScope('<ul><li class="i"><a href="/1">一</a></li><li class="i"><a href="/2">二</a></li></ul>', 'https://book15.net/');
    const list = parseFieldRule('.i');
    const viaList = evaluateFieldList(list, scope);
    const nodes = evaluateFieldNodes(list, scope);
    expect(viaList).toHaveLength(nodes.length);
    for (let i = 0; i < nodes.length; i += 1) {
      const a = evaluateField(parseFieldRule('a@href'), viaList[i]);
      expect(a).toBe(evaluateField(parseFieldRule('a@href'), insideNode(scope, nodes[i])));
    }
    expect(viaList.map((inner) => evaluateField(parseFieldRule('a@text'), inner))).toEqual(['一', '二']);
  });
});
