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
    ruleContent: { content: '.c' },
    ...over,
  } as RawSource;
}

describe('滤网 1 compileAdmission（纯本地）', () => {
  it('174 源核心字段可解释 = 114（faithful parse 口径，冻结数字）', () => {
    const ok = sources.filter((source) => compileAdmission(source).ok);
    expect(ok.length).toBe(114);
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
  it('174 源一轮 mock 准入：114 compile-ok / 60 compile 拒，真实搜索 ≤5，未探测占位可续测', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html><body>no results</body></html>'));
    const declaredHosts = new Set(sources.map((source) => new URL(source.bookSourceUrl).hostname));
    const result = await runAdmissionBatch({
      candidates: sources.map((source) => ({ url: new URL(source.bookSourceUrl).href.replace(/\/$/, ''), source })),
      declaredHosts, existing: new Map(), fetchPage, signal: signal(), throttleMs: 0,
    });
    expect(result.compileOk).toBe(114);
    expect(result.compileRejected).toBe(60);
    expect(result.probed).toBe(5);
    expect(fetchPage).toHaveBeenCalledTimes(5);
    // 200 但 bookList 无候选 → no_result（deferred 桶，下轮可复测），不是 ok/rejected。
    expect(result.verdicts).toEqual({ no_result: 5 });
    for (const row of result.rows.filter((item) => item.search_verdict === 'no_result')) {
      expect(admissionBucket(row.search_verdict)).toBe('deferred');
      expect(row.search_ok).toBe(false);
    }
    // 全部 174 源都有行（114 通过 + 60 拒），未轮到的通过源写未测占位。
    expect(result.rows).toHaveLength(174);
    expect(result.rows.filter((row) => row.compile_ok && row.search_ok === null)).toHaveLength(109);
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
