import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), owner: {} as Record<string, unknown> }));

// 本仓 vitest 只收 *.test.ts、environment 是 node（vitest.config.ts），组件测试走
// renderToStaticMarkup + 模块桩这条既有先例（AuthForm.test.ts / LoginCard.test.ts）。
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));

import FindTab from './FindTab';
import { EMPTY_HISTORY } from '@/lib/recent-queries';

// 与组件里的常量保持一致：EXAMPLES 的补位上限与「最近」展示条数决定了首屏 chips。
const EXAMPLE_POOL = [
  '类似《诡秘之主》的克苏鲁+升级流，主角要冷静理性',
  '慢热权谋文，文笔好，不要无脑爽',
  '单女主都市日常，轻松治愈，别有系统',
  '历史文，考据扎实，主角不圣母',
  '无限流团队作战，不要个人英雄主义',
  '仙侠文，世界观宏大，主角不圣母',
  '硬核科幻末世，拒绝恋爱脑',
];

function render(): string {
  return renderToStaticMarkup(createElement(FindTab));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner = { apiFetch: mocks.apiFetch, user: { id: 7, canFind: true, canRead: true, canDownload: true } };
});

describe('找书面板的默认状态', () => {
  // 回归护栏：默认入口必须是口味推荐。改成 exact（或不再标 aria-selected）会改变
  // 所有现有用户的第一眼落点，本用例必须因此失败。
  it('默认停在「口味推荐」，两个模式的 tab 与说明各就各位', () => {
    const html = render();
    expect(html).toContain('aria-label="找书模式"');
    expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>口味推荐<\/button>/);
    expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="false"[^>]*>精确找书<\/button>/);
    expect(html).toContain('描述你想看什么，模型按你的画像推荐。');
    // 精确找书那句说明只在切过去之后才出，默认不出现（避免两种模式的话术混在一屏）。
    expect(html).not.toContain('按书名直搜，命中就是这一本，不打模型。');
  });

  // 回归护栏：两个面板都保持挂载（hidden 而不是条件渲染），否则切回口味推荐时
  // 上一次的结果会被丢掉。用「hidden 只挂在精确面板上」把这条钉死。
  it('两个面板都挂载，只有精确找书面板被 hidden', () => {
    const html = render();
    expect(html.split('hidden=""').length - 1).toBe(1);
    const hiddenAt = html.indexOf('hidden=""');
    const titleInputAt = html.indexOf('aria-label="书名"');
    expect(hiddenAt).toBeGreaterThan(-1);
    expect(titleInputAt).toBeGreaterThan(hiddenAt);
  });

  it('需求为空时「找 书」禁用，且不显示任何进行中/空结果文案', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>找 书<\/button>/);
    expect(html).not.toContain('寻径中…');
    expect(html).not.toContain('本轮没有符合条件的书。');
  });

  it('「仅本次有效」默认不勾选，并把长期/本次的差别说给用户', () => {
    const html = render();
    expect(html).toContain('仅本次有效');
    expect(html).toContain('勾选后本次需求只用于本轮匹配，不写入长期画像/不进入记忆；默认长期记录。');
    // 默认是长期通道：checkbox 上没有 checked 属性。
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*\/>/);
  });

  // F12：文案承诺的两个边界必须与实现的 retention 契约一致——「仅本次」= session（不写搜索
  // 历史、推荐记录不落需求原文），默认 = longterm（两者都写）。文案里这两句是可断言的锚点；
  // 真正的保留行为由 find-retention.test.ts 逐格钉住。
  it('文案承诺的「仅本次」/「默认长期」边界与 retention 契约一致', () => {
    const html = render();
    expect(html).toContain('不进入记忆');
    expect(html).toContain('默认长期记录');
  });
});

describe('示例 chips 的补位规则', () => {
  // 回归护栏：没有历史时，示例池按 CHIP_TOTAL 截到上限。把 slice 去掉（或把 6 改成池长）
  // 会让首屏一次铺满十条，本用例必须因此失败。
  it('无历史时只铺到上限条数，且顺序按池子原序轮转', () => {
    const html = render();
    for (const example of EXAMPLE_POOL.slice(0, 6)) {
      expect(html, `应出现示例：${example}`).toContain(example);
    }
    expect(html).not.toContain(EXAMPLE_POOL[6]);
  });

  // 回归护栏：没有最近记录时不该出现「最近」分组标签，也不该有历史 chips。
  it('无历史时不渲染「最近」分组', () => {
    expect(EMPTY_HISTORY).toHaveLength(0); // 服务端快照确实为空，断言才有意义
    expect(render()).not.toContain('>最近<');
  });
});

describe('精确找书面板（hidden 但仍然渲染）', () => {
  it('书名/作者两个输入位与说明文案齐全', () => {
    const html = render();
    expect(html).toContain('aria-label="书名"');
    expect(html).toContain('placeholder="书名，例如：诡秘之主"');
    expect(html).toContain('aria-label="作者（选填）"');
    expect(html).toContain('placeholder="作者（选填，同名书多时用来区分）"');
    expect(html).toContain('这里只输入书名，不要写口味描述（那属于「口味推荐」）。先查本地书库，没有再查豆瓣。');
  });

  // 回归护栏：空书名时不能提交（会打出一次必然 400 的请求）。
  it('空书名时「精确查找」禁用，也不显示检索中/空结果文案', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>精确查找<\/button>/);
    expect(html).not.toContain('检索中…');
    expect(html).not.toContain('正在查本地书库与豆瓣…');
  });
});

describe('渲染期的副作用', () => {
  // 回归护栏：请求只能发生在 effect / 事件里。把 fetch 提到渲染期会在 SSR 直接炸，
  // 本仓库此前也踩过类似的重复请求问题。
  it('首屏渲染不发任何请求', () => {
    render();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
