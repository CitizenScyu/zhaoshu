// @vitest-environment jsdom
// 手动刷新可取消（statsrc42）：刷新按钮与首次 effect 共用同一可取消生命周期。
// 覆盖：刷新后离开页面 → 在途请求被 abort；迟到结果不追加渲染/不触发
// /api/admin/download-stats 连锁；正常刷新仍工作；连续刷新前一条被后一条中止。
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import StatsTab from './StatsTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});

// 文案含中文标点（规范化成裸字符），按字面量匹配会失配；去掉所有非字母数字汉字再比。
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

/** 真实 /api/stats 的最小形状。allowedSections 含 tokens → 会连锁拉 /api/admin/download-stats，
 * 迟到的连锁请求正是本文件要断言「不再发生」的对象。 */
function statsBody(over: Record<string, unknown> = {}) {
  return {
    subject: { userId: 5 },
    allowedSections: ['library', 'download', 'find', 'shelf', 'shuyuan', 'tokens'],
    sectionStates: {
      library: 'ok', download: 'ok', find: 'ok', shelf: 'ok', shuyuan: 'ok', tokens: 'ok',
    },
    sectionScopes: {
      library: 'shared', download: 'personal', find: 'personal', shelf: 'personal', shuyuan: 'shared', tokens: 'shared-owner',
    },
    library: { total: 12, withQuality: 3, avgQuality: 7.5, charsLabeled: 5540000, genres: [{ name: '玄幻', count: 4 }] },
    download: { total: 2, done: 1, chapters: 100, chars: 20000 },
    find: { queries: 8, recommendations: 20 },
    shelf: { statuses: [{ name: 'want', count: 3 }] },
    shuyuan: null,
    tokens: null,
    availability: { library: true, download: true, find: true, shelf: true, shuyuan: false, tokens: true },
    ...over,
  };
}

const QUEUE = {
  total: 2,
  groups: [{
    requestedBy: 'user', total: 2, share: 1, leaseExpiredRate: 0,
    states: { pending: 0, running: 1, done: 1, partial: 0, failed: 0, leaseExpired: 0 },
    retries: 0, withArtifact: 1,
  }],
};

/** 首次加载即可完成的 apiFetch 桩（链式拉到 download-stats）。 */
function settledFetchMock(): FetchMock {
  return vi.fn<ApiFetch>(async (input) => {
    if (String(input).includes('/api/admin/download-stats')) return json(QUEUE);
    return json(statsBody());
  }) as FetchMock;
}

function renderTab(apiFetch: FetchMock) {
  mocks.owner = {
    ready: true, status: 'ready', user: { id: 5 }, permissions: { find: true, read: true, download: true },
    authMethod: 'session', accountsEnabled: true, expired: false, sessionId: 1, sessionOnly: false,
    setSessionOnly: vi.fn(), submitToken: vi.fn(), login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    apiFetch, can: () => true,
  };
  return render(<StatsTab />);
}

const statsCalls = (apiFetch: FetchMock) =>
  apiFetch.mock.calls.filter((call) => String(call[0]).startsWith('/api/stats')).length;
const queueCalls = (apiFetch: FetchMock) =>
  apiFetch.mock.calls.filter((call) => String(call[0]).includes('/api/admin/download-stats')).length;

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('StatsTab 手动刷新可取消', () => {
  it('正常路径：点「刷新统计」重新拉 /api/stats 并照常渲染新结果与队列统计', async () => {
    const apiFetch = settledFetchMock();
    renderTab(apiFetch);
    // 首次加载完成：统计卡出现，连锁的队列统计也回来。
    expect(await screen.findByText('玄幻')).toBeTruthy();
    await waitFor(() => expect(queueCalls(apiFetch)).toBe(1));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: textIs('刷新统计') }));
    await waitFor(() => expect(statsCalls(apiFetch)).toBe(2));
    await waitFor(() => expect(queueCalls(apiFetch)).toBe(2));
    // 刷新后统计仍照常显示。
    expect(await screen.findByText('玄幻')).toBeTruthy();
  });

  it('刷新后离开页面：在途 /api/stats 被中止（signal.aborted=true），迟到响应不触发连锁', async () => {
    // 手动挂起 /api/stats：拿到调用时的 signal，直到测试主动放行。
    const releaseStats: Array<(body: unknown) => void> = [];
    const seenSignals: AbortSignal[] = [];
    const apiFetch = vi.fn<ApiFetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/stats')) {
        seenSignals.push(init?.signal as AbortSignal);
        const body = await new Promise<unknown>((resolve) => { releaseStats.push(resolve); });
        return json(body);
      }
      return json(QUEUE);
    }) as FetchMock;
    renderTab(apiFetch);

    const user = userEvent.setup();
    // 首次 effect 完成后按钮才可点（loading=false），第一次放行。
    await waitFor(() => expect(seenSignals.length).toBe(1));
    releaseStats[0](statsBody());
    await screen.findByText('玄幻');
    await waitFor(() => expect(queueCalls(apiFetch)).toBe(1));

    // 点刷新：第二次 /api/stats 在途。
    await user.click(screen.getByRole('button', { name: textIs('刷新统计') }));
    await waitFor(() => expect(seenSignals.length).toBe(2));
    expect(seenSignals[1].aborted).toBe(false);

    // 离开页面：卸载 cleanup 应中止在途手动刷新请求。
    cleanup();
    await waitFor(() => expect(seenSignals[1].aborted).toBe(true));
    // 迟到响应到达也不该再发起 /api/admin/download-stats 连锁。
    releaseStats[1](statsBody());
    await new Promise((r) => setTimeout(r, 20));
    expect(queueCalls(apiFetch)).toBe(1); // 只有首次加载那一条
  });

  it('迟到响应（abort 后才 resolve）不覆盖错误态、不追加队列统计', async () => {
    // 首次加载立即失败（渲染出错误），随后手动刷新挂起，卸载后再放行一个「成功」响应。
    let releaseStats: ((body: unknown) => void) | null = null;
    let call = 0;
    const apiFetch = vi.fn<ApiFetch>(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/stats')) {
        call += 1;
        if (call === 1) return json({ error: '统计加载失败(503)' }, 503);
        const body = await new Promise<unknown>((resolve) => { releaseStats = resolve; });
        return json(body);
      }
      return json(QUEUE);
    }) as FetchMock;
    const view = renderTab(apiFetch);
    const alert = await screen.findByRole('alert');
    expect(squeeze(alert.textContent ?? '')).toContain(squeeze('统计加载失败'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: textIs('刷新统计') }));
    await waitFor(() => expect(statsCalls(apiFetch)).toBe(2));
    view.unmount();

    // 卸载后迟到成功响应到达：不渲染新统计（组件已卸载，只验证不抛、不连锁）。
    releaseStats!(statsBody());
    await new Promise((r) => setTimeout(r, 20));
    expect(queueCalls(apiFetch)).toBe(0); // 错误响应无 tokens 权限路径，连锁从未发起
  });

  it('连续两次刷新：前一条手动刷新被后一条中止', async () => {
    const seenSignals: AbortSignal[] = [];
    const releaseFns: Array<(body: unknown) => void> = [];
    const apiFetch = vi.fn<ApiFetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/stats')) {
        seenSignals.push(init?.signal as AbortSignal);
        return json(await new Promise<unknown>((resolve) => { releaseFns.push(resolve); }));
      }
      return json(QUEUE);
    }) as FetchMock;
    renderTab(apiFetch);

    const user = userEvent.setup();
    // 首次 effect 完成，按钮恢复可用。
    await waitFor(() => expect(seenSignals.length).toBe(1));
    releaseFns[0](statsBody());
    await screen.findByText('玄幻');

    // 第一次刷新挂起（signal[1]）；loading 中按钮禁用，等待其返回后立即再刷。
    await user.click(screen.getByRole('button', { name: textIs('刷新统计') }));
    await waitFor(() => expect(seenSignals.length).toBe(2));
    expect(seenSignals[1].aborted).toBe(false);
    // 放行第一次刷新 → loading 结束。
    releaseFns[1](statsBody());
    await waitFor(() => expect(seenSignals[1].aborted).toBe(false));
    // 第二次刷新：refresh 先 abort 上一条（signal[1]），再发新请求（signal[2]）。
    const refreshButton = () => screen.getByRole('button', { name: textIs('刷新统计') }) as HTMLButtonElement;
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    await user.click(refreshButton());
    await waitFor(() => expect(seenSignals.length).toBe(3));
    expect(seenSignals[1].aborted).toBe(true); // 前一条被后一条中止
    expect(seenSignals[2].aborted).toBe(false);
    releaseFns[2](statsBody());
    await screen.findByText('玄幻');
  });
});
