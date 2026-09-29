// @vitest-environment jsdom
// cancel53 竞态复现：先用真实组件 + 可控兑现顺序的合成 apiFetch，验证任务书 4 项场景在原版真实失败。
// 每条用例只做「复现」：断言当前版本的错误行为（失败红），修复后同文件用例应转绿（见 fix 标注的断言方向）。
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShuyuanTab from './ShuyuanTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});

const squeeze = (s: string) => s.replace(/[^0-9A-Za-z㐀-䶿一-鿿]/g, '');
function textIs(expected: string) {
  const want = squeeze(expected);
  return (_content: string, element: Element | null) => element !== null && squeeze(element.textContent ?? '') === want;
}

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function statsPage(over: Record<string, unknown> = {}) {
  return {
    total: 100, active: 5, enabled: 90, disabled: 10,
    unprobed: 80, pending: 3, reachable: 7, failed: 10,
    collections: [{ id: 1, title: '合集甲', count: 60 }],
    refreshedAt: '2026-09-20T00:00:00.000Z',
    sourcesLimit: 20,
    sources: [{
      url: 'https://a.example', name: '源甲', disabled: false, availability: 'reachable',
      lastError: '', checkedAt: '2026-09-20T00:00:00.000Z', probeError: null,
    }],
    filter: 'all', page: 1, pageSize: 20, totalPages: 5,
    ...over,
  };
}

/** 手动兑现的 promise：new Promise + resolve 句柄，测试按需放行。 */
function manual<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Recorded {
  url: string; method: string; signal: AbortSignal | null | undefined;
  headers: manual<Response>;
  body: manual<unknown>;
}

/**
 * 记录每次 apiFetch 调用；合成 Response：响应头（apiFetch 返回）与 res.json()（读体）
 * 各自手动兑现——测试可以精确控制「POST 等待」与「正文等待」两个窗口。
 */
function makeScriptedFetch() {
  const calls: Recorded[] = [];
  const apiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const recorded: Recorded = {
      url: String(input), method: init?.method ?? 'GET', signal: init?.signal,
      headers: manual<Response>(), body: manual<unknown>(),
    };
    calls.push(recorded);
    const res = await recorded.headers.promise;
    // res.json() 独立兑现（读体时机与响应头时机解耦）；ok/status 取自 headers 兑现值。
    return { ok: res.ok, status: res.status, json: () => recorded.body.promise } as unknown as Response;
  }) as unknown as ApiFetch & { mock: { calls: unknown[][] } };
  return { apiFetch, calls };
}

/** 首屏加载：等 effect 的 queueMicrotask 发起 GET，再立即兑现 headers+body。 */
async function resolveFirstLoad(calls: Recorded[]) {
  await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
  const first = calls[0];
  await act(async () => {
    first.headers.resolve(json(statsPage()));
    first.body.resolve(statsPage());
  });
}

function renderTab(apiFetch: ApiFetch & { mock: { calls: unknown[][] } }) {
  mocks.owner = {
    ready: true, status: 'ready', user: null, permissions: { find: false, read: false, download: false },
    authMethod: null, accountsEnabled: true, expired: false, sessionId: 0, sessionOnly: false,
    setSessionOnly: vi.fn(), submitToken: vi.fn(), login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    apiFetch, can: () => false,
  };
  return render(<ShuyuanTab />);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('场景1:POST/读体期间卸载,旧响应兑现后不得发起新列表 GET', () => {
  it('refresh:POST 响应体兑现前卸载——兑现后不得出现新的列表 GET', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    const { unmount } = renderTab(apiFetch);
    const user = userEvent.setup();

    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    // 点刷新:POST 挂起(未兑现)。
    await user.click(screen.getByRole('button', { name: '刷新合集' }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].method).toBe('POST');

    // POST 期间卸载。
    unmount();

    // 旧 POST 兑现成功(响应头+读体都完成)。
    await act(async () => {
      calls[1].headers.resolve({ ok: true, status: 200 } as unknown as Response);
      calls[1].body.resolve({ ok: true });
    });
    await act(async () => {}); // 让微任务队列走完

    // 关键断言:兑现后没有新 GET 被发起(总调用数仍是 2:首屏 GET + POST)。
    expect(calls.length).toBe(2);
  });
});

describe('场景2:旧筛选上的手动操作未完成时切筛选,新列表先返回,旧操作后兑现', () => {
  it('toggle:旧 POST 闭包持有旧 filter/page,兑现后不得覆盖新视图', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    const user = userEvent.setup();

    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    // 在 all 筛选下点「禁用」:POST 挂起。
    await user.click(screen.getByRole('button', { name: '禁用' }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].method).toBe('POST');

    // 用户切到「已禁用」筛选:effect 发新 GET(calls[2]),挂起。
    await user.click(screen.getByRole('button', { name: textIs('已禁用 10') }));
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls[2].method).toBe('GET');
    expect(calls[2].url).toBe('/api/shuyuan?filter=disabled&page=1');

    // 新列表先返回(disabled 筛选下 10 条,第 1 页)。
    const disabledView = statsPage({
      total: 10, enabled: 0, disabled: 10, filter: 'disabled',
      sources: [{ url: 'https://a.example', name: '源甲', disabled: true, availability: 'reachable', lastError: '', checkedAt: null, probeError: null }],
    });
    await act(async () => {
      calls[2].headers.resolve(json(disabledView));
      calls[2].body.resolve(disabledView);
    });
    await screen.findByText(textIs('已禁用的书源'));
    await screen.findByText(textIs('共 10 条,第 1 / 1 页'));

    // 旧 POST 现在兑现成功:它将用旧闭包的 {filter:'all', page:1} 发起 load。
    await act(async () => {
      calls[1].headers.resolve({ ok: true, status: 200 } as unknown as Response);
      calls[1].body.resolve({ disabled: true });
    });
    // 旧操作发起的 GET 已发出(行为本身允许),但它拿旧 filter。
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(3));
    const stale = calls[3];
    expect(stale.url).toBe('/api/shuyuan?filter=all&page=1');

    // 关键断言(修复后):旧操作不得覆盖当前视图——stale 响应兑现不得把 stats 写回 all 视图。
    // 原版行为:load 无视图代守卫,stale 响应兑现会把 stats 写回 all 视图 ⇒ 真实失败。
    await act(async () => {
      stale.headers.resolve(json(statsPage()));
      stale.body.resolve(statsPage());
    });
    // 检查页脚:应仍显示 disabled 视图(共 10 条),而非 all 视图(共 100 条)。
    const footer = screen.getByText(textIs('共 10 条,第 1 / 1 页'));
    expect(footer).toBeTruthy();
  });
});

describe('场景3:仅取消客户端请求,服务端写入已发生——不宣称回滚,当前视图可见实际状态', () => {
  it('toggle POST 已成功(写入已发生),客户端中止不得回滚显示;视图恢复应能看到实际状态', async () => {
    // 行为保留项:这条只验证既有语义没被修复破坏——写入成功后刷新列表可见实际状态。
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    const user = userEvent.setup();
    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: '禁用' }));
    await waitFor(() => expect(calls[1]?.method).toBe('POST'));
    await act(async () => {
      calls[1].headers.resolve({ ok: true, status: 200 } as unknown as Response);
      calls[1].body.resolve({ disabled: true });
    });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(2));

    // 重载返回禁用后的列表:源显示「已禁用」。
    const afterToggle = statsPage({
      sources: [{ url: 'https://a.example', name: '源甲', disabled: true, availability: 'reachable', lastError: '', checkedAt: null, probeError: null }],
    });
    await act(async () => {
      calls[2].headers.resolve(json(afterToggle));
      calls[2].body.resolve(afterToggle);
    });
    expect(screen.getByText('已禁用')).toBeTruthy();
  });
});

describe('场景4:旧请求失败/finally 不得迟到覆盖新交互状态', () => {
  it('refresh 的 finally 迟到:setRefreshing(false) 不得影响新操作;旧失败 setError 不得覆盖新视图', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    const user = userEvent.setup();
    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    // 第一次刷新:POST 挂起。
    await user.click(screen.getByRole('button', { name: '刷新合集' }));
    await waitFor(() => expect(calls[1]?.method).toBe('POST'));

    // POST 兑现 500(旧操作将失败 setError)。
    await act(async () => {
      calls[1].headers.resolve({ ok: false, status: 500 } as unknown as Response);
      calls[1].body.resolve({ error: '上游不可达' });
    });
    // 失败后的 load 不应发生(POST 失败即抛)。
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('上游不可达'));

    // 新交互:切筛选(新视图加载成功),旧错误应被清掉。
    await user.click(screen.getByRole('button', { name: textIs('已禁用 10') }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    const disabledView = statsPage({ total: 10, enabled: 0, disabled: 10, filter: 'disabled' });
    await act(async () => {
      const last = calls.at(-1)!;
      last.headers.resolve(json(disabledView));
      last.body.resolve(disabledView);
    });
    await screen.findByText(textIs('共 10 条,第 1 / 1 页'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
