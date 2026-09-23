// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShuyuanTab from './ShuyuanTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});

// ShuyuanTab 的文案含中文标点(已规范化成裸字符),按字面量匹配会失配;这里把所有
// 非字母数字汉字都去掉(标点/空白/符号)再比 —— 只留 0-9 A-Z a-z 与 CJK,不动汉字。
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

/** 真实 /api/shuyuan 的分页形状(ShuyuanStatsPage)。数字刻意互不相同:
 *  reachable(探活)7 ≠ active(兼容字段)5 ≠ enabled(启停)90 ≠ total 100 ——
 *  任何「拿错字段填数字」都会被下面的断言抓住。 */
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

function renderTab(apiFetch: FetchMock) {
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

describe('ShuyuanTab 统计数字:取自各自的字段(探活 vs 准入是两条链)', () => {
  it('筛选卡数字按 FILTER_COUNT_KEYS 取字段:reachable=探活数,enabled=启停数,不串源', async () => {
    const apiFetch = vi.fn(async () => json(statsPage()));
    renderTab(apiFetch);

    // 数字必须落到正确的字段上:这是最容易「张冠李戴」的地方。
    // 最近探测可达 7 = counts.reachable(不是 active 5、不是 enabled 90)。
    expect(await screen.findByRole('button', { name: textIs('最近探测可达 7') })).toBeTruthy();
    expect(screen.getByRole('button', { name: textIs('已启用 90') })).toBeTruthy();
    expect(screen.getByRole('button', { name: textIs('已禁用 10') })).toBeTruthy();
    expect(screen.getByRole('button', { name: textIs('全部 100') })).toBeTruthy();
    expect(screen.getByRole('button', { name: textIs('待核验 3') })).toBeTruthy();
    expect(screen.getByRole('button', { name: textIs('最近探测失败 10') })).toBeTruthy();
    // 兼容字段 active=5 不该出现在任何筛选卡上(否则就是把探活与启停混为一谈)。
    expect(screen.queryByRole('button', { name: textIs('全部 5') })).toBeNull();
    // 列表页脚的总条数用同一份 total。
    expect(screen.getByText(textIs('共 100 条,第 1 / 5 页'))).toBeTruthy();
  });

  it('加载失败:role=alert 透出服务端错误原文', async () => {
    const apiFetch = vi.fn(async () => json({ error: '书源加载失败' }, 500));
    renderTab(apiFetch);
    const alert = await screen.findByRole('alert');
    expect(squeeze(alert.textContent ?? '')).toContain(squeeze('书源加载失败'));
  });

  it('初次加载:首屏拉取请求打到带 filter/page 的 /api/shuyuan', async () => {
    const apiFetch = vi.fn<ApiFetch>(async () => json(statsPage()));
    renderTab(apiFetch);
    await screen.findByRole('button', { name: textIs('全部 100') });
    expect(String(apiFetch.mock.calls[0]?.[0])).toBe('/api/shuyuan?filter=all&page=1');
  });
});

describe('ShuyuanTab 启停切换', () => {
  it('点「禁用」发 POST {action:disable,url},成功后重新拉列表', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ disabled: true });
      return json(statsPage());
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: '禁用' }));

    await waitFor(() => {
      const post = apiFetch.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(String(post![0])).toBe('/api/shuyuan');
      expect(JSON.parse(String((post![1] as RequestInit).body)))
        .toEqual({ action: 'disable', url: 'https://a.example' });
    });
    // 成功后列表被重新拉取(不止一次 GET)。
    await waitFor(() => expect(apiFetch.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method).length).toBeGreaterThan(1));
  });

  it('已禁用的源:`重新启用` 发 action:enable;后端答「没这一行」时给提示', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ enabled: false });
      return json(statsPage({
        sources: [{ url: 'https://a.example', name: '源甲', disabled: true, availability: 'failed', lastError: '过去失败', checkedAt: null, probeError: null }],
      }));
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: '重新启用' }));
    await waitFor(() => {
      const post = apiFetch.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ action: 'enable', url: 'https://a.example' });
    });
    // enabled:false = 该 URL 已不在库里 ⇒ 提示列表已重载。
    const alert = await screen.findByRole('alert');
    expect(squeeze(alert.textContent ?? '')).toContain(squeeze('这个书源已不在当前合集里,已为你重新加载列表'));
  });
});

describe('ShuyuanTab 探测状态展示', () => {
  it('已启用但连续探测失败的源:给出「不会参与搜索」的原因提示', async () => {
    const apiFetch = vi.fn(async () => json(statsPage({
      sources: [{
        url: 'https://a.example', name: '源甲', disabled: false, availability: 'failed',
        lastError: '', checkedAt: '2026-09-20T00:00:00.000Z', probeError: '连续失败',
      }],
    })));
    renderTab(apiFetch);
    await screen.findByRole('button', { name: textIs('全部 100') });
    // 提示落在该源所在的行里(participationHint 的口径:开关开着但不参与搜索)。
    const row = screen.getByText('源甲').closest('li')!;
    const hint = row.querySelector('p');
    expect(squeeze([...row.querySelectorAll('p')].map((p) => p.textContent).join(' ')))
      .toContain(squeeze('已启用,但连续探测失败次数已达阈值,当前不会参与搜索;刷新后会重试'));
    expect(hint).toBeTruthy();
  });
});