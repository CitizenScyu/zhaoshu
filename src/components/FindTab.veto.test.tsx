// @vitest-environment jsdom
// 41-veto-visible：被画像雷点自动排除的书的展示块。判定（有无、默认折叠、展开内容）都在
// 这里测，不写进 FindTab 的 JSX 闭包——本仓默认 node 环境，这里单独声明 jsdom。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 与既有的 FindTab.test.ts 同一套桩：直接渲染 VetoedList 本不需要它们，但导入 FindTab.tsx
// 会连带求值整棵模块图（OwnerProvider / ReadBookLink→next/link），保住默认 locale 与导航桩。
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({ apiFetch: vi.fn(), user: { id: 7 } }) }));

import { VetoedList } from './FindTab';

afterEach(cleanup);

const BOOKS = [
  { title: '后宫书', author: '作者乙', reason: '书库题材标签「后宫」命中你画像里的雷点「后宫」' },
  { title: '另一本', author: '', reason: '' },
];

describe('被画像雷点排除的书：结果页展示块', () => {
  it('没有排除项时整块不渲染（旧行为：无此字段的书照常）', () => {
    expect(renderToStaticMarkup(createElement(VetoedList, { books: [] }))).toBe('');
  });

  it('有排除项时渲染标题、书名、作者与理由', () => {
    const html = renderToStaticMarkup(createElement(VetoedList, { books: BOOKS }));
    expect(html).toContain('已按你的雷点排除 2 本');
    expect(html).toContain('后宫书');
    expect(html).toContain('作者乙');
    expect(html).toContain('雷点「后宫」');
    // 作者/理由为空的项退化为只有书名，不能渲染出「 · 」这类空壳。
    expect(html).toContain('另一本');
    expect(html).not.toContain('另一本 · ');
  });

  it('默认折叠：details 不带 open，用户不点就不展开', () => {
    const { container } = render(createElement(VetoedList, { books: BOOKS }));
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    // 折叠的是「呈现」而非「数据」：内容已在 DOM 里，展开即可见。
    expect(container.textContent).toContain('后宫书');
  });

  it('点标题可展开：summary 承载可访问的折叠开关', () => {
    const { container } = render(createElement(VetoedList, { books: BOOKS }));
    const details = container.querySelector('details') as HTMLDetailsElement;
    const summary = container.querySelector('summary');
    expect(summary).not.toBeNull();
    fireEvent.click(summary!);
    expect(details.open).toBe(true);
    fireEvent.click(summary!);
    expect(details.open).toBe(false);
  });
});
