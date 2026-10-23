// @vitest-environment jsdom
// readerux42-B:自动阅读的行为钉(开关与速度/章末无缝接续/出错即停/末章停止/用户手势接管)。
// 滚读的滚动量与章末判定依赖 scrollHeight/clientHeight,jsdom 无布局 ⇒ 用
// Object.defineProperty 在正文容器上钉假尺寸;定时拍用假计时器驱动。
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const urls = (apiFetch: { mock: { calls: unknown[][] } }) => apiFetch.mock.calls.map((call) => String(call[0]));
const param = (url: string, key: string) => new URLSearchParams(url.split('?')[1]).get(key);

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

function simpleFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/read/source/index')) return json(catalog());
    const chapter = Number(new URLSearchParams(url.split('?')[1]).get('chapter') ?? '0');
    return json(part({
      chapterIndex: chapter,
      title: chapter === 0 ? '第一章' : '第二章',
      text: chapter === 0 ? '第一章\n正文内容' : '第二章\n后章正文',
    }));
  });
}

/** 首章正常、下一章取不到:用来钉「自动阅读中出错 ⇒ 自动停」。
 * 刻意用 500 而不是 503/404/422/504 —— 那几个状态会触发 readerux42-A 的自动换源扇出,
 * 探测请求会混进「停下之后不再发任何请求」的断言口径(换源那条路径由 autoswitch 测试钉)。 */
function failingNextFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/read/source/index')) return json(catalog());
    const chapter = Number(param(url, 'chapter') ?? '0');
    if (chapter >= 1) return json({ error: '下一章取不到内容' }, 500);
    return json(part({ chapterIndex: 0, title: '第一章', text: '第一章\n正文内容' }));
  });
}

/** 正文容器上钉假视口尺寸:content 高度可变(章末接续后加高,模拟新章内容接上)。 */
function pinViewport(content: () => number, client: number): HTMLElement {
  const el = document.querySelector<HTMLElement>('main[aria-label="阅读正文"]');
  if (!el) throw new Error('找不到正文容器');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: content });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client });
  el.scrollTop = 0;
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // 预取关掉:预取的章节请求会混进「章末接续才发请求」的断言口径。
  window.localStorage.setItem('novel-finder-reading-settings', JSON.stringify({ preloadNext: false }));
});

afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('readerux42-B 自动阅读', () => {
  it('页脚开关与速度:默认关;开启后三档速度出现且「中」默认,可切「快」,再点停止', async () => {
    const apiFetch = simpleFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);

    const toggle = screen.getByRole('button', { name: '自动阅读' }) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('group', { name: '自动阅读速度' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const speeds = screen.getByRole('group', { name: '自动阅读速度' });
    const buttons = Array.from(speeds.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['慢', '中', '快']);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(buttons[2]);
    expect(buttons[2].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '停止自动' }));
    expect(screen.getByRole('button', { name: '自动阅读' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('group', { name: '自动阅读速度' })).toBeNull();
  });

  it('章末无缝接续:滚到章底自动 extend 下一章(请求发出、播放不中断),新内容接上后继续滚', async () => {
    const apiFetch = simpleFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);
    // 视口 500,首屏内容 520(滚 20px 到底);下一章载入后内容加高到 1520。
    let content = 520;
    const viewport = pinViewport(() => content, 500);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '自动阅读' }));
    fireEvent.click(screen.getByRole('button', { name: '快' })); // 150px/s ⇒ 15px/拍
    const before = urls(apiFetch).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    // 章底(remaining ≤ 4)⇒ 自动接续发出下一章请求,且新章正文渲染出来。
    // (fake 计时器下不用 findByText —— waitFor 依赖真实计时器会挂起。)
    const requested = urls(apiFetch).slice(before).filter((u) => u.startsWith('/api/read/source/chapter'));
    expect(requested.some((u) => param(u, 'chapter') === '1')).toBe(true);
    expect(screen.getByText(/后章正文/)).toBeTruthy();

    // 新内容接上(容器加高)后继续自动滚,播放不中断:滚动量增长且开关仍开。
    content = 1520;
    const start = viewport.scrollTop;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(viewport.scrollTop).toBeGreaterThan(start + 60);
    expect(screen.getByRole('button', { name: '停止自动' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('出错即停:自动阅读中取下一章失败,开关自动回到关,不再滚动也不再发请求', async () => {
    const apiFetch = failingNextFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);
    // 视口 500、内容 520(滚 20px 到章底)⇒ 自动阅读会去 extend 下一章,而下一章取不到。
    const viewport = pinViewport(() => 520, 500);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '自动阅读' }));
    fireEvent.click(screen.getByRole('button', { name: '快' })); // 150px/s ⇒ 15px/拍,两拍到章底
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    // 停下的是「出错」这条路径,不是「读到末尾」那条:错误条在,末尾提示不在。
    screen.getByText('下一章取不到内容');
    expect(screen.queryByText(textIs('已读到全书末尾，自动阅读停止。'))).toBeNull();
    // 开关自己回到关(不是停在「开但不滚」的假活状态):速度组收起、按钮回到未按下态。
    expect(screen.getByRole('button', { name: '自动阅读' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('button', { name: '停止自动' })).toBeNull();
    expect(screen.queryByRole('group', { name: '自动阅读速度' })).toBeNull();

    // 停了就是停了:再走 2 秒,不滚动、不自行重试取章(重试只由用户点「重试」发起)。
    const after = urls(apiFetch).length;
    const stopped = viewport.scrollTop;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(viewport.scrollTop).toBe(stopped);
    expect(urls(apiFetch).slice(after)).toEqual([]);
  });

  it('最后一章滚到底:自动阅读停止并提示,不再发任何章节请求', async () => {
    const apiFetch = simpleFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);
    // 先翻到最后一章(第二章)。
    fireEvent.click(screen.getByRole('button', { name: '下一章 →' }));
    await screen.findByText(/后章正文/);
    pinViewport(() => 520, 500);
    const before = urls(apiFetch).length;

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '自动阅读' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(screen.getByRole('button', { name: '自动阅读' }).getAttribute('aria-pressed')).toBe('false');
    screen.getByText(textIs('已读到全书末尾，自动阅读停止。'));
    expect(urls(apiFetch).slice(before)).toEqual([]);
  });

  it('用户滚轮即接管:自动阅读开着时用户一滚,自动滚停(开关可再开)', async () => {
    const apiFetch = simpleFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);
    const viewport = pinViewport(() => 2000, 500);

    fireEvent.click(screen.getByRole('button', { name: '自动阅读' }));
    const toggle = screen.getByRole('button', { name: '停止自动' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.wheel(viewport, { deltaY: 120 });
    expect(screen.getByRole('button', { name: '自动阅读' }).getAttribute('aria-pressed')).toBe('false');
    // 再开回来:开关仍可用。
    fireEvent.click(screen.getByRole('button', { name: '自动阅读' }));
    expect(screen.getByRole('button', { name: '停止自动' }).getAttribute('aria-pressed')).toBe('true');
  });
});
