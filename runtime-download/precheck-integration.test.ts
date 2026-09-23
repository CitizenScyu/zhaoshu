// 41-EXEC-SRCUNAVAIL 第二轮：扣额度前预检 = 先书源可达、后身份（整合 41-T5-IDENTITY 修订版钩子）。
// 钉住三件事（不连库、不联网）：
//   A. 身份预检的可达性判定与下载器同源同判（同一 isSourceUnavailableError、同阶段口径、外部中断不算）；
//   B. 执行器把 { ok:false, retryable } 按下载腿同一收口退避：不扣额度、不下载、同一行结构化日志；
//      shell 形态的 read()（只回 {date, used}）不会静默关掉预检；
//   C. entry 装配：默认开、DOWNLOAD_IDENTITY_PRECHECK=0 关、打包注入的 budgetLimit 补齐上限。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../src/lib/rule-engine/api';
import * as compile from '../src/lib/rule-engine/compile';
import * as parser from '../src/lib/source-parser';
import fixtures from '../src/lib/rule-engine/fixtures/smoke-174.json';
import { SourceHttpError } from '../src/lib/source-fetch';
import { SourcePolicyError } from '../src/lib/source-policy';
import { downloadBook } from '../scripts/engine-download.mjs';
import type { SourceAdapter, TaskRow, WorkerStorage } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import type { DownloadTaskLease } from '../src/lib/download-task-queue';
import { createIdentityPrecheck } from './identity-precheck';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike, type PrecheckResult } from './executor';
import { createDownloadExecutor, type RuntimeStorage } from './entry';
import { assembleEngineModules } from './engine';

const MINUTE = 60_000;
const modules = { api, compile, parser };
const BOOK = 'https://book15.net/books/details3224.html';
const builtinSource = { url: 'https://book15.net/', name: 'synthetic', searchUrl: '/search?q={{key}}', rules: {} };
const engineRules: Record<string, Record<string, string>> = {};
for (const [key, value] of Object.entries(fixtures[0].coreRules)) {
  const [group, field] = key.split('.'); (engineRules[group] ??= {})[field] = value as string;
}
const engineSource = { url: 'https://book15.net/', name: 'synthetic-engine', searchUrl: '/search?q={{key}}', rules: engineRules };
const resolveAs = (builtin: boolean) => async () => ({ source: builtin ? builtinSource : engineSource, builtin });
const UNVERIFIED = { ok: true, reason: 'identity_unverified' };
const unavailableAt = (stage: string) => ({ ok: false, reason: 'source_unavailable', retryable: true, stage });

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Stage = 'search' | 'detail';
type Transport = (url: string, opts: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) => Promise<{ url: string; text: string }>;

/** 合成 book15 页面（与 identity-precheck.test.ts 同形）；fail 指定在搜索或首个详情请求上抛错。 */
function site(fail?: { at: Stage; error: () => unknown }) {
  vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
  const calls: string[] = [];
  const title = '九鼎狂尊';
  const author = '上汤豆苗';
  const search = `<div class="list-item-panel"><h3><a href="${BOOK}">${title}</a></h3><a class="author">${author}</a></div><li itemprop="mainEntity"><a itemprop="url" href="${BOOK}"><h2 itemprop="name">${title}</h2></a><p itemprop="author">${author}</p></li>`;
  const detail = `<h1>${title}</h1><div class="d-info-panel"><a href="/author/1">${author}</a></div><meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${author}">`;
  let detailReads = 0;
  const transport: Transport = async (url, opts) => {
    calls.push(url);
    await opts.beforeRequest?.(opts.signal);
    if (url.includes('/search')) {
      if (fail?.at === 'search') throw fail.error();
      return { url, text: search };
    }
    if (url === BOOK) {
      detailReads += 1;
      if (fail?.at === 'detail' && detailReads === 1) throw fail.error();
      return { url, text: detail };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, transport, task: { id: 9, book_id: 1036, title, author, status: 'running', source_url: BOOK, source_kind: 'builtin', source_id: null, requested_by: 'system' } as TaskRow };
}

const precheckOn = (transport: unknown, builtin = true, over: Record<string, unknown> = {}) =>
  createIdentityPrecheck({ modules, resolveSource: resolveAs(builtin), transport, timeoutMs: 1000, ...over });

const connectTimeout = () => new DOMException('书源连接超时', 'ConnectTimeoutError');

describe('A. 身份预检：先书源可达、后身份（与下载器同源同判）', () => {
  it('搜索请求连接超时 ⇒ source_unavailable（search，可重试），只打一次请求', async () => {
    const s = site({ at: 'search', error: connectTimeout });
    expect(await precheckOn(s.transport)(s.task)).toEqual(unavailableAt('search'));
    expect(s.calls).toHaveLength(1);
  });

  it('详情请求 Cloudflare 522 ⇒ source_unavailable（detail）', async () => {
    const s = site({ at: 'detail', error: () => new SourceHttpError(522) });
    expect(await precheckOn(s.transport)(s.task)).toEqual(unavailableAt('detail'));
    expect(s.calls).toHaveLength(2);
  });

  it('引擎源：搜索请求 fetch failed ⇒ source_unavailable（search）', async () => {
    const s = site({ at: 'search', error: () => new TypeError('fetch failed') });
    expect(await precheckOn(s.transport, false)({ ...s.task, source_kind: 'engine' })).toEqual(unavailableAt('search'));
  });

  it('限速器熔断 ⇒ source_unavailable（熔断由连续源站失败触发）', async () => {
    const s = site({ at: 'search', error: () => Object.assign(new Error('源 book15.net 熔断中'), { name: 'CircuitOpenError' }) });
    expect(await precheckOn(s.transport)(s.task)).toEqual(unavailableAt('search'));
  });

  it('搜索 404 ⇒ 不算不可达、也不判不符：放行 identity_unverified', async () => {
    const s = site({ at: 'search', error: () => new SourceHttpError(404) });
    expect(await precheckOn(s.transport)(s.task)).toEqual(UNVERIFIED);
  });

  it('逐请求超时（与下载器 operation_timeout 同口径）⇒ 放行 identity_unverified，不判不可达', async () => {
    const hanging: Transport = async (_url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    const s = site();
    expect(await precheckOn(hanging, true, { timeoutMs: 30, budgetMs: 10_000 })(s.task)).toEqual(UNVERIFIED);
  });

  it('预检墙钟用尽时的 TimeoutError 不算书源不可达（AbortSignal.timeout 的 reason 也是 TimeoutError）', async () => {
    const hanging: Transport = async (_url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('超时', 'TimeoutError')), { once: true }));
    const s = site();
    expect(await precheckOn(hanging, true, { timeoutMs: 60_000, budgetMs: 30 })(s.task)).toEqual(UNVERIFIED);
  });

  it('drain 中途停机时的请求失败不算书源不可达', async () => {
    const controller = new AbortController();
    const stopping: Transport = async (_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(connectTimeout()), { once: true });
      setTimeout(() => controller.abort(new Error('SIGTERM')), 5);
    });
    const s = site();
    expect(await precheckOn(stopping)(s.task, controller.signal)).toEqual(UNVERIFIED);
  });

  const errors: [string, () => unknown][] = [
    ['ConnectTimeoutError', connectTimeout],
    ['TimeoutError', () => new DOMException('书源请求及正文读取超时', 'TimeoutError')],
    ['fetch failed', () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })],
    ['HTTP 500', () => new SourceHttpError(500)],
    ['HTTP 503', () => new SourceHttpError(503)],
    ['Cloudflare 522', () => new SourceHttpError(522)],
    ['CircuitOpenError', () => Object.assign(new Error('熔断中'), { name: 'CircuitOpenError' })],
    ['HTTP 404', () => new SourceHttpError(404)],
    ['HTTP 403', () => new SourceHttpError(403)],
    ['HTTP 429', () => new SourceHttpError(429)],
    ['策略拒绝', () => new SourcePolicyError('书源跳转次数超限')],
    ['未归类异常', () => new Error('boom')],
  ];
  const matrix = errors.flatMap(([name, error]) => (['search', 'detail'] as const).flatMap(stage =>
    [true, false].map(builtin => [name, stage, builtin ? 'builtin' : 'engine', error] as const)));

  it.each(matrix)('同源同判（可达性）：%s @ %s（%s）⇒ 预检可重试 ⇔ 下载器 code=2 source_unavailable 且阶段一致', async (_name, stage, kind, error) => {
    const builtin = kind === 'builtin';
    const s = site({ at: stage, error });
    const result = await precheckOn(s.transport, builtin)(s.task);
    const d = site({ at: stage, error });
    const out = mkdtempSync(join(tmpdir(), 'r2-reach-')); dirs.push(out);
    const download = await downloadBook(modules, {
      source: BOOK, title: d.task.title, author: d.task.author, out,
      'max-chapters': 20000, 'rate-ms': 0, 'timeout-ms': 1000, 'budget-ms': 60000,
    }, resolveAs(builtin), d.transport);
    const downloaderUnavailable = download.code === 2 && download.manifest.errors[0] === 'source_unavailable';
    const retryable = !result.ok && result.retryable === true;
    expect(retryable).toBe(downloaderUnavailable);
    if (retryable) expect((download.manifest as { failure_stage?: string }).failure_stage).toBe(stage);
    if (retryable) expect(result).toEqual(unavailableAt(stage));
    else expect(result).toEqual(UNVERIFIED); // 取页失败从不判身份不符
  });
});

// ---- B. 执行器：retryable 结论 ----
const lease: DownloadTaskLease = { id: 14, leaseGeneration: 2, leaseOwner: 'owner', attemptCount: 1 };
const row: TaskRow = {
  id: 14, book_id: 42, title: '希灵帝国', author: '远瞳', status: 'running',
  source_url: 'https://book15.net/books/details859.html', source_kind: 'builtin', source_id: null, requested_by: 'user',
};
const github: GitHubContents = { put: async () => {}, getBytes: async () => null };

function harness(result: PrecheckResult, options: {
  attemptCount?: number;
  defer?: () => Promise<string | null>;
  read?: () => Promise<{ used: number; limit?: number }>;
} = {}) {
  const calls: string[] = [];
  const defers: { delayMs: number; error?: string }[] = [];
  const finishes: { status: string; error?: string }[] = [];
  const refunds: string[] = [];
  const logged: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const storage = {
    claim: async () => { calls.push('claim'); return { ...lease, attemptCount: options.attemptCount ?? 1 }; },
    taskRow: async () => row,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async (_l: DownloadTaskLease, r: { status: string; error?: string }) => { calls.push(`finish:${r.status}`); finishes.push(r); return true; },
    defer: async (_l: DownloadTaskLease, input: { delayMs: number; error?: string }) => {
      calls.push('defer'); defers.push(input);
      return options.defer ? options.defer() : '2026-09-24T03:15:00.000Z';
    },
    reserveArtifactPath: async () => 1,
    registerArtifact: async () => true,
    releaseClaim: async () => { calls.push('release'); return true; },
  } as unknown as WorkerStorage & { releaseClaim: (l: DownloadTaskLease) => Promise<boolean> };
  const budget: DailyBudgetLike = {
    read: options.read ?? (async () => { calls.push('read'); return { used: 0, limit: 3 }; }),
    async consume() { calls.push('consume'); return { allowed: true, date: '2026-09-24' }; },
  };
  const adapter: SourceAdapter = { kind: 'builtin', async download() { calls.push('download'); return { kind: 'failure', code: 'x' }; } };
  const precheck = vi.fn(async () => { calls.push('precheck'); return result; });
  const executor = createExecutor({
    storage, github, adapters: [adapter], budget, repositoryId: 1, branch: 'main', owner: 'owner',
    decisions: DEFAULT_DECISIONS, precheck,
    refundBudget: async ticket => { refunds.push(ticket.key); return 'refunded'; },
    log: (level, message, fields) => { logged.push({ level, message, fields }); },
  });
  return { executor, calls, defers, finishes, refunds, logged, precheck };
}

describe('B. 执行器：预检判书源不可达 ⇒ 与下载腿同一收口，不扣额度', () => {
  const retry = (stage = 'search'): PrecheckResult => ({ ok: false, reason: 'source_unavailable', retryable: true, stage });

  it('退避放回 pending：不 consume、不下载、不退还（本就没扣），TASK_DONE，一行结构化日志', async () => {
    const h = harness(retry());
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.calls).toEqual(['claim', 'read', 'precheck', 'defer']);
    expect(h.defers).toEqual([{ delayMs: 15 * MINUTE, error: expect.stringContaining('search') }]);
    expect(h.defers[0].error).toContain('source_unavailable');
    expect(h.refunds).toEqual([]);
    expect(h.logged).toEqual([{ level: 'info', message: '书源不可达', fields: { reason: 'source_unavailable', stage: 'search', host: 'book15.net', retryAt: '2026-09-24T03:15:00.000Z' } }]);
    const printed = JSON.stringify([h.logged, h.defers]);
    for (const secret of [row.title, row.author, 'details859', 'https://']) expect(printed).not.toContain(secret);
  });

  it('退避与下载腿共用 attempt_count 阶梯：第 3 次 ⇒ 1h', async () => {
    const h = harness(retry('detail'), { attemptCount: 3 });
    await h.executor.runOnce();
    expect(h.defers.map(d => d.delayMs)).toEqual([60 * MINUTE]);
  });

  it('第 16 次仍不可达 ⇒ partial 终态（不再退避），日志 retryAt=null', async () => {
    const h = harness(retry(), { attemptCount: 16 });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.calls).toEqual(['claim', 'read', 'precheck', 'finish:partial']);
    expect(h.finishes[0].error).toContain('source_unavailable');
    expect(h.logged.map(line => line.fields?.retryAt)).toEqual([null]);
  });

  it('退避写库失败 ⇒ 退回 pending 后上抛（交 drain 退避），不扣额度', async () => {
    const h = harness(retry(), { defer: async () => { throw new Error('db_down'); } });
    await expect(h.executor.runOnce()).rejects.toThrow('db_down');
    expect(h.calls).toEqual(['claim', 'read', 'precheck', 'defer', 'release']);
  });

  it('退避时租约已失 ⇒ TASK_DONE、不扣额度、不打书源不可达日志', async () => {
    const h = harness(retry(), { defer: async () => null });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.calls).toEqual(['claim', 'read', 'precheck', 'defer']);
    expect(h.logged).toEqual([{ level: 'info', message: '扣额度前预检收口时租约已失', fields: { taskId: 14 } }]);
  });

  it('阶段不是固定小写码 ⇒ 记成 unknown（上游文本进不了库与日志）', async () => {
    const h = harness(retry('search<script>'));
    await h.executor.runOnce();
    expect(h.logged[0].fields?.stage).toBe('unknown');
    expect(h.defers[0].error).toContain('unknown');
  });

  it('shell 形态的 read()（只回 {date, used}，不含上限）⇒ 照跑预检，不被静默关掉', async () => {
    const h = harness({ ok: false, reason: 'identity_mismatch' }, { read: async () => ({ date: '2026-09-24', used: 3 }) as never });
    expect(await h.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(h.precheck).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['claim', 'precheck', 'finish:failed']);
  });

  it('上限为 0（DOWNLOAD_DAILY_BOOK_LIMIT=0）⇒ 视为已满，不预检', async () => {
    const h = harness({ ok: false, reason: 'identity_mismatch' }, { read: async () => ({ used: 0, limit: 0 }) });
    await h.executor.runOnce();
    expect(h.precheck).not.toHaveBeenCalled();
  });
});

// ---- C. entry 装配 ----
describe('C. entry 装配：默认开、env 关、打包注入上限', () => {
  async function wired(env: Record<string, string>, used: number, budgetLimit?: number) {
    const calls: string[] = [];
    const logged: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const storage = {
      claim: async () => { calls.push('claim'); return lease; },
      taskRow: async () => row,
      heartbeat: async () => true,
      progress: async () => true,
      finish: async () => { calls.push('finish'); return true; },
      defer: async () => { calls.push('defer'); return '2026-09-24T03:15:00.000Z'; },
      reserveArtifactPath: async () => 1,
      registerArtifact: async () => true,
      releaseClaim: async () => { calls.push('release'); return true; },
    } as unknown as RuntimeStorage;
    // shell daily-budget.mjs 的真实形态：read() 只回 {date, used}；consume() 回 {allowed, date, used, limit}。
    const shellBudget = {
      read: async () => { calls.push('read'); return { date: '2026-09-24', used }; },
      consume: async () => { calls.push('consume'); return { allowed: false, date: '2026-09-24', used, limit: 3 }; },
    } as unknown as DailyBudgetLike;
    const transport = (async (url: string) => { calls.push(`GET ${new URL(url).pathname}`); throw connectTimeout(); }) as never;
    const adapter: SourceAdapter = { kind: 'builtin', async download() { calls.push('download'); return { kind: 'failure', code: 'x' }; } };
    const executor = await createDownloadExecutor({
      budget: shellBudget, budgetLimit, workDir: 'unused', env: env as NodeJS.ProcessEnv, storage, github,
      modules: assembleEngineModules(),
      resolveSource: async () => ({ source: { url: 'https://book15.net/', name: 'book15.net', searchUrl: 'https://book15.net/books/search.html?kw={{key}}', rules: {} }, builtin: true }),
      transport, adapters: [adapter], repositoryId: 1, branch: 'main', owner: 'owner',
      log: (level, message, fields) => { logged.push({ level, message, fields }); },
    });
    return { executor, calls, logged };
  }

  it('默认开：扣额度前先打搜索页，书源不可达 ⇒ 退避、不 consume', async () => {
    const w = await wired({}, 0, 3);
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(w.calls).toEqual(['claim', 'read', 'GET /books/search.html', 'defer']);
    expect(w.logged.find(line => line.message === '执行器装配完成')?.fields?.identityPrecheck).toBe(true);
  });

  it('DOWNLOAD_IDENTITY_PRECHECK=0 ⇒ 不预检（不读额度、不发请求），回到第一轮行为', async () => {
    const w = await wired({ DOWNLOAD_IDENTITY_PRECHECK: '0' }, 0, 3);
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.BUDGET_EXHAUSTED);
    expect(w.calls).toEqual(['claim', 'consume', 'release']);
    expect(w.logged.find(line => line.message === '执行器装配完成')?.fields?.identityPrecheck).toBe(false);
  });

  it('打包注入 budgetLimit：当日已满 ⇒ 不预检、不发请求（防 drain 每 45s 空打源站）', async () => {
    const w = await wired({}, 3, 3);
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.BUDGET_EXHAUSTED);
    expect(w.calls).toEqual(['claim', 'read', 'consume', 'release']);
  });

  it('缺 budgetLimit ⇒ 上限未知照跑预检，并在装配时报错提示', async () => {
    const w = await wired({}, 3, undefined);
    await w.executor.runOnce();
    expect(w.calls).toContain('GET /books/search.html');
    expect(w.logged.some(line => line.level === 'error' && line.message.includes('日预算上限未接线'))).toBe(true);
  });
});
