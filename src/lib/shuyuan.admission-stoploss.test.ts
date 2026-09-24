// 41-ADMIT-CONC-FIX:端到端钉死「逐探止损」。断言写的是基点 3059eb5 的行为:
// 刷新阶段耗 53s 后准入 20 个死站,refresh 必须 resolve、写满 20 行并打 batch 日志。
// 5f3b506(名额在批次开头一次性领完)上本测试必红:refresh reject DeadlineExceededError、写 0 行、无日志。
// harness 照抄 shuyuan.test.ts。
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

import { refreshShuyuan, REFRESH_BUDGET_MS } from './shuyuan';

const indexUrl = 'https://www.yckceo.com/yuedu/shuyuans/index.html';
const collectionUrl = (id: number) => `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
const zeroCounts = { total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0 };
const responses = new Map<string, { body: string; delayMs: number }>();
const fetchMock = vi.fn<typeof fetch>();

describe('41-ADMIT-CONC-FIX:refreshShuyuan 准入逐探止损(端到端,c 缺省=1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockReset().mockImplementation(async (query) => query.text.startsWith('SELECT count(*)') ? [zeroCounts] : []);
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
    const insert = execute.mock.calls.find(([query]) => query.text.startsWith('INSERT INTO source_admission'));
    const written = insert ? (JSON.parse(insert[0].values[0] as string) as { search_verdict: string }[]) : [];
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
});
