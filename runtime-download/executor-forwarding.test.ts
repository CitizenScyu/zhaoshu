// relocate1105：执行器把 prePublishCheck / relocateArtifacts 透传给 worker（此前 prePublishCheck 漏透传，
// 生产开着 DOWNLOAD_PREPUBLISH_CHECK=1 预检也从未生效）。不连库、不联网：内存 storage/budget/adapter。
import { describe, expect, it, vi } from 'vitest';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike } from './executor';
import type { AdapterOutcome, SourceAdapter, TaskRow, WorkerStorage } from '../src/lib/download-worker';
import type { DownloadTaskLease } from '../src/lib/download-task-queue';

const lease: DownloadTaskLease = { id: 9, leaseGeneration: 4, leaseOwner: 'owner', attemptCount: 1 };
const row: TaskRow = {
  id: 9, book_id: 1, title: '合成书', author: '合成作者', status: 'running',
  source_url: 'https://reader.test/book', source_kind: 'engine', source_id: null, requested_by: 'system',
};
const complete: AdapterOutcome = { kind: 'complete', txt: '合成正文', chaptersTotal: 1, chaptersDone: 1, charsTotal: 4 };

function harness(flags: { prePublishCheck?: boolean }) {
  const findArtifactIdentityOwner = vi.fn<NonNullable<WorkerStorage['findArtifactIdentityOwner']>>().mockResolvedValue(null);
  const storage: WorkerStorage = {
    claim: async () => lease,
    taskRow: async () => row,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async () => true,
    defer: async () => null,
    reserveArtifactPath: async () => 1,
    findArtifactBinding: async () => null,
    findArtifactIdentityOwner,
    registerArtifact: async () => 'registered',
  };
  const budget: DailyBudgetLike = {
    read: async () => ({ used: 0, limit: 5 }),
    consume: async () => ({ allowed: true, date: '2026-11-05' }),
  };
  const adapter: SourceAdapter = { kind: 'engine', download: async () => complete };
  const executor = createExecutor({
    storage, github: { put: async () => {}, getBytes: async () => null }, adapters: [adapter], budget,
    repositoryId: 1, branch: 'main', owner: 'owner', decisions: DEFAULT_DECISIONS,
    ...flags,
  });
  return { run: () => executor.runOnce(), findArtifactIdentityOwner };
}

describe('relocate1105 执行器透传', () => {
  it('prePublishCheck 开：worker 抓取前查 identity 落位', async () => {
    const { run, findArtifactIdentityOwner } = harness({ prePublishCheck: true });
    expect(await run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(findArtifactIdentityOwner).toHaveBeenCalledTimes(1);
  });

  it('缺省关：不查（与引入前一致）', async () => {
    const { run, findArtifactIdentityOwner } = harness({});
    expect(await run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(findArtifactIdentityOwner).not.toHaveBeenCalled();
  });
});
