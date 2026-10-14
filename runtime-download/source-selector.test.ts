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
  search?: (url: string) => Hit[] | Promise<Hit[]>;
  detail?: (bookUrl: string) => Detail;
  suspect?: string[];
  builtinHosts?: string[];
}) {
  const searchedUrls: string[] = [];
  const detailUrls: string[] = [];
  const poolLoads: number[] = [];
  const logs: Array<{ level: 'info' | 'error'; message: string; fields?: Record<string, unknown> }> = [];
  const selector = createSourceSelector({
    modules: {
      compile: { compileSource: () => ({}) },
      supported: { BUILTIN_SOURCE_HOSTS: opts.builtinHosts ?? ['book15.net', 'www.book15.net'] },
      api: {
        // 非 async：让 search 能同步 throw（穿透到 sourceHasBook 成 rejection）。
        engineSearchBook: (engine: { url: string }) => {
          searchedUrls.push(engine.url);
          return opts.search?.(engine.url) ?? [{ title: TASK.title, author: TASK.author, bookUrl: `${engine.url}b/1` }];
        },
        engineFetchDetail: (_engine: unknown, bookUrl: string) => {
          detailUrls.push(bookUrl);
          return Promise.resolve(opts.detail?.(bookUrl) ?? { title: TASK.title, author: TASK.author });
        },
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
  });
  return { selector, searchedUrls, detailUrls, poolLoads, logs };
}

const request = (over: Partial<SourceSelectionRequest> = {}): SourceSelectionRequest => ({
  task: TASK, excludedHosts: [], excludedSources: [], targetHits: 2, scanLimit: 200, budgetMs: 30_000, ...over,
});
const freshSignal = () => new AbortController().signal;

describe('共用选源器', () => {
  it('逐书出网封顶：书不在池里最多扫 scanLimit 个源，不必扫完整池', async () => {
    const pool = Array.from({ length: 220 }, (_, i) => `https://s${i}.example/`);
    const h = harness({ pool, search: () => [] });
    expect(await h.selector(request({ scanLimit: 200 }), freshSignal())).toEqual([]);
    expect(h.searchedUrls).toHaveLength(200);
    expect(h.detailUrls).toEqual([]);
  });

  it('共享扫描余额跨调用保留，过滤不扣额，耗尽后不再读池', async () => {
    const h = harness({ pool: ['http://skip.example/', 'https://a.example/', 'https://b.example/', 'https://c.example/'] });
    const scanBudget = { remaining: 3 };
    expect(await h.selector(request({ scanBudget }), freshSignal())).toEqual(['https://a.example/', 'https://b.example/']);
    expect(scanBudget.remaining).toBe(1);
    expect(await h.selector(request({ scanBudget, excludedSources: ['https://a.example/', 'https://b.example/'] }), freshSignal()))
      .toEqual(['https://c.example/']);
    expect(scanBudget.remaining).toBe(0);
    expect(await h.selector(request({ scanBudget }), freshSignal())).toEqual([]);
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
    expect(await two.selector(request({ targetHits: 2 }), freshSignal())).toEqual(['https://a.example/', 'https://b.example/']);
    expect(two.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
    const three = harness({ pool });
    expect(await three.selector(request({ targetHits: 3 }), freshSignal())).toHaveLength(3);
    expect(three.searchedUrls).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
  });

  it('同 host 重复候选：已命中 host 不再扫，另一 host 补位', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://a.example/other/', 'https://b.example/'] });
    expect(await h.selector(request(), freshSignal())).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('busy/suspect/builtin/非 https/非法 URL 过滤不耗 scanLimit', async () => {
    const h = harness({
      pool: ['https://book15.net/x', 'http://plain.example/', 'not a url', 'https://dead.example/', 'https://busy.example/',
        'https://a.example/', 'https://b.example/', 'https://c.example/'],
      suspect: ['dead.example'],
    });
    expect(await h.selector(request({ excludedHosts: ['busy.example'], scanLimit: 2 }), freshSignal()))
      .toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.poolLoads).toEqual([1]);
  });

  it('已失败 URL 只按精确 source_url 排除：A/B 排除后补 C/D；同 host 不同 source URL 仍可选', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'] });
    expect(await h.selector(request({ excludedSources: ['https://a.example/', 'https://b.example/'] }), freshSignal()))
      .toEqual(['https://c.example/', 'https://d.example/']);
    expect(h.searchedUrls).toEqual(['https://c.example/', 'https://d.example/']);

    const sameHost = harness({ pool: ['https://a.example/old', 'https://a.example/new'] });
    expect(await sameHost.selector(request({ targetHits: 1, excludedSources: ['https://a.example/old'] }), freshSignal()))
      .toEqual(['https://a.example/new']);
    expect(sameHost.searchedUrls).toEqual(['https://a.example/new']);
  });

  it('扫描内单源无书不禁整 host：本轮同 host 只扫首个变体，后续轮次经排除仍可选同 host 变体', async () => {
    const h = harness({
      pool: ['https://a.example/s1', 'https://a.example/s2', 'https://b.example/'],
      search: url => (url === 'https://a.example/s1' ? [] : [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }]),
    });
    // 本轮：s1 无书即标记该 host，s2 不再消耗槽位；b 补位。
    expect(await h.selector(request({ targetHits: 1 }), freshSignal())).toEqual(['https://b.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/s1', 'https://b.example/']);
    // 后续轮次 s1 进失败排除集后，同 host 变体 s2 恢复可扫（早停于 targetHits=1）。
    expect(await h.selector(request({ targetHits: 1, excludedSources: ['https://a.example/s1'] }), freshSignal()))
      .toEqual(['https://a.example/s2']);
    expect(h.searchedUrls).toEqual(['https://a.example/s1', 'https://b.example/', 'https://a.example/s2']);
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
    expect(await h.selector(request({ task }), freshSignal())).toEqual(['https://b.example/']);
    expect(h.detailUrls).toEqual(['https://a.example/d1', 'https://a.example/d2', 'https://b.example/d1']);
    expect(h.detailUrls).not.toContain('https://a.example/author-conflict');
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('池不可用：真实异常（异步与同步 throw）返回 [] 并记固定原因码', async () => {
    const poolAsync = harness({ poolThrows: 'async' });
    expect(await poolAsync.selector(request(), freshSignal())).toEqual([]);
    expect(poolAsync.logs[0].fields).toMatchObject({ taskId: TASK.id, reason: 'engine_source_pool_unavailable' });
    const poolSync = harness({ poolThrows: 'sync' });
    expect(await poolSync.selector(request(), freshSignal())).toEqual([]);
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
    expect(await syncThrow.selector(request({ targetHits: 1 }), freshSignal())).toEqual(['https://b.example/']);
    expect(syncThrow.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);

    const asyncReject = harness({
      pool: ['https://a.example/', 'https://b.example/'],
      search: url => (url === 'https://a.example/' ? Promise.reject(new TypeError('fetch failed'))
        : [{ title: TASK.title, author: TASK.author, bookUrl: `${url}b/1` }]),
    });
    expect(await asyncReject.selector(request({ targetHits: 1 }), freshSignal())).toEqual(['https://b.example/']);
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
    expect(await occupied.selector(request({ targetHits: 2 }), freshSignal()))
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
    expect(await occupiedDetail.selector(request({ targetHits: 1 }), freshSignal())).toEqual(['https://b.example/']);

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
    expect(await h.selector(request({ budgetMs: 60 }), freshSignal())).toEqual(['https://a.example/']);
    expect(h.searchedUrls).toEqual(['https://a.example/', 'https://b.example/']);
    expect(h.detailUrls).toEqual(['https://a.example/b/1']);
  });

  it('无 DB/预算写入口：selector 是裸函数，结果只含源 URL 字符串', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    expect(typeof h.selector).toBe('function');
    expect(Object.keys(h.selector)).toEqual([]);
    const picked = await h.selector(request({ targetHits: 1 }), freshSignal());
    expect(picked.every(u => typeof u === 'string')).toBe(true);
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
});
