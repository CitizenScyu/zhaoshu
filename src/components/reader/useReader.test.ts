import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { partKey, useReader } from './useReader';
import { DEFAULT_READER_SETTINGS } from '@/lib/reader-preferences';
import type { ReaderPart } from '@/lib/reader-types';

// 本仓 vitest 只有 node 环境、没有 jsdom（vitest.config.ts）：useReader 的取数、滚动、
// 预取全部挂在 useEffect / useLayoutEffect 与 DOM 事件上，SSR 一个都不跑。
// 能钉的是「首屏返回值」与导出的纯函数——首屏这几个初值直接决定阅读页第一眼说什么
// （见 ReaderClient.test.ts 的「正文未就绪」用例）。
function readInitial() {
  const apiFetch = vi.fn();
  let seen: ReturnType<typeof useReader> | undefined;
  function Probe() {
    seen = useReader({ kind: 'download', taskId: 1 }, apiFetch, 3);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!seen) throw new Error('useReader 没有返回句柄');
  return { reader: seen, apiFetch };
}

describe('partKey', () => {
  // 章内分段必须有稳定且唯一的键：sections 映射、阅读窗口去重、React key 全靠它。
  it('把 chapterIndex 与 partIndex 编成复合键', () => {
    expect(partKey({ chapterIndex: 0, partIndex: 0 })).toBe('0:0');
    expect(partKey({ chapterIndex: 2, partIndex: 11 })).toBe('2:11');
  });

  // 回归护栏：只用 partIndex（或只用 chapterIndex）会让不同章的同号分段互相顶掉。
  it('(1,11) 与 (11,1) 不是同一个键', () => {
    expect(partKey({ chapterIndex: 1, partIndex: 11 }))
      .not.toBe(partKey({ chapterIndex: 11, partIndex: 1 }));
  });

  it('接受完整的 ReaderPart（多余字段不参与编码）', () => {
    const full: ReaderPart = {
      chapterIndex: 3, partIndex: 2, taskId: 1, version: 'v1', partCount: 5,
      title: '第三章', startByte: 0, endByte: 10, text: '正文',
    };
    expect(partKey(full)).toBe('3:2');
  });
});

describe('首屏返回的阅读状态', () => {
  // 回归护栏：loading 初值一旦为 false，阅读页会先把「一页书，一段光阴」当成
  // 加载完的结果渲染出来，再跳成正文——闪一下空状态。
  it('loading 初值为 true，且没有任何已加载内容', () => {
    const { reader } = readInitial();
    expect(reader.loading).toBe(true);
    expect(reader.flowing).toBe(false);
    expect(reader.reading).toBeNull();
    expect(reader.activePart).toBeUndefined();
    expect(reader.failure).toBeNull();
  });

  // 首屏还没有进度、没有提示、也没有存储失败结论。
  it('进度/提示/存储失败都从零开始', () => {
    const { reader } = readInitial();
    expect(reader.percent).toBe(0);
    expect(reader.notice).toBe('');
    expect(reader.storageFailed).toBe(false);
    expect(reader.focused).toBe(false);
  });

  // 本仓没有 localStorage：设置必须回落到默认值，而不是 undefined/空对象
  // （下游 `settings.fontSize + 'px'` 会直接渲染成 "undefinedpx"）。
  it('读不到存储设置时回落到默认阅读设置', () => {
    const { reader } = readInitial();
    expect(reader.settings).toEqual(DEFAULT_READER_SETTINGS);
  });

  // 首屏就要把 ref 与回调交出去：ReaderClient 会把它们挂到 DOM 上。
  it('ref 与操作面齐全', () => {
    const { reader } = readInitial();
    for (const key of ['scroller', 'article', 'heading'] as const) {
      expect(reader[key], `${key} 必须是 ref 对象`).toHaveProperty('current');
    }
    for (const key of [
      'onScroll', 'updateSettings', 'setFocusMode', 'navigate', 'extend',
      'retry', 'markScrollIntent', 'loadConfirmedBook', 'setSection',
    ] as const) {
      expect(typeof reader[key], `${key} 必须是函数`).toBe('function');
    }
  });

  // 回归护栏：取数一旦被提到渲染期，SSR 就会发请求（也会在客户端每次重渲染重发）。
  it('首屏渲染不发请求', () => {
    const { apiFetch } = readInitial();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  // M3 复审 P1-3:换源提交的回调句柄必须随 hook 暴露,且初始未注册(没人注册时
  // loadIndex 的 onSwitchCommitted.current?.(...) 空转,book_url 永不落 URL,刷新丢源)。
  // 暴露的是「注册函数」而非裸 ref:直接写 hook 返回的 ref 会被 react-hooks 的
  // React Compiler 规则判 error(hook 返回值不可变)。
  it('暴露 registerSwitchCommitted 注册函数,初始未注册', () => {
    const { reader } = readInitial();
    expect(typeof reader.registerSwitchCommitted).toBe('function');
    // 初始未注册:没人注册时 loadIndex 的回调空转,book_url 永不落 URL(刷新丢源)。
    // 注册/清除都不该抛(ReaderClient 在 effect 里注册,卸载时清)。
    expect(() => {
      reader.registerSwitchCommitted(() => {});
      reader.registerSwitchCommitted(null);
    }).not.toThrow();
  });

  // M3 复审 P1-3:switchedBookUrl 从 indexUrl 的 book_url 参数取值;下载会话
  // (kind !== 'source')不该掺和换源,恒返回 undefined。
  it('switchedBookUrl:非书源会话恒为 undefined;书源会话取 indexUrl 的 book_url', () => {
    const apiFetch = vi.fn();
    let seen: ReturnType<typeof useReader> | undefined;
    function Probe() {
      seen = useReader({ kind: 'source', title: '测试书', author: '作者' }, apiFetch, 3);
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    if (!seen) throw new Error('useReader 没有返回句柄');
    // 首屏 indexUrl 由 session 派生,不带 book_url ⇒ undefined(确认路径才会带)。
    expect(seen.switchedBookUrl()).toBeUndefined();
  });
});
