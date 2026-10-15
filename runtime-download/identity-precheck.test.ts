// 41-T5-IDENTITY：身份预检钩子（真 source-parser / 规则引擎 + 真 identityMatches，合成 book15 页面，离线）。
// 核心不变量（同源同判）：预检拦截 ⇔ downloadBook 在同一源上以 identity_mismatch_or_no_candidate 失败。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../src/lib/rule-engine/api';
import * as compile from '../src/lib/rule-engine/compile';
import * as parser from '../src/lib/source-parser';
import fixtures from '../src/lib/rule-engine/fixtures/smoke-174.json';
import { downloadBook } from '../scripts/engine-download.mjs';
import { createIdentityPrecheck } from './identity-precheck';
import type { TaskRow } from '../src/lib/download-worker';

const modules = { api, compile, parser };
const BOOK = 'https://book15.net/books/details3224.html';
const builtinSource = { url: 'https://book15.net/', name: 'synthetic', searchUrl: '/search?q={{key}}', rules: {} };
const engineRules: Record<string, Record<string, string>> = {};
for (const [key, value] of Object.entries(fixtures[0].coreRules)) {
  const [group, field] = key.split('.'); (engineRules[group] ??= {})[field] = value as string;
}
const engineSource = { url: 'https://book15.net/', name: 'synthetic-engine', searchUrl: '/search?q={{key}}', rules: engineRules };
const resolveAs = (builtin: boolean) => async () => ({ source: builtin ? builtinSource : engineSource, builtin });

const MISMATCH = { ok: false, reason: 'identity_mismatch' };
const MATCH = { ok: true };
const UNVERIFIED = { ok: true, reason: 'identity_unverified' };

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function task(title: string, author: string): TaskRow {
  return { id: 9, book_id: 1036, title, author, status: 'running', source_url: BOOK, source_kind: 'builtin', source_id: null, requested_by: 'system' };
}

/** 合成源站：详情页作者 = pageAuthor。hits=false 时搜索无结果。bareDetail=true 时详情页无书名/作者规则（kxdu 形态）。 */
function site(title: string, pageAuthor: string, { hits = true, detailError = false, bareDetail = false } = {}) {
  vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
  const calls: string[] = [];
  const search = hits
    ? `<div class="list-item-panel"><h3><a href="${BOOK}">${title}</a></h3><a class="author">${pageAuthor}</a></div><li itemprop="mainEntity"><a itemprop="url" href="${BOOK}"><h2 itemprop="name">${title}</h2></a><p itemprop="author">${pageAuthor}</p></li>`
    : '<div class="empty">没有找到</div>';
  const detail = bareDetail
    ? '<div class="d-info-panel"><p>简介…</p></div>'
    : `<h1>${title}</h1><div class="d-info-panel"><a href="/author/1">${pageAuthor}</a></div><meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${pageAuthor}">`;
  const transport = async (url: string, opts: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) => {
    calls.push(url);
    await opts.beforeRequest?.(opts.signal);
    if (url.includes('/search')) return { url, text: search };
    if (url === BOOK) {
      if (detailError) throw new Error('ECONNRESET');
      return { url, text: detail };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, transport };
}

const precheckFor = (transport: unknown, over: Record<string, unknown> = {}) =>
  createIdentityPrecheck({ modules, resolveSource: resolveAs(true), transport, timeoutMs: 1000, ...over });

async function downloadError(transport: Parameters<typeof downloadBook>[3], t: TaskRow, builtin: boolean): Promise<string | undefined> {
  const out = mkdtempSync(join(tmpdir(), 't5id-')); dirs.push(out);
  const result = await downloadBook(modules, {
    source: t.source_url, title: t.title, author: t.author, out,
    'max-chapters': 20000, 'rate-ms': 0, 'timeout-ms': 1000, 'budget-ms': 60000,
  }, resolveAs(builtin), transport);
  return result.manifest.errors[0];
}

describe('41-T5-IDENTITY 身份预检钩子', () => {
  it.each(['HOST_OCCUPIED', 'HOST_OCCUPANCY_UNAVAILABLE'])('物理占位门 %s 不吞成 identity_unverified', async code => {
    const error = Object.assign(new Error('synthetic gate rejection'), { code });
    const transport = async () => { throw error; };
    await expect(precheckFor(transport)(task('测试书', '测试作者'), new AbortController().signal))
      .rejects.toBe(error);
  });

  it('caller abort 优先于迟到占位门错误', async () => {
    const controller = new AbortController();
    const error = new Error('synthetic cancellation');
    const transport = async () => {
      controller.abort(error);
      throw Object.assign(new Error('synthetic gate'), { code: 'HOST_OCCUPANCY_UNAVAILABLE' });
    };
    await expect(precheckFor(transport)(task('测试书', '测试作者'), controller.signal)).rejects.toBe(error);
  });
  it('名单作者 ≠ 源站作者（生产实例：九鼎狂尊 上汤豆苗 vs 孤神枫）⇒ {ok:false, identity_mismatch}，只打搜索+详情两次', async () => {
    const s = site('九鼎狂尊', '孤神枫');
    expect(await precheckFor(s.transport)(task('九鼎狂尊', '上汤豆苗'))).toEqual(MISMATCH);
    expect(s.calls).toHaveLength(2);
  });

  it('作者对得上（活着 / 余华）⇒ {ok:true}', async () => {
    const s = site('活着', '余华');
    expect(await precheckFor(s.transport)(task('活着', '余华'))).toEqual(MATCH);
  });

  it.each([
    ['首尾半角空格', '余华 ', '余华'],
    ['全角字母 + 大小写', 'Ｍａｘｗｅｌｌ', 'maxwell'],
  ])('canonicalBookKey 归一差异（%s）⇒ 视为对得上', async (_label, taskAuthor, pageAuthor) => {
    const s = site('活着', pageAuthor);
    expect(await precheckFor(s.transport)(task('活着', taskAuthor))).toEqual(MATCH);
  });

  // 41-IDLENIENT：判据与阅读器 sourceBookMatches 同口径，站点作者字段的已知修饰要剥掉。
  it('站点作者带「著」修饰（book.qq 形态：忘语 著）⇒ 视为对得上', async () => {
    const s = site('凡人修仙传', '忘语 著');
    expect(await precheckFor(s.transport)(task('凡人修仙传', '忘语'))).toEqual(MATCH);
  });

  it('详情页无书名/作者规则（kxdu 形态：detail={}）⇒ 回落到搜索候选行判等', async () => {
    const s = site('盗墓笔记', '南派三叔', { bareDetail: true });
    const precheck = createIdentityPrecheck({ modules, resolveSource: resolveAs(false), transport: s.transport, timeoutMs: 1000 });
    expect(await precheck({ ...task('盗墓笔记', '南派三叔'), source_kind: 'engine' })).toEqual(MATCH);
  });

  it('详情页无书名/作者规则但搜索候选作者不符 ⇒ 仍拦截', async () => {
    const s = site('盗墓笔记', '旁人甲', { bareDetail: true });
    const precheck = createIdentityPrecheck({ modules, resolveSource: resolveAs(false), transport: s.transport, timeoutMs: 1000 });
    expect(await precheck({ ...task('盗墓笔记', '南派三叔'), source_kind: 'engine' })).toEqual(MISMATCH);
  });

  it('源站搜不到同名书 ⇒ 拦截（下载器同样判 no_candidate）', async () => {
    const s = site('九鼎狂尊', '孤神枫', { hits: false });
    expect(await precheckFor(s.transport)(task('九鼎狂尊', '上汤豆苗'))).toEqual(MISMATCH);
  });

  it('详情页取不到（网络错误）⇒ 放行 identity_unverified，不判不符', async () => {
    const s = site('九鼎狂尊', '孤神枫', { detailError: true });
    expect(await precheckFor(s.transport)(task('九鼎狂尊', '上汤豆苗'))).toEqual(UNVERIFIED);
  });

  it('源解析失败（引擎池不可用 code=2）⇒ 放行，一个请求都不发', async () => {
    const s = site('九鼎狂尊', '孤神枫');
    const unavailable = async () => { throw Object.assign(new Error('engine_source_pool_unavailable'), { code: 2 }); };
    const precheck = createIdentityPrecheck({ modules, resolveSource: unavailable, transport: s.transport });
    expect(await precheck(task('九鼎狂尊', '上汤豆苗'))).toEqual(UNVERIFIED);
    expect(s.calls).toEqual([]);
  });

  it('源站挂起 ⇒ 预检墙钟用尽后放行（不拖到租约回收）', async () => {
    const hanging = async (_url: string, opts: { signal: AbortSignal }) =>
      new Promise<{ url: string; text: string }>((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    expect(await precheckFor(hanging, { budgetMs: 50, timeoutMs: 60000 })(task('九鼎狂尊', '上汤豆苗'))).toEqual(UNVERIFIED);
  });

  it('drain 已停机 ⇒ 上抛原中止原因，一个请求都不发', async () => {
    const s = site('九鼎狂尊', '孤神枫');
    const controller = new AbortController();
    const reason = new Error('synthetic cancellation');
    controller.abort(reason);
    await expect(precheckFor(s.transport)(task('九鼎狂尊', '上汤豆苗'), controller.signal)).rejects.toBe(reason);
    expect(s.calls).toEqual([]);
  });

  it.each([
    ['作者不符', '孤神枫', '上汤豆苗', MISMATCH],
    ['作者相符', '余华', '余华', MATCH],
  ])('引擎源（规则编译 + engineSearchBook/engineFetchDetail）：%s', async (_label, pageAuthor, taskAuthor, expected) => {
    const s = site('九鼎狂尊', pageAuthor);
    const precheck = createIdentityPrecheck({ modules, resolveSource: resolveAs(false), transport: s.transport, timeoutMs: 1000 });
    expect(await precheck({ ...task('九鼎狂尊', taskAuthor), source_kind: 'engine' })).toEqual(expected);
  });

  it.each([
    ['builtin 作者不符', true, '九鼎狂尊', '孤神枫', '上汤豆苗', true],
    ['builtin 搜不到', true, '九鼎狂尊', null, '上汤豆苗', true],
    ['builtin 作者相符', true, '活着', '余华', '余华', false],
    ['builtin 归一后相符', true, '活着', '余华', '余华 ', false],
    ['引擎 作者不符', false, '九鼎狂尊', '孤神枫', '上汤豆苗', true],
    ['引擎 作者相符', false, '九鼎狂尊', '余华', '余华', false],
  ])('同源同判：%s 时预检与 downloadBook 结论一致', async (_label, builtin, title, pageAuthor, taskAuthor, rejected) => {
    const s = site(title, pageAuthor ?? '孤神枫', { hits: pageAuthor !== null });
    const t = task(title, taskAuthor);
    const precheck = createIdentityPrecheck({ modules, resolveSource: resolveAs(builtin), transport: s.transport, timeoutMs: 1000 });
    const result = await precheck(t);
    const error = await downloadError(s.transport, t, builtin);
    expect(result.ok).toBe(!rejected);
    expect(error === 'identity_mismatch_or_no_candidate').toBe(rejected);
  });

  // authbridge42：镜像站按通行书名收录，标题搜索空、作者名才搜得到（书名 0 候选的结构性根因）。
  // 这一组钉「补搜接线 + B′ 门」（主会话 2026-10-15 裁定：作者门逐字过 且 候选去重后恰好 1 条）。
  describe('authbridge42 作者名回退轮', () => {
    /** 标题搜索空、作者搜索才有结果。pageTitle 可与任务书名不同（通行名形态）。 */
    function bridgeSite(author: string, pageTitle: string) {
      return bridgeSiteMulti(author, [pageTitle]);
    }

    /** 同上，但作者搜索返回多本书（各占一个详情 URL）。 */
    function bridgeSiteMulti(author: string, pageTitles: string[]) {
      vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
      const calls: string[] = [];
      const bookUrl = (n: number) => `https://book15.net/books/details${n}.html`;
      const row = (title: string, url: string) =>
        `<div class="list-item-panel"><h3><a href="${url}">${title}</a></h3><a class="author">${author}</a></div>`
        + `<li itemprop="mainEntity"><a itemprop="url" href="${url}"><h2 itemprop="name">${title}</h2></a><p itemprop="author">${author}</p></li>`;
      const found = pageTitles.map((t, i) => row(t, bookUrl(i + 1))).join('');
      const detailOf = (url: string) => {
        const n = Number(/details(\d+)\.html$/.exec(url)?.[1] ?? '1') - 1;
        const title = pageTitles[n] ?? pageTitles[0];
        return `<h1>${title}</h1><div class="d-info-panel"><a href="/author/1">${author}</a></div>`
          + `<meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="${author}">`;
      };
      const transport = async (url: string) => {
        calls.push(url);
        if (url.includes('/search')) {
          const key = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
          return { url, text: key === author && pageTitles.length ? found : '<div class="empty">没有找到</div>' };
        }
        if (/^https:\/\/book15\.net\/books\/details\d+\.html$/.test(url)) return { url, text: detailOf(url) };
        throw new Error(`unexpected url ${url}`);
      };
      return {
        calls, transport,
        searches: () => calls.filter(url => url.includes('/search')),
        detailReads: () => calls.filter(url => !url.includes('/search')),
      };
    }

    it.each([true, false])('builtin=%s 标题搜空时补搜作者名，详情门对上即 ok（两轮搜索各一次）', async builtin => {
      const s = bridgeSite('测试作者', '测试书');
      const precheck = createIdentityPrecheck({ modules, resolveSource: resolveAs(builtin), transport: s.transport, timeoutMs: 1000 });
      expect(await precheck({ ...task('测试书', '测试作者'), source_kind: builtin ? 'builtin' : 'engine' })).toEqual(MATCH);
      expect(s.searches()).toHaveLength(2);
    });

    it('别名桥接（authbridge42 核心价值）：书名搜空 + 作者轮唯一候选作者门过 ⇒ ok', async () => {
      // 实测形态（authbridge42-probe：leesven.com/leebook/4877.html）：og:novel:book_name=帝临鸿蒙、
      // og:novel:author=为尹染墨红尘、全文无「原书名」⇒ 无 alias ⇒ sourceBookMatches 书名门不过，
      // 靠 B′ 门的作者门 + 唯一性认出来——这正是 0 候选率 96.6% 的结构性修复点。
      const s = bridgeSite('为尹染墨红尘', '帝临鸿蒙');
      expect(await precheckFor(s.transport)(task('少年羽皇', '为尹染墨红尘'))).toEqual(MATCH);
      expect(s.searches()).toHaveLength(2);
    });

    it('作者轮候选 >1（同作者多本）判 mismatch，且唯一性先于详情：不抓详情', async () => {
      const s = bridgeSiteMulti('魏风华', ['诡事录1', '诡事录2', '诡事录3']);
      expect(await precheckFor(s.transport)(task('大唐神探之长安诡案', '魏风华'))).toEqual(MISMATCH);
      expect(s.searches()).toHaveLength(2);
      expect(s.detailReads()).toHaveLength(0);
    });

    it('作者归一后为空（缺失/佚名/未知）不补搜：搜索只打一次', async () => {
      for (const author of ['', '佚名', '未知', '未知作者']) {
        const s = bridgeSite(author, '测试书');
        expect(await precheckFor(s.transport)(task('测试书', author))).toEqual(MISMATCH);
        expect(s.searches()).toHaveLength(1);
      }
    });

    it('作者与书名同键不补搜：标题轮自己就够，补搜等于把同一个搜索再发一遍', async () => {
      const s = bridgeSite('测试书', '测试书');
      expect(await precheckFor(s.transport)(task('测试书', '测试书'))).toEqual(MATCH);
      expect(s.searches()).toHaveLength(1);
    });
  });
});
