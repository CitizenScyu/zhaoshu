// capacity991：entry 生产端口装配（rollover seam）合成测试（全 mock：零网络、零真库、零凭据）。
//
// 断言任务书冻结的四件：
//   ① 开关关（未设 ZHAOSHU_ROLLOVER_ENABLED）⇒ WorkerOptions 不含 rollover（undefined），零行为变化；
//   ② 开 ⇒ seam 三件齐（port/current/rebuildGitHubContents），current 元组与装配期一致；
//   ③ 开但 listCandidates 拿不到对账证据（ledger 非 ready）⇒ 抛（不降级）；
//   ④ rebuildGitHubContents 用与装配期相同的配置（同 token + target 的 owner/repo/branch）重建闭包。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductionExecutorOptions, RuntimeStorage } from './entry';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { RepositoryTuple } from './repository-rollover';

const mocks = vi.hoisted(() => ({
  neon: vi.fn(), sql: vi.fn(), storage: vi.fn(), github: vi.fn(), modules: vi.fn(),
  resolveSource: vi.fn(), transport: vi.fn(), adapter: vi.fn(), executor: vi.fn(),
}));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('../scripts/engine-download.mjs', () => ({ downloadBook: vi.fn() }));
vi.mock('../src/lib/download-worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/download-worker')>()), createEngineAdapter: mocks.adapter,
}));
vi.mock('./storage', () => ({ createWorkerStorage: mocks.storage }));
vi.mock('./github-contents', () => ({ createGitHubContents: mocks.github }));
vi.mock('./engine', () => ({
  assembleEngineModules: mocks.modules, createResolveSource: mocks.resolveSource,
  createSourceTransport: mocks.transport, loadEnginePool: vi.fn(),
}));
vi.mock('./read-book-text', () => ({ readBookText: vi.fn() }));
vi.mock('./without-process-signals', () => ({ withoutProcessSignals: (fn: unknown) => fn }));
vi.mock('./budget-refund', () => ({ createBudgetRefund: vi.fn() }));
vi.mock('./identity-precheck', () => ({ createIdentityPrecheck: vi.fn() }));
vi.mock('./builtin-fallback', () => ({ createBuiltinFallback: vi.fn() }));
vi.mock('./executor', () => ({ createExecutor: mocks.executor, DEFAULT_DECISIONS: {} }));
vi.mock('../src/lib/db-quota', () => ({ dbQuotaBackoffMs: () => 0, recordDbQuotaSeen: vi.fn() }));
import { createDownloadExecutor } from './entry';

const storage = {} as RuntimeStorage;
const github: GitHubContents = { put: vi.fn(), getBytes: vi.fn() };
const executor = { synthetic: true };
const env = {
  NODE_ENV: 'test' as const, DATABASE_URL: 'synthetic-database', GITHUB_TOKEN: 'synthetic-token',
  ZHAOSHU_BOOKS_REPO: ' Storage/Books ',
};
function options(overrides: Partial<ProductionExecutorOptions> = {}): ProductionExecutorOptions {
  return { workDir: 'synthetic-workdir', budget: { read: vi.fn(), consume: vi.fn() },
    adapters: [], env: { NODE_ENV: 'test' as const }, ...overrides };
}

/** 一条已对账（ready）候选行；可覆盖为坏证据。 */
function candidateRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 17, owner: 'Storage', repo: 'Books', branch: 'main',
    enabled: true, is_private: true, read_only: false, sealed_at: null,
    ledger_state: 'ready', baseline_epoch: 'epoch-v1', target_bytes: '1000000000',
    registered_bytes: '0', reserved_bytes: '0',
    admission_status: 'granted', admission_version: 'adm-1',
    admission_valid_until: '2099-12-31T00:00:00.000Z',
    admission_target: { repositoryId: 17, branch: 'main' },
    ...over,
  };
}

describe('capacity991 entry rollover seam 装配（合成）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
    mocks.neon.mockReturnValue(mocks.sql);
    // 默认：反查仓返回 [{id:17}]；候选查询返回一条 ready 行。按查询文本区分两条 sql``。
    mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("");
      return text.includes('repository_capacity_ledger') ? [candidateRow()] : [{ id: 17 }];
    });
    mocks.storage.mockReturnValue(storage);
    mocks.github.mockReturnValue(github);
    mocks.modules.mockReturnValue({});
    mocks.resolveSource.mockReturnValue(vi.fn());
    mocks.transport.mockReturnValue({});
    mocks.adapter.mockReturnValue({});
    mocks.executor.mockReturnValue(executor);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('① 开关缺省关 ⇒ 注入的 WorkerOptions 不含 rollover（undefined）', async () => {
    await createDownloadExecutor(options({ env: { ...env } }));
    expect(mocks.executor).toHaveBeenCalledTimes(1);
    const deps = mocks.executor.mock.calls[0][0] as { rollover?: unknown };
    expect(deps.rollover).toBeUndefined();
    expect('rollover' in deps).toBe(false);
  });

  it('② 开关开 ⇒ seam 三件齐，current 元组与装配期一致', async () => {
    await createDownloadExecutor(options({ env: { ...env, ZHAOSHU_ROLLOVER_ENABLED: '1' } }));
    const deps = mocks.executor.mock.calls[0][0] as {
      rollover?: { port: { listCandidates(): Promise<readonly { id: number }[]>; now(): Date }; current: RepositoryTuple; rebuildGitHubContents(t: RepositoryTuple): GitHubContents };
    };
    const seam = deps.rollover;
    expect(seam).toBeDefined();
    expect(typeof seam!.port.listCandidates).toBe('function');
    expect(typeof seam!.port.now).toBe('function');
    expect(seam!.port.now()).toBeInstanceOf(Date);
    expect(typeof seam!.rebuildGitHubContents).toBe('function');
    // 装配期 current = resolveRepositoryId 结果(id=17) + 解析出的 owner/repo/branch。
    expect(seam!.current).toEqual({ id: 17, owner: 'Storage', repo: 'Books', branch: 'main' });
    // 端口能组装出证据（一条 ready 候选）。
    const candidates = await seam!.port.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(17);
  });

  it('③ 开但 listCandidates 拿不到对账证据（ledger 非 ready）⇒ 抛，不降级', async () => {
    mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("");
      // 候选行存在但账目未对账（uninitialized）。
      return text.includes('repository_capacity_ledger') ? [candidateRow({ ledger_state: 'uninitialized' })] : [{ id: 17 }];
    });
    await createDownloadExecutor(options({ env: { ...env, ZHAOSHU_ROLLOVER_ENABLED: '1' } }));
    const deps = mocks.executor.mock.calls[0][0] as { rollover?: { port: { listCandidates(): Promise<unknown> } } };
    await expect(deps.rollover!.port.listCandidates()).rejects.toThrow(/no ready capacity ledger/);
  });

  it('④ rebuildGitHubContents 用与装配期相同配置（同 token + target owner/repo/branch）重建闭包', async () => {
    await createDownloadExecutor(options({ env: { ...env, ZHAOSHU_ROLLOVER_ENABLED: '1' } }));
    const deps = mocks.executor.mock.calls[0][0] as {
      rollover?: { rebuildGitHubContents(t: RepositoryTuple): GitHubContents };
    };
    mocks.github.mockClear();
    const target: RepositoryTuple = { id: 99, owner: 'Next', repo: 'Store', branch: 'archive' };
    deps.rollover!.rebuildGitHubContents(target);
    // 同装配期 token（同配置），仓元组取自 target。
    expect(mocks.github).toHaveBeenCalledTimes(1);
    expect(mocks.github).toHaveBeenCalledWith({
      token: 'synthetic-token', repository: 'Next/Store', branch: 'archive',
    });
  });
});
