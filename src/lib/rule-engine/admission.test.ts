import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import corpus from './fixtures/admission-174.json';
import {
  ADMISSION_RETEST_INTERVAL_MS, admissionBucket, compileAdmission, runAdmissionBatch, searchAdmission,
  rulesHash, type AdmissionSourceRow, type AdmissionTransport,
} from './admission';
import { isForbiddenHostAddress, validateSourceUrl } from '@/lib/source-policy';
import type { RawSource } from './compile-smoke';

// 设计依据：m1-engine-design.md v3 §4.1–§4.4 / §6.1 / §9 任务 3。
// 传输层注入（fetchPage）但**校验函数不 mock**——所有 URL 判定走真的 checkSourceUrl 系列。

type FixtureSource = {
  name: string; bookSourceName: string; bookSourceUrl: string; searchUrl: string;
  checkKeyWord: string | null; ruleSearch?: Record<string, unknown>;
  ruleBookInfo?: Record<string, unknown>; ruleToc?: Record<string, unknown>;
  ruleContent?: Record<string, unknown>;
};
const sources = corpus as unknown as FixtureSource[];

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };
const page = (body: string, status = 200) => new Response(body, { status, headers: HTML_HEADERS });
const signal = () => new AbortController().signal;

function sourceRow(url: string, over: Partial<AdmissionSourceRow> = {}): AdmissionSourceRow {
  return {
    source_url: url, tier: 'T7', compile_ok: false, core_field_mask: {}, search_ok: null,
    search_verdict: '', search_checked_at: null, rules_hash: '', host: '', error: '', ...over,
  };
}

function syntheticSource(url: string, over: Partial<RawSource> = {}): RawSource {
  return {
    bookSourceUrl: url, bookSourceName: '合成源', searchUrl: `https://${new URL(url).hostname}/s?q={{key}}`,
    checkKeyWord: '测试关键字',
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
    ...over,
  } as RawSource;
}

describe('滤网 1 compileAdmission（纯本地）', () => {
  it('174 源核心字段可解释 = 104（N03 必需组后新冻结数字；原 114 里 10 条缺 ruleToc.chapterUrl）', () => {
    const ok = sources.filter((source) => compileAdmission(source).ok);
    expect(ok.length).toBe(104);
  });

  it('未通过 survey 初筛（无 {{key}} 搜索模板）判 T7 拒，且不进 compile', () => {
    const result = compileAdmission(syntheticSource('https://a.example.com/', { searchUrl: 'https://a.example.com/s?q=1' }));
    expect(result.ok).toBe(false);
    expect(result.tier).toBe('T7');
    expect(result.reason).toContain('survey 初筛');
  });

  it('核心字段含不支持构件（xpath / @js:）→ compile 拒，理由落到字段', () => {
    const xpath = compileAdmission(syntheticSource('https://a.example.com/', {
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '//div/a' },
    }));
    expect(xpath.ok).toBe(false);
    expect(xpath.reason).toContain('ruleSearch.author');
    expect(xpath.tier).toBe('T7');
  });

  it('book15 核心字段全可解释（M1 对拍基线不被滤网 1 误杀）', () => {
    const book15 = sources.find((source) => source.name === '📂网阅小说');
    expect(book15).toBeDefined();
    expect(compileAdmission(book15!).ok).toBe(true);
  });
});

describe('滤网 2 searchAdmission 判定分桶', () => {
  const declared = (...hosts: string[]) => new Set(hosts);

  it('200 且 bookList 解析出候选 → ok', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const result = await searchAdmission(syntheticSource('https://ok.example.com/'), {
      fetchPage, declaredHosts: declared('ok.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result).toEqual({ verdict: 'ok', candidateCount: 1, status: 200, error: '' });
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('403 → challenge（rejected）；503 同样判 challenge 不落 http_5xx', async () => {
    for (const status of [403, 503]) {
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('blocked', status));
      const result = await searchAdmission(syntheticSource('https://wall.example.com/'), {
        fetchPage, declaredHosts: declared('wall.example.com'), signal: signal(), throttleMs: 0,
      });
      expect(result.verdict).toBe('challenge');
      expect(admissionBucket(result.verdict)).toBe('rejected');
    }
  });

  it('challenge 双条件：200 + 弱标记 cloudflare 不判墙，200 + 强标记才判墙', async () => {
    const weak = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>cloudflare cdn normal page</html>'));
    const weakResult = await searchAdmission(syntheticSource('https://cf.example.com/'), {
      fetchPage: weak, declaredHosts: declared('cf.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(weakResult.verdict).not.toBe('challenge');

    const strong = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>Just a moment...</html>'));
    const strongResult = await searchAdmission(syntheticSource('https://cf.example.com/'), {
      fetchPage: strong, declaredHosts: declared('cf.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(strongResult.verdict).toBe('challenge');
  });

  // P1-2（复审裁定）：强标记先判会把正常 200 搜索页判成 challenge 终态（rejected 24h 不重测）。
  // 判定顺序改为「候选计数先于强标记」——有 ≥1 候选一律 ok，墙只在 403/503 或 0 候选+强标记成立。
  describe('P1-2 候选计数先于强标记（正常页不得判墙）', () => {
    const candidateHtml = (footer: string) =>
      `<html><body><div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>${footer}</body></html>`;

    it.each(['安全验证', 'enable javascript', '人机验证', '请开启 javascript', 'ddos protection by'])(
      '200 + 合法候选 + 强标记「%s」→ ok（不判墙）', async (marker) => {
        const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(candidateHtml(`<footer>${marker}</footer>`)));
        const result = await searchAdmission(syntheticSource('https://normal.example.com/'), {
          fetchPage, declaredHosts: declared('normal.example.com'), signal: signal(), throttleMs: 0,
        });
        expect(result).toEqual({ verdict: 'ok', candidateCount: 1, status: 200, error: '' });
        expect(admissionBucket(result.verdict)).toBe('ok');
      });

    it('200 + 无候选 + 同一批强标记 → challenge（原语义保留，仍不硬刚）', async () => {
      for (const marker of ['安全验证', 'enable javascript', '人机验证']) {
        const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(`<html><body>${marker}</body></html>`));
        const result = await searchAdmission(syntheticSource('https://wall.example.com/'), {
          fetchPage, declaredHosts: declared('wall.example.com'), signal: signal(), throttleMs: 0,
        });
        expect(result.verdict, marker).toBe('challenge');
        expect(admissionBucket(result.verdict)).toBe('rejected');
      }
    });

    it('200 + 候选 + 弱标记 cloudflare → ok（回归）', async () => {
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(candidateHtml('<footer>cloudflare</footer>')));
      const result = await searchAdmission(syntheticSource('https://cdn.example.com/'), {
        fetchPage, declaredHosts: declared('cdn.example.com'), signal: signal(), throttleMs: 0,
      });
      expect(result.verdict).toBe('ok');
    });

    it('403/503 → challenge，不论有无候选（回归）', async () => {
      for (const status of [403, 503]) {
        for (const body of [candidateHtml(''), '<html><body>no results</body></html>']) {
          const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(body, status));
          const result = await searchAdmission(syntheticSource('https://wall.example.com/'), {
            fetchPage, declaredHosts: declared('wall.example.com'), signal: signal(), throttleMs: 0,
          });
          expect(result.verdict, `${status} ${body.length}`).toBe('challenge');
        }
      }
    });

    it('200 + 无候选 + 无标记 → no_result（deferred，未受重排影响）', async () => {
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html><body>no results</body></html>'));
      const result = await searchAdmission(syntheticSource('https://empty.example.com/'), {
        fetchPage, declaredHosts: declared('empty.example.com'), signal: signal(), throttleMs: 0,
      });
      expect(result).toEqual({ verdict: 'no_result', candidateCount: 0, status: 200, error: 'bookList 未解析出候选' });
    });
  });

  it('网络层失败 → conn_fail（rejected）；500 → http_5xx（deferred）', async () => {
    const down = vi.fn<AdmissionTransport>().mockRejectedValue(new TypeError('fetch failed'));
    const downResult = await searchAdmission(syntheticSource('https://down.example.com/'), {
      fetchPage: down, declaredHosts: declared('down.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(downResult.verdict).toBe('conn_fail');
    expect(admissionBucket(downResult.verdict)).toBe('rejected');

    const err = vi.fn<AdmissionTransport>().mockResolvedValue(page('boom', 500));
    const errResult = await searchAdmission(syntheticSource('https://err.example.com/'), {
      fetchPage: err, declaredHosts: declared('err.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(errResult.verdict).toBe('http_5xx');
    expect(admissionBucket(errResult.verdict)).toBe('deferred');
  });

  it('空壳 + script 且无标题/正文标记 → shell（rejected）', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<body><script>a()</script><script>b()</script></body>'));
    const result = await searchAdmission(syntheticSource('https://shell.example.com/'), {
      fetchPage, declaredHosts: declared('shell.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('shell');
    expect(admissionBucket(result.verdict)).toBe('rejected');
  });

  it('跳转逐跳复验：Location 越出声明 host 集合 → url_invalid，声明集内 → 跟随', async () => {
    const out = vi.fn<AdmissionTransport>().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://evil.example.net/x' } }));
    const outResult = await searchAdmission(syntheticSource('https://redir.example.com/'), {
      fetchPage: out, declaredHosts: declared('redir.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(outResult.verdict).toBe('url_invalid');

    const inner = vi.fn<AdmissionTransport>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://ok.example.com/next' } }))
      .mockResolvedValueOnce(page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const innerResult = await searchAdmission(syntheticSource('https://redir.example.com/'), {
      fetchPage: inner, declaredHosts: declared('redir.example.com', 'ok.example.com'), signal: signal(), throttleMs: 0,
    });
    expect(innerResult.verdict).toBe('ok');
    expect(inner).toHaveBeenCalledTimes(2);
  });

  // checkKeyWord 取值（legado 标准嵌套位置优先）：DB 995 源顶层 checkKeyWord=0 行，
  // 实际都在 ruleSearch.checkKeyWord。全用兜底词曾致 kanshuw 超时 / czhiyao 搜兜底词 0 结果。
  describe('expandAdmissionSearchUrl 的 checkKeyWord 取值（嵌套优先）', () => {
    const candidateHtml = '<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>';
    const defaultRules = { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' };
    // over.ruleSearch 与默认核心规则合并（bookList 等不能被 checkKeyWord 用例冲掉）。
    const assertUrlKeyword = async (over: Partial<RawSource>, expected: string) => {
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(candidateHtml));
      const { ruleSearch, ...rest } = over;
      const source = syntheticSource('https://kw.example.com/', {
        ...rest, ruleSearch: { ...defaultRules, ...(ruleSearch as Record<string, unknown> | undefined) },
      });
      const result = await searchAdmission(source, {
        fetchPage, declaredHosts: declared('kw.example.com'), signal: signal(), throttleMs: 0,
      });
      expect(result.verdict).toBe('ok');
      expect(fetchPage.mock.calls[0][0]).toBe(`https://kw.example.com/s?q=${encodeURIComponent(expected)}`);
    };

    it('嵌套 ruleSearch.checkKeyWord 生效（源自带词，非兜底词）', async () => {
      await assertUrlKeyword({ ruleSearch: { checkKeyWord: '我的' } }, '我的');
    });

    it('嵌套为空白时回落顶层 checkKeyWord（非标准源兼容）', async () => {
      await assertUrlKeyword({ checkKeyWord: '山海经', ruleSearch: { checkKeyWord: '  ' } }, '山海经');
    });

    it('无嵌套时顶层 checkKeyWord 生效', async () => {
      // syntheticSource 默认顶层 checkKeyWord=「测试关键字」、ruleSearch 无该字段。
      await assertUrlKeyword({}, '测试关键字');
    });

    it('嵌套与顶层都无 → 落 DEFAULT_ADMISSION_KEYWORD（现有行为不变）', async () => {
      await assertUrlKeyword({ checkKeyWord: '' }, '斗破苍穹');
    });
  });
});

describe('滤网 2 IP/私网负例（v3 E4：两把锁同防线）', () => {
  const NEGATIVES = [
    'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://172.16.0.1/x',
    'https://192.168.1.1/x', 'https://169.254.0.1/x', 'https://[::1]/x', 'https://[fc00::1]/x',
  ];

  it.each(NEGATIVES)('声明集即使含该 IP，%s 仍被 validateAdmissionUrl 拒（url_invalid，不发请求）', async (base) => {
    const host = new URL(base).hostname;
    const source = syntheticSource(base, {
      searchUrl: `${base.replace(/\/x$/, '/s')}?q={{key}}`,
    });
    const fetchPage = vi.fn<AdmissionTransport>();
    const result = await searchAdmission(source, {
      fetchPage, declaredHosts: new Set([host]), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).toBe('url_invalid');
    expect(admissionBucket(result.verdict)).toBe('deferred');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('isForbiddenHostAddress 覆盖 IPv4 全段与 IPv6 字面量', () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '8.8.8.8', '[::1]', '[fc00::1]', '[::ffff:127.0.0.1]']) {
      expect(isForbiddenHostAddress(host), host).toBe(true);
    }
    for (const host of ['book15.net', 'mirror.example.net', '127.0.0.1.evil.com']) {
      expect(isForbiddenHostAddress(host), host).toBe(false);
    }
  });
});

describe('两把锁判别性用例（v3 E3 正例+负例）', () => {
  // H ∈ shuyuan_sources 声明集 ∧ H ∉ admission-ok ∧ H ≠ book15
  const H = 'https://mirror.example.net/';
  const host = 'mirror.example.net';

  it('① validateAdmissionUrl 放行：请求真发出，且不是 url_invalid', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const result = await searchAdmission(syntheticSource(H), {
      fetchPage, declaredHosts: new Set([host]), signal: signal(), throttleMs: 0,
    });
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(String(fetchPage.mock.calls[0][0])).toContain(host);
    expect(result.verdict).not.toBe('url_invalid');
  });

  it('② 同一 H 过运行时门 validateSourceUrl 必抛（两把锁判别性成立）', () => {
    expect(() => validateSourceUrl(H)).toThrow();
  });
});

describe('准入状态机 runAdmissionBatch', () => {
  it('174 源一轮 mock 准入：104 compile-ok / 70 compile 拒，真实搜索 ≤5，未探测占位可续测', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html><body>no results</body></html>'));
    const declaredHosts = new Set(sources.map((source) => new URL(source.bookSourceUrl).hostname));
    const result = await runAdmissionBatch({
      candidates: sources.map((source) => ({ url: new URL(source.bookSourceUrl).href.replace(/\/$/, ''), source })),
      declaredHosts, existing: new Map(), fetchPage, signal: signal(), throttleMs: 0,
    });
    expect(result.compileOk).toBe(104);
    expect(result.compileRejected).toBe(70);
    expect(result.probed).toBe(5);
    expect(fetchPage).toHaveBeenCalledTimes(5);
    // 200 但 bookList 无候选 → no_result（deferred 桶，下轮可复测），不是 ok/rejected。
    expect(result.verdicts).toEqual({ no_result: 5 });
    for (const row of result.rows.filter((item) => item.search_verdict === 'no_result')) {
      expect(admissionBucket(row.search_verdict)).toBe('deferred');
      expect(row.search_ok).toBe(false);
    }
    // 全部 174 源都有行（104 通过 + 70 拒），未轮到的通过源写未测占位。
    expect(result.rows).toHaveLength(174);
    expect(result.rows.filter((row) => row.compile_ok && row.search_ok === null)).toHaveLength(99);
    for (const row of result.rows.filter((item) => !item.compile_ok)) {
      expect(row.tier).toBe('T7');
      expect(row.host).not.toBe('');
    }
  });

  it('合成源覆盖六种分桶：ok / challenge / conn_fail / http_5xx / shell / url_invalid', async () => {
    const candidates = [
      { url: 'https://ok.example.com', source: syntheticSource('https://ok.example.com/') },
      { url: 'https://wall.example.com', source: syntheticSource('https://wall.example.com/') },
      { url: 'https://down.example.com', source: syntheticSource('https://down.example.com/') },
      { url: 'https://err.example.com', source: syntheticSource('https://err.example.com/') },
      { url: 'https://shell.example.com', source: syntheticSource('https://shell.example.com/') },
      { url: 'https://127.0.0.1', source: syntheticSource('https://127.0.0.1/', { searchUrl: 'https://127.0.0.1/s?q={{key}}' }) },
    ];
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async (input) => {
      const host = new URL(input).hostname;
      if (host === 'ok.example.com') return page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>');
      if (host === 'wall.example.com') return page('Just a moment...', 403);
      if (host === 'down.example.com') throw new TypeError('fetch failed');
      if (host === 'err.example.com') return page('boom', 500);
      if (host === 'shell.example.com') return page('<body><script>a()</script><script>b()</script></body>');
      throw new Error('IP 直连不应发出请求');
    });
    const result = await runAdmissionBatch({
      candidates,
      declaredHosts: new Set(candidates.map(({ url }) => new URL(url).hostname)),
      existing: new Map(), fetchPage, signal: signal(), throttleMs: 0, maxProbes: 6,
    });
    expect(result.verdicts).toEqual({
      ok: 1, challenge: 1, conn_fail: 1, http_5xx: 1, shell: 1, url_invalid: 1,
    });
    const byVerdict = new Map(result.rows.map((row) => [row.search_verdict, row]));
    expect(byVerdict.get('ok')!.search_ok).toBe(true);
    expect(admissionBucket('challenge')).toBe('rejected');
    expect(admissionBucket('conn_fail')).toBe('rejected');
    expect(admissionBucket('shell')).toBe('rejected');
    expect(admissionBucket('http_5xx')).toBe('deferred');
    expect(admissionBucket('url_invalid')).toBe('deferred');
    expect(admissionBucket('ok')).toBe('ok');
  });

  it('deferred 每 24h 重测：超窗复测转 ok，未超窗不重测', async () => {
    const url = 'https://retry.example.com';
    const source = syntheticSource('https://retry.example.com/');
    const hash = rulesHash(source);
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    // 未超窗：24h 内不重测。
    const fresh = new Map([[url, sourceRow(url, {
      compile_ok: true, rules_hash: hash, search_ok: false, search_verdict: 'http_5xx',
      search_checked_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })]]);
    const skipped = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['retry.example.com']),
      existing: fresh, fetchPage, signal: signal(), throttleMs: 0,
    });
    expect(skipped.rows).toHaveLength(0);
    expect(fetchPage).not.toHaveBeenCalled();

    // 超窗：25h 后重测 → ok，search_checked_at 刷新。
    const stale = new Map([[url, sourceRow(url, {
      compile_ok: true, rules_hash: hash, search_ok: false, search_verdict: 'http_5xx',
      search_checked_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    })]]);
    const retested = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['retry.example.com']),
      existing: stale, fetchPage, signal: signal(), throttleMs: 0,
    });
    expect(retested.probed).toBe(1);
    expect(retested.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok' });
    expect(Date.parse(retested.rows[0].search_checked_at!)).toBeGreaterThan(Date.now() - ADMISSION_RETEST_INTERVAL_MS);
  });

  it('compile 拒是终态：规则未变不复测、不重写；规则变才重跑滤网 1', async () => {
    const url = 'https://static.example.com';
    const bad = syntheticSource('https://static.example.com/', { ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '//x' } });
    const fetchPage = vi.fn<AdmissionTransport>();
    const existing = new Map([[url, sourceRow(url, { compile_ok: false, tier: 'T7', rules_hash: rulesHash(bad) })]]);
    const unchanged = await runAdmissionBatch({
      candidates: [{ url, source: bad }], declaredHosts: new Set(['static.example.com']),
      existing, fetchPage, signal: signal(), throttleMs: 0,
    });
    expect(unchanged.rows).toHaveLength(0);
    expect(fetchPage).not.toHaveBeenCalled();

    const fixed = syntheticSource('https://static.example.com/');
    const changed = await runAdmissionBatch({
      candidates: [{ url, source: fixed }], declaredHosts: new Set(['static.example.com']),
      existing, fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>x</html>')),
      signal: signal(), throttleMs: 0,
    });
    expect(changed.rows).toHaveLength(1);
    expect(changed.rows[0].compile_ok).toBe(true);
  });

  it('预算闸（canProbe=false）时不发网络请求，但仍为规则变过的源写下未测占位', async () => {
    const url = 'https://budget.example.com';
    const source = syntheticSource('https://budget.example.com/');
    const fetchPage = vi.fn<AdmissionTransport>();
    const result = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['budget.example.com']),
      existing: new Map(), fetchPage, signal: signal(), throttleMs: 0, canProbe: () => false,
    });
    expect(result.probed).toBe(0);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.rows[0]).toMatchObject({ compile_ok: true, search_ok: null, search_verdict: '' });
  });

  it('筛选后每轮真实搜索 ≤ maxProbes', async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      url: `https://s${index}.example.com`, source: syntheticSource(`https://s${index}.example.com/`),
    }));
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>no results</html>'));
    const result = await runAdmissionBatch({
      candidates, declaredHosts: new Set(candidates.map(({ url }) => new URL(url).hostname)),
      existing: new Map(), fetchPage, signal: signal(), throttleMs: 0, maxProbes: 3,
    });
    expect(result.probed).toBe(3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------- N03 回归
  describe('N03：缺必需目录规则的源不再 compile_ok（gpt-review-recheck §N03 反例）', () => {
    const full = () => syntheticSource('https://toc.example.com/');
    const noToc = () => syntheticSource('https://toc.example.com/', { ruleToc: undefined });

    it('反例：正常搜索+正文规则、完全删掉 ruleToc → compile 不再 ok，reason 指向必需组', () => {
      const result = compileAdmission(noToc());
      expect(result.ok).toBe(false);
      expect(result.tier).toBe('T7');
      expect(result.reason).toContain('缺少必需规则');
      expect(result.reason).toContain('ruleToc.chapterList');
      expect(result.reason).toContain('ruleToc.chapterUrl');
    });

    it('反例（批次层）：无 ruleToc 的源进 runAdmissionBatch 不再得 compile_ok=true/search 探测', async () => {
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
        page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
      const url = 'https://toc.example.com';
      const result = await runAdmissionBatch({
        candidates: [{ url, source: noToc() }],
        declaredHosts: new Set(['toc.example.com']), existing: new Map(),
        fetchPage, signal: signal(), throttleMs: 0,
      });
      expect(result.compileOk).toBe(0);
      expect(result.probed).toBe(0);
      expect(fetchPage).not.toHaveBeenCalled(); // 省预算：无阅读路径的源不占真实搜索名额
      expect(result.rows[0]).toMatchObject({ compile_ok: false, search_ok: null, search_verdict: '' });
      expect(result.rows[0].error).toContain('ruleToc.chapterList');
    });

    it('单缺 chapterUrl（chapterList/chapterName 在）同样拒——174 池 10 条这类源是收紧对象', () => {
      const result = compileAdmission(syntheticSource('https://toc.example.com/', {
        ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' },
      }));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('ruleToc.chapterUrl');
    });

    it('完整规则照旧 ok；能力可选字段缺失不误杀', () => {
      expect(compileAdmission(full()).ok).toBe(true);
      // 无 author / 无 ruleBookInfo / 无翻页规则 / 无 tocUrl：能力降级，不是阅读路径断裂。
      const minimal = syntheticSource('https://toc.example.com/', {
        ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
        ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
        ruleContent: { content: '.c' },
      });
      const result = compileAdmission(minimal);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe('');
    });
  });

  describe('N03 祖父条款：W1 现网 admitted 池不被新校验打回（红线）', () => {
    const url = 'https://pool.example.com';
    // yingsx 形态：缺 chapterUrl 但其余齐——新校验会拒的存量形态。
    const legacy = () => syntheticSource(url, {
      ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' },
    });
    const admittedRow = (hash: string): [string, AdmissionSourceRow] => [url, sourceRow(url, {
      tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
      search_checked_at: '2026-09-18T00:00:00Z', rules_hash: hash,
    })];

    it('规则未变 ∧ 已在池（compile_ok ∧ search_ok=true）→ 维持既有资格，不写库', async () => {
      const hash = rulesHash(legacy());
      const fetchPage = vi.fn<AdmissionTransport>();
      const result = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }],
        declaredHosts: new Set(['pool.example.com']),
        existing: new Map([admittedRow(hash)]), fetchPage, signal: signal(), throttleMs: 0,
      });
      expect(result.grandfathered).toBe(1);
      expect(result.compileOk).toBe(1); // 计入 ok（资格维持），不再占用 70 拒里
      expect(result.rows).toHaveLength(0); // 不重写——写库会把 compile_ok 打成 false，出池
      expect(fetchPage).not.toHaveBeenCalled(); // search 结论仍有效，无需复测
    });

    it('规则一变（hash 变）→ 祖父条款失效，按新校验拒', async () => {
      const fetchPage = vi.fn<AdmissionTransport>();
      const result = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }],
        declaredHosts: new Set(['pool.example.com']),
        existing: new Map([admittedRow('old-hash-not-matching')]), fetchPage, signal: signal(), throttleMs: 0,
      });
      expect(result.grandfathered).toBe(0);
      expect(result.rows[0]).toMatchObject({ compile_ok: false, tier: 'T7' });
      expect(result.rows[0].error).toContain('ruleToc.chapterUrl');
    });

    it('既有行非 admitted（search_ok=false/null）→ 无豁免，新源无既有行更无豁免', async () => {
      const hash = rulesHash(legacy());
      for (const searchOk of [false, null] as const) {
        const result = await runAdmissionBatch({
          candidates: [{ url, source: legacy() }],
          declaredHosts: new Set(['pool.example.com']),
          existing: new Map([[url, sourceRow(url, {
            tier: 'M1', compile_ok: true, search_ok: searchOk, search_verdict: 'no_result',
            search_checked_at: '2026-09-18T00:00:00Z', rules_hash: hash,
          })]]),
          fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>x</html>')),
          signal: signal(), throttleMs: 0,
        });
        expect(result.grandfathered).toBe(0);
        expect(result.rows[0].compile_ok).toBe(false);
      }
      // 新源（无既有行）：豁免不可能命中。
      const fresh = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }],
        declaredHosts: new Set(['pool.example.com']), existing: new Map(),
        fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0,
      });
      expect(fresh.grandfathered).toBe(0);
      expect(fresh.rows[0].compile_ok).toBe(false);
    });

    it('174 池现实核对：缺 chapterUrl 的 10 条若已有 admitted 行则维持，否则转拒', async () => {
      // W1 四源 ruleToc 三件套齐（yingsx/jhssd 实测在池），走不到祖父分支；
      // 此用例只验证混合批次里 admitted 与未 admitted 的缺 chapterUrl 源分别维持/转拒。
      const hashA = rulesHash(legacy());
      const b = syntheticSource('https://never-probed.example.com', {
        ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' },
      });
      const result = await runAdmissionBatch({
        candidates: [
          { url, source: legacy() },
          { url: 'https://never-probed.example.com', source: b },
        ],
        declaredHosts: new Set(['pool.example.com', 'never-probed.example.com']),
        existing: new Map([admittedRow(hashA)]),
        fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0,
      });
      expect(result.grandfathered).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ source_url: 'https://never-probed.example.com', compile_ok: false });
    });
  });

  // ---------------------------------------------------------------- N04 回归
  describe('N04：公平调度——前 5 个持续失败源不再饿死新源', () => {
    const hosts = Array.from({ length: 6 }, (_, i) => `s${i}.example.com`);
    const candidates = hosts.map((host) => ({ url: `https://${host}`, source: syntheticSource(`https://${host}/`) }));

    it('反例：6 候选前 5 个 HTTP 500，首轮名额给前 5、第 6 个写占位；第 2 轮即被探测（3 轮内）', async () => {
      const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async (input) => {
        const host = new URL(input).hostname;
        return host === 's5.example.com'
          ? page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>')
          : page('boom', 500);
      });
      const fail = vi.fn<AdmissionTransport>().mockImplementation(fetchPage.getMockImplementation()!);

      const existing = new Map<string, AdmissionSourceRow>();
      const runOne = async () => runAdmissionBatch({
        candidates, declaredHosts: new Set(hosts), existing, fetchPage: fail,
        signal: signal(), throttleMs: 0,
      });
      // 轮 1（全新）：5 个名额。未测优先按输入序 → s0..s4 被探测（500 → deferred 占位），
      // s5 未轮到但「库中无行」→ 写未测占位，不再是恒 null 的黑洞。
      const round1 = await runOne();
      expect(round1.probed).toBe(5);
      expect(round1.rows.filter((row) => row.search_ok === null && row.compile_ok)).toHaveLength(1);
      for (const row of round1.rows) existing.set(row.source_url, row);
      const s5Round1 = round1.rows.find((row) => row.source_url === 'https://s5.example.com');
      expect(s5Round1).toMatchObject({ compile_ok: true, search_ok: null });

      // 轮 2（恰好 24h 后，deferred 全部到期）：未测优先 → s5（唯一 search_ok=null）先占名额。
      const round2 = await runOne();
      const probedHosts = fail.mock.calls.map(([input]) => new URL(String(input)).hostname);
      expect(probedHosts).toContain('s5.example.com');
      const s5Round2 = round2.rows.find((row) => row.source_url === 'https://s5.example.com');
      expect(s5Round2).toMatchObject({ search_ok: true, search_verdict: 'ok' });
      for (const row of round2.rows) existing.set(row.source_url, row);

      // 反例原状（旧算法）：3 轮 15 次请求全部落在前 5 个，s5 恒 null。此处 2 轮内已翻案。
      expect(probedHosts.filter((h) => h === 's5.example.com').length).toBe(1);
    });

    it('复测到期者按 search_checked_at 最旧优先（上轮刚测过的排最后，天然轮转）', async () => {
      const now = Date.now();
      const mk = (host: string, checkedAtMs: number): AdmissionSourceRow => sourceRow(`https://${host}`, {
        tier: 'M1', compile_ok: true, search_ok: false, search_verdict: 'http_5xx',
        search_checked_at: new Date(checkedAtMs).toISOString(), rules_hash: rulesHash(syntheticSource(`https://${host}/`)),
      });
      const existing = new Map<string, AdmissionSourceRow>([
        ['https://a-old.example.com', mk('a-old.example.com', now - 72 * 3_600_000)], // 最旧
        ['https://b-mid.example.com', mk('b-mid.example.com', now - 48 * 3_600_000)],
        ['https://c-new.example.com', mk('c-new.example.com', now - 25 * 3_600_000)], // 最新（刚过 24h 窗）
        // d：未测（search_ok=null）——未测优先级最高，即使比到期者“新”。
        ['https://d-untested.example.com', sourceRow('https://d-untested.example.com', {
          tier: 'M1', compile_ok: true, search_ok: null, search_verdict: '', search_checked_at: null,
          rules_hash: rulesHash(syntheticSource('https://d-untested.example.com/')),
        })],
      ]);
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('boom', 500));
      const candidates = [...existing.keys()].map((url) => ({ url, source: syntheticSource(`${url}/`) }));
      const result = await runAdmissionBatch({
        candidates, declaredHosts: new Set(candidates.map(({ url }) => new URL(url).hostname)),
        existing, fetchPage, signal: signal(), throttleMs: 0, maxProbes: 2,
      });
      const probedHosts = fetchPage.mock.calls.map(([input]) => new URL(String(input)).hostname);
      expect(probedHosts).toEqual(['d-untested.example.com', 'a-old.example.com']);
      expect(result.probed).toBe(2);
    });

    it('结论仍有效（未到期/终态）者不占名额：maxProbes 名额全给未测/到期者', async () => {
      const stableRow = sourceRow('https://stable.example.com', {
        tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
        search_checked_at: new Date(Date.now() - 3_600_000).toISOString(),
        rules_hash: rulesHash(syntheticSource('https://stable.example.com/')),
      });
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>x</html>'));
      const result = await runAdmissionBatch({
        candidates: [
          { url: 'https://stable.example.com', source: syntheticSource('https://stable.example.com/') },
          { url: 'https://fresh.example.com', source: syntheticSource('https://fresh.example.com/') },
        ],
        declaredHosts: new Set(['stable.example.com', 'fresh.example.com']),
        existing: new Map([['https://stable.example.com', stableRow]]),
        fetchPage, signal: signal(), throttleMs: 0, maxProbes: 1,
      });
      expect(result.probed).toBe(1);
      expect(fetchPage.mock.calls[0][0]).toContain('fresh.example.com');
    });
  });
});

describe('导出面红线（任务 4 结构断言的前置）', () => {
  it('admissionFetch / validateAdmissionUrl 不在模块导出集合内', async () => {
    const moduleExports = Object.keys(await import('./admission'));
    expect(moduleExports).not.toContain('admissionFetch');
    expect(moduleExports).not.toContain('validateAdmissionUrl');
    expect(moduleExports).not.toContain('checkSourceUrl');
  });
});

// M1 任务 4 硬性要求 0（M1 任务 3 复审 P1-1 收口）：rulesHash 与 reader 的 sourceRevision
// 必须走同一实现。断言 = 同一 source 经两处取 hash 输出相同，且不再是旧的「整份源键排序 sha1」。
describe('rulesHash 与 sourceRevision 同源（M1 任务 4 硬性要求 0）', () => {
  const oldStableHash = (source: unknown): string => {
    const stable = JSON.stringify(source, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
        : item);
    return createHash('sha1').update(stable ?? '').digest('hex');
  };

  it('rulesHash({url,searchUrl,rules}) === sourceRevision(source)（同一实现）', async () => {
    const { sourceRevision } = await import('@/lib/source-revision');
    const source = syntheticSource('https://same.example.com/');
    expect(rulesHash(source)).toBe(sourceRevision({
      url: source.bookSourceUrl as string, searchUrl: source.searchUrl, rules: source,
    }));
    // 反证：不再是对整份源键排序序列化的旧实现（旧值会与任一字段顺序无关）。
    expect(rulesHash(source)).not.toBe(oldStableHash(source));
  });

  it('规则变化（含 searchUrl）即哈希变化', async () => {
    const base = syntheticSource('https://changed.example.com/');
    expect(rulesHash(base)).not.toBe(rulesHash({ ...base, searchUrl: 'https://changed.example.com/other?q={{key}}' }));
  });
});
