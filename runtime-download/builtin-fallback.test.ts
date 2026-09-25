// 41-T8FB：builtin-fallback 单元层（不连库、不联网）：选源的容错与边界、下载腿的停止条件。
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
const signal = () => new AbortController().signal;

function harness(opts: {
  pool?: string[] | (() => never); throwSearch?: string[]; suspect?: string[]; noBook?: string[];
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
  });
  return { fallback, searched, poolLoads };
}

const adapter = (outcomes: Record<string, AdapterOutcome>, calls: string[]): SourceAdapter => ({
  kind: 'engine',
  async download(t) { calls.push(hostOf(t.source_url)); return outcomes[hostOf(t.source_url)] ?? { kind: 'failure', code: 'identity_mismatch_or_no_candidate' }; },
});
const context = () => ({ signal: signal(), progress: async () => {} });

describe('41-T8FB builtin-fallback', () => {
  it('选源：跳过 book15/非 https/suspect/同 host 重复，单源搜索失败只跳过该源，池序取前三', async () => {
    const h = harness({
      pool: ['https://www.book15.net/', 'http://plain.example/', 'https://dead.example/', 'https://boom.example/',
        'https://a.example/', 'https://a.example/other', 'https://none.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'],
      suspect: ['dead.example'], throwSearch: ['boom.example'], noBook: ['none.example'],
    });
    const precheck = h.fallback.wrapPrecheck(async () => UNAVAILABLE);
    expect(await precheck(task(), signal())).toEqual({ ok: true, reason: 'builtin_engine_fallback' });
    expect(h.searched).toEqual(['boom.example', 'a.example', 'none.example', 'b.example', 'c.example']);
    const calls: string[] = [];
    const out = await h.fallback.wrapAdapter(adapter({}, []), adapter({}, calls)).download(task(), context());
    expect(calls).toEqual(['a.example', 'b.example', 'c.example']); // 预检选好的源直接用，不再碰 book15
    expect(out).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable' });
  });

  it('逐书出网封顶：书不在池里时最多搜 MAX_FALLBACK_SCAN_SOURCES 个源', async () => {
    const pool = Array.from({ length: MAX_FALLBACK_SCAN_SOURCES + 10 }, (_, i) => `https://s${i}.example/`);
    const h = harness({ pool, noBook: pool.map(hostOf) });
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal())).toEqual(UNAVAILABLE);
    expect(h.searched).toHaveLength(MAX_FALLBACK_SCAN_SOURCES);
  });

  it('源池不可用 ⇒ 预检保持 source_unavailable（阶段沿用内层），不放行', async () => {
    const h = harness({ pool: () => { throw new Error('db down'); } });
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task(), signal())).toEqual(UNAVAILABLE);
  });

  it('内层预检其余结论（身份不符/放行/未验证）原样返回，不读源池；engine 任务不经回退', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    for (const result of [{ ok: false, reason: 'identity_mismatch' }, { ok: true }, { ok: true, reason: 'identity_unverified' }] as PrecheckResult[]) {
      expect(await h.fallback.wrapPrecheck(async () => result)(task(), signal())).toEqual(result);
    }
    expect(await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task({ source_kind: 'engine' }), signal())).toEqual(UNAVAILABLE);
    expect(h.poolLoads).toEqual([]);
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

  it('预检选的源只给同一任务：别的任务来领不沿用（单槽按任务 id 认领）', async () => {
    const h = harness({ pool: ['https://a.example/'] });
    await h.fallback.wrapPrecheck(async () => UNAVAILABLE)(task({ id: 1 }), signal());
    const calls: string[] = [];
    const ok: AdapterOutcome = { kind: 'complete', txt: 'x', chaptersTotal: 1, chaptersDone: 1, charsTotal: 1 };
    await h.fallback.wrapAdapter(adapter({ 'book15.net': ok }, calls), adapter({}, calls)).download(task({ id: 2 }), context());
    expect(calls).toEqual(['book15.net']);
  });
});
