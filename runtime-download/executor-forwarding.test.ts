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

function harness(flags: { prePublishCheck?: boolean; tocFloor?: boolean }, adapter: SourceAdapter = { kind: 'engine', download: async () => complete }) {
  const findArtifactIdentityOwner = vi.fn<NonNullable<WorkerStorage['findArtifactIdentityOwner']>>().mockResolvedValue(null);
  const progress = vi.fn<WorkerStorage['progress']>().mockResolvedValue(true);
  const storage: WorkerStorage = {
    claim: async () => lease,
    taskRow: async () => row,
    heartbeat: async () => true,
    progress,
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
  const executor = createExecutor({
    storage, github: { put: async () => {}, getBytes: async () => null, del: async () => {} }, adapters: [adapter], budget,
    repositoryId: 1, branch: 'main', owner: 'owner', decisions: DEFAULT_DECISIONS,
    ...flags,
  });
  return { run: () => executor.runOnce(), findArtifactIdentityOwner, progress };
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

// tocfloor1111：tocFloor 透传给 worker（开 = 进度回调写的是本次领取里章数最高的一份）。
describe('tocfloor1111 执行器透传', () => {
  const rejected = (): SourceAdapter => ({
    kind: 'engine',
    async download(_task, context) {
      await context.progress({ chaptersDone: 120, chaptersTotal: 200, charsTotal: 9000 });
      await context.progress({ chaptersDone: 0, chaptersTotal: 40, charsTotal: 0 });
      return { kind: 'failure', code: 'toc_below_floor' };
    },
  });

  it('tocFloor 开：腿报 0 时写的仍是最高那份进度', async () => {
    const { run, progress } = harness({ tocFloor: true }, rejected());
    expect(await run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(progress.mock.calls.map(call => call[1].chaptersDone)).toEqual([120, 120]);
  });

  it('缺省关：只有腿自己报的两次', async () => {
    const { run, progress } = harness({}, rejected());
    expect(await run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(progress.mock.calls.map(call => call[1].chaptersDone)).toEqual([120, 0]);
  });
});
