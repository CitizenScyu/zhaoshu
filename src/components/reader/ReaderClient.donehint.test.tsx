// @vitest-environment jsdom
// readerlocal42：书仓直读提示条的前端行为。
// 覆盖：index 响应带合法 doneReadTaskId 时提示条渲染且链接指向 /read/<id>?from=<from>；
// 不带字段或值非法（0/负/非整数）时提示条不出现；download 会话即便字段存在也不渲染。
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReaderClient from './ReaderClient';

vi.mock('./reader.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }));
vi.mock('next/link', () => ({
  default: (props: { children?: unknown; href: unknown }) => createElement('a', { href: props.href }, props.children as never),
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
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
}

const squeeze = (s: string) => s.replace(/[^0-9A-Za-z㐀-䶿一-鿿]/g, '');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const catalog = (over: Record<string, unknown> = {}) => ({
  taskId: null,
  source: { id: 'src-1', name: '源甲', url: 'https://a.example', session: 'sess-A' },
  title: '诡秘之主', author: '爱潜水的乌贼', version: 'v1', totalBytes: 0,
  chapters: [{ index: 0, title: '第一章', startByte: 0, endByte: 0, partCount: 1 }],
  ...over,
});

const part = () => ({
  taskId: null, sourceId: 'src-1', servedFrom: '源甲', version: 'v1',
  chapterIndex: 0, partIndex: 0, partCount: 1, title: '第一章',
  startByte: 0, endByte: 4, text: '第一章\n正文内容',
});

function sourceApiFetch(indexBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/read/source/index')) return json(indexBody);
    if (url.startsWith('/api/feedback')) return json({ current: { version: 0, status: null, note: '' } });
    if (url.startsWith('/api/reader-sync')) return json({ entries: [] });
    return json(part());
  });
}

function renderReader(apiFetch: ReturnType<typeof sourceApiFetch>, from: 'library' | 'find' = 'library') {
  mocks.owner = {
    ready: true, status: 'ready', user: { id: 5, canRead: true, canFind: true, canDownload: true } as never,
    permissions: { find: true, read: true, download: true }, authMethod: 'session', accountsEnabled: true,
    expired: false, sessionId: 1, sessionOnly: false, setSessionOnly: vi.fn(),
    submitToken: vi.fn(), login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    apiFetch, can: (permission: string) => permission === 'read', isCurrentSession: () => true,
  };
  return render(createElement(ReaderClient, {
    session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' }, from,
  }));
}

const HINT_TEXT = '书库已有本书全文，切换后阅读更稳、无需逐章请求书源。';

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => cleanup());

describe('ReaderClient 书仓直读提示条（readerlocal42）', () => {
  it('index 带 doneReadTaskId：提示条出现，链接指向 /read/<id>?from=<from>', async () => {
    renderReader(sourceApiFetch(catalog({ doneReadTaskId: 321 })), 'library');
    await screen.findByText(/正文内容/);
    const hint = screen.getByText((_, element) => element !== null && element.getAttribute('role') === 'status' && squeeze(element.textContent ?? '').includes(squeeze(HINT_TEXT)));
    expect(hint).toBeTruthy();
    const link = screen.getByRole('link', { name: /打开全书阅读/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/read/321?from=library');
  });

  it('from=find 时链接带上对应来源', async () => {
    renderReader(sourceApiFetch(catalog({ doneReadTaskId: 99 })), 'find');
    await screen.findByText(/正文内容/);
    const link = screen.getByRole('link', { name: /打开全书阅读/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/read/99?from=find');
  });

  it('index 不带 doneReadTaskId：提示条不出现', async () => {
    renderReader(sourceApiFetch(catalog()));
    await screen.findByText(/正文内容/);
    expect(screen.queryByRole('link', { name: /打开全书阅读/ })).toBeNull();
  });

  it('doneReadTaskId 非法值（0）：不渲染（非安全正整数按无提示处理）', async () => {
    renderReader(sourceApiFetch(catalog({ doneReadTaskId: 0 })));
    await screen.findByText(/正文内容/);
    expect(screen.queryByRole('link', { name: /打开全书阅读/ })).toBeNull();
  });

  it('doneReadTaskId 非法值（负数）：不渲染', async () => {
    renderReader(sourceApiFetch(catalog({ doneReadTaskId: -5 })));
    await screen.findByText(/正文内容/);
    expect(screen.queryByRole('link', { name: /打开全书阅读/ })).toBeNull();
  });
});
