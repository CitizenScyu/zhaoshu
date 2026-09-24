import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 41-fanout E.4 门槛估算：单次 probe 的墙钟分布与进程内 CPU/堆开销。**默认跳过**，`E4_BENCH=1` 才跑：
//   E4_BENCH=1 npx vitest run src/lib/source-probe.e4.bench.test.ts
// 不对任何真实书源站发请求：fetch 被替换成本地延迟模型（真实计时器），延迟取仓内已记录的生产实测量级
// （source-fetch.ts：connect ≤0.51s、TTFB ≤2.11s；source-reader.ts：详情页最慢 ≤3.6s）。
// 结果写 console（JSON 一行），折算见 fanout-41-report.md §4。

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('./db', () => ({ getSql: mocks.getSql, ensureSchema: vi.fn() }));
vi.mock('./shuyuan', () => ({ getReadingSources: vi.fn() }));

const RUN = process.env.E4_BENCH === '1';
const PER_SCENARIO = 40;

// 确定性伪随机（mulberry32），同种子同分布，结果可复算。
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(41);
/** 单次上游请求延迟（ms）：60% 0.3–1.0s、30% 1.0–2.1s、10% 2.1–3.6s。 */
function latency(): number {
  const r = random();
  const span = r < 0.6 ? [300, 1_000] : r < 0.9 ? [1_000, 2_100] : [2_100, 3_600];
  return Math.round(span[0] + random() * (span[1] - span[0]));
}

const engineRules = {
  ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.content@text' },
};
// 目录页按真实量级放 1500 章，搜索页放 20 条结果，让解析 CPU 不被低估。
const tocHtml = Array.from({ length: 1_500 }, (_, i) => `<li class="chapter"><a href="/c/${i}.html">第${i + 1}章 标题</a></li>`).join('');
const searchHtml = (hit: boolean) => Array.from({ length: 20 }, (_, i) =>
  `<div class="book"><span class="name">${hit && i === 7 ? '测试书' : '别的书' + i}</span><span class="author">作者</span><a href="/d/${i}.html">x</a></div>`,
).join('');

type Scenario = 'hit' | 'no_candidates' | 'miss' | 'connect_hang' | 'body_stall';
const SCENARIOS: Scenario[] = ['hit', 'no_candidates', 'miss', 'connect_hang', 'body_stall'];

function fetchFor(scenario: Scenario, delay: () => number): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const signal = init?.signal ?? undefined;
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    if (scenario === 'connect_hang') await wait(1e9); // 挂起到 3s 连接段超时
    await wait(delay());
    if (scenario === 'body_stall') return new Response(new ReadableStream({ start() {} }), { status: 200 });
    if (url.pathname === '/s') return new Response(scenario === 'no_candidates' ? '<div>无结果</div>' : searchHtml(scenario === 'hit'));
    if (url.pathname.startsWith('/d/')) {
      const title = scenario === 'hit' ? '测试书' : '别的书';
      return new Response(`<h1 class="title">${title}</h1><span class="writer">作者</span><a class="toc" href="/toc/1.html">目录</a>`);
    }
    if (url.pathname.startsWith('/toc/')) return new Response(tocHtml);
    throw new Error('unexpected ' + url.href);
  }) as typeof fetch;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

describe.skipIf(!RUN)('E.4 单源 probe 墙钟与开销（本地延迟模型，不出网）', () => {
  let service: typeof import('./source-reader');
  beforeAll(async () => {
    const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?'), values });
    mocks.getSql.mockReturnValue(Object.assign(sql, { transaction: async (queries: unknown[]) => queries.map(() => []) }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    service = await import('./source-reader');
    (await import('./source-policy')).refreshSupportedHosts(Array.from({ length: PER_SCENARIO }, (_, i) => `s${i}.bench.test`));
  });
  afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('每场景 40 次并发 probe：墙钟分布；另测零延迟下的 CPU 与堆', async () => {
    const report: Record<string, unknown> = {};
    for (const scenario of SCENARIOS) {
      vi.stubGlobal('fetch', fetchFor(scenario, latency));
      const runs = await Promise.all(Array.from({ length: PER_SCENARIO }, (_, i) => service.probeSourceForBook({
        url: `https://s${i}.bench.test/`, name: `s${i}`, searchUrl: `https://s${i}.bench.test/s?q={{key}}`, tier: 'M1', rules: engineRules,
      }, { title: '测试书', author: '作者' }, new AbortController().signal)));
      const walls = runs.map((run) => run.elapsedMs).sort((a, b) => a - b);
      report[scenario] = {
        statuses: [...new Set(runs.map((run) => run.status))],
        requestsMax: Math.max(...runs.map((run) => run.requests)),
        p50: pct(walls, 0.5), p95: pct(walls, 0.95), max: walls.at(-1),
        mean: Math.round(walls.reduce((a, b) => a + b, 0) / walls.length),
      };
    }
    // 零延迟：只剩解析与引擎求值（Active CPU 的上界估计；节流槽按 host 分桶，同源 350ms 间隔仍计入墙钟不计 CPU）。
    vi.stubGlobal('fetch', fetchFor('hit', () => 0));
    const cpu0 = process.cpuUsage();
    const heap0 = process.memoryUsage().heapUsed;
    const N = 20;
    for (let i = 0; i < N; i += 1) {
      await service.probeSourceForBook({
        url: `https://s${i}.bench.test/`, name: `s${i}`, searchUrl: `https://s${i}.bench.test/s?q={{key}}`, tier: 'M1', rules: engineRules,
      }, { title: '测试书', author: '作者' }, new AbortController().signal);
    }
    const cpu = process.cpuUsage(cpu0);
    report.cpuMsPerHitProbe = Math.round((cpu.user + cpu.system) / 1000 / N);
    report.heapDeltaMb = Math.round((process.memoryUsage().heapUsed - heap0) / 1024 / 1024);
    console.log('[E4_BENCH]', JSON.stringify(report));
    expect(report.hit).toMatchObject({ statuses: ['ok'] });
  }, 60_000);
});
