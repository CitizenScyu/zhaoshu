import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({ apiFetch: mocks.apiFetch, user: { id: 3 } }) }));

import ShelfTab from './ShelfTab';

beforeEach(() => {
  vi.clearAllMocks();
});

// 本文件选择 SSR 首屏验证，useEffect 不执行；items 尚未加载时只渲染占位。
// 分组和移除交互发生在加载之后，另由 ShelfTab.remove.test.tsx 与
// ShelfTab.operation-lifecycle.test.tsx 的 jsdom 场景验证。
describe('书架的加载态', () => {
  it('首屏是加载占位，不抢先渲染空书架或分组', () => {
    const html = renderToStaticMarkup(createElement(ShelfTab));
    expect(html.split('ink-drop').length - 1).toBe(3);
    // 「书架空空」是加载完成后才成立的结论，加载中说出来就是把未知当成了没有。
    expect(html).not.toContain('书架空空，先去「找书」跑一单');
    expect(html).not.toContain('搜书名 / 作者');
    expect(html).not.toContain('清空未处理');
    expect(html).not.toContain('role="alert"');
  });

  it('首屏渲染不发请求（取数只能发生在 effect 里）', () => {
    renderToStaticMarkup(createElement(ShelfTab));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
