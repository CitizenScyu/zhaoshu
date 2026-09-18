import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

// 本仓 vitest 只有 node 环境、没有 jsdom（vitest.config.ts）。组件测试走
// renderToStaticMarkup + 模块桩这条既有先例（AuthForm.test.ts / LoginCard.test.ts）。
// FeedbackForm 的取数在 useEffect 里，SSR 不执行；能测的是「拿到 props 后的首屏形态」，
// 也就是线上快照已知 / 未知这两条分支——它们恰好决定了用户看到的是编辑器还是重读入口。
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({ apiFetch: mocks.apiFetch }) }));

import FeedbackForm from './FeedbackForm';
import type { FeedbackSnapshot } from '@/lib/feedback';

function render(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(FeedbackForm, {
    title: '诡秘之主',
    author: '爱潜水的乌贼',
    status: 'want',
    onSaved: vi.fn(),
    onCancel: vi.fn(),
    onBusyChange: vi.fn(),
    ...over,
  }));
}

function buttonFor(html: string, label: string): string {
  const match = html.match(new RegExp(`<button[^>]*>${label}<\\/button>`));
  if (!match) throw new Error(`找不到按钮：${label}`);
  return match[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('线上快照未知时的首屏', () => {
  // 回归护栏：baseline 未知就渲染编辑器，用户改的是一份来路不明的草稿，
  // 保存时必然撞 409。此时只能给「重读反馈」+「取消」两个出口。
  it('不渲染编辑器，只给重读与取消两个出口', () => {
    const html = render();
    expect(html).not.toContain('<form');
    expect(buttonFor(html, '重读反馈')).not.toContain('disabled');
    expect(buttonFor(html, '取消')).not.toContain('disabled');
  });

  // 还没开始读线上反馈（首屏 busy=false），不能先摆出「正在读取已有反馈…」骗人。
  it('还没发起读取时不说「正在读取已有反馈…」', () => {
    expect(render()).not.toContain('正在读取已有反馈…');
  });

  it('首屏渲染不发请求、也不改动外部 busy 状态', () => {
    const onBusyChange = vi.fn();
    render({ onBusyChange });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(onBusyChange).not.toHaveBeenCalled();
  });
});

describe('线上快照已知时的首屏', () => {
  const snapshot = (note: string): FeedbackSnapshot => ({ version: 3, note, status: 'want' });

  // 回归护栏：原因行与补充说明必须按 parseFeedbackNote 的口径拆开回填。
  // 拆错（例如整段塞进 textarea）会把预设原因重复计进字数，用户第一眼就看到脏草稿。
  it('带原因的快照：原因被选中，补充说明回填，字数按合计口径算', () => {
    const html = render({ initialSnapshot: snapshot('节奏慢\n太拖了') });
    expect(html).toContain('aria-label="想读反馈"');
    expect(html).toContain('标记为「想读」· 原因可多选，也可以只更新状态');
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>✓ 节奏慢<\/button>/);
    expect(html).toContain('>太拖了</textarea>');
    // 节奏慢(3) + 换行(1) + 太拖了(3) = 7
    expect(html).toContain('原因与补充说明合计 7/1000 字');
  });

  it('已有内容时按钮说「记下反馈」，不说成「只更新状态」', () => {
    expect(buttonFor(render({ initialSnapshot: snapshot('节奏慢') }), '记下反馈')).toBeTruthy();
  });

  // 回归护栏：线上没有原因时按钮必须说「只更新状态」。写成「清除原因」会让用户
  // 以为自己删掉了什么。
  it('线上没有原因时按钮说「只更新状态」，且不出现「清除原因」', () => {
    const html = render({ initialSnapshot: snapshot('') });
    expect(buttonFor(html, '只更新状态')).toBeTruthy();
    expect(html).not.toContain('清除原因');
  });

  // 回归护栏：clearInitially（书架那条「清除原因」入口）必须从空草稿起步。
  // 草稿一旦沿用 initialNote，第二次保存会把刚清掉的原因原样写回去。
  it('clearInitially：草稿从空开始，按钮变「清除原因」，预设原因全部未选中', () => {
    const html = render({ initialSnapshot: snapshot('节奏慢'), clearInitially: true });
    expect(html).toContain('原因与补充说明合计 0/1000 字');
    expect(html).not.toContain('>节奏慢</textarea>');
    expect(html).not.toMatch(/aria-pressed="true"/);
    expect(buttonFor(html, '清除原因')).toBeTruthy();
  });

  // status 只是展示口径，但错了用户会以为自己标错书。
  it('编辑器标题跟着 status 走', () => {
    expect(render({ status: 'dropped', initialSnapshot: snapshot('烂尾') })).toContain('标记为「弃书」');
  });
});
