// 共用选源器单元层（不连库、不联网）：扫描上限与早停、排除口径（URL 精确 / host 快照）、
// 身份判据与每源详情上限、停止语义（caller abort / 预算耗尽 / 池失败）、无持久化入口与日志脱敏。
import { describe, expect, it } from 'vitest';
import { createSourceSelector, type SourceSelectionRequest } from './source-selector';

const TASK = { id: 11, title: '测试书', author: '佚名' };
const hang = <T,>() => new Promise<T>(() => {});
const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

type Hit = { title?: string; author?: string; bookUrl: string };
type Detail = { title?: string; author?: string };

function harness(opts: {
  pool?: string[];
  poolThrows?: 'sync' | 'async';
  search?: (url: string, key: string) => Hit[] | Promise<Hit[]>;
  detail?: (bookUrl: string) => Detail;
  suspect?: string[];
  builtinHosts?: string[];
  hostPriority?: (signal: AbortSignal) => Promise<ReadonlyMap<string, number>>;
  doomed?: string[];
  skipStrictToc?: boolean;
}) {
  const searchedUrls: string[] = [];
  const searchKeys: string[] = [];
  const detailUrls: string[] = [];
  const poolLoads: number[] = [];
  const compiles: string[] = [];
  const logs: Array<{ level: 'info' | 'error'; message: string; fields?: Record<string, unknown> }> = [];
  const selector = createSourceSelector({
    modules: {
      compile: { compileSource: (s: { url: string }) => { compiles.push(s.url); return { url: s.url }; } },
      supported: { BUILTIN_SOURCE_HOSTS: opts.builtinHosts ?? ['book15.net', 'www.book15.net'] },
      api: {
        // 非 async：让 search 能同步 throw（穿透到 sourceHasBook 成 rejection）。
        engineSearchBook: (engine: { url: string }, key: string) => {
          searchedUrls.push(engine.url);
          searchKeys.push(key);
          return opts.search?.(engine.url, key) ?? [{ title: TASK.title, author: TASK.author, bookUrl: `${engine.url}b/1` }];
        },
        engineFetchDetail: (_engine: unknown, bookUrl: string) => {
          detailUrls.push(bookUrl);
          return Promise.resolve(opts.detail?.(bookUrl) ?? { title: TASK.title, author: TASK.author });
        },
        strictTocUnsupported: (compiled: { url: string }) => opts.doomed?.includes(compiled.url) ?? false,
      },
    },
    transport: async () => { throw new Error('unused'); },
    loadPool: () => {
      poolLoads.push(1);
      if (opts.poolThrows === 'sync') throw new Error('pool sync down');
      return (async () => {
        if (opts.poolThrows === 'async') throw new Error('pool async down');
        return (opts.pool ?? []).map(url => ({ url, name: url, searchUrl: '/s' }));
      })();
    },
    isSuspect: (host: string) => opts.suspect?.includes(host) ?? false,
    log: (level, message, fields) => logs.push({ level, message, fields }),
    hostPriority: opts.hostPriority,
    skipStrictToc: opts.skipStrictToc,
  });
  return { selector, searchedUrls, searchKeys, detailUrls, poolLoads, logs, compiles };
}

const request = (over: Partial<SourceSelectionRequest> = {}): SourceSelectionRequest => ({
  task: TASK, excludedHosts: [], excludedSources: [], targetHits: 2, scanLimit: 200, budgetMs: 30_000, ...over,
});
const freshSignal = () => new AbortController().signal;

describe('共用选源器', () => {
  it('逐书出网封顶：书不在池里最多扫 scanLimit 个源，不必扫完整池', async () => {
    const pool = Array.from({ length: 220 }, (_, i) => `https://s${i}.example/`);
    const h = harness({ pool, search: () => [] });
    expect((await h.selector(request({ scanLimit: 200 }), freshSignal())).picked).toEqual([]);
    expect(h.searchedUrls).toHaveLength(200);
    expect(h.detailUrls).toEqual([]);
  });

  it('toctgate1030：skipStrictToc 开 ⇒ strict 目录必拒的源零出网出池、不耗 scanLimit；关 ⇒ 逐字同改前', async () => {
    const pool = ['https://a.example/', 'https://q.example/', 'https://b.example/', 'https://c.example/'];
    const on = harness({ pool, search: () => [], doomed: ['https://q.example/'], skipStrictToc: true });
    expect((await on.selector(request({ scanLimit: 3 }), freshSignal())).scanned).toBe(3);
    expect(on.searchedUrls).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    // 同一规则对象第二轮选源走记忆，不重编译判定。
    const before = on.compiles.filter(u => u === 'https://q.example/').length;
    await on.selector(request({ scanLimit: 3 }), freshSignal());
    expect(on.compiles.filter(u => u === 'https://q.example/').length).toBe(before);
    const off = harness({ pool, search: () => [], doomed: ['https://q.example/'] });
    await off.selector(request({ scanLimit: 3 }), freshSignal());
    expect(off.searchedUrls).toEqual(['https://a.example/', 'https://q.example/', 'https://b.example/']);
    expect(off.compiles).toEqual(off.searchedUrls);
  });

  it('yield1030：hostPriority 稳定重排——高分 host 先扫，同分与缺席保持池序，scanLimit 不变', async () => {
    const pool = ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/', 'https://c.example/zh/'];
    const h = harness({ pool, search: () => [],
      hostPriority: async () => new Map([['c.example', 5], ['d.example', 5], ['b.example', 1]]) });
    await h.selector(request({ scanLimit: 4 }), freshSignal());
    expect(h.searchedUrls).toEqual(['https://c.example/', 'https://d.example/', 'https://c.example/zh/', 'https://b.example/']);
  });

  it('yield1030：hostPriority 抛错/空表 ⇒ 池序原样扫，不少扫', async () => {
    const pool = ['https://a.example/', 'https://b.example/'];
    for (const hostPriority of [async () => { throw new Error('db down'); }, async () => new Map<string, number>()]) {
      const h = harness({ pool, search: () => [], hostPriority });
      expect((await h.selector(request(), freshSignal())).scanned).toBe(2);
      expect(h.searchedUrls).toEqual(pool);
    }
  });

  it('yield1030：重排不绕过过滤——高分的 builtin/suspect/排除 host 照旧跳过', async () => {
    const pool = ['https://a.example/', 'https://book15.net/', 'https://s.example/', 'https://x.example/'];
    const h = harness({ pool, search: () => [], suspect: ['s.example'],
      hostPriority: async () => new Map([['book15.net', 9], ['s.example', 9], ['x.example', 9]]) });
    await h.selector(request({ excludedHosts: ['x.example'] }), freshSignal());
    expect(h.searchedUrls).toEqual(['https://a.example/']);
  });

  it('rotate1030：第 k 轮整体左移 k×scanLimit，几轮即覆盖全池；rotate=0 逐字同池序', async () => {
    const pool = Array.from({ length: 10 }, (_, i) => `https://s${i}.example/`);
    const scans: string[][] = [];
    for (const rotate of [0, 1, 2, 3]) {
      const h = harness({ pool, search: () => [] });
      expect((await h.selector(request({ scanLimit: 3, rotate }), freshSignal())).scanned).toBe(3);
      scans.push(h.searchedUrls.map(url => url.slice(8, 10)));
    }
    expect(scans).toEqual([['s0', 's1', 's2'], ['s3', 's4', 's5'], ['s6', 's7', 's8'], ['s9', 's0', 's1']]);
  });

  it('rotate1030：优先段钉在最前不参与轮转；窗口扣掉优先段，偏移只数可扫源', async () => {
    const pool = ['http://skip.example/', 'https://t0.example/', 'https://busy.example/', 'https://t1.example/', 'https://p.example/',
      'https://t2.example/', 'https://t3.example/', 'https://t4.example/'];
    const h = harness({ pool, search: () => [], hostPriority: async () => new Map([['p.example', 3]]) });
    await h.selector(request({ scanLimit: 3, rotate: 1, excludedHosts: ['busy.example'] }), freshSignal());
    // 窗口 = 3 − 1（p 可扫）= 2；尾段可扫 t0..t4，跳过 2 个可扫源（t0、t1）⇒ 从 t2 起扫。
    expect(h.searchedUrls).toEqual(['https://p.example/', 'https://t2.example/', 'https://t3.example/']);
  });

  it('rotate1030：尾段可扫源不超过一个窗口 ⇒ 不转（本来就扫得完）', async () => {
    const pool = ['https://a.example/', 'https://b.example/', 'https://c.example/'];
    const h = harness({ pool, search: () => [] });
    await h.selector(request({ scanLimit: 3, rotate: 5 }), freshSignal());
    expect(h.searchedUrls).toEqual(pool);
  });

  it('共享扫描余额跨调用保留，过滤不扣额，耗尽后不再读池', async () => {
    const h = harness({ pool: ['http://skip.example/', 'https://a.example/', 'https://b.example/', 'https://c.example/'] });
    const scanBudget = { remaining: 3 };
    expect((await h.selector(request({ scanBudget }), freshSignal())).picked).toEqual(['https://a.example/', 'https://b.example/']);
    expect(scanBudget.remaining).toBe(1);
    expect((await h.selector(request({ scanBudget, excludedSources: ['https://a.example/', 'https://b.example/'] }), freshSignal())).picked)
      .toEqual(['https://c.example/']);
    expect(scanBudget.remaining).toBe(0);
    expect((await h.selector(request({ scanBudget }), freshSignal())).picked).toEqual([]);
    expect(h.poolLoads).toHaveLength(2);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
  });

  it('扫描抛门后端故障也保留已消耗的额度，不因异常恢复余额', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'], search: () => {
      throw Object.assign(new Error('synthetic gate'), { code: 'HOST_OCCUPANCY_UNAVAILABLE' });
    } });
    const scanBudget = { remaining: 2 };
    await expect(h.selector(request({ scanBudget }), freshSignal())).rejects.toMatchObject({ code: 'HOST_OCCUPANCY_UNAVAILABLE' });
    expect(scanBudget.remaining).toBe(1);
    expect(h.searchedUrls).toEqual(['https://a.example/']);
  });

  it('命中 targetHits 个不同 host 早停（2 与 3）', async () => {
    const pool = ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/', 'https://e.example/'];
    const two = harness({ pool });
    expect((await two.selector(request({ targetHits: 2 }), freshSignal())).picked).toEqual(['https://a.example/', 'https://b.example/']);
    expect(two.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
    const three = harness({ pool });
    expect((await three.selector(request({ targetHits: 3 }), freshSignal())).picked).toHaveLength(3);
    expect(three.searchedUrls).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
  });

  it('同 host 重复候选：已命中 host 不再扫，另一 host 补位', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://a.example/other/', 'https://b.example/'] });
    expect((await h.selector(request(), freshSignal())).picked).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('busy/suspect/builtin/非 https/非法 URL 过滤不耗 scanLimit', async () => {
    const h = harness({
      pool: ['https://book15.net/x', 'http://plain.example/', 'not a url', 'https://dead.example/', 'https://busy.example/',
        'https://a.example/', 'https://b.example/', 'https://c.example/'],
      suspect: ['dead.example'],
    });
    expect((await h.selector(request({ excludedHosts: ['busy.example'], scanLimit: 2 }), freshSignal())).picked)
      .toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.poolLoads).toEqual([1]);
  });

  it('qqpay42 付费墙 host 跳过：挂书命中也不进 picked、不耗扫描槽位', async () => {
    // 付费墙站恒挂书（搜索命中、正文拿不到）——qq 4 host 即便命中也须跳过；
    // scanLimit=2 钉住「跳过不耗槽位」：若耗槽位，两个免费源一个都扫不到。
    const h = harness({
      pool: ['https://book.qq.com/', 'https://chuangshi.qq.com/', 'https://ubook.reader.qq.com/',
        'https://yunqi.qq.com/', 'https://a.example/', 'https://b.example/'],
    });
    expect((await h.selector(request({ scanLimit: 2 }), freshSignal())).picked).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.logs[0].fields).toMatchObject({ scanned: 2, candidates: 2 });
  });

  it('已失败 URL 只按精确 source_url 排除：A/B 排除后补 C/D；同 host 不同 source URL 仍可选', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'] });
    expect((await h.selector(request({ excludedSources: ['https://a.example/', 'https://b.example/'] }), freshSignal())).picked)
      .toEqual(['https://c.example/', 'https://d.example/']);
    expect(h.searchedUrls).toEqual(['https://c.example/', 'https://d.example/']);

    const sameHost = harness({ pool: ['https://a.example/old', 'https://a.example/new'] });
    expect((await sameHost.selector(request({ targetHits: 1, excludedSources: ['https://a.example/old'] }), freshSignal())).picked)
      .toEqual(['https://a.example/new']);
    expect(sameHost.searchedUrls).toEqual(['https://a.example/new']);
  });

  it('扫描内同 host 变体全扫不设死区：s1 无书后 s2 同轮仍可命中（scanrev41 回归）', async () => {
    // 历史教训：曾加「每 host 每轮只扫首个变体」的去重，导致排在无书变体之后的同 host
    // 变体永久死区（扫描无书不进 excludedSources，markFailure 只记下载过的源）——
    // noveltri zh-cn/zh-tw 同 host 分版正是活例。去重已删，此测试钉住该语义。
    const h = harness({
      pool: ['https://a.example/s1', 'https://a.example/s2', 'https://b.example/'],
      search: url => (url === 'https://a.example/s1' ? [] : [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }]),
    });
    expect((await h.selector(request({ targetHits: 1 }), freshSignal())).picked).toEqual(['https://a.example/s2']);
    expect(h.searchedUrls).toEqual(['https://a.example/s1', 'https://a.example/s2']);
  });

  it('身份判据：标题须 normalize 相等、列表作者冲突不进详情、每源至多 2 详情', async () => {
    // 作者用具体名：'佚名' 经 knownSourceAuthor 归一为空 ⇒ 无作者约束，测不出冲突过滤。
    const task = { id: 12, title: '测试书', author: '测试作者' };
    const h = harness({
      pool: ['https://a.example/', 'https://b.example/'],
      search: url => (url === 'https://a.example/' ? [
        { title: '别的书', author: '测试作者', bookUrl: 'https://a.example/wrong-title' },
        { title: '测试书', author: '别人', bookUrl: 'https://a.example/author-conflict' },
        { title: '测试书', author: '测试作者', bookUrl: 'https://a.example/d1' },
        { title: '测试书', author: '测试作者', bookUrl: 'https://a.example/d2' },
        { title: '测试书', author: '测试作者', bookUrl: 'https://a.example/d3' },
      ] : [{ title: '测试书', author: '测试作者', bookUrl: 'https://b.example/d1' }]),
      // a 源两条详情都对不上（不入选），b 源对得上：d3 超每源详情上限永不触详情。
      detail: bookUrl => (bookUrl.startsWith('https://a.example/') ? { title: '测试书', author: '别人' } : { title: '测试书', author: '测试作者' }),
    });
    expect((await h.selector(request({ task }), freshSignal())).picked).toEqual(['https://b.example/']);
    expect(h.detailUrls).toEqual(['https://a.example/d1', 'https://a.example/d2', 'https://b.example/d1']);
    expect(h.detailUrls).not.toContain('https://a.example/author-conflict');
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('池不可用：真实异常（异步与同步 throw）返回 [] 并记固定原因码', async () => {
    const poolAsync = harness({ poolThrows: 'async' });
    expect((await poolAsync.selector(request(), freshSignal())).picked).toEqual([]);
    expect(poolAsync.logs[0].fields).toMatchObject({ taskId: TASK.id, reason: 'engine_source_pool_unavailable' });
    const poolSync = harness({ poolThrows: 'sync' });
    expect((await poolSync.selector(request(), freshSignal())).picked).toEqual([]);
    expect(poolSync.logs[0].fields).toMatchObject({ reason: 'engine_source_pool_unavailable' });
  });

  it('单源搜索失败（同步 throw 与异步拒绝）跳过该源继续', async () => {
    const syncThrow = harness({
      pool: ['https://a.example/', 'https://b.example/', 'https://c.example/'],
      search: url => {
        if (url === 'https://a.example/') throw new TypeError('fetch failed');
        return [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }];
      },
    });
    expect((await syncThrow.selector(request({ targetHits: 1 }), freshSignal())).picked).toEqual(['https://b.example/']);
    expect(syncThrow.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);

    const asyncReject = harness({
      pool: ['https://a.example/', 'https://b.example/'],
      search: url => (url === 'https://a.example/' ? Promise.reject(new TypeError('fetch failed'))
        : [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }]),
    });
    expect((await asyncReject.selector(request({ targetHits: 1 }), freshSignal())).picked).toEqual(['https://b.example/']);
  });

  it('caller abort：及时停止并抛 signal.reason，不再继续扫描；入口已中止不读池', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'], search: () => hang<Hit[]>() });
    const controller = new AbortController();
    const p = h.selector(request(), controller.signal);
    await tick();
    expect(h.searchedUrls).toEqual(['https://a.example/']);
    controller.abort(new Error('lease_lost'));
    await expect(p).rejects.toThrow('lease_lost');
    expect(h.searchedUrls).toEqual(['https://a.example/']);
    expect(h.detailUrls).toEqual([]);

    const entry = harness({ pool: ['https://a.example/'] });
    const aborted = new AbortController();
    aborted.abort(new Error('stopped'));
    await expect(entry.selector(request(), aborted.signal)).rejects.toThrow('stopped');
    expect(entry.poolLoads).toEqual([]);
  });

  it('物理门：HOST_OCCUPIED 拒绝且搜第二源；HOST_OCCUPANCY_UNAVAILABLE 上抛且不搜第二源', async () => {
    const gateError = (code: string) => Object.assign(new Error('gate'), { code });
    const occupied = harness({
      pool: ['https://a.example/', 'https://b.example/', 'https://c.example/'],
      search: url => (url === 'https://a.example/' ? Promise.reject(gateError('HOST_OCCUPIED'))
        : [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }]),
    });
    expect((await occupied.selector(request({ targetHits: 2 }), freshSignal())).picked)
      .toEqual(['https://b.example/', 'https://c.example/']);
    expect(occupied.searchedUrls).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);

    // 详情页抛 HOST_OCCUPIED 同样只跳过该源。
    const occupiedDetail = harness({
      pool: ['https://a.example/', 'https://b.example/'],
      detail: bookUrl => {
        if (bookUrl.startsWith('https://a.example/')) throw gateError('HOST_OCCUPIED');
        return { title: TASK.title, author: TASK.author };
      },
    });
    expect((await occupiedDetail.selector(request({ targetHits: 1 }), freshSignal())).picked).toEqual(['https://b.example/']);

    // 门后端失效（DB 不可用）：fail-closed 上抛，第一个源之后不再有任何搜索。
    const unavailable = harness({
      pool: Array.from({ length: 5 }, (_, i) => `https://s${i}.example/`),
      search: url => (url === 'https://s0.example/' ? Promise.reject(gateError('HOST_OCCUPANCY_UNAVAILABLE'))
        : [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }]),
    });
    await expect(unavailable.selector(request(), freshSignal())).rejects.toMatchObject({ code: 'HOST_OCCUPANCY_UNAVAILABLE' });
    expect(unavailable.searchedUrls).toEqual(['https://s0.example/']);

    // caller abort 仍优先于门失效：门错误在中止之后才到时，抛 signal.reason。
    const controller = new AbortController();
    let failGate: (error: Error) => void = () => {};
    const gated = new Promise<Hit[]>((_, reject) => { failGate = reject; });
    const both = harness({
      pool: ['https://a.example/', 'https://b.example/'],
      search: url => (url === 'https://a.example/' ? gated : hang<Hit[]>()),
    });
    const p = both.selector(request(), controller.signal);
    await tick();
    controller.abort(new Error('lease_lost'));
    failGate(Object.assign(new Error('gate'), { code: 'HOST_OCCUPANCY_UNAVAILABLE' }));
    await expect(p).rejects.toThrow('lease_lost');
  });

  it('预算耗尽：返回预算前已验证的 picked，不再 search/detail', async () => {
    const h = harness({
      pool: ['https://a.example/', 'https://b.example/', 'https://c.example/'],
      search: url => (url === 'https://b.example/' ? hang<Hit[]>() : [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }]),
    });
    expect((await h.selector(request({ budgetMs: 60 }), freshSignal())).picked).toEqual(['https://a.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.detailUrls).toEqual(['https://a.example/b/1']);
  });

  it('无 DB/预算写入口：selector 是裸函数，结果只含源 URL 字符串', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    expect(typeof h.selector).toBe('function');
    expect(Object.keys(h.selector)).toEqual([]);
    const picked = await h.selector(request({ targetHits: 1 }), freshSignal());
    expect(picked.picked.every(u => typeof u === 'string')).toBe(true);
  });

  it('日志脱敏：只记 taskId/scanned/candidates/host/原因码，不含书名、作者、URL、错误原文', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'] });
    await h.selector(request(), freshSignal());
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0].fields).toMatchObject({ taskId: TASK.id, scanned: 2, candidates: 2, hosts: ['a.example', 'b.example'] });
    const text = JSON.stringify({ m: h.logs[0].message, f: h.logs[0].fields });
    for (const secret of [TASK.title, TASK.author, 'https://', '/b/']) expect(text).not.toContain(secret);

    const boom = harness({ poolThrows: 'async' });
    await boom.selector(request(), freshSignal());
    const fail = JSON.stringify({ m: boom.logs[0].message, f: boom.logs[0].fields });
    expect(fail).toContain('engine_source_pool_unavailable');
    expect(fail).not.toContain('pool async down');
  });

  // nocand42：scanned 是下载线区分「全池 0 候选」与「瞬时不可达」的唯一依据，0 也必须如实返回。
  it('nocand42 scanned 计数：实探数而非池大小；跳过与未探一律不计', async () => {
    const zero = harness({ pool: ['https://a.example/', 'https://b.example/', 'https://c.example/'], search: () => [] });
    expect((await zero.selector(request(), freshSignal())).scanned).toBe(3);

    const capped = harness({ pool: Array.from({ length: 220 }, (_, i) => `https://s${i}.example/`), search: () => [] });
    expect((await capped.selector(request({ scanLimit: 200 }), freshSignal())).scanned).toBe(200);

    // builtin/suspect/非 https 被跳过 = 没探，不计入 scanned。
    const skipped = harness({
      pool: ['http://skip.example/', 'https://builtin.example/', 'https://sick.example/', 'https://real.example/'],
      builtinHosts: ['builtin.example'], suspect: ['sick.example'], search: () => [],
    });
    const selection = await skipped.selector(request(), freshSignal());
    expect(selection).toEqual({ picked: [], scanned: 1 });
    expect(skipped.searchedUrls).toEqual(['https://real.example/']);

    // 扫描余额耗尽 ⇒ 一次没探，scanned=0（下载线据此判「瞬时不可达」而非 0 候选）。
    const budget = { remaining: 0 };
    const broke = harness({ pool: ['https://a.example/'] });
    expect(await broke.selector(request({ scanBudget: budget }), freshSignal())).toEqual({ picked: [], scanned: 0 });
    expect(broke.searchedUrls).toEqual([]);
  });

  it('nocand42 池不可读 ⇒ scanned=0（不是「全池没人挂」）', async () => {
    const h = harness({ poolThrows: 'async' });
    expect(await h.selector(request(), freshSignal())).toEqual({ picked: [], scanned: 0 });
    const budget = { remaining: 2 };
    const sync = harness({ poolThrows: 'sync' });
    expect(await sync.selector(request({ scanBudget: budget }), freshSignal())).toEqual({ picked: [], scanned: 0 });
    expect(budget.remaining).toBe(2);
  });

  // authbridge42：QQ 系书在镜像站按通行书名收录（队列名「少年羽皇」vs 站名「帝临鸿蒙」），
  // 书名搜索天然失配；作者名是可靠桥接键（qqmirror42 实测 5/6 命中）。这一组只钉**接线**——
  // 什么时候补搜、搜什么 key、详情门怎么把关、出网怎么封顶——判据本体不在这里动。
  describe('authbridge42 作者名回退轮', () => {
    const task = { id: 21, title: '测试书', author: '测试作者' };
    const byKey = (titleHits: Hit[], authorHits: Hit[]) =>
      (_url: string, key: string) => (key === '测试作者' ? authorHits : titleHits);

    it('书名轮收 0 才补搜作者名，详情门对上即算该源有书', async () => {
      const h = harness({
        pool: ['https://a.example/'],
        search: byKey([], [{ title: '测试书', author: '测试作者', bookUrl: 'https://a.example/author-hit' }]),
        detail: () => ({ title: '测试书', author: '测试作者' }),
      });
      expect((await h.selector(request({ task, targetHits: 1 }), freshSignal())).picked).toEqual(['https://a.example/']);
      expect(h.searchKeys).toEqual(['测试书', '测试作者']);
      expect(h.detailUrls).toEqual(['https://a.example/author-hit']);
    });

    it('作者轮候选 >1（同作者多本）判不命中，且唯一性先于详情：一次详情都不打', async () => {
      // shidaxiaoshuo 搜「魏风华」返回 3 本诡事录系列的形态：没有书名证据时认哪一本都是猜，
      // 错配一本比 0 命中坏得多 ⇒ 先按去重后 bookUrl 数判唯一性，不合格就不进详情。
      const h = harness({
        pool: ['https://a.example/'],
        search: byKey([], [
          { title: '诡事录1', author: '魏风华', bookUrl: 'https://a.example/w1' },
          { title: '诡事录2', author: '魏风华', bookUrl: 'https://a.example/w2' },
        ]),
        detail: () => ({ title: '诡事录1', author: '魏风华' }),
      });
      expect((await h.selector(request({ task }), freshSignal())).picked).toEqual([]);
      expect(h.detailUrls).toEqual([]);
    });

    it('作者轮候选按 bookUrl 去重后恰好 1 条才进详情（重复链接不算多本）', async () => {
      const h = harness({
        pool: ['https://a.example/'],
        search: byKey([], [
          { title: '测试书', author: '测试作者', bookUrl: 'https://a.example/c1' },
          { title: '测试书', author: '测试作者', bookUrl: 'https://a.example/c1' },
          { title: '阅读测试书', author: '测试作者', bookUrl: 'https://a.example/c1' },
        ]),
        detail: () => ({ title: '测试书', author: '测试作者' }),
      });
      expect((await h.selector(request({ task, targetHits: 1 }), freshSignal())).picked).toEqual(['https://a.example/']);
      expect(h.detailUrls).toEqual(['https://a.example/c1']);
    });

    it('唯一候选但详情页作者门对不上 ⇒ 不 picked（作者名只是桥接键，不等于认领）', async () => {
      const h = harness({
        pool: ['https://a.example/'],
        search: byKey([], [{ title: '别的书', author: '别人', bookUrl: 'https://a.example/w1' }]),
        detail: () => ({ title: '别的书', author: '别人' }),
      });
      expect((await h.selector(request({ task }), freshSignal())).picked).toEqual([]);
      expect(h.detailUrls).toEqual(['https://a.example/w1']);
    });

    it('作者归一后为空（缺失/佚名/未知）不触发回退：一次搜索不多打', async () => {
      for (const author of ['', '佚名', '未知', '未知作者']) {
        const h = harness({ pool: ['https://a.example/'], search: () => [] });
        expect((await h.selector(request({ task: { ...task, author } }), freshSignal())).picked).toEqual([]);
        expect(h.searchKeys).toEqual(['测试书']);
      }
    });

    it('作者与书名同键不触发回退：否则等于把同一个搜索原样再发一遍', async () => {
      const h = harness({ pool: ['https://a.example/'], search: () => [] });
      expect((await h.selector(request({ task: { ...task, author: '测试书' } }), freshSignal())).picked).toEqual([]);
      expect(h.searchKeys).toEqual(['测试书']);
    });

    it('书名轮已有命中时不补搜：命中但详情不过说明是身份问题不是改名', async () => {
      const h = harness({
        pool: ['https://a.example/'],
        search: byKey([{ title: '测试书', author: '测试作者', bookUrl: 'https://a.example/d1' }], [
          { title: '测试书', author: '测试作者', bookUrl: 'https://a.example/author-hit' },
        ]),
        detail: () => ({ title: '测试书', author: '别人' }),
      });
      expect((await h.selector(request({ task }), freshSignal())).picked).toEqual([]);
      expect(h.searchKeys).toEqual(['测试书']);
      expect(h.detailUrls).toEqual(['https://a.example/d1']);
    });

    it('scanned 口径不变：作者轮多出的出网不计入 scanned，也不额外扣扫描余额', async () => {
      const pool = ['https://a.example/', 'https://b.example/', 'https://c.example/'];
      const h = harness({ pool, search: byKey([], [{ title: '别的书', author: '测试作者', bookUrl: 'https://x.example/w' }]) });
      const scanBudget = { remaining: 3 };
      expect(await h.selector(request({ task, scanBudget }), freshSignal())).toEqual({ picked: [], scanned: 3 });
      expect(scanBudget.remaining).toBe(0);
      // 每源两次搜索（书名 + 作者），scanned 仍是 3：scanned 是「探测的源数」不是「HTTP 请求数」。
      expect(h.searchKeys).toHaveLength(6);
    });

    it('宿主占用门在作者轮失效照样上抛 fail-closed，不被吞成「这个源没书」', async () => {
      const h = harness({
        pool: ['https://a.example/', 'https://b.example/'],
        search: (_url, key) => key === '测试作者'
          ? Promise.reject(Object.assign(new Error('gate'), { code: 'HOST_OCCUPANCY_UNAVAILABLE' }))
          : [],
      });
      await expect(h.selector(request({ task }), freshSignal())).rejects.toMatchObject({ code: 'HOST_OCCUPANCY_UNAVAILABLE' });
      // a 源打了两次（书名 + 作者）就上抛，b 源从未进入——门失效后不许继续扫全池。
      expect(h.searchedUrls).toEqual(['https://a.example/', 'https://a.example/']);
      expect(h.searchKeys).toEqual(['测试书', '测试作者']);
    });

    it('别名书桥接（authbridge42 核心价值）：书名搜不到，作者轮唯一候选 + 作者门过 ⇒ picked', async () => {
      // 实测形态（authbridge42-probe：leesven.com/leebook/4877.html）：
      // og:novel:book_name=帝临鸿蒙（通行名）、og:novel:author=为尹染墨红尘（与任务作者逐字一致）、
      // 全文无「原书名」标记 ⇒ sourceBookMatches 的 alias 通道恒空，书名直等必不过。
      // B′ 门靠作者门 + 唯一性把它认出来——这是 0 候选率 96.6% 的结构性修复点。
      const aliasTask = { id: 22, title: '少年羽皇', author: '为尹染墨红尘' };
      const h = harness({
        pool: ['https://www.leesven.com/'],
        search: (_url, key) => key === '为尹染墨红尘'
          ? [{ title: '帝临鸿蒙', author: '为尹染墨红尘', bookUrl: 'https://www.leesven.com/leebook/4877.html' }]
          : [],
        detail: () => ({ title: '帝临鸿蒙', author: '为尹染墨红尘' }),
      });
      expect((await h.selector(request({ task: aliasTask, targetHits: 1 }), freshSignal())).picked)
        .toEqual(['https://www.leesven.com/']);
      expect(h.searchKeys).toEqual(['少年羽皇', '为尹染墨红尘']);
      expect(h.detailUrls).toEqual(['https://www.leesven.com/leebook/4877.html']);
    });

    it('作者门过但作者轮收 0 条 ⇒ 仍不 picked（作者名搜不到就是搜不到，不猜）', async () => {
      const aliasTask = { id: 23, title: '少年羽皇', author: '为尹染墨红尘' };
      const h = harness({ pool: ['https://www.leesven.com/'], search: () => [] });
      expect((await h.selector(request({ task: aliasTask }), freshSignal())).picked).toEqual([]);
      expect(h.detailUrls).toEqual([]);
    });

    // dlsearch-1026：搜索词清洗接线——带版本注记书名/国籍多作者串的任务，出网键是清洗后的值；
    // 直等过滤认清洗键（源站通行书名）与任务原书名两个归一键，身份比对仍吃任务原值。
    it('dlsearch-1026：搜索键用清洗值（版本注记书名/国籍作者串），身份比对仍用任务原值', async () => {
      const task = {
        id: 24,
        title: '精灵宝钻（精装插图本）',
        author: '[英] J.R.R.托尔金 著，[英] 泰德·纳史密斯 图',
      };
      // 形态 1：源站按通行书名（清洗键）列条目——搜到后须过直等过滤 + 身份门。
      const commonName = harness({
        pool: ['https://a.example/'],
        search: (_url, key) => {
          if (key === '精灵宝钻') {
            return [{ title: '精灵宝钻', author: task.author, bookUrl: 'https://a.example/b1' }];
          }
          throw new Error(`unexpected search key: ${key}`);
        },
        detail: () => ({ title: task.title, author: task.author }),
      });
      expect((await commonName.selector(request({ task, targetHits: 1 }), freshSignal())).picked)
        .toEqual(['https://a.example/']);
      expect(commonName.searchKeys).toEqual(['精灵宝钻']);
      // 形态 2：源站条目带同款注记（与任务书逐字一致）——原书名键分支。
      const annotated = harness({
        pool: ['https://b.example/'],
        search: (_url, key) => {
          if (key === '精灵宝钻') {
            return [{ title: task.title, author: task.author, bookUrl: 'https://b.example/b1' }];
          }
          throw new Error(`unexpected search key: ${key}`);
        },
        detail: () => ({ title: task.title, author: task.author }),
      });
      expect((await annotated.selector(request({ task, targetHits: 1 }), freshSignal())).picked)
        .toEqual(['https://b.example/']);
      expect(annotated.searchKeys).toEqual(['精灵宝钻']);
    });

    it('dlsearch-1026：作者回退轮也用清洗后的作者键（[英] X 著，[英] Y 图 → 搜「J.R.R.托尔金」）', async () => {
      const task = {
        id: 25,
        title: '精灵宝钻（精装插图本）',
        author: '[英] J.R.R.托尔金 著，[英] 泰德·纳史密斯 图',
      };
      const h = harness({
        pool: ['https://a.example/'],
        search: (_url, key) => {
          if (key === 'J.R.R.托尔金') {
            return [{ title: '精灵宝钻', author: 'J.R.R.托尔金', bookUrl: 'https://a.example/w1' }];
          }
          return [];
        },
        detail: (bookUrl) => (bookUrl === 'https://a.example/w1'
          ? { title: '精灵宝钻', author: 'J.R.R.托尔金' }
          : { title: task.title, author: task.author }),
      });
      // 书名轮 0 命中 → 作者轮清洗键唯一候选，作者门（authorBridgeAccepts 用任务原值归一）对上。
      expect((await h.selector(request({ task, targetHits: 1 }), freshSignal())).picked)
        .toEqual(['https://a.example/']);
      expect(h.searchKeys).toEqual(['精灵宝钻', 'J.R.R.托尔金']);
    });
  });
});
