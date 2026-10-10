import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductionExecutorOptions, RuntimeStorage } from './entry';
import type { GitHubContents } from '../src/lib/download-publisher';

const mocks = vi.hoisted(() => ({
  neon: vi.fn(), sql: vi.fn(), storage: vi.fn(), github: vi.fn(), modules: vi.fn(),
  resolveSource: vi.fn(), transport: vi.fn(), adapter: vi.fn(), executor: vi.fn(),
}));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('../scripts/engine-download.mjs', () => ({ downloadBook: vi.fn() }));
vi.mock('../src/lib/download-worker', () => ({ createEngineAdapter: mocks.adapter }));
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
// repository.ts保持真实：其SQL模板进入假SQL，不注入ID冒充反查覆盖。
import { createDownloadExecutor } from './entry';

const storage = {} as RuntimeStorage;
const github: GitHubContents = { put: vi.fn(), getBytes: vi.fn() };
const executor = { synthetic: true };
const env = { NODE_ENV: 'test' as const, DATABASE_URL: 'synthetic-database', GITHUB_TOKEN: 'synthetic-token',
  ZHAOSHU_BOOKS_REPO: ' Storage/Books ', GITHUB_REPOSITORY: 'Runner/Execution' };
function options(overrides: Partial<ProductionExecutorOptions> = {}): ProductionExecutorOptions {
  return { workDir: 'synthetic-workdir', budget: { read: vi.fn(), consume: vi.fn() },
    adapters: [], env: { NODE_ENV: 'test' as const }, ...overrides };
}
function noAssembly() {
  for (const factory of Object.values(mocks)) expect(factory).not.toHaveBeenCalled();
}

describe('createDownloadExecutor显式存储目标合同', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
    mocks.neon.mockReturnValue(mocks.sql);
    mocks.sql.mockResolvedValue([{ id: 17 }]);
    mocks.storage.mockReturnValue(storage);
    mocks.github.mockReturnValue(github);
    mocks.modules.mockReturnValue({});
    mocks.resolveSource.mockReturnValue(vi.fn());
    mocks.transport.mockReturnValue({});
    mocks.adapter.mockReturnValue({});
    mocks.executor.mockReturnValue(executor);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('只有执行仓变量不能成为存储目标，任何工厂均未装配', async () => {
    await expect(createDownloadExecutor(options({ env: { NODE_ENV: 'test' as const, GITHUB_REPOSITORY: 'Runner/Execution' } })))
      .rejects.toThrow('MISSING_STORAGE_REPOSITORY');
    noAssembly();
  });

  it.each([{ github }, { repositoryId: 17 }, { github: null as unknown as GitHubContents }, { repositoryId: 0 }])
    ('单侧DI按undefined判定并前置拒绝（%#）', async (injected) => {
      await expect(createDownloadExecutor(options(injected))).rejects.toThrow('STORAGE_TARGET_INJECTION_PAIR_REQUIRED');
      noAssembly();
    });

  it('完整可信DI无仓目标环境可装配，并保留注入client对象', async () => {
    expect(await createDownloadExecutor(options({ github, repositoryId: 17, storage }))).toBe(executor);
    expect(mocks.executor).toHaveBeenCalledWith(expect.objectContaining({ github, storage, repositoryId: 17, branch: 'main' }));
    expect(mocks.neon).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.github).not.toHaveBeenCalled();
  });

  it('完整目标DI没有storage仍按旧合同要求DB', async () => {
    await expect(createDownloadExecutor(options({ github, repositoryId: 17 })))
      .rejects.toThrow('missing environment key: DATABASE_URL');
    noAssembly();
  });

  it('完整目标DI只补storage时不要求仓或GitHub环境', async () => {
    await createDownloadExecutor(options({ github, repositoryId: 17, env: { NODE_ENV: 'test' as const, DATABASE_URL: 'synthetic-database' } }));
    expect(mocks.storage).toHaveBeenCalledWith(mocks.sql);
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.github).not.toHaveBeenCalled();
    expect(mocks.executor).toHaveBeenCalledWith(expect.objectContaining({ github, repositoryId: 17 }));
  });

  it.each([
    [undefined, undefined, 'main'],
    [undefined, 'archive-env', 'archive-env'],
    [' release/中文 ?#& ', 'ignored-env', ' release/中文 ?#& '],
  ] as const)('默认目标一次解析，branch优先级及原始值保持（%#）', async (branch, envBranch, expectedBranch) => {
    expect(await createDownloadExecutor(options({ env: { ...env, DOWNLOAD_TARGET_BRANCH: envBranch }, branch }))).toBe(executor);
    expect(mocks.neon).toHaveBeenCalledTimes(1);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.sql.mock.calls[0].slice(1)).toEqual(['Storage', 'Books', expectedBranch]);
    expect(mocks.github).toHaveBeenCalledTimes(1);
    expect(mocks.github).toHaveBeenCalledWith({ token: 'synthetic-token', repository: 'Storage/Books', branch: expectedBranch });
    expect(mocks.executor).toHaveBeenCalledWith(expect.objectContaining({ github, repositoryId: 17, branch: expectedBranch }));
  });

  it('options.repository优先于坏环境目标，注入storage也必须真实走反查', async () => {
    await createDownloadExecutor(options({ storage, repository: ' Options/Store ', env: { ...env, ZHAOSHU_BOOKS_REPO: 'bad/value/extra' } }));
    expect(mocks.storage).not.toHaveBeenCalled();
    expect(mocks.sql.mock.calls[0].slice(1)).toEqual(['Options', 'Store', 'main']);
    expect(mocks.github).toHaveBeenCalledWith({ token: 'synthetic-token', repository: 'Options/Store', branch: 'main' });
  });

  it.each(['', ' ', 'a/b/c', './b', 'a/..', 'a/ b', 'a/b?x', 'a/b#x', 'a/@b',
    'a\\b', 'a//b', 'a/b\n', '\ta/b', null, 17])('显式空值或非法格式不回退也不泄漏输入（%#）', async (repository) => {
    await expect(createDownloadExecutor(options({ env, repository: repository as string })))
      .rejects.toEqual(new Error('INVALID_STORAGE_REPOSITORY'));
    noAssembly();
  });

  it('默认环境目标也经过格式门', async () => {
    await expect(createDownloadExecutor(options({ env: { ...env, ZHAOSHU_BOOKS_REPO: 'bad/@target' } })))
      .rejects.toEqual(new Error('INVALID_STORAGE_REPOSITORY'));
    noAssembly();
  });

  it.each([
    { writable: false, registeredBranch: 'archive' },
    { writable: true, registeredBranch: 'other-branch' },
  ])('资格不足或branch未匹配导致反查空行时拒绝，不退回执行仓（%#）', async (registered) => {
    mocks.sql.mockImplementation(async (_query, owner, repo, branch) => {
      expect([owner, repo, branch]).toEqual(['Storage', 'Books', 'archive']);
      return registered.writable && branch === registered.registeredBranch ? [{ id: 17 }] : [];
    });
    await expect(createDownloadExecutor(options({ env, branch: 'archive' })))
      .rejects.toEqual(new Error('no writable storage_repositories row for repository/branch'));
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.github).not.toHaveBeenCalled();
    expect(mocks.modules).not.toHaveBeenCalled();
    expect(mocks.executor).not.toHaveBeenCalled();
  });

  it.each(['', ' \t ', 42])('无效branch在默认与完整DI两条路径均前置拒绝（%#）', async (branch) => {
    for (const injected of [{}, { github, repositoryId: 17, storage }]) {
      await expect(createDownloadExecutor(options({ env, ...injected, branch: branch as string })))
        .rejects.toEqual(new Error('INVALID_STORAGE_BRANCH'));
      noAssembly();
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, '17'])
    ('完整DI的ID必须是正安全整数（%#）', async (repositoryId) => {
      await expect(createDownloadExecutor(options({ github, storage, repositoryId: repositoryId as number })))
        .rejects.toEqual(new Error('INVALID_STORAGE_REPOSITORY_ID'));
      noAssembly();
    });
});
