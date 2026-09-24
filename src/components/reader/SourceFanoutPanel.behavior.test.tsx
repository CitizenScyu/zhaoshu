// @vitest-environment jsdom
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReaderClient from './ReaderClient';
import { SOURCE_PROBE_CONCURRENCY } from './useSourceFanout';

// 41-panel:换源面板的扇出路径(候选列表 → 逐源并发 probe)。测试桩与 ReaderClient.behavior.test.tsx 同款:
// 真实 useReader / useSourceFanout 在 jsdom 下跑,只把网络面(apiFetch)、路由、纯样式模块换掉,
// 契约(fanout-41-report §6)靠 fetch 参数与渲染结果来钉。
vi.mock('./reader.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }));
vi.mock('next/link', () => ({
  default: (props: { children?: unknown; href: unknown }) => createElement('a', { href: props.href }, props.children as ReactNode),
}));

const mocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), owner: {} as Record<string, unknown> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, OwnerProvider: (props: { children: unknown }) => props.children, useOwner: () => mocks.owner };
});

if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    private cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe() { queueMicrotask(() => this.cb()); }
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
  }
}

// 源码里的中文标点有全角/半角混用;只比汉字与字母数字。
const squeeze = (s: string) => s.replace(/[^0-9A-Za-z㐀-䶿一-鿿]/g, '');

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const CURRENT = 'https://a.example';
// 阅读目录的 source.url 是书的详情页(sourceReaderIndex 填 bookUrl),不是候选里的源 url。默认夹具是**旧服务端**形状
// (目录无 sourceUrl、段无 servedFromUrl)⇒ 面板按源名认当前源;41-srcurl 的新形状见「当前源」用例组。
const catalog = (over: Record<string, unknown> = {}) => ({
  taskId: null,
  source: { id: 'src-1', name: '源甲', url: CURRENT + '/book/1', session: 'sess-A' },
  title: '诡秘之主', author: '爱潜水的乌贼', version: 'v1', totalBytes: 0,
  chapters: [
    { index: 0, title: '第一章', startByte: 0, endByte: 0, partCount: 1 },
    { index: 1, title: '第二章', startByte: 0, endByte: 0, partCount: 1 },
  ],
  ...over,
});
const part = (over: Record<string, unknown> = {}) => ({
  taskId: null, sourceId: 'src-1', servedFrom: '源甲', version: 'v1',
  chapterIndex: 0, partIndex: 0, partCount: 1, title: '第一章', startByte: 0, endByte: 4, text: '第一章\n正文内容', ...over,
});

const candidate = (name: string, url: string, readable = true) => ({ url, name, tier: 'M1', readable });
const probe = (source: { url: string; name: string }, over: Record<string, unknown>) => ({
  sourceUrl: source.url, sourceName: source.name, elapsedMs: 120, requests: 2, readable: true, ...over,
});
const book = (bookUrl: string) => ({ title: '诡秘之主', author: '爱潜水的乌贼', bookUrl, chapters: 1432 });

type ProbeHandler = (sourceUrl: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** index/章节走固定响应;候选列表与单源 probe 交给用例。 */
function fanoutFetch(
  sources: unknown[] | Response, onProbe: ProbeHandler, servedFrom = '源甲',
  shape: { index?: Record<string, unknown>; part?: Record<string, unknown> } = {},
) {
  return vi.fn<ApiFetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/read/source/index')) {
      const query = new URLSearchParams(url.split('?')[1]);
      // 确认路径(带 book_url)返回换过源的目录(源 id 不变,便于 part 校验通过)。
      return json(query.get('book_url')
        ? catalog({ source: { id: 'src-1', name: '源乙', url: query.get('source') ?? 'https://x.example', session: 'sess-B' } })
        : catalog(shape.index));
    }
    if (url.startsWith('/api/read/source-probe')) {
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      if (!query.has('source')) return sources instanceof Response ? sources : json({ limit: 24, sources });
      return onProbe(query.get('source')!, init);
    }
    if (url.startsWith('/api/read/source/alternates')) return json({ sources: [], partial: false });
    return json(part({ servedFrom, ...shape.part }));
  });
}

function probeCalls(apiFetch: ReturnType<typeof fanoutFetch>): string[] {
  return apiFetch.mock.calls.map((call) => String(call[0]))
    .filter((url) => url.startsWith('/api/read/source-probe?'))
    .map((url) => new URLSearchParams(url.split('?')[1]).get('source')!);
}

function rows(): HTMLLIElement[] {
  return Array.from(document.querySelectorAll<HTMLLIElement>('li[data-probe-status]'));
}
function row(name: string): HTMLLIElement {
  const found = rows().find((item) => squeeze(item.querySelector('span')?.textContent ?? '').startsWith(squeeze(name)));
  if (!found) throw new Error('找不到书源行:' + name);
  return found;
}
const buttonsIn = (element: HTMLElement) => Array.from(element.querySelectorAll('button'));

function ownerWith(apiFetch: ApiFetch) {
  return {
    ready: true, status: 'ready', user: { id: 5, canRead: true, canFind: true, canDownload: true } as never,
    permissions: { find: true, read: true, download: true }, authMethod: 'session', accountsEnabled: true,
    expired: false, sessionId: 1, sessionOnly: false, setSessionOnly: vi.fn(),
    submitToken: vi.fn(), login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    apiFetch, can: (permission: string) => permission === 'read',
  };
}

async function openPanel(apiFetch: ApiFetch) {
  mocks.owner = ownerWith(apiFetch);
  render(createElement(ReaderClient, { session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' }, from: 'library' }));
  await screen.findByText(/正文内容/);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /换源/ }));
  return user;
}

/** 挂起的 probe:由用例手动放行;请求被 abort 时以 AbortError 拒绝(与真 fetch 一致)。 */
function deferredProbes() {
  const pending = new Map<string, { resolve: (res: Response) => void; signal?: AbortSignal }>();
  const aborted: string[] = [];
  const handler: ProbeHandler = (sourceUrl, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    pending.set(sourceUrl, { resolve, signal });
    signal?.addEventListener('abort', () => {
      aborted.push(sourceUrl);
      pending.delete(sourceUrl);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  const release = (sourceUrl: string, res: Response) => {
    const entry = pending.get(sourceUrl);
    if (!entry) throw new Error('该源没有在飞的 probe:' + sourceUrl);
    pending.delete(sourceUrl);
    entry.resolve(res);
  };
  return { pending, aborted, handler, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe('换源面板扇出:九种 status 逐一渲染,只有 readable 的 ok / similar 可切换', () => {
  const sources = [
    candidate('源甲', CURRENT),
    candidate('命中源', 'https://ok.example'),
    candidate('相似源', 'https://similar.example'),
    candidate('不可读源', 'https://unreadable.example', false),
    candidate('多部源', 'https://ambiguous.example'),
    candidate('无书源', 'https://miss.example'),
    candidate('空搜源', 'https://empty.example'),
    candidate('断网源', 'https://down.example'),
    candidate('超时源', 'https://slow.example'),
    candidate('规则源', 'https://rule.example'),
    candidate('怪状态源', 'https://weird.example'),
    candidate('矛盾源', 'https://odd.example'),
    candidate('反向矛盾源', 'https://odd2.example'),
  ];
  const bySource: Record<string, Record<string, unknown>> = {
    'https://ok.example': { status: 'ok', book: book('https://ok.example/b/1') },
    'https://similar.example': {
      status: 'similar',
      candidates: [{ title: '诡秘之主(精校)', author: '乌贼', chapters: 1400, bookUrl: 'https://similar.example/b/9' }],
    },
    'https://unreadable.example': { status: 'unreadable', found: 'ok', readable: false, book: book('https://unreadable.example/b/2') },
    'https://ambiguous.example': { status: 'ambiguous' },
    'https://miss.example': { status: 'miss' },
    'https://empty.example': { status: 'no_candidates' },
    'https://down.example': { status: 'unreachable', code: 'SOURCE_HTTP' },
    'https://slow.example': { status: 'timeout' },
    'https://rule.example': { status: 'compile_failed', code: 'SOURCE_RULE', missingFields: ['ruleSearch.bookList'] },
    'https://weird.example': { status: 'brand_new_status', book: book('https://weird.example/b/3') },
    // 服务端不会发 ok+readable:false(N10 改报 unreadable),面板仍按 readable 兜底不给切换。
    'https://odd.example': { status: 'ok', readable: false, book: book('https://odd.example/b/4') },
    // 反过来:status=unreadable 却 readable:true,也只按状态判定为仅展示(状态闸与 readable 闸各自独立生效)。
    'https://odd2.example': { status: 'unreadable', found: 'ok', readable: true, book: book('https://odd2.example/b/5') },
  };

  it('每行按 status 渲染文案;当前源不发 probe;unreadable / 未知状态 / readable=false 一律无切换按钮', async () => {
    const apiFetch = fanoutFetch(sources, (url) => {
      const source = sources.find((item) => item.url === url)!;
      return json(probe(source, bySource[url]));
    });
    await openPanel(apiFetch);
    await waitFor(() => expect(rows().length).toBe(sources.length));
    await waitFor(() => expect(rows().filter((item) => item.dataset.probeStatus === 'probing' || item.dataset.probeStatus === 'pending').length).toBe(0));

    const expectations: [string, string, string][] = [
      ['命中源', 'ok', '诡秘之主 · 爱潜水的乌贼 · 1432 章'],
      ['相似源', 'similar', '找到相近的书,请确认是哪一本'],
      ['不可读源', 'unreadable', '找到但不可读'],
      ['多部源', 'ambiguous', '该书源有多部同名作品'],
      ['无书源', 'miss', '该书源没有这本书'],
      ['空搜源', 'no_candidates', '该书源没有搜到结果'],
      ['断网源', 'unreachable', '该书源暂时无法访问'],
      ['超时源', 'timeout', '检测超时'],
      ['规则源', 'compile_failed', '该书源规则暂不兼容'],
      ['怪状态源', 'brand_new_status', '暂不支持的检测结果'],
    ];
    for (const [name, status, text] of expectations) {
      expect(row(name).dataset.probeStatus, name).toBe(status);
      expect(squeeze(row(name).textContent ?? ''), name).toContain(squeeze(text));
    }
    // unreadable 仍展示找到的书(仅展示)。
    expect(squeeze(row('不可读源').textContent ?? '')).toContain(squeeze('1432 章'));

    // 可切换性:只有 ok(一个「切换到此源」)与 similar(每个候选一个按钮)。
    expect(buttonsIn(row('命中源')).map((b) => squeeze(b.textContent ?? ''))).toEqual([squeeze('切换到此源')]);
    expect(buttonsIn(row('相似源')).length).toBe(1);
    for (const name of ['不可读源', '多部源', '无书源', '空搜源', '断网源', '超时源', '规则源', '怪状态源', '矛盾源', '反向矛盾源']) {
      expect(buttonsIn(row(name)), name).toEqual([]);
    }

    // 当前源:标「当前源」、不 probe(省限流额度)、无切换按钮。
    expect(row('源甲').dataset.probeStatus).toBe('current');
    expect(squeeze(row('源甲').textContent ?? '')).toContain(squeeze('当前源'));
    expect(buttonsIn(row('源甲'))).toEqual([]);
    expect(probeCalls(apiFetch)).not.toContain(CURRENT);
    expect(probeCalls(apiFetch).length).toBe(sources.length - 1);
    // probe 请求带书名、作者与候选 url 原样。
    const first = apiFetch.mock.calls.map((call) => String(call[0])).find((url) => url.includes('source=https%3A%2F%2Fok.example'))!;
    const query = new URLSearchParams(first.split('?')[1]);
    expect([query.get('title'), query.get('author'), query.get('source')]).toEqual(['诡秘之主', '爱潜水的乌贼', 'https://ok.example']);
  });
});

describe('换源面板扇出:当前源', () => {
  it('当前源按正在供稿的源名认(章内换源后 servedFrom 是新源):新源标当前且不 probe,原目录源照常 probe', async () => {
    const sources = [candidate('源甲', CURRENT), candidate('源乙', 'https://b.example')];
    const apiFetch = fanoutFetch(sources, (url) => json(probe(sources.find((item) => item.url === url)!, { status: 'miss' })), '源乙');
    await openPanel(apiFetch);
    await waitFor(() => expect(row('源甲').dataset.probeStatus).toBe('miss'));
    expect(row('源乙').dataset.probeStatus).toBe('current');
    expect(probeCalls(apiFetch)).toEqual([CURRENT]);
  });

  // 41-srcurl:目录带 source.sourceUrl、段带 servedFromUrl ⇒ 按源 url 精确认当前源。
  const withUrls = (sourceUrl: string, servedFromUrl: string) => ({
    index: { source: { id: 'src-1', name: '源甲', url: CURRENT + '/book/1', sourceUrl, session: 'sess-A' } },
    part: { servedFromUrl },
  });
  const MIRROR = 'https://mirror.example';

  it('同名不同 url 的两个源:只有 url 相符的是当前源,另一个照常 probe 且可切换', async () => {
    const sources = [candidate('源甲', CURRENT), candidate('源甲', MIRROR)];
    const apiFetch = fanoutFetch(sources, (url) => json(probe(sources.find((item) => item.url === url)!, {
      status: 'ok', book: book(url + '/b/1'),
    })), '源甲', withUrls(CURRENT, CURRENT));
    await openPanel(apiFetch);
    await waitFor(() => expect(rows()[1].dataset.probeStatus).toBe('ok'));
    const [current, mirror] = rows();
    expect(current.dataset.probeStatus).toBe('current');
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(buttonsIn(current)).toEqual([]);
    expect(mirror.getAttribute('aria-current')).toBeNull();
    expect(squeeze(mirror.textContent ?? '')).not.toContain(squeeze('当前源'));
    expect(buttonsIn(mirror).map((b) => squeeze(b.textContent ?? ''))).toEqual([squeeze('切换到此源')]);
    expect(probeCalls(apiFetch)).toEqual([MIRROR]);
  });

  it('章内换源后跟到新源 url:servedFromUrl 指向的源标当前,同名的另一 url 与原目录源照常 probe', async () => {
    const sources = [candidate('源甲', CURRENT), candidate('源乙', 'https://b1.example'), candidate('源乙', 'https://b2.example')];
    const apiFetch = fanoutFetch(sources, (url) => json(probe(sources.find((item) => item.url === url)!, { status: 'miss' })),
      '源乙', withUrls(CURRENT, 'https://b2.example'));
    await openPanel(apiFetch);
    await waitFor(() => expect(rows()[1].dataset.probeStatus).toBe('miss'));
    expect(rows().map((item) => item.dataset.probeStatus)).toEqual(['miss', 'miss', 'current']);
    expect(probeCalls(apiFetch).sort()).toEqual([CURRENT, 'https://b1.example']);
  });

  it('段只带源名(旧服务端)时不拿目录上的 url 去配:按段的源名认,目录源照常 probe', async () => {
    const sources = [candidate('源甲', CURRENT), candidate('源乙', 'https://b.example')];
    const apiFetch = fanoutFetch(sources, (url) => json(probe(sources.find((item) => item.url === url)!, { status: 'miss' })),
      '源乙', { index: withUrls(CURRENT, CURRENT).index });
    await openPanel(apiFetch);
    await waitFor(() => expect(row('源甲').dataset.probeStatus).toBe('miss'));
    expect(row('源乙').dataset.probeStatus).toBe('current');
    expect(probeCalls(apiFetch)).toEqual([CURRENT]);
  });
});

describe('换源面板扇出:确认切换必须带 source', () => {
  const sources = [candidate('命中源', 'https://ok.example'), candidate('相似源', 'https://similar.example')];
  const handler: ProbeHandler = (url) => json(url === 'https://ok.example'
    ? probe(sources[0], { status: 'ok', book: book('https://ok.example/b/1') })
    : probe(sources[1], { status: 'similar', candidates: [{ title: '诡秘之主', author: '乌贼', chapters: 9, bookUrl: 'https://similar.example/b/9' }] }));

  it('ok 行「切换到此源」⇒ index 请求带 book_url 与该行 sourceUrl;成功后 URL 同时存 source 与 book_url', async () => {
    const apiFetch = fanoutFetch(sources, handler);
    const user = await openPanel(apiFetch);
    await waitFor(() => expect(buttonsIn(row('命中源')).length).toBe(1));
    await user.click(buttonsIn(row('命中源'))[0]);

    await waitFor(() => {
      const confirm = apiFetch.mock.calls.map((call) => String(call[0]))
        .find((url) => url.startsWith('/api/read/source/index') && url.includes('book_url='));
      expect(confirm).toBeTruthy();
      const query = new URLSearchParams(confirm!.split('?')[1]);
      expect(query.get('book_url')).toBe('https://ok.example/b/1');
      expect(query.get('source')).toBe('https://ok.example');
    });
    await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
    const replaced = new URLSearchParams(String(mocks.replace.mock.calls.at(-1)![0]).split('?')[1]);
    expect(replaced.get('book_url')).toBe('https://ok.example/b/1');
    expect(replaced.get('source')).toBe('https://ok.example');
  });

  it('similar 行点选候选 ⇒ index 请求带该候选 bookUrl 与该行 sourceUrl', async () => {
    const apiFetch = fanoutFetch(sources, handler);
    const user = await openPanel(apiFetch);
    await waitFor(() => expect(buttonsIn(row('相似源')).length).toBe(1));
    await user.click(buttonsIn(row('相似源'))[0]);
    await waitFor(() => {
      const confirm = apiFetch.mock.calls.map((call) => String(call[0]))
        .find((url) => url.startsWith('/api/read/source/index') && url.includes('book_url='));
      const query = new URLSearchParams(confirm!.split('?')[1]);
      expect(query.get('book_url')).toBe('https://similar.example/b/9');
      expect(query.get('source')).toBe('https://similar.example');
    });
  });
});

describe('换源面板扇出:开关与错误码', () => {
  it('候选列表 404 SOURCE_FANOUT_DISABLED ⇒ 退回旧 alternates 面板,不报错、不发 probe', async () => {
    const apiFetch = fanoutFetch(json({ error: '换源扇出未开启。', code: 'SOURCE_FANOUT_DISABLED' }, 404), () => { throw new Error('不该 probe'); });
    await openPanel(apiFetch);
    await waitFor(() => expect(apiFetch.mock.calls.some((call) => String(call[0]).startsWith('/api/read/source/alternates'))).toBe(true));
    expect(probeCalls(apiFetch)).toEqual([]);
    expect(rows()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('429 ⇒ 停发剩余 probe(不自动重试),提示「请稍后再试(N 秒)」,未发的行标未检测', async () => {
    const sources = Array.from({ length: 7 }, (_, i) => candidate(`源${i + 1}号`, `https://s${i + 1}.example`));
    const probes = deferredProbes();
    const apiFetch = fanoutFetch(sources, probes.handler);
    await openPanel(apiFetch);
    await waitFor(() => expect(probes.pending.size).toBe(SOURCE_PROBE_CONCURRENCY));
    probes.release('https://s1.example', json(
      { error: '换源探测过于频繁,请稍后再试。', code: 'SOURCE_PROBE_RATE_LIMITED', retryAfterSeconds: 37 }, 429, { 'Retry-After': '37' },
    ));
    for (const url of ['https://s2.example', 'https://s3.example', 'https://s4.example']) {
      probes.release(url, json(probe({ url, name: url }, { status: 'miss' })));
    }
    await waitFor(() => expect(squeeze(screen.getByRole('alert').textContent ?? '')).toContain(squeeze('请稍后再试（37 秒）')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probeCalls(apiFetch).length).toBe(SOURCE_PROBE_CONCURRENCY);
    expect(['源5号', '源6号', '源7号'].map((name) => row(name).dataset.probeStatus)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(row('源2号').dataset.probeStatus).toBe('miss');
  });

  it('429 只带 Retry-After 头 ⇒ 秒数取自响应头', async () => {
    const sources = [candidate('源一', 'https://one.example')];
    const apiFetch = fanoutFetch(sources, () => json({ code: 'SOURCE_PROBE_RATE_LIMITED' }, 429, { 'Retry-After': '12' }));
    await openPanel(apiFetch);
    await waitFor(() => expect(squeeze(screen.getByRole('alert').textContent ?? '')).toContain(squeeze('请稍后再试（12 秒）')));
  });

  it('503 ⇒ 提示服务暂不可用并停止扇出', async () => {
    const sources = Array.from({ length: 6 }, (_, i) => candidate(`源${i + 1}号`, `https://s${i + 1}.example`));
    const probes = deferredProbes();
    const apiFetch = fanoutFetch(sources, probes.handler);
    await openPanel(apiFetch);
    await waitFor(() => expect(probes.pending.size).toBe(SOURCE_PROBE_CONCURRENCY));
    probes.release('https://s1.example', json({ code: 'SOURCE_PROBE_RATE_LIMIT_UNAVAILABLE' }, 503, { 'Retry-After': '5' }));
    for (const url of ['https://s2.example', 'https://s3.example', 'https://s4.example']) {
      probes.release(url, json(probe({ url, name: url }, { status: 'miss' })));
    }
    await waitFor(() => expect(squeeze(screen.getByRole('alert').textContent ?? '')).toContain(squeeze('换源探测暂时不可用')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probeCalls(apiFetch).length).toBe(SOURCE_PROBE_CONCURRENCY);
    expect(row('源6号').dataset.probeStatus).toBe('skipped');
  });

  // 41-srcurl:候选列表路由不查限流,产不出 503 限流不可用(panelrev41 M14:该分支不可达,已删)。
  // 网关/平台给的 503(HTML 或无 error 字段)与其它 5xx 同样走 error:提示可重试、零 probe、不退回旧面板。
  it('候选列表 5xx(含网关 503)⇒ 候选加载失败提示,零 probe,不退回旧面板', async () => {
    const apiFetch = fanoutFetch(new Response('<html>Service Unavailable</html>', { status: 503 }), () => { throw new Error('不该 probe'); });
    await openPanel(apiFetch);
    await waitFor(() => expect(squeeze(screen.getByRole('alert').textContent ?? '')).toContain(squeeze('换源候选加载失败,请重试。')));
    expect(probeCalls(apiFetch)).toEqual([]);
    expect(apiFetch.mock.calls.some((call) => String(call[0]).startsWith('/api/read/source/alternates'))).toBe(false);
    expect((screen.getByRole('button', { name: '重新检测' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('504(准备阶段超时)与 200 {status:timeout}(probe 超时)分别渲染,且都不停止扇出', async () => {
    const sources = [candidate('准备超时源', 'https://prep.example'), candidate('探测超时源', 'https://probe.example'), candidate('正常源', 'https://fine.example')];
    const apiFetch = fanoutFetch(sources, (url) => {
      if (url === 'https://prep.example') return json({ error: '书源查询已取消或超时,可稍后重试。', code: 'SOURCE_TIMEOUT' }, 504, { 'Retry-After': '5' });
      if (url === 'https://probe.example') return json(probe(sources[1], { status: 'timeout' }));
      return json(probe(sources[2], { status: 'miss' }));
    });
    await openPanel(apiFetch);
    await waitFor(() => expect(row('正常源').dataset.probeStatus).toBe('miss'));
    expect(row('准备超时源').dataset.probeStatus).toBe('failed');
    expect(squeeze(row('准备超时源').textContent ?? '')).toContain(squeeze('准备超时'));
    expect(row('探测超时源').dataset.probeStatus).toBe('timeout');
    expect(squeeze(row('探测超时源').textContent ?? '')).toContain(squeeze('检测超时'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('换源面板扇出:调度', () => {
  it(`并发上限 ${SOURCE_PROBE_CONCURRENCY}:10 个候选逐个放行,同时在飞从不超过上限,最终全部发出`, async () => {
    const sources = Array.from({ length: 10 }, (_, i) => candidate(`源${i + 1}号`, `https://s${i + 1}.example`));
    const probes = deferredProbes();
    let peak = 0;
    const apiFetch = fanoutFetch(sources, (url, init) => {
      const promise = probes.handler(url, init);
      peak = Math.max(peak, probes.pending.size);
      return promise;
    });
    await openPanel(apiFetch);
    for (let released = 0; released < sources.length; released++) {
      await waitFor(() => expect(probes.pending.size).toBe(Math.min(SOURCE_PROBE_CONCURRENCY, sources.length - released)));
      const [url] = probes.pending.keys();
      probes.release(url, json(probe({ url, name: url }, { status: 'miss' })));
    }
    await waitFor(() => expect(rows().every((item) => item.dataset.probeStatus === 'miss')).toBe(true));
    expect(peak).toBe(SOURCE_PROBE_CONCURRENCY);
    expect(new Set(probeCalls(apiFetch)).size).toBe(10);
  });

  it('同 host 的候选不同时在飞:前一个落定后才发下一个', async () => {
    const sources = [candidate('甲一', 'https://same.example/a'), candidate('甲二', 'https://same.example/b'), candidate('乙', 'https://other.example')];
    const probes = deferredProbes();
    const apiFetch = fanoutFetch(sources, probes.handler);
    await openPanel(apiFetch);
    await waitFor(() => expect([...probes.pending.keys()].sort()).toEqual(['https://other.example', 'https://same.example/a']));
    probes.release('https://same.example/a', json(probe(sources[0], { status: 'miss' })));
    await waitFor(() => expect(probes.pending.has('https://same.example/b')).toBe(true));
  });

  // 41-srcurl:同站按服务端下发的 hostKey 串行。book15 apex/www 是两个 hostname、同一个站。
  it('候选带 hostKey ⇒ book15 apex 与 www 按同站串行:前一个落定后才发下一个', async () => {
    const sources = [
      { ...candidate('book15', 'https://book15.net/'), hostKey: 'book15.net' },
      { ...candidate('book15 www', 'https://www.book15.net/'), hostKey: 'book15.net' },
      { ...candidate('乙', 'https://other.example'), hostKey: 'other.example' },
    ];
    const probes = deferredProbes();
    const apiFetch = fanoutFetch(sources, probes.handler);
    await openPanel(apiFetch);
    await waitFor(() => expect([...probes.pending.keys()].sort()).toEqual(['https://book15.net/', 'https://other.example']));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probes.pending.has('https://www.book15.net/')).toBe(false);
    probes.release('https://book15.net/', json(probe(sources[0], { status: 'miss' })));
    await waitFor(() => expect(probes.pending.has('https://www.book15.net/')).toBe(true));
  });

  it('候选没有 hostKey(旧服务端)⇒ 退回 hostname:apex 与 www 视为两个 host 同时在飞', async () => {
    const sources = [candidate('book15', 'https://book15.net/'), candidate('book15 www', 'https://www.book15.net/')];
    const probes = deferredProbes();
    const apiFetch = fanoutFetch(sources, probes.handler);
    await openPanel(apiFetch);
    await waitFor(() => expect([...probes.pending.keys()].sort()).toEqual(['https://book15.net/', 'https://www.book15.net/']));
  });

  it('关闭面板 ⇒ 在途 probe 全部 abort,之后不再发新 probe', async () => {
    const sources = Array.from({ length: 8 }, (_, i) => candidate(`源${i + 1}号`, `https://s${i + 1}.example`));
    const probes = deferredProbes();
    const apiFetch = fanoutFetch(sources, probes.handler);
    const user = await openPanel(apiFetch);
    await waitFor(() => expect(probes.pending.size).toBe(SOURCE_PROBE_CONCURRENCY));
    const inFlight = [...probes.pending.keys()];
    await user.click(screen.getByRole('button', { name: '关闭切换书源' }));
    await waitFor(() => expect(probes.aborted.sort()).toEqual(inFlight.sort()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probeCalls(apiFetch).length).toBe(SOURCE_PROBE_CONCURRENCY);
  });

  it('同一阅读会话内重开面板:已有结论的源不重复 probe,超时的源重测', async () => {
    const sources = [candidate('无书源', 'https://miss.example'), candidate('超时源', 'https://slow.example')];
    const apiFetch = fanoutFetch(sources, (url) => json(probe(sources.find((item) => item.url === url)!, {
      status: url === 'https://slow.example' ? 'timeout' : 'miss',
    })));
    const user = await openPanel(apiFetch);
    await waitFor(() => expect(row('超时源').dataset.probeStatus).toBe('timeout'));
    await user.click(screen.getByRole('button', { name: '关闭切换书源' }));
    await user.click(screen.getByRole('button', { name: /换源/ }));
    await waitFor(() => expect(probeCalls(apiFetch).filter((url) => url === 'https://slow.example').length).toBe(2));
    expect(probeCalls(apiFetch).filter((url) => url === 'https://miss.example').length).toBe(1);
    await waitFor(() => expect(row('无书源').dataset.probeStatus).toBe('miss'));
  });
});
