import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReaderPart, ReaderOrigin, ReadingSession } from '@/lib/reader-types';
import { DEFAULT_READER_SETTINGS } from '@/lib/reader-preferences';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  apiFetch: vi.fn(),
  owner: {} as Record<string, unknown>,
  reader: {} as Record<string, unknown>,
  readerCalls: 0,
}));

// 本仓 vitest 只有 node 环境、没有 jsdom（vitest.config.ts），组件测试走
// renderToStaticMarkup + 模块桩这条既有先例（AuthForm.test.ts / LoginCard.test.ts）。
// ReaderClient 的重活（取数/滚动/预取）在 useReader 里，这里把它换成受控替身，
// 专门钉 ReaderClient 自己的分支：准入判定、失败口径、正文与页脚渲染。
// reader.module.css 纯样式、与渲染断言无关，桩掉它以绕开本机 PostCSS/Tailwind
// 插件链的加载问题（@alloc/quick-lru 在本机 node_modules 缺失，属环境问题）。
vi.mock('./reader.module.css', () => ({ default: {} }));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.push }) }));
vi.mock('@/components/OwnerProvider', () => ({
  OwnerProvider: (props: { children: unknown }) => props.children,
  useOwner: () => mocks.owner,
}));
// 只替换 hook，partKey 仍用真实实现（区内分段键是 ReaderClient 渲染的一部分）。
vi.mock('./useReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useReader')>();
  return {
    ...actual,
    useReader: () => {
      mocks.readerCalls += 1;
      return mocks.reader;
    },
  };
});

import ReaderClient from './ReaderClient';

const part = (
  chapterIndex: number, partIndex: number, title: string, text: string,
  extra: Partial<ReaderPart> = {},
): ReaderPart => ({
  taskId: 1, version: 'v1', chapterIndex, partIndex, partCount: 3, title,
  startByte: 0, endByte: text.length, text, ...extra,
});

const index = {
  taskId: 1, title: '诡秘之主', author: '爱潜水的乌贼', version: 'v1', totalBytes: 999,
  chapters: [
    { index: 0, title: '第一章 开头', startByte: 0, endByte: 50, partCount: 3 },
    { index: 1, title: '第二章 中段', startByte: 50, endByte: 100, partCount: 1 },
  ],
};

function readerBase(over: Record<string, unknown> = {}) {
  return {
    settings: { ...DEFAULT_READER_SETTINGS },
    reading: null, activePart: undefined, loading: true, flowing: false, failure: null,
    percent: 0, notice: '', storageFailed: false, focused: false,
    scroller: { current: null }, article: { current: null }, heading: { current: null },
    onScroll: vi.fn(), updateSettings: vi.fn(), setFocusMode: vi.fn(), navigate: vi.fn(),
    extend: vi.fn(), retry: vi.fn(), markScrollIntent: vi.fn(), setSection: vi.fn(),
    loadConfirmedBook: vi.fn(),
    ...over,
  };
}

/** 造一个「正在读某个分段」的会话状态。indexSource=true 模拟书源书（有 index.source）。 */
function readingState(partToShow: ReaderPart, over: Record<string, unknown> = {}, indexSource = false) {
  return readerBase({
    loading: false,
    reading: {
      index: indexSource ? { ...index, source: { id: 's', name: '备用源', url: 'u', session: 'k' } } : index,
      parts: [partToShow],
      position: { chapterIndex: partToShow.chapterIndex, partIndex: partToShow.partIndex, ratio: 0 },
      focus: false,
    },
    activePart: partToShow,
    ...over,
  });
}

function render(props: { session?: ReadingSession; from?: ReaderOrigin } = {}): string {
  return renderToStaticMarkup(createElement(ReaderClient, {
    session: props.session ?? { kind: 'download', taskId: 1 },
    from: props.from ?? 'library',
  }));
}

function buttonFor(html: string, label: string): string {
  const match = html.match(new RegExp(`<button[^>]*>${label}<\\/button>`));
  if (!match) throw new Error(`找不到按钮：${label}`);
  return match[0];
}

const visitor = () => ({ ready: true, user: null, can: () => false, sessionId: 0, apiFetch: mocks.apiFetch });
const member = (canRead: boolean) => ({
  ready: true, user: { id: 5, canRead }, can: (p: string) => canRead && p === 'read',
  sessionId: 1, apiFetch: mocks.apiFetch,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readerCalls = 0;
  mocks.reader = readerBase();
  mocks.owner = member(true);
});

describe('阅读页准入', () => {
  // 回归护栏：会话探测没回来之前不能先渲染正文骨架，更不能把未登录当成可读。
  it('会话未定：只说「正在打开书页…」，且不建立阅读会话', () => {
    mocks.owner = { ready: false, user: null, can: () => false, sessionId: 0, apiFetch: mocks.apiFetch };
    const html = render();
    expect(html).toContain('正在打开书页…');
    expect(html).not.toContain('阅读正文');
    expect(mocks.readerCalls).toBe(0);
  });

  // 回归护栏：准入卡必须按来源给返回链接，否则从书库进来的人会被送回首页。
  it('未登录：给出准入卡，返回链接跟着 from 走', () => {
    mocks.owner = visitor();
    expect(render({ from: 'library' })).toContain('href="/?tab=library"');
    expect(render({ from: 'library' })).toContain('← 返回书库');
    expect(render({ from: 'shelf' })).toContain('← 返回书架');
    expect(render({ from: 'find' })).toContain('← 返回找书');
    const html = render({ from: 'shelf' });
    expect(html).toContain('推门，入书中');
    expect(html).toContain('登录后继续阅读；没有账号可先向管理员申请。');
    // 还没有身份，不能先建阅读会话去发请求。
    expect(mocks.readerCalls).toBe(0);
  });

  // 回归护栏：「没有阅读权限」必须与「文件不存在」分开说，且根本不去取正文。
  it('无阅读权限：说明原因并停在准入页，不发请求', () => {
    mocks.owner = member(false);
    const html = render({ from: 'find' });
    expect(html).toContain('当前账号尚未获得阅读权限');
    expect(html).toContain('这本书在书库中存在，但当前账号没有在线阅读权限；请联系管理员开通后再试。');
    expect(html).not.toContain('暂时未能打开这本书');
    expect(html).not.toContain('阅读正文');
    expect(mocks.readerCalls).toBe(0);
  });

  it('有阅读权限才建立阅读会话', () => {
    expect(mocks.readerCalls).toBe(0);
    render();
    expect(mocks.readerCalls).toBe(1);
  });
});

describe('正文未就绪与加载失败', () => {
  it('正文未就绪：给「准备中」的口径，不说成打不开', () => {
    const html = render();
    expect(html).toContain('正在准备目录与正文，首次打开可能需要一点时间…');
    expect(html).toContain('一页书，一段光阴');
    expect(html).toContain('书页正在准备中…');
    expect(html).toContain('待展卷');
    expect(html).toContain('书径 · 在线阅读');
    expect(html).toMatch(/aria-valuenow="0"/);
    expect(html).not.toContain('暂时未能打开这本书');
  });

  it('已经读到目录但分段还在路上：状态栏说「正在打开章节…」', () => {
    mocks.reader = readingState(part(0, 0, '第一章 开头', '正文'), { loading: true });
    const html = render();
    expect(html).toContain('正在打开章节…');
    expect(html).not.toContain('正在准备目录与正文');
  });

  // 回归护栏：失败原因必须原样透出，不能换成一句笼统的「加载失败」。
  it('下载会话失败：错误条原样带出原因，正文区换成可重试的口径', () => {
    mocks.reader = readerBase({ loading: false, failure: { message: '阅读服务暂时不可用，请稍后重试。', status: 503 } });
    const html = render({ session: { kind: 'download', taskId: 1 } });
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain('阅读服务暂时不可用，请稍后重试。');
    expect(html).toContain('暂时未能打开这本书');
    expect(html).toContain('可重试，或返回查看书籍的下载状态。');
    expect(buttonFor(html, '重试')).not.toContain('disabled');
    // 下载会话没有「去书库下载」的出路。
    expect(html).not.toContain('去书库下载全书');
  });

  it('书源会话失败：换口径，并给出「去书库下载全书」的出路', () => {
    mocks.reader = readerBase({ loading: false, failure: { message: '书源暂时不可用', status: 502 } });
    const html = render({ session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' } });
    expect(html).toContain('可重试书源，或到书库尝试下载全书。');
    expect(html).toContain('去书库下载全书');
    expect(html).toContain('tab=library');
    expect(html).toContain('q=%E8%AF%A1%E7%A7%98%E4%B9%8B%E4%B8%BB');
  });

  // 回归护栏：409 是「目录对不上」，重试同一个目录没意义，必须重新加载目录。
  it('409 的按钮是「重新加载目录」而不是「重试」', () => {
    mocks.reader = readerBase({
      loading: false,
      failure: { message: '章节内容与目录不一致，请重新加载目录。', status: 409 },
    });
    const html = render();
    expect(buttonFor(html, '重新加载目录')).toBeTruthy();
    expect(html).not.toMatch(/>重试<\/button>/);
  });

  // 回归护栏：401 是凭证失效，要回到准入卡并说明原因，而不是停在一个「重试」按钮上。
  it('401：回到准入卡，并把失败消息显示出来', () => {
    mocks.reader = readerBase({
      loading: false,
      failure: { message: '访问口令不正确或已失效，请重新输入。', status: 401 },
    });
    const html = render({ from: 'find' });
    expect(html).toContain('推门，入书中');
    expect(html).toContain('访问口令不正确或已失效，请重新输入。');
    expect(html).not.toContain('阅读正文');
  });

  // 回归护栏：403 是权限问题，不能渲染成「书不存在」或通用失败。
  it('403：渲染无阅读权限页，而不是通用失败', () => {
    mocks.reader = readerBase({ loading: false, failure: { message: '没有阅读权限', status: 403 } });
    const html = render();
    expect(html).toContain('当前账号尚未获得阅读权限');
    expect(html).not.toContain('暂时未能打开这本书');
    expect(html).not.toContain('role="alert"');
  });

  it('SOURCE_SIMILAR：把候选列成可点选的列表', () => {
    mocks.reader = readerBase({
      loading: false,
      failure: {
        message: '未找到完全匹配的书源', status: 409, code: 'SOURCE_SIMILAR',
        candidates: [
          { title: '诡秘之主', author: '', alias: '闺蜜之主', chapters: 3, bookUrl: 'https://s/1' },
          { title: '宿命之环', author: '爱潜水的乌贼', chapters: 12, bookUrl: 'https://s/2' },
        ],
      },
    });
    const html = render({ session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' } });
    expect(html).toContain('aria-label="相似书籍候选"');
    expect(html).toContain('<strong>诡秘之主</strong>');
    // 作者缺失时说「佚名」，不说 undefined。
    expect(html).toContain('佚名 · 原名《闺蜜之主》 · 3 章');
    expect(html).toContain('爱潜水的乌贼 · 12 章');
  });

  it('候选为空时不摆空列表', () => {
    mocks.reader = readerBase({
      loading: false,
      failure: { message: '未找到完全匹配的书源', status: 409, code: 'SOURCE_SIMILAR', candidates: [] },
    });
    expect(render()).not.toContain('相似书籍候选');
  });

  // M3 复审 P1-3:reading=null(目录还没回来 / 换源飞着 / 失败兜底)时,
  // 头部的「换源」入口必须能点开换源面板 —— 否则确认失败后用户被一个 disabled 按钮卡死。
  it('书源会话 reading=null 时「换源」按钮仍可用(复审 P1-3)', () => {
    mocks.reader = readerBase({ loading: true, reading: null });
    const html = render({ session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' } });
    // ⇄ 在按钮里;aria-expanded 表明它就是换源面板的触发器。
    // (用 [\s\S] 代替 /s 标志:本仓 tsconfig target 低于 es2018,/s 会被 tsc 拒收。)
    const button = html.match(/<button[^>]*aria-expanded="(?:false|true)"[^>]*>[\s\S]*?换源<\/button>/)?.[0]
      ?? html.match(/<button[^>]*>[\s\S]*?换源<\/button>/)?.[0];
    if (!button) throw new Error('找不到换源按钮');
    expect(button).not.toContain('disabled');
  });

  // M3 复审 P1-3:确认失败码(候选建目录失败 404/422/503)必须给「换个书源」出口;
  // 不再依赖已死的 SOURCE_CHANGED 码(服务端不产出),也不只认 SOURCE_CHAPTER_UNAVAILABLE。
  it('确认失败码(404/422/503)的错误条给出「换个书源」出口(复审 P1-3)', () => {
    for (const status of [404, 422, 503]) {
      mocks.reader = readerBase({
        loading: false,
        failure: { message: '书源未能提供这本书的目录。', status },
      });
      const html = render({ session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' } });
      expect(buttonFor(html, '换个书源')).not.toContain('disabled');
    }
  });

  // 回归护栏:非确认失败码(如 409 目录不一致、500 服务错误)不该摆「换个书源」——
  // 那不是换源能解决的问题,重复入口反而误导用户。
  it('非确认失败码(409/500)不摆「换个书源」', () => {
    for (const status of [409, 500]) {
      mocks.reader = readerBase({
        loading: false,
        failure: { message: '出错了', status },
      });
      const html = render({ session: { kind: 'source', title: '诡秘之主', author: '爱潜水的乌贼' } });
      expect(html).not.toContain('换个书源');
    }
  });

});

describe('正文渲染', () => {
  // 回归护栏：分段正文首行与章节标题重复时必须去掉，否则每章开头都重复一遍标题。
  it('partIndex=0 且首行等于标题：正文里不再重复标题', () => {
    mocks.reader = readingState(part(0, 0, '第一章 开头', '﻿第一章 开头\n正文第一段。'));
    const html = render();
    expect(html).toContain('aria-label="章节正文">正文第一段。</div>');
    // 标题只应出现两次：section 的 aria-label 与 h1。
    expect((html.match(/第一章 开头/g) ?? []).length).toBe(2);
    expect(html).not.toContain('﻿');
  });

  it('partIndex≠0：只剥 BOM，首行原样保留', () => {
    mocks.reader = readingState(part(0, 2, '第一章 开头', '﻿半途开始的一段\n后面还有。'));
    const html = render();
    expect(html).toContain('>半途开始的一段\n后面还有。</div>');
    expect(html).not.toContain('﻿');
  });

  it('全篇只有标题：正文渲染为空，而不是把标题再写一遍', () => {
    mocks.reader = readingState(part(0, 0, '第一章 开头', '第一章 开头'));
    expect(render()).toContain('aria-label="章节正文"></div>');
  });

  it('章节头部给出作者与章序', () => {
    mocks.reader = readingState(part(0, 0, '第一章 开头', '正文'));
    const html = render();
    expect(html).toContain('爱潜水的乌贼 著');
    expect(html).toContain('01 / 2');
  });

  // 回归护栏：进度、章序与两个翻章按钮的可用性都要跟当前章一致。
  it('页脚：章序、百分比与翻章按钮的可用性', () => {
    mocks.reader = readingState(part(0, 1, '第一章 开头', '正文'), { percent: 42.5 }, true);
    const html = render({ session: { kind: 'source', title: 'T', author: 'A' } });
    expect(html).toContain('<span>第 1 / 2 章</span>');
    // 有 index.source（书源书）时进度只能是估算，口径必须说清楚。
    expect(html).toContain('<small>按章节估算 42.5%</small>');
    expect(html).toMatch(/aria-valuenow="42.5"/);
    expect(buttonFor(html, '← 上一章')).toContain('disabled');
    expect(buttonFor(html, '下一章 →')).not.toContain('disabled');
  });

  it('没有书源信息的书用「全书」口径，不说成估算', () => {
    mocks.reader = readingState(part(0, 1, '第一章 开头', '正文'), { percent: 10 });
    const html = render({ session: { kind: 'download', taskId: 1 } });
    expect(html).toContain('<small>全书 10.0%</small>');
    expect(html).not.toContain('按章节估算');
  });

  it('末章：下一章禁用，接续区说「已读到全书末尾」', () => {
    mocks.reader = readingState(part(1, 0, '第二章 中段', '正文'), { percent: 100 });
    const html = render();
    expect(buttonFor(html, '← 上一章')).not.toContain('disabled');
    expect(buttonFor(html, '下一章 →')).toContain('disabled');
    expect(html).toContain('已读到全书末尾 · 合卷，再寻一径');
  });

  it('还有下一处：给接续按钮与滚动提示', () => {
    mocks.reader = readingState(part(0, 2, '第一章 开头', '正文'));
    const html = render();
    expect(buttonFor(html, '接着读下一章 →')).not.toContain('disabled');
    expect(html).toContain('向下滚动，接着读');
  });

  // 关闭「滚动自动接续」之后就不该再出现滚动提示。
  it('关掉滚动接续时不提示「向下滚动」', () => {
    mocks.reader = readingState(part(0, 2, '第一章 开头', '正文'), {
      settings: { ...DEFAULT_READER_SETTINGS, continuous: false },
    });
    expect(render()).not.toContain('向下滚动，接着读');
  });

  it('书源会话在章节头带出 serving 书源名', () => {
    mocks.reader = readingState(part(0, 0, '第一章 开头', '正文', { servedFrom: '某某书源' }), {}, true);
    const html = render({ session: { kind: 'source', title: 'T', author: 'A' } });
    expect(html).toContain('书源：某某书源');
  });
});

describe('阅读页的界面开关', () => {
  // 回归护栏：专注模式下工具栏与页脚都要收起来，否则「专注」名不副实。
  it('专注模式：header/footer 收起，留一个「显示工具栏」按钮', () => {
    mocks.reader = readingState(part(0, 0, '第一章 开头', '正文'), { focused: true });
    const html = render();
    expect(html).toContain('data-focused="true"');
    expect(html).toContain('aria-label="显示工具栏"');
    expect(html.split('hidden=""').length - 1).toBe(2);
  });

  it('非专注模式不隐藏工具栏', () => {
    expect(render()).toContain('data-focused="false"');
  });

  it('存储失败时明确告知进度与设置记不住', () => {
    mocks.reader = readerBase({ storageFailed: true });
    const html = render();
    expect(html).toContain('浏览器未允许保存，阅读进度与设置暂时无法记住。');
  });

  // 回归护栏：设置必须真的落到阅读页的根属性上，否则主题/字号改了没反应。
  it('阅读设置透传到根元素的 data-* 属性', () => {
    mocks.reader = readerBase({
      settings: { ...DEFAULT_READER_SETTINGS, theme: 'night', font: 'serif', width: 'wide', fontSize: 26 },
    });
    const html = render();
    expect(html).toContain('data-theme="night"');
    expect(html).toContain('data-font="serif"');
    expect(html).toContain('data-width="wide"');
    expect(html).toContain('--reader-font-size:26px');
  });
});
