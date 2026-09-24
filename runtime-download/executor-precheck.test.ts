// 41-T5-IDENTITY：执行器「扣额度前预检」钩子契约（不连库、不联网，内存 storage/budget/adapter）。
// 顺序钉死为 claim → 读额度 → 预检 → consume → 下载；{ok:false} ⇒ 落 failed(reason) 终态、不扣额度、不下载；
// {ok:true, reason} 与预检抛错 ⇒ 放行（fail-open）；额度已满 ⇒ 不预检（不给源站白打请求）。
import { describe, expect, it, vi } from 'vitest';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike, type PrecheckResult } from './executor';
import type { SourceAdapter, TaskRow, WorkerStorage } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { DownloadTaskLease } from '../src/lib/download-task-queue';

const lease: DownloadTaskLease = { id: 9, leaseGeneration: 1, leaseOwner: 'owner', attemptCount: 1 };
const row: TaskRow = {
  id: 9, book_id: 1036, title: '九鼎狂尊', author: '上汤豆苗', status: 'running',
  source_url: 'https://book15.net/books/details3224.html', source_kind: 'builtin', source_id: null, requested_by: 'system',
};
const github: GitHubContents = { put: async () => {}, getBytes: async () => null };

function harness(result: PrecheckResult | Error | null, options: { used?: number; allowed?: boolean; storage?: Partial<WorkerStorage> } = {}) {
  const log: string[] = [];
  const logged: { message: string; fields?: Record<string, unknown> }[] = [];
  const storage = {
    claim: async () => { log.push('claim'); return lease; },
    taskRow: async () => row,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async (_l: DownloadTaskLease, r: { status: string; error?: string }) => { log.push(`finish:${r.status}:${r.error}`); return true; },
    defer: async () => { log.push('defer'); return '2026-09-24T03:15:00.000Z'; },
    reserveArtifactPath: async () => 1,
    registerArtifact: async () => true,
    releaseClaim: async () => { log.push('release'); return true; },
    ...options.storage,
  } as WorkerStorage & { releaseClaim: (l: DownloadTaskLease) => Promise<boolean> };
  const budget: DailyBudgetLike = {
    async read() { log.push('read'); return { used: options.used ?? 0, limit: 3 }; },
    async consume() { log.push('consume'); return { allowed: options.allowed ?? true }; },
  };
  const adapter: SourceAdapter = { kind: 'builtin', async download() { log.push('download'); return { kind: 'failure', code: 'x' }; } };
  const precheck = result === null ? undefined : vi.fn<(task: TaskRow, signal?: AbortSignal) => Promise<PrecheckResult>>(async () => {
    log.push('precheck');
    if (result instanceof Error) throw result;
    return result;
  });
  const executor = createExecutor({
    storage, github, adapters: [adapter], budget, repositoryId: 1, branch: 'main', owner: 'owner',
    decisions: DEFAULT_DECISIONS, precheck, log: (_level, message, fields) => { logged.push({ message, fields }); },
  });
  return { executor, log, logged, precheck };
}

describe('41-T5-IDENTITY 扣额度前预检钩子', () => {
  it('{ok:false, reason:identity_mismatch} ⇒ 落 failed(identity_mismatch)，不扣额度、不下载，决策 TASK_DONE', async () => {
    const h = harness({ ok: false, reason: 'identity_mismatch' });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'read', 'precheck', 'finish:failed:identity_mismatch']);
  });

  it('{ok:true} ⇒ 与引入前同一路径：consume → 下载', async () => {
    const h = harness({ ok: true });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'read', 'precheck', 'consume', 'download', 'finish:failed:x']);
    expect(h.logged).toEqual([]);
  });

  it('{ok:true, reason}（预检无结论）⇒ 放行下载，并记一行只含原因码的日志', async () => {
    const h = harness({ ok: true, reason: 'identity_unverified' });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'read', 'precheck', 'consume', 'download', 'finish:failed:x']);
    expect(h.logged.map(line => line.fields)).toEqual([{ taskId: 9, reason: 'identity_unverified' }]);
  });

  it('预检自身抛错 ⇒ 按无结论放行（fail-open），不上抛', async () => {
    const h = harness(new Error('precheck_bug'));
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'read', 'precheck', 'consume', 'download', 'finish:failed:x']);
  });

  it('今日额度已满 ⇒ 不跑预检（不给源站白打请求），照旧 consume 拒绝 → 退回 pending，BUDGET_EXHAUSTED', async () => {
    const h = harness({ ok: false, reason: 'identity_mismatch' }, { used: 3, allowed: false });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.BUDGET_EXHAUSTED);
    expect(h.log).toEqual(['claim', 'read', 'consume', 'release']);
    expect(h.precheck).not.toHaveBeenCalled();
  });

  it('预检放行但 consume 拒绝 ⇒ 退回 pending，BUDGET_EXHAUSTED（原语义不变）', async () => {
    const h = harness({ ok: true }, { allowed: false });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.BUDGET_EXHAUSTED);
    expect(h.log).toEqual(['claim', 'read', 'precheck', 'consume', 'release']);
  });

  it('未注入预检 ⇒ 行为与引入前逐字一致（不读额度、不读任务行）', async () => {
    const h = harness(null);
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'consume', 'download', 'finish:failed:x']);
  });

  it('读额度或任务行失败 ⇒ 退回 pending 后上抛（交 drain 退避），不扣额度', async () => {
    const h = harness({ ok: false, reason: 'identity_mismatch' }, { storage: { taskRow: async () => { throw new Error('db_down'); } } });
    await expect(h.executor.runOnce()).rejects.toThrow('db_down');
    expect(h.log).toEqual(['claim', 'read', 'release']);
  });

  it('拦截但终态写失败 ⇒ 退回 pending 后上抛，不把任务搁在 running', async () => {
    const h = harness({ ok: false, reason: 'identity_mismatch' }, { storage: { finish: async () => { throw new Error('db_down'); } } });
    await expect(h.executor.runOnce()).rejects.toThrow('db_down');
    expect(h.log).toEqual(['claim', 'read', 'precheck', 'release']);
  });

  it('reason 不是合规原因码 ⇒ 库里与日志只记 precheck_rejected，原文不落盘', async () => {
    const h = harness({ ok: false, reason: `作者不符：${row.author}` });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.log).toEqual(['claim', 'read', 'precheck', 'finish:failed:precheck_rejected']);
    expect(JSON.stringify(h.logged)).not.toContain(row.author);
  });

  it('日志只带任务 id 与原因码，不含书名、作者、URL', async () => {
    const h = harness({ ok: false, reason: 'identity_mismatch' });
    await h.executor.runOnce();
    expect(h.logged.map(line => line.fields)).toEqual([{ taskId: 9, reason: 'identity_mismatch', written: true }]);
    const text = JSON.stringify(h.logged);
    for (const secret of [row.title, row.author, 'book15.net', 'https://']) expect(text).not.toContain(secret);
  });

  it('预检拿到的是 drain 的停机信号', async () => {
    const h = harness({ ok: true });
    const controller = new AbortController();
    await h.executor.runOnce(controller.signal);
    expect(h.precheck?.mock.calls[0]?.[1]).toBe(controller.signal);
  });
});
