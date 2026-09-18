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

// 本仓 vitest 只有 node 环境、没有 jsdom（vitest.config.ts），useEffect 不执行，
// 而 ShelfTab 的一切（分组、两段式确认、带原因的移除）都发生在 `items` 到位之后
// ——首屏的 `items === null && loading` 早返回把后面整棵树挡在 SSR 之外。
// 因此这里只钉「首屏不能是别的东西」这条底线，其余留作报告里的已知缺口。
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
