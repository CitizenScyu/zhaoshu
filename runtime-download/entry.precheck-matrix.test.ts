// wrapcove41：entry 装配层 identityPrecheck × fallback 四组合矩阵端到端（审查遗留 F4 follow-up）。
// 缺口背景：wrapPrecheck / wrapAdapter / HOST_OCCUPIED 各缝已在 builtin-fallback.test.ts、
// precheck-integration.test.ts、entry.host-occupancy.test.ts 有缝级覆盖，但没有任何用例断言
// 「四种 env 组合下 createDownloadExecutor 的装配产物真的是预期形态」。本文件经真实装配
// （不 vi.mock 任何模块，注入边界桩：modules/resolveSource/transport/loadEnginePool/engineDownload/
// storage/github）跑 executor.runOnce 验证：
//   1. 预检关 + fallback 关 → 装配日志 identityPrecheck:false engineFallback:false，任务直走原腿；
//   2. 预检开 + fallback 关 → identityPrecheck:true engineFallback:false，source_unavailable 按原语义
//      退避（不换源、不扣额度、不下载）；
//   3. 预检关 + fallback 开 → identityPrecheck:false engineFallback:true，wrapPrecheck 不装配（零预检
//      请求）但 wrapAdapter 腿照包（原腿 identity 失败 → 扫池 → 引擎候选下载收口）；
//   4. 预检开 + fallback 开（生产现形态）→ wrapped 链真实生效：预检阶段 identity_mismatch 被拦下并
//      经 entry 装配的真实组装走引擎候选选源（非直接调 wrapPrecheck）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDownloadExecutor, type ProductionExecutorOptions, type RuntimeStorage } from './entry';
import type { EngineDownloadLike, TaskRow } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import { DEFAULT_DECISIONS, type DailyBudgetLike } from './executor';
import type { SourceTransport } from './engine';

const MINUTE = 60_000;
const TXT = '整本合成正文';
const ORIGIN = 'https://book15.net/books/details859.html';
const SEARCH_URL = 'https://book15.net/search?q=synthetic';
const POOL = [
  { url: 'https://a.example/', name: 'a', searchUrl: '/s' },
  { url: 'https://b.example/', name: 'b', searchUrl: '/s' },
];

const lease = { id: 14, leaseGeneration: 2, leaseOwner: 'owner', attemptCount: 1 };
const row: TaskRow = {
  id: 14, book_id: 42, title: '测试书', author: '上汤豆苗', status: 'running',
  source_url: ORIGIN, source_kind: 'builtin', source_id: null, requested_by: 'user',
};

class MemoryGitHub implements GitHubContents {
  puts: string[] = [];
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.puts.push(path); this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

type LogLine = { level: string; message: string; fields?: Record<string, unknown> };

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * 装配矩阵 harness：全部生产模块真实（createIdentityPrecheck/createBuiltinFallback/createEngineAdapter/
 * createExecutor/createDownloadExecutor），只注入边界桩。sql 不注入 ⇒ 无 hostOccupancy、无候选持久化
 * 接缝（fallback 回到内存单槽形态——planned 候选由 wrapPrecheck → wrapAdapter 同实例传递）。
 * transportMode：'serve' 出合成搜索/详情页（详情作者与任务不符 ⇒ 预检判 identity_mismatch）；
 * 'dead' 搜索请求抛 ConnectTimeoutError ⇒ 预检判 source_unavailable（search）。
 */
async function rig(env: Record<string, string>, transportMode: 'serve' | 'dead', book15: 'complete' | 'identity-miss' | 'forbidden') {
  const calls: string[] = [];
  const logged: LogLine[] = [];
  const defers: { delayMs: number; error?: string }[] = [];
  const finishes: { status: string; error?: string }[] = [];
  const precheckPages: string[] = [];
  const searchHosts: string[] = [];
  const downloads: string[] = [];
  const poolLoads: number[] = [];

  const storage = {
    claim: async () => { calls.push('claim'); return lease; },
    taskRow: async () => { calls.push('taskRow'); return row; },
    heartbeat: async () => true,
    progress: async () => true,
    finish: async (_l: unknown, r: { status: string; error?: string }) => { calls.push(`finish:${r.status}`); finishes.push(r); return true; },
    defer: async (_l: unknown, input: { delayMs: number; error?: string }) => { calls.push('defer'); defers.push(input); return '2026-10-15T03:15:00.000Z'; },
    reserveArtifactPath: async () => { calls.push('reserve'); return 1; },
    registerArtifact: async () => { calls.push('register'); return 'registered'; },
    releaseClaim: async () => { calls.push('release'); return true; },
  } as unknown as RuntimeStorage;

  const budget: DailyBudgetLike = {
    read: async () => { calls.push('read'); return { date: '2026-10-15', used: 0 }; },
    consume: async () => { calls.push('consume'); return { allowed: true, date: '2026-10-15', used: 1, limit: 3 }; },
  };

  const transport: SourceTransport = async (url) => {
    calls.push(`GET ${url}`);
    precheckPages.push(url);
    if (transportMode === 'dead') throw new DOMException('书源连接超时', 'ConnectTimeoutError');
    return { url, text: url.includes('/search') ? 'search-page' : 'detail-page' };
  };

  const modules = {
    compile: { compileSource: () => ({}) },
    parser: {
      sourceSearchUrl: () => SEARCH_URL,
      parseSourceSearch: () => [ORIGIN],
      parseSourceIdentity: () => ({ title: '测试书', author: '孤神枫' }), // 与任务作者不符 ⇒ identity_mismatch
    },
    supported: { BUILTIN_SOURCE_HOSTS: ['book15.net', 'www.book15.net'] },
    api: {
      engineSearchBook: async (engine: { url: string }) => {
        searchHosts.push(new URL(engine.url).hostname);
        return [{ title: '测试书', author: '上汤豆苗', bookUrl: `${engine.url}b/1` }];
      },
      engineFetchDetail: async () => ({ title: '测试书', author: '上汤豆苗' }),
    },
  };

  const resolveSource = async () => ({
    source: { url: 'https://book15.net/', name: 'book15', searchUrl: '/search?q={{key}}', rules: {} },
    builtin: true,
  });

  const loadEnginePool = async () => { poolLoads.push(1); return POOL; };

  const engineDownload: EngineDownloadLike = async (_m, args, _r, _t, hooks) => {
    const source = args.source as string;
    downloads.push(source);
    if (source.startsWith('https://book15.net/')) {
      if (book15 === 'forbidden') throw new Error('unexpected original leg download');
      if (book15 === 'identity-miss') {
        return { code: 1, manifest: { status: 'failed', errors: ['identity_mismatch_or_no_candidate'], chapters_total: 0, chapters_done: 0, chars: 0 } };
      }
    }
    const out = args.out as string;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'book.txt'), TXT);
    await hooks?.onProgress?.({ chaptersDone: 1, chaptersTotal: 1, charsTotal: TXT.length });
    return {
      code: 0,
      manifest: {
        status: 'done', errors: [], chapters_total: 1, chapters_done: 1, chars: TXT.length,
        artifact: { file: 'book.txt', sha256: 'synthetic', bytes: Buffer.byteLength(TXT, 'utf8') },
      },
    };
  };

  const workDir = mkdtempSync(join(tmpdir(), 'wrapcove41-'));
  dirs.push(workDir);
  const github = new MemoryGitHub();
  const log = (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => {
    logged.push({ level, message, fields });
  };
  const executor = await createDownloadExecutor({
    budget, budgetLimit: 3, workDir,
    env: env as NodeJS.ProcessEnv,
    storage, github, modules, resolveSource, transport, loadEnginePool, engineDownload,
    repositoryId: 1, branch: 'main', owner: 'owner',
    log,
  } as unknown as ProductionExecutorOptions);
  return { executor, calls, logged, defers, finishes, precheckPages, searchHosts, downloads, poolLoads, github };
}

describe('entry 装配矩阵：identityPrecheck × fallback 四组合（真实装配，runOnce 端到端）', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); })); });

  it('组合1 预检关 + fallback 关：装配日志双 false，任务直走原腿成功', async () => {
    const r = await rig({ DOWNLOAD_IDENTITY_PRECHECK: '0', DOWNLOAD_ENGINE_FALLBACK: '0' }, 'serve', 'complete');
    expect(await r.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const assembled = r.logged.find(line => line.message === '执行器装配完成');
    expect(assembled?.fields).toMatchObject({ identityPrecheck: false, engineFallback: false });
    // 无预检（零请求、零预算读）、无回退（零池加载）：claim → consume → 下载原腿 → 发布收口。
    expect(r.calls.filter(call => call.startsWith('GET'))).toEqual([]);
    expect(r.poolLoads).toHaveLength(0);
    expect(r.downloads).toEqual([ORIGIN]);
    expect(r.calls).toContain('consume');
    expect(r.calls).not.toContain('read');
    expect(r.finishes).toEqual([{ status: 'done', error: '' }]);
    expect(r.github.puts.length).toBeGreaterThan(0);
  });

  it('组合2 预检开 + fallback 关：source_unavailable 按原语义退避，不换源、不扣额度、不下载', async () => {
    const r = await rig({ DOWNLOAD_ENGINE_FALLBACK: '0' }, 'dead', 'complete');
    expect(await r.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const assembled = r.logged.find(line => line.message === '执行器装配完成');
    expect(assembled?.fields).toMatchObject({ identityPrecheck: true, engineFallback: false });
    expect(r.calls).toEqual(['claim', 'read', 'taskRow', `GET ${SEARCH_URL}`, 'defer']);
    expect(r.defers).toEqual([{ delayMs: 15 * MINUTE, error: expect.stringContaining('source_unavailable') }]);
    expect(r.logged).toContainEqual({ level: 'info', message: '书源不可达', fields: { reason: 'source_unavailable', stage: 'search', host: 'book15.net', retryAt: '2026-10-15T03:15:00.000Z' } });
    // 不换源：fallback 未装配，池零加载、引擎腿零调用、不扣额度、无终态写入。
    expect(r.poolLoads).toHaveLength(0);
    expect(r.downloads).toEqual([]);
    expect(r.calls).not.toContain('consume');
    expect(r.finishes).toEqual([]);
  });

  it('组合3 预检关 + fallback 开：wrapPrecheck 不装配（零预检请求），wrapAdapter 腿照包', async () => {
    const r = await rig({ DOWNLOAD_IDENTITY_PRECHECK: '0' }, 'serve', 'identity-miss');
    expect(await r.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const assembled = r.logged.find(line => line.message === '执行器装配完成');
    expect(assembled?.fields).toMatchObject({ identityPrecheck: false, engineFallback: true });
    // 预检关 ⇒ 扣额度前零请求、零预算读；回退开 ⇒ 下载腿照包：原腿先跑（identity 失败）→ 扫池 → 引擎候选收口。
    expect(r.calls.filter(call => call.startsWith('GET'))).toEqual([]);
    expect(r.calls).not.toContain('read');
    expect(r.calls).toContain('consume');
    expect(r.poolLoads).toHaveLength(1);
    expect(r.searchHosts).toEqual(['a.example', 'b.example']);
    expect(r.downloads).toEqual([ORIGIN, 'https://a.example/']);
    expect(r.finishes).toEqual([{ status: 'done', error: '' }]);
    expect(r.github.puts.length).toBeGreaterThan(0);
  });

  it('组合4 预检开 + fallback 开（生产现形态）：wrapped 链真实生效，预检 identity_mismatch 被拦下走引擎候选', async () => {
    const r = await rig({}, 'serve', 'forbidden');
    expect(await r.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const assembled = r.logged.find(line => line.message === '执行器装配完成');
    expect(assembled?.fields).toMatchObject({ identityPrecheck: true, engineFallback: true });
    // wrapPrecheck 经 entry 装配包住真实 identityPrecheck：先搜索后详情（作者不符 ⇒ identity_mismatch），
    // 再经真实 selector 扫池选好候选（a/b 两 host 早停），放行 builtin_engine_fallback。
    expect(r.precheckPages).toEqual([SEARCH_URL, ORIGIN]);
    expect(r.searchHosts).toEqual(['a.example', 'b.example']);
    expect(r.poolLoads).toHaveLength(1);
    expect(r.logged).toContainEqual(expect.objectContaining({
      level: 'info', message: '扣额度前预检未得结论，照常下载', fields: { taskId: 14, reason: 'builtin_engine_fallback' },
    }));
    // 下载腿收到 planned 候选：原腿（book15）不被触碰，引擎候选直接下载并发布收口。
    expect(r.downloads).toEqual(['https://a.example/']);
    expect(r.calls).toContain('consume');
    expect(r.finishes).toEqual([{ status: 'done', error: '' }]);
    expect(r.github.puts.length).toBeGreaterThan(0);
  });
});
