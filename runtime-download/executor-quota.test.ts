// 41-q402fix：T8 执行器的数据库配额长退避（不连库、不联网，用内存 storage 与假时钟）。
// 钉住：配额错误 → 布置冷却并抛短文案；冷却期内下一次 runOnce 先睡到期再碰库；停机可中断；
// 任务中途撞配额（worker 吞成 failed reason）同样布置冷却；恢复后补记发现时刻、回到正常节奏；
// 普通错误照旧上抛、不触发冷却。
import { describe, expect, it, vi } from 'vitest';
import { neon, neonConfig } from '@neondatabase/serverless';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike } from './executor';
import { DbQuotaExceededError } from '../src/lib/db-quota';
import type { SourceAdapter, TaskRow, WorkerStorage } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { DownloadTaskLease } from '../src/lib/download-task-queue';

const lease: DownloadTaskLease = { id: 1, leaseGeneration: 1, leaseOwner: 'owner', attemptCount: 1 };
const row: TaskRow = {
  id: 1, book_id: 1, title: '测试书', author: '佚名', status: 'running',
  source_url: 'https://book15.example/x', source_kind: 'engine', source_id: null, requested_by: 'system',
};
const github: GitHubContents = { put: async () => {}, getBytes: async () => null };
const budget: DailyBudgetLike = { async read() { return { used: 0, limit: 20 }; }, async consume() { return { allowed: true }; } };

/** 驱动对 402 实际抛出的错误（替身 fetch 回生产实测响应体；主机 .invalid 不出网）。 */
async function neon402(): Promise<Error> {
  neonConfig.fetchFunction = async () => new Response(JSON.stringify({
    message: 'Your account or project has exceeded the quota. Upgrade your plan to increase limits.',
    'neon:retryable': true,
  }), { status: 402 });
  try {
    await neon('postgresql://user:pass@db.example.invalid/neondb')`SELECT 1`;
    throw new Error('driver did not throw');
  } catch (error) {
    return error as Error;
  } finally {
    neonConfig.fetchFunction = undefined;
  }
}

function fakeStorage(over: Partial<WorkerStorage> = {}): WorkerStorage {
  return {
    claim: async () => null,
    taskRow: async () => row,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async () => true,
    defer: async () => '2026-09-24T03:15:00.000Z',
    reserveArtifactPath: async () => 1,
    registerArtifact: async () => true,
    ...over,
  } as WorkerStorage;
}

function harness(storage: WorkerStorage, adapters: SourceAdapter[] = []) {
  let t = Date.parse('2026-09-25T03:43:00.000Z');
  const sleeps: number[] = [];
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const recorded: string[] = [];
  const executor = createExecutor({
    storage, github, adapters, budget, repositoryId: 1, branch: 'main', owner: 'owner', decisions: DEFAULT_DECISIONS,
    quotaBackoffMs: 30 * 60_000,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    log: (level, message, fields) => { logs.push({ level, message, fields }); },
    recordQuotaSeen: async (at) => { recorded.push(at); },
  });
  return { executor, sleeps, logs, recorded, advance: (ms: number) => { t += ms; } };
}

describe('T8 执行器：数据库配额长退避', () => {
  it('claim 撞 402 ⇒ 抛 DbQuotaExceededError（短文案，原文只在 cause）+ 一行结构化日志', async () => {
    const quota = await neon402();
    const h = harness(fakeStorage({ claim: async () => { throw quota; } }));
    const error = await h.executor.runOnce().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DbQuotaExceededError);
    expect((error as Error).message).toBe('database quota exceeded');
    expect((error as Error).cause).toBe(quota);
    const line = h.logs.find(l => l.fields?.reason === 'db_quota_exceeded');
    expect(line?.level).toBe('error');
    expect(line?.fields).toEqual({
      reason: 'db_quota_exceeded', where: 'run', backoffMs: 1_800_000, retryAt: '2026-09-25T04:13:00.000Z',
    });
    expect(JSON.stringify(h.logs)).not.toMatch(/Upgrade|HTTP status/); // 日志不带驱动原文
  });

  it('冷却期内下一次 runOnce 先睡满剩余冷却再碰库（而非按 drain 60s 节奏）', async () => {
    const quota = await neon402();
    const claim = vi.fn(async () => { throw quota; });
    const h = harness(fakeStorage({ claim }));
    await expect(h.executor.runOnce()).rejects.toBeInstanceOf(DbQuotaExceededError);
    h.advance(60_000); // drain 的 errorBackoffMs
    await expect(h.executor.runOnce()).rejects.toBeInstanceOf(DbQuotaExceededError);
    expect(h.sleeps).toEqual([30 * 60_000 - 60_000]);
    expect(claim).toHaveBeenCalledTimes(2); // 31 分钟里只碰库两次（原 60s 节奏为 31 次）
  });

  it('停机：冷却等待中 signal 中止 ⇒ 不碰库，返回 NO_TASK', async () => {
    const quota = await neon402();
    const claim = vi.fn(async () => { throw quota; });
    const controller = new AbortController();
    const executor = createExecutor({
      storage: fakeStorage({ claim }), github, adapters: [], budget, repositoryId: 1, branch: 'main', owner: 'owner',
      sleep: async () => { controller.abort(); },
    });
    await expect(executor.runOnce()).rejects.toBeInstanceOf(DbQuotaExceededError);
    expect(await executor.runOnce(controller.signal)).toBe(DEFAULT_DECISIONS.NO_TASK);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('真实 abortableSleep（缺省注入）遇 signal 中止立即返回，不等满 30 分钟', async () => {
    const quota = await neon402();
    const executor = createExecutor({
      storage: fakeStorage({ claim: async () => { throw quota; } }),
      github, adapters: [], budget, repositoryId: 1, branch: 'main', owner: 'owner',
    });
    await expect(executor.runOnce()).rejects.toBeInstanceOf(DbQuotaExceededError);
    const controller = new AbortController();
    const pending = executor.runOnce(controller.signal);
    controller.abort();
    expect(await pending).toBe(DEFAULT_DECISIONS.NO_TASK);
  });

  it('恢复：冷却后碰库成功 ⇒ 记恢复日志、补记发现时刻一次，之后回到正常节奏（不再睡）', async () => {
    const quota = await neon402();
    let down = true;
    const claim = vi.fn(async () => { if (down) throw quota; return null; });
    const h = harness(fakeStorage({ claim }));
    await expect(h.executor.runOnce()).rejects.toBeInstanceOf(DbQuotaExceededError);
    down = false;
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.NO_TASK);
    expect(h.recorded).toEqual(['2026-09-25T03:43:00.000Z']);
    expect(h.logs.some(l => l.fields?.reason === 'db_quota_recovered')).toBe(true);
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.NO_TASK);
    expect(h.sleeps).toHaveLength(1); // 只有冷却那一次
    expect(h.recorded).toHaveLength(1); // 补记只一次
  });

  it('补记失败只记日志，不影响本轮决策', async () => {
    const quota = await neon402();
    let down = true;
    const logs: string[] = [];
    let t = 0;
    const executor = createExecutor({
      storage: fakeStorage({ claim: async () => { if (down) throw quota; return null; } }),
      github, adapters: [], budget, repositoryId: 1, branch: 'main', owner: 'owner',
      now: () => t, sleep: async (ms) => { t += ms; },
      log: (_level, _message, fields) => { logs.push(String(fields?.reason)); },
      recordQuotaSeen: async () => { throw new Error('write failed'); },
    });
    await expect(executor.runOnce()).rejects.toBeInstanceOf(DbQuotaExceededError);
    down = false;
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.NO_TASK);
    expect(logs).toContain('db_quota_record_failed');
  });

  it('任务中途撞配额（worker 吞成 failed reason 文本）⇒ TASK_DONE 且布置冷却，下一轮先睡', async () => {
    const quota = await neon402();
    const claim = vi.fn(async () => lease);
    const adapter: SourceAdapter = { kind: 'engine', async download() { throw quota; } };
    const h = harness(fakeStorage({ claim }), [adapter]);
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.logs.find(l => l.fields?.reason === 'db_quota_exceeded')?.fields?.where).toBe('task');
    await h.executor.runOnce();
    expect(h.sleeps).toEqual([30 * 60_000]);
  });

  it('普通错误照旧原样上抛，不触发冷却', async () => {
    const claim = vi.fn(async () => { throw new Error('db_down'); });
    const h = harness(fakeStorage({ claim }));
    await expect(h.executor.runOnce()).rejects.toThrow('db_down');
    await expect(h.executor.runOnce()).rejects.toThrow('db_down');
    expect(h.sleeps).toEqual([]);
    expect(h.logs.some(l => l.fields?.reason === 'db_quota_exceeded')).toBe(false);
  });
});
