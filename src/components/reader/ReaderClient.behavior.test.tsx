// @vitest-environment jsdom
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReaderClient from './ReaderClient';

// 本仓首个 jsdom 组件测试(见 vitest.config.ts 的 esbuild.jsx=automatic 与 include):
// 真实 useReader 在 jsdom 下跑起来,只把网络面(apiFetch)、路由、纯样式模块换掉 ——
// 换源的状态流转正是靠 fetch 参数断言来钉。
//
// reader.module.css 桩掉:纯样式,且本机 PostCSS/Tailwind 插件链加载有问题、与渲染断言无关。
vi.mock('./reader.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }));
vi.mock('next/link', () => ({
  default: (props: { children?: unknown; href: unknown }) => createElement('a', { href: props.href }, props.children as ReactNode),
}));

const mocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), owner: {} as Record<string, unknown> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
// OwnerProvider 也桩成透传:真实实现会建 AuthController 并发认证请求,与本题无关。
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return {
    ...actual,
    OwnerProvider: (props: { children: unknown }) => props.children,
    useOwner: () => mocks.owner,
  };
});

// jsdom 未实现的 Web API:useReader 的 useLayoutEffect 会 new ResizeObserver,缺失即整棵
// ReaderSession 抛错、被 React 吞成空渲染;Panel 用 <dialog>.showModal。均为测试环境补齐,
// 不改被测代码。
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

// 源码里的中文标点已被规范化(裸逗号/句点/…),与测试里能直接敲出来的 ASCII 标点不同码点,
// 直接按字面量匹配会失配。这里把所有标点都折叠成 ASCII 再比 —— 只动标点,不动汉字。
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

function urls(apiFetch: { mock: { calls: unknown[][] } }): string[] {
  return apiFetch.mock.calls.map((call) => String(call[0]));
}

function ownerWith(apiFetch: ApiFetch) {
  return {
    ready: true, status: 'ready', user: { id: 5, canRead: true, canFind: true, canDownload: true } as never,
    permissions: { find: true, read: true, download: true }, authMethod: 'session', accountsEnabled: true,
    expired: false, sessionId: 1, sessionOnly: false, setSessionOnly: vi.fn(),
    submitToken: vi.fn(), login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    apiFetch, can: (permission: string) => permission === 'read',
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

describe('ReaderClient 换源:章节响应带 sourceSession ⇒ 后续章节改用新 session', () => {
  it('首段响应带 sourceSession 时,下一章请求的 session 换成新源(不再用旧 session)', async () => {
    // 服务端换源成功的形状(readSourceChapter):part.version 与 part.sourceSession 同为新源
    // 目录会话版本(source-reader.ts 里 `version: switched.version` 与 `sourceSession: switched.version`)。
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      const chapter = Number(new URLSearchParams(url.split('?')[1]).get('chapter') ?? '0');
      // 首章换源成功:part.version === part.sourceSession === 新源会话 'v2'(readSourceChapter 的形状);
      // 第二章按目录对齐,同样带新源 version/sourceId。
      return chapter === 0
        ? json(part({ version: 'v2', sourceSession: 'v2', sourceId: 'src-2', servedFrom: '源乙' }))
        : json(part({ chapterIndex: 1, title: '第二章', version: 'v2', sourceId: 'src-2', servedFrom: '源乙' }));
    });
    renderReader(apiFetch);

    await screen.findByText(/正文内容/);
    await waitFor(() => expect(urls(apiFetch).some((u) => u.includes('session=sess-A'))).toBe(true));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '下一章 →' }));

    // 第二章请求必须改用新源 session/version —— 换源的核心契约(洞 2 前端半边)。
    await waitFor(() => {
      const second = urls(apiFetch).filter((u) => u.includes('/chapter') && u.includes('chapter=1'));
      expect(second.length).toBeGreaterThan(0);
      expect(second.some((u) => u.includes('session=v2') && u.includes('version=v2'))).toBe(true);
      for (const u of second) expect(u).not.toContain('session=sess-A');
    });
  });

  it('首段不带 sourceSession(未换源)时,下一章沿用原 session —— 有变化才换', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      const chapter = Number(new URLSearchParams(url.split('?')[1]).get('chapter') ?? '0');
      return json(part({ chapterIndex: chapter, title: chapter === 0 ? '第一章' : '第二章' }));
    });
    renderReader(apiFetch);

    await screen.findByText(/正文内容/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '下一章 →' }));
    await waitFor(() => {
      const second = urls(apiFetch).filter((u) => u.includes('chapter=1'));
      expect(second.length).toBeGreaterThan(0);
      for (const u of second) expect(u).toContain('session=sess-A');
    });
  });
});

describe('ReaderClient 换源:错误码 ⇒ 用户可见文案与可重试/换源入口', () => {
  it('SOURCE_CHAPTER_UNAVAILABLE(503):错误条透出原文,并给「重试」与「换个书源」两个出口', async () => {
    const message = '本章暂不可读,备用书源也未找到相同章节。可重试或尝试「下载全书」。';
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      return json({ error: message, code: 'SOURCE_CHAPTER_UNAVAILABLE' }, 503);
    });
    renderReader(apiFetch);

    const alert = await screen.findByRole('alert');
    expect(squeeze(alert.textContent ?? '')).toContain(squeeze(message));
    // 503 是确认失败码之一 ⇒ 必须有「换个书源」出口,把用户「读这本书」的本意接住。
    expect(screen.getByRole('button', { name: '换个书源' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('SOURCE_TIMEOUT(504):错误条透出超时文案,「换个书源」不出现(504 不是确认失败码)', async () => {
    const message = '书源查询已取消或超时,可重试或尝试「下载全书」。';
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      return json({ error: message, code: 'SOURCE_TIMEOUT' }, 504);
    });
    renderReader(apiFetch);

    const alert = await screen.findByRole('alert');
    expect(squeeze(alert.textContent ?? '')).toContain(squeeze(message));
    // 504 不在 404/422/503 的确认失败码里,不该摆「换个书源」(误导:重试才有意义)。
    expect(screen.queryByRole('button', { name: '换个书源' })).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('ReaderClient 换源:换源面板 ok / miss / unreachable 及 partial 的渲染', () => {
  const panelBody = (sources: unknown[], over: Record<string, unknown> = {}) => ({ sources, partial: false, ...over });

  function sourceButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-status]'));
  }
  function buttonNamed(name: string): HTMLButtonElement {
    const found = sourceButtons().find((b) => squeeze(b.textContent ?? '').startsWith(name));
    if (!found) throw new Error('找不到书源按钮:' + name);
    return found;
  }

  async function openSourcePanel(apiFetch: FetchMock) {
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /换源/ }));
    return user;
  }

  it('ok / miss / unreachable 三态:各渲染对应文案,只有 ok 且非当前源可点', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      if (url.startsWith('/api/read/source/alternates')) {
        return json(panelBody([
          { sourceName: '源甲', status: 'ok', current: true, bookUrl: 'https://a.example/1', title: '诡秘之主', author: '乌贼', chapters: 2 },
          { sourceName: '源乙', status: 'ok', current: false, bookUrl: 'https://b.example/2', title: '诡秘之主', author: '乌贼', chapters: 3 },
          { sourceName: '源丙', status: 'miss', current: false, bookUrl: '' },
          { sourceName: '源丁', status: 'unreachable', current: false, bookUrl: '' },
        ]));
      }
      return json(part());
    });
    await openSourcePanel(apiFetch);

    // 三态各自的可用性文案落盘在各自的 data-status 上。
    await waitFor(() => expect(sourceButtons().length).toBe(4));
    const byStatus = (status: string) => sourceButtons().filter((b) => b.dataset.status === status);
    expect(byStatus('ok').length).toBe(2);
    expect(byStatus('miss').length).toBe(1);
    expect(byStatus('unreachable').length).toBe(1);
    const missBtn = byStatus('miss')[0];
    const unreachableBtn = byStatus('unreachable')[0];
    expect(squeeze(missBtn.textContent ?? '')).toContain(squeeze('该书源没有这本书'));
    expect(squeeze(unreachableBtn.textContent ?? '')).toContain(squeeze('该书源暂时无法访问'));

    // 可点性:当前源 disabled;非当前但 ok 的可点;miss/unreachable disabled。
    expect(buttonNamed('源甲').disabled).toBe(true); // current
    expect(buttonNamed('源乙').disabled).toBe(false);
    expect(buttonNamed('源丙').disabled).toBe(true);
    expect(buttonNamed('源丁').disabled).toBe(true);
    // ok 项展示书名/作者/章数,当前源带徽标。
    expect(squeeze(buttonNamed('源乙').textContent ?? '')).toContain(squeeze('诡秘之主 · 乌贼 · 3 章'));
    expect(screen.getByText(textIs('当前源'))).toBeTruthy();
  });

  it('partial=true:提示「部分书源未检测完」,可重新检测', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      if (url.startsWith('/api/read/source/alternates')) {
        return json(panelBody(
          [{ sourceName: '源乙', status: 'ok', current: false, bookUrl: 'https://b.example/2', title: '诡秘之主', author: '乌贼', chapters: 3 }],
          { partial: true },
        ));
      }
      return json(part());
    });
    await openSourcePanel(apiFetch);

    await screen.findByText(textIs('部分书源未检测完(预算或时间限制),可再次点击「重新检测」。'));
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy();
  });

  it('检测失败:面板内 role=alert 透出服务端错误原文', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      if (url.startsWith('/api/read/source/alternates')) return json({ error: '检测书源失败,请重试。' }, 500);
      return json(part());
    });
    await openSourcePanel(apiFetch);
    await waitFor(() => expect(squeeze(screen.getByRole('alert').textContent ?? '')).toContain(squeeze('检测书源失败')));
  });

  it('点可点的备用源:走确认重放换书(book_url 写进 index 请求)', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) {
        const bookUrl = new URLSearchParams(url.split('?')[1]).get('book_url');
        // 确认路径(带 book_url)返回「换过源的目录」:会话换成 sess-B(源 id 不变,便于 part 校验通过)。
        return json(bookUrl
          ? catalog({ source: { id: 'src-1', name: '源乙', url: 'https://b.example', session: 'sess-B' } })
          : catalog());
      }
      if (url.startsWith('/api/read/source/alternates')) {
        return json(panelBody([{ sourceName: '源乙', status: 'ok', current: false, bookUrl: 'https://b.example/2', title: '诡秘之主', author: '乌贼', chapters: 3 }]));
      }
      return json(part());
    });
    const user = await openSourcePanel(apiFetch);
    await waitFor(() => expect(sourceButtons().length).toBe(1));
    await user.click(buttonNamed('源乙'));

    // 换源发起:index 请求带上刚点选的 book_url。
    await waitFor(() => {
      expect(urls(apiFetch).some((u) => u.includes('book_url=https%3A%2F%2Fb.example%2F2'))).toBe(true);
    });
  });

  // MS-29 行为钉:换源面板以**当前源 session 为 key**,源会话一变就重挂、autoDone ref 归零、
  // 自动以新 session 重检。这里让面板保持打开(接着读按钮不关面板),后续章节带新 sourceSession
  // 触发 adoptSwitch ⇒ reading.index.source.session 变化 ⇒ 面板重挂并以新 session 再发一次
  // alternates。拿掉 key 时,面板不会重挂、不再重检(或沿用旧 session),本测试红。
  it('当前源会话变化时,打开着的换源面板自动以新 session 重检(MS-29)', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      if (url.startsWith('/api/read/source/alternates')) {
        return json(panelBody([{ sourceName: '源乙', status: 'ok', current: false, bookUrl: 'https://b.example/2', title: '诡秘之主', author: '乌贼', chapters: 3 }]));
      }
      const chapter = Number(new URLSearchParams(url.split('?')[1]).get('chapter') ?? '0');
      // 首章原源;接着读的下一章带新源 sourceSession='sess-B'(章内换源)。
      return chapter === 1
        ? json(part({ chapterIndex: 1, title: '第二章', version: 'sess-B', sourceSession: 'sess-B', sourceId: 'src-2', servedFrom: '源乙' }))
        : json(part());
    });
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /换源/ }));
    await waitFor(() => expect(sourceButtons().length).toBe(1));
    const before = urls(apiFetch).filter((u) => u.startsWith('/api/read/source/alternates'));
    expect(before.some((u) => u.includes('session=sess-A'))).toBe(true);

    // 面板仍开着:点「接着读下一章」加载带新 sourceSession 的下一章(extend 不关面板)。
    await user.click(screen.getByRole('button', { name: /接着读下一章/ }));

    // 源会话变了 ⇒ 面板重挂 ⇒ 再发一次 alternates,且带新 session。
    await waitFor(() => {
      const after = urls(apiFetch).filter((u) => u.startsWith('/api/read/source/alternates'));
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.some((u) => u.includes('session=sess-B'))).toBe(true);
    });
  });
});

describe('ReaderClient 换源:按标题对齐回原文(正确行为,非 H7)', () => {
  // 正确行为:同一个位置(章序号)在新源里换了一个标题不同的正文时,按目录对齐后前端应
  // 交付**服务端新源返回的正文**,而不是把旧源残留的正文当成结果。这里只钉「同一序号 + 新
  // 源响应 ⇒ 新源正文透出」,不去碰「换源后下一章用旧序号」这类 H7 问题(见下一组 H7 用例)。
  it('换源后按服务端返回渲染新源正文', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      const chapter = Number(new URLSearchParams(url.split('?')[1]).get('chapter') ?? '0');
      return chapter === 0
        ? json(part({ version: 'v2', sourceSession: 'v2', sourceId: 'src-2', servedFrom: '源乙', text: '第一章\n换源后的正文' }))
        : json(part({ chapterIndex: 1, title: '第二章', version: 'v2', sourceId: 'src-2', servedFrom: '源乙', text: '第二章\n续读正文' }));
    });
    renderReader(apiFetch);
    await screen.findByText(/换源后的正文/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '下一章 →' }));
    await screen.findByText(/续读正文/);
  });

});

// H7/F11:换源响应附带新源目录(switchedChapters)与本章在新目录的序号(switchedChapterIndex)时,
// 前端一次性替换旧目录并把位置迁过去 —— 之后的「下一章」/续读按**新目录**序号请求。
// 备用目录 [序言, 第一章, 第二章] 比原目录多一个「序言」:首章在新目录序号 1,下一章必须请求
// chapter=2(第二章);按旧段号 +1 会请求 chapter=1 —— 那在新目录里是「第一章」,即重复章。
// 断言一律只看**点击之后新增**的请求(先记点击前的请求数);预取关掉(preloadNext=false),
// 否则命中预取缓存的点击不发请求,点击前的预取又会混进来 —— 恒真用例正是这么来的。
describe('ReaderClient 换源:H7 新目录序号(点击后请求的真断言)', () => {
  const newChapters = [
    { index: 0, title: '序言', startByte: 0, endByte: 0, partCount: 1 },
    { index: 1, title: '第一章', startByte: 0, endByte: 0, partCount: 1 },
    { index: 2, title: '第二章', startByte: 0, endByte: 0, partCount: 1 },
  ];
  const param = (url: string, key: string) => new URLSearchParams(url.split('?')[1]).get(key);
  const chapterUrlsSince = (apiFetch: FetchMock, from: number) =>
    urls(apiFetch).slice(from).filter((u) => u.startsWith('/api/read/source/chapter'));

  // 原源(sess-A)的首章换源成功:交付段按请求的旧序号标记(chapterIndex=0、标题取旧目录),
  // 与服务端 readSourceChapter 同形;新 session(v2)的请求按新目录序号交付。
  function switchingFetch() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      if (param(url, 'session') === 'sess-A') {
        return json(part({
          version: 'v2', sourceSession: 'v2', sourceId: 'src-2', servedFrom: '源乙',
          switchedChapters: newChapters, switchedChapterIndex: 1,
        }));
      }
      const chapter = Number(param(url, 'chapter') ?? '0');
      const title = newChapters[chapter]?.title ?? '未知章';
      return json(part({ chapterIndex: chapter, title, version: 'v2', sourceId: 'src-2', servedFrom: '源乙', text: title + '\n新目录正文' }));
    });
  }

  beforeEach(() => {
    window.localStorage.setItem('novel-finder-reading-settings', JSON.stringify({ preloadNext: false }));
  });

  it('① 页脚先落到迁移后的章,再点「下一章」⇒ 点击只请求新目录「迁移目标+1」且带新 session,不发重复章', async () => {
    const apiFetch = switchingFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);
    // 先等显示的章节等于迁移后的目标:新目录序号 1 ⇒ 页脚「第 2 / 3 章」。
    await screen.findByText('第 2 / 3 章');

    const before = urls(apiFetch).length;
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '下一章 →' }));
    await screen.findByRole('region', { name: '第二章' });

    const clicked = chapterUrlsSince(apiFetch, before);
    expect(clicked).toHaveLength(1);
    expect(param(clicked[0], 'chapter')).toBe('2');
    expect(param(clicked[0], 'session')).toBe('v2');
    // 负对照:重复章(新目录序号 1 =「第一章」+ 新 session)一次也不许请求。
    expect(clicked.filter((u) => param(u, 'chapter') === '1' && param(u, 'session') === 'v2')).toEqual([]);
  });

  it('② 时序窗口:换源正文一出现就立即点「下一章」(不等任何后续状态)⇒ 不得请求重复章', async () => {
    const apiFetch = switchingFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);

    const next = screen.getByRole('button', { name: '下一章 →' }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    const before = urls(apiFetch).length;
    fireEvent.click(next);
    await screen.findByRole('region', { name: '第二章' });

    const clicked = chapterUrlsSince(apiFetch, before);
    expect(clicked.map((u) => param(u, 'chapter'))).toEqual(['2']);
    expect(clicked.filter((u) => param(u, 'chapter') === '1' && param(u, 'session') === 'v2')).toEqual([]);
  });

  it('③ 续读:换源刚采纳就点「接着读下一章」⇒ 只请求新目录序号 2,不发重复章', async () => {
    const apiFetch = switchingFetch();
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);

    const before = urls(apiFetch).length;
    fireEvent.click(screen.getByRole('button', { name: /接着读下一章/ }));
    await screen.findByRole('region', { name: '第二章' });

    const clicked = chapterUrlsSince(apiFetch, before);
    expect(clicked.map((u) => param(u, 'chapter'))).toEqual(['2']);
    expect(param(clicked[0], 'session')).toBe('v2');
  });
});

describe('ReaderClient 状态流转边界', () => {
  it('首屏(目录未回来)loading 态:状态栏说准备中,正文区给「一页书,一段光阴」', () => {
    const apiFetch = vi.fn(() => new Promise<Response>(() => {}));
    renderReader(apiFetch);
    expect(screen.getByText(textIs('正在准备目录与正文,首次打开可能需要一点时间...'))).toBeTruthy();
    expect(screen.getByText(textIs('一页书,一段光阴'))).toBeTruthy();
  });

  it('正文就绪:「换源」按钮可点开面板,章节内容渲染出来', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/read/source/index')) return json(catalog());
      if (url.startsWith('/api/read/source/alternates')) return json({ sources: [], partial: false });
      return json(part());
    });
    renderReader(apiFetch);
    await screen.findByText(/正文内容/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /换源/ }));
    expect(await screen.findByRole('dialog', { name: '切换书源' })).toBeTruthy();
  });
});
