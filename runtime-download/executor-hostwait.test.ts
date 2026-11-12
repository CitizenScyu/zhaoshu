// hostwait1031：执行器把 hostWait 透传给 worker（entry 由 DOWNLOAD_HOST_WAIT=1 开）；排队放回同书源不可达一样退还日预算，
// 日志「书源不可达」多带 hostWait:true。不连库、不联网：内存 storage/budget/adapter。
import { describe, expect, it, vi } from 'vitest';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike } from './executor';
import type { AdapterOutcome, SourceAdapter, TaskRow, WorkerStorage } from '../src/lib/download-worker';
import type { DownloadTaskLease } from '../src/lib/download-task-queue';
import type { BudgetRefundOutcome, BudgetTicket } from './budget-refund';

const lease: DownloadTaskLease = { id: 9, leaseGeneration: 4, leaseOwner: 'owner', attemptCount: 3 };
const row: TaskRow = {
  id: 9, book_id: 1, title: '合成书', author: '合成作者', status: 'running',
  source_url: 'https://reader.test/book', source_kind: 'engine', source_id: null, requested_by: 'system',
};
const occupied: AdapterOutcome = {
  kind: 'incomplete', reason: 'source_unavailable', stage: 'search', retryCause: 'host_occupied',
  chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
};

function harness(hostWait: boolean, extra: { progress?: boolean; outcome?: AdapterOutcome; lease?: DownloadTaskLease; put?: () => Promise<void>; deferLost?: boolean } = {}) {
  const deferred: Parameters<WorkerStorage['defer']>[1][] = [];
  const logged: [string, Record<string, unknown> | undefined][] = [];
  const storage: WorkerStorage = {
    claim: async () => extra.lease ?? lease,
    taskRow: async () => row,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async () => true,
    defer: async (_l, input) => { deferred.push(input); return extra.deferLost ? null : '2026-10-31T10:00:00.000Z'; },
    reserveArtifactPath: async () => 1,
    findArtifactBinding: async () => null,
    registerArtifact: async () => 'registered',
  };
  const budget: DailyBudgetLike = {
    read: async () => ({ used: 0, limit: 5 }),
    consume: async () => ({ allowed: true, date: '2026-10-31' }),
  };
  const refundBudget = vi.fn(async (_ticket: BudgetTicket): Promise<BudgetRefundOutcome> => 'refunded');
  const adapter: SourceAdapter = { kind: 'engine', download: async () => extra.outcome ?? occupied };
  const executor = createExecutor({
    storage, github: { put: extra.put ?? (async () => {}), getBytes: async () => null, del: async () => {} }, adapters: [adapter], budget, refundBudget,
    repositoryId: 1, branch: 'main', owner: 'owner', decisions: DEFAULT_DECISIONS,
    log: (_level, message, fields) => { logged.push([message, fields]); },
    ...(hostWait ? { hostWait: true } : {}),
    ...(extra.progress ? { hostWaitProgress: true } : {}),
  });
  return { run: () => executor.runOnce(), deferred, logged, refundBudget };
}

describe('hostwait1031 执行器透传', () => {
  it('开：host_occupied 不计 attempt 放回，退还日预算，日志带 hostWait', async () => {
    const h = harness(true);
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.deferred).toEqual([expect.objectContaining({ countAttempt: false, delayMs: 30 * 60_000 })]);
    expect(h.refundBudget).toHaveBeenCalledTimes(1);
    expect(h.logged).toEqual([['书源不可达', {
      reason: 'source_unavailable', stage: 'search', host: 'reader.test', retryAt: '2026-10-31T10:00:00.000Z', hostWait: true,
    }]]);
  });

  it('缺省关：与改前一致（计数放回、日志无 hostWait）', async () => {
    const h = harness(false);
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.deferred).toHaveLength(1);
    expect(h.deferred[0].countAttempt).toBeUndefined();
    expect(h.refundBudget).toHaveBeenCalledTimes(1);
    expect(h.logged).toEqual([['书源不可达', {
      reason: 'source_unavailable', stage: 'search', host: 'reader.test', retryAt: '2026-10-31T10:00:00.000Z',
    }]]);
  });

  it('breakerprogress1102：透传 hostWaitProgress——不计数领取已过 32 次时，有进展的熔断让出仍排队不计次', async () => {
    const outcome: AdapterOutcome = { ...occupied, stage: 'content', retryCause: 'host_breaker', progressed: true };
    const busy: DownloadTaskLease = { ...lease, leaseGeneration: 3 + 40, attemptCount: 3 };
    const on = harness(true, { progress: true, outcome, lease: busy });
    await on.run();
    expect(on.deferred).toEqual([expect.objectContaining({ countAttempt: false })]);
    const off = harness(true, { outcome, lease: busy });
    await off.run();
    expect(off.deferred).toHaveLength(1);
    expect(off.deferred[0].countAttempt).toBeUndefined();
  });
});

describe('发布退避与失租约留日志（带任务 id，不带路径）', () => {
  const txt = ['合成书', '合成作者', '', ...Array.from({ length: 3 }, (_, i) => `【第${i + 1}章 合成。】\n\n${'正文'.repeat(400)}`)].join('\n');
  const complete: AdapterOutcome = { kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 };
  const conflict = async () => { throw Object.assign(new Error('github_http_409'), { status: 409 }); };

  it('publication_retry → 一行「发布失败，已退避放回」，含阶段与 retryAt', async () => {
    const h = harness(false, { outcome: complete, put: conflict });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.logged).toEqual([['发布失败，已退避放回', {
      taskId: 9, stage: expect.stringMatching(/^[a-z]+:github_http_409$/), retryAt: '2026-10-31T10:00:00.000Z',
    }]]);
  });

  it('退避写库时租约已失 → 一行「任务失租约，交回收器」', async () => {
    const h = harness(false, { outcome: complete, put: conflict, deferLost: true });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.logged).toEqual([['任务失租约，交回收器', { taskId: 9 }]]);
  });
});
