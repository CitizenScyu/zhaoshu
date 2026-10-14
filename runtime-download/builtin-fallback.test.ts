// 41-T8FB：builtin-fallback 单元层（不连库、不联网）：选源的容错与边界、下载腿的停止条件。
// bsrcfix-20261007：扫描循环已抽到共用 selector（./source-selector）；本文件经 createBuiltinFallback
// 的默认 selector 装配驱动真 selector 代码路径（excludedHosts/excludedSources/targetHits/scanLimit/budget
// 的喂入与收口），物理 host 互斥改经 AdapterOutcome.retryCause（门拒绝不标失败；host_occupied 换源、
// host_occupancy_unavailable 停）；coarse occupy/release/holder/occupancyTtlMs 接缝已删。
import { describe, expect, it } from 'vitest';
import { createBuiltinFallback, MAX_FALLBACK_SCAN_SOURCES } from './builtin-fallback';
import type { AdapterOutcome, SourceAdapter, TaskRow } from '../src/lib/download-worker';
import type { PrecheckResult } from './executor';

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 7, book_id: 1, title: '测试书', author: '佚名', status: 'running',
  source_url: 'https://book15.net/books/details1.html', source_kind: 'builtin', source_id: null, requested_by: 'system', ...over,
});
const hostOf = (url: string) => new URL(url).hostname;
const UNAVAILABLE: PrecheckResult = { ok: false, reason: 'source_unavailable', retryable: true, stage: 'detail' };
// 生产 identity-precheck 对 identity_mismatch 只回 {ok:false, reason}（不带 retryable/stage，
// nocandrev41 F3）：夹具同形状，钉住 retryable 缺省=不可重试的收窄路径。
const IDENTITY_MISS: PrecheckResult = { ok: false, reason: 'identity_mismatch' };
const signal = () => new AbortController().signal;

function harness(opts: {
  pool?: string[] | (() => never); throwSearch?: string[]; suspect?: string[]; noBook?: string[]; hostTarget?: number; maxSources?: number;
}) {
  const searched: string[] = [];
  const poolLoads: number[] = [];
  const fallback = createBuiltinFallback({
    modules: {
      compile: { compileSource: () => ({}) },
      supported: { BUILTIN_SOURCE_HOSTS: ['book15.net', 'www.book15.net'] },
      api: {
        engineSearchBook: async (engine: { url: string }) => {
          const host = hostOf(engine.url);
          searched.push(host);
          if (opts.throwSearch?.includes(host)) throw new TypeError('fetch failed');
          if (opts.noBook?.includes(host)) return [];
          return [{ title: '测试书', author: '佚名', bookUrl: `https://${host}/b/1` }];
        },
        engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
      },
    },
    transport: async () => { throw new Error('unused'); },
    loadPool: async () => {
      poolLoads.push(1);
      if (typeof opts.pool === 'function') opts.pool();
      return ((opts.pool as string[] | undefined) ?? []).map(url => ({ url, name: url, searchUrl: '/s' }));
    },
    isSuspect: host => opts.suspect?.includes(host) ?? false,
    hostTarget: opts.hostTarget,
    maxSources: opts.maxSources,
  });
  return { fallback, searched, poolLoads };
}

const adapter = (outcomes: Record<string, AdapterOutcome>, calls: string[]): SourceAdapter => ({
  kind: 'engine',
  async download(t) { calls.push(hostOf(t.source_url)); return outcomes[hostOf(t.source_url)] ?? { kind: 'failure', code: 'identity_mismatch_or_no_candidate' }; },
});
const context = () => ({ signal: signal(), progress: async () => {} });

describe('41-T8FB builtin-fallback', () => {
  it('选源：跳过 book15/非 https/suspect/同 host 重复，单源搜索失败只跳过该源；命中 2 个不同 host 早停', async () => {
    const h = harness({
      pool: ['https://www.book15.net/', 'http://plain.example/', 'https://dead.example/', 'https://boom.example/',
        'https://a.example/', 'https://a.example/other', 'https://none.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'],
      suspect: ['dead.example'], throwSearch: ['boom.example'], noBook: ['none.example'],
    });
    const precheck = h.fallback.wrapPrecheck(async () => UNAVAILABLE);
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    // a.example、b.example 命中后满 2 个不同 host 即早停：c/d 不再被扫。
    expect(h.searched).toEqual(['boom.example', 'a.example', 'none.example', 'b.example']);
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(adapter({}, []), adapter({}, calls)).download(task(), context());
    expect(calls).toEqual(['a.example', 'b.example']); // 预检选好的源直接用，不再碰 book15
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable' });
  });

  it('未传可选 signal 时仍可按默认信号选源', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'] });
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(h.searched).toEqual(['a.example', 'b.example']);
  });

  it('早停目标 3：hostTarget=3 时命中 3 个不同 host 才停，且仍受 maxSources 上限', async () => {
    const h = harness({
      pool: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'],
      hostTarget: 3, maxSources: 3,
    });
    const precheck = h.fallback.wrapPrecheck(async () => UNAVAILABLE);
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(h.searched).toEqual(['a.example', 'b.example', 'c.example']);
    const calls: string[] = [];
    await h.fallback.wrapAdapter(adapter({}, []), adapter({}, calls)).download(task(), context());
    expect(calls).toEqual(['a.example', 'b.example', 'c.example']);
  });

  // 41-nocand（2026-10-14）：原源可达但库里没有这本书（identity_mismatch / no_candidate）
  // 此前不触发引擎回退直接终态 failed——book.qq 链尾 cohort 全栽在这条路径。现扩回退资格。
  it('41-nocand：原源身份缺失（无此书）也走引擎回退，选到即放行并下载成功', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'] });
    expect(await h.fallback.wrapPrecheck(async () => IDENTITY_MISS)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(adapter({}, []), adapter({ 'a.example': {
      kind: 'complete', txt: 'x', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1,
    } }, calls)).download(task(), context());
    expect(out.kind).toBe('complete');
    expect(calls).toEqual(['a.example']);
  });

  it('41-nocand：身份缺失且引擎池也选不到 ⇒ 按原身份失败终态，不退避空耗重扫', async () => {
    const h = harness({ pool: ['https://a.example/'], noBook: ['a.example'] });
    expect(await h.fallback.wrapPrecheck(async () => IDENTITY_MISS)(task(), signal()))
      .toMatchObject({ ok: false, reason: 'identity_mismatch', retryable: false });
  });

  it('41-nocand F1（nocandrev41）：预检身份缺失选到候选、候选全失败 ⇒ 身份失败终态，不退避重扫', async () => {
    // F1 反例：候选搜得到但下载全挂时，旧版降级 source_unavailable ⇒ 16 轮退避重扫（每轮全池）。
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'] });
    expect(await h.fallback.wrapPrecheck(async () => IDENTITY_MISS)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(adapter({}, []), adapter({}, calls)).download(task(), context());
    // adapter 默认兜底 outcome 即 identity_mismatch_or_no_candidate failure ⇒ 两候选全失败。
    expect(out).toEqual({ kind: 'failure', code: 'identity_mismatch_or_no_candidate' });
    expect(calls).toEqual(['a.example', 'b.example']);
  });

  it('41-nocand：下载腿原源 identity_mismatch_or_no_candidate ⇒ 换引擎候选收口', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    const calls: string[] = [];
    const builtin = adapter({ 'book15.net': { kind: 'failure', code: 'identity_mismatch_or_no_candidate' } }, []);
    const out = await h.fallback.wrapAdapter(builtin, adapter({ 'a.example': {
      kind: 'complete', txt: 'x', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1,
    } }, calls)).download(task(), context());
    expect(out.kind).toBe('complete');
    expect(calls).toEqual(['a.example']);
  });

  it('逐书出网封顶：书不在池里时最多搜 MAX_FALLBACK_SCAN_SOURCES 个源', async () => {
    const pool = Array.from({ length: MAX_FALLBACK_SCAN_SOURCES + 10 }, (_, i) => `https://s${i}.example/`);
    const h = harness({ pool, noBook: pool.map(hostOf) });
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal())).toEqual(UNAVAILABLE);
    expect(h.searched).toHaveLength(MAX_FALLBACK_SCAN_SOURCES);
  });

  it.each([false, true])('预检新扫与下载补扫累计最多 MAX_FALLBACK_SCAN_SOURCES 个源（耗尽=%s），下一轮重建余额', async exhausted => {
    const pool = Array.from({ length: MAX_FALLBACK_SCAN_SOURCES + 10 }, (_, i) => `https://s${i}.example/`);
    const searched: string[] = [];
    const failed = new Set<string>();
    let loads = 0;
    const firstHit = MAX_FALLBACK_SCAN_SOURCES - (exhausted ? 2 : 3);
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] },
        api: {
          engineSearchBook: async (source: { url: string }) => {
            searched.push(source.url);
            if (loads === 1 && !pool.slice(firstHit, firstHit + 2).includes(source.url)) return [];
            return [{ title: '测试书', author: '佚名', bookUrl: `${source.url}b1` }];
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => {
        loads += 1;
        return pool.map(url => ({ url, name: url, searchUrl: '/s' }));
      },
      candidates: {
        usable: async () => [], failedSources: async () => failed,
        occupiedHosts: async () => new Set<string>(), replace: async () => {},
        markFailure: async (_bookId, url) => { failed.add(url); },
      },
      isSuspect: () => false,
    });
    const precheck = fallback.wrapPrecheck(async () => UNAVAILABLE);
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(searched).toHaveLength(exhausted ? MAX_FALLBACK_SCAN_SOURCES : MAX_FALLBACK_SCAN_SOURCES - 1);
    const calls: string[] = [];
    await fallback.wrapAdapter(adapter({}, []), adapter({}, calls)).download(task(), context());
    // 预检扫满额度时零补扫；差一个扫满时仅允许补扫一个，不能再次按全额度扫出两候选。
    expect(searched).toHaveLength(MAX_FALLBACK_SCAN_SOURCES);
    expect(loads).toBe(exhausted ? 1 : 2);
    expect(calls).toEqual([...pool.slice(firstHit, firstHit + 2).map(hostOf),
      ...(exhausted ? [] : ['s0.example'])]);
    if (!exhausted) expect(searched[MAX_FALLBACK_SCAN_SOURCES - 1]).toBe(pool[0]);
    // planned 仅传给同一轮下载；新轮拥有新的累计额度，而非永久耗尽。
    searched.length = 0;
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(searched).toHaveLength(2);
  });

  it('源池不可用 ⇒ 预检保持 source_unavailable（阶段沿用内层），不放行', async () => {
    const h = harness({ pool: () => { throw new Error('db down'); } });
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal())).toEqual(UNAVAILABLE);
  });

  // 933 回归：原源 host 被本机其他实例的下载作用域占用（物理门 HOST_OCCUPIED）时，wrapPrecheck 不得
  // 上抛——否则 executor 释放任务 → drain ERROR 60s 退避 → 重领同一 host，形成每分钟空转死循环。
  // 改走引擎回退选源（selector 的 excludedHosts 已排除忙 host）。占位表后端不可用
  // （HOST_OCCUPANCY_UNAVAILABLE）语义不同，仍原样上抛由执行器立即收口。
  it('原源被物理门占用（HOST_OCCUPIED）⇒ 改走引擎回退选源，不上抛', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'] });
    const occupied = Object.assign(new Error('host occupied: book15.net'), { code: 'HOST_OCCUPIED' });
    const precheck = h.fallback.wrapPrecheck(async () => { throw occupied; });
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(h.searched).toEqual(['a.example', 'b.example']);
  });

  it('占位表后端不可用（HOST_OCCUPANCY_UNAVAILABLE）⇒ 原样上抛，不回退选源', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    const unavailable = Object.assign(new Error('host occupancy unavailable'), { code: 'HOST_OCCUPANCY_UNAVAILABLE' });
    const precheck = h.fallback.wrapPrecheck(async () => { throw unavailable; });
    await expect(precheck(task(), signal())).rejects.toThrow('host occupancy unavailable');
    expect(h.searched).toEqual([]);
  });

  it('内层预检放行/未验证原样返回不读源池；身份不符（41-nocand）改走引擎回退；engine 无候选存储直通', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    for (const result of [{ ok: true }, { ok: true, reason: 'identity_unverified' }] as PrecheckResult[]) {
      expect(await h.fallback.wrapPrecheck(async () => result)(task(), signal())).toEqual(result);
    }
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task({ source_kind: 'engine' }), signal()))
      .toEqual(UNAVAILABLE);
    expect(h.poolLoads).toEqual([]);
    // identity_mismatch：原源可达但无此书 ⇒ 扫池找候选（41-nocand 前 identity_mismatch 直通终态）。
    expect(await h.fallback.wrapPrecheck(async () => IDENTITY_MISS)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(h.searched).toEqual(['a.example']);
  });

  it('engine 任务有候选存储但无可用候选：先过原预检，放行直通；身份不符（41-nocand）改扫池选候选', async () => {
    const state = {
      usable: [],
      stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    const engineTask = task({ source_kind: 'engine', source_url: 'https://origin.example/rules' });
    expect(await h.fallback.wrapPrecheck(async () => ({ ok: true }))(engineTask, signal())).toEqual({ ok: true });
    expect(h.searched).toEqual([]);
    // identity_mismatch：原引擎源可达但无此书 ⇒ 扫池选候选并落库（41-nocand 前直通终态）。
    expect(await h.fallback.wrapPrecheck(async () => IDENTITY_MISS)(engineTask, signal()))
      .toEqual({ ok: true, reason: 'engine_source_candidates' });
    expect(h.searched).toEqual(['a.example', 'b.example']);
    expect(state.stored).toEqual([[1, ['https://a.example/', 'https://b.example/']]]);
  });

  it('engine 任务已有持久化候选：跳过原预检并下载候选', async () => {
    const state = {
      usable: [{ source_url: 'https://fallback.example/b1', host: 'fallback.example' }],
      stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    const engineTask = task({ source_kind: 'engine', source_url: 'https://origin.example/rules' });
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(engineTask, signal()))
      .toEqual({ ok: true, reason: 'engine_source_candidates' });
    expect(h.searched).toEqual([]);
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(adapter({}, []), adapter({
      'fallback.example': { kind: 'complete', txt: 'x', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1 },
    }, calls), 'engine').download(engineTask, context());
    expect(calls).toEqual(['fallback.example']);
    expect(out.kind).toBe('complete');
  });

  it('下载腿：引擎源遇任务层停止（budget_exhausted）即收口，不再换下一个源', async () => {
    const h = harness({ pool: ['https://a.example/', 'https://b.example/'] });
    const calls: string[] = [];
    const stop: AdapterOutcome = { kind: 'incomplete', reason: 'budget_exhausted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
    const builtin = adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls);
    const out = await h.fallback.wrapAdapter(builtin, adapter({ 'a.example': stop }, calls)).download(task(), context());
    expect(out).toEqual(stop);
    expect(calls).toEqual(['book15.net', 'a.example']);
  });

  it('下载腿：引擎源全失败 ⇒ 回 book15 自己的 source_unavailable（阶段不变）', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    const primary: AdapterOutcome = { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' };
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(adapter({ 'book15.net': primary }, calls), adapter({}, calls)).download(task(), context());
    expect(out).toEqual(primary);
    expect(calls).toEqual(['book15.net', 'a.example']);
  });

  it('engine 任务有持久化候选时优先复用候选，不调用原预检并按候选逐源切换', async () => {
    const state = {
      usable: [
        { source_url: 'https://engine-a.example/b1', host: 'engine-a.example' },
        { source_url: 'https://engine-b.example/b1', host: 'engine-b.example' },
      ],
      stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    const engineTask = task({ source_kind: 'engine' });
    let innerCalls = 0;
    const precheck = h.fallback.wrapPrecheck(async () => {
      innerCalls += 1;
      return UNAVAILABLE;
    });
    expect(await precheck(engineTask, signal())).toEqual({ ok: true, reason: 'engine_source_candidates' });
    expect(innerCalls).toBe(0);
    const calls: string[] = [];
    const failed: AdapterOutcome = {
      kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
    };
    const out = await h.fallback.wrapAdapter(adapter({}, calls), adapter({ 'engine-a.example': failed, 'engine-b.example': {
      kind: 'complete', txt: 'x', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1,
    } }, calls), 'engine').download(engineTask, context());
    expect(out.kind).toBe('complete');
    expect(calls).toEqual(['engine-a.example', 'engine-b.example']);
    expect(state.failures).toEqual([[1, 'https://engine-a.example/b1', 'temporary', 'source_unavailable']]);
  });

  it('engine 任务无持久化候选时下载腿先试原始引擎源：原源可用即收，不可达才扫池', async () => {
    const state = {
      usable: [] as { source_url: string; host: string }[],
      stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    const engineTask = task({ source_kind: 'engine', source_url: 'https://origin.example/rules' });
    const calls: string[] = [];
    const complete: AdapterOutcome = { kind: 'complete', txt: 'x', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1 };
    const engine = adapter({ 'origin.example': complete }, calls);
    const out = await h.fallback.wrapAdapter(adapter({}, []), engine, 'engine').download(engineTask, context());
    expect(out).toEqual(complete);
    expect(calls).toEqual(['origin.example']);
    expect(h.searched).toEqual([]);
    expect(state.stored).toEqual([]);
    // 原源不可达 ⇒ 扫池选候选（a/b 命中早停）后再用 engine 腿下载。
    const unavailableOutcome: AdapterOutcome = {
      kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc',
    };
    const calls2: string[] = [];
    const deadOrigin = adapter({ 'origin.example': unavailableOutcome, 'b.example': complete }, calls2);
    const out2 = await h.fallback.wrapAdapter(adapter({}, []), deadOrigin, 'engine').download(engineTask, context());
    expect(out2.kind).toBe('complete');
    expect(calls2).toEqual(['origin.example', 'a.example', 'b.example']);
    expect(h.searched).toEqual(['a.example', 'b.example']);
    expect(state.stored).toEqual([[1, ['https://a.example/', 'https://b.example/']]]);
  });

  it('recall 过滤：suspect/重复 host/超上限剔除，全被剔除 ⇒ 重选出网', async () => {
    const state = {
      usable: [
        { source_url: 'https://dead.example/b1', host: 'dead.example' },
        { source_url: 'https://a.example/b1', host: 'a.example' },
        { source_url: 'https://a.example/b2', host: 'a.example' },
        { source_url: 'http://plain.example/b1', host: 'plain.example' },
      ],
      stored: [] as [number, string[]][],
    };
    const suspects = new Set(['dead.example']);
    const stored: [number, string[]][] = [];
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] },
        api: {
          engineSearchBook: async (engine: { url: string }) => [{ title: '测试书', author: '佚名', bookUrl: `https://${hostOf(engine.url)}/b/1` }],
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => ['https://a.example/', 'https://b.example/'].map(url => ({ url, name: url, searchUrl: '/s' })),
      candidates: {
        usable: async () => state.usable,
        failedSources: async () => new Set<string>(),
        replace: async (bookId, sources) => { stored.push([bookId, [...sources]]); },
        markFailure: async () => {},
        occupiedHosts: async () => new Set<string>(),
      },
      isSuspect: host => suspects.has(host),
    });
    // a.example 本身可用：suspect/非 https/同 host 重复全剔后只剩 a.example，命中即放行。
    expect(await fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    // a.example 也 suspect ⇒ recall 全空，走出网重选（b.example 命中）。
    suspects.add('a.example');
    expect(await fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(stored).toEqual([[1, ['https://b.example/']]]);
  });

  // bsrcfix-41：候选源持久化接缝（无 DB 时缺省 = 内存单槽旧行为，上面用例已覆盖；这里钉接缝语义）。
  // recall 上限是 min(maxSources, hostTarget)（默认 2/2）：多源逐一下载的用例要显式放开两者。
  function candidatesHarness(state: {
    usable: { source_url: string; host: string }[] | null;
    failedSources?: Set<string>;
    occupied?: string[];
    stored: [number, string[]][];
    failures: [number, string, string, string][];
    replaceError?: Error;
    failureError?: Error;
  }, limits?: { hostTarget?: number; maxSources?: number }) {
    const searched: string[] = [];
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net', 'www.book15.net'] },
        api: {
          engineSearchBook: async (engine: { url: string }) => {
            const host = hostOf(engine.url);
            searched.push(host);
            return [{ title: '测试书', author: '佚名', bookUrl: `https://${host}/b/1` }];
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => (['https://a.example/', 'https://b.example/', 'https://c.example/']
        .map(url => ({ url, name: url, searchUrl: '/s' }))),
      ...limits,
      candidates: {
        usable: async () => state.usable ?? [],
        failedSources: async () => state.failedSources ?? new Set<string>(),
        replace: async (bookId, sources) => {
          if (state.replaceError) throw state.replaceError;
          state.stored.push([bookId, [...sources]]);
        },
        markFailure: async (bookId, url, kind, reason) => {
          if (state.failureError) throw state.failureError;
          state.failures.push([bookId, url, kind, reason]);
        },
        occupiedHosts: async () => new Set(state.occupied ?? []),
      },
      isSuspect: () => false,
    });
    return { fallback, searched };
  }

  it('持久化命中 ⇒ 预检零出网放行（不读源池、不搜索）', async () => {
    const state = {
      usable: [{ source_url: 'https://good.example/b1', host: 'good.example' }],
      stored: [], failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(h.searched).toEqual([]);
    expect(state.stored).toEqual([]);
  });

  it('候选保存失败不使用未持久化计划放行下载', async () => {
    const state = {
      usable: [], stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
      replaceError: new Error('synthetic database failure'),
    };
    const h = candidatesHarness(state);
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal())).toEqual(UNAVAILABLE);
    expect(state.stored).toEqual([]);
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 } }, calls),
      adapter({}, calls),
    ).download(task(), context());
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable' });
    expect(calls).toEqual(['book15.net']);
  });

  it.each(['failure', 'incomplete'] as const)('%s 失败记忆写入失败时停止，不试备用源', async kind => {
    const state = {
      usable: [
        { source_url: 'https://a.example/', host: 'a.example' },
        { source_url: 'https://b.example/', host: 'b.example' },
      ],
      stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
      failureError: new Error('synthetic database failure'),
    };
    const h = candidatesHarness(state);
    await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal());
    const calls: string[] = [];
    const failed: AdapterOutcome = kind === 'failure'
      ? { kind: 'failure', code: 'identity_mismatch_or_no_candidate' }
      : { kind: 'incomplete', reason: 'missing_chapters', chaptersTotal: 2, chaptersDone: 1, charsTotal: 1 };
    const out = await h.fallback.wrapAdapter(adapter({}, []), adapter({ 'a.example': failed }, calls))
      .download(task(), context());
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable', stage: 'candidates' });
    expect(calls).toEqual(['a.example']);
    expect(state.failures).toEqual([]);
  });

  it('持久化未命中 ⇒ 出网选源并落库；选源跳过被占用 host', async () => {
    const state = { usable: [], occupied: ['a.example'], stored: [], failures: [] as [number, string, string, string][] };
    const h = candidatesHarness(state);
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    // a.example 被占跳过；b、c 命中满 2 个不同 host 早停（被跳过的 a 不占扫描额）。
    expect(h.searched).toEqual(['b.example', 'c.example']);
    expect(state.stored).toEqual([[1, ['https://b.example/', 'https://c.example/']]]);
  });

  it('补扫按单源排除失败源：A/B 的 URL 失败后不重扫，同 host 其他 URL 仍可用；改扫 C/D 补齐', async () => {
    const state = {
      usable: [] as { source_url: string; host: string }[],
      failedSources: new Set(['https://a.example/', 'https://b.example/']),
      stored: [] as [number, string[]][],
      failures: [] as [number, string, string, string][],
      pool: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'],
    };
    const searched: string[] = [];
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net', 'www.book15.net'] },
        api: {
          engineSearchBook: async (engine: { url: string }) => {
            searched.push(hostOf(engine.url));
            return [{ title: '测试书', author: '佚名', bookUrl: `https://${hostOf(engine.url)}/b/1` }];
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => state.pool.map(url => ({ url, name: url, searchUrl: '/s' })),
      candidates: {
        usable: async () => [],
        failedSources: async () => state.failedSources,
        replace: async (bookId, sources) => { state.stored.push([bookId, [...sources]]); },
        markFailure: async () => {},
        occupiedHosts: async () => new Set<string>(),
      },
      isSuspect: () => false,
    });
    expect(await fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    // 失败记忆按 source_url 精确排除 A/B，只扫 C/D 补齐。
    expect(searched).toEqual(['c.example', 'd.example']);
    expect(state.stored).toEqual([[1, ['https://c.example/', 'https://d.example/']]]);
    // 同 host 其他 URL 不连带排除：只有 a.example/ 失败时，a.example/other 仍可扫（host 去重只作用于 picked）。
    state.failedSources = new Set(['https://a.example/']);
    state.pool = ['https://a.example/other', 'https://b.example/', 'https://c.example/'];
    state.stored.length = 0;
    searched.length = 0;
    expect(await fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(searched).toEqual(['a.example', 'b.example']);
    expect(state.stored).toEqual([[1, ['https://a.example/other', 'https://b.example/']]]);
  });

  it('候选读取失败 ⇒ 空退避，不盲扫（宁退勿撞）', async () => {
    const searched: string[] = [];
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] },
        api: {
          engineSearchBook: async (engine: { url: string }) => {
            searched.push(hostOf(engine.url));
            return [{ title: '测试书', author: '佚名', bookUrl: `https://${hostOf(engine.url)}/b/1` }];
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => ['https://a.example/'].map(url => ({ url, name: url, searchUrl: '/s' })),
      candidates: {
        usable: async () => { throw new Error('db down'); },
        failedSources: async () => { throw new Error('db down'); },
        replace: async () => {},
        markFailure: async () => {},
        occupiedHosts: async () => { throw new Error('db down'); },
      },
      isSuspect: () => false,
    });
    expect(await fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: false, reason: 'source_unavailable', retryable: true, stage: 'search' });
    expect(searched).toEqual([]);
  });

  it('下载腿：源级 incomplete（source_unavailable/missing_chapters/toc_changed/operation_timeout）标 temporary；budget/interrupted 与白名单外不标', async () => {
    const state = {
      usable: [
        { source_url: 'https://s1.example/b1', host: 's1.example' },
        { source_url: 'https://s2.example/b1', host: 's2.example' },
        { source_url: 'https://s3.example/b1', host: 's3.example' },
        { source_url: 'https://s4.example/b1', host: 's4.example' },
        { source_url: 'https://s5.example/b1', host: 's5.example' },
        { source_url: 'https://s6.example/b1', host: 's6.example' },
      ],
      stored: [] as [number, string[]][],
      failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state, { hostTarget: 6, maxSources: 6 });
    const calls: string[] = [];
    const outcomes: Record<string, AdapterOutcome> = {
      's1.example': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'search' },
      's2.example': { kind: 'incomplete', reason: 'missing_chapters', chaptersTotal: 3, chaptersDone: 1, charsTotal: 100 },
      's3.example': { kind: 'incomplete', reason: 'toc_changed', chaptersTotal: 3, chaptersDone: 0, charsTotal: 0 },
      's4.example': { kind: 'incomplete', reason: 'operation_timeout', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 },
      's5.example': { kind: 'failure', code: 'identity_mismatch_or_no_candidate' },
      's6.example': { kind: 'incomplete', reason: 'budget_exhausted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 },
    };
    const out = await h.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls),
      adapter(outcomes, calls),
    ).download(task(), context());
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'budget_exhausted' });
    expect(calls).toEqual(['s1.example', 's2.example', 's3.example', 's4.example', 's5.example', 's6.example']);
    // 白名单四个源级 reason ⇒ temporary；identity ⇒ permanent；budget 是任务层停止 ⇒ 不标。
    expect(state.failures).toEqual([
      [1, 'https://s1.example/b1', 'temporary', 'source_unavailable'],
      [1, 'https://s2.example/b1', 'temporary', 'missing_chapters'],
      [1, 'https://s3.example/b1', 'temporary', 'toc_changed'],
      [1, 'https://s4.example/b1', 'temporary', 'operation_timeout'],
      [1, 'https://s5.example/b1', 'permanent', 'identity_mismatch_or_no_candidate'],
    ]);
    // 白名单外 reason（如中断）：不归源失败、不换源。
    const state2 = {
      usable: [{ source_url: 'https://i1.example/b1', host: 'i1.example' }],
      stored: [] as [number, string[]][],
      failures: [] as [number, string, string, string][],
    };
    const h2 = candidatesHarness(state2);
    const calls2: string[] = [];
    const out2 = await h2.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls2),
      adapter({ 'i1.example': { kind: 'incomplete', reason: 'interrupted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 } }, calls2),
    ).download(task(), context());
    expect(out2).toMatchObject({ kind: 'incomplete', reason: 'interrupted' });
    expect(state2.failures).toEqual([]);
  });

  it.each(['source_unavailable', 'missing_chapters', 'toc_changed', 'operation_timeout'])('全部候选 %s 后才补扫其它源，后续复用补扫结果', async reason => {
    const failed = new Set<string>();
    let usable = ['https://a.example/', 'https://b.example/'];
    const searched: string[] = [];
    const marks: string[] = [];
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] },
        api: {
          engineSearchBook: async (engine: { url: string }) => {
            searched.push(engine.url);
            return [{ title: '测试书', author: '佚名', bookUrl: `${engine.url}b1` }];
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => ['a', 'b', 'c', 'd'].map(h => ({ url: `https://${h}.example/`, name: h, searchUrl: '/s' })),
      candidates: {
        usable: async () => usable.map(source_url => ({ source_url, host: hostOf(source_url) })),
        failedSources: async () => failed,
        replace: async (_bookId, urls) => { usable = [...urls]; },
        markFailure: async (_bookId, url) => {
          marks.push(url);
          failed.add(url);
          usable = usable.filter(item => item !== url);
        },
        occupiedHosts: async () => new Set<string>(),
      },
      isSuspect: () => false,
    });
    const precheck = fallback.wrapPrecheck(async () => UNAVAILABLE);
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(searched).toEqual([]);
    const incomplete: AdapterOutcome = { kind: 'incomplete', reason, chaptersTotal: 3, chaptersDone: 1, charsTotal: 100 };
    const ok: AdapterOutcome = { kind: 'complete', txt: 'x', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1 };
    const calls: string[] = [];
    const engine: SourceAdapter = {
      kind: 'engine',
      async download(t) {
        calls.push(hostOf(t.source_url));
        if (hostOf(t.source_url) === 'a.example' || hostOf(t.source_url) === 'b.example') {
          expect(searched).toEqual([]);
          return incomplete;
        }
        expect(marks).toEqual(['https://a.example/', 'https://b.example/']);
        return ok;
      },
    };
    expect(await fallback.wrapAdapter(adapter({}, []), engine).download(task(), context())).toEqual(ok);
    expect(calls).toEqual(['a.example', 'b.example', 'c.example']);
    expect(marks).toEqual(['https://a.example/', 'https://b.example/']);
    expect(searched).toEqual(['https://c.example/', 'https://d.example/']);
    expect(usable).toEqual(['https://c.example/', 'https://d.example/']);
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    calls.length = 0;
    expect(await fallback.wrapAdapter(adapter({}, []), adapter({ 'c.example': ok }, calls)).download(task(), context())).toEqual(ok);
    expect(calls).toEqual(['c.example']);
    expect(searched).toHaveLength(2);
  });

  it.each(['builtin', 'engine'] as const)('无候选的 %s 原源被占用：保留分类、不扫池、不标失败', async kind => {
    const state = { usable: [], stored: [] as [number, string[]][], failures: [] as [number, string, string, string][] };
    const h = candidatesHarness(state);
    const gate: AdapterOutcome = { kind: 'incomplete', reason: 'source_unavailable',
      retryCause: 'host_occupied', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
    const calls: string[] = [];
    const origin = adapter({ 'book15.net': gate, 'origin.example': gate }, calls);
    const row = task({ source_kind: kind, source_url: kind === 'engine' ? 'https://origin.example/' : task().source_url });
    expect(await h.fallback.wrapAdapter(origin, origin, kind).download(row, context())).toBe(gate);
    expect(calls).toEqual([hostOf(row.source_url)]);
    expect(h.searched).toEqual([]);
    expect(state.stored).toEqual([]);
    expect(state.failures).toEqual([]);
  });

  it('builtin 门后端不可用立即返回，不读取候选或搜索池', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    const gate: AdapterOutcome = { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
      retryCause: 'host_occupancy_unavailable' };
    const calls: string[] = [];
    expect(await h.fallback.wrapAdapter(adapter({ 'book15.net': gate }, calls), adapter({}, calls)).download(task(), context())).toBe(gate);
    expect(calls).toEqual(['book15.net']);
    expect(h.poolLoads).toEqual([]);
    expect(h.searched).toEqual([]);
  });

  it.each(['interrupted', 'budget_exhausted'])('第一候选返回时 signal %s，不标坏且不下载第二候选', async reason => {
    const state = {
      usable: [{ source_url: 'https://a.example/', host: 'a.example' }, { source_url: 'https://b.example/', host: 'b.example' }],
      stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal());
    const controller = new AbortController();
    const calls: string[] = [];
    const engine: SourceAdapter = {
      kind: 'engine',
      async download(t) {
        calls.push(hostOf(t.source_url));
        controller.abort(new Error(reason));
        return { kind: 'failure', code: 'synthetic_source_failure' };
      },
    };
    expect(await h.fallback.wrapAdapter(adapter({}, []), engine).download(task(), { signal: controller.signal, progress: async () => {} }))
      .toMatchObject({ kind: 'incomplete', reason });
    expect(calls).toEqual(['a.example']);
    expect(state.failures).toEqual([]);
  });

  it.each([false, true])('选源期间预算中止按 incomplete 收口（补扫=%s），不归为源失败', async supplement => {
    const controller = new AbortController();
    const failed = new Set<string>();
    const marks: string[] = [];
    const calls: string[] = [];
    const searched: string[] = [];
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] },
        api: {
          engineSearchBook: async (source: { url: string }) => {
            searched.push(source.url);
            controller.abort(new Error('budget_exhausted'));
            throw controller.signal.reason;
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => [{ url: 'https://new.example/', name: 'new', searchUrl: '/s' }],
      candidates: {
        usable: async () => supplement
          ? [{ source_url: 'https://known.example/', host: 'known.example' }] : [],
        failedSources: async () => failed,
        replace: async () => {},
        markFailure: async (_bookId, url) => { marks.push(url); failed.add(url); },
        occupiedHosts: async () => new Set<string>(),
      },
      isSuspect: () => false,
    });
    const engine = adapter({ 'book15.net': {
      kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
    } }, calls);
    const out = await fallback.wrapAdapter(adapter({}, []), engine, 'engine')
      .download(task({ source_kind: 'engine' }), { signal: controller.signal, progress: async () => {} });
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'budget_exhausted' });
    expect(searched).toEqual(['https://new.example/']);
    expect(calls).toEqual(supplement ? ['known.example'] : ['book15.net']);
    expect(marks).toEqual(supplement ? ['https://known.example/'] : []);
  });

  it('门拒绝不标失败：host_occupied 换下一已记录源不 markFailure；host_occupancy_unavailable 立即收口不再试', async () => {
    const state = {
      usable: [
        { source_url: 'https://o1.example/b1', host: 'o1.example' },
        { source_url: 'https://o2.example/b1', host: 'o2.example' },
        { source_url: 'https://o3.example/b1', host: 'o3.example' },
      ],
      stored: [] as [number, string[]][],
      failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state, { hostTarget: 3, maxSources: 3 });
    const calls: string[] = [];
    const outcomes: Record<string, AdapterOutcome> = {
      'o1.example': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'request', retryCause: 'host_occupied' },
      'o2.example': { kind: 'complete', txt: 't', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1 },
    };
    const out = await h.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls),
      adapter(outcomes, calls),
    ).download(task(), context());
    // host_occupied：门拒绝，不标失败记忆，换下一个源（o2 complete 收口）。
    expect(out.kind).toBe('complete');
    expect(calls).toEqual(['o1.example', 'o2.example']);
    expect(state.failures).toEqual([]);
    // host_occupancy_unavailable：立即收口，不再试 o3、不标失败。
    const calls2: string[] = [];
    const state2 = {
      usable: [
        { source_url: 'https://u1.example/b1', host: 'u1.example' },
        { source_url: 'https://u2.example/b1', host: 'u2.example' },
      ],
      stored: [] as [number, string[]][],
      failures: [] as [number, string, string, string][],
    };
    const h2 = candidatesHarness(state2, { hostTarget: 2, maxSources: 2 });
    const out2 = await h2.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls2),
      adapter({ 'u1.example': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'request', retryCause: 'host_occupancy_unavailable' } }, calls2),
    ).download(task(), context());
    expect(out2).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable', retryCause: 'host_occupancy_unavailable' });
    expect(calls2).toEqual(['u1.example']); // 已有候选不试原源；u2 没被试
    expect(state2.failures).toEqual([]);
  });

  it('下载侧选源遇占用后端故障时按可重试门拒绝收口，不标源失败', async () => {
    const marks: string[] = [];
    const fallback = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] },
        api: {
          engineSearchBook: async () => {
            throw Object.assign(new Error('synthetic gate'), { code: 'HOST_OCCUPANCY_UNAVAILABLE' });
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => [{ url: 'https://new.example/', name: 'new', searchUrl: '/s' }],
      candidates: {
        usable: async () => [], failedSources: async () => new Set<string>(),
        replace: async () => {}, markFailure: async (_bookId, url) => { marks.push(url); },
        occupiedHosts: async () => new Set<string>(),
      },
      isSuspect: () => false,
    });
    const calls: string[] = [];
    const engine = adapter({ 'book15.net': {
      kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
    } }, calls);
    expect(await fallback.wrapAdapter(adapter({}, []), engine, 'engine')
      .download(task({ source_kind: 'engine' }), context())).toMatchObject({
      kind: 'incomplete', reason: 'source_unavailable', retryCause: 'host_occupancy_unavailable',
    });
    expect(calls).toEqual(['book15.net']);
    expect(marks).toEqual([]);
  });

  it('候选暂时占用不等于失败：继续已知备用源，但不补扫或覆盖候选', async () => {
    const state = {
      usable: [{ source_url: 'https://a.example/', host: 'a.example' }, { source_url: 'https://b.example/', host: 'b.example' }],
      stored: [] as [number, string[]][], failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    const calls: string[] = [];
    const gate: AdapterOutcome = {
      kind: 'incomplete', reason: 'source_unavailable', retryCause: 'host_occupied',
      chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
    };
    const out = await h.fallback.wrapAdapter(adapter({}, []), adapter({ 'a.example': gate }, calls), 'engine')
      .download(task({ source_kind: 'engine' }), context());
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable' });
    expect(calls).toEqual(['a.example', 'b.example']);
    expect(state.failures).toEqual([[1, 'https://b.example/', 'permanent', 'identity_mismatch_or_no_candidate']]);
    expect(h.searched).toEqual([]);
    expect(state.stored).toEqual([]);
  });

  it('下载腿：失败分类落库（identity ⇒ permanent，超时 ⇒ temporary）', async () => {
    const state = {
      usable: [{ source_url: 'https://x.example/b1', host: 'x.example' }, { source_url: 'https://y.example/b1', host: 'y.example' }],
      stored: [] as [number, string[]][],
      failures: [] as [number, string, string, string][],
    };
    const h = candidatesHarness(state);
    const calls: string[] = [];
    const outcomes: Record<string, AdapterOutcome> = {
      'x.example': { kind: 'failure', code: 'identity_mismatch_or_no_candidate' },
      'y.example': { kind: 'complete', txt: 't', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1 },
    };
    const out = await h.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls),
      adapter(outcomes, calls),
    ).download(task(), context());
    expect(out.kind).toBe('complete');
    expect(calls).toEqual(['x.example', 'y.example']);
    expect(state.failures).toEqual([[1, 'https://x.example/b1', 'permanent', 'identity_mismatch_or_no_candidate']]);
  });

  it('下载腿：engine.download 抛错按原语义上抛（物理作用域由 entry 的 engine 腿负责，本层无占位接缝）', async () => {
    const state = {
      usable: [{ source_url: 'https://boom.example/b1', host: 'boom.example' }],
      stored: [] as [number, string[]][],
      failures: [] as [number, string, string, string][],
    };
    const calls: string[] = [];
    const throwing: SourceAdapter = {
      kind: 'engine',
      async download(t) {
        calls.push(hostOf(t.source_url));
        throw new Error('engine crashed');
      },
    };
    const h = candidatesHarness(state);
    await expect(h.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls),
      throwing,
    ).download(task(), context())).rejects.toThrow('engine crashed'); // 未知异常按原语义上抛
    expect(calls).toEqual(['boom.example']);
    expect(state.failures).toEqual([]); // 抛错不走 markFailure（非源级分类）
  });

  it('下载腿：全部 host 被占用则不下载；候选读取失败则不补扫', async () => {
    const state = { usable: [], occupied: ['a.example', 'b.example', 'c.example'], stored: [], failures: [] as [number, string, string, string][] };
    const h = candidatesHarness(state);
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(
      adapter({ 'book15.net': { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'toc' } }, calls),
      adapter({}, calls),
    ).download(task(), context());
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable' });
    expect(calls).toEqual(['book15.net']); // 只试过 book15，引擎源一个都没下载
    // 读库失败（usable 抛错）⇒ 不盲扫，退避（与上一轮「走出网选源」不同：candidate 读失败即空返回）。
    let poolLoads = 0;
    let searches = 0;
    const broken = createBuiltinFallback({
      modules: {
        compile: { compileSource: () => ({}) },
        supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] },
        api: {
          engineSearchBook: async () => {
            searches += 1;
            return [{ title: '测试书', author: '佚名', bookUrl: 'https://d.example/b1' }];
          },
          engineFetchDetail: async () => ({ title: '测试书', author: '佚名' }),
        },
      },
      transport: async () => { throw new Error('unused'); },
      loadPool: async () => {
        poolLoads += 1;
        return ['https://d.example/'].map(url => ({ url, name: url, searchUrl: '/s' }));
      },
      candidates: {
        usable: async () => { throw new Error('db down'); },
        failedSources: async () => new Set<string>(),
        replace: async () => {},
        markFailure: async () => {},
        occupiedHosts: async () => new Set<string>(),
      },
      isSuspect: () => false,
    });
    expect(await broken.wrapPrecheck(async () => UNAVAILABLE)(task(), signal()))
      .toEqual({ ok: false, reason: 'source_unavailable', retryable: true, stage: 'search' });
    expect(poolLoads).toBe(0);
    expect(searches).toBe(0);
  });
});
