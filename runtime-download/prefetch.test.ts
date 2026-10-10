// 预取调度器核心合成测试（不连库、不联网）：并发互斥、有界重试、race 兜底、中止归还、
// 空选源不落 plan、注入边界与日志脱敏。
import { describe, expect, it, vi } from 'vitest';
import {
  PREFETCH_TARGET_HITS, runPrefetchScheduler,
  type PrefetchSchedulerOptions, type PrefetchStore, type PrefetchTask,
} from './prefetch';

const task = (id: number, bookId = id * 10): PrefetchTask => ({ id, bookId, title: `t${id}`, author: '佚名' });

interface StoreOptions {
  tasks: PrefetchTask[];
  busyHosts?: string[];
  finishThrows?: boolean;
}

/** 跨实例共享的 fake store：claimNext 互斥由内存行状态模拟（同一任务只被领走一次）。 */
function createFakeStore(opts: StoreOptions) {
  const rows = opts.tasks.map(t => ({ task: t, claimed: false, finished: false, released: false }));
  const calls = { busyHosts: 0, claimNext: 0, finish: 0, release: 0 };
  const releases: { id: number; reason: string; retryDelayMs?: number }[] = [];
  const plans = new Map<number, string[]>();
  const store: PrefetchStore = {
    async busyHosts() { calls.busyHosts += 1; return [...opts.busyHosts ?? []]; },
    async claimNext() {
      calls.claimNext += 1;
      const row = rows.find(r => !r.claimed && !r.finished && !r.released);
      if (!row) return null;
      row.claimed = true;
      return row.task;
    },
    async finish(t, plan) {
      calls.finish += 1;
      if (opts.finishThrows) throw new Error('store down');
      const row = rows.find(r => r.task.id === t.id && r.claimed && !r.released);
      if (!row) return false;
      row.finished = true;
      plans.set(t.id, plan.sourceUrls);
      return true;
    },
    async release(t, input) {
      calls.release += 1;
      releases.push({ id: t.id, reason: input.reason, retryDelayMs: input.retryDelayMs });
      const row = rows.find(r => r.task.id === t.id && r.claimed && !r.finished);
      if (!row) return false;
      row.claimed = false;
      row.released = false; // 归还后可再次被领取（store 侧按 retryDelayMs 决定何时放回）
      return true;
    },
  };
  return { store, calls, releases, plans, rows };
}

const signal = () => new AbortController().signal;

const baseOptions = (
  store: PrefetchStore,
  over: Partial<PrefetchSchedulerOptions> = {},
): PrefetchSchedulerOptions => ({ store, selector: async () => [], signal: signal(), ...over });

describe('预取调度器', () => {
  it('两个调度者共享同一 store：不重复领取、不重复预扫，各领各的书', async () => {
    const s = createFakeStore({ tasks: [task(1), task(2), task(3), task(4)] });
    const scanned: number[] = [];
    const selector = vi.fn(async (req: { task: PrefetchTask }) => {
      scanned.push(req.task.id);
      return [`https://h${req.task.id}.example/b`, `https://h${req.task.id}b.example/b`];
    });
    const [r1, r2] = await Promise.all([
      runPrefetchScheduler(baseOptions(s.store, { selector, maxTasksPerRound: 4, maxIdlePolls: 2, idlePollMs: 1 })),
      runPrefetchScheduler(baseOptions(s.store, { selector, maxTasksPerRound: 4, maxIdlePolls: 2, idlePollMs: 1 })),
    ]);
    expect([r1, r2].every(r => r === 'completed' || r === 'idle_bound')).toBe(true);
    expect(scanned.sort()).toEqual([1, 2, 3, 4]);
    expect(s.plans.size).toBe(4);
  });

  it('无任务：空领取连续到达上界即停（有界空转）', async () => {
    const s = createFakeStore({ tasks: [] });
    const selector = vi.fn(async () => []);
    const result = await runPrefetchScheduler(baseOptions(s.store, { selector, maxIdlePolls: 2, idlePollMs: 1 }));
    expect(result).toBe('idle_bound');
    expect(s.calls.claimNext).toBe(2);
    expect(selector).not.toHaveBeenCalled();
  });

  it('选源器持续失败：连续失败到上界即停，失败书归还预取租约', async () => {
    const s = createFakeStore({ tasks: [task(1)] });
    const selector = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const result = await runPrefetchScheduler(baseOptions(s.store, {
      selector, maxConsecutiveFailures: 3, failureBackoffMs: 1,
    }));
    expect(result).toBe('failure_bound');
    expect(selector).toHaveBeenCalledTimes(3);
    expect(s.releases.map(r => r.reason)).toEqual(['scan_failed', 'scan_failed', 'scan_failed']);
    expect(s.plans.size).toBe(0);
  });

  it('selector 同步抛错：按有界失败处理，不越过清理（timer 不泄漏）', async () => {
    const s = createFakeStore({ tasks: [task(1)] });
    const selector = vi.fn(() => { throw new TypeError('sync boom'); });
    const result = await runPrefetchScheduler(baseOptions(s.store, {
      selector, maxConsecutiveFailures: 2, failureBackoffMs: 1, budgetMs: 60_000,
    }));
    expect(result).toBe('failure_bound');
    expect(selector).toHaveBeenCalledTimes(2);
    expect(s.releases.every(r => r.reason === 'scan_failed')).toBe(true);
    expect(s.plans.size).toBe(0);
  });

  it('外部中止纳入 race：selector 永不 settle 也不等预算，立即停并归还', async () => {
    const s = createFakeStore({ tasks: [task(1)] });
    const selector = vi.fn((req, sig) => new Promise<string[]>(() => { void req; void sig; }));
    const controller = new AbortController();
    const running = runPrefetchScheduler(baseOptions(s.store, {
      selector, signal: controller.signal, budgetMs: 300_000,
    }));
    await new Promise(r => setTimeout(r, 10));
    expect(selector).toHaveBeenCalledTimes(1);
    const startedAt = Date.now();
    controller.abort();
    const result = await running;
    expect(result).toBe('aborted');
    expect(Date.now() - startedAt).toBeLessThan(5_000); // 没等 300s 预算
    expect(s.releases).toEqual([{ id: 1, reason: 'aborted', retryDelayMs: undefined }]);
    expect(s.plans.size).toBe(0);
  });

  it('预算超时兜底：selector 永不 settle 也不拖过单本预算，scanSignal 通知守约 selector', async () => {
    const s = createFakeStore({ tasks: [task(1)] });
    let observedAbort = false;
    const selector = vi.fn((req, sig) => new Promise<string[]>(() => {
      void req;
      sig.addEventListener('abort', () => { observedAbort = true; });
    }));
    const result = await runPrefetchScheduler(baseOptions(s.store, {
      selector, budgetMs: 30, maxConsecutiveFailures: 1,
    }));
    expect(result).toBe('failure_bound');
    expect(s.releases.map(r => r.reason)).toEqual(['scan_budget_exhausted']);
    expect(observedAbort).toBe(true); // race 停止等待的同时给了 selector 停止信号
  });

  it('空选源不落 plan：release no_sources 带退避，不重扫到死也不计成功', async () => {
    const s = createFakeStore({ tasks: [task(1), task(2)] });
    const selector = vi.fn(async () => []);
    const result = await runPrefetchScheduler(baseOptions(s.store, {
      selector, maxConsecutiveFailures: 3, idlePollMs: 1,
    }));
    expect(result).toBe('failure_bound');
    expect(s.calls.finish).toBe(0); // 从不把空 plan finish 成有效 plan
    expect(s.releases.every(r => r.reason === 'no_sources' && r.retryDelayMs !== undefined)).toBe(true);
    expect(s.plans.size).toBe(0);
  });

  it('每轮上界：完成 maxTasksPerRound 本即停，队里剩书留给下一轮', async () => {
    const s = createFakeStore({ tasks: [task(1), task(2), task(3)] });
    const result = await runPrefetchScheduler(baseOptions(s.store, {
      selector: async req => [`https://a${req.task.id}.example/b`, `https://b${req.task.id}.example/b`],
      maxTasksPerRound: 2,
    }));
    expect(result).toBe('completed');
    expect(s.plans.size).toBe(2);
  });

  it('命中 targetHits 即收：选源器收到守约参数，超出/违规的选源被防御性裁剪', async () => {
    const s = createFakeStore({ tasks: [task(1)], busyHosts: ['busy.example'] });
    let seenTarget = -1;
    const result = await runPrefetchScheduler(baseOptions(s.store, {
      selector: async (req) => {
        seenTarget = req.targetHits;
        expect(req.excludedHosts).toContain('busy.example');
        return [
          'https://busy.example/b',        // running host：不许选
          'https://a.example/b',
          'https://a.example/other',      // 同 host 重复
          'not-a-url',                    // 解析不出 host
          'https://b.example/b',
          'https://c.example/b',          // 超过 targetHits=2
        ];
      },
      targetHits: 2, maxIdlePolls: 1, idlePollMs: 1, maxTasksPerRound: 1,
    }));
    expect(result).toBe('completed');
    expect(seenTarget).toBe(2);
    expect(s.plans.get(1)).toEqual(['https://a.example/b', 'https://b.example/b']);
  });

  it('正在下载的 host 传给选源器（busyHosts 注入）', async () => {
    const s = createFakeStore({ tasks: [task(1)], busyHosts: ['book15.net'] });
    let excluded: string[] = [];
    await runPrefetchScheduler(baseOptions(s.store, {
      selector: async req => { excluded = [...req.excludedHosts]; return []; },
      maxConsecutiveFailures: 1,
    }));
    expect(excluded).toEqual(['book15.net']);
  });

  it('store 抛错（非预期退出路径）：finally 也归还持有的预取租约', async () => {
    const s = createFakeStore({ tasks: [task(1)], finishThrows: true });
    await expect(runPrefetchScheduler(baseOptions(s.store, {
      selector: async () => ['https://a.example/b', 'https://b.example/b'],
      maxConsecutiveFailures: 1, failureBackoffMs: 1,
    }))).rejects.toThrow('store down');
    expect(s.releases.some(r => r.id === 1)).toBe(true);
  });

  it('注入边界：调度器只触碰 PrefetchStore 四个方法，接口无 download_tasks 写入口', async () => {
    type StoreKeys = keyof PrefetchStore;
    const expected: StoreKeys[] = ['busyHosts', 'claimNext', 'finish', 'release'];
    const actual = Object.keys({
      busyHosts: 0, claimNext: 0, finish: 0, release: 0,
    } satisfies Record<StoreKeys, number>).sort();
    expect(actual).toEqual([...expected].sort());
    const s = createFakeStore({ tasks: [task(1), task(2)] });
    const touched = new Set<string>();
    const probed = new Proxy(s.store, {
      get(target, prop: string) { touched.add(prop); return target[prop as keyof PrefetchStore]; },
    });
    let failOnce = true;
    await runPrefetchScheduler(baseOptions(probed, {
      selector: async () => {
        if (failOnce) { failOnce = false; throw new TypeError('one-off'); }
        return ['https://a.example/b', 'https://b.example/b'];
      },
      maxIdlePolls: 1, idlePollMs: 1, maxTasksPerRound: 2, failureBackoffMs: 1,
    }));
    expect([...touched].sort()).toEqual(['busyHosts', 'claimNext', 'finish', 'release']);
  });

  it('日志脱敏：不记书名、作者、原始源 URL；只记 taskId/bookId/host', async () => {
    const SECRET_TITLE = '测试书名甲';
    const s = createFakeStore({
      tasks: [{ id: 1, bookId: 10, title: SECRET_TITLE, author: '作者乙' }],
    });
    const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const log = (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) =>
      logs.push({ level, message, fields });
    await runPrefetchScheduler(baseOptions(s.store, {
      selector: async () => ['https://a.example/b', 'https://b.example/b'],
      log, maxIdlePolls: 1, idlePollMs: 1,
    }));
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(SECRET_TITLE);
    expect(dump).not.toContain('作者乙');
    expect(dump).not.toContain('https://a.example');
    expect(dump).not.toContain('/b');
    expect(dump).toContain('a.example');
  });

  it('默认参数上界（2 命中 / 5min 单本）', () => {
    expect(PREFETCH_TARGET_HITS).toBe(2);
    expect(300_000).toBe(300_000);
  });
});

// 预算收尾竞态修正（watchdog = budgetMs + 1000 纯收尾余量）的 fake timers 草稿。未运行。
describe('预取调度器预算收尾（fake timers 草稿，未运行）', () => {
  it('守约 selector 到 budgetMs 返回命中：scheduler 正常 finish，不因收尾余量当预算失败', async () => {
    vi.useFakeTimers();
    try {
      const s = createFakeStore({ tasks: [task(1)] });
      let receivedBudget = -1;
      const selector = vi.fn(async (req: { budgetMs: number }, sig: AbortSignal) => {
        receivedBudget = req.budgetMs;
        // 守约：到 budgetMs 停止请求并返回预算前已验证的一命中
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, req.budgetMs);
          sig.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return ['https://grace.example/b'];
      });
      const running = runPrefetchScheduler(baseOptions(s.store, {
        selector, budgetMs: 300_000, maxTasksPerRound: 1, maxIdlePolls: 1, idlePollMs: 1,
      }));
      await vi.advanceTimersByTimeAsync(300_000); // selector 的 budget 原值到点，余量窗口内返回
      const result = await running;
      expect(result).toBe('completed');
      expect(receivedBudget).toBe(300_000); // 传给 selector 的 budget 仍是原值，不含余量
      expect(s.calls.finish).toBe(1);
      expect(s.plans.get(1)).toEqual(['https://grace.example/b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('不守约 selector 永不 settle：到 budgetMs+1000 watchdog 才 release 预算失败', async () => {
    vi.useFakeTimers();
    try {
      const s = createFakeStore({ tasks: [task(1)] });
      const selector = vi.fn((req, sig) => new Promise<string[]>(() => { void req; void sig; }));
      const running = runPrefetchScheduler(baseOptions(s.store, {
        selector, budgetMs: 300_000, maxConsecutiveFailures: 1,
      }));
      await vi.advanceTimersByTimeAsync(300_000 + 999); // 余量内还没到 watchdog：不释放
      expect(s.calls.release).toBe(0);
      await vi.advanceTimersByTimeAsync(1); // watchdog 到点
      await running;
      expect(s.releases.map(r => r.reason)).toEqual(['scan_budget_exhausted']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caller 在余量窗口内 abort：立即归还，余量 timer 被清掉不再触发', async () => {
    vi.useFakeTimers();
    try {
      const s = createFakeStore({ tasks: [task(1)] });
      const selector = vi.fn((req, sig) => new Promise<string[]>(() => { void req; void sig; }));
      const controller = new AbortController();
      const running = runPrefetchScheduler(baseOptions(s.store, {
        selector, signal: controller.signal, budgetMs: 300_000, maxConsecutiveFailures: 1,
      }));
      await vi.advanceTimersByTimeAsync(300_500); // selector 预算已过、watchdog 未到
      controller.abort(); // 按现合同立即中止，不等待余量
      const result = await running;
      expect(result).toBe('aborted');
      expect(s.releases).toEqual([{ id: 1, reason: 'aborted', retryDelayMs: undefined }]);
      // 余量 timer 已在 finally 清理：继续推进不再产生预算失败/重复 release
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.calls.release).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同步 throw 立刻收口：watchdog timer 不泄漏', async () => {
    vi.useFakeTimers();
    try {
      const s = createFakeStore({ tasks: [task(1)] });
      const selector = vi.fn(() => { throw new TypeError('sync boom'); });
      const running = runPrefetchScheduler(baseOptions(s.store, {
        selector, budgetMs: 300_000, maxConsecutiveFailures: 1,
      }));
      await running;
      expect(s.releases.every(r => r.reason === 'scan_failed')).toBe(true);
      // 若 timer 泄漏，继续推进会再触发 reject（unhandled）或重复 release
      await vi.advanceTimersByTimeAsync(300_000 + 60_000);
      expect(s.calls.release).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
