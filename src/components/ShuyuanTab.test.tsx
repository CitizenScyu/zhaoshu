// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
      adultClassification: 'unmarked',
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
    apiFetch, can: () => false, isCurrentSession: () => true,
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

describe('ShuyuanTab 分类说明与手动网址', () => {
  it('三态均保留，合法HTTP(S)使用隔离新窗口链接且悬停不请求源站', async () => {
    const rows = [
      { url: 'https://adult.example/book', name: '成人标记源', adultClassification: 'adult' },
      { url: 'http://invalid.example/book', name: '元数据损坏源', adultClassification: 'invalid' },
      { url: 'https://ordinary.example/', name: '普通源', adultClassification: 'unmarked' },
    ].map((row) => ({ ...row, disabled: false, availability: 'reachable', lastError: '', checkedAt: null, probeError: null }));
    const apiFetch = vi.fn<ApiFetch>(async (input) => {
      expect(String(input)).toBe('/api/shuyuan?filter=all&page=1');
      return json(statsPage({ total: 3, enabled: 3, disabled: 0, sources: rows }));
    });
    const directFetch = vi.fn(() => { throw new Error('Unexpected direct network request'); });
    vi.stubGlobal('fetch', directFetch);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      renderTab(apiFetch);
      await screen.findByText('成人标记源');
      expect(screen.getByText('启用/可达不等于可自动取书。')).toBeTruthy();
      const user = userEvent.setup();
      for (const row of rows) {
        const item = screen.getByText(row.name).closest('li')!;
        const link = within(item).getByRole('link', { name: `手动访问${row.name}的网址（新窗口）` });
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe(row.url);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')?.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
        await user.hover(link);
      }
      const adult = screen.getByText('成人标记源').closest('li')!;
      expect(within(adult).getByText(textIs('成人标记；不参与自动阅读/下载，可手动访问。'))).toBeTruthy();
      const invalid = screen.getByText('元数据损坏源').closest('li')!;
      expect(within(invalid).getByText(textIs('元数据无效；不参与自动阅读/下载。'))).toBeTruthy();
      expect(invalid.textContent).not.toContain('成人标记');
      expect(screen.getAllByRole('link')).toHaveLength(3);
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(directFetch).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      cleanup();
      open.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('危险scheme、相对地址、解析失败和URL凭据不产生链接或敏感回显', async () => {
    const urls = ['javascript:alert(1)', 'data:text/plain,synthetic', 'file:///synthetic', '//unsafe.example/path',
      '/relative', 'not a url', 'https://synthetic:synthetic-password@unsafe.example/', 'https://@unsafe.example/',
      'https://bad host.example/'];
    const rows = urls.map((url, index) => ({ url, name: `无效网址${index}`, adultClassification: 'unmarked',
      disabled: false, availability: 'unprobed', lastError: '', checkedAt: null, probeError: null }));
    const apiFetch = vi.fn<ApiFetch>(async () => json(statsPage({ sources: rows, total: rows.length })));
    try {
      renderTab(apiFetch);
      await screen.findByText('无效网址0');
      for (const row of rows) {
        const item = screen.getByText(row.name).closest('li')!;
        expect(within(item).queryByRole('link')).toBeNull();
        expect(within(item).getByText('网址无法安全打开')).toBeTruthy();
      }
      expect(document.body.textContent).not.toContain('synthetic-password');
      expect(apiFetch).toHaveBeenCalledTimes(1);
    } finally { cleanup(); }
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

describe('ShuyuanTab 请求中止(MS-33)', () => {
  it('刷新合集后的重新加载带 AbortSignal,且卸载时该 signal 被中止', async () => {
    const seen: Array<{ url: string; method: string; signal: AbortSignal | null | undefined }> = [];
    const apiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', signal: init?.signal });
      if (init?.method === 'POST') return json({ ok: true });
      return json(statsPage());
    });
    const { unmount } = renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: '刷新合集' }));
    await waitFor(() => expect(seen.filter((c) => c.method === 'GET').length).toBeGreaterThan(1));

    // 刷新触发的那次列表重载必须带 signal:否则快速连点时旧响应能盖掉新状态。
    const reload = seen.filter((c) => c.method === 'GET').at(-1)!;
    expect(reload.signal).toBeInstanceOf(AbortSignal);
    expect(reload.signal!.aborted).toBe(false);

    unmount();
    expect(reload.signal!.aborted).toBe(true);
  });

  it('启停切换后的重新加载同样带 AbortSignal', async () => {
    const seen: Array<{ method: string; signal: AbortSignal | null | undefined }> = [];
    const apiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ method: init?.method ?? 'GET', signal: init?.signal });
      if (init?.method === 'POST') return json({ disabled: true });
      return json(statsPage());
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: '禁用' }));
    await waitFor(() => expect(seen.filter((c) => c.method === 'GET').length).toBeGreaterThan(1));

    const reload = seen.filter((c) => c.method === 'GET').at(-1)!;
    expect(reload.signal).toBeInstanceOf(AbortSignal);
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
describe('ShuyuanTab 筛选切换后的统计标签(count-label53)', () => {
  // ShuyuanStatsPage.total 是双语义字段:无筛选时=全局总数,带 filter 时=该筛选的分页
  // 条数。53 独立脚本已复现:切到 disabled 后 API 返回 total=10(筛选数),旧实现拿它
  // 画「全部」标签,全局 100 被顶成 10。修法:全局数用 enabled+disabled 推回,
  // 页脚/总页数仍用筛选 total——同一份分页响应两种口径并存。
  function filterPage(filter: string, filteredTotal: number) {
    // 真实 API 形状:counts 段始终是全局聚合(100/90/10),只有 total 被换成筛选数。
    return statsPage({
      filter, total: filteredTotal, totalPages: Math.max(1, Math.ceil(filteredTotal / 20)),
      page: 1,
    });
  }

  it('切到 disabled 后「全部」仍是全局 100(enabled+disabled),页脚显示该筛选的 10', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('filter=disabled')) return json(filterPage('disabled', 10));
      return json(filterPage('all', 100));
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: textIs('已禁用 10') }));

    // 新视图(disabled)的响应兑现后:「全部」保持全局 100,其余卡仍取各自字段。
    await waitFor(() => expect(screen.getByText(textIs('共 10 条,第 1 / 1 页'))).toBeTruthy());
    expect(screen.getByRole('button', { name: textIs('全部 100') })).toBeTruthy();
    expect(screen.getByRole('button', { name: textIs('已启用 90') })).toBeTruthy();
    expect(screen.getByRole('button', { name: textIs('已禁用 10') })).toBeTruthy();
    // 页脚/总页数用筛选 total(10 ⇒ 1 页),不用全局数。
    expect(screen.queryByText(textIs('共 100 条,第 1 / 5 页'))).toBeNull();
  });

  it('切到 enabled 后「全部」仍是全局数;回到 all 视图页脚回到全局分页', async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('filter=enabled')) return json(filterPage('enabled', 90));
      return json(filterPage('all', 100));
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: textIs('已启用 90') }));
    await waitFor(() => expect(screen.getByText(textIs('共 90 条,第 1 / 5 页'))).toBeTruthy());
    // 「全部」没被 enabled 筛选的 total=90 顶掉。
    expect(screen.getByRole('button', { name: textIs('全部 100') })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: textIs('全部 100') }));
    await waitFor(() => expect(screen.getByText(textIs('共 100 条,第 1 / 5 页'))).toBeTruthy());
  });

  it('真实统计变化时标签跟着新快照走,不缓存首屏总数', async () => {
    // 第一屏全局 100;重载后全局变 120(enabled 108/disabled 12)——「全部」应显示 120。
    let call = 0;
    const apiFetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return json(filterPage('all', 100));
      return json(statsPage({ total: 120, enabled: 108, disabled: 12, totalPages: 6 }));
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: textIs('全部 100') });

    await user.click(screen.getByRole('button', { name: '刷新合集' }));
    await waitFor(() => expect(screen.getByRole('button', { name: textIs('全部 120') })).toBeTruthy());
    expect(screen.getByText(textIs('共 120 条,第 1 / 6 页'))).toBeTruthy();
  });
});
