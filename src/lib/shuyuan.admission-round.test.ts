// 42-admbudget：独立准入轮 runAdmissionRound 与刷新尾部准入的互斥租约。
// harness 照抄 shuyuan.admission-stoploss.test.ts（mock sql 标签 → execute，按语句文本分派返回）。
// 钉四件事：① 独立轮用自己的 ADMISSION_ROUND_BUDGET_MS，探得比整份刷新预算能容纳的还多；
// ② 租约领不到 / 领取报错 ⇒ 一个都不探（fail-closed）；③ 刷新尾部开关开时领不到租约就跳过；
// ④ 开关关时刷新尾部不发任何租约语句（与改前逐字相同）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Query = { text: string; values: unknown[] };
type TransactionOptions = { readOnly?: boolean; fetchOptions?: { signal: AbortSignal } };

const { ensureSchema, getSql, sql, execute, transaction, readTransaction } = vi.hoisted(() => {
  const execute = vi.fn<(query: Query) => Promise<unknown[]>>();
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
    return {
      ...query,
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected: (error: unknown) => unknown) {
        return execute(query).then(onFulfilled, onRejected);
      },
    };
  });
  return {
    ensureSchema: vi.fn(), getSql: vi.fn(), sql, execute,
    transaction: vi.fn<(queries: Query[], options?: TransactionOptions) => Promise<unknown[][]>>(),
    readTransaction: vi.fn<(queries: Query[], options?: TransactionOptions) => Promise<unknown[][]>>(),
  };
});

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

import {
  ADMISSION_LEASE_ROW, ADMISSION_LEASE_TTL_MS, ADMISSION_ROUND_BUDGET_MS, REFRESH_BUDGET_MS,
  admissionLeaseTtlMs, admissionOwnCronEnabled, refreshShuyuan, runAdmissionRound, runAdmissionRunnerRound,
} from './shuyuan';
import { ADMISSION_PHOENIX_OK_PREFIX, ADMISSION_PROBE_WORST_MS } from './rule-engine/admission';

const WRITE_RESERVE_MS = 5_000; // shuyuan.ts 同名常量（未导出）；止损门 = 剩余 > 单探最坏 + 写库预留
const indexUrl = 'https://www.yckceo.com/yuedu/shuyuans/index.html';
const collectionUrl = (id: number) => `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
const zeroCounts = { total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0 };
const fetchMock = vi.fn<typeof fetch>();
const SEARCH = /^https:\/\/dead\d+\.example\/s\?q=/;

function deadSource(i: number) {
  return {
    bookSourceUrl: `https://dead${i}.example/`, bookSourceName: `死站${i}`,
    searchUrl: `https://dead${i}.example/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
  };
}

let lease: 'claimed' | 'held' | 'error';
let stored: { source_url: string; source: Record<string, unknown> }[];
// 42-admhealth：cron_health 成功行写入（recordCronSuccess('admission')）的替身开关。
let admissionSuccessWrite: 'ok' | 'fail';

const queries = () => execute.mock.calls.map(([query]) => query);
// 租约行 = INSERT INTO cron_health 且首参数是租约行名（带 now()+TTL）；成功行 = 同表但首参数 'admission'（now() upsert）。
const leaseQueries = () => queries().filter((query) => query.text.startsWith('INSERT INTO cron_health')
  && query.values[0] === ADMISSION_LEASE_ROW);
const successQueries = () => queries().filter((query) => query.text.startsWith('INSERT INTO cron_health')
  && query.values[0] === 'admission');
const searches = () => fetchMock.mock.calls.filter(([input]) => SEARCH.test(String(input)));
const logged = (log: { mock: { calls: unknown[][] } }, message: string) =>
  log.mock.calls.filter(([m]) => m === message).map(([, payload]) => payload);

beforeEach(() => {
  vi.clearAllMocks();
  lease = 'claimed';
  stored = [];
  admissionSuccessWrite = 'ok';
  execute.mockReset().mockImplementation(async (query) => {
    if (query.text.startsWith('INSERT INTO cron_health')) {
      // 42-admhealth：成功行 upsert（name='admission'，VALUES (?, now())，无租约 TTL 表达式）与租约行区分。
      if (query.values[0] === 'admission') {
        if (admissionSuccessWrite === 'fail') throw new Error('database unavailable');
        return [];
      }
      if (lease === 'error') throw new Error('database unavailable');
      return lease === 'claimed' ? [{ name: ADMISSION_LEASE_ROW }] : [];
    }
    if (query.text.startsWith('SELECT source_url, source FROM shuyuan_sources ORDER BY id')) return stored;
    if (query.text.startsWith('SELECT count(*)')) return [zeroCounts];
    return [];
  });
  transaction.mockReset().mockResolvedValue([]);
  readTransaction.mockReset().mockImplementation(async (queries) => Promise.all(queries.map((query) => execute(query))));
  ensureSchema.mockResolvedValue(undefined);
  getSql.mockReturnValue(Object.assign(sql, { transaction: (queries: Query[], options?: TransactionOptions) =>
    options?.readOnly ? readTransaction(queries, options) : transaction(queries, options),
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('admissionOwnCronEnabled', () => {
  it('只有 1/true/on（忽略大小写与空白）才开，缺失/其它一律关', () => {
    for (const on of ['1', 'true', 'TRUE', ' on ']) expect(admissionOwnCronEnabled({ ADMISSION_OWN_CRON: on })).toBe(true);
    for (const off of [undefined, '', '0', 'false', 'yes', 'enabled']) {
      expect(admissionOwnCronEnabled({ ADMISSION_OWN_CRON: off })).toBe(false);
    }
  });
});

// admrunner42：租约 TTL env 化——默认逐字 300_000（Vercel 不设 env 行为不变），phoenix 单元设 900000。
describe('admissionLeaseTtlMs', () => {
  it('f) 默认 300_000；env 正整数即用；非法/0/负数/空白回默认', () => {
    expect(ADMISSION_LEASE_TTL_MS).toBe(300_000);
    expect(admissionLeaseTtlMs({})).toBe(300_000);
    expect(admissionLeaseTtlMs({ ADMISSION_LEASE_TTL_MS: '900000' })).toBe(900_000);
    expect(admissionLeaseTtlMs({ ADMISSION_LEASE_TTL_MS: '1' })).toBe(1);
    for (const bad of [undefined, '', ' ', '0', '-5', 'abc', 'NaN', '9007199254740993']) {
      expect(admissionLeaseTtlMs({ ADMISSION_LEASE_TTL_MS: bad }), String(bad)).toBe(300_000);
    }
    // '1.5' 被 parseInt 截成 1（与其它 *_MS env 的解析口径一致，不额外拒绝）。
    expect(admissionLeaseTtlMs({ ADMISSION_LEASE_TTL_MS: '1.5' })).toBe(1);
  });

  it('租约语句吃 env 值：设 900000 时 VALUES 参数是 900000；不设时是默认 300000', async () => {
    vi.stubEnv('ADMISSION_LEASE_TTL_MS', '900000');
    await runAdmissionRound();
    expect(leaseQueries().at(-1)!.values).toEqual([ADMISSION_LEASE_ROW, 900_000]);
    vi.unstubAllEnvs();
    execute.mockClear();
    await runAdmissionRound();
    expect(leaseQueries().at(-1)!.values).toEqual([ADMISSION_LEASE_ROW, ADMISSION_LEASE_TTL_MS]);
  });
});

// admrunner42：phoenix runner 轮（entry.ts --admission）：同一把租约、同一条流水；ok 行带 phoenix_ok:；不发布产物。
describe('runAdmissionRunnerRound（phoenix runner）', () => {
  // 候选 URL 回显查询词（href=/b/<q>）：主搜索与对照搜索关键词不同 ⇒ 候选 URL 不同 ⇒ Jaccard 0，
  // 判 ok 而非 query_insensitive（模拟真正随查询变化的站点；静态页会被对照判据判 query_insensitive）。
  const okResponse = (input: RequestInfo | URL) => {
    const q = new URL(String(input)).searchParams.get('q') ?? '';
    const html = `<div class="i"><span class="t">${q}</span><a href="/b/${encodeURIComponent(q)}">x</a><span class="a">作者</span></div>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };

  it('ok 站写 phoenix_ok: 前缀、死站写真实 verdict；不发布产物；记 admission 成功行', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ADMISSION_MAX_PROBES', '2');
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', 'D:/nonexistent/pool.json');
    stored = [
      { source_url: 'https://dead0.example/', source: deadSource(0) },
      { source_url: 'https://dead1.example/', source: deadSource(1) },
    ];
    fetchMock.mockImplementation((input, options) => {
      const url = String(input);
      if (!SEARCH.test(url)) return Promise.reject(new Error(`Unexpected network request: ${url}`));
      // dead0 探 ok（页面含候选），dead1 永远挂到超时 ⇒ conn_fail。
      if (url.startsWith('https://dead0.')) return Promise.resolve(okResponse(input));
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const settled = runAdmissionRunnerRound(120_000);
    await vi.advanceTimersByTimeAsync(120_000 + 60_000);
    const summary = await settled;
    vi.useRealTimers();
    expect(summary).toMatchObject({ sources: 2, candidates: 2, probed: 2, written: 2 });
    const insert = queries().find((query) => query.text.startsWith('INSERT INTO source_admission'))!;
    const rows = JSON.parse(insert.values[0] as string) as { source_url: string; search_ok: boolean | null; search_verdict: string; error: string }[];
    const byUrl = Object.fromEntries(rows.map((row) => [row.source_url, row]));
    expect(byUrl['https://dead0.example/']).toMatchObject({ search_ok: true, search_verdict: 'ok', error: ADMISSION_PHOENIX_OK_PREFIX });
    expect(byUrl['https://dead1.example/']).toMatchObject({ search_ok: false, search_verdict: 'conn_fail' });
    expect(byUrl['https://dead1.example/'].error.startsWith(ADMISSION_PHOENIX_OK_PREFIX)).toBe(false);
    // 不发布产物：没有产物生成的库读（shuyuan_meta 投影），收尾行 artifact='skipped'、trigger='runner'。
    expect(queries().some((query) => query.text.includes('FROM shuyuan_meta'))).toBe(false);
    const [round] = logged(log, 'shuyuan admission round') as { artifact: string; trigger: string }[];
    expect(round).toMatchObject({ artifact: 'skipped', trigger: 'runner', written: 2 });
    expect(successQueries()).toHaveLength(1);
    // 租约先于读源表。
    const order = queries().map((query) => query.text);
    expect(order.findIndex((text) => text.startsWith('INSERT INTO cron_health')))
      .toBeLessThan(order.findIndex((text) => text.startsWith('SELECT source_url, source FROM shuyuan_sources')));
  });

  it('租约被占 ⇒ 整轮跳过（trigger=runner），不读源表、不探、不记成功行', async () => {
    lease = 'held';
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runAdmissionRunnerRound(60_000)).toEqual({ skipped: 'lease' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queries().map((query) => query.text)).toEqual([expect.stringMatching(/^INSERT INTO cron_health/)]);
    expect(logged(log, 'shuyuan admission batch')).toEqual([{ skipped: 'lease', trigger: 'runner' }]);
    expect(successQueries()).toHaveLength(0);
  });

  it('租约领取报错 ⇒ fail-closed，不探', async () => {
    lease = 'error';
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runAdmissionRunnerRound(60_000)).toEqual({ skipped: 'lease' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('shuyuan admission lease failed', { trigger: 'runner', reason: expect.any(String) });
  });

  it('Vercel 独立轮（runAdmissionRound）对同一 ok 站不带前缀（okPrefix 缺省，改前逐字）', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ADMISSION_MAX_PROBES', '1');
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (!SEARCH.test(url)) return Promise.reject(new Error(`Unexpected network request: ${url}`));
      return Promise.resolve(okResponse(input));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const settled = runAdmissionRound();
    await vi.advanceTimersByTimeAsync(ADMISSION_ROUND_BUDGET_MS + 60_000);
    await settled;
    vi.useRealTimers();
    const insert = queries().find((query) => query.text.startsWith('INSERT INTO source_admission'))!;
    const [row] = JSON.parse(insert.values[0] as string) as { search_ok: boolean | null; search_verdict: string; error: string }[];
    expect(row).toMatchObject({ search_ok: true, search_verdict: 'ok', error: '' });
  });
});

describe('runAdmissionRound：独立预算', () => {
  it('预算与刷新无关：40 个死站探出的次数 > 整份刷新预算能容纳的上限，且全部在自己的 240s 内止损', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ADMISSION_MAX_PROBES', '40');
    stored = Array.from({ length: 40 }, (_, i) => ({ source_url: `https://dead${i}.example/`, source: deadSource(i) }));
    const t0 = Date.now();
    const startsAt: number[] = [];
    fetchMock.mockImplementation((input, options) => {
      const url = String(input);
      if (!SEARCH.test(url)) return Promise.reject(new Error(`Unexpected network request: ${url}`));
      startsAt.push(Date.now() - t0);
      const probeSignal = options!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        probeSignal.addEventListener('abort', () => reject(probeSignal.reason), { once: true });
      });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const settled = runAdmissionRound();
    await vi.advanceTimersByTimeAsync(ADMISSION_ROUND_BUDGET_MS + 60_000);
    const summary = await settled;

    // 死站每探一次吃满 8s 单次超时（c 缺省 = 1，串行）。刷新哪怕 0 耗时，180s 也只容得下
    // floor((180000 − 21350) / 8000) + 1 = 20 次起探；独立轮的 240s 容得下更多。
    const refreshCeiling = Math.floor((REFRESH_BUDGET_MS - ADMISSION_PROBE_WORST_MS - WRITE_RESERVE_MS) / 8_000) + 1;
    expect(startsAt.length).toBeGreaterThan(refreshCeiling);
    expect(startsAt.at(-1)!).toBeLessThanOrEqual(ADMISSION_ROUND_BUDGET_MS - ADMISSION_PROBE_WORST_MS - WRITE_RESERVE_MS);
    expect(summary).toMatchObject({ sources: 40, candidates: 40, probed: startsAt.length, written: 40 });
    const insert = queries().find((query) => query.text.startsWith('INSERT INTO source_admission'));
    expect(JSON.parse(insert!.values[0] as string)).toHaveLength(40);
    const [round] = logged(log, 'shuyuan admission round') as { remainingMs: number; artifact: string }[];
    expect(round).toMatchObject({ probed: startsAt.length, written: 40, artifact: 'skipped' });
    expect(round.remainingMs).toBeGreaterThanOrEqual(WRITE_RESERVE_MS);
    // 租约先于读源表：领到才读 1.7K 行 source 大列。
    const order = queries().map((query) => query.text);
    expect(order.findIndex((text) => text.startsWith('INSERT INTO cron_health')))
      .toBeLessThan(order.findIndex((text) => text.startsWith('SELECT source_url, source FROM shuyuan_sources')));
  });

  it('租约语句：单条原子领取，到期时刻 = 库端 now() + TTL，只抢过期行', async () => {
    await runAdmissionRound();
    const [claim] = leaseQueries();
    expect(claim.values).toEqual([ADMISSION_LEASE_ROW, ADMISSION_LEASE_TTL_MS]);
    expect(claim.text).toContain("now() + ?::int * interval '1 millisecond'");
    expect(claim.text).toContain('ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at');
    expect(claim.text).toMatch(/WHERE cron_health\.last_success_at <= now\(\) RETURNING name$/);
    // TTL 须覆盖任一持有者的最长存活（路由 maxDuration 295s）。
    expect(ADMISSION_LEASE_TTL_MS).toBeGreaterThanOrEqual(295_000);
  });

  it('源表为空 ⇒ no_candidates，不发网络请求', async () => {
    expect(await runAdmissionRound()).toEqual({ skipped: 'no_candidates' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('真正跑完一轮（源表空、no_candidates）⇒ 不记 admission 成功行（42-admhealth）', async () => {
    await runAdmissionRound();
    expect(successQueries()).toHaveLength(0);
  });

  it('跑完一轮有候选并写回 ⇒ 记 admission 成功行（42-admhealth）', async () => {
    vi.useFakeTimers();
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    vi.stubEnv('ADMISSION_MAX_PROBES', '1');
    fetchMock.mockImplementation((_input, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const settled = runAdmissionRound();
    await vi.advanceTimersByTimeAsync(ADMISSION_ROUND_BUDGET_MS + 60_000);
    const summary = await settled;
    vi.useRealTimers();
    expect('skipped' in summary).toBe(false);
    const success = successQueries();
    expect(success).toHaveLength(1);
    // 成功行是 now() upsert，不是租约的「now() + TTL」——两者都借 cron_health 表，语义必须分开。
    expect(success[0].text).toContain('ON CONFLICT (name) DO UPDATE SET last_success_at = now()');
    expect(success[0].text).not.toContain('interval');
  });

  it('成功行写入失败 ⇒ 轮本身结果不变（记录失败不打挂准入，42-admhealth）', async () => {
    vi.useFakeTimers();
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    vi.stubEnv('ADMISSION_MAX_PROBES', '1');
    admissionSuccessWrite = 'fail';
    fetchMock.mockImplementation((_input, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const settled = runAdmissionRound();
    await vi.advanceTimersByTimeAsync(ADMISSION_ROUND_BUDGET_MS + 60_000);
    const summary = await settled;
    vi.useRealTimers();
    expect('skipped' in summary).toBe(false);
    expect(summary).toMatchObject({ sources: 1, candidates: 1, written: 1 });
  });

  it('租约被占（skipped:lease）⇒ 不记成功行', async () => {
    lease = 'held';
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runAdmissionRound();
    expect(successQueries()).toHaveLength(0);
  });

  it('租约被占 ⇒ 整轮跳过：不读源表、不探、不写', async () => {
    lease = 'held';
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runAdmissionRound()).toEqual({ skipped: 'lease' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queries().map((query) => query.text)).toEqual([expect.stringMatching(/^INSERT INTO cron_health/)]);
    expect(logged(log, 'shuyuan admission batch')).toEqual([{ skipped: 'lease', trigger: 'round' }]);
  });  it('租约领取报错 ⇒ fail-closed 当作没领到，不探', async () => {
    lease = 'error';
    stored = [{ source_url: 'https://dead0.example/', source: deadSource(0) }];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runAdmissionRound()).toEqual({ skipped: 'lease' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('shuyuan admission lease failed', { trigger: 'round', reason: expect.any(String) });
  });
});

describe('刷新尾部准入与租约', () => {
  async function runRefresh(): Promise<{ outcome: string; log: ReturnType<typeof vi.spyOn> }> {
    vi.useFakeTimers();
    const fixtures = new Map<string, string>([
      [indexUrl, `<a href="/yuedu/shuyuans/content/id/11.html">合集 11</a>`],
      [collectionUrl(11), JSON.stringify([deadSource(0), deadSource(1)])],
    ]);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      const body = fixtures.get(url);
      if (body !== undefined) return Promise.resolve(new Response(body, { status: 200 }));
      if (SEARCH.test(url)) return Promise.reject(new Error('fetch failed'));
      return Promise.reject(new Error(`Unexpected network request: ${url}`));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const settled = refreshShuyuan().then(() => 'resolved', (e: unknown) => `rejected: ${String(e)}`);
    await vi.advanceTimersByTimeAsync(REFRESH_BUDGET_MS + 60_000);
    return { outcome: await settled, log };
  }

  it('开关关（缺省）：尾部不发任何租约语句，照常探测（与改前逐字相同）', async () => {
    const { outcome } = await runRefresh();
    expect(outcome).toBe('resolved');
    expect(leaseQueries()).toHaveLength(0);
    expect(searches().length).toBeGreaterThan(0);
  });

  it('开关关：尾部跑完准入 ⇒ 也记 admission 成功行（42-admhealth：两个入口同记一行）', async () => {
    const { outcome } = await runRefresh();
    expect(outcome).toBe('resolved');
    const success = successQueries();
    expect(success).toHaveLength(1);
    expect(success[0].values).toEqual(['admission']);
  });

  it('开关开 + 领到租约：照常探测', async () => {
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    const { outcome } = await runRefresh();
    expect(outcome).toBe('resolved');
    expect(leaseQueries()).toHaveLength(1);
    expect(successQueries()).toHaveLength(1);
    expect(searches().length).toBeGreaterThan(0);
  });

  it('开关开 + 租约被独立轮占着：尾部整批跳过，刷新本身照常成功', async () => {
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    lease = 'held';
    const { outcome, log } = await runRefresh();
    expect(outcome).toBe('resolved');
    expect(searches()).toHaveLength(0);
    expect(queries().some((query) => query.text.startsWith('INSERT INTO source_admission'))).toBe(false);
    // 跳过（没真正跑准入）⇒ 不记成功行。
    expect(successQueries()).toHaveLength(0);
    expect(logged(log, 'shuyuan admission batch')).toEqual([{ sources: 2, skipped: 'lease', trigger: 'refresh' }]);
  });
});
