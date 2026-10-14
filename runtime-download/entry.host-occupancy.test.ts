// bsrcfix-20261007：entry 的物理 host 占用装配合同（全 mock，不连库、不联网、不执行真实门）。
// 断言四件（任务书 §3/§4）：
//   ① 默认装配：原生 engine 腿与 builtin 腿的每次 download 各自 runDownload 逐次作用域——
//      fallback 换下一个源时，上一源的作用域已先释放（enter/exit 事件序）；
//   ② 共享 limiter 不重建：默认 transport 只建一次（同一 limiter 实例），wrapTransport 恰一次；
//   ③ DOWNLOAD_ENGINE_FALLBACK=0：fallback 不装配，但两条默认腿仍被逐次 scope 覆盖；
//   ④ options.adapters DI：外部自负边界——腿不经 runDownload 包装，executor 收到原样 adapters。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  neon: vi.fn(), storage: vi.fn(), github: vi.fn(), modules: vi.fn(),
  resolveSource: vi.fn(), transport: vi.fn(), adapter: vi.fn(), executor: vi.fn(),
  runDownload: vi.fn(), wrapTransport: vi.fn(), fallbackWrapAdapter: vi.fn(),
  identityPrecheck: vi.fn(), createHostOccupancy: vi.fn(), createBuiltinFallback: vi.fn(),
}));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('../scripts/engine-download.mjs', () => ({ downloadBook: vi.fn() }));
vi.mock('../src/lib/download-worker', () => ({ createEngineAdapter: mocks.adapter, WORKER_TASK_TIMEOUT_MS: 123_000 }));
vi.mock('./storage', () => ({ createWorkerStorage: mocks.storage }));
vi.mock('./github-contents', () => ({ createGitHubContents: mocks.github }));
vi.mock('./engine', () => ({
  assembleEngineModules: mocks.modules, createResolveSource: mocks.resolveSource,
  createSourceTransport: mocks.transport, loadEnginePool: vi.fn(),
}));
vi.mock('./read-book-text', () => ({ readBookText: vi.fn() }));
vi.mock('./without-process-signals', () => ({ withoutProcessSignals: (fn: unknown) => fn }));
vi.mock('./budget-refund', () => ({ createBudgetRefund: vi.fn() }));
vi.mock('./identity-precheck', () => ({ createIdentityPrecheck: mocks.identityPrecheck }));
vi.mock('./builtin-fallback', () => ({ createBuiltinFallback: mocks.createBuiltinFallback }));
vi.mock('./host-occupancy', () => ({ createHostOccupancy: mocks.createHostOccupancy }));
vi.mock('./executor', () => ({ createExecutor: mocks.executor, DEFAULT_DECISIONS: {} }));
vi.mock('../src/lib/db-quota', () => ({ dbQuotaBackoffMs: () => 0, recordDbQuotaSeen: vi.fn() }));
import { createDownloadExecutor, type ProductionExecutorOptions } from './entry';
import type { SourceAdapter } from '../src/lib/download-worker';

const storage = {} as never;
const github = { put: vi.fn(), getBytes: vi.fn() } as never;
const executorMarker = { synthetic: true };
const sqlMarker = (() => {}) as never;
const limiter = { syntheticLimiter: true } as never;
const context = { signal: new AbortController().signal, progress: vi.fn(async () => {}) };
const complete = { kind: 'complete' as const, txt: 'synthetic', chaptersTotal: 1, chaptersDone: 1, charsTotal: 9 };

function options(overrides: Partial<ProductionExecutorOptions> = {}): ProductionExecutorOptions {
  return { workDir: 'synthetic-workdir', budget: { read: vi.fn(), consume: vi.fn() },
    storage, github, repositoryId: 17, sql: sqlMarker, rateLimiter: limiter, env: {} as NodeJS.ProcessEnv, ...overrides };
}
const adaptersOf = () => mocks.executor.mock.calls[0][0].adapters as SourceAdapter[];

describe('entry 物理 host 占用装配', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.storage.mockReturnValue(storage);
    mocks.modules.mockReturnValue({ supported: { BUILTIN_SOURCE_HOSTS: ['book15.net'] } });
    mocks.resolveSource.mockReturnValue(vi.fn());
    mocks.transport.mockReturnValue(vi.fn(async () => ({ url: 'https://x.example/', text: '' })));
    mocks.adapter.mockImplementation(() => ({ kind: 'engine', download: vi.fn(async () => complete) }));
    mocks.executor.mockReturnValue(executorMarker);
    mocks.identityPrecheck.mockReturnValue(vi.fn());
    mocks.runDownload.mockImplementation(async (_t: number, _s: AbortSignal, op: () => Promise<unknown>) => op());
    mocks.wrapTransport.mockImplementation((t: unknown) => t);
    mocks.createHostOccupancy.mockReturnValue({ runDownload: mocks.runDownload, wrapTransport: mocks.wrapTransport });
    mocks.createBuiltinFallback.mockReturnValue({ wrapAdapter: mocks.fallbackWrapAdapter, wrapPrecheck: (h: unknown) => h });
  });

  it('默认装配：原生与 fallback 两条腿逐次作用域，fallback 换源上一源先释放；limiter/transport 单建单包', async () => {
    // fallback 换源：第一个源失败后换第二个源（顺序调用已包装的 engine 腿）。
    mocks.fallbackWrapAdapter.mockImplementation((_builtin: SourceAdapter, engine: SourceAdapter, kind: SourceAdapter['kind'] = 'builtin') => ({
      kind,
      async download(task: { id: number }, ctx: typeof context) {
        await engine.download({ ...task, source_url: 'https://a.example/b1', source_kind: 'engine' } as never, ctx);
        return engine.download({ ...task, source_url: 'https://b.example/b1', source_kind: 'engine' } as never, ctx);
      },
    }) as never);
    const events: string[] = [];
    mocks.runDownload.mockImplementation(async (_t: number, _s: AbortSignal, op: () => Promise<unknown>) => {
      events.push('enter');
      try { return await op(); }
      finally { events.push('exit'); }
    });

    expect(await createDownloadExecutor(options())).toBe(executorMarker);
    // 共享 limiter 不重建：默认 transport 只建一次（同一 limiter），且 wrap 的是它的返回值。
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.transport).toHaveBeenCalledWith(limiter);
    expect(mocks.wrapTransport).toHaveBeenCalledTimes(1);
    expect(mocks.wrapTransport).toHaveBeenCalledWith(mocks.transport.mock.results[0].value);
    // hostOccupancy 以注入 sql 建；TTL：download 与任务超时同源 + 10 分钟，scan 固定 6 分钟。
    expect(mocks.createHostOccupancy).toHaveBeenCalledTimes(1);
    expect(mocks.createHostOccupancy).toHaveBeenCalledWith(sqlMarker, {
      downloadTtlMs: 123_000 + 600_000, scanTtlMs: 360_000,
    });
    // fallback 包的是已 scoped 的 engine 腿（不是裸腿）。engine 与 builtin 均有候选消费包装。
    expect(mocks.adapter).toHaveBeenCalledTimes(2);
    expect(mocks.fallbackWrapAdapter).toHaveBeenCalledTimes(2);
    const wrappedEngine = mocks.fallbackWrapAdapter.mock.calls[0][1] as SourceAdapter;
    expect(mocks.fallbackWrapAdapter.mock.calls[0][2]).toBe('engine');
    expect(wrappedEngine).toBeDefined();
    // fallback 包装 engine 腿（adapters[0]；mock 换源形态：每次包装 download 内层 engine 调两次）：
    // 每次内层 download 各一个作用域、进出成对——连续两次包装调用合计 4 对 8 事件。
    const taskRow = { id: 7 } as never;
    await adaptersOf()[0].download(taskRow, context);
    await adaptersOf()[0].download(taskRow, context);
    expect(events).toEqual(['enter', 'exit', 'enter', 'exit', 'enter', 'exit', 'enter', 'exit']);
    // fallback 腿换源：第一源作用域退出后才进第二源（上个先释放，再占下一个）。
    events.length = 0;
    await adaptersOf()[1].download(taskRow, context);
    expect(events).toEqual(['enter', 'exit', 'enter', 'exit']);
    expect(mocks.runDownload).toHaveBeenCalledWith(7, context.signal, expect.any(Function));
  });

  it('单源下载抛错仍退出作用域，下一次下载重新进入', async () => {
    const events: string[] = [];
    const failure = new Error('synthetic_download_failure');
    const download = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(complete);
    mocks.adapter.mockReturnValue({ kind: 'engine', download });
    mocks.runDownload.mockImplementation(async (_t: number, _s: AbortSignal, op: () => Promise<unknown>) => {
      events.push('enter');
      try { return await op(); }
      finally { events.push('exit'); }
    });
    await createDownloadExecutor(options({ env: { DOWNLOAD_ENGINE_FALLBACK: '0' } as unknown as NodeJS.ProcessEnv }));
    const engine = adaptersOf()[0];
    await expect(engine.download({ id: 7 } as never, context)).rejects.toBe(failure);
    await expect(engine.download({ id: 7 } as never, context)).resolves.toEqual(complete);
    expect(events).toEqual(['enter', 'exit', 'enter', 'exit']);
  });

  it('DOWNLOAD_ENGINE_FALLBACK=0：fallback 不装配，两条默认腿仍被逐次 scope 覆盖', async () => {
    await createDownloadExecutor(options({ env: { DOWNLOAD_ENGINE_FALLBACK: '0' } as unknown as NodeJS.ProcessEnv }));
    expect(mocks.createBuiltinFallback).not.toHaveBeenCalled();
    expect(mocks.createHostOccupancy).toHaveBeenCalledTimes(1);
    const adapters = adaptersOf();
    expect(adapters).toHaveLength(2);
    await adapters[0].download({ id: 1 } as never, context);
    await adapters[1].download({ id: 2 } as never, context);
    expect(mocks.runDownload).toHaveBeenCalledTimes(2);
    expect(mocks.runDownload).toHaveBeenNthCalledWith(1, 1, context.signal, expect.any(Function));
    expect(mocks.runDownload).toHaveBeenNthCalledWith(2, 2, context.signal, expect.any(Function));
  });

  it('options.adapters DI：外部自负边界，腿不经 runDownload，executor 收到原样 adapters', async () => {
    const custom: SourceAdapter = { kind: 'engine', download: vi.fn(async () => complete) };
    await createDownloadExecutor(options({ adapters: [custom] }));
    expect(mocks.adapter).toHaveBeenCalledTimes(2);
    expect(mocks.createBuiltinFallback).not.toHaveBeenCalled();
    expect(adaptersOf()).toEqual([custom]);
    await adaptersOf()[0].download({ id: 9 } as never, context);
    expect(mocks.runDownload).not.toHaveBeenCalled();
  });
});
