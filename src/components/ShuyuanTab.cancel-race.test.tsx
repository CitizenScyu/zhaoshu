// @vitest-environment jsdom
// cancel53 竞态回归：真实组件 + 可控兑现顺序的合成 apiFetch。
// 断言的是最终视图/请求语义（不锁死「必须发哪个 GET」的实现细节）：
//   场景1 矩阵 refresh/toggle × 响应头等待/读体等待——卸载后 POST signal 必须已中止、
//         兑现后不得再发新列表 GET；
//   场景2  旧操作兑现时视图已切走——迟到的请求只允许服务于当前视图，旧视图数据不得覆盖；
//   场景2b A→B→A——切回旧视图后，旧一轮 A 的迟到响应不得覆盖新一轮 A 的数据（需代际守卫）；
//   场景3  行为保留：启停成功后重载可见实际状态（无实际取消，不涉回滚语义）；
//   场景4  新视图先完成、旧操作后失败/gone——迟到的错误与提示不得覆盖新视图状态。
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
const disabledSource = {
  url: 'https://a.example', name: '源甲', disabled: true, availability: 'reachable',
  lastError: '', checkedAt: null, probeError: null,
};

type Manual<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

/** 手动兑现的 promise：new Promise + resolve 句柄，测试按需放行。 */
function manual<T>(): Manual<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Recorded {
  url: string; method: string; signal: AbortSignal | null | undefined;
  headers: Manual<Response>;
  body: Manual<unknown>;
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

/** 让已兑现 promise 的后续微任务链走完（组件里的多段 await 各占一拍）。 */
async function drain() {
  await act(async () => {});
  await act(async () => {});
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

/** 点按钮发起手动操作并等到 POST 记录入账，返回 POST 的 Recorded。 */
async function startAction(calls: Recorded[], button: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: button }));
  const post = await waitFor(() => {
    const found = calls.find((c) => c.method === 'POST');
    expect(found).toBeTruthy();
    return found!;
  });
  return post;
}

const okHeaders = { ok: true, status: 200 } as unknown as Response;

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

// 场景1 矩阵：refresh/toggle × 响应头等待/读体等待。卸载后两件事必须成立：
// ① POST 收到的 signal 已中止（请求本体接入 actionAbort——卸载不该让请求继续跑完全程）；
// ② 旧操作兑现后不得再发新的列表 GET（卸载后的组件不发新请求）。
describe.each([
  { name: 'refresh·响应头等待窗口', action: '刷新合集', window: 'headers' as const },
  { name: 'refresh·读体等待窗口', action: '刷新合集', window: 'body' as const },
  { name: 'toggle·响应头等待窗口', action: '禁用', window: 'headers' as const },
  { name: 'toggle·读体等待窗口', action: '禁用', window: 'body' as const },
])('场景1:$name 卸载', ({ action, window }) => {
  it('卸载后 POST signal 已中止,兑现后无新 GET', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    const { unmount } = renderTab(apiFetch);

    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    const post = await startAction(calls, action);
    if (window === 'body') {
      // 读体窗口：响应头已兑现、组件正 await res.json() 时卸载。
      await act(async () => { post.headers.resolve(okHeaders); });
    }
    unmount();

    // ① 卸载即中止 POST 请求本体（真实 AbortSignal 的 aborted 标志）。
    expect(post.signal?.aborted).toBe(true);

    // ② 旧操作完整兑现成功后，不再发新的列表 GET（总调用数不变）。
    const before = calls.length;
    await act(async () => {
      if (window === 'headers') post.headers.resolve(okHeaders);
      post.body.resolve({ ok: true, disabled: true });
    });
    await drain();
    expect(calls.length).toBe(before);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1); // 只有首屏 GET
  });
});

describe('场景2:旧筛选上的手动操作未完成时切筛选,新列表先返回,旧操作后兑现', () => {
  it('toggle:旧 POST 兑现后的任何迟到请求只允许服务当前视图,旧视图数据不得覆盖', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    const user = userEvent.setup();

    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    // 在 all 筛选下点「禁用」:POST 挂起。
    const post = await startAction(calls, '禁用');

    // 用户切到「已禁用」筛选:effect 发新 GET,先返回(disabled 视图 10 条)。
    await user.click(screen.getByRole('button', { name: textIs('已禁用 10') }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    const disabledView = statsPage({
      total: 10, enabled: 0, disabled: 10, filter: 'disabled', sources: [disabledSource],
    });
    const viewGet = calls.filter((c) => c.method === 'GET')[1];
    await act(async () => {
      viewGet.headers.resolve(json(disabledView));
      viewGet.body.resolve(disabledView);
    });
    await screen.findByText(textIs('已禁用的书源'));
    await screen.findByText(textIs('共 10 条,第 1 / 1 页'));

    // 旧 POST 现在兑现:它闭包里还是 {filter:'all', page:1}。
    const getsBefore = calls.filter((c) => c.method === 'GET').length;
    await act(async () => {
      post.headers.resolve(okHeaders);
      post.body.resolve({ disabled: true });
    });
    await drain();

    // 断言语义而非实现:旧操作兑现后若还发 GET,只允许刷新**当前**视图(disabled);
    // 不允许再拿旧闭包的 filter=all 去发。也不写回旧视图数据——页脚仍是 disabled。
    const lateGets = calls.filter((c) => c.method === 'GET').slice(getsBefore);
    for (const g of lateGets) expect(g.url).toBe('/api/shuyuan?filter=disabled&page=1');
    expect(screen.getByText(textIs('共 10 条,第 1 / 1 页'))).toBeTruthy();
  });
});

describe('场景2b:A→B→A——切回旧视图后,旧一轮 A 的迟到响应不得覆盖新一轮 A', () => {
  it('refresh 的重载在 all 上挂起,经 disabled 绕回 all 后,旧响应(代际过期)不写回', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    const user = userEvent.setup();

    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    // 刷新:POST 兑现后组件用当时的 {all,1} 发重载 GET,让它挂起(模拟慢响应)。
    const post = await startAction(calls, '刷新合集');
    await act(async () => {
      post.headers.resolve(okHeaders);
      post.body.resolve({ ok: true });
    });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    const staleReload = calls.filter((c) => c.method === 'GET')[1];
    expect(staleReload.url).toBe('/api/shuyuan?filter=all&page=1');

    // A→B:切 disabled,effect GET 兑现,disabled 视图可见。
    await user.click(screen.getByRole('button', { name: textIs('已禁用 10') }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3));
    const disabledView = statsPage({
      total: 10, enabled: 0, disabled: 10, filter: 'disabled', sources: [disabledSource],
    });
    const bGet = calls.filter((c) => c.method === 'GET')[2];
    await act(async () => {
      bGet.headers.resolve(json(disabledView));
      bGet.body.resolve(disabledView);
    });
    await screen.findByText(textIs('共 10 条,第 1 / 1 页'));

    // B→A:切回 all,effect 发新一轮 A 的 GET,先兑现(刷新后总数 120)。
    // 注:disabled 视图的分页 total=10 也会顶到「全部」标签上(count-label 任务的已知缺陷),
    // 这里按当前行为选按钮,不锁死标签语义。
    await user.click(screen.getByRole('button', { name: /^全部/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(4));
    const freshA = statsPage({ total: 120, enabled: 108, disabled: 12 });
    const aGet = calls.filter((c) => c.method === 'GET')[3];
    await act(async () => {
      aGet.headers.resolve(json(freshA));
      aGet.body.resolve(freshA);
    });
    await screen.findByText(textIs('共 120 条,第 1 / 6 页'));

    // 旧一轮 A 的重载现在才兑现(total=999 作标记):值比较会放行(都是 all/1),
    // 只有代际守卫能拒绝——不得把页脚覆盖回旧数据。
    await act(async () => {
      staleReload.headers.resolve(json(statsPage({ total: 999 })));
      staleReload.body.resolve(statsPage({ total: 999 }));
    });
    await drain();
    expect(screen.getByText(textIs('共 120 条,第 1 / 6 页'))).toBeTruthy();
  });
});

describe('场景3(行为保留):启停成功后重载可见实际状态', () => {
  it('toggle 成功(服务端写入已发生)后,重载列表显示已禁用——保留既有语义', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    const post = await startAction(calls, '禁用');
    await act(async () => {
      post.headers.resolve(okHeaders);
      post.body.resolve({ disabled: true });
    });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    const afterToggle = statsPage({ sources: [disabledSource] });
    const reload = calls.filter((c) => c.method === 'GET')[1];
    await act(async () => {
      reload.headers.resolve(json(afterToggle));
      reload.body.resolve(afterToggle);
    });
    expect(screen.getByText('已禁用')).toBeTruthy();
  });
});

describe('场景4:新视图先完成,旧操作后失败/后兑现——迟到状态不得覆盖新视图', () => {
  it('refresh 迟到失败:切筛选并加载完成后,旧 POST 的 500 不得把错误盖到新视图上', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    const user = userEvent.setup();
    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    // 第一次刷新:POST 挂起。
    const post = await startAction(calls, '刷新合集');

    // 新交互先行:切筛选,新视图完整加载。
    await user.click(screen.getByRole('button', { name: textIs('已禁用 10') }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    const disabledView = statsPage({
      total: 10, enabled: 0, disabled: 10, filter: 'disabled', sources: [disabledSource],
    });
    const viewGet = calls.filter((c) => c.method === 'GET')[1];
    await act(async () => {
      viewGet.headers.resolve(json(disabledView));
      viewGet.body.resolve(disabledView);
    });
    await screen.findByText(textIs('共 10 条,第 1 / 1 页'));

    // 旧 POST 现在才失败(500):迟到的错误不得写回已切换的新视图。
    await act(async () => {
      post.headers.resolve({ ok: false, status: 500 } as unknown as Response);
      post.body.resolve({ error: '上游不可达' });
    });
    await drain();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(textIs('共 10 条,第 1 / 1 页'))).toBeTruthy();
  });

  it('toggle 迟到 gone 提示:视图切换后,旧 POST 的 gone 不得把提示盖到新视图上', async () => {
    const { apiFetch, calls } = makeScriptedFetch();
    renderTab(apiFetch);
    const user = userEvent.setup();
    await resolveFirstLoad(calls);
    await screen.findByRole('button', { name: textIs('全部 100') });

    // 在 all 筛选下点「禁用」:POST 挂起。
    const post = await startAction(calls, '禁用');

    // 新交互先行:切到 disabled 并完整加载。
    await user.click(screen.getByRole('button', { name: textIs('已禁用 10') }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    const disabledView = statsPage({
      total: 10, enabled: 0, disabled: 10, filter: 'disabled', sources: [disabledSource],
    });
    const viewGet = calls.filter((c) => c.method === 'GET')[1];
    await act(async () => {
      viewGet.headers.resolve(json(disabledView));
      viewGet.body.resolve(disabledView);
    });
    await screen.findByText(textIs('共 10 条,第 1 / 1 页'));

    // 旧 POST 现在才兑现 gone(URL 已不在合集):迟到的提示不得写回新视图。
    await act(async () => {
      post.headers.resolve(okHeaders);
      post.body.resolve({ disabled: false });
    });
    await drain();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(textIs('共 10 条,第 1 / 1 页'))).toBeTruthy();
  });
});
