// T8 验收：drain 决策映射（不连库、不联网，用内存 storage/github）。
// 空队列不扣预算；领取成功才 consume；预算耗尽 → BUDGET_EXHAUSTED 且回退任务；
// 异常上抛交 drain 退避；决策字面量与 runtime/service/drain.mjs 的 LoopDecision 对齐。
import { describe, expect, it, vi } from 'vitest';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike, type LoopDecisions } from './executor';
import type { SourceAdapter, TaskRow, WorkerStorage } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { DownloadTaskLease } from '../src/lib/download-task-queue';

const lease: DownloadTaskLease = { id: 1, leaseGeneration: 1, leaseOwner: 'owner', attemptCount: 1 };
const row: TaskRow = {
  id: 1, book_id: 1, title: '测试书', author: '佚名', status: 'running',
  source_url: 'https://book15.example/x', source_kind: 'engine', source_id: null, requested_by: 'system',
};

function fakeStorage(over: Partial<WorkerStorage> & { releaseClaim?: (l: DownloadTaskLease) => Promise<boolean> } = {}): WorkerStorage {
  return {
    claim: async () => null,
    taskRow: async () => row,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async () => true,
    reserveArtifactPath: async () => 1,
    registerArtifact: async () => true,
    ...over,
  } as WorkerStorage;
}
const github: GitHubContents = { put: async () => {}, getBytes: async () => null };

function budget(allowed: boolean, log: string[]): DailyBudgetLike {
  return {
    async read() { return { used: 0, limit: 20 }; },
    async consume() { log.push('consume'); return { allowed }; },
  };
}

const deps = (storage: WorkerStorage, b: DailyBudgetLike, adapters: SourceAdapter[]) => ({
  storage, github, adapters, budget: b, repositoryId: 1, branch: 'main', owner: 'owner', decisions: DEFAULT_DECISIONS,
});

describe('T8 drain 决策映射', () => {
  it('决策字面量与 drain.mjs LoopDecision 一致', () => {
    expect(DEFAULT_DECISIONS).toEqual({ NO_TASK: 'no-task', BUDGET_EXHAUSTED: 'budget-exhausted', TASK_DONE: 'task-done' });
    const typed: LoopDecisions = DEFAULT_DECISIONS;
    expect(Object.values(typed)).toEqual(['no-task', 'budget-exhausted', 'task-done']);
  });

  it('空队列 → NO_TASK，不扣日预算', async () => {
    const log: string[] = [];
    const executor = createExecutor(deps(fakeStorage({ claim: async () => null }), budget(true, log), []));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.NO_TASK);
    expect(log).toEqual([]); // consume 未被调用
  });

  it('领取成功后 consume，且顺序为 claim → consume → 任务处理', async () => {
    const log: string[] = [];
    const storage = fakeStorage({
      claim: async () => { log.push('claim'); return lease; },
      releaseClaim: async () => { log.push('release'); return true; },
    });
    const adapter: SourceAdapter = { kind: 'engine', async download() { log.push('download'); return { kind: 'failure', code: 'x' }; } };
    const executor = createExecutor(deps(storage, budget(true, log), [adapter]));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(log).toEqual(['claim', 'consume', 'download']);
  });

  it('预算耗尽 → BUDGET_EXHAUSTED，任务回退 pending，不跑 adapter', async () => {
    const log: string[] = [];
    const storage = fakeStorage({
      claim: async () => { log.push('claim'); return lease; },
      releaseClaim: async () => { log.push('release'); return true; },
    });
    const adapter: SourceAdapter = { kind: 'engine', async download() { log.push('download'); return { kind: 'failure', code: 'x' }; } };
    const executor = createExecutor(deps(storage, budget(false, log), [adapter]));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.BUDGET_EXHAUSTED);
    expect(log).toEqual(['claim', 'consume', 'release']); // 回退、不处理
  });

  it('storage 异常上抛（交 drain errorBackoffMs 退避）', async () => {
    const storage = fakeStorage({ claim: async () => { throw new Error('db_down'); } });
    const executor = createExecutor(deps(storage, budget(true, []), []));
    await expect(executor.runOnce()).rejects.toThrow('db_down');
  });

  it('预算 consume 抛错：任务回退 pending 后异常上抛', async () => {
    const released: string[] = [];
    const storage = fakeStorage({
      claim: async () => lease,
      releaseClaim: async () => { released.push('release'); return true; },
    });
    const failing: DailyBudgetLike = { async read() { return { used: 0, limit: 20 }; }, async consume() { throw new Error('budget_io'); } };
    const executor = createExecutor(deps(storage, failing, []));
    await expect(executor.runOnce()).rejects.toThrow('budget_io');
    expect(released).toEqual(['release']);
  });

  it('signal 已 aborted：不领取，直接 NO_TASK（停机语义）', async () => {
    const claim = vi.fn(async () => lease);
    const storage = fakeStorage({ claim });
    const controller = new AbortController();
    controller.abort();
    const executor = createExecutor(deps(storage, budget(true, []), []));
    expect(await executor.runOnce(controller.signal)).toBe(DEFAULT_DECISIONS.NO_TASK);
    expect(claim).not.toHaveBeenCalled();
  });
});
