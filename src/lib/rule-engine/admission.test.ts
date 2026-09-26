import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import corpus from './fixtures/admission-174.json';
import {
  ADMISSION_CHALLENGE_MAX_STRIKES, ADMISSION_CHALLENGE_STRIKE_PREFIX,
  ADMISSION_CONN_FAIL_RETEST_MS, ADMISSION_OK_RECHECK_MS, ADMISSION_RECHECK_FAIL_PREFIX,
  ADMISSION_RETEST_INTERVAL_MS, ADMISSION_TIMEOUT_MS, DEFAULT_ADMISSION_MAX_PROBES,
  DEFAULT_ADMISSION_PROBE_CONCURRENCY, MAX_ADMISSION_PROBE_CONCURRENCY,
  admissionBucket, admissionMaxProbes, admissionProbeConcurrency, compileAdmission,
  recheckOutcome, runAdmissionBatch, searchAdmission, rulesHash, type AdmissionSourceRow, type AdmissionTransport,
} from './admission';
import { createDeadline } from '@/lib/deadline';
import { ENGINE_SEMANTICS_VERSION, engineVersionedKey } from './compile';
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

// 时间夹具「现在」：凡是用固定 search_checked_at 的用例，必须把批次 now 也钉到同一时刻
// （runAdmissionBatch 的 now 注入），否则「到期/未到期」随真实日期漂移——B2 的 7 天 ok 复核窗
// 就是这么在 2026-09-25 把 N03 祖父条款两例转红的（夹具 2026-09-18 + 真实 now）。
const FIXTURE_NOW_MS = Date.parse('2026-09-18T12:00:00Z');
const atFixtureNow = () => new Date(FIXTURE_NOW_MS);
/** 相对夹具「现在」的 N 毫秒前时刻（ISO），让「几小时/几天前测过」的意图可读、且不随真实日期漂移。 */
const fixtureAgoIso = (ms: number) => new Date(FIXTURE_NOW_MS - ms).toISOString();

function sourceRow(url: string, over: Partial<AdmissionSourceRow> = {}): AdmissionSourceRow {
  return {
    source_url: url, tier: 'T7', compile_ok: false, core_field_mask: {}, search_ok: null,
    search_verdict: '', search_checked_at: null, rules_hash: '', engine_semantics_version: 0,
    host: '', error: '', compile_diagnostics: [], ...over,
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
  it('174 源有效规则判据下 compile-ok = 114（准入兼容 L2；原 N03 104 + 10 条缺 ruleToc.chapterUrl 由引擎默认救回）', () => {
    const ok = sources.filter((source) => compileAdmission(source).ok);
    expect(ok.length).toBe(114);
    // 「靠引擎默认进池」可自查：救回的 10 条 reason 空、mask 里 chapterUrl=false。
    const defaulted = ok.filter((source) => {
      const result = compileAdmission(source);
      return result.coreFieldMask['ruleToc.chapterUrl'] === false;
    });
    expect(defaulted).toHaveLength(10);
    for (const source of defaulted) {
      const result = compileAdmission(source);
      expect(result.reason).toBe('');
      expect(result.coreFieldMask['ruleToc.chapterUrl']).toBe(false);
    }
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

  it('signal 预先中止 ⇒ 不发请求,并以中止原因 reject(S5 纵深防御)', async () => {
    // 单独删掉 admissionFetch 里「注册监听后补 if (signal.aborted) controller.abort」那行,
    // 本测试必须红:已中止的 signal 上注册监听永不触发,传输层会拿到未中止的 probeSignal。
    const controller = new AbortController();
    const reason = new Error('budget');
    controller.abort(reason);
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>ok</html>'));
    const settled = await searchAdmission(syntheticSource('https://ok.example.com/'), {
      fetchPage, declaredHosts: declared('ok.example.com'), signal: controller.signal, throttleMs: 0,
    }).then(() => 'resolved', (e: unknown) => e);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(settled).toBe(reason);
  });

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

  // P1-2（复审裁定）：强标记先判会把正常 200 搜索页判成 challenge 终态（rejected 20h 不重测）。
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

describe('滤网 2 搜索模板 http→https 升级（41-urlfix）', () => {
  const host = 'up.example.net';
  const httpSource = (searchUrl: string, over: Partial<RawSource> = {}) =>
    syntheticSource(`https://${host}/`, { searchUrl, ...over });

  it('写死 http:// 的搜索模板升 https 后放行并真发请求（改前：url_invalid 不发请求）', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const result = await searchAdmission(httpSource(`http://${host}/s?q={{key}}`), {
      fetchPage, declaredHosts: new Set([host]), signal: signal(), throttleMs: 0,
    });
    expect(result.verdict).not.toBe('url_invalid');
    expect(fetchPage).toHaveBeenCalledOnce();
    // 请求真的打到 https，且 host/路径逐字不变。
    expect(String(fetchPage.mock.calls[0][0])).toBe(`https://${host}/s?q=` + encodeURIComponent('测试关键字'));
  });

  it('升级只改 scheme，不改判据：非声明 host / 非 443 端口 / IP 直连的 http 模板仍判 url_invalid 且不发请求', async () => {
    const cases: [string, Set<string>, string][] = [
      [`http://other.example.net/s?q={{key}}`, new Set([host]), 'host 不在声明集'],
      [`http://${host}:8080/s?q={{key}}`, new Set([host]), '非 443 端口'],
      ['http://127.0.0.1/s?q={{key}}', new Set(['127.0.0.1']), 'IP 直连'],
    ];
    for (const [searchUrl, declaredHosts, label] of cases) {
      const fetchPage = vi.fn<AdmissionTransport>();
      const result = await searchAdmission(httpSource(searchUrl), {
        fetchPage, declaredHosts, signal: signal(), throttleMs: 0,
      });
      expect(result.verdict, label).toBe('url_invalid');
      expect(fetchPage, label).not.toHaveBeenCalled();
    }
  });

  it('非 http 的其它 scheme（ftp:/javascript:）不升级，照旧被拒', async () => {
    for (const searchUrl of ['ftp://up.example.net/s?q={{key}}', 'javascript:alert(1){{key}}', 'data:text/plain,{{key}}']) {
      const fetchPage = vi.fn<AdmissionTransport>();
      const result = await searchAdmission(httpSource(searchUrl), {
        fetchPage, declaredHosts: new Set([host]), signal: signal(), throttleMs: 0,
      });
      expect(result.verdict, searchUrl).toBe('url_invalid');
      expect(fetchPage, searchUrl).not.toHaveBeenCalled();
    }
  });
});

describe('准入状态机 runAdmissionBatch', () => {
  it('174 源一轮 mock 准入：114 compile-ok / 60 compile 拒（L2 后冻结数字），真实搜索 ≤20（默认名额），未探测占位可续测', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html><body>no results</body></html>'));
    const declaredHosts = new Set(sources.map((source) => new URL(source.bookSourceUrl).hostname));
    const result = await runAdmissionBatch({
      candidates: sources.map((source) => ({ url: new URL(source.bookSourceUrl).href.replace(/\/$/, ''), source })),
      declaredHosts, existing: new Map(), fetchPage, signal: signal(), throttleMs: 0,
    });
    expect(result.compileOk).toBe(114);
    expect(result.compileRejected).toBe(60);
    // 默认名额 20（41-ADMIT-THROUGHPUT 起）：41-urlfix 起 http→https 升级让 sma.yueyouxs.com 系列
    // 由「不发请求的 url_invalid」变成真探测，占掉的名额把 1 个原在窗口内的候选挤出前 20
    // （fnshu.cc 本轮只写未测占位）——故 fetchPage 19 次、只剩 ubook.reader.qq.com 1 条 url_invalid。
    // probed 仍是 20（url_invalid 也占名额，只是不发请求），未测占位数不变。
    expect(result.probed).toBe(20);
    expect(fetchPage).toHaveBeenCalledTimes(19);
    // 200 但 bookList 无候选 → no_result（deferred 桶，下轮可复测），不是 ok/rejected。
    expect(result.verdicts).toEqual({ no_result: 19, url_invalid: 1 });
    for (const row of result.rows.filter((item) => item.search_verdict === 'no_result')) {
      expect(admissionBucket(row.search_verdict)).toBe('deferred');
      expect(row.search_ok).toBe(false);
    }
    // 全部 174 源都有行（114 通过 + 60 拒），未轮到的通过源写未测占位
    // （114 - 20 已探测 = 94 占位）。
    expect(result.rows).toHaveLength(174);
    expect(result.rows.filter((row) => row.compile_ok && row.search_ok === null)).toHaveLength(94);
    for (const row of result.rows.filter((item) => !item.compile_ok)) {
      expect(row.tier).toBe('T7');
      expect(row.host).not.toBe('');
    }
    // 救回的 10 条以 mask 可自查（url_defaulted 观测的本地口径）。
    expect(result.rows.filter((row) => row.compile_ok
      && row.core_field_mask['ruleToc.chapterUrl'] === false)).toHaveLength(10);
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

  it('deferred 定期重测：超窗复测转 ok，未超窗不重测', async () => {
    const url = 'https://retry.example.com';
    const source = syntheticSource('https://retry.example.com/');
    const hash = rulesHash(source);
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    // 未超窗：60min 内不重测。
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

  it('复测窗 20h 边界：19h 不重测、21h 重测（防 cron 分钟级抖动推迟整周期）', async () => {
    const url = 'https://window.example.com';
    const source = syntheticSource('https://window.example.com/');
    const hash = rulesHash(source);
    const mkExisting = (hoursAgo: number) => new Map([[url, sourceRow(url, {
      compile_ok: true, rules_hash: hash, search_ok: false, search_verdict: 'http_5xx',
      search_checked_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    })]]);

    // 19h：仍在 20h 窗内，fetchPage 不被调用。
    const within = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['window.example.com']),
      existing: mkExisting(19), fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0,
    });
    expect(within.rows).toHaveLength(0);
    expect(within.probed).toBe(0);

    // 21h：已超 20h 窗，触发复测。
    const beyond = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['window.example.com']),
      existing: mkExisting(21), fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(
        page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>')),
      signal: signal(), throttleMs: 0,
    });
    expect(beyond.probed).toBe(1);
    expect(beyond.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok' });
  });

  // 41-srcfix P2：deferred 按 verdict 设复测窗。改前统一 20h ⇒ no_result/url_invalid 每天吃满名额，
  // class 2 的 ok 复核被饿死（srclife-41b G1/G2）。
  describe('41-srcfix P2：deferred 按 verdict 分复测窗', () => {
    const okBody = '<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>';
    const deferredRow = (url: string, source: RawSource, verdict: string, hoursAgo: number) =>
      new Map([[url, sourceRow(url, {
        tier: 'M1', compile_ok: true, rules_hash: rulesHash(source), search_ok: false, search_verdict: verdict,
        search_checked_at: fixtureAgoIso(hoursAgo * 3_600_000),
      })]]);
    const run = (url: string, source: RawSource, existing: Map<string, AdmissionSourceRow>,
      declaredHosts: Set<string>, fetchPage: AdmissionTransport = vi.fn<AdmissionTransport>().mockResolvedValue(page(okBody))) =>
      runAdmissionBatch({
        candidates: [{ url, source }], declaredHosts, existing, fetchPage,
        signal: signal(), throttleMs: 0, now: atFixtureNow,
      });

    it('no_result：21h 不重测（改前 20h 即重测）、73h 重测', async () => {
      const url = 'https://noresult.example.com';
      const source = syntheticSource(`${url}/`);
      const hosts = new Set(['noresult.example.com']);
      const within = await run(url, source, deferredRow(url, source, 'no_result', 21), hosts);
      expect(within.probed).toBe(0);
      expect(within.rows).toHaveLength(0);
      const beyond = await run(url, source, deferredRow(url, source, 'no_result', 73), hosts);
      expect(beyond.probed).toBe(1);
      expect(beyond.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok' });
    });

    it.each(['http_4xx', 'http_5xx', 'query_insensitive'])('%s 保持 20h 窗：19h 不重测、21h 重测', async (verdict) => {
      const url = 'https://soft.example.com';
      const source = syntheticSource(`${url}/`);
      const hosts = new Set(['soft.example.com']);
      expect((await run(url, source, deferredRow(url, source, verdict, 19), hosts)).probed).toBe(0);
      expect((await run(url, source, deferredRow(url, source, verdict, 21), hosts)).probed).toBe(1);
    });

    // 本地确定性 url_invalid：searchUrl host 不在声明集（po.net 型）。同输入必同结论。
    const crossUrl = 'https://cross.example.com';
    const crossSource = syntheticSource(`${crossUrl}/`, { searchUrl: 'https://search.other.example/s?q={{key}}' });

    it('本地确定性 url_invalid：规则与判据都没变 ⇒ 不按时间复测、不占名额（改前 21h/30d 都重测且扣名额）', async () => {
      for (const hoursAgo of [21, 30 * 24]) {
        const fetchPage = vi.fn<AdmissionTransport>();
        const result = await run(crossUrl, crossSource, deferredRow(crossUrl, crossSource, 'url_invalid', hoursAgo),
          new Set(['cross.example.com']), fetchPage);
        expect(result.probed).toBe(0);
        expect(result.rows).toHaveLength(0);
        expect(fetchPage).not.toHaveBeenCalled();
      }
      // 名额让给真正该测的源：1 个名额 + 一个到期 http_5xx 源 ⇒ 名额给 http_5xx 源。
      const softUrl = 'https://soft2.example.com';
      const softSource = syntheticSource(`${softUrl}/`);
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(okBody));
      const result = await runAdmissionBatch({
        candidates: [{ url: crossUrl, source: crossSource }, { url: softUrl, source: softSource }],
        declaredHosts: new Set(['cross.example.com', 'soft2.example.com']),
        existing: new Map([
          ...deferredRow(crossUrl, crossSource, 'url_invalid', 48),
          ...deferredRow(softUrl, softSource, 'http_5xx', 21),
        ]),
        fetchPage, signal: signal(), throttleMs: 0, now: atFixtureNow, maxProbes: 1,
      });
      expect(result.probed).toBe(1);
      expect(result.rows.map((row) => row.source_url)).toEqual([softUrl]);
    });

    it('url_invalid 判据变化（rules_hash 不变）⇒ 自动重测：模拟代码层放行后本地展开可过即按 20h 窗重排', async () => {
      // 判据变化用「声明集纳入搜索 host」模拟（与 urlfix41 的 host 放行 / http→https 升级同一效果：
      // expandAdmissionSearchUrl 从抛错变成通过），规则一字未改 ⇒ rules_hash 不变。
      const hosts = new Set(['cross.example.com', 'search.other.example']);
      const existing = deferredRow(crossUrl, crossSource, 'url_invalid', 21);
      expect(existing.get(crossUrl)!.rules_hash).toBe(rulesHash(crossSource));
      const result = await run(crossUrl, crossSource, existing, hosts);
      expect(result.probed).toBe(1);
      expect(result.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok' });
      // 仍在 20h 窗内的不急着测（网络期 url_invalid 同款节奏）。
      expect((await run(crossUrl, crossSource, deferredRow(crossUrl, crossSource, 'url_invalid', 19), hosts)).probed).toBe(0);
    });

    it('网络期 url_invalid（跳转越出声明集）：本地展开可过 ⇒ 仍按 20h 窗复测', async () => {
      const url = 'https://redir.example.com';
      const source = syntheticSource(`${url}/`);
      const hosts = new Set(['redir.example.com']);
      expect((await run(url, source, deferredRow(url, source, 'url_invalid', 19), hosts)).probed).toBe(0);
      expect((await run(url, source, deferredRow(url, source, 'url_invalid', 21), hosts)).probed).toBe(1);
    });

    it('本地确定性 url_invalid + 规则变（hash 变）⇒ 照常重排探测', async () => {
      const existing = new Map([[crossUrl, sourceRow(crossUrl, {
        tier: 'M1', compile_ok: true, rules_hash: 'stale-hash', search_ok: false, search_verdict: 'url_invalid',
        search_checked_at: fixtureAgoIso(3_600_000),
      })]]);
      const fixed = syntheticSource(`${crossUrl}/`);
      const result = await run(crossUrl, fixed, existing, new Set(['cross.example.com']));
      expect(result.probed).toBe(1);
      expect(result.rows[0]).toMatchObject({ search_ok: true, rules_hash: rulesHash(fixed) });
    });
  });

  // 41-B1-RETRY：conn_fail 一次 8s 超时不再永久拒。仍归 rejected 桶（出池、漏斗口径不变），
  // 但带 7 天衰减——超窗即回 class 1 复测。反例背景：跨 cron 轮的瞬时网络抖动曾把可用源
  // 永久踢出（2026-09-23 opus 源链路复审 B1：conn_fail 比 http_5xx 判得更重，轻重反了）。
  describe('41-B1-RETRY：conn_fail 衰减复测（一次 8s 超时 ≠ 永久拒）', () => {
    const url = 'https://b1.example.com';
    const source = syntheticSource('https://b1.example.com/');
    const hash = rulesHash(source);
    const okPage = () => vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const connFailRow = (daysAgo: number) => new Map([[url, sourceRow(url, {
      tier: 'M1', compile_ok: true, rules_hash: hash, search_ok: false, search_verdict: 'conn_fail',
      search_checked_at: new Date(Date.now() - daysAgo * 24 * 3_600_000).toISOString(),
    })]]);

    it('①首次超时（1 天前）不立即复测：仍 rejected 终态、不占名额', async () => {
      // 衰减窗内：源保持出池（bucket 不变），但也不反复重探——瞬时抖动不放大为探测风暴。
      expect(admissionBucket('conn_fail')).toBe('rejected'); // 桶口径不变：出池判定不动
      const result = await runAdmissionBatch({
        candidates: [{ url, source }], declaredHosts: new Set(['b1.example.com']),
        existing: connFailRow(1), fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0,
      });
      expect(result.probed).toBe(0);
      expect(result.rows).toHaveLength(0); // 旧行原样保留（search_ok=false 不被占位覆盖）
    });

    it('②衰减到期（8 天前 > 7 天窗）→ 回到复探队列，站点恢复即回池（ok 改写）', async () => {
      const result = await runAdmissionBatch({
        candidates: [{ url, source }], declaredHosts: new Set(['b1.example.com']),
        existing: connFailRow(8), fetchPage: okPage(), signal: signal(), throttleMs: 0,
      });
      expect(result.probed).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        search_ok: true, search_verdict: 'ok', rules_hash: hash,
      }); // search_ok=true ⇒ 入池谓词恢复，源回池
    });

    it('③衰减到期但站点仍挂 → 再判 conn_fail，checked_at 刷新、再等一个衰减窗（不放松判据）', async () => {
      const stillDown = vi.fn<AdmissionTransport>().mockRejectedValue(new TypeError('fetch failed'));
      const result = await runAdmissionBatch({
        candidates: [{ url, source }], declaredHosts: new Set(['b1.example.com']),
        existing: connFailRow(8), fetchPage: stillDown, signal: signal(), throttleMs: 0,
      });
      expect(result.verdicts).toEqual({ conn_fail: 1 });
      expect(result.rows[0]).toMatchObject({ search_ok: false, search_verdict: 'conn_fail' });
      // checked_at 必须刷新：否则下一轮立刻又判到期、死站每轮都吃名额（衰减失效）。
      expect(Date.parse(result.rows[0].search_checked_at!))
        .toBeGreaterThan(Date.now() - ADMISSION_CONN_FAIL_RETEST_MS);
    });

    it('④壳页 rejected 终态不衰减；challenge 满 strike 同样终态：21 天后仍不重测（站点行为 ≠ 网络抖动）', async () => {
      // 41-srcfix 改法1：challenge 改为有限复测（见下方「challenge 有限复测」），strike 满额后才回到本条的终态语义。
      for (const [verdict, error] of [['shell', ''], ['challenge', `${ADMISSION_CHALLENGE_STRIKE_PREFIX}${ADMISSION_CHALLENGE_MAX_STRIKES}:403`]] as const) {
        const existing = new Map([[url, sourceRow(url, {
          tier: 'M1', compile_ok: true, rules_hash: hash, search_ok: false, search_verdict: verdict, error,
          search_checked_at: new Date(Date.now() - 21 * 24 * 3_600_000).toISOString(),
        })]]);
        const result = await runAdmissionBatch({
          candidates: [{ url, source }], declaredHosts: new Set(['b1.example.com']),
          existing, fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0,
        });
        expect(result.probed, verdict).toBe(0);
        expect(result.rows, verdict).toHaveLength(0);
      }
    });

    it('⑤衰减到期者与未测源抢名额：class 0 未测优先，conn_fail 到期不抢队（N04 公平序不破）', async () => {
      const fresh = 'https://b1-fresh.example.com';
      const freshSource = syntheticSource('https://b1-fresh.example.com/');
      const result = await runAdmissionBatch({
        candidates: [
          { url, source },
          { url: fresh, source: freshSource },
        ],
        declaredHosts: new Set(['b1.example.com', 'b1-fresh.example.com']),
        existing: connFailRow(8), fetchPage: okPage(), signal: signal(), throttleMs: 0, maxProbes: 1,
      });
      expect(result.probed).toBe(1);
      expect(result.rows[0].source_url).toBe(fresh); // 未测（class 0）先于衰减到期（class 1）
    });
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

  // 防出池（勘案 41 清单 1）：占位覆盖曾把入池源（search_ok=true）打成 null 出池。
  // 2026-09-21 实证 234.484448.xyz：00:05 轮入池、20:27 轮被占位覆盖出池。
  it('rulesChanged ∧ 既有行 search_ok=true ∧ compile_ok=true ∧ 没轮到名额 → 不写行（不占位覆盖，保住入池资格）', async () => {
    const url = 'https://pinned.example.com';
    const source = syntheticSource('https://pinned.example.com/');
    // 既有行：上一轮真探过 search_ok=true，但 rules_hash 是旧规则（本轮 rulesChanged 成立）。
    const existing = new Map([[url, sourceRow(url, {
      tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
      search_checked_at: new Date().toISOString(),
      rules_hash: '1:stale-old-rules', engine_semantics_version: 1,
    })]]);
    // 名额 0（没轮到）→ 旧行为会写 search_ok=null 占位、覆盖出池；修复后不写任何行。
    const result = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['pinned.example.com']),
      existing, fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0, maxProbes: 0,
    });
    expect(result.probed).toBe(0);
    expect(result.rows).toHaveLength(0); // 关键断言：不写占位 = 不覆盖旧行 = 不出池
  });

  it('防出池续测：下一轮仍 rulesChanged 且拿到名额 → 正常真探改写（不放松任何判据）', async () => {
    const url = 'https://pinned2.example.com';
    const source = syntheticSource('https://pinned2.example.com/');
    const existing = new Map([[url, sourceRow(url, {
      tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
      search_checked_at: new Date().toISOString(),
      rules_hash: '1:stale-old-rules', engine_semantics_version: 1,
    })]]);
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const result = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['pinned2.example.com']),
      existing, fetchPage, signal: signal(), throttleMs: 0, maxProbes: 1,
    });
    expect(result.probed).toBe(1); // rulesChanged ⇒ probeClass=1，拿到名额即真探
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      search_ok: true, search_verdict: 'ok', rules_hash: rulesHash(source),
    });
  });

  it('防出池边界：既有行 search_ok=true 但 compile_ok=false → 不在保护范围，仍写占位（勘案 §2.2 条件即 compile_ok∧search_ok 双真才保）', async () => {
    // compile_ok=false 的行本就不满足入池谓词（search_ok IS TRUE 之外还需 JOIN 源表 +
    // compile_ok），占位覆盖不会改变其池外状态；不扩大保护面，避免占位语义被稀释。
    const url = 'https://pinned3.example.com';
    const source = syntheticSource('https://pinned3.example.com/');
    const existing = new Map([[url, sourceRow(url, {
      tier: 'M1', compile_ok: false, search_ok: true, search_verdict: 'ok',
      search_checked_at: new Date().toISOString(),
      rules_hash: '1:stale-old-rules', engine_semantics_version: 1,
    })]]);
    const result = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['pinned3.example.com']),
      existing, fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0, maxProbes: 0,
    });
    expect(result.rows).toHaveLength(1); // 双真才保：compile_ok=false → 仍占位（旧语义）
    expect(result.rows[0]).toMatchObject({ compile_ok: true, search_ok: null });
    expect(result.probed).toBe(0);
  });

  it('防出池不放松未测语义：rulesChanged ∧ previous.search_ok=null → 仍写占位（旧行为保留）', async () => {
    const url = 'https://queue.example.com';
    const source = syntheticSource('https://queue.example.com/');
    const existing = new Map([[url, sourceRow(url, {
      tier: 'M1', compile_ok: true, search_ok: null, rules_hash: '1:stale-old-rules',
    })]]);
    const result = await runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts: new Set(['queue.example.com']),
      existing, fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0, maxProbes: 0,
    });
    expect(result.rows).toHaveLength(1); // 未测占位照写——84 队列续测语义不受防出池修复影响
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

  // 41-ADMIT-THROUGHPUT：名额上限 10→20 并改 env 可调。两组行为各钉一条：
  // 默认值（不传 maxProbes 时走 admissionMaxProbes() 的默认 20）与 env 覆盖生效。
  describe('名额上限默认 20 + env ADMISSION_MAX_PROBES 可调（41-ADMIT-THROUGHPUT）', () => {
    // 不传 maxProbes 的批次用 30 个候选：名额 20 ⇒ 恰探 20 个，10 个不占名额。
    // 候选数 > 名额数才能钉住「默认不再停在旧值 10」——若实现回退到 10，本组变红。
    const probeDefault = async () => {
      const candidates = Array.from({ length: 30 }, (_, index) => ({
        url: `https://d${index}.example.com`, source: syntheticSource(`https://d${index}.example.com/`),
      }));
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>no results</html>'));
      const result = await runAdmissionBatch({
        candidates, declaredHosts: new Set(candidates.map(({ url }) => new URL(url).hostname)),
        existing: new Map(), fetchPage, signal: signal(), throttleMs: 0,
      });
      return { result, fetchPage };
    };

    it('默认（env 缺失）每轮名额 = DEFAULT_ADMISSION_MAX_PROBES = 20', async () => {
      const { result, fetchPage } = await probeDefault();
      expect(DEFAULT_ADMISSION_MAX_PROBES).toBe(20);
      expect(result.probed).toBe(20);
      expect(fetchPage).toHaveBeenCalledTimes(20);
    });

    it('admissionMaxProbes：env 合法值生效，非法/≤0/缺失回退默认 20', () => {
      expect(admissionMaxProbes({ ADMISSION_MAX_PROBES: '5' })).toBe(5);
      expect(admissionMaxProbes({ ADMISSION_MAX_PROBES: '20' })).toBe(20);
      // 回退：缺失、空串、非整数、非数字、0、负数——同款 readingPoolLimit() 口径。
      expect(admissionMaxProbes({})).toBe(DEFAULT_ADMISSION_MAX_PROBES);
      expect(admissionMaxProbes({ ADMISSION_MAX_PROBES: '' })).toBe(DEFAULT_ADMISSION_MAX_PROBES);
      expect(admissionMaxProbes({ ADMISSION_MAX_PROBES: 'abc' })).toBe(DEFAULT_ADMISSION_MAX_PROBES);
      expect(admissionMaxProbes({ ADMISSION_MAX_PROBES: '0' })).toBe(DEFAULT_ADMISSION_MAX_PROBES);
      expect(admissionMaxProbes({ ADMISSION_MAX_PROBES: '-3' })).toBe(DEFAULT_ADMISSION_MAX_PROBES);
      // '3.5'：parseInt 截断得 3（同款 readingPoolLimit 口径，不放宽为「非整数即回退」）。
      expect(admissionMaxProbes({ ADMISSION_MAX_PROBES: '3.5' })).toBe(3);
    });

    it('env 覆盖穿透批次：ADMISSION_MAX_PROBES=7（stubEnv）⇒ 不传 maxProbes 恰探 7', async () => {
      vi.stubEnv('ADMISSION_MAX_PROBES', '7');
      const candidates = Array.from({ length: 30 }, (_, index) => ({
        url: `https://e${index}.example.com`, source: syntheticSource(`https://e${index}.example.com/`),
      }));
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>no results</html>'));
      const result = await runAdmissionBatch({
        candidates, declaredHosts: new Set(candidates.map(({ url }) => new URL(url).hostname)),
        existing: new Map(), fetchPage, signal: signal(), throttleMs: 0,
      });
      vi.unstubAllEnvs();
      expect(result.probed).toBe(7);
      expect(fetchPage).toHaveBeenCalledTimes(7);
    });
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
      // 准入兼容 L2：chapterUrl 已由引擎默认覆盖，缺位 reason 不再含它。
      expect(result.reason).not.toContain('ruleToc.chapterUrl');
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

    it('反例 12（准入兼容 L2）：单缺 chapterUrl（chapterList/chapterName 在）→ 引擎默认可产，不再拒', () => {
      const result = compileAdmission(syntheticSource('https://toc.example.com/', {
        ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' },
      }));
      expect(result.ok).toBe(true);
      expect(result.reason).toBe('');
      expect(result.coreFieldMask['ruleToc.chapterUrl']).toBe(false); // 「靠默认进池」可自查
    });

    it('规则存在但编译不过（chapterUrl:"@baseUrl"）→ 仍拒（failures 路径不放松）；缺 chapterList/chapterName/content 仍拒（不在 ENGINE_DEFAULT_FIELDS）', () => {
      const baseUrlRule = compileAdmission(syntheticSource('https://toc.example.com/', {
        ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: '@baseUrl' },
      }));
      expect(baseUrlRule.ok).toBe(false);
      expect(baseUrlRule.reason).toContain('特殊变量');

      const noName = compileAdmission(syntheticSource('https://toc.example.com/', {
        ruleToc: { chapterList: '.toc@li', chapterUrl: 'a@href' },
      }));
      expect(noName.ok).toBe(false);
      expect(noName.reason).toContain('ruleToc.chapterName');

      const noContent = compileAdmission(syntheticSource('https://toc.example.com/', {
        ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' },
        ruleContent: { content: '##%%' }, // 编译不过：不走缺位分支，failures 拒
      }));
      expect(noContent.ok).toBe(false);
      expect(noContent.reason).toContain('ruleContent.content');
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
    // 准入兼容 L2 后「缺 chapterUrl」不再触发 compile 拒（引擎默认救回），祖父条款的
    // 触发形态改为显式规则不可解释（@baseUrl，failures 路径不放松）——反例 10 要求，
    // 否则整组退化失去保护力。
    const legacy = () => syntheticSource(url, {
      ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: '@baseUrl' },
    });
    const admittedRow = (hash: string): [string, AdmissionSourceRow] => [url, sourceRow(url, {
      tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
      // 相对夹具「现在」：未到 B2 的 7 天 ok 复核窗（到期与否由钉住的 now 决定，不随真实日期漂移）。
      search_checked_at: fixtureAgoIso(3 * 3_600_000), rules_hash: hash,
    })];

    it('规则未变 ∧ 已在池（compile_ok ∧ search_ok=true）→ 维持既有资格，不写库', async () => {
      const hash = rulesHash(legacy());
      const fetchPage = vi.fn<AdmissionTransport>();
      const result = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }],
        declaredHosts: new Set(['pool.example.com']),
        existing: new Map([admittedRow(hash)]), fetchPage, signal: signal(), throttleMs: 0,
        now: atFixtureNow,
      });
      expect(result.grandfathered).toBe(1);
      expect(result.compileOk).toBe(1); // 计入 ok（资格维持），不再占用 60 拒里
      expect(result.rows).toHaveLength(0); // 不重写——写库会把 compile_ok 打成 false，出池
      expect(fetchPage).not.toHaveBeenCalled(); // search 结论仍有效，无需复测
    });

    it('规则一变（hash 变）→ 祖父条款失效，按新校验拒', async () => {
      const fetchPage = vi.fn<AdmissionTransport>();
      const result = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }],
        declaredHosts: new Set(['pool.example.com']),
        existing: new Map([admittedRow('old-hash-not-matching')]), fetchPage, signal: signal(), throttleMs: 0,
        now: atFixtureNow,
      });
      expect(result.grandfathered).toBe(0);
      expect(result.rows[0]).toMatchObject({ compile_ok: false, tier: 'T7' });
      expect(result.rows[0].error).toContain('ruleToc.chapterUrl'); // failures 落到字段
    });

    it('既有行非 admitted（search_ok=false/null）→ 无豁免，新源无既有行更无豁免', async () => {
      const hash = rulesHash(legacy());
      for (const searchOk of [false, null] as const) {
        const result = await runAdmissionBatch({
          candidates: [{ url, source: legacy() }],
          declaredHosts: new Set(['pool.example.com']),
          existing: new Map([[url, sourceRow(url, {
            tier: 'M1', compile_ok: true, search_ok: searchOk, search_verdict: 'no_result',
            search_checked_at: fixtureAgoIso(3 * 3_600_000), rules_hash: hash,
          })]]),
          fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>x</html>')),
          signal: signal(), throttleMs: 0, now: atFixtureNow,
        });
        expect(result.grandfathered).toBe(0);
        expect(result.rows[0].compile_ok).toBe(false);
      }
      // 新源（无既有行）：豁免不可能命中。
      const fresh = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }],
        declaredHosts: new Set(['pool.example.com']), existing: new Map(),
        fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0, now: atFixtureNow,
      });
      expect(fresh.grandfathered).toBe(0);
      expect(fresh.rows[0].compile_ok).toBe(false);
    });

    it('174 池现实核对：缺 chapterUrl 的 10 条 L2 后直接 compile-ok（不再依赖祖父）；@baseUrl 形态才有维持/转拒分叉', async () => {
      // W1 四源 ruleToc 三件套齐（yingsx/jhssd 实测在池），走不到祖父分支；
      // 此用例验证混合批次里 admitted 的 @baseUrl 源维持、未 admitted 的缺 chapterUrl 源直接通过。
      const hashA = rulesHash(legacy());
      const b = syntheticSource('https://never-probed.example.com', {
        ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' }, // 缺 chapterUrl：L2 救回
      });
      const result = await runAdmissionBatch({
        candidates: [
          { url, source: legacy() },
          { url: 'https://never-probed.example.com', source: b },
        ],
        declaredHosts: new Set(['pool.example.com', 'never-probed.example.com']),
        existing: new Map([admittedRow(hashA)]),
        fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(
          page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>')),
        signal: signal(), throttleMs: 0, now: atFixtureNow,
      });
      expect(result.grandfathered).toBe(1);
      // b 是新源（无既有行）且缺 chapterUrl：L2 判 compile-ok、直接拿探测名额，不转拒。
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        source_url: 'https://never-probed.example.com', compile_ok: true, search_ok: true,
      });
    });

    it('窗口边界钉死（now 注入）：在池干净 ok 行未到 7 天窗 ⇒ 不重写；到期 ⇒ class 2 复核（防日期漂移再次转红）', async () => {
      const hash = rulesHash(legacy());
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
        page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
      const checkedAt = (msAgo: number) => sourceRow(url, {
        tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
        search_checked_at: fixtureAgoIso(msAgo), rules_hash: hash,
      });
      // 6 天前测过 < 7 天窗：结论仍有效，不写行、不复测。
      const within = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }], declaredHosts: new Set(['pool.example.com']),
        existing: new Map([[url, checkedAt(6 * 24 * 3_600_000)]]), fetchPage,
        signal: signal(), throttleMs: 0, now: atFixtureNow,
      });
      expect(within.rows).toHaveLength(0);
      expect(fetchPage).not.toHaveBeenCalled();
      // 8 天前测过 > 7 天窗：class 2 长周期复核到期 ⇒ 真探并改写行。
      const due = await runAdmissionBatch({
        candidates: [{ url, source: legacy() }], declaredHosts: new Set(['pool.example.com']),
        existing: new Map([[url, checkedAt(8 * 24 * 3_600_000)]]), fetchPage,
        signal: signal(), throttleMs: 0, now: atFixtureNow,
      });
      expect(due.probed).toBe(1);
      expect(due.rows).toHaveLength(1);
      expect(due.rows[0]).toMatchObject({ source_url: url, search_verdict: 'ok' });
    });
  });

  // ---------------------------------------------------------------- 准入兼容（回滚态用例，设计 §5.2）
  describe('回滚态：L2 revert 后救回的源由祖父条款接住（源留存池内）', () => {
    // 场景：L1+L2 上线后某缺 chapterUrl 源过探测进池（行=compile_ok ∧ search_ok=true ∧
    // hash=h）；随后 git revert——compileAdmission 复判 false，但 isGrandfatheredAdmitted
    // 命中（hash 未变 ∧ 已在池）⇒ exempt=true、计入 grandfathered、probeClass=2 不重写行。
    // 源以祖父身份长期留在池内（与 W1 现网池同机制），直到上游规则变化——可接受，钉死此结论。
    const url = 'https://rollback.example.com';
    const rescued = () => syntheticSource(url, { ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' } });

    it('revert 后（模拟：既有 admitted 行 + hash 未变）→ 免疫命中、不重写行、不发请求', async () => {
      const hash = rulesHash(rescued());
      const existing = new Map([[url, sourceRow(url, {
        tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
        search_checked_at: fixtureAgoIso(3 * 3_600_000), rules_hash: hash,
      })]]);
      // 注意：当前代码（L2 生效）下 compileAdmission(rescued()) 已 ok，exempt 分支不可达——
      // 回滚态由「既有行不变 + compileAdmission 复判」联合表达：本用例先钉住
      // 「L2 下同规则同 hash 复判 ok ⇒ 行不重写」（回滚前的稳态），再钉
      // 「写库只会发生在 probe 结论更新时」，两端合起来即 revert 后行的命运：
      // compile 复判 false + 免疫命中 ⇒ rows 为空 ⇒ 行原样留存池内。
      const fetchPage = vi.fn<AdmissionTransport>();
      const steady = await runAdmissionBatch({
        candidates: [{ url, source: rescued() }], declaredHosts: new Set(['rollback.example.com']),
        existing, fetchPage, signal: signal(), throttleMs: 0, now: atFixtureNow,
      });
      expect(steady.rows).toHaveLength(0); // probeClass=2（结论仍有效）不重写、不复测
      expect(fetchPage).not.toHaveBeenCalled();

      // revert 态的直接复现：老代码判 false 时 isGrandfatheredAdmitted 的语义
      // （admission.ts 导出的纯函数，直接对同一行断言）。
      const { isGrandfatheredAdmitted } = await import('./admission');
      const row = existing.get(url)!;
      expect(isGrandfatheredAdmitted(row, hash)).toBe(true); // 免疫命中（hash 未变 ∧ 已 admitted）
      expect(isGrandfatheredAdmitted(row, 'changed-hash')).toBe(false); // 规则一变即失保护
    });
  });

  // ---------------------------------------------------------------- N04 回归
  describe('N04：公平调度——前 5 个持续失败源不再饿死新源', () => {
    const hosts = Array.from({ length: 6 }, (_, i) => `s${i}.example.com`);
    const candidates = hosts.map((host) => ({ url: `https://${host}`, source: syntheticSource(`https://${host}/`) }));

    // ---------------------------------------------------------------- 准入兼容 L3（反例 15-17：恢复回路钉死）
    describe('L3 恢复回路：compile 拒 ≠ 出环，上游补字段自动回池', () => {
      const url = 'https://recover.example.com';
      const fetchOk = () => vi.fn<AdmissionTransport>().mockResolvedValue(
        page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));

      it('反例 15：既有 compile 拒行 + 规则未变（仍拒）→ 终态去抖不写行不探测；'
        + '上游补上合法 chapterUrl（hash 变）→ compileOk+1、probed+1、写出的行 compile_ok=true', async () => {
        // 用「缺 chapterUrl」作拒因已不可（L2 救回），反例 15 的「拒」形态用 @baseUrl（failures 拒）。
        const bad = syntheticSource(url, { ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: '@baseUrl' } });
        const existing = new Map([[url, sourceRow(url, {
          tier: 'T7', compile_ok: false, search_ok: null, rules_hash: rulesHash(bad),
        })]]);

        // 规则未变仍拒 → compileRejected+1、不写行、不探测（终态去抖）。
        const unchanged = await runAdmissionBatch({
          candidates: [{ url, source: bad }], declaredHosts: new Set(['recover.example.com']),
          existing, fetchPage: fetchOk(), signal: signal(), throttleMs: 0,
        });
        expect(unchanged.compileRejected).toBe(1);
        expect(unchanged.rows).toHaveLength(0);
        expect(unchanged.probed).toBe(0);

        // 上游补字段（改成合法 a@href，hash 变）：下一轮自动回池并拿探测名额。
        const fixed = syntheticSource(url, { ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' } });
        const recovered = await runAdmissionBatch({
          candidates: [{ url, source: fixed }], declaredHosts: new Set(['recover.example.com']),
          existing, fetchPage: fetchOk(), signal: signal(), throttleMs: 0,
        });
        expect(recovered.compileRejected).toBe(0);
        expect(recovered.compileOk).toBe(1);
        expect(recovered.probed).toBe(1);
        expect(recovered.rows).toHaveLength(1);
        expect(recovered.rows[0]).toMatchObject({ compile_ok: true, search_ok: true, search_verdict: 'ok' });
      });

      it('反例 15b（引擎默认救回变体）：既有 compile 拒行（缺 chapterUrl 时代写下）+ 上游不改规则 → '
        + 'L2 后同一批规则即 compile-ok（引擎默认可产），hash 未变也直接回池拿探测名额', async () => {
        // 这是 L1+L2 落地当天的真实路径：10 条缺 chapterUrl 源的旧行是 compile_ok=false
        // （N03 写下），规则未变；L2 生效后 compileAdmission 直接 ok——不是靠上游补字段，
        // 是判定本身放行。终态去抖只在「仍然拒」时生效，此路径不受其阻挡。
        const stillMissing = syntheticSource(url, { ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' } });
        const existing = new Map([[url, sourceRow(url, {
          tier: 'T7', compile_ok: false, search_ok: null, rules_hash: rulesHash(stillMissing),
        })]]);
        const result = await runAdmissionBatch({
          candidates: [{ url, source: stillMissing }], declaredHosts: new Set(['recover.example.com']),
          existing, fetchPage: fetchOk(), signal: signal(), throttleMs: 0,
        });
        expect(result.compileRejected).toBe(0);
        expect(result.compileOk).toBe(1);
        expect(result.probed).toBe(1);
        expect(result.rows[0]).toMatchObject({
          compile_ok: true, search_ok: true,
          core_field_mask: expect.objectContaining({ 'ruleToc.chapterUrl': false }),
        });
      });

      it('反例 16：恢复后优先级——该行 search_ok=null ⇒ probeClass=0 未测优先，同一轮即拿名额', async () => {
        // 反例 15b 的对照扩展：一个「已恢复但未测」源 + 一个「结论仍有效」源抢 1 个名额，
        // 未测优先 ⇒ 恢复源赢（不被 60 条拒源或稳定源饿死）。
        const recovered = syntheticSource(url, { ruleToc: { chapterList: '.toc@li', chapterName: 'a@text' } });
        const stable = syntheticSource('https://stable.example.com/');
        const result = await runAdmissionBatch({
          candidates: [
            { url: 'https://stable.example.com', source: stable },
            { url, source: recovered },
          ],
          declaredHosts: new Set(['recover.example.com', 'stable.example.com']),
          existing: new Map([
            [url, sourceRow(url, { tier: 'T7', compile_ok: false, search_ok: null, rules_hash: rulesHash(recovered) })],
            ['https://stable.example.com', sourceRow('https://stable.example.com', {
              tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
              search_checked_at: new Date(Date.now() - 3_600_000).toISOString(),
              rules_hash: rulesHash(stable),
            })],
          ]),
          fetchPage: fetchOk(), signal: signal(), throttleMs: 0, maxProbes: 1,
        });
        expect(result.probed).toBe(1);
        expect(result.rows[0].source_url).toBe(url); // 未测优先（probeClass 0 < 2 < 3）
      });
    });

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
        signal: signal(), throttleMs: 0, maxProbes: 5,
      });
      // 轮 1（全新）：5 个名额。未测优先按输入序 → s0..s4 被探测（500 → deferred 占位），
      // s5 未轮到但「库中无行」→ 写未测占位，不再是恒 null 的黑洞。
      const round1 = await runOne();
      expect(round1.probed).toBe(5);
      expect(round1.rows.filter((row) => row.search_ok === null && row.compile_ok)).toHaveLength(1);
      for (const row of round1.rows) existing.set(row.source_url, row);
      const s5Round1 = round1.rows.find((row) => row.source_url === 'https://s5.example.com');
      expect(s5Round1).toMatchObject({ compile_ok: true, search_ok: null });

      // 轮 2（恰好 24h 后，deferred 全部到期——已远超 20h 窗）：未测优先 → s5（唯一 search_ok=null）先占名额。
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
        ['https://c-new.example.com', mk('c-new.example.com', now - 25 * 3_600_000)], // 最新（刚过 20h 复测窗）
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

  // 41-B2-OK-RECHECK：ok 源不再永久免检——7 天长周期复核（class 2，名额最后），
  // 首次失败记 strike（error=recheck_fail:<verdict>，search_ok/verdict 保持 ok，不出池），
  // 可疑行 20h 后走 class 1 再确认，再失败才写真实结论出池。
  describe('41-B2-OK-RECHECK：ok 源长周期复核 + 一次失败不出池', () => {
    const url = 'https://b2.example.com';
    const source = syntheticSource('https://b2.example.com/');
    const hash = rulesHash(source);
    const okPage = () => vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const okRow = (over: Partial<AdmissionSourceRow> = {}) => sourceRow(url, {
      tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok', rules_hash: hash, ...over,
    });

    it('①ok 行 8 天前测过 → 进入探测（class 2）；名额受限时 class 0/1 先拿名额，ok 复核只吃剩余', async () => {
      expect(ADMISSION_OK_RECHECK_MS).toBe(7 * 24 * 3_600_000);
      const staleOk = okRow({ search_checked_at: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString() });
      // 名额 2：未测（class 0）与 deferred 到期（class 1）先占，ok 复核（class 2）吃不到名额。
      const deferredUrl = 'https://b2-deferred.example.com';
      const freshUrl = 'https://b2-fresh.example.com';
      const deferredSource = syntheticSource('https://b2-deferred.example.com/');
      const limited = await runAdmissionBatch({
        candidates: [
          { url, source },
          { url: deferredUrl, source: deferredSource },
          { url: freshUrl, source: syntheticSource('https://b2-fresh.example.com/') },
        ],
        declaredHosts: new Set(['b2.example.com', 'b2-deferred.example.com', 'b2-fresh.example.com']),
        existing: new Map([
          [url, staleOk],
          [deferredUrl, sourceRow(deferredUrl, {
            tier: 'M1', compile_ok: true, search_ok: false, search_verdict: 'http_5xx',
            search_checked_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
            rules_hash: rulesHash(deferredSource),
          })],
        ]),
        fetchPage: okPage(), signal: signal(), throttleMs: 0, maxProbes: 2,
      });
      const probedHosts = limited.rows.map((row) => row.source_url);
      expect(probedHosts).toEqual([freshUrl, deferredUrl]); // class 0 先于 class 1，ok 复核落选
      expect(limited.probed).toBe(2);

      // 名额宽（3）：ok 复核吃到剩余名额，最旧优先语义下同档排最前。
      const wide = await runAdmissionBatch({
        candidates: [
          { url, source },
          { url: deferredUrl, source: deferredSource },
          { url: freshUrl, source: syntheticSource('https://b2-fresh.example.com/') },
        ],
        declaredHosts: new Set(['b2.example.com', 'b2-deferred.example.com', 'b2-fresh.example.com']),
        existing: new Map([
          [url, staleOk],
          [deferredUrl, sourceRow(deferredUrl, {
            tier: 'M1', compile_ok: true, search_ok: false, search_verdict: 'http_5xx',
            search_checked_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
            rules_hash: rulesHash(deferredSource),
          })],
        ]),
        fetchPage: okPage(), signal: signal(), throttleMs: 0, maxProbes: 3,
      });
      expect(wide.rows.map((row) => row.source_url)).toEqual([freshUrl, deferredUrl, url]);
      expect(wide.probed).toBe(3);
    });

    it('②ok 行 3 天前测过 → 未到 7 天窗，不探测', async () => {
      const result = await runAdmissionBatch({
        candidates: [{ url, source }], declaredHosts: new Set(['b2.example.com']),
        existing: new Map([[url, okRow({
          search_checked_at: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
        })]]),
        fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), throttleMs: 0,
      });
      expect(result.probed).toBe(0);
      expect(result.rows).toHaveLength(0);
    });

    it('③ok 复核首次失败（conn_fail 与 http_5xx）→ strike：search_ok=true、verdict=ok、error 带 recheck_fail: 前缀，仍在池', async () => {
      for (const [verdict, fetchPage] of [
        ['conn_fail', vi.fn<AdmissionTransport>().mockRejectedValue(new TypeError('fetch failed'))],
        ['http_5xx', vi.fn<AdmissionTransport>().mockResolvedValue(page('boom', 500))],
      ] as const) {
        const result = await runAdmissionBatch({
          candidates: [{ url, source }], declaredHosts: new Set(['b2.example.com']),
          existing: new Map([[url, okRow({
            search_checked_at: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(),
          })]]),
          fetchPage, signal: signal(), throttleMs: 0,
        });
        expect(result.probed, verdict).toBe(1);
        expect(result.rows[0], verdict).toMatchObject({
          search_ok: true, search_verdict: 'ok', error: `${ADMISSION_RECHECK_FAIL_PREFIX}${verdict}`,
        });
      }
    });

    it('④可疑行 21 小时后 → class 1 复测；再次失败 → search_ok=false + 真实 verdict（出池）', async () => {
      const suspicious = okRow({
        search_checked_at: new Date(Date.now() - 21 * 3_600_000).toISOString(),
        error: `${ADMISSION_RECHECK_FAIL_PREFIX}conn_fail`,
      });
      // class 1 佐证：与未测源抢 1 个名额时未测赢（可疑行不抢 class 0），但先于 ok 长周期复核。
      const freshUrl = 'https://b2-fresh2.example.com';
      const order = await runAdmissionBatch({
        candidates: [
          { url, source },
          { url: freshUrl, source: syntheticSource('https://b2-fresh2.example.com/') },
        ],
        declaredHosts: new Set(['b2.example.com', 'b2-fresh2.example.com']),
        existing: new Map([[url, suspicious]]),
        fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page('boom', 500)),
        signal: signal(), throttleMs: 0, maxProbes: 1,
      });
      expect(order.rows[0].source_url).toBe(freshUrl); // class 0 先于可疑行（class 1）

      // 再次失败：strike 耗尽，写真实结论出池。
      const again = await runAdmissionBatch({
        candidates: [{ url, source }], declaredHosts: new Set(['b2.example.com']),
        existing: new Map([[url, suspicious]]),
        fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page('boom', 500)),
        signal: signal(), throttleMs: 0,
      });
      expect(again.probed).toBe(1);
      expect(again.rows[0]).toMatchObject({ search_ok: false, search_verdict: 'http_5xx', error: '500' });
    });

    it('④b 可疑行(class 1)与另一个 class 1 到期源抢 1 个名额 → class 1 内最旧者赢,可疑行不混进 class 2', async () => {
      // 现有 ④ 只证明可疑行输给 class 0,对「class 1 与 class 2 有别」是恒真的(class 0 对谁都赢)。
      // 本条钉区分:可疑行(21h 前,带 recheck_fail 前缀)与一个更老的 deferred 到期源(class 1)
      // 抢 1 个名额时,class 1 内按 search_checked_at 最旧优先——deferred 源(25h 前)赢,
      // 可疑行落选写占位;若可疑行被错判成 class 2(名额最后),结果同样是 deferred 赢,
      // 所以再加一个 8 天前的干净 ok 行(class 2)做对照:名额放宽到 2 时,可疑行必须排在
      // class 2 之前拿到第 2 个名额。
      const suspicious = okRow({
        search_checked_at: new Date(Date.now() - 21 * 3_600_000).toISOString(),
        error: `${ADMISSION_RECHECK_FAIL_PREFIX}conn_fail`,
      });
      const deferredUrl = 'https://b2-old-deferred.example.com';
      const deferredSource = syntheticSource('https://b2-old-deferred.example.com/');
      const okUrl = 'https://b2-old-ok.example.com';
      const okSource = syntheticSource('https://b2-old-ok.example.com/');
      const existing = new Map<string, AdmissionSourceRow>([
        [url, suspicious],
        [deferredUrl, sourceRow(deferredUrl, {
          tier: 'M1', compile_ok: true, search_ok: false, search_verdict: 'http_5xx',
          search_checked_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
          rules_hash: rulesHash(deferredSource),
        })],
        [okUrl, sourceRow(okUrl, {
          tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
          search_checked_at: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(),
          rules_hash: rulesHash(okSource),
        })],
      ]);
      const candidates = [
        { url, source },
        { url: deferredUrl, source: deferredSource },
        { url: okUrl, source: okSource },
      ];
      const hosts = new Set(['b2.example.com', 'b2-old-deferred.example.com', 'b2-old-ok.example.com']);
      const one = await runAdmissionBatch({
        candidates, declaredHosts: hosts, existing,
        fetchPage: okPage(), signal: signal(), throttleMs: 0, maxProbes: 1,
      });
      expect(one.rows.filter((row) => row.search_verdict !== '').map((row) => row.source_url))
        .toEqual([deferredUrl]); // class 1 内最旧者(25h)赢过可疑行(21h)
      const two = await runAdmissionBatch({
        candidates, declaredHosts: hosts, existing,
        fetchPage: okPage(), signal: signal(), throttleMs: 0, maxProbes: 2,
      });
      expect(two.rows.filter((row) => row.search_verdict !== '').map((row) => row.source_url))
        .toEqual([deferredUrl, url]); // 第 2 个名额给可疑行(class 1),class 2 的 ok 复核落选
    });

    it('⑤可疑行复测成功 → error 清空，回到普通 ok', async () => {
      const result = await runAdmissionBatch({
        candidates: [{ url, source }], declaredHosts: new Set(['b2.example.com']),
        existing: new Map([[url, okRow({
          search_checked_at: new Date(Date.now() - 21 * 3_600_000).toISOString(),
          error: `${ADMISSION_RECHECK_FAIL_PREFIX}http_5xx`,
        })]]),
        fetchPage: okPage(), signal: signal(), throttleMs: 0,
      });
      expect(result.probed).toBe(1);
      expect(result.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok', error: '' });
    });

    it('recheckOutcome 纯函数：非 ok 行的探测失败照实写（strike 只保护干净 ok 行）', () => {
      const failed = { verdict: 'http_5xx', candidateCount: 0, status: 500, error: '500' } as const;
      expect(recheckOutcome(undefined, failed)).toEqual({ search_ok: false, search_verdict: 'http_5xx', error: '500' });
      const deferredRow = sourceRow(url, { compile_ok: true, search_ok: false, search_verdict: 'http_5xx' });
      expect(recheckOutcome(deferredRow, failed)).toEqual({ search_ok: false, search_verdict: 'http_5xx', error: '500' });
      const cleanOk = sourceRow(url, { compile_ok: true, search_ok: true, search_verdict: 'ok' });
      expect(recheckOutcome(cleanOk, failed)).toEqual({
        search_ok: true, search_verdict: 'ok', error: `${ADMISSION_RECHECK_FAIL_PREFIX}http_5xx`,
      });
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

describe('rulesHash 纳入引擎语义版本', () => {
  const oldStableHash = (source: unknown): string => {
    const stable = JSON.stringify(source, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
        : item);
    return createHash('sha1').update(stable ?? '').digest('hex');
  };

  it('内容 revision 保持同源，并增加可见的语义版本前缀', async () => {
    const { sourceRevision } = await import('@/lib/source-revision');
    const source = syntheticSource('https://same.example.com/');
    expect(rulesHash(source)).toBe(`${ENGINE_SEMANTICS_VERSION}:${sourceRevision({
      url: source.bookSourceUrl as string, searchUrl: source.searchUrl, rules: source,
    })}`);
    // 反证：不再是对整份源键排序序列化的旧实现（旧值会与任一字段顺序无关）。
    expect(rulesHash(source)).not.toBe(oldStableHash(source));
  });

  it('规则变化（含 searchUrl）即哈希变化', async () => {
    const base = syntheticSource('https://changed.example.com/');
    expect(rulesHash(base)).not.toBe(rulesHash({ ...base, searchUrl: 'https://changed.example.com/other?q={{key}}' }));
  });

  it('语义版本升级会改变缓存/准入 identity，即使源内容不变', () => {
    expect(engineVersionedKey('same-content', 1)).not.toBe(engineVersionedKey('same-content', 2));
  });

  it('预置旧语义 rulesHash 的 compile_rejected 行会失效并重评', async () => {
    const source = syntheticSource('https://version.example.com/');
    const { sourceRevision } = await import('@/lib/source-revision');
    const legacyHash = sourceRevision({
      url: source.bookSourceUrl as string, searchUrl: source.searchUrl, rules: source,
    });
    const result = await runAdmissionBatch({
      candidates: [{ url: 'https://version.example.com/', source }],
      declaredHosts: new Set(['version.example.com']),
      existing: new Map([['https://version.example.com/', sourceRow('https://version.example.com/', {
        compile_ok: false, rules_hash: legacyHash, engine_semantics_version: 0,
      })]]),
      fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), maxProbes: 0,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      compile_ok: true, search_ok: null, rules_hash: rulesHash(source),
      engine_semantics_version: ENGINE_SEMANTICS_VERSION,
    });
  });

  it('预置旧语义 rulesHash 的 search_ok 不会复用，先失效为待探测', async () => {
    // 注：防出池修复（rulesChanged ∧ 双真 → 不占位）不与此冲突——该场景双真的行没轮到名额时
    // 不写占位、旧行保留，hash 前缀仍是 0:，下一轮 rulesChanged 仍成立、拿到名额即真探改写；
    // 本用例的既有行 compile_ok=true ∧ search_ok=true，在 maxProbes=0 下新语义应为「不写行」。
    // 语义版本翻转（1:→2:）时同理：池源保住旧结论，复测拿名额后按新前缀改写。
    // 此处以 compile_ok=true 断言旧语义版本翻转路径的旧行为变化：翻转后（旧 hash 0:）
    // 行不再被占位覆盖——search_ok=true 保留至真探，而非被清成 null。
    const source = syntheticSource('https://search-version.example.com/');
    const existing = new Map([['https://search-version.example.com/', sourceRow('https://search-version.example.com/', {
      tier: 'M1', compile_ok: true, search_ok: true, search_verdict: 'ok',
      rules_hash: '0:legacy-content', engine_semantics_version: 0,
    })]]);
    const noSlot = await runAdmissionBatch({
      candidates: [{ url: 'https://search-version.example.com/', source }],
      declaredHosts: new Set(['search-version.example.com']),
      existing, fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), maxProbes: 0,
    });
    // 防出池：双真行没轮到名额 → 不写占位（旧行的 search_ok=true 保留）。
    expect(noSlot.rows).toHaveLength(0);
    expect(noSlot.probed).toBe(0);

    // 拿到名额 → 真探正常改写为新前缀，search_ok 不复用旧结论。
    // 41-B2-OK-RECHECK 注：既有行是干净 ok 行，本次真探失败（no_result）只记 strike、
    // 不出池——search_ok/verdict 保持 ok，error 带 recheck_fail: 前缀；hash 前缀照常翻新。
    const probed = await runAdmissionBatch({
      candidates: [{ url: 'https://search-version.example.com/', source }],
      declaredHosts: new Set(['search-version.example.com']),
      existing, fetchPage: vi.fn<AdmissionTransport>().mockResolvedValue(page('<html>x</html>')),
      signal: signal(), maxProbes: 1, throttleMs: 0,
    });
    expect(probed.rows).toHaveLength(1);
    expect(probed.rows[0]).toMatchObject({
      compile_ok: true, search_ok: true, search_verdict: 'ok',
      error: `${ADMISSION_RECHECK_FAIL_PREFIX}no_result`,
      rules_hash: rulesHash(source),
      engine_semantics_version: ENGINE_SEMANTICS_VERSION,
    });
  });
});

// P1a 开闸前置修复（review-batch-t3t6p1a-p2.md 第三节 P2 条）：三处落库此前写死常量 1，
// 而 rulesHash 在 ENGINE_SYNTAX_OR=1 时产出 `2:<hash>` → 行内元数据自相矛盾。修复后版本列
// 与 hash 前缀同源。三条路径逐一覆盖：compile 拒 / 探测落库 / 未测占位。
// env 注入只动 process.env（vi.stubEnv），与 engineSyntaxOrEnabled 默认读 env 的口径一致；
// 不给 runAdmissionBatch 加参数、不 stub 其它全局。
describe('落库元数据自洽：engine_semantics_version 与 rulesHash 前缀同源', () => {
  afterEach(() => vi.unstubAllEnvs());

  const hashVersion = (hash: string): number => Number(hash.slice(0, hash.indexOf(':')));
  // ruleContent.content 含 ||：off 态拒（旧行为），on 态编过——两态都产行，便于对照。
  const orSource = (host: string) => syntheticSource(`https://${host}/`, {
    ruleContent: { content: '#content@html||.body@html' },
  } as Partial<RawSource>);
  // xpath 两态均拒，用来覆盖 on 态仍走 compile 拒落库的那条路径。
  const xpathSource = (host: string) => syntheticSource(`https://${host}/`, {
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '//div/a' },
  } as Partial<RawSource>);

  it('off 态（env 缺失）：compile 拒行版本列 1、hash 前缀 1:（与修复前等值）', async () => {
    vi.stubEnv('ENGINE_SYNTAX_OR', '');
    const source = orSource('off-version.example.com');
    const result = await runAdmissionBatch({
      candidates: [{ url: 'https://off-version.example.com/', source }],
      declaredHosts: new Set(['off-version.example.com']),
      existing: new Map(), fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), maxProbes: 0,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.compile_ok).toBe(false); // off 态 || 仍拒
    expect(row.engine_semantics_version).toBe(1);
    expect(row.rules_hash.startsWith('1:')).toBe(true);
    expect(row.engine_semantics_version).toBe(hashVersion(row.rules_hash));
  });

  it('off 态：compile 通过的未测占位行版本列仍为 1', async () => {
    vi.stubEnv('ENGINE_SYNTAX_OR', '');
    const source = syntheticSource('https://off-ok.example.com/');
    const result = await runAdmissionBatch({
      candidates: [{ url: 'https://off-ok.example.com/', source }],
      declaredHosts: new Set(['off-ok.example.com']),
      existing: new Map(), fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), maxProbes: 0,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.compile_ok).toBe(true);
    expect(row.search_ok).toBeNull();
    expect(row.engine_semantics_version).toBe(1);
    expect(row.rules_hash.startsWith('1:')).toBe(true);
    expect(row.engine_semantics_version).toBe(hashVersion(row.rules_hash));
  });

  it('on 态（ENGINE_SYNTAX_OR=1）：未测占位行版本列 2、hash 前缀 2:', async () => {
    vi.stubEnv('ENGINE_SYNTAX_OR', '1');
    const source = orSource('on-version.example.com');
    const result = await runAdmissionBatch({
      candidates: [{ url: 'https://on-version.example.com/', source }],
      declaredHosts: new Set(['on-version.example.com']),
      existing: new Map(), fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), maxProbes: 0,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.compile_ok).toBe(true); // on 态 || 编过
    expect(row.search_ok).toBeNull(); // 本轮无探测名额 → 占位行
    expect(row.engine_semantics_version).toBe(2);
    expect(row.rules_hash.startsWith('2:')).toBe(true);
    expect(row.engine_semantics_version).toBe(hashVersion(row.rules_hash));
  });

  it('on 态（ENGINE_SYNTAX_OR=1）：真实探测落库行版本列同样 2', async () => {
    vi.stubEnv('ENGINE_SYNTAX_OR', '1');
    const source = orSource('on-probe.example.com');
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(
      page('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>'));
    const result = await runAdmissionBatch({
      candidates: [{ url: 'https://on-probe.example.com/', source }],
      declaredHosts: new Set(['on-probe.example.com']),
      existing: new Map(), fetchPage, signal: signal(), maxProbes: 1, throttleMs: 0,
    });
    expect(result.probed).toBe(1);
    const row = result.rows[0];
    expect(row.search_verdict).toBe('ok');
    expect(row.engine_semantics_version).toBe(2);
    expect(row.engine_semantics_version).toBe(hashVersion(row.rules_hash));
    expect(row.rules_hash.startsWith('2:')).toBe(true);
  });

  it('on 态（ENGINE_SYNTAX_OR=1）：compile 拒行同样版本列 2、hash 前缀 2:', async () => {
    vi.stubEnv('ENGINE_SYNTAX_OR', '1');
    const source = xpathSource('on-reject.example.com');
    const result = await runAdmissionBatch({
      candidates: [{ url: 'https://on-reject.example.com/', source }],
      declaredHosts: new Set(['on-reject.example.com']),
      existing: new Map(), fetchPage: vi.fn<AdmissionTransport>(), signal: signal(), maxProbes: 0,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.compile_ok).toBe(false);
    expect(row.engine_semantics_version).toBe(2);
    expect(row.rules_hash.startsWith('2:')).toBe(true);
    expect(row.engine_semantics_version).toBe(hashVersion(row.rules_hash));
  });
});
// 41-ADMIT-CONC:准入探测受限并发(env ADMISSION_PROBE_CONCURRENCY,默认 1=串行)。
// 判据三条:(a) 名额/canProbe 在 await 前同步领取(不超发);(b) 同 host 不并发;
// (c) 输出按计划顺序(与完成先后无关)。c=1 时必须与串行版逐行一致(零行为变更)。
describe('41-ADMIT-CONC:准入探测受限并发', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  // fake transport 工厂:按 host 记录调用序/在飞峰值;可给每 host 配结果与延迟。
  type FetchImpl = (url: string) => Promise<Response>;
  function tracker(fetchImpl?: FetchImpl) {
    let inflight = 0;
    let maxInflight = 0;
    const byHostInflight = new Map<string, number>();
    const hostPeak = new Map<string, number>();
    const calls: string[] = [];
    const impl = async (input: string): Promise<Response> => {
      const host = new URL(input).hostname;
      calls.push(host);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const h = (byHostInflight.get(host) ?? 0) + 1;
      byHostInflight.set(host, h);
      hostPeak.set(host, Math.max(hostPeak.get(host) ?? 0, h));
      await Promise.resolve(); // 让出,确保并发请求真正交叠
      try {
        if (fetchImpl) return await fetchImpl(input);
        return page('<html>no results</html>');
      } finally {
        inflight -= 1;
        byHostInflight.set(host, (byHostInflight.get(host) ?? 1) - 1);
      }
    };
    return {
      fetchPage: vi.fn<AdmissionTransport>(impl),
      get maxInflight() { return maxInflight; },
      get hostPeak() { return hostPeak; },
      get calls() { return calls; },
    };
  }

  const candidatesFor = (hosts: string[]) => hosts.map((host) => ({
    url: `https://${host}`, source: syntheticSource(`https://${host}/`),
  }));

  it('并发 c 时同时在飞 ≤ c(fake transport 记录在飞峰值)', async () => {
    const hosts = ['c0.example.com', 'c1.example.com', 'c2.example.com', 'c3.example.com', 'c4.example.com'];
    const t = tracker();
    const result = await runAdmissionBatch({
      candidates: candidatesFor(hosts),
      declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 5, probeConcurrency: 2,
    });
    expect(result.probed).toBe(5);
    expect(t.fetchPage).toHaveBeenCalledTimes(5);
    expect(t.maxInflight).toBeLessThanOrEqual(2);
    expect(t.maxInflight).toBeGreaterThanOrEqual(2); // 确实并行了(不是退化成串行)
  });

  it('名额永不超发:名额 5、c=4、10 个候选 ⇒ 恰好 5 次探测', async () => {
    const hosts = Array.from({ length: 10 }, (_, i) => `n${i}.example.com`);
    const t = tracker();
    const result = await runAdmissionBatch({
      candidates: candidatesFor(hosts),
      declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 5, probeConcurrency: 4,
    });
    expect(result.probed).toBe(5);
    expect(t.fetchPage).toHaveBeenCalledTimes(5);
    // 被探的是计划序里最前的 5 个(未测 class 0,输入序)。
    expect(t.calls).toEqual(['n0.example.com', 'n1.example.com', 'n2.example.com', 'n3.example.com', 'n4.example.com']);
  });

  it('同 host 不并发:同一 host 两个候选不会同时在飞', async () => {
    // 两个候选同一 host(不同 url 路径),外加两个别的 host 提供并发度。
    const dup = [
      { url: 'https://dup.example.com/a', source: syntheticSource('https://dup.example.com/a') },
      { url: 'https://dup.example.com/b', source: syntheticSource('https://dup.example.com/b') },
      { url: 'https://x.example.com', source: syntheticSource('https://x.example.com/') },
      { url: 'https://y.example.com', source: syntheticSource('https://y.example.com/') },
    ];
    const t = tracker();
    await runAdmissionBatch({
      candidates: dup,
      declaredHosts: new Set(['dup.example.com', 'x.example.com', 'y.example.com']),
      existing: new Map(), fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 4, probeConcurrency: 4,
    });
    expect(t.fetchPage).toHaveBeenCalledTimes(4);
    expect(t.hostPeak.get('dup.example.com')).toBe(1); // 同 host 峰值 1 = 从不并发
  });

  it('同站互斥键取 searchUrl 展开后的 host:bookSourceUrl 不同但 searchUrl 同站的两个源被串行化(41-fanout)', async () => {
    // a/b 两个源声明 URL 不同站,搜索却都打向 search.example.com;x/y 提供并发度。
    const shared = { searchUrl: 'https://search.example.com/s?q={{key}}' };
    const candidates = [
      { url: 'https://a.example.com', source: syntheticSource('https://a.example.com/', shared) },
      { url: 'https://b.example.com', source: syntheticSource('https://b.example.com/', shared) },
      { url: 'https://x.example.com', source: syntheticSource('https://x.example.com/') },
      { url: 'https://y.example.com', source: syntheticSource('https://y.example.com/') },
    ];
    const t = tracker();
    const result = await runAdmissionBatch({
      candidates,
      declaredHosts: new Set(['a.example.com', 'b.example.com', 'search.example.com', 'x.example.com', 'y.example.com']),
      existing: new Map(), fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 4, probeConcurrency: 4,
    });
    expect(t.fetchPage).toHaveBeenCalledTimes(4);
    expect(t.maxInflight).toBeGreaterThanOrEqual(2); // 确实并发了(x/y 与 search 站交叠)
    expect(t.hostPeak.get('search.example.com')).toBe(1); // 真实目标站峰值 1 = 从不并发
    // 写库的 host 列仍是声明 URL 的 host(互斥键只影响调度)。
    expect(result.rows.map((row) => row.host)).toEqual(['a.example.com', 'b.example.com', 'x.example.com', 'y.example.com']);
  });

  it('searchUrl 展开失败的源退回声明 URL host 作互斥键,不影响其余源并发(41-fanout)', async () => {
    const candidates = [
      // 动态规则展开失败 ⇒ url_invalid、不发请求;互斥键退回 bad.example.com。
      { url: 'https://bad.example.com', source: syntheticSource('https://bad.example.com/', { searchUrl: 'https://bad.example.com/s?q={{key}}&t={{java.time()}}' }) },
      { url: 'https://x.example.com', source: syntheticSource('https://x.example.com/') },
      { url: 'https://y.example.com', source: syntheticSource('https://y.example.com/') },
    ];
    const t = tracker();
    const result = await runAdmissionBatch({
      candidates,
      declaredHosts: new Set(['bad.example.com', 'x.example.com', 'y.example.com']),
      existing: new Map(), fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 3, probeConcurrency: 3,
    });
    expect(result.verdicts.url_invalid).toBe(1);
    expect(t.calls.sort()).toEqual(['x.example.com', 'y.example.com']);
    expect(t.maxInflight).toBe(2);
  });

  it('canProbe 随探测耗时转 false ⇒ 逐探止损,之后不再起探并写占位(对照基点 3059eb5 实测值)', async () => {
    // 判据钉的是基点行为,不是新实现自比:canProbe 依赖时间(每探耗 8s,预算 30s,
    // 门槛 8s 超时 + 5s 写库预留 = 13s)。5 个候选、名额 20。
    // 基点 3059eb5 实测:probed=3、请求 3 次、占位 2 条、起探时剩余 [30,22,14]s。
    // 5f3b506(名额在批次开头一次性领完)实测:probed=5、占位 0——本断言在其上必红。
    const hosts = ['t0.example.com', 't1.example.com', 't2.example.com', 't3.example.com', 't4.example.com'];
    const BUDGET = 30_000;
    let elapsed = 0;
    const startedAt: number[] = [];
    const fetchPage = vi.fn<AdmissionTransport>(async () => {
      startedAt.push(elapsed);
      elapsed += 8_000;
      return page('<html>no results</html>');
    });
    const result = await runAdmissionBatch({
      candidates: candidatesFor(hosts), declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage, signal: signal(), throttleMs: 0, maxProbes: 20,
      canProbe: () => BUDGET - elapsed > ADMISSION_TIMEOUT_MS + 5_000,
    });
    expect(result.probed).toBe(3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result.rows.filter((r) => r.search_ok === null)).toHaveLength(2);
    expect(startedAt.map((t) => BUDGET - t)).toEqual([30_000, 22_000, 14_000]);
  });

  it('两探之间调用方中止 signal ⇒ 不再发起新请求,其余写占位,批次正常返回', async () => {
    // 基点 3059eb5 实测:请求 1 次、probed=1、占位 2 条。
    // 5f3b506 实测:请求 3 次(第 2、3 次在中止之后发出)——本断言在其上必红。
    // now() 第 1 次 = planProbeOrder;第 2 次 = 第 1 探完成后取 search_checked_at,
    // 恰在两探之间中止。
    const hosts = ['a0.example.com', 'a1.example.com', 'a2.example.com'];
    const controller = new AbortController();
    let nowCalls = 0;
    const fixed = new Date('2026-09-23T00:00:00Z');
    const now = () => { nowCalls += 1; if (nowCalls === 2) controller.abort(new Error('budget')); return fixed; };
    const fetchPage = vi.fn<AdmissionTransport>(async () => page('<html>no results</html>'));
    const result = await runAdmissionBatch({
      candidates: candidatesFor(hosts), declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage, signal: controller.signal, throttleMs: 0, maxProbes: 20, now,
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.probed).toBe(1);
    expect(result.rows.filter((r) => r.search_ok === null)).toHaveLength(2);
    expect(result.rows.map((r) => r.search_verdict || '(placeholder)')).toEqual([
      'no_result', '(placeholder)', '(placeholder)',
    ]);
  });

  it('生产形状:createDeadline(60s)+20 个死站每探 8s 超时 ⇒ 预算内收口并返回全部 20 行', async () => {
    // canProbe 口径同 shuyuan.ts:990(剩余 > 8s 超时 + 5s 写库预留)。
    // 基点 3059eb5 实测:resolve、probed=6、20 行(6 条 conn_fail + 14 条占位)。
    // 5f3b506 实测:reject DeadlineExceededError、起探 8 次——本断言在其上必红。
    vi.useFakeTimers();
    const budget = createDeadline(60_000);
    const hosts = Array.from({ length: 20 }, (_, i) => `d${i}.example.com`);
    const fetchPage = vi.fn<AdmissionTransport>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    const batch = runAdmissionBatch({
      candidates: candidatesFor(hosts), declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage, signal: budget.signal, throttleMs: 0, maxProbes: 20,
      canProbe: () => !budget.signal.aborted && budget.remainingMs > ADMISSION_TIMEOUT_MS + 5_000,
    });
    const settled = batch.then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(200_000);
    const outcome = await settled;
    budget.dispose();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.r.probed).toBe(6);
    expect(outcome.r.rows).toHaveLength(20);
    expect(outcome.r.rows.filter((r) => r.search_verdict === 'conn_fail')).toHaveLength(6);
    expect(outcome.r.rows.filter((r) => r.search_ok === null)).toHaveLength(14);
  });

  it('c>1 时调用方中止 ⇒ 被 host 挡住的 worker 不再发孤儿请求', async () => {
    // 5f3b506 实测:批次 reject 后,被同 host 挡住的 worker 被唤醒仍发出
    // fetch#3(callerAborted=true)。逐探判 signal 后该请求必须消失。
    const controller = new AbortController();
    const cands = [
      { url: 'https://dup.example.com/a', source: syntheticSource('https://dup.example.com/a') },
      { url: 'https://dup.example.com/b', source: syntheticSource('https://dup.example.com/b') },
      { url: 'https://x.example.com', source: syntheticSource('https://x.example.com/') },
    ];
    let nowCalls = 0;
    const now = () => { nowCalls += 1; if (nowCalls === 2) controller.abort(new Error('budget')); return new Date(); };
    const seen: boolean[] = [];
    const fetchPage = vi.fn<AdmissionTransport>((_input, init) => {
      seen.push(controller.signal.aborted);
      if (seen.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      return Promise.resolve(page('<html>no results</html>'));
    });
    const outcome = await runAdmissionBatch({
      candidates: cands, declaredHosts: new Set(['dup.example.com', 'x.example.com']), existing: new Map(),
      fetchPage, signal: controller.signal, throttleMs: 0, maxProbes: 20, now, probeConcurrency: 2,
    }).then(() => 'resolved', () => 'rejected');
    // 在飞探测遭调用方中止 ⇒ 整批 reject(不许吞掉异常后照常 resolve 并写库)。
    expect(outcome).toBe('rejected');
    expect(seen.filter((aborted) => aborted)).toEqual([]);
  });

  it('结果行顺序 = 计划顺序(不同延迟使完成顺序与计划顺序相反)', async () => {
    const hosts = ['o0.example.com', 'o1.example.com', 'o2.example.com'];
    // o0 最慢、o2 最快 ⇒ 完成顺序 o2,o1,o0,与计划顺序相反。
    const delays: Record<string, number> = { 'o0.example.com': 30, 'o1.example.com': 15, 'o2.example.com': 0 };
    const t = tracker(async (input) => {
      const host = new URL(input).hostname;
      await new Promise((resolve) => setTimeout(resolve, delays[host]));
      return page('<html>no results</html>');
    });
    const result = await runAdmissionBatch({
      candidates: candidatesFor(hosts),
      declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 3, probeConcurrency: 3,
    });
    // 启动顺序=计划序(证明排序不是「碰巧对」——完成顺序另由延迟决定)。
    expect(t.calls).toEqual(['o0.example.com', 'o1.example.com', 'o2.example.com']);
    expect(result.rows.map((r) => r.source_url)).toEqual([
      'https://o0.example.com', 'https://o1.example.com', 'https://o2.example.com',
    ]);
  });

  it('c=1 输出与基点 3059eb5 的固定期望逐行相等(不自比)', async () => {
    // 期望值取自基点 3059eb5 同输入的实测输出(固定 now,无延迟):3 行全 no_result,
    // search_checked_at 固定、rules_hash 前缀 1:(ENGINE_SYNTAX_OR 未开)。5f3b506 在此输入上碰巧相同,所以本条
    // 单独不区分;区分力由上面三条「逐探止损」断言承担(它们在 5f3b506 上必红)。
    const hosts = ['q0.example.com', 'q1.example.com', 'q2.example.com'];
    const fixedNow = () => new Date('2026-09-23T00:00:00Z');
    const result = await runAdmissionBatch({
      candidates: candidatesFor(hosts), declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage: vi.fn<AdmissionTransport>(async () => page('<html>no results</html>')),
      signal: signal(), throttleMs: 0, maxProbes: 3, now: fixedNow,
    });
    expect(result.probed).toBe(3);
    expect(result.verdicts).toEqual({ no_result: 3 });
    expect(result.rows.map((r) => ({
      url: r.source_url, tier: r.tier, compile_ok: r.compile_ok, search_ok: r.search_ok,
      verdict: r.search_verdict, checked: r.search_checked_at, error: r.error,
      hashPrefix: r.rules_hash.slice(0, 2), version: r.engine_semantics_version,
    }))).toEqual(hosts.map((host) => ({
      url: `https://${host}`, tier: 'M1', compile_ok: true, search_ok: false,
      verdict: 'no_result', checked: '2026-09-23T00:00:00.000Z', error: 'bookList 未解析出候选',
      hashPrefix: '1:', version: 1,
    })));
  });

  it('注入值 probeConcurrency=100 被钳到上限 8(在飞峰值 ≤8)', async () => {
    // S6:env 路径已由 admissionProbeConcurrency 单独钳制;这里补注入值(测试直传)的钳制覆盖。
    const hosts = Array.from({ length: 10 }, (_, i) => `k${i}.example.com`);
    const t = tracker();
    const result = await runAdmissionBatch({
      candidates: candidatesFor(hosts), declaredHosts: new Set(hosts), existing: new Map(),
      fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 10, probeConcurrency: 100,
    });
    expect(result.probed).toBe(10);
    expect(t.maxInflight).toBeLessThanOrEqual(8);
    expect(t.maxInflight).toBeGreaterThan(1);
  });

  describe('env ADMISSION_PROBE_CONCURRENCY 解析:缺失/非法/0/负数/超上限', () => {
    it('默认值常量 = 1(串行=零行为变更)', () => {
      expect(DEFAULT_ADMISSION_PROBE_CONCURRENCY).toBe(1);
      expect(MAX_ADMISSION_PROBE_CONCURRENCY).toBe(8);
      expect(admissionProbeConcurrency({})).toBe(1);
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: '' })).toBe(1);
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: 'abc' })).toBe(1);
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: '0' })).toBe(1);
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: '-3' })).toBe(1);
    });

    it('合法值生效;超上限夹到 8;3.5 截断为 3(同款 admissionMaxProbes 口径)', () => {
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: '4' })).toBe(4);
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: '8' })).toBe(8);
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: '100' })).toBe(8);
      expect(admissionProbeConcurrency({ ADMISSION_PROBE_CONCURRENCY: '3.5' })).toBe(3);
    });

    it('env 覆盖穿透批次:ADMISSION_PROBE_CONCURRENCY=2(stubEnv)⇒ 在飞峰值 ≤2 且确实并行', async () => {
      vi.stubEnv('ADMISSION_PROBE_CONCURRENCY', '2');
      const hosts = ['z0.example.com', 'z1.example.com', 'z2.example.com', 'z3.example.com'];
      const t = tracker();
      const result = await runAdmissionBatch({
        candidates: candidatesFor(hosts), declaredHosts: new Set(hosts), existing: new Map(),
        fetchPage: t.fetchPage, signal: signal(), throttleMs: 0, maxProbes: 4,
      });
      expect(result.probed).toBe(4);
      expect(t.maxInflight).toBeLessThanOrEqual(2);
      expect(t.maxInflight).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('espfix41:查询不敏感判据(对照搜索)', () => {
  const host = 'junk.example.com';
  const url = `https://${host}/`;
  const declaredHosts = new Set([host]);
  // 垃圾源形态(按 lbldeploy41 §5 观察合成):无论搜什么都回同一批无关条目。
  const junkHtml = [1, 2, 3].map((i) => `<div class="i"><span class="t">无关条目${i}</span><a href="/b/${i}">x</a></div>`).join('');
  const resultsFor = (q: string) => [1, 2].map((i) => `<div class="i"><span class="t">${q}${i}</span><a href="/b/${encodeURIComponent(q)}-${i}">x</a></div>`).join('');
  const queryOf = (input: string) => new URL(input).searchParams.get('q') ?? '';

  it('反例(改前放行):同一批条目在不开对照时判 ok;开对照后判 query_insensitive', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async () => page(junkHtml));
    const before = await searchAdmission(syntheticSource(url), { fetchPage, declaredHosts, signal: signal(), throttleMs: 0 });
    expect(before.verdict).toBe('ok');
    expect(fetchPage).toHaveBeenCalledOnce();
    const after = await searchAdmission(syntheticSource(url), {
      fetchPage, declaredHosts, signal: signal(), throttleMs: 0, controlQuery: true,
    });
    expect(after.verdict).toBe('query_insensitive');
    expect(after.error).toContain('100%');
    // 第二次请求用对照书名(与主关键词「测试关键字」无公共字的第一个)
    expect(queryOf(String(fetchPage.mock.calls[2][0]))).toBe('凡人修仙传');
    expect(admissionBucket('query_insensitive')).toBe('deferred');
  });

  it('正常站:结果随查询变化 ⇒ 仍判 ok', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async (input) => page(resultsFor(queryOf(input))));
    const result = await searchAdmission(syntheticSource(url), {
      fetchPage, declaredHosts, signal: signal(), throttleMs: 0, controlQuery: true,
    });
    expect(result.verdict).toBe('ok');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('正常站:对照书名 0 结果(页上只有热门榜,不在 bookList 里)⇒ 仍判 ok', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async (input) =>
      page(queryOf(input) === '测试关键字' ? resultsFor('测试关键字') : '<html><body><ul class="hot"><li>热门</li></ul></body></html>'));
    const result = await searchAdmission(syntheticSource(url), {
      fetchPage, declaredHosts, signal: signal(), throttleMs: 0, controlQuery: true,
    });
    expect(result.verdict).toBe('ok');
  });

  it('对照搜索网络失败 / 5xx:拿不到证据 ⇒ 维持 ok(不把抖动升级成出池)', async () => {
    for (const control of [() => Promise.reject(new TypeError('fetch failed')), () => Promise.resolve(page('err', 502))]) {
      const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async (input) =>
        queryOf(input) === '测试关键字' ? page(junkHtml) : control());
      const result = await searchAdmission(syntheticSource(url), {
        fetchPage, declaredHosts, signal: signal(), throttleMs: 0, controlQuery: true,
      });
      expect(result.verdict).toBe('ok');
    }
  });

  it('部分重合低于阈值 ⇒ ok;达到阈值 ⇒ query_insensitive', async () => {
    const item = (i: number) => `<div class="i"><span class="t">条目${i}</span><a href="/b/${i}">x</a></div>`;
    const run = async (control: number[]) => {
      const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async (input) =>
        page((queryOf(input) === '测试关键字' ? [1, 2, 3, 4, 5] : control).map(item).join('')));
      return (await searchAdmission(syntheticSource(url), {
        fetchPage, declaredHosts, signal: signal(), throttleMs: 0, controlQuery: true,
      })).verdict;
    };
    expect(await run([1, 2, 6, 7, 8])).toBe('ok');                 // Jaccard 2/8
    expect(await run([1, 2, 3, 4])).toBe('query_insensitive');     // Jaccard 4/5 = 0.8
  });

  it('对照词避开与主关键词有公共字的候选;全部冲突则不做对照', async () => {
    const { queryControlKeyword } = await import('./admission');
    expect(queryControlKeyword('修仙')).toBe('诡秘之主');
    expect(queryControlKeyword('测试关键字')).toBe('凡人修仙传');
    expect(queryControlKeyword('凡诡庆斗')).toBeUndefined();
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async () => page(junkHtml));
    const result = await searchAdmission(syntheticSource(url, { checkKeyWord: '凡诡庆斗' }), {
      fetchPage, declaredHosts, signal: signal(), throttleMs: 0, controlQuery: true,
    });
    expect(result.verdict).toBe('ok');
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('两次请求之间补一次同站节流间隔', async () => {
    const sleep = vi.fn(async () => {});
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async () => page(junkHtml));
    await searchAdmission(syntheticSource(url), {
      fetchPage, declaredHosts, signal: signal(), throttleMs: 350, sleep, controlQuery: true,
    });
    expect(sleep).toHaveBeenCalledWith(350, expect.anything());
  });

  it('批次:在池的干净 ok 行复核判 query_insensitive ⇒ 不走 strike、直接出池(search_ok=false)', async () => {
    const source = syntheticSource(url);
    const checked = new Date(Date.parse('2026-09-24T00:00:00Z') - ADMISSION_OK_RECHECK_MS - 1).toISOString();
    const existing = new Map([[url, sourceRow(url, {
      compile_ok: true, search_ok: true, search_verdict: 'ok', search_checked_at: checked,
      rules_hash: rulesHash(source), host,
    })]]);
    const fetchPage = vi.fn<AdmissionTransport>().mockImplementation(async () => page(junkHtml));
    const run = (controlQuery: boolean) => runAdmissionBatch({
      candidates: [{ url, source }], declaredHosts, existing, fetchPage, signal: signal(), throttleMs: 0,
      now: () => new Date('2026-09-24T00:00:00Z'), controlQuery,
    });
    const before = await run(false);
    expect(before.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok' });
    const after = await run(true);
    expect(after.rows[0]).toMatchObject({ search_ok: false, search_verdict: 'query_insensitive' });
    expect(after.verdicts).toEqual({ query_insensitive: 1 });
  });
});
