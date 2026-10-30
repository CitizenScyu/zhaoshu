// shutrel1030：停机中止在途下载并原样放回 pending（entry 由 DOWNLOAD_SHUTDOWN_RELEASE=1 开 releaseOnShutdown）。
// 不连库、不联网：内存 storage/budget/adapter，drain 的停机 signal 由用例在下载中途 abort。
import { describe, expect, it, vi } from 'vitest';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike } from './executor';
import type { AdapterOutcome, SourceAdapter, SourceAdapterContext, TaskRow, WorkerStorage } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { DownloadTaskLease } from '../src/lib/download-task-queue';
import type { BudgetRefundOutcome, BudgetTicket } from './budget-refund';

const lease: DownloadTaskLease = { id: 9, leaseGeneration: 4, leaseOwner: 'owner', attemptCount: 3 };
const row: TaskRow = {
  id: 9, book_id: 1, title: '合成书', author: '合成作者', status: 'running',
  source_url: 'https://reader.test/book', source_kind: 'engine', source_id: null, requested_by: 'system',
};
const interrupted: AdapterOutcome = { kind: 'incomplete', reason: 'interrupted', chaptersTotal: 10, chaptersDone: 4, charsTotal: 400 };
const complete: AdapterOutcome = { kind: 'complete', txt: '第一章\n合成正文\n', chaptersTotal: 1, chaptersDone: 1, charsTotal: 4 };

type Step = (context: SourceAdapterContext, stop: () => void) => Promise<AdapterOutcome>;

function harness(step: Step, options: { on?: boolean; release?: boolean | 'none' | 'throw'; storage?: Partial<WorkerStorage> } = {}) {
  const log: string[] = [];
  const logged: string[] = [];
  const drain = new AbortController();
  const files = new Map<string, string>();
  const release = options.release ?? true;
  const github: GitHubContents = {
    put: async (path, text) => { files.set(path, text); },
    getBytes: async path => { const text = files.get(path); return text === undefined ? null : Buffer.from(text, 'utf8'); },
  };
  const storage: WorkerStorage = {
    claim: async () => { log.push('claim'); return lease; },
    taskRow: async () => row,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async (_l, r) => { log.push(`finish:${r.status}`); return true; },
    defer: async () => { log.push('defer'); return '2026-10-30T10:00:00.000Z'; },
    reserveArtifactPath: async () => 1,
    findArtifactBinding: async () => null,
    registerArtifact: async () => 'registered',
    ...(release === 'none' ? {} : {
      releaseClaim: async (): Promise<boolean> => {
        log.push('release');
        if (release === 'throw') throw new Error('db_down');
        return release === true;
      },
    }),
    ...options.storage,
  };
  const budget: DailyBudgetLike = {
    read: async () => ({ used: 0, limit: 5 }),
    consume: async () => { log.push('consume'); return { allowed: true, date: '2026-10-30' }; },
  };
  const refundBudget = vi.fn(async (_ticket: BudgetTicket): Promise<BudgetRefundOutcome> => 'refunded');
  const adapter: SourceAdapter = {
    kind: 'engine',
    async download(_task, context) {
      log.push('download');
      const outcome = await step(context, () => drain.abort('SIGTERM'));
      log.push(`leg:${context.signal.aborted}`);
      return outcome;
    },
  };
  const executor = createExecutor({
    storage, github, adapters: [adapter], budget, refundBudget, repositoryId: 1, branch: 'main', owner: 'owner',
    decisions: DEFAULT_DECISIONS, log: (_level, message) => { logged.push(message); },
    ...(options.on === false ? {} : { releaseOnShutdown: true }),
  });
  return { run: () => executor.runOnce(drain.signal), log, logged, refundBudget, files };
}

// 下载中途收到停机：腿被中止则按引擎口径给 interrupted，没被中止给失败码 x（便于区分两条路径）。
const stopMidway: Step = async (context, stop) => {
  stop();
  await Promise.resolve();
  return context.signal.aborted ? interrupted : { kind: 'failure', code: 'x' };
};

describe('shutrel1030 停机放回在途下载', () => {
  it('缺省关：停机信号不进下载腿，行为与引入前一致（在途照跑到终态，不放回、不退还）', async () => {
    const h = harness(stopMidway, { on: false });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'leg:false', 'finish:failed']);
    expect(h.refundBudget).not.toHaveBeenCalled();
  });

  it('开：下载中途停机 ⇒ releaseClaim 原样放回 pending，不写终态、不 defer，退还本次日预算', async () => {
    const h = harness(stopMidway);
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'leg:true', 'release']);
    expect(h.refundBudget).toHaveBeenCalledTimes(1);
    expect(h.refundBudget).toHaveBeenCalledWith({ key: '9:4', date: '2026-10-30' });
    expect(h.logged).toEqual(['停机中止在途下载，已放回 pending']);
  });

  it('开：下载腿因停机抛错 ⇒ 同样放回，不落 failed', async () => {
    const h = harness(async (_context, stop) => { stop(); throw new Error('interrupted'); });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'release']);
    expect(h.refundBudget).toHaveBeenCalledTimes(1);
  });

  it('开：停机时已拿到整本 ⇒ 照常发布 done，不放回、不退还', async () => {
    const h = harness(async (_context, stop) => { stop(); return complete; });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'leg:true', 'finish:done']);
    expect(h.files.size).toBeGreaterThan(0);
    expect(h.refundBudget).not.toHaveBeenCalled();
  });

  it('开但没停机 ⇒ 与关闭时同一路径', async () => {
    const h = harness(async () => ({ kind: 'failure', code: 'x' }));
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'leg:false', 'finish:failed']);
    expect(h.refundBudget).not.toHaveBeenCalled();
  });

  it('开：腿内失租约优先 ⇒ 不放回、不写终态、不退还', async () => {
    const h = harness(async (context, stop) => {
      stop();
      await context.progress({ chaptersDone: 1, chaptersTotal: 10, charsTotal: 100 });
      return interrupted;
    }, { storage: { progress: async () => false } });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download']);
    expect(h.refundBudget).not.toHaveBeenCalled();
  });

  it('开但 storage 无 releaseClaim ⇒ 不接停机信号（与关闭时一致）', async () => {
    const h = harness(stopMidway, { release: 'none' });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'leg:false', 'finish:failed']);
  });

  it.each([false, 'throw'] as const)('开：放回结果 %s（失租约/库不可达）⇒ 不写终态、不退还，行留给回收器', async release => {
    const h = harness(stopMidway, { release });
    expect(await h.run()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'leg:true', 'release']);
    expect(h.refundBudget).not.toHaveBeenCalled();
    expect(h.logged).toEqual([]);
  });
});
