// zhuigeng42：追更判定的纯逻辑回归（真库行为在 followup.pglite.test.ts）。
//
// 这里钉的是**判据本身**：什么算「纯追加」、什么绝对不许入队、以及与服务端指纹同源的前缀算法。
// 追更误判的代价是全书重抓 + 版本前移 + 书架亮「有更新」，所以反例比正例重要。

import { describe, expect, it } from 'vitest';
import { catalogPrefixKey } from './reader-preferences';
import {
  decideFollowup, followupBackoffMs, followupPrefixKey,
  FOLLOWUP_BASE_INTERVAL_MS, FOLLOWUP_MAX_INTERVAL_MS,
} from './followup';
import type { ReaderIndex } from './reader-types';

function indexOf(titles: string[]): ReaderIndex {
  return {
    taskId: null, title: '追更测试书', author: '作者', version: 'v1', totalBytes: 0, source: undefined,
    chapters: titles.map((title, index) => ({ index, title, startByte: 0, endByte: 0, partCount: 1 })),
  };
}

describe('追更前缀指纹与客户端同构', () => {
  it.each([
    ['单章', ['第一章']],
    ['多章含中文标点', ['第一章 起风', '第二章·暗涌', '第三章（完）']],
    ['空目录', []],
    ['分隔符敏感：ab|c vs a|bc', ['ab', 'c']],
  ])('%s：与服务端 reader-preferences 的 catalogPrefixKey 逐字一致', (_name, titles) => {
    const index = indexOf(titles);
    for (let cut = 1; cut <= titles.length; cut++) {
      expect(followupPrefixKey(titles, cut)).toBe(catalogPrefixKey(index, cut - 1));
    }
  });

  it("['ab','c'] 与 ['a','bc'] 不撞指纹（0x1f 分隔符在位）", () => {
    expect(followupPrefixKey(['ab', 'c'], 2)).not.toBe(followupPrefixKey(['a', 'bc'], 2));
  });
});

describe('纯追加判定 decideFollowup', () => {
  const base = ['第1章', '第2章', '第3章'];

  it('首轮没有旧基线：只记基线，永不判追加', () => {
    const verdict = decideFollowup({ chapterCount: null, prefixHash: '' }, base);
    expect(verdict.kind).toBe('baseline');
    expect(verdict.chapterCount).toBe(3);
    expect(verdict.prefixHash).toBe(followupPrefixKey(base, 3));
  });

  it('旧行有章数但指纹为空（历史脏行）：同样当首轮', () => {
    expect(decideFollowup({ chapterCount: 3, prefixHash: '' }, base).kind).toBe('baseline');
  });

  it('正例：末尾追加新章、前缀逐字未变 ⇒ appended', () => {
    const baseline = { chapterCount: 3, prefixHash: followupPrefixKey(base, 3) };
    const verdict = decideFollowup(baseline, [...base, '第4章', '第5章']);
    expect(verdict.kind).toBe('appended');
    expect(verdict.chapterCount).toBe(5);
    // 入队后基线要换成新目录的整本指纹，否则下一轮会拿旧 N 去比、永远判不出追加。
    expect(verdict.prefixHash).toBe(followupPrefixKey([...base, '第4章', '第5章'], 5));
  });

  it('反例：站方改写旧章标题（章数不变）⇒ 不入队，按新目录重建基线', () => {
    const baseline = { chapterCount: 3, prefixHash: followupPrefixKey(base, 3) };
    const verdict = decideFollowup(baseline, ['第1章', '第2章（修订）', '第3章']);
    expect(verdict.kind).toBe('rebased');
    expect(verdict.prefixHash).toBe(followupPrefixKey(['第1章', '第2章（修订）', '第3章'], 3));
  });

  it('反例：站方在开头插入一章（总数变多但前缀变了）⇒ 不入队', () => {
    const baseline = { chapterCount: 3, prefixHash: followupPrefixKey(base, 3) };
    expect(decideFollowup(baseline, ['楔子', ...base]).kind).toBe('rebased');
  });

  it('反例：目录收缩 ⇒ 不入队', () => {
    const baseline = { chapterCount: 5, prefixHash: followupPrefixKey([...base, '第4章', '第5章'], 5) };
    expect(decideFollowup(baseline, base).kind).toBe('rebased');
    expect(decideFollowup(baseline, []).kind).toBe('rebased');
  });

  it('反例：章节顺序被换（同一批标题、顺序不同）⇒ 不入队', () => {
    const baseline = { chapterCount: 3, prefixHash: followupPrefixKey(base, 3) };
    expect(decideFollowup(baseline, ['第3章', '第2章', '第1章']).kind).toBe('rebased');
  });

  it('章数与指纹都没变 ⇒ unchanged（不重复入队）', () => {
    const baseline = { chapterCount: 3, prefixHash: followupPrefixKey(base, 3) };
    const verdict = decideFollowup(baseline, base);
    expect(verdict.kind).toBe('unchanged');
    expect(verdict.prefixHash).toBe(baseline.prefixHash);
  });
});

describe('退避节奏 followupBackoffMs', () => {
  it('连续无进展逐轮递增：4h → 8h → 16h → 24h 封顶', () => {
    const hours = [0, 1, 2, 3, 9].map(n => followupBackoffMs(n) / 3_600_000);
    expect(hours).toEqual([4, 8, 16, 24, 24]);
  });

  it('非法/负数计数按 0 处理（不倒退、不炸）', () => {
    expect(followupBackoffMs(-3)).toBe(FOLLOWUP_BASE_INTERVAL_MS);
    expect(followupBackoffMs(1.5)).toBe(FOLLOWUP_BASE_INTERVAL_MS);
    expect(followupBackoffMs(Number.NaN)).toBe(FOLLOWUP_BASE_INTERVAL_MS);
    expect(followupBackoffMs(0)).toBe(FOLLOWUP_BASE_INTERVAL_MS);
  });

  it('入队成功后计数清零 ⇒ 回到 4h', () => {
    expect(followupBackoffMs(0)).toBeLessThan(FOLLOWUP_MAX_INTERVAL_MS);
  });
});
