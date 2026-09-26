import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission, type AdmissionTransport } from './admission';
import { selectCandidates, type RawSource } from './compile-smoke';
import { buildSourceSearchRequest, searchOptionsConstructible } from '@/lib/source-parser';
import { searchTemplateRejected } from '@/lib/source-usability';
import { encodeToBytes } from '@/lib/source-charset';
import { SourcePolicyError } from '@/lib/source-policy';

// 41-admpost：准入候选/探测支持 POST/charset + 判据单一化（F1/F2）。
// book15.net 在内建 host 白名单里，故运行时 validateSourceUrl 也放行——四处判据可直接对齐。
const BASE = 'https://book15.net';
const src = (searchUrl: string): RawSource => ({
  bookSourceUrl: BASE, searchUrl,
  ruleSearch: { bookList: '.book' }, ruleContent: { content: '.content' },
});

const runtimeThrows = (su: string): boolean => {
  try { buildSourceSearchRequest(su, '书', BASE); return false; } catch (e) { if (e instanceof SourcePolicyError) return true; throw e; }
};

// 每条 fixture 标注「构造得出吗」，四处判据必须一致。
const FIXTURES: [label: string, searchUrl: string, supported: boolean][] = [
  ['纯 GET', `${BASE}/s?q={{key}}`, true],
  ['POST 表单 body + gb2312', `${BASE}/s,{"method":"POST","body":"k={{key}}","charset":"gb2312"}`, true],
  ['POST 单引号选项', `${BASE}/s,{'method':'POST','body':'k={{key}}'}`, true],
  ['白名单头', `${BASE}/s,{"method":"POST","body":"k={{key}}","headers":{"Content-Type":"application/x-www-form-urlencoded"}}`, true],
  ['urlPart 残留 {{cookie}}', `${BASE}/s?q={{key}}&c={{cookie:token}},{"method":"POST"}`, false],
  ['空 charset', `${BASE}/s,{"method":"POST","body":"k={{key}}","charset":""}`, false],
  ['headers 是字符串', `${BASE}/s,{"method":"POST","body":"k={{key}}","headers":"x"}`, false],
  ['body 是对象', `${BASE}/s,{"method":"POST","body":{"k":"{{key}}"}}`, false],
  ['webView', `${BASE}/s?q={{key}},{"webView":true}`, false],
  ['未知键', `${BASE}/s?q={{key}},{"method":"POST","foo":1}`, false],
  ['@js body', `${BASE}/s,{"method":"POST","body":"k={{key}}@js:1"}`, false],
];

describe('41-admpost F1：候选/运行时/source-usability 三处判据单一化', () => {
  beforeEach(() => { process.env.ENGINE_POST_SEARCH = '1'; });
  afterEach(() => { delete process.env.ENGINE_POST_SEARCH; });

  it.each(FIXTURES)('%s：四处判据一致（supported=%s）', (_label, searchUrl, supported) => {
    // 候选口径（结构判据，放开 host）
    expect(searchOptionsConstructible(searchUrl, BASE)).toBe(supported);
    // 运行时构造（默认 validateSourceUrl，book15 在白名单）
    expect(runtimeThrows(searchUrl)).toBe(!supported);
    // source-usability（flag 开走 buildSourceSearchRequest）
    expect(searchTemplateRejected({ url: BASE, searchUrl, rules: {} }, '书')).toBe(!supported);
    // selectCandidates postSearch 开
    expect(selectCandidates([src(searchUrl)], { postSearch: true }).length).toBe(supported ? 1 : 0);
  });
});

describe('41-admpost：开关两态', () => {
  const POST = `${BASE}/s,{"method":"POST","body":"k={{key}}","charset":"gb2312"}`;

  it('关（默认）：POST 源不入候选、source-usability 判死、运行时抛', () => {
    delete process.env.ENGINE_POST_SEARCH;
    expect(selectCandidates([src(POST)]).length).toBe(0);
    expect(searchTemplateRejected({ url: BASE, searchUrl: POST, rules: {} }, '书')).toBe(true);
  });

  it('开：POST 源入候选、source-usability 放行', () => {
    process.env.ENGINE_POST_SEARCH = '1';
    expect(selectCandidates([src(POST)], { postSearch: true }).length).toBe(1);
    expect(searchTemplateRejected({ url: BASE, searchUrl: POST, rules: {} }, '书')).toBe(false);
    delete process.env.ENGINE_POST_SEARCH;
  });
});

// ------- 准入探测 POST/charset（滤网 2 searchAdmission） -------
const declared = (host: string) => new Set([host]);
const signal = () => new AbortController().signal;
// searchCandidateUrls 用 bookList/.i + name/.t@text + bookUrl/a@href：一条即算候选。
const CANDIDATE_HTML = '<html><body><div class="i"><span class="t">书名</span><a href="/b/1">x</a></div></body></html>';
const postSource = (host: string, over: Partial<RawSource> = {}): RawSource => ({
  bookSourceUrl: `https://${host}/`, bookSourceName: 'POST 源',
  searchUrl: `https://${host}/s,{"method":"POST","body":"k={{key}}","charset":"gb2312"}`,
  checkKeyWord: '剑来',
  ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
  ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.c' },
  ...over,
});

describe('41-admpost item2：准入探测 POST/charset 分类', () => {
  beforeEach(() => { process.env.ENGINE_POST_SEARCH = '1'; });
  afterEach(() => { delete process.env.ENGINE_POST_SEARCH; });

  it('POST 命中：发出 POST + gbk 字节化 body，判 ok', async () => {
    const captured: { method?: string; body?: unknown } = {};
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation((_input, init) => {
      captured.method = init.method; captured.body = init.body;
      return Promise.resolve(new Response(CANDIDATE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    });
    const result = await searchAdmission(postSource('post.example.com'), {
      fetchPage, declaredHosts: declared('post.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('ok');
    expect(result.candidateCount).toBe(1);
    expect(captured.method).toBe('POST');
    // body = "k=" + gbk 百分号编码后的 "剑来"（表单 body：{{key}} 走 encodeQueryComponent，任何 charset 下都是 ASCII 百分号串）。
    const bodyText = new TextDecoder('gbk').decode(captured.body as Uint8Array);
    expect(bodyText).toBe('k=%BD%A3%C0%B4');
  });

  it('GBK 响应无 Content-Type charset：回退请求声明字符集解码，候选可解析', async () => {
    const gbkBody = encodeToBytes(CANDIDATE_HTML, 'gbk');
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      new Response(gbkBody, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const result = await searchAdmission(postSource('gbk.example.com'), {
      fetchPage, declaredHosts: declared('gbk.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('ok');
    expect(result.candidateCount).toBe(1);
  });

  it('POST 403 → challenge', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(new Response('blocked', { status: 403 }));
    const result = await searchAdmission(postSource('wall.example.com'), {
      fetchPage, declaredHosts: declared('wall.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('challenge');
  });

  it('POST 传输失败 → conn_fail', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockRejectedValue(new TypeError('fetch failed'));
    const result = await searchAdmission(postSource('down.example.com'), {
      fetchPage, declaredHosts: declared('down.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('conn_fail');
  });

  it('{{cookie}} 展不开的 POST 源 → url_invalid，不发请求', async () => {
    const fetchPage = vi.fn<AdmissionTransport>();
    const source = postSource('cookie.example.com', {
      searchUrl: 'https://cookie.example.com/s?q={{key}}&c={{cookie:x}},{"method":"POST"}',
    });
    const result = await searchAdmission(source, {
      fetchPage, declaredHosts: declared('cookie.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('url_invalid');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('POST 重定向后降级为无 body 的 GET', async () => {
    const methods: (string | undefined)[] = [];
    const bodies: unknown[] = [];
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation((_input, init) => {
      methods.push(init.method); bodies.push(init.body);
      if (methods.length === 1) {
        return Promise.resolve(new Response('', { status: 302, headers: { location: 'https://redir.example.com/r' } }));
      }
      return Promise.resolve(new Response(CANDIDATE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    });
    const result = await searchAdmission(postSource('redir.example.com'), {
      fetchPage, declaredHosts: declared('redir.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('ok');
    expect(methods).toEqual(['POST', 'GET']);
    expect(bodies[1]).toBeUndefined();
  });
});

// ------- M1 修复：响应解码字符集受 enginePostSearchEnabled() 门控（rvadmpost §2 M1 反例）-------
// 纯 GET 源（flag 关时的唯一候选形态）+ 站点在 Content-Type 里声明 charset=gbk 的 GBK 页面。
// 基线 f57e191 恒 utf-8 解码：gbk 字节按 utf-8 解出乱码、不命中强反爬标记 → no_result（deferred）。
// 修复前的 :464（无 flag 门）会在 flag 关时也嗅探 gbk、解出「安全验证」→ challenge（rejected 终态），
// 改变准入分桶且发生在 flag 打开之前。修复后 flag 关恒 utf-8（与基线逐字等价）、flag 开才按 gbk 解码。
const getSource = (host: string): RawSource => ({
  bookSourceUrl: `https://${host}/`, bookSourceName: 'GET 源',
  searchUrl: `https://${host}/s?q={{key}}`, checkKeyWord: '剑来',
  ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
  ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.c' },
});
const gbkChallengePage = () =>
  encodeToBytes('<html><body><p>安全验证</p></body></html>', 'gbk');

describe('41-admpost M1：GET 源准入响应解码的 flag 门控', () => {
  afterEach(() => { delete process.env.ENGINE_POST_SEARCH; });

  it('flag 关 + GBK 声明 + 强标记页：恒 utf-8 解码 → no_result（与基线 f57e191 同分类，不误判 challenge）', async () => {
    delete process.env.ENGINE_POST_SEARCH;
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      new Response(gbkChallengePage(), { status: 200, headers: { 'content-type': 'text/html; charset=gbk' } }),
    );
    const result = await searchAdmission(getSource('gbk-off.example.com'), {
      fetchPage, declaredHosts: declared('gbk-off.example.com'), signal: signal(), throttleMs: 0,
    });
    // utf-8 解出的乱码不含「安全验证」明文 → 不命中 STRONG_CHALLENGE_MARKERS → 落 no_result。
    expect(result.verdict).toBe('no_result');
  });

  it('flag 开 + GBK 声明 + 强标记页：按 gbk 解码 → 命中「安全验证」→ challenge', async () => {
    process.env.ENGINE_POST_SEARCH = '1';
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      new Response(gbkChallengePage(), { status: 200, headers: { 'content-type': 'text/html; charset=gbk' } }),
    );
    const result = await searchAdmission(getSource('gbk-on.example.com'), {
      fetchPage, declaredHosts: declared('gbk-on.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('challenge');
    expect(result.error).toBe('安全验证');
  });
});
