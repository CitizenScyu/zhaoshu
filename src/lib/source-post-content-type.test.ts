import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSourceSearchRequest } from './source-parser';
import { checkSourceUrl } from './source-policy';
import { fetchSourceText } from './source-fetch';
import { searchAdmission, type AdmissionTransport } from './rule-engine/admission';
import type { RawSource } from './rule-engine/compile-smoke';

// postct42：POST 有 body 却没声明 Content-Type 时，buildSourceSearchRequest 补默认 CT。
// 取证见 zhaoshu/postnr-42-report.md：body 以字节发出、fetch 不自动加 CT，PHP 站 $_POST 为空 → 空搜索页 → no_result。
const allowAny = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const build = (template: string, base = 'https://h.example', title = '书') =>
  buildSourceSearchRequest(template, title, base, allowAny);
const FORM = 'application/x-www-form-urlencoded';

describe('buildSourceSearchRequest 默认 Content-Type', () => {
  // postnr42 §5 离线回归样例 1
  it('POST + 表单 body、未声明 CT → 补 application/x-www-form-urlencoded', () => {
    const req = build('/x.php,{"method":"POST","body":"searchkey={{key}}"}');
    expect(req.url).toBe('https://h.example/x.php');
    expect(req.headers).toEqual({ 'Content-Type': FORM });
  });

  // postnr42 §5 离线回归样例 2
  it('源已声明 Content-Type: application/json → 不覆盖', () => {
    const req = build('/x.php,{"method":"POST","body":"searchkey={{key}}","headers":{"Content-Type":"application/json"}}');
    expect(req.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('源已声明小写 content-type → 不覆盖、不另加大写键', () => {
    const req = build('/x.php,{"method":"POST","body":"k={{key}}","charset":"gbk","headers":{"content-type":"text/plain"}}');
    expect(req.headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('源已声明混合大小写 CONTENT-TYPE → 不覆盖', () => {
    const req = build('/x.php,{"method":"POST","body":"k={{key}}","headers":{"CONTENT-TYPE":"multipart/form-data"}}');
    expect(req.headers).toEqual({ 'CONTENT-TYPE': 'multipart/form-data' });
  });

  // postnr42 §5 离线回归样例 3（GET 与无 body 的 POST 两种形态）
  it.each([
    ['纯 GET 模板', '/s?q={{key}}'],
    ['带选项的 GET', '/s?q={{key}},{"method":"GET","charset":"gbk"}'],
    ['GET 带 body（不发 body，也不加 CT）', '/s?q={{key}},{"body":"k={{key}}"}'],
    ['无 body 的 POST', '/s?q={{key}},{"method":"POST"}'],
    ['body 为空串的 POST', '/s?q={{key}},{"method":"POST","body":""}'],
  ])('不加 CT：%s', (_label, template) => {
    expect(build(template).headers).toBeUndefined();
  });

  it('GBK 源：CT 带 ; charset=<声明值>', () => {
    const req = build('/s.php,{"charset":"gbk","method":"POST","body":"s={{key}}&type=articlename"}');
    expect(req.charset).toBe('gbk');
    expect(req.headers).toEqual({ 'Content-Type': `${FORM}; charset=gbk` });
  });

  it('声明值原样（去首尾空白）写进 CT，归一只影响字节化', () => {
    expect(build('/s,{"charset":" gb2312 ","method":"post","body":"k={{key}}"}').headers)
      .toEqual({ 'Content-Type': `${FORM}; charset=gb2312` });
    expect(build('/s,{"charset":"GBK","method":"POST","body":"k={{key}}"}').headers)
      .toEqual({ 'Content-Type': `${FORM}; charset=GBK` });
  });

  it('JSON body（以 { 起）→ application/json', () => {
    const req = build('/api,{"method":"POST","body":"{\\"key\\":\\"{{key}}\\"}"}');
    expect(req.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('其它白名单头保留，CT 追加在后', () => {
    const req = build('/s,{"method":"POST","body":"k={{key}}","headers":{"Referer":"https://h.example/"}}');
    expect(req.headers).toEqual({ Referer: 'https://h.example/', 'Content-Type': FORM });
  });
});

// postnr42 §4 的 7 个 a 类源（searchUrl 原样取自 postnr42-scratch/srcs.json）：补前无 CT、补后站点才收到关键词。
const A_CLASS: [host: string, searchUrl: string, ct: string][] = [
  ['https://m.haitangwx.com', '/s.php,{\n  "charset": "gbk",\n  "method": "POST",\n  "body": "s={{key}}&type=articlename"\n}', `${FORM}; charset=gbk`],
  ['https://m.xyushuwu.me', '/s.php,{\n  "charset": "gbk",\n  "method": "POST",\n  "body": "s={{key}}&type=articlename"\n}', `${FORM}; charset=gbk`],
  ['https://wap.po18bl.com', 'https://wap.po18bl.com/modules/article/search.php,{\n"charset": "utf-8",\n"method": "POST",\n"body": "searchkey={{key}}&searchtype=all"\n}', `${FORM}; charset=utf-8`],
  ['https://www.bengben.com', 'https://www.bengben.com/search/book,{\n  "body": "searchkey={{key}}",\n  "method": "POST",\n  "charset": "GBK"\n}', `${FORM}; charset=GBK`],
  ['https://www.sangshixs.com', '/e/search/index.php,{\n  "body": "tbname=bookname&show=title,writer&tempid=1&keyboard={{key}}",\n  "method": "POST"\n}', FORM],
  ['https://www.sjks88.com', '/e/search/index.php,{\n  "charset": "gb2312",\n  "method": "post",\n  "body": "keyboard={{key}}&show=title&classid=0"\n}', `${FORM}; charset=gb2312`],
  ['https://www.xyushuwu.one', '/modules/article/search.php,{\n  "method": "POST",\n  "body": "searchtype=all&searchkey={{key}}"\n}', FORM],
];

describe('postnr42 a 类 7 源：构造出的请求带 CT', () => {
  it.each(A_CLASS)('%s', (host, searchUrl, ct) => {
    const req = build(searchUrl, host, '斗破苍穹');
    expect(req.method).toBe('POST');
    expect(req.body).toContain(req.charset === 'utf-8' ? encodeURIComponent('斗破苍穹') : '%B6%B7%C6%C6');
    expect(req.headers).toEqual({ 'Content-Type': ct });
  });
});

// 两条发请求路径都经 buildSourceSearchRequest：CT 只在首跳，重定向后的 GET 不带。
describe('发请求层：首跳带 CT、重定向跳不带', () => {
  afterEach(() => { delete process.env.ENGINE_POST_SEARCH; vi.unstubAllGlobals(); });

  it('准入 searchAdmission（ENGINE_POST_SEARCH 开）', async () => {
    process.env.ENGINE_POST_SEARCH = '1';
    const host = 'm.haitangwx.com';
    const source: RawSource = {
      bookSourceUrl: `https://${host}`, bookSourceName: 'a 类样例', searchUrl: A_CLASS[0][1], checkKeyWord: '斗破苍穹',
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '.c' },
    };
    const hops: { method?: string; headers: Record<string, string> }[] = [];
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation((_input, init) => {
      hops.push({ method: init.method, headers: { ...(init.headers as Record<string, string>) } });
      if (hops.length === 1) return Promise.resolve(new Response('', { status: 302, headers: { location: `https://${host}/r` } }));
      return Promise.resolve(new Response('<div class="i"><span class="t">斗破苍穹</span><a href="/b/1">x</a></div>', { status: 200 }));
    });
    const result = await searchAdmission(source, {
      fetchPage, declaredHosts: new Set([host]), signal: new AbortController().signal, throttleMs: 0,
      controlQuery: false, keywordFallback: false,
    });
    expect(result.verdict).toBe('ok');
    expect(hops[0].method).toBe('POST');
    expect(hops[0].headers['Content-Type']).toBe(`${FORM}; charset=gbk`);
    expect(hops[1].method).toBe('GET');
    expect(Object.keys(hops[1].headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('运行时 fetchSourceText（请求来自 buildSourceSearchRequest）', async () => {
    const req = buildSourceSearchRequest('https://book15.net/s,{"method":"POST","body":"searchkey={{key}}","charset":"gb2312"}', '剑来', 'https://book15.net');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/result' } }))
      .mockResolvedValueOnce(new Response('结果'));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSourceText(req.url, {
      signal: new AbortController().signal,
      request: { method: req.method, body: req.body, headers: req.headers, charset: req.charset },
    });
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe(`${FORM}; charset=gb2312`);
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][1].headers['Content-Type']).toBeUndefined();
  });
});
