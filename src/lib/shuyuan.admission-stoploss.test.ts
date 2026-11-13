// 41-ADMIT-CONC-FIX:端到端钉死「逐探止损」。断言写的是基点 3059eb5 的行为:
// 刷新阶段耗 53s 后准入 20 个死站,refresh 必须 resolve、写满 20 行并打 batch 日志。
// 5f3b506(名额在批次开头一次性领完)上本测试必红:refresh reject DeadlineExceededError、写 0 行、无日志。
// harness 照抄 shuyuan.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Query = { text: string; values: unknown[] };
type TransactionOptions = { readOnly?: boolean; fetchOptions?: { signal: AbortSignal } };

const { ensureSchema, getSql, sql, execute, transaction, readTransaction } = vi.hoisted(() => {
  const execute = vi.fn<(query: Query) => Promise<unknown[]>>();
  // urlfix：neon 的 sql.unsafe(raw) 把原始 SQL 片段内联进 text（不是参数绑定），
  // 归一化表达式依赖它；其余插值照旧进 values（mock 风格用 ? 占位）。
  const isUnsafe = (value: unknown): value is { __unsafe: true; raw: string } =>
    typeof value === 'object' && value !== null && '__unsafe' in value;
  const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const bound: unknown[] = [];
    strings.forEach((part, index) => {
      text += part;
      if (index < values.length) {
        const value = values[index];
        if (isUnsafe(value)) { text += value.raw; } else { bound.push(value); text += '?'; }
      }
    });
    const query = { text: text.replace(/\s+/g, ' ').trim(), values: bound };
    return {
      ...query,
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected: (error: unknown) => unknown) {
        return execute(query).then(onFulfilled, onRejected);
      },
    };
  });
  const sql = Object.assign(tag, { unsafe: (raw: string) => ({ __unsafe: true, raw } as unknown) });
  return {
    ensureSchema: vi.fn(), getSql: vi.fn(), sql, execute,
    transaction: vi.fn<(queries: Query[], options?: TransactionOptions) => Promise<unknown[][]>>(),
    readTransaction: vi.fn<(queries: Query[], options?: TransactionOptions) => Promise<unknown[][]>>(),
  };
});

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

import { refreshShuyuan, REFRESH_BUDGET_MS, ADMISSION_LEASE_ROW } from './shuyuan';
import { createDeadline } from '@/lib/deadline';

// probecap1113:admissionProbeCapMs 的 env 解析(夹取规则)。
import { admissionProbeCapMs } from './shuyuan';

describe('probecap1113: ADMISSION_PROBE_CAP_MS env 解析', () => {
  afterEach(() => vi.restoreAllMocks());
  it('缺失/非法/≤0 → undefined(关,行为逐字不变)', () => {
    expect(admissionProbeCapMs({})).toBeUndefined();
    expect(admissionProbeCapMs({ ADMISSION_PROBE_CAP_MS: 'abc' })).toBeUndefined();
    expect(admissionProbeCapMs({ ADMISSION_PROBE_CAP_MS: '0' })).toBeUndefined();
    expect(admissionProbeCapMs({ ADMISSION_PROBE_CAP_MS: '-5000' })).toBeUndefined();
  });
  it('正整数夹在 [8000, admissionProbeWorstMs(env)] 内(默认 env 全关口径 16.7s)', () => {
    expect(admissionProbeCapMs({ ADMISSION_PROBE_CAP_MS: '30000' })).toBe(16_700);
    expect(admissionProbeCapMs({ ADMISSION_PROBE_CAP_MS: '5000' })).toBe(8_000);
    expect(admissionProbeCapMs({ ADMISSION_PROBE_CAP_MS: '999999' })).toBe(16_700);
    // 联网开关全开(生产 confirm 轮口径):worst=18 请求×8.35s=150.3s,30s 不再被夹。
    const netJsEnv = {
      ADMISSION_PROBE_CAP_MS: '30000',
      ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1',
    };
    expect(admissionProbeCapMs(netJsEnv)).toBe(30_000);
  });
});

const indexUrl = 'https://www.yckceo.com/yuedu/shuyuans/index.html';
const collectionUrl = (id: number) => `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
const zeroCounts = { total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0 };
const responses = new Map<string, { body: string; delayMs: number }>();
const fetchMock = vi.fn<typeof fetch>();

describe('41-ADMIT-CONC-FIX:refreshShuyuan 准入逐探止损(端到端,c 缺省=1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // admlfix42：刷新尾部无条件领准入租约；默认领到（返回租约行）使准入照常跑。
    execute.mockReset().mockImplementation(async (query) => {
      if (query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW) {
        return [{ name: ADMISSION_LEASE_ROW, generation: '1' }];
      }
      return query.text.startsWith('SELECT count(*)') ? [zeroCounts] : [];
    });
    transaction.mockReset().mockImplementation(async (batch) => {
      if (!batch.some((query) => query.text.startsWith('SELECT name FROM cron_health'))) return [];
      const results = [];
      for (const query of batch) results.push(await execute(query));
      const writeIndex = batch.findIndex((query) => query.text.includes('INSERT INTO source_admission'));
      if (writeIndex >= 0) {
        results[writeIndex] = [{ lease_valid: true, written: JSON.parse(batch[writeIndex].values[2] as string).length }];
      }
      return results;
    });
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('刷新阶段耗 53s 后准入 20 个死站:逐探止损、20 行落库、refresh 正常返回', async () => {
    vi.useFakeTimers();
    const dead = Array.from({ length: 20 }, (_, i) => ({
      bookSourceUrl: `https://dead${i}.example/`, bookSourceName: `死站${i}`,
      searchUrl: `https://dead${i}.example/s?q={{key}}`,
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
      ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '.c' },
    }));
    responses.clear();
    // 索引 20s(< 24s 超时)+ 3 个合集各 11s(< 12s 超时)= 53s,准入开始时剩 ≈127s。
    responses.set(indexUrl, {
      body: [11, 12, 13].map((id) => `<a href="/yuedu/shuyuans/content/id/${id}.html">合集 ${id}</a>`).join(''),
      delayMs: 20_000,
    });
    responses.set(collectionUrl(11), { body: JSON.stringify(dead), delayMs: 11_000 });
    responses.set(collectionUrl(12), { body: '[]', delayMs: 11_000 });
    responses.set(collectionUrl(13), { body: '[]', delayMs: 11_000 });
    const t0 = Date.now();
    const searchStartsAt: number[] = [];
    fetchMock.mockImplementation((input, options) => {
      const url = String(input);
      const fixture = responses.get(url);
      if (fixture) {
        return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(fixture.body, { status: 200 })), fixture.delayMs));
      }
      if (/^https:\/\/dead\d+\.example\/s\?q=/.test(url)) {
        searchStartsAt.push(Math.round((Date.now() - t0) / 1000));
        const probeSignal = options!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          probeSignal.addEventListener('abort', () => reject(probeSignal.reason), { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected network request: ${url}`));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const settled = refreshShuyuan().then(
      () => 'resolved',
      (e: unknown) => `rejected: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    );
    await vi.advanceTimersByTimeAsync(REFRESH_BUDGET_MS + 60_000);
    const outcome = await settled;
    const insert = execute.mock.calls.find(([query]) => query.text.includes('INSERT INTO source_admission'));
    const written = insert ? (JSON.parse(insert[0].values[2] as string) as { search_verdict: string }[]) : [];
    const batchLog = log.mock.calls.find(([message]) => message === 'shuyuan admission batch');
    // 基点 3059eb5 实测:resolved、搜索 15 次(末次 t=165s)、20 行(15 conn_fail + 5 占位)、有 batch 日志。
    // espfix41:开对照搜索后止损按单探最坏 ADMISSION_PROBE_WORST_MS(16.35s)预留,剩 >21.35s 才起探 ⇒
    // 14 次(末次 t=157s,结束 165s 时仍剩 15s ≥ 写库预留)、14 conn_fail + 6 占位。
    expect(outcome).toBe('resolved');
    expect(searchStartsAt).toHaveLength(14);
    expect(searchStartsAt.at(-1)).toBe(157);
    expect(written).toHaveLength(20);
    expect(written.filter((row) => row.search_verdict === 'conn_fail')).toHaveLength(14);
    expect(batchLog?.[1]).toMatchObject({ candidates: 20, probed: 14 });
  });

  it('probecap1113: cap 止损预留小于理论最坏 ⇒ 同预算内起探更多(注入假时钟,直接驱动 runAdmissionBatch)', async () => {
    vi.useFakeTimers();
    try {
      const { runAdmissionBatch } = await import('./rule-engine/admission');
      const hosts = Array.from({ length: 10 }, (_, i) => `cap${i}.example.com`);
      const candidates = hosts.map((host) => ({
        url: `https://${host}`,
        source: {
          bookSourceUrl: `https://${host}/`, bookSourceName: `源${host}`, searchUrl: `https://${host}/s?q={{key}}`,
          checkKeyWord: '测试关键字',
          ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
          ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
          ruleContent: { content: '.c' },
        },
      }));
      const searches: number[] = [];
      const t0 = Date.now();
      const fetchPage = vi.fn((_input: unknown, init: { signal: AbortSignal }) => {
        searches.push(Date.now() - t0);
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('<html>no results</html>', { status: 200 })), 20_000);
          init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
        });
      });
      const run = (probeCapMs: number | undefined) => {
        searches.length = 0;
        const deadline = createDeadline(120_000);
        const settled = runAdmissionBatch({
          candidates, declaredHosts: new Set(hosts), existing: new Map(),
          fetchPage: fetchPage as never, signal: deadline.signal, throttleMs: 0, maxProbes: 10,
          ...(probeCapMs !== undefined ? { probeCapMs, timeoutSignal: (ms: number) => {
            const c = new AbortController();
            setTimeout(() => c.abort(new Error('probe cap exceeded')), ms);
            return c.signal;
          } } : {}),
          canProbe: () => !deadline.signal.aborted
            && deadline.remainingMs > (probeCapMs ?? 21_700) + 5_000,
        }).then(() => 'resolved', () => 'rejected');
        return { settled, deadline };
      };
      // 无 cap:止损按 16.7s 最坏 +5s 预留,每探 20s ⇒ 120s 只起 4-5 探。
      const noCap = run(undefined);
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await noCap.settled).toBe('resolved');
      noCap.deadline.dispose();
      const noCapSearches = searches.length;
      // 开 cap=8s(=单请求超时下限,止损 13s 预留):每探要么 8s 内被截(占位),要么 20s 返回——
      // 但截断后 12s 又能起下一探 ⇒ 起探次数严格多于无 cap。
      const withCap = run(8_000);
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await withCap.settled).toBe('resolved');
      withCap.deadline.dispose();
      expect(searches.length).toBeGreaterThan(noCapSearches);
    } finally {
      vi.useRealTimers();
    }
  });
});
