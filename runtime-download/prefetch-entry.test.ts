// prefetch-entry 合成测试（不连库、不联网、不执行生产装配）：env 固定键名、缺 limiter 固定码
// 拒绝且零 store/SQL/HTTP、DI run 参数与每轮上界、失败候选精确 URL 排除不连坐 host、busy host
// 透传、abort 零出网/归还、GitHub 键与日预算不参与；另覆盖默认真实链（fake modules/pool/
// SQL.transaction + mock fetchSourceText）：占用门与限速许可双门顺序、注入 transport 不绕过门、
// 占用被抢时零许可消耗。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourcePrefetch, type SourcePrefetch } from './prefetch-entry';
import type { PrefetchStore, PrefetchTask } from './prefetch';
import type { SourceSelector } from './source-selector';
import type { PrefetchSql } from './prefetch-store';
import type { EngineModules, SourceTransport } from './engine';

const log = vi.fn();

// 统一事件日志：门/发射按真实发生顺序各记一条，供「占用→许可→发射」顺序断言。
// occupy:/release: 由 fakeSql 记，acquire: 由 fake limiter 记，emit:/rawEmit: 由传输层记。
const mocks = vi.hoisted(() => ({
  fetchSourceText: vi.fn(),
  events: [] as string[],
}));

vi.mock('../src/lib/source-fetch', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  // 受控 fetchSourceText 模拟真实行为顺序：先过 beforeFetch 物理门（wrapTransport 占用门 →
  // createSourceTransport 限速许可 → afterAcquire 复查），再 abort 检查、最后才记发射；页面文本
  // 携带身份载荷，让 fake api 从传输层页面解析身份。sourceAbortable 等其余导出保留真实实现。
  mocks.fetchSourceText.mockImplementation(async (
    url: string,
    options: { signal: AbortSignal; beforeFetch?: (signal: AbortSignal, url: string) => void | Promise<void> },
  ) => {
    await options.beforeFetch?.(options.signal, url);
    options.signal.throwIfAborted();
    mocks.events.push(`emit:${url}`);
    return { url, text: 't1|佚名' };
  });
  return { ...actual, fetchSourceText: mocks.fetchSourceText };
});

interface FakeSqlOptions {
  /** 失败候选查询抛错（真实 SQL 故障模拟）。 */
  throwSql?: boolean;
  /** occupancy INSERT 返回 0 行：host 被他人占用，门拒绝。 */
  occupyFail?: boolean;
}

/** 记录所有 SQL 调用的文本/参数；实现 transaction（occupancy 门需要）；可注入故障。 */
function fakeSql(opts: FakeSqlOptions = {}) {
  const calls: { text: string; values: unknown[] }[] = [];
  const transactionOptions: unknown[] = [];
  const candidates = new Map<number, string[]>();
  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (opts.throwSql) throw new Error('sql down');
    if (text.includes('download_source_candidates')) {
      const bookId = Number(values[0]);
      return (candidates.get(bookId) ?? []).map(source_url => ({ source_url }));
    }
    if (text.includes('INSERT INTO download_host_occupancy')) {
      mocks.events.push(`occupy:${String(values[0])}`);
      return opts.occupyFail ? [] : [{ host: String(values[0]) }];
    }
    if (text.includes('DELETE FROM download_host_occupancy')) {
      mocks.events.push(`release:${String(values[0])}`);
      return [{ host: String(values[0]) }];
    }
    return [];
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    query(strings, ...values)) as unknown as PrefetchSql;
  // 41-zombieocc 等场景对 neon 事务签名做窄化断言——生产 sql 仍按 PrefetchSql 使用，
  // 这里只把 mock 的 transaction 属性收到能直接赋值的最小形状，避免与 neon 重载签名不兼容。
  type FakeTransaction = (fn: (tx: unknown) => unknown, options?: unknown) => Promise<unknown>;
  (sql as unknown as { transaction: FakeTransaction }).transaction = async (fn, options) => {
    transactionOptions.push(options);
    return fn(sql);
  };
  return { sql, calls, candidates, transactionOptions };
}

const task = (id: number, bookId = id * 10): PrefetchTask => ({ id, bookId, title: `t${id}`, author: '佚名' });

interface StoreOptions {
  tasks: PrefetchTask[];
  busyHosts?: string[];
}

/** 合成 store（同 prefetch.test.ts 形态）：记录 finish/release 供归还断言。 */
function createFakeStore(opts: StoreOptions) {
  const rows = opts.tasks.map(t => ({ task: t, claimed: false, finished: false, released: false }));
  const calls = { busyHosts: 0, claimNext: 0, finish: 0, release: 0 };
  const releases: { id: number; reason: string; retryDelayMs?: number }[] = [];
  const plans = new Map<number, string[]>();
  const store: PrefetchStore = {
    async busyHosts() { calls.busyHosts += 1; return [...opts.busyHosts ?? []]; },
    async claimNext() {
      calls.claimNext += 1;
      const row = rows.find(r => !r.claimed && !r.finished && !r.released);
      if (!row) return null;
      row.claimed = true;
      return row.task;
    },
    async finish(t, plan) {
      calls.finish += 1;
      const row = rows.find(r => r.task.id === t.id && r.claimed && !r.released);
      if (!row) return false;
      row.finished = true;
      plans.set(t.id, plan.sourceUrls);
      return true;
    },
    async release(t, input) {
      calls.release += 1;
      releases.push({ id: t.id, reason: input.reason, retryDelayMs: input.retryDelayMs });
      const row = rows.find(r => r.task.id === t.id && r.claimed && !r.finished);
      if (!row) return false;
      row.claimed = false;
      row.released = false;
      return true;
    },
  };
  return { store, calls, releases, plans, rows };
}

/** 合成 limiter：与下载腿共享同一实例的形态；acquire 记事件供门序断言（返回类型保留 Mock）。 */
const fakeLimiter = () => ({
  acquire: vi.fn(async (key: string) => {
    mocks.events.push(`acquire:${key}`);
    return {};
  }),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
});

const pickTwo = vi.fn<SourceSelector>(async () => ['https://a.example/b', 'https://b.example/b']);

/** 便捷构造：全部注入，env 留空（验证生产 env 键解析不触发）。 */
function entry(o: Partial<Parameters<typeof createSourcePrefetch>[0]> = {}) {
  return createSourcePrefetch({
    rateLimiter: fakeLimiter(), log, env: {} as NodeJS.ProcessEnv, ...o,
  });
}

beforeEach(() => {
  mocks.events.length = 0;
  mocks.fetchSourceText.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  log.mockClear();
});

describe('createSourcePrefetch 装配门（fail-closed）', () => {
  it('缺 rateLimiter：固定码拒绝且零 store/SQL/HTTP', () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
    const f = fakeSql();
    const s = createFakeStore({ tasks: [task(1)] });
    expect(() => createSourcePrefetch({
      rateLimiter: undefined as unknown as import('./engine').RateLimiterLike,
      log, env: {} as NodeJS.ProcessEnv, sql: f.sql, store: s.store,
    })).toThrow('PREFETCH_RATE_LIMITER_REQUIRED');
    expect(f.calls.length).toBe(0);
    expect(s.calls.busyHosts + s.calls.claimNext + s.calls.finish + s.calls.release).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('无 sql/store 注入且 env 缺 DATABASE_URL：固定键名错误且不读配置文件', () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
    expect(() => createSourcePrefetch({ rateLimiter: fakeLimiter(), log, env: {} as NodeJS.ProcessEnv }))
      .toThrow('missing environment key: DATABASE_URL');
    expect(log).not.toHaveBeenCalled();
  });

  it('注入 selector 时零生产装配：不触发 env 键、失败候选查询外无 SQL、无 GitHub/预算调用面', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
    const f = fakeSql();
    const s = createFakeStore({ tasks: [task(1)] });
    const selector: SourceSelector = pickTwo;
    const stop = await entry({ sql: f.sql, store: s.store, selector }).run(new AbortController().signal);
    expect(stop).toBe('completed');
    // 唯一 SQL 是失败候选查询；生产键（GITHUB_TOKEN 等）未被读取、日预算无消费入口。
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].text).toContain('download_source_candidates');
    expect(mocks.fetchSourceText).not.toHaveBeenCalled();
    expect(s.plans.get(1)).toEqual(['https://a.example/b', 'https://b.example/b']);
  });
});

describe('run：每轮上界与参数合同', () => {
  it('参数透传：2/200/300000、每轮 1 任务即 completed', async () => {
    const f = fakeSql();
    const s = createFakeStore({ tasks: [task(1), task(2)] });
    const selector = vi.fn(pickTwo);
    const stop = await entry({ sql: f.sql, store: s.store, selector }).run(new AbortController().signal);
    expect(stop).toBe('completed');
    expect(selector).toHaveBeenCalledTimes(1);
    const req = selector.mock.calls[0][0];
    expect(req.targetHits).toBe(2);
    expect(req.scanLimit).toBe(200);
    expect(req.budgetMs).toBeGreaterThan(0);
    expect(req.budgetMs).toBeLessThanOrEqual(300_000);
    // 包装层按 SourceSelectionTask 形状转发（bookId 留在 SQL 参数侧，不传给选源器）。
    expect(req.task).toEqual({ id: 1, title: 't1', author: '佚名' });
    expect(s.calls.claimNext).toBe(1);
  });

  it('无任务：1 次空轮询即 idle_bound（maxIdlePolls=1）', async () => {
    const f = fakeSql();
    const s = createFakeStore({ tasks: [] });
    const stop = await entry({ sql: f.sql, store: s.store, selector: vi.fn() }).run(new AbortController().signal);
    expect(stop).toBe('idle_bound');
    expect(s.calls.claimNext).toBe(1);
  });
});

describe('失败候选排除（真实 selector 包装）', () => {
  it('已有一个 host 时仅补一个新 host，已知 host 与 busy host 一并排除', async () => {
    const f = fakeSql();
    const known = { ...task(1), sourceUrls: ['https://known.example/book'] };
    const s = createFakeStore({ tasks: [known], busyHosts: ['busy.example'] });
    const selector = vi.fn<SourceSelector>(async () => ['https://new.example/book']);
    expect(await entry({ sql: f.sql, store: s.store, selector }).run(new AbortController().signal)).toBe('completed');
    expect(selector.mock.calls[0][0]).toMatchObject({ targetHits: 1, scanLimit: 200,
      excludedHosts: ['busy.example', 'known.example'] });
    // store 负责保留领取快照并追加；调度器仅交新增结果，不把旧候选重新标成已验证。
    expect(s.plans.get(1)).toEqual(['https://new.example/book']);
  });

  it('非 HTTPS 旧候选不计有效 host：缺额仍为 2，仅排除 busy host', async () => {
    // accept933 确认点：entry 只把 HTTPS 算作已知 host；http 旧候选既不缩缺额也不进 excludedHosts。
    const f = fakeSql();
    const legacy = { ...task(1), sourceUrls: ['http://legacy.example/book'] };
    const s = createFakeStore({ tasks: [legacy], busyHosts: ['busy.example'] });
    const selector = vi.fn<SourceSelector>(async () => ['https://a.example/book', 'https://b.example/book']);
    expect(await entry({ sql: f.sql, store: s.store, selector }).run(new AbortController().signal)).toBe('completed');
    expect(selector.mock.calls[0][0]).toMatchObject({ targetHits: 2, excludedHosts: ['busy.example'] });
    expect(s.plans.get(1)).toEqual(['https://a.example/book', 'https://b.example/book']);
  });

  it('按 bookId 参数化查询 failure<>空串，传精确 URL 不连坐 host', async () => {
    const f = fakeSql();
    f.candidates.set(10, ['https://h1.example/x', 'https://h1.example/y']);
    const s = createFakeStore({ tasks: [task(1)] });
    const selector = vi.fn(pickTwo);
    await entry({ sql: f.sql, store: s.store, selector }).run(new AbortController().signal);
    const candidateCall = f.calls.find(c => c.text.includes('download_source_candidates'))!;
    expect(candidateCall.values[0]).toBe(10);
    expect(candidateCall.text).toContain('failure');
    const req = selector.mock.calls[0][0];
    // 精确 URL 全部传入（同 host 的另一 URL 不连坐删除，host 字符串本身不出现在列表里）。
    expect(req.excludedSources.sort()).toEqual(['https://h1.example/x', 'https://h1.example/y'].sort());
    expect(req.excludedSources).not.toContain('h1.example');
  });

  it('失败候选查询耗时从单书预算扣除，并向数据库传中止信号', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
    try {
      const f = fakeSql();
      const s = createFakeStore({ tasks: [task(1)] });
      const selector = vi.fn(pickTwo);
      await entry({ sql: f.sql, store: s.store, selector }).run(new AbortController().signal);
      expect(selector.mock.calls[0][0].budgetMs).toBe(290_000);
      expect(f.transactionOptions[0]).toMatchObject({
        readOnly: true, fetchOptions: { signal: expect.any(AbortSignal) },
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('查询期间中止时不调用选源器，归还预取资格', async () => {
    const controller = new AbortController();
    const f = fakeSql();
    f.sql.transaction = async () => {
      controller.abort(new Error('prefetch_aborted'));
      return [];
    };
    const s = createFakeStore({ tasks: [task(1)] });
    const selector = vi.fn();
    expect(await entry({ sql: f.sql, store: s.store, selector }).run(controller.signal)).toBe('aborted');
    expect(selector).not.toHaveBeenCalled();
    expect(s.calls.finish).toBe(0);
    expect(s.releases[0]).toMatchObject({ id: 1, reason: 'aborted' });
  });

  it('查询失败：不盲扫，selector 不被调，错误原样抛给调度器按 scan_failed 退避归还', async () => {
    const f = fakeSql({ throwSql: true });
    const s = createFakeStore({ tasks: [task(1)] });
    const selector = vi.fn();
    // 失败退避默认 60s：用首次 SQL 调用后即 abort 截断退避等待，让 run 可收口。
    const controller = new AbortController();
    const transaction = (f.sql as unknown as { transaction: (fn: (tx: unknown) => unknown, options?: unknown) => Promise<unknown> }).transaction;
    (f.sql as unknown as { transaction: (fn: (tx: unknown) => unknown, options?: unknown) => Promise<unknown> }).transaction = async (build, options) => {
      setTimeout(() => controller.abort(new Error('prefetch_aborted')), 0);
      return transaction(build, options);
    };
    const stop = await entry({ sql: f.sql, store: s.store, selector }).run(controller.signal);
    expect(stop).toBe('aborted');
    expect(selector).not.toHaveBeenCalled();
    expect(s.releases[0]).toMatchObject({ id: 1, reason: 'scan_failed' });
    expect(s.releases[0].retryDelayMs).toBe(60_000);
    // 包装层日志只记固定原因码；SQL/error 真值不进（调度器自身另有一条预扫失败日志）。
    const wrapperLogs = log.mock.calls.filter(c => c[1] === '预取：已失败候选查询失败');
    expect(wrapperLogs.length).toBe(1);
    expect(wrapperLogs[0][2]).toMatchObject({ taskId: 1, bookId: 10, reason: 'failed_candidates_query_failed' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('sql down');
  });
});

describe('busy host 与 abort 合同', () => {
  it('busy host 快照透传给 selector 的 excludedHosts', async () => {
    const f = fakeSql();
    const s = createFakeStore({ tasks: [task(1)], busyHosts: ['busy.example'] });
    const selector = vi.fn(pickTwo);
    await entry({ sql: f.sql, store: s.store, selector }).run(new AbortController().signal);
    expect(selector.mock.calls[0][0].excludedHosts).toEqual(['busy.example']);
  });

  it('run 前已中止：零出网、零领取、零归还（无持有态即无归还对象）', async () => {
    const f = fakeSql();
    const s = createFakeStore({ tasks: [task(1)] });
    const selector = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('prefetch_aborted'));
    const stop = await entry({ sql: f.sql, store: s.store, selector }).run(controller.signal);
    expect(stop).toBe('aborted');
    expect(selector).not.toHaveBeenCalled();
    expect(s.calls.claimNext).toBe(0);
    expect(s.calls.finish).toBe(0);
    expect(s.releases).toEqual([]);
    expect(f.calls.length).toBe(0);
  });

  it('运行中 abort：持有任务被归还，run 随调用方 signal 结束，无新建常驻 signal', async () => {
    const f = fakeSql();
    const s = createFakeStore({ tasks: [task(1)] });
    // 1ms 时中止落在 selector 等待窗口内（20ms 才返回）：scan 中止 → 归还 → aborted。
    const selector = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return ['https://a.example/b', 'https://b.example/b'];
    });
    const controller = new AbortController();
    const pending = entry({ sql: f.sql, store: s.store, selector }).run(controller.signal);
    setTimeout(() => controller.abort(new Error('prefetch_aborted')), 1);
    const stop = await pending;
    expect(stop).toBe('aborted');
    expect(s.calls.finish).toBe(0);
    expect(s.releases).toEqual([{ id: 1, reason: 'aborted', retryDelayMs: undefined }]);
  });
});

/**
 * 默认真实链用例（不注入 selector/transport）：modules/loadPool/sql/store 注入合成物，
 * fetchSourceText 被 mock 成受控页源（不联网），createSourceTransport(limiter) 与
 * occupancy.wrapTransport 都是真实实现——用统一事件日志证明门序（occupy → acquire → emit），
 * 每次 wrapTransport 调用自持 prefetch scope（结束后 release）。
 */
describe('默认真实链（真实 selector/transport/occupancy 装配）', () => {
  /** 与 identity-precheck pageContext 的 ctx 同形：{ signal, page(url) }，page 经真实 transport 出网。 */
  type FakeCtx = { signal: AbortSignal; page: (url: string) => Promise<{ url: string; text: string }> };

  interface DefaultChain {
    f: ReturnType<typeof fakeSql>;
    s: ReturnType<typeof createFakeStore>;
    limiter: ReturnType<typeof fakeLimiter>;
    prefetch: SourcePrefetch;
  }

  /** selector 实际读取的最小模块形状（api/compile/supported）；不伪装完整 EngineModules。 */
  interface SelectorModules {
    compile: { compileSource(source: unknown): unknown };
    supported: { BUILTIN_SOURCE_HOSTS: readonly string[] };
    api: {
      engineSearchBook(engine: { url: string }, title: string, ctx: FakeCtx): Promise<Array<{ title?: string; author?: string; bookUrl: string }>>;
      engineFetchDetail(engine: { url: string }, bookUrl: string, ctx: FakeCtx): Promise<{ title?: string; author?: string }>;
    };
  }

  function fakeModules(): SelectorModules {
    return {
      api: {
        // 搜索/详情都经 ctx.page 走真实 transport 链；身份从页面文本解析，不直接返回硬编码身份。
        engineSearchBook: async (engine, _title, ctx) => {
          const page = await ctx.page(`${engine.url}/search`);
          const [title, author] = page.text.split('|');
          return [{ title, author, bookUrl: `${engine.url}/detail` }];
        },
        engineFetchDetail: async (_engine, bookUrl, ctx) => {
          const page = await ctx.page(bookUrl);
          const [title, author] = page.text.split('|');
          return { title, author };
        },
      },
      compile: { compileSource: () => ({}) },
      supported: { BUILTIN_SOURCE_HOSTS: ['book15.net', 'www.book15.net'] },
    };
  }

  function buildDefaultChain(
    pool: string[],
    over: { failed?: string[]; busyHosts?: string[]; transport?: SourceTransport } & FakeSqlOptions = {},
  ): DefaultChain {
    const f = fakeSql({ throwSql: over.throwSql, occupyFail: over.occupyFail });
    if (over.failed) f.candidates.set(10, over.failed);
    const s = createFakeStore({ tasks: [task(1)], busyHosts: over.busyHosts });
    const limiter = fakeLimiter();
    const prefetch = createSourcePrefetch({
      rateLimiter: limiter,
      log,
      env: {} as NodeJS.ProcessEnv,
      sql: f.sql,
      store: s.store,
      // DI 边界单点转型：窄合成形状只覆盖 selector 读取面。
      modules: fakeModules() as unknown as EngineModules,
      loadPool: async () => pool.map(url => ({ url, name: url, searchUrl: url })),
      ...(over.transport ? { transport: over.transport } : {}),
    });
    return { f, s, limiter, prefetch };
  }

  it('默认链全通：排除生效后仅一源出网，occupy→acquire→occupy(复查)→emit→release 门序、plan 落库', async () => {
    const chain = buildDefaultChain(
      ['https://failed.example/x', 'https://busy.example/y', 'https://book15.net/a', 'https://pick.example/ok'],
      { failed: ['https://failed.example/x'], busyHosts: ['busy.example'] },
    );
    const stop = await chain.prefetch.run(new AbortController().signal);
    expect(stop).toBe('completed');
    // 失败候选（精确 URL）、busy host（store.busyHosts 注入的快照）、builtin host 三重排除生效。
    // 两阶段门（真实 engine）：每次发射前 beforeFetch 占用→限速许可→afterAcquire 占用复查，
    // 才进发射；该次 wrapTransport scope 结束后归还（release:）。
    expect(mocks.events).toEqual([
      'occupy:pick.example', 'acquire:pick.example', 'occupy:pick.example', 'emit:https://pick.example/ok/search', 'release:pick.example',
      'occupy:pick.example', 'acquire:pick.example', 'occupy:pick.example', 'emit:https://pick.example/ok/detail', 'release:pick.example',
    ]);
    expect(chain.limiter.recordSuccess).toHaveBeenCalledTimes(2);
    expect(chain.limiter.recordFailure).not.toHaveBeenCalled();
    // 入选的是精确 source.url（非 host），经 store.finish 落 plan。
    expect(chain.s.plans.get(1)).toEqual(['https://pick.example/ok']);
  });

  it('注入 transport 仍过占用门：wrapTransport 不被绕过（占用 INSERT 每请求两次）', async () => {
    // 注入方自带门：不走 createSourceTransport，故 limiter 不被触碰；两阶段占用门照常各执行一次。
    const transport: SourceTransport = async (url, options) => {
      await options.beforeFetch?.(options.signal, url);
      await options.afterAcquire?.(options.signal, url);
      options.signal.throwIfAborted();
      mocks.events.push(`rawEmit:${url}`);
      return { url, text: 't1|佚名' };
    };
    const chain = buildDefaultChain(['https://pick.example/ok'], { transport });
    const stop = await chain.prefetch.run(new AbortController().signal);
    expect(stop).toBe('completed');
    expect(mocks.events).toEqual([
      'occupy:pick.example', 'occupy:pick.example', 'rawEmit:https://pick.example/ok/search', 'release:pick.example',
      'occupy:pick.example', 'occupy:pick.example', 'rawEmit:https://pick.example/ok/detail', 'release:pick.example',
    ]);
    expect(chain.limiter.acquire).not.toHaveBeenCalled();
    expect(chain.f.calls.some(c => c.text.includes('INSERT INTO download_host_occupancy'))).toBe(true);
    expect(chain.s.plans.get(1)).toEqual(['https://pick.example/ok']);
  });

  it('占用被抢（INSERT 0 行）：门在 beforeFetch 内拒绝，零发射零许可，无 plan 即归还', async () => {
    const controller = new AbortController();
    const chain = buildDefaultChain(['https://pick.example/ok'], { occupyFail: true });
    // 门拒绝 → 单源跳过 → 无候选 → no_sources 归还（fake store 归还后可再领，调度器会立即重领）：
    // 在归还回调里确定性地 abort，让下一轮 while 条件退出收口，不依赖计时器。
    const originalRelease = chain.s.store.release.bind(chain.s.store);
    chain.s.store.release = async (t, input) => {
      const ok = await originalRelease(t, input);
      if (input.reason === 'no_sources') controller.abort(new Error('prefetch_aborted'));
      return ok;
    };
    const stop = await chain.prefetch.run(controller.signal);
    expect(stop).toBe('aborted');
    // 传输层确实进入（fetchSourceText 被调 1 次），拒绝发生在门内部：零 emit、零 acquire。
    expect(mocks.fetchSourceText).toHaveBeenCalledTimes(1);
    expect(mocks.events.filter(e => e.startsWith('occupy:')).length).toBe(1);
    expect(mocks.events.some(e => e.startsWith('acquire:') || e.startsWith('emit:'))).toBe(false);
    expect(chain.limiter.recordFailure).not.toHaveBeenCalled();
    expect(chain.s.calls.finish).toBe(0);
    expect(chain.s.releases).toEqual([{ id: 1, reason: 'no_sources', retryDelayMs: 60_000 }]);
  });
});
