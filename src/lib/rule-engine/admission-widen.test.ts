// 41-srcfix 准入扩池：改法1（探测词兜底 + challenge 有限复测）与改法2（http bookSourceUrl 升 https 参与初筛）。
// 依据：srcpool-41-report.md §5.2 / §6.3。传输层注入，校验函数（checkSourceUrl）不 mock。
import { describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_CHALLENGE_MAX_STRIKES, ADMISSION_CHALLENGE_STRIKE_PREFIX, ADMISSION_MAX_KEYWORD_TRIES,
  DEFAULT_ADMISSION_KEYWORD, DEFAULT_ADMISSION_KEYWORDS, DEFAULT_ADMISSION_UPGRADED_MAX_PROBES,
  admissionBucket, admissionKeywords, admissionUpgradedMaxProbes, challengeStrikes, compileAdmission,
  queryControlKeyword, runAdmissionBatch, rulesHash, searchAdmission,
  type AdmissionSourceRow, type AdmissionTransport,
} from './admission';
import { selectCandidates, type RawSource } from './compile-smoke';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };
const page = (body: string, status = 200) => new Response(body, { status, headers: HTML_HEADERS });
const signal = () => new AbortController().signal;
const EMPTY = '<html><body><h1>没有找到相关书籍</h1></body></html>';
const list = (...paths: string[]) => paths
  .map((path) => `<div class="i"><span class="t">书名${path}</span><a href="${path}">x</a></div>`).join('');

const FIXTURE_NOW_MS = Date.parse('2026-09-18T12:00:00Z');
const atFixtureNow = () => new Date(FIXTURE_NOW_MS);
const hoursAgoIso = (hours: number) => new Date(FIXTURE_NOW_MS - hours * 3_600_000).toISOString();

function source(url: string, over: Partial<RawSource> = {}): RawSource {
  return {
    bookSourceUrl: url, bookSourceName: '合成源', searchUrl: `https://${new URL(url).hostname}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
    ...over,
  } as RawSource;
}

function row(url: string, over: Partial<AdmissionSourceRow> = {}): AdmissionSourceRow {
  return {
    source_url: url, tier: 'M1', compile_ok: true, core_field_mask: {}, search_ok: null,
    search_verdict: '', search_checked_at: null, rules_hash: '', engine_semantics_version: 0,
    host: '', error: '', compile_diagnostics: [], ...over,
  };
}

/** 按查询词分派响应的站点桩；记录每次请求的 URL 与解码后的查询词。 */
function site(respond: (keyword: string) => Response | Promise<Response>) {
  const keywords: string[] = [];
  const urls: string[] = [];
  const fetchPage = vi.fn<AdmissionTransport>(async (input) => {
    urls.push(input);
    const keyword = new URL(input).searchParams.get('q') ?? '';
    keywords.push(keyword);
    return respond(keyword);
  });
  return { fetchPage, keywords, urls };
}

describe('改法1 探测词兜底', () => {
  const url = 'https://kw.example.com';
  const hosts = new Set(['kw.example.com']);

  it('探测词序列：无自带词 = 默认列表；自带词排首位、去重、截到上限', () => {
    expect(DEFAULT_ADMISSION_KEYWORD).toBe('斗破苍穹'); // 首词保持历史值
    expect(admissionKeywords(source(url))).toEqual([...DEFAULT_ADMISSION_KEYWORDS]);
    expect(admissionKeywords(source(url, { ruleSearch: { bookList: '.i', checkKeyWord: ' 我的 ' } })))
      .toEqual(['我的', '斗破苍穹', '诡秘之主']);
    expect(admissionKeywords(source(url, { checkKeyWord: '剑来' }))).toEqual(['剑来', '斗破苍穹', '我的']);
    for (const s of [source(url), source(url, { checkKeyWord: '剑来' })]) {
      expect(admissionKeywords(s).length).toBeLessThanOrEqual(ADMISSION_MAX_KEYWORD_TRIES);
    }
  });

  it('每个默认探测词都有无公共字的对照词（否则该词命中后查询不敏感判据失效）', () => {
    for (const keyword of DEFAULT_ADMISSION_KEYWORDS) expect(queryControlKeyword(keyword), keyword).toBeDefined();
  });

  it('多词兜底命中：首词 no_result、次词命中 ⇒ ok，只多发一次请求', async () => {
    const stub = site((keyword) => page(keyword === '我的' ? list('/b/1') : EMPTY));
    const result = await searchAdmission(source(url), {
      fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0, keywordFallback: true,
    });
    expect(result).toEqual({ verdict: 'ok', candidateCount: 1, status: 200, error: '' });
    expect(stub.keywords).toEqual(['斗破苍穹', '我的']);
  });

  it('全部 miss ⇒ no_result，试满上限，error 记词数', async () => {
    const stub = site(() => page(EMPTY));
    const result = await searchAdmission(source(url), {
      fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0, keywordFallback: true,
    });
    expect(result.verdict).toBe('no_result');
    expect(result.error).toBe(`bookList 未解析出候选（试 ${ADMISSION_MAX_KEYWORD_TRIES} 词）`);
    expect(stub.keywords).toEqual([...DEFAULT_ADMISSION_KEYWORDS]);
  });

  it('预算不足即停：canRetryKeyword 判否 ⇒ 不再换词，以已得 no_result 收尾', async () => {
    const stub = site(() => page(EMPTY));
    const denied = await searchAdmission(source(url), {
      fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0, keywordFallback: true,
      canRetryKeyword: () => false,
    });
    expect(stub.keywords).toEqual(['斗破苍穹']);
    expect(denied).toEqual({ verdict: 'no_result', candidateCount: 0, status: 200, error: 'bookList 未解析出候选' });

    const once = vi.fn<() => boolean>().mockReturnValueOnce(true).mockReturnValue(false);
    const stub2 = site(() => page(EMPTY));
    const partial = await searchAdmission(source(url), {
      fetchPage: stub2.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0, keywordFallback: true,
      canRetryKeyword: once,
    });
    expect(stub2.keywords).toEqual(['斗破苍穹', '我的']);
    expect(partial.error).toBe('bookList 未解析出候选（试 2 词）');
  });

  it('缺省关（纯函数调用方）：只试主关键词，结果逐字同改前', async () => {
    const stub = site(() => page(EMPTY));
    const result = await searchAdmission(source(url), {
      fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0,
    });
    expect(result).toEqual({ verdict: 'no_result', candidateCount: 0, status: 200, error: 'bookList 未解析出候选' });
    expect(stub.fetchPage).toHaveBeenCalledOnce();
  });

  it('非 no_result（challenge / conn_fail / 5xx）不换词', async () => {
    for (const respond of [
      () => page('blocked', 403),
      () => page('oops', 502),
      () => Promise.reject(new TypeError('fetch failed')),
    ]) {
      const stub = site(respond);
      await searchAdmission(source(url), {
        fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0, keywordFallback: true,
      });
      expect(stub.fetchPage).toHaveBeenCalledOnce();
    }
  });

  it('换词之间补同站节流间隔', async () => {
    const sleep = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(async () => {});
    const stub = site(() => page(EMPTY));
    await searchAdmission(source(url), {
      fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 350, sleep, keywordFallback: true,
    });
    // 每次换词前 1 次（2 次），admissionFetch 内部节流在首请求时不等待。
    expect(sleep.mock.calls.filter(([ms]) => ms === 350).length).toBeGreaterThanOrEqual(2);
  });

  describe('query_insensitive 语义不被多词破坏', () => {
    it('固定列表站：首词即命中，照常被对照抓出（不会因换词被放过）', async () => {
      const stub = site(() => page(list('/b/1', '/b/2')));
      const result = await searchAdmission(source(url), {
        fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0,
        keywordFallback: true, controlQuery: true,
      });
      expect(result.verdict).toBe('query_insensitive');
      expect(stub.keywords).toEqual(['斗破苍穹', queryControlKeyword('斗破苍穹')]);
    });

    it('次词命中、对照是另一批书 ⇒ ok（不误判）', async () => {
      const stub = site((keyword) => page(
        keyword === '我的' ? list('/b/1', '/b/2') : keyword === '凡人修仙传' ? list('/b/9') : EMPTY));
      const result = await searchAdmission(source(url), {
        fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0,
        keywordFallback: true, controlQuery: true,
      });
      expect(result.verdict).toBe('ok');
      expect(stub.keywords).toEqual(['斗破苍穹', '我的', '凡人修仙传']);
    });

    it('次词命中、对照也回同一批 ⇒ query_insensitive', async () => {
      const stub = site((keyword) => page(keyword === '斗破苍穹' ? EMPTY : list('/b/1', '/b/2')));
      const result = await searchAdmission(source(url), {
        fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0,
        keywordFallback: true, controlQuery: true,
      });
      expect(result.verdict).toBe('query_insensitive');
    });

    it('对照词按「命中的那个词」选：自带词「修仙」miss、「斗破苍穹」命中 ⇒ 对照取凡人修仙传（与修仙有公共字，本不可用）', async () => {
      // 若误按主关键词（修仙）选对照，会取「诡秘之主」；按命中词（斗破苍穹）选才是「凡人修仙传」。
      expect(queryControlKeyword('修仙')).toBe('诡秘之主');
      const stub = site((keyword) => page(keyword === '斗破苍穹' ? list('/b/1') : keyword === '凡人修仙传' ? list('/b/7') : EMPTY));
      const result = await searchAdmission(source(url, { checkKeyWord: '修仙' }), {
        fetchPage: stub.fetchPage, declaredHosts: hosts, signal: signal(), throttleMs: 0,
        keywordFallback: true, controlQuery: true,
      });
      expect(result.verdict).toBe('ok');
      expect(stub.keywords).toEqual(['修仙', '斗破苍穹', '凡人修仙传']);
    });
  });

  describe('批次：名额按源计、换词按 canProbe 逐次判预算', () => {
    it('一个源试 3 个词只占 1 个名额；名额 1 ⇒ 第二个源不探', async () => {
      const other = 'https://kw2.example.com';
      const stub = site(() => page(EMPTY));
      const result = await runAdmissionBatch({
        candidates: [{ url, source: source(url) }, { url: other, source: source(other) }],
        declaredHosts: new Set(['kw.example.com', 'kw2.example.com']), existing: new Map(),
        fetchPage: stub.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 1, keywordFallback: true,
      });
      expect(result.probed).toBe(1);
      expect(stub.fetchPage).toHaveBeenCalledTimes(ADMISSION_MAX_KEYWORD_TRIES);
      expect(result.rows.find((r) => r.source_url === other)).toMatchObject({ search_ok: null }); // 占位，下轮接着测
    });

    it('起探后预算见底：第三个词前 canProbe 判否 ⇒ 停在两词', async () => {
      const canProbe = vi.fn<() => boolean>()
        .mockReturnValueOnce(true) // 起探
        .mockReturnValueOnce(true) // 换第 2 词前
        .mockReturnValue(false); // 换第 3 词前
      const stub = site(() => page(EMPTY));
      const result = await runAdmissionBatch({
        candidates: [{ url, source: source(url) }], declaredHosts: hosts, existing: new Map(),
        fetchPage: stub.fetchPage, signal: signal(), throttleMs: 0, keywordFallback: true, canProbe,
      });
      expect(stub.keywords).toEqual(['斗破苍穹', '我的']);
      expect(result.rows[0]).toMatchObject({ search_verdict: 'no_result', error: 'bookList 未解析出候选（试 2 词）' });
    });

    it('批次缺省不开兜底（单测/旧调用方逐字不变）', async () => {
      const stub = site(() => page(EMPTY));
      await runAdmissionBatch({
        candidates: [{ url, source: source(url) }], declaredHosts: hosts, existing: new Map(),
        fetchPage: stub.fetchPage, signal: signal(), throttleMs: 0,
      });
      expect(stub.fetchPage).toHaveBeenCalledOnce();
    });
  });
});

describe('改法1 challenge 有限复测', () => {
  const url = 'https://wall.example.com';
  const src = source(url);
  const hash = rulesHash(src);
  const hosts = new Set(['wall.example.com']);
  const challengeRow = (hoursAgo: number, error: string, rulesHashValue = hash) => new Map([[url, row(url, {
    rules_hash: rulesHashValue, search_ok: false, search_verdict: 'challenge', error,
    search_checked_at: hoursAgoIso(hoursAgo), host: 'wall.example.com',
  })]]);
  const run = (existing: Map<string, AdmissionSourceRow>, fetchPage: AdmissionTransport) => runAdmissionBatch({
    candidates: [{ url, source: src }], declaredHosts: hosts, existing, fetchPage,
    signal: signal(), throttleMs: 0, now: atFixtureNow,
  });
  const blocked = () => vi.fn<AdmissionTransport>().mockResolvedValue(page('blocked', 403));

  it('桶口径不变：challenge 仍 rejected（出池、漏斗 SQL 不动）', () => {
    expect(admissionBucket('challenge')).toBe('rejected');
  });

  it('首次判 challenge 写 strike 1；强标记形态同样带前缀', async () => {
    const first = await runAdmissionBatch({
      candidates: [{ url, source: src }], declaredHosts: hosts, existing: new Map(),
      fetchPage: blocked(), signal: signal(), throttleMs: 0,
    });
    expect(first.rows[0]).toMatchObject({
      search_ok: false, search_verdict: 'challenge', error: `${ADMISSION_CHALLENGE_STRIKE_PREFIX}1:403`,
    });
    const marker = await runAdmissionBatch({
      candidates: [{ url, source: src }], declaredHosts: hosts, existing: new Map(),
      fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page('<title>Just a moment...</title>')),
      signal: signal(), throttleMs: 0,
    });
    expect(marker.rows[0].error).toBe(`${ADMISSION_CHALLENGE_STRIKE_PREFIX}1:just a moment`);
  });

  it('72h 窗：71h 不复测、73h 到期复测；旧行（无前缀）按 1 次计 ⇒ 再挡写 strike 2', async () => {
    expect((await run(challengeRow(71, '403'), blocked())).probed).toBe(0);
    const due = await run(challengeRow(73, '403'), blocked());
    expect(due.probed).toBe(1);
    expect(due.rows[0]).toMatchObject({ search_verdict: 'challenge', error: `${ADMISSION_CHALLENGE_STRIKE_PREFIX}2:403` });
  });

  it('偶发质询恢复：到期复测拿到候选 ⇒ ok 回池', async () => {
    const recovered = await run(challengeRow(73, `${ADMISSION_CHALLENGE_STRIKE_PREFIX}2:403`),
      vi.fn<AdmissionTransport>().mockResolvedValue(page(list('/b/1'))));
    expect(recovered.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok', error: '' });
  });

  it('重试上限：strike 满额后回终态，30 天后仍不复测', async () => {
    const last = await run(challengeRow(73, `${ADMISSION_CHALLENGE_STRIKE_PREFIX}${ADMISSION_CHALLENGE_MAX_STRIKES - 1}:403`), blocked());
    expect(last.rows[0].error).toBe(`${ADMISSION_CHALLENGE_STRIKE_PREFIX}${ADMISSION_CHALLENGE_MAX_STRIKES}:403`);
    const fetchPage = blocked();
    const capped = await run(challengeRow(30 * 24, last.rows[0].error), fetchPage);
    expect(capped.probed).toBe(0);
    expect(capped.rows).toHaveLength(0);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('规则一变（rules_hash 变）照常重排，strike 从头计', async () => {
    const changed = await run(
      challengeRow(1, `${ADMISSION_CHALLENGE_STRIKE_PREFIX}${ADMISSION_CHALLENGE_MAX_STRIKES}:403`, 'stale-hash'), blocked());
    expect(changed.probed).toBe(1);
    expect(changed.rows[0].error).toBe(`${ADMISSION_CHALLENGE_STRIKE_PREFIX}1:403`);
  });

  it('在池 ok 行复核遇 challenge：仍走 recheck strike 不出池（B2 语义不变）', async () => {
    const existing = new Map([[url, row(url, {
      rules_hash: hash, search_ok: true, search_verdict: 'ok', search_checked_at: hoursAgoIso(8 * 24),
    })]]);
    const result = await run(existing, blocked());
    expect(result.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok', error: 'recheck_fail:challenge' });
  });

  it('challengeStrikes 解析：非 challenge 0、无前缀 1、坏计数按 1', () => {
    expect(challengeStrikes({ search_verdict: 'ok', error: '' })).toBe(0);
    expect(challengeStrikes({ search_verdict: 'challenge', error: '403' })).toBe(1);
    expect(challengeStrikes({ search_verdict: 'challenge', error: `${ADMISSION_CHALLENGE_STRIKE_PREFIX}x:403` })).toBe(1);
    expect(challengeStrikes({ search_verdict: 'challenge', error: `${ADMISSION_CHALLENGE_STRIKE_PREFIX}2:403` })).toBe(2);
  });
});

describe('改法2 http bookSourceUrl 升 https 参与初筛', () => {
  it('selectCandidates：http:// 放行；无协议 / 其它 scheme / 空照旧丢弃；https 不变', () => {
    const cases: [string, boolean][] = [
      ['https://a.example.com/', true],
      ['http://a.example.com/', true],
      ['HTTP://a.example.com/', true],
      ['爱发电', false],
      ['a.example.com', false],
      ['ftp://a.example.com/', false],
      ['//a.example.com/', false],
      ['', false],
    ];
    for (const [bookSourceUrl, pass] of cases) {
      const s = { ...source('https://a.example.com/'), bookSourceUrl };
      expect(selectCandidates([s]).length, bookSourceUrl).toBe(pass ? 1 : 0);
    }
  });

  it('compileAdmission：http 源通过初筛并照常编译（M1）', () => {
    expect(compileAdmission(source('http://up.example.com/')).ok).toBe(true);
  });

  it('升级后的 URL 真正用于请求：相对 / 写死 http 的搜索模板都打 https', async () => {
    for (const searchUrl of ['/s?q={{key}}', 'http://up.example.com/s?q={{key}}']) {
      const stub = site(() => page(list('/b/1')));
      const result = await searchAdmission(source('http://up.example.com/', { searchUrl }), {
        fetchPage: stub.fetchPage, declaredHosts: new Set(['up.example.com']), signal: signal(), throttleMs: 0,
      });
      expect(result.verdict, searchUrl).toBe('ok');
      expect(stub.urls[0]).toMatch(/^https:\/\/up\.example\.com\/s\?q=/);
    }
  });

  it('SSRF 锁不放宽：私网/环回 IP、非 443 端口、userinfo、未声明 host 升级后仍 url_invalid 且不发请求', async () => {
    const cases: [string, string][] = [
      ['http://10.0.0.1/', '10.0.0.1'],
      ['http://127.0.0.1/', '127.0.0.1'],
      ['http://[::1]/', '[::1]'],
      ['http://up.example.com:8080/', 'up.example.com'],
      ['http://user@up.example.com/', 'up.example.com'],
      ['http://up.example.com/', 'other.example.com'],
    ];
    for (const [bookSourceUrl, declared] of cases) {
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(list('/b/1')));
      const result = await searchAdmission(source('https://placeholder.example/', {
        bookSourceUrl, searchUrl: '/s?q={{key}}',
      }), { fetchPage, declaredHosts: new Set([declared]), signal: signal(), throttleMs: 0 });
      expect(result.verdict, bookSourceUrl).toBe('url_invalid');
      expect(fetchPage, bookSourceUrl).not.toHaveBeenCalled();
    }
  });

  it('source_url 键不变：行键仍是库里原样的 http:// URL，host 列同 hostname（不会出新旧两行）', async () => {
    const key = 'http://up.example.com';
    const src = source(`${key}/`, { searchUrl: '/s?q={{key}}' });
    const result = await runAdmissionBatch({
      candidates: [{ url: key, source: src }], declaredHosts: new Set(['up.example.com']), existing: new Map(),
      fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page(list('/b/1'))), signal: signal(), throttleMs: 0,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ source_url: key, host: 'up.example.com', search_ok: true });
    // rules_hash 仍按上游原文算（bookSourceUrl 未被改写），下一轮同输入同 hash ⇒ 不重复排队。
    expect(result.rows[0].rules_hash).toBe(rulesHash(src));
  });

  describe('放量控制：http 升级源首探每轮上限', () => {
    const http = (n: number) => `http://h${n}.example.com`;
    const https = (n: number) => `https://s${n}.example.com`;
    const candidates = [http(1), https(1), http(2), https(2), http(3)]
      .map((url) => ({ url, source: source(`${url}/`) }));
    const declaredHosts = new Set(candidates.map(({ url }) => new URL(url).hostname));
    // 每次请求新建 Response（同一实例的 body 只能读一次）。
    const ok = () => vi.fn<AdmissionTransport>(async () => page(list('/b/1')));

    it('env 解析：缺失/非法/负数回落默认 10；0 合法（暂停）', () => {
      expect(DEFAULT_ADMISSION_UPGRADED_MAX_PROBES).toBe(10);
      expect(admissionUpgradedMaxProbes({})).toBe(10);
      for (const bad of ['abc', '-1', '']) expect(admissionUpgradedMaxProbes({ ADMISSION_UPGRADED_MAX_PROBES: bad })).toBe(10);
      expect(admissionUpgradedMaxProbes({ ADMISSION_UPGRADED_MAX_PROBES: '0' })).toBe(0);
      expect(admissionUpgradedMaxProbes({ ADMISSION_UPGRADED_MAX_PROBES: '30' })).toBe(30);
    });

    it('上限 1：http 源本轮只首探 1 个，名额让给 https 源；没轮到的写未测占位', async () => {
      const result = await runAdmissionBatch({
        candidates, declaredHosts, existing: new Map(), fetchPage: ok(), signal: signal(), throttleMs: 0,
        maxProbes: 10, upgradedMaxProbes: 1,
      });
      expect(result.probed).toBe(3);
      const probed = result.rows.filter((r) => r.search_ok === true).map((r) => r.source_url);
      expect(probed).toEqual([http(1), https(1), https(2)]);
      expect(result.rows.filter((r) => r.search_ok === null).map((r) => r.source_url)).toEqual([http(2), http(3)]);
    });

    it('上限 0 = 暂停：http 源一个都不首探，https 源不受影响', async () => {
      const result = await runAdmissionBatch({
        candidates, declaredHosts, existing: new Map(), fetchPage: ok(), signal: signal(), throttleMs: 0,
        maxProbes: 10, upgradedMaxProbes: 0,
      });
      expect(result.rows.filter((r) => r.search_ok === true).map((r) => r.source_url)).toEqual([https(1), https(2)]);
    });

    it('只管首探：测过的 http 源复测到期不受上限约束', async () => {
      const key = http(1);
      const src = source(`${key}/`);
      const existing = new Map([[key, row(key, {
        rules_hash: rulesHash(src), search_ok: false, search_verdict: 'http_5xx', search_checked_at: hoursAgoIso(21),
      })]]);
      const result = await runAdmissionBatch({
        candidates: [{ url: key, source: src }], declaredHosts, existing, fetchPage: ok(), signal: signal(),
        throttleMs: 0, now: atFixtureNow, upgradedMaxProbes: 0,
      });
      expect(result.probed).toBe(1);
      expect(result.rows[0]).toMatchObject({ search_ok: true });
    });
  });
});
