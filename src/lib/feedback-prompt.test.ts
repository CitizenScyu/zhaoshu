import { describe, expect, it } from 'vitest';
import {
  feedbackPromptKey,
  hasPromptedFeedback,
  hasReadingTrace,
  markFeedbackPrompted,
  planFeedbackPrompt,
  promptableOrigin,
  READ_TRACE_PERCENT,
  shouldPromptFeedback,
  snapshotHasFeedback,
  type FeedbackPromptFacts,
} from './feedback-prompt';
import type { ReaderOrigin } from './reader-types';

// T66 回归护栏：引导入口只该出现在「读过、还没反馈、也没问过」的书上。
// 判定写松了就是每本书每次返回都弹窗；写紧了反馈入口等于没做。

function facts(overrides: Partial<FeedbackPromptFacts> = {}): FeedbackPromptFacts {
  return { read: false, hasFeedback: false, prompted: false, ...overrides };
}

describe('引导条件判定', () => {
  it('读过、没有反馈、没引导过：才引导', () => {
    expect(shouldPromptFeedback(facts({ read: true }))).toBe(true);
  });

  it('没读过就不问：打开就走的书不该被拦下来', () => {
    expect(shouldPromptFeedback(facts())).toBe(false);
    expect(shouldPromptFeedback(facts({ read: false, hasFeedback: false }))).toBe(false);
  });

  it('已有反馈就不问：状态或原因任一条都算说过', () => {
    for (const hasFeedback of [true]) {
      expect(shouldPromptFeedback({ read: true, hasFeedback, prompted: false })).toBe(false);
      expect(shouldPromptFeedback({ read: true, hasFeedback, prompted: true })).toBe(false);
    }
  });

  it('引导过就不问第二次：同一本书只引导一次', () => {
    expect(shouldPromptFeedback({ read: true, hasFeedback: false, prompted: true })).toBe(false);
  });
});

describe('反馈快照是否算已反馈', () => {
  it('状态或原因有任意一个就跳过引导', () => {
    expect(snapshotHasFeedback({ status: 'done', note: '' })).toBe(true);
    expect(snapshotHasFeedback({ status: null, note: '节奏太慢' })).toBe(true);
    expect(snapshotHasFeedback({ status: 'dropped', note: '烂尾' })).toBe(true);
  });

  it('空快照表示还没反馈', () => {
    expect(snapshotHasFeedback({ status: null, note: '' })).toBe(false);
    expect(snapshotHasFeedback({ status: null, note: '   ' })).toBe(false);
    expect(snapshotHasFeedback({ status: '', note: '' })).toBe(false);
  });

  it('读不出来按已反馈处理：宁可不引导，也不能在已有反馈的书上再问一次', () => {
    expect(snapshotHasFeedback(null)).toBe(true);
    expect(snapshotHasFeedback({ status: 123, note: {} })).toBe(true);
    expect(snapshotHasFeedback({ status: null, note: {} })).toBe(true);
  });
});

describe('引导去重键', () => {
  it('按用户分命名空间：换身份阅读不被别人的引导记录影响', () => {
    expect(feedbackPromptKey(1, '书名', '作者')).not.toBe(feedbackPromptKey(2, '书名', '作者'));
  });

  it('书名与作者调换不会撞键', () => {
    expect(feedbackPromptKey(1, '甲', '乙')).not.toBe(feedbackPromptKey(1, '乙', '甲'));
    expect(feedbackPromptKey(1, '甲', '乙')).not.toBe(feedbackPromptKey(1, '甲', '丙'));
  });

  it('同名不同分隔方式的写法保持不同', () => {
    expect(feedbackPromptKey(1, '甲-乙', '丙')).not.toBe(feedbackPromptKey(1, '甲', '乙-丙'));
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    has: (key: string) => data.has(key),
    raw: (key: string) => data.get(key),
  };
}

describe('引导去重的存取', () => {
  it('没记过就是没引导过，记过之后就引导过', () => {
    const storage = memoryStorage();
    const key = feedbackPromptKey(1, '书名', '作者');
    expect(hasPromptedFeedback(storage, key)).toBe(false);
    markFeedbackPrompted(storage, key, 1_700_000_000_000);
    expect(hasPromptedFeedback(storage, key)).toBe(true);
    expect(storage.raw(key)).toBe('1700000000000');
  });

  it('存储不可用时视作已引导：记不住就不能反复弹', () => {
    expect(hasPromptedFeedback(null, 'k')).toBe(true);
  });

  it('存储抛错时不冒泡：读写失败都不影响阅读和返回', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(hasPromptedFeedback(throwing, 'k')).toBe(true);
    expect(() => markFeedbackPrompted(throwing, 'k', 1)).not.toThrow();
    expect(() => markFeedbackPrompted(null, 'k', 1)).not.toThrow();
  });
});

describe('阅读痕迹阈值', () => {
  it('本机存过进度就算读过：回到开头重看时 percent 是 0', () => {
    expect(hasReadingTrace(0, true)).toBe(true);
  });

  it('本次读够阈值才算读过', () => {
    expect(hasReadingTrace(READ_TRACE_PERCENT, false)).toBe(true);
    expect(hasReadingTrace(READ_TRACE_PERCENT + 0.1, false)).toBe(true);
  });

  it('刚点开就返回：没痕迹、没读够，都不算读过', () => {
    expect(hasReadingTrace(0, false)).toBe(false);
    expect(hasReadingTrace(READ_TRACE_PERCENT - 0.1, false)).toBe(false);
  });
});

describe('引导入口范围', () => {
  it('书架与找书都引导：这两条路径的书一定有 books 行', () => {
    // shelf = recommendations JOIN books；find = 同一次请求里刚 persistRecommendations 落库。
    expect(promptableOrigin('shelf')).toBe(true);
    expect(promptableOrigin('find')).toBe(true);
  });

  it('书库直读不引导：书库是 labeled_books，不是 books，反馈会 404 BOOK_NOT_FOUND', () => {
    // 全仓非测试代码里 INSERT INTO books 只有 /api/find 与 POST /api/shelf 两处；
    // 从书库直接下载、没跑过 find 也没进书架的书没有 books 行。
    expect(promptableOrigin('library')).toBe(false);
  });

  it('判定看 from 而不是会话类型：session.kind 判不出 book 身份', () => {
    // library + taskId 是 download 会话但书只在 labeled_books；find 是 source 会话但书在 books。
    // 这两条正好相反，所以 from 才是更准的判据。
    expect(promptableOrigin('find')).toBe(true);
    expect(promptableOrigin('library')).toBe(false);
  });
});

describe('点返回时的编排', () => {
  function plan(overrides: Partial<FeedbackPromptFacts & { userId: number; from: ReaderOrigin }> = {}) {
    return planFeedbackPrompt({ userId: 1, from: 'shelf', read: true, hasFeedback: false, prompted: false, ...overrides });
  }

  it('读过、没反馈、没引导过：接管返回并记账', () => {
    expect(plan()).toEqual({ offer: true, remember: true });
  });

  it('找书「直接阅读」走书源会话，同样拿得到引导', () => {
    expect(plan({ from: 'find' })).toEqual({ offer: true, remember: true });
  });

  it('书库直读不接管，也不记账：没展示就不该消耗掉这本书唯一的一次引导', () => {
    expect(plan({ from: 'library' })).toEqual({ offer: false, remember: false });
  });

  it('未登录不接管也不记账：u0 的键会把同一个人拆成两次引导', () => {
    expect(plan({ userId: 0 })).toEqual({ offer: false, remember: false });
  });

  it('没读够 / 已有反馈 / 已引导过：一律不接管也不记账', () => {
    expect(plan({ read: false })).toEqual({ offer: false, remember: false });
    expect(plan({ hasFeedback: true })).toEqual({ offer: false, remember: false });
    expect(plan({ prompted: true })).toEqual({ offer: false, remember: false });
  });
});
