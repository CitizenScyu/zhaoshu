import { describe, expect, it } from 'vitest';

// srcfeed：多 feed 合并的版本取舍是纯函数——把它钉在模块级单测里，不碰数据库与 fetch。
// 全序判据只在 incomingWins 内一处判定；上游自报 lastUpdateTime 不能压过 yckceo（position=0）。
import { feedLabelOf, incomingWins } from './shuyuan';

describe('srcfeed: feedLabelOf（URL → host/文件名 label）', () => {
  it('合法 https URL → host/最后一段', () => {
    expect(feedLabelOf('https://book.cloud.us.kg/qq-mirror-sources.json'))
      .toBe('book.cloud.us.kg/qq-mirror-sources.json');
    expect(feedLabelOf('https://example.com/')).toBe('example.com');
  });

  // 2026-10-16 生产事故回归钉：label 本身不是合法 URL（无 scheme），
  // 把 fetchExtraFeeds 返回的 result.feed 再喂 feedLabelOf 必抛 Invalid URL 并炸整轮刷新。
  it('label 无 scheme 不可再被 new URL 解析（result.feed 严禁二次 feedLabelOf）', () => {
    expect(() => new URL('book.cloud.us.kg/qq-mirror-sources.json')).toThrow();
  });
});

describe('srcfeed: incomingWins（source_url 归并版本取舍）', () => {
  it('yckceo（position=0）与 extra（position>0）都无戳 ⇒ 不到者让位（yckceo 不覆 extra）', () => {
    expect(incomingWins({ stamp: 999, position: 5 }, { stamp: 1, position: 0 })).toBe(true);
  });

  it('extra 双方都有 >0 时间戳且不等 ⇒ 新者胜，即使旧方来自更靠后的 feed', () => {
    expect(incomingWins({ stamp: 200, position: 5 }, { stamp: 100, position: 6 })).toBe(true);
  });

  it('extra 双方都有 >0 时间戳且不等 ⇒ 旧者让位，即使新方来自更靠前的 feed', () => {
    expect(incomingWins({ stamp: 100, position: 4 }, { stamp: 200, position: 5 })).toBe(false);
  });

  it('extra 双方时间戳相等 ⇒ 后出现者胜（position 大的）', () => {
    expect(incomingWins({ stamp: 100, position: 5 }, { stamp: 100, position: 4 })).toBe(true);
  });

  it('双方 0（均无 lastUpdateTime）⇒ 后到者胜（position 大的）', () => {
    expect(incomingWins({ stamp: 0, position: 5 }, { stamp: 0, position: 4 })).toBe(true);
  });

  it('仅一方有 >0 时间戳 ⇒ 无法比较，仍按 position 后到者胜（报告里记「无戳=后到胜」）', () => {
    expect(incomingWins({ stamp: 0, position: 5 }, { stamp: 100, position: 4 })).toBe(true);
    expect(incomingWins({ stamp: 100, position: 4 }, { stamp: 0, position: 5 })).toBe(false);
  });
});
