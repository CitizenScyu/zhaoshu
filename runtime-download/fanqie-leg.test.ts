// fanqie1106 番茄渠道单元层（临时目录，不连库、不联网）：匹配口径、TXT 重排、预检放行/未命中、下载成功、
// 占用排队、失败退回原腿、日额度与熔断、socket 协议。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SourceAdapter, TaskRow } from '../src/lib/download-worker';
import {
  askFanqieChannel, createFanqieLeg, createFanqieSearchFetch, fanqieDailyLimit, fanqieDir, fanqieEnabled, FANQIE_BREAKER_FAILS,
  FANQIE_BREAKER_PAUSE_MS, normalizeName, pickFanqieBook, rebuildFanqieTxt, titleKey, type FanqieReply,
} from './fanqie-leg';

const ID = '7199341816770989095';
const TASK: TaskRow = {
  id: 7, book_id: 1, title: '规则怪谈：诡异学校', author: '柒月July', status: 'running',
  source_url: 'https://book15.example/1', source_kind: 'builtin', source_id: null, requested_by: 'system',
};
const HEADER = `书籍信息\n\n书名：规则怪谈：诡异学校\n作者：柒月July\n书籍 ID：${ID}\n\n【简介】\n第1章 入学\n\n————————————————————————————————\n\n`;
const LONG = '正文'.repeat(2000);
const raw = (...chapters: string[]) => HEADER + chapters.join('\n\n') + '\n\n';
const context = () => ({ signal: new AbortController().signal, progress: async () => {} });

function setup(options: { reply?: FanqieReply | Error; search?: unknown; dailyLimit?: number; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fanqie-'));
  mkdirSync(join(dir, 'out'));
  const inner: SourceAdapter = {
    kind: 'builtin',
    download: vi.fn(async () => ({ kind: 'failure' as const, code: 'inner' })),
  };
  const innerPrecheck = vi.fn(async () => ({ ok: true as const, reason: 'inner' }));
  const fetchText = vi.fn(async (_url: string, _signal: AbortSignal) => JSON.stringify(options.search
    ?? { code: 0, data: { ret_data: [{ book_id: ID, title: TASK.title, author: TASK.author, creation_status: 0 }] } }));
  const ask = vi.fn(async () => {
    if (options.reply instanceof Error) throw options.reply;
    return options.reply ?? { rc: 0, result: { status: 'done', file: 'a.txt', titles: ['第1章 入学'], missing: 0, pua: 0, replacement: 0 } };
  });
  const leg = createFanqieLeg({ dir, fetchText, ask: ask as never, dailyLimit: options.dailyLimit, now: options.now });
  return { dir, inner, innerPrecheck, fetchText, ask, leg, adapter: leg.wrapAdapter(inner), precheck: leg.wrapPrecheck(innerPrecheck) };
}

describe('开关与目录', () => {
  it('缺省关，=1 才开', () => {
    expect(fanqieEnabled({})).toBe(false);
    expect(fanqieEnabled({ DOWNLOAD_FANQIE: '0' })).toBe(false);
    expect(fanqieEnabled({ DOWNLOAD_FANQIE: '1' })).toBe(true);
  });
  it('日额度缺省 200，非法值回缺省', () => {
    expect(fanqieDailyLimit({})).toBe(200);
    expect(fanqieDailyLimit({ DOWNLOAD_FANQIE_DAILY: '50' })).toBe(50);
    expect(fanqieDailyLimit({ DOWNLOAD_FANQIE_DAILY: '-1' })).toBe(200);
  });
  it('多实例布局落到 base/fanqie', () => {
    expect(fanqieDir(join('/b', 'inst-3', 'work'))).toBe(join('/b', 'fanqie'));
    expect(fanqieDir(join('/x', 'work'))).toBe(join('/x', 'work', 'fanqie'));
  });
});

describe('pickFanqieBook', () => {
  it('书名作者归一化后都相等才算', () => {
    expect(normalizeName('规则怪谈：诡异学校 ')).toBe('规则怪谈诡异学校');
    const rows = [{ book_id: ID, title: '规则怪谈：诡异学校', author: '柒月july', creation_status: 0 }];
    expect(pickFanqieBook(rows, '规则怪谈:诡异学校', '柒月July')).toBe(ID);
    expect(pickFanqieBook(rows, '规则怪谈：诡异学校', '别人')).toBeNull();
    expect(pickFanqieBook(rows, '规则怪谈', '柒月July')).toBeNull();
    expect(pickFanqieBook(rows, '规则怪谈：诡异学校', '')).toBeNull();
  });
  it('同名同作者优先完结；书号非法不收', () => {
    const rows = [
      { book_id: '7000000000000000001', title: 'A', author: 'B', creation_status: 1 },
      { book_id: '7000000000000000002', title: 'A', author: 'B', creation_status: '0' },
      { book_id: 'x', title: 'A', author: 'B', creation_status: 0 },
    ];
    expect(pickFanqieBook(rows, 'A', 'B')).toBe('7000000000000000002');
  });
});

describe('rebuildFanqieTxt', () => {
  it('去文件头、按目录切章（含无章号番外），边界首尾相接铺满', () => {
    const titles = ['第1章 入学', '第2章 校规', '一封来自远方的信'];
    const book = rebuildFanqieTxt(raw('第1章 入学', '甲一\n\n甲二', '第2章 校规', '乙', '一封来自远方的信', '丙'), titles)!;
    expect(book.txt).toBe('第1章 入学\n\n甲一\n\n甲二\n\n第2章 校规\n\n乙\n\n一封来自远方的信\n\n丙\n\n');
    expect(book.txt).not.toContain('书籍信息');
    expect(book.charsTotal).toBe(8); // 同引擎：正文按码点计，段间换行也算
    expect(book.chapterRanges.map(r => r.index)).toEqual([0, 1, 2]);
    expect(book.chapterRanges[0].startByte).toBe(0);
    book.chapterRanges.slice(1).forEach((r, i) => expect(r.startByte).toBe(book.chapterRanges[i].endByte));
    expect(book.chapterRanges[2].endByte).toBe(Buffer.byteLength(book.txt, 'utf8'));
  });
  it('正文里提到标题但不是独立成段的不切', () => {
    const book = rebuildFanqieTxt(raw('第1章', '上一段\n第2章\n下一段', '第2章', '乙'), ['第1章', '第2章'])!;
    expect(book.txt).toBe('第1章\n\n上一段\n第2章\n下一段\n\n第2章\n\n乙\n\n');
  });
  it('简介里的同名标题不算（从分隔线之后找）', () => {
    expect(rebuildFanqieTxt(raw('第1章 入学', '甲'), ['第1章 入学'])!.txt).toBe('第1章 入学\n\n甲\n\n');
  });
  it('标题空白差异可容忍，以目录为准', () => {
    expect(rebuildFanqieTxt(raw('第1章  入学', '甲'), ['第1章 入学'])!.txt).toBe('第1章 入学\n\n甲\n\n');
  });
  it('下载器把中文章号改写成数字、换了分隔符也认，标题以目录为准', () => {
    const titles = ['第一章 入学', '第十二章：校规', '第三百零一章 尾声', '番外 信'];
    const book = rebuildFanqieTxt(raw('第1章 入学', '甲', '第12章 校规', '乙', '第301章尾声', '丙', '番外 信', '丁'), titles)!;
    expect(book.txt).toBe('第一章 入学\n\n甲\n\n第十二章：校规\n\n乙\n\n第三百零一章 尾声\n\n丙\n\n番外 信\n\n丁\n\n');
  });
  it('titleKey：章号转数字，非章号的「第一」不动', () => {
    expect(titleKey('第一章 天上打开一扇门')).toBe(titleKey('第1章 天上打开一扇门'));
    expect(titleKey('第一百零一章')).toBe('第101章');
    expect(titleKey('第两千三百四十五章')).toBe('第2345章');
    expect(titleKey('第一万零一章')).toBe('第10001章');
    expect(titleKey('第十章')).toBe('第10章');
    expect(titleKey('第一〇一章')).toBe('第101章');
    expect(titleKey('第一卷 第三节')).toBe('第1卷第3节');
    expect(titleKey('第一次见面')).toBe('第一次见面');
  });
  it('缺章、无分隔线、空目录返回 null', () => {
    expect(rebuildFanqieTxt(raw('第1章', '甲'), ['第1章', '第2章'])).toBeNull();
    expect(rebuildFanqieTxt('第1章\n\n甲\n\n', ['第1章'])).toBeNull();
    expect(rebuildFanqieTxt(raw('第1章', '甲'), [])).toBeNull();
  });
});

describe('预检', () => {
  it('命中跳过原预检；未命中走原预检；memo 免重复搜索', async () => {
    const hit = setup();
    expect(await hit.precheck(TASK)).toEqual({ ok: true });
    expect(hit.innerPrecheck).not.toHaveBeenCalled();
    expect(hit.fetchText.mock.calls[0][0]).toContain(encodeURIComponent(TASK.title));
    await hit.precheck(TASK);
    expect(hit.fetchText).toHaveBeenCalledTimes(1);

    const miss = setup({ search: { code: 0, data: { ret_data: [] } } });
    expect(await miss.precheck(TASK)).toEqual({ ok: true, reason: 'inner' });
    await miss.precheck(TASK);
    expect(miss.fetchText).toHaveBeenCalledTimes(1);
  });
  it('搜索出错放行原预检且不落 memo', async () => {
    const { precheck, innerPrecheck, fetchText } = setup({ search: { code: 500 } });
    await precheck(TASK);
    await precheck(TASK);
    expect(innerPrecheck).toHaveBeenCalledTimes(2);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
  it('无作者不查', async () => {
    const { precheck, fetchText } = setup();
    await precheck({ ...TASK, author: '' });
    expect(fetchText).not.toHaveBeenCalled();
  });
  it('memo 不含书名作者', async () => {
    const { precheck, dir } = setup();
    await precheck(TASK);
    const { readdirSync } = await import('node:fs');
    const [name] = readdirSync(join(dir, 'memo'));
    expect(readFileSync(join(dir, 'memo', name), 'utf8')).toContain(ID);
    expect(readFileSync(join(dir, 'memo', name), 'utf8')).not.toContain('规则');
  });
});

describe('下载腿', () => {
  it('没有计划直接走原腿', async () => {
    const { adapter, inner, ask } = setup();
    await adapter.download(TASK, context());
    expect(ask).not.toHaveBeenCalled();
    expect(inner.download).toHaveBeenCalledTimes(1);
  });
  it('成功：complete 带 chapterRanges，任务行写入章数字数，产物读完即删，记 ok', async () => {
    const { dir, adapter, inner, precheck } = setup();
    writeFileSync(join(dir, 'out', 'a.txt'), raw('第1章 入学', LONG));
    await precheck(TASK);
    const progress = vi.fn(async () => {});
    const outcome = await adapter.download(TASK, { ...context(), progress });
    expect(outcome).toMatchObject({ kind: 'complete', chaptersTotal: 1, chaptersDone: 1, charsTotal: LONG.length });
    expect(outcome.kind === 'complete' && outcome.chapterRanges?.length).toBe(1);
    expect(progress).toHaveBeenCalledWith({ chaptersDone: 1, chaptersTotal: 1, charsTotal: LONG.length });
    expect(inner.download).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'out', 'a.txt'))).toBe(false);
    const day = new Date().toISOString().slice(0, 10);
    expect(readFileSync(join(dir, `events-${day}.log`), 'utf8')).toBe(`ok ${ID} done\n`);
  });
  it('占用：host_occupied 排队，不走原腿、不记事件', async () => {
    for (const reply of [{ rc: 75, result: null }, { rc: null, result: null }]) {
      const { dir, adapter, inner, precheck } = setup({ reply });
      await precheck(TASK);
      expect(await adapter.download(TASK, context())).toMatchObject({
        kind: 'incomplete', reason: 'source_unavailable', stage: 'fanqie', retryCause: 'host_occupied',
      });
      expect(inner.download).not.toHaveBeenCalled();
      expect(existsSync(join(dir, `events-${new Date().toISOString().slice(0, 10)}.log`))).toBe(false);
    }
  });
  it('socket 不通：走原腿，不怪这本书', async () => {
    const { adapter, inner, precheck, fetchText } = setup({ reply: new Error('ECONNREFUSED') });
    await precheck(TASK);
    await adapter.download(TASK, context());
    expect(inner.download).toHaveBeenCalledTimes(1);
    await precheck(TASK);
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['下载器报错', { rc: 1, result: { status: 'error', reason: 'stalled' } }],
    ['目录比对残缺', { rc: 1, result: { status: 'incomplete', file: 'a.txt', titles: ['第1章 入学'], missing: 3 } }],
    ['exists 但有缺章', { rc: 0, result: { status: 'exists', file: 'a.txt', titles: ['第1章 入学'], missing: 3 } }],
    ['切章失败', { rc: 0, result: { status: 'done', file: 'a.txt', titles: ['别的标题'] } }],
    ['太短', { rc: 0, result: { status: 'done', file: 'b.txt', titles: ['第1章 入学'] } }],
  ])('失败退回原腿并记住这本书：%s', async (_name, reply) => {
    const { dir, adapter, inner, precheck, innerPrecheck } = setup({ reply: reply as FanqieReply });
    writeFileSync(join(dir, 'out', 'a.txt'), raw('第1章 入学', LONG));
    writeFileSync(join(dir, 'out', 'b.txt'), raw('第1章 入学', '短'));
    await precheck(TASK);
    expect(await adapter.download(TASK, context())).toEqual({ kind: 'failure', code: 'inner' });
    expect(inner.download).toHaveBeenCalledTimes(1);
    await precheck(TASK);
    expect(innerPrecheck).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['界面遮挡/自动化异常', { rc: 1, result: { status: 'error', reason: 'exception: POST element/x/click -> 400 element click intercepted' } }],
    ['搜索框没出来', { rc: 1, result: { status: 'error', reason: 'no_search_input' } }],
    ['容器没出结果', { rc: 1, result: null }],
    ['产物读不到', { rc: 0, result: { status: 'done', file: 'gone.txt', titles: ['第1章 入学'] } }],
  ])('通道故障退回原腿、计熔断，但不记坏这本书：%s', async (_name, reply) => {
    const { dir, adapter, inner, precheck, innerPrecheck, fetchText } = setup({ reply: reply as FanqieReply });
    await precheck(TASK);
    expect(await adapter.download(TASK, context())).toEqual({ kind: 'failure', code: 'inner' });
    expect(inner.download).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, `events-${new Date().toISOString().slice(0, 10)}.log`), 'utf8')).toMatch(/^fail /);
    expect(await precheck(TASK)).toEqual({ ok: true });
    expect(innerPrecheck).not.toHaveBeenCalled();
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
});

describe('额度与熔断', () => {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  it('今日额度用尽不再搜索', async () => {
    const { dir, precheck, fetchText, innerPrecheck } = setup({ dailyLimit: 2 });
    writeFileSync(join(dir, `events-${day(Date.now())}.log`), `ok 1 done\nok 2 done\n`);
    await precheck(TASK);
    expect(fetchText).not.toHaveBeenCalled();
    expect(innerPrecheck).toHaveBeenCalledTimes(1);
  });
  it('连续失败熔断，到期放行，成功一次解除', async () => {
    let t = Date.now();
    const { dir, precheck, fetchText } = setup({ now: () => t });
    const file = join(dir, `events-${day(t)}.log`);
    writeFileSync(file, `fail 1 stalled\n`.repeat(FANQIE_BREAKER_FAILS));
    await precheck(TASK);
    expect(fetchText).not.toHaveBeenCalled();

    t += FANQIE_BREAKER_PAUSE_MS + 1;
    const stamp = new Date(t - FANQIE_BREAKER_PAUSE_MS - 1);
    utimesSync(file, stamp, stamp);
    await precheck(TASK);
    expect(fetchText).toHaveBeenCalledTimes(1);

    writeFileSync(file, `${`fail 1 stalled\n`.repeat(FANQIE_BREAKER_FAILS)}ok 2 done\n`);
    t = Date.now();
    expect(await setup({ now: () => t }).precheck(TASK)).toEqual({ ok: true });
  });
});

describe('createFanqieSearchFetch', () => {
  const URL0 = 'https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1/?device_platform=android&aid=1967&offset=0&q=x';
  const limiter = () => ({ acquire: vi.fn(async () => 'permit'), recordSuccess: vi.fn(), recordFailure: vi.fn() });
  it('先取共享限速许可再发，成功回报', async () => {
    const lim = limiter();
    const fetchImpl = vi.fn(async () => new Response('{"code":0}'));
    expect(await createFanqieSearchFetch(lim, fetchImpl as never)(URL0, new AbortController().signal)).toBe('{"code":0}');
    expect(lim.acquire).toHaveBeenCalledWith('novel.snssdk.com', expect.anything());
    expect(lim.recordSuccess).toHaveBeenCalledWith('novel.snssdk.com', { permit: 'permit' });
    expect(fetchImpl.mock.calls[0]).toEqual([URL0, expect.objectContaining({ redirect: 'error' })]);
  });
  it('HTTP 失败回报并抛；429 带退避', async () => {
    const lim = limiter();
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    await expect(createFanqieSearchFetch(lim, fetchImpl as never)(URL0, new AbortController().signal)).rejects.toMatchObject({ code: 'HTTP_429' });
    expect(lim.recordFailure).toHaveBeenCalledWith('novel.snssdk.com', { permit: 'permit', retryAfterMs: 60_000 });
  });
  it('没有限速器或地址不对就不发', async () => {
    const fetchImpl = vi.fn();
    await expect(createFanqieSearchFetch(undefined, fetchImpl as never)(URL0, new AbortController().signal)).rejects.toMatchObject({ code: 'NO_LIMITER' });
    await expect(createFanqieSearchFetch(limiter(), fetchImpl as never)('https://evil.example/', new AbortController().signal)).rejects.toMatchObject({ code: 'BAD_URL' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('askFanqieChannel', () => {
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const path = join(mkdtempSync(join(tmpdir(), 'fq-sock-')), 's');
    const server = createServer(handler!);
    await new Promise<void>(resolve => server.listen(path, resolve));
    return { path, close: () => server.close() };
  };
  it('发书号，解析结果行和 rc', async () => {
    const seen: string[] = [];
    const { path, close } = await serve((socket) => {
      socket.on('data', (chunk) => {
        seen.push(String(chunk));
        socket.end(`${JSON.stringify({ book_id: ID, status: 'done', file: 'a.txt' })}\n{"rc":0}\n`);
      });
    });
    const reply = await askFanqieChannel(path, ID, new AbortController().signal);
    close();
    expect(seen).toEqual([`${ID}\n`]);
    expect(reply).toEqual({ rc: 0, result: { book_id: ID, status: 'done', file: 'a.txt' } });
  });
  it('中止即断开连接并抛出', async () => {
    const closed = new Promise<void>((resolve) => {
      void serve((socket) => { socket.resume(); socket.on('close', () => resolve()); socket.on('error', () => {}); }).then(({ path, close }) => {
        const controller = new AbortController();
        const pending = askFanqieChannel(path, ID, controller.signal);
        setTimeout(() => controller.abort(new Error('stop')), 20);
        void pending.catch((error: Error) => { expect(error.message).toBe('stop'); close(); });
      });
    });
    await closed;
  });
  it('socket 不存在时拒绝', async () => {
    await expect(askFanqieChannel(join(tmpdir(), 'no-such-fq.sock'), ID, new AbortController().signal)).rejects.toThrow();
  });
});
