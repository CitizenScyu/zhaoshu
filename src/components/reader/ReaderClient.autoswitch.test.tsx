// @vitest-environment jsdom
// readerux42-A:阅读中自动换源的行为钉(触发/每章一次限流/开关回落/SOURCE_SIMILAR 不自动选/429 止步)。
// 网络面(apiFetch)、路由、纯样式模块换掉,换源流转靠 fetch 参数断言钉死 —— 与
// ReaderClient.behavior.test.tsx 同一 harness(此处只摘与本题相关的桩)。
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReaderClient from './ReaderClient';

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
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      private cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe() { queueMicrotask(() => this.cb()); }
      unobserve() {}
      disconnect() {}
    };
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
  }
}

// 中文标点与 ASCII 标点不同码点,断言前统一折叠(与 behavior.test 同一手法)。
const squeeze = (s: string) => s.replace(/[^0-9A-Za-z㐀-䶿一-鿿]/g, '');
function textIs(expected: string) {
  const want = squeeze(expected);
  return (_content: string, element: Element | null) => element !== null && squeeze(element.textContent ?? '') === want;
}

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchMock = ApiFetch & { mock: { calls: unknown[][] } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fanoutOff = () => json({ error: '换源扇出未开启。', code: 'SOURCE_FANOUT_DISABLED' }, 404);

const catalog = (over: Record<string, unknown> = {}) => ({
  taskId: null,
  source: { id: 'src-1', name: '源甲', url: 'https://a.example', session: 'sess-A' },
  title: '诡秘之主', author: '爱潜水的乌贼', version: 'v1', totalBytes: 0,
  chapters: [
    { index: 0, title: '第一章', startByte: 0, endByte: 0, partCount: 1 },
    { index: 1, title: '第二章', startByte: 0, endByte: 0, partCount: 1 },
  ],
  ...over,
});

const part = (over: Record<string, unknown> = {}) => ({
  taskId: null, sourceId: 'src-1', servedFrom: '源甲', version: 'v1',
  chapterIndex: 0, partIndex: 0, partCount: 1, title: '第一章',
  startByte: 0, endByte: 4, text: '第一章\n正文内容', ...over,
});

const param = (url: string, key: string) => new URLSearchParams(url.split('?')[1]).get(key);
const urls = (apiFetch: { mock: { calls: unknown[][] } }) => apiFetch.mock.calls.map((call) => String(call[0]));
const candidateListCalls = (apiFetch: FetchMock) => urls(apiFetch).filter((u) => u === '/api/read/source-probe');
const probeCalls = (apiFetch: FetchMock) => urls(apiFetch).filter((u) => u.startsWith('/api/read/source-probe?'));
const unavailable = () => json({ error: '本章暂不可读,备用书源也未找到相同章节。可重试或尝试「下载全书」。', code: 'SOURCE_CHAPTER_UNAVAILABLE' }, 503);

// 扇出候选列表:两个候选(源乙先、源丙后),供顺序与止步断言。
const candidatesBody = () => json({
  sources: [
    { url: 'https://b.example', name: '源乙', tier: 'builtin', readable: true },
    { url: 'https://c.example', name: '源丙', tier: 'builtin', readable: true },
  ],
});

const probeOk = (sourceUrl: string, sourceName: string, bookUrl: string) => json({
  status: 'ok', sourceUrl, sourceName, elapsedMs: 5, requests: 1, readable: true,
  book: { title: '诡秘之主', author: '爱潜水的乌贼', bookUrl, chapters: 2 },
});

function ownerWith(apiFetch: ApiFetch) {
  return {
    ready: true, status: 'ready', user: { id: 5, canRead: true, canFind: true, canDownload: true } as never,
    permissions: { find: true, read: true, download: true }, authMethod: 'session', accountsEnabled: true,
    expired: false, sessionId: 1, sessionOnly: false, setSessionOnly: vi.fn(),
    submitToken: vi.fn(), login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    apiFetch, can: (permission: string) => permission === 'read', isCurrentSession: () => true,
  };
}

function renderReader(apiFetch: FetchMock) {
  mocks.owner = ownerWith(apiFetch);
  return render(createElement(ReaderClient, {
    session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' }, from: 'library',
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => cleanup());

describe('readerux42-A 阅读中自动换源', () => {
  it('正文取失败(503)⇒ 自动探测候选并切换到第一个可用源,走 book_url 确认重放,新源正文透出', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/read/source-probe') return candidatesBody();
      if (url.startsWith('/api/read/source-probe?')) {
        // 第一个候选(源乙)即 ok+readable+bookUrl ⇒ 直接命中,源丙不该被探测。
        return param(url, 'source') === 'https://b.example'
          ? probeOk('https://b.example', '源乙', 'https://b.example/2')
          : probeOk('https://c.example', '源丙', 'https://c.example/3');
      }
      if (url.startsWith('/api/read/source/index')) {
        // 确认路径(带 book_url)返回换过源的目录(源乙 / sess-B)。
        return param(url, 'book_url')
          ? json(catalog({ source: { id: 'src-2', name: '源乙', url: 'https://b.example', session: 'sess-B' } }))
          : json(catalog());
      }
      if (param(url, 'session') === 'sess-B') {
        return json(part({ sourceId: 'src-2', servedFrom: '源乙', text: '第一章\n备用源正文' }));
      }
      return unavailable();
    });
    renderReader(apiFetch);

    // 失败出现 ⇒ 自动探测被触发(候选列表 + 命中源的单源 probe)。
    await screen.findByRole('alert');
    await waitFor(() => expect(candidateListCalls(apiFetch)).toHaveLength(1));
    await waitFor(() => expect(probeCalls(apiFetch).some((u) => param(u, 'source') === 'https://b.example')).toBe(true));

    // 自动切换:带 book_url 的确认重放发出,且带命中源的 source 参数。
    await waitFor(() => {
      const confirmed = urls(apiFetch).filter((u) => u.startsWith('/api/read/source/index') && param(u, 'book_url'));
      expect(confirmed.length).toBeGreaterThanOrEqual(1);
      expect(param(confirmed[0], 'book_url')).toBe('https://b.example/2');
      expect(param(confirmed[0], 'source')).toBe('https://b.example');
    });
    // 新源正文透出,错误条消失。
    await screen.findByText(/备用源正文/);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('每章至多自动换一次:同一章再次失败只提示,不再发候选探测(回落手动换源)', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/read/source-probe') return fanoutOff(); // 扇出关 ⇒ 找不到可直切源
      if (url.startsWith('/api/read/source-probe?')) return probeOk('https://b.example', '源乙', 'https://b.example/2');
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      return unavailable();
    });
    renderReader(apiFetch);

    await screen.findByRole('alert');
    // 第一次失败:探测发生,扇出关 ⇒ 提示回落手动换源。
    await waitFor(() => expect(candidateListCalls(apiFetch)).toHaveLength(1));
    await screen.findByText(textIs('没有找到可直接切换的可用书源;可点「换个书源」手动检测。'));

    // 重试 ⇒ 同一章再次失败:不再探测,提示「已自动换过一次」。
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText(textIs('本章已自动换过一次书源,不再自动重试;可点「换个书源」手动切换。'));
    expect(candidateListCalls(apiFetch)).toHaveLength(1);
    expect(probeCalls(apiFetch)).toHaveLength(0);
  });

  it('开关默认开;关掉后正文失败不自动探测,只有手动换源入口', async () => {
    window.localStorage.setItem('novel-finder-reading-settings', JSON.stringify({ autoSwitchSource: false }));
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source-probe')) return candidatesBody();
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      return unavailable();
    });
    renderReader(apiFetch);

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '换个书源' })).toBeTruthy();
    // 一个扇出请求都不该发(候选列表与单源 probe 都没有)。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(urls(apiFetch).some((u) => u.startsWith('/api/read/source-probe'))).toBe(false);
  });

  it('SOURCE_SIMILAR(422)有自己的候选点选卡 ⇒ 不自动探测、不自动选', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source-probe')) return candidatesBody();
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      return json({
        error: '找到多部相似书籍,请确认。', code: 'SOURCE_SIMILAR',
        candidates: [{ title: '诡秘之主', author: '爱潜水的乌贼', bookUrl: 'https://s.example/1', chapters: 2 }],
      }, 422);
    });
    renderReader(apiFetch);

    // 候选点选卡渲染,而不是自动换源探测。
    await screen.findByRole('listbox', { name: '相似书籍候选' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(urls(apiFetch).some((u) => u.startsWith('/api/read/source-probe'))).toBe(false);
  });

  it('单源 probe 遇 429 限流 ⇒ 立即止步,剩余候选不再探测(不烧额度)', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/read/source-probe') return candidatesBody();
      if (url.startsWith('/api/read/source-probe?')) {
        return param(url, 'source') === 'https://b.example'
          ? json({ error: '换源探测过于频繁,请稍后再试。', code: 'SOURCE_PROBE_RATE_LIMITED', retryAfterSeconds: 30 }, 429)
          : probeOk('https://c.example', '源丙', 'https://c.example/3');
      }
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      return unavailable();
    });
    renderReader(apiFetch);

    await screen.findByRole('alert');
    await waitFor(() => expect(candidateListCalls(apiFetch)).toHaveLength(1));
    // 源乙被 429 ⇒ 整体放弃(不自动重试),源丙一个 probe 都不发。
    await screen.findByText(textIs('没有找到可直接切换的可用书源;可点「换个书源」手动检测。'));
    expect(probeCalls(apiFetch).every((u) => param(u, 'source') !== 'https://c.example')).toBe(true);
  });

  // ruxrev42 F-1 回归:探测必须跨宏任务兑现。同微任务兑现的 mock(其余用例)抢在 React
  // 调度 re-render 之前跑完,测不出「依赖里的新引用触发 cleanup abort 在飞探测」;真实
  // fetch 起步就是一个宏任务。且失败必须发生在**已读到正文之后** —— 首载即败时 reading
  // 尚为 null、servingSource 恒 undefined(稳定值),暴露不了每次渲染新引用的缺陷。
  it('ruxrev42 F-1:读到正文后章节失败,跨宏任务兑现的探测仍完成并切换(notice 重渲染不中止探测)', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      await tick(); // 与真实网络同量级:兑现晚于 setNotice 触发的 re-render
      const url = String(input);
      if (url === '/api/read/source-probe') return candidatesBody();
      if (url.startsWith('/api/read/source-probe?')) {
        return param(url, 'source') === 'https://b.example'
          ? probeOk('https://b.example', '源乙', 'https://b.example/2')
          : probeOk('https://c.example', '源丙', 'https://c.example/3');
      }
      if (url.startsWith('/api/read/source/index')) {
        return param(url, 'book_url')
          ? json(catalog({ source: { id: 'src-2', name: '源乙', url: 'https://b.example', session: 'sess-B' } }))
          : json(catalog());
      }
      if (param(url, 'session') === 'sess-B') {
        return json(part({ sourceId: 'src-2', servedFrom: '源乙', text: '第一章\n备用源正文' }));
      }
      // 首章读得通;翻到第二章 503 ⇒ 失败时 reading/正文已在屏上。
      const chapter = Number(new URLSearchParams(url.split('?')[1]).get('chapter') ?? '0');
      return chapter === 0 ? json(part()) : unavailable();
    });
    renderReader(apiFetch);

    await screen.findByText(/正文内容/);
    fireEvent.click(screen.getByRole('button', { name: '下一章 →' }));
    await screen.findByRole('alert');
    // 命中源的单源 probe 真的发出(没有被 notice 重渲染的 cleanup abort 掉)。
    await waitFor(() => expect(probeCalls(apiFetch).some((u) => param(u, 'source') === 'https://b.example')).toBe(true));
    // 切换完成:确认重放发出且带 book_url/source,新源正文透出。
    await screen.findByText(/备用源正文/);
    const confirmed = urls(apiFetch).filter((u) => u.startsWith('/api/read/source/index') && param(u, 'book_url'));
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(param(confirmed[0], 'book_url')).toBe('https://b.example/2');
    expect(param(confirmed[0], 'source')).toBe('https://b.example');
  });

  // ruxrev42 F-2:一次可见失败至多一轮扇出。章节失败触发的自动换源走确认重放,新源建目录
  // 失败(无 target)与触发它的章节失败算同一次 —— 计数上继承上一次的 key,不再自立
  // 'index' 命名空间,也不发第二轮候选探测。
  it('ruxrev42 F-2:章节失败自动换源后新源建目录失败,只计同一次,不再发第二轮扇出探测', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/read/source-probe') return candidatesBody();
      if (url.startsWith('/api/read/source-probe?')) return probeOk('https://b.example', '源乙', 'https://b.example/2');
      if (url.startsWith('/api/read/source/index')) {
        // 确认路径(带 book_url)建目录也失败 —— 换源未成,错误条回到可见。
        return param(url, 'book_url') ? unavailable() : json(catalog());
      }
      return unavailable();
    });
    renderReader(apiFetch);

    // 章节 503 ⇒ 第一轮(也是唯一一轮)候选探测 + 命中源的确认重放。
    await screen.findByRole('alert');
    await waitFor(() => expect(candidateListCalls(apiFetch)).toHaveLength(1));
    await waitFor(() => expect(probeCalls(apiFetch).some((u) => param(u, 'source') === 'https://b.example')).toBe(true));
    await waitFor(() => {
      expect(urls(apiFetch).some((u) => u.startsWith('/api/read/source/index') && param(u, 'book_url'))).toBe(true);
    });
    // 确认重放失败落定后,等一个可观测窗口:候选列表仍是 1 次 —— 一次可见失败只烧一轮扇出。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(candidateListCalls(apiFetch)).toHaveLength(1);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('readerux42-A 自动换源开关(阅读设置)', () => {
  it('设置面板有「自动换源」开关,默认开;可关掉并持久化', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source-probe')) return candidatesBody();
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      return json(part());
    });
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /设置$/ }));
    const dialog = await screen.findByRole('dialog', { name: '阅读设置' });
    // 三个开关(滚动接续/提前载入/自动换源)都存在;自动换源默认开。
    const switches = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(switches.length).toBe(3);
    expect(screen.getByText('自动换源')).toBeTruthy();
    const autoSwitch = switches[2];
    expect(autoSwitch.checked).toBe(true);

    fireEvent.click(autoSwitch);
    await waitFor(() => {
      const stored = window.localStorage.getItem('novel-finder-reading-settings');
      expect(stored && JSON.parse(stored).autoSwitchSource).toBe(false);
    });
  });
});
