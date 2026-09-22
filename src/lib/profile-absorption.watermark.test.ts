import { describe, expect, it } from 'vitest';
import { absorbedWatermarkFor, fedFeedbackUpperBound, feedbackForPrompt } from './db';

// F41-F1 纯函数契约：水位 = 本轮**实喂**上界，不是全表 max。
//
// 核心不变量（任务书已定，不许推翻）：**任何反馈行除非真喂给模型，不得被标记已消费**。
// 多保留（下轮重喂）可接受，多推进（漏行）禁止。
//
// 这些断言是「改回旧行为必须变红」的锚点：变异测试会把 absorbedWatermarkFor 换成
// max(全类) 或 getMaxFeedbackIdForUser 语义，见报告的两组红绿。

const info = (...ids: number[]) => ids.map((id) => ({ feedbackId: id }));
const wd = (...ids: number[]) => ids.map((id) => ({ feedbackId: id }));

describe('F41-F1 fedFeedbackUpperBound', () => {
  it('空批不设上界（null），调用方退回另一类的上界', () => {
    expect(fedFeedbackUpperBound([])).toBeNull();
    expect(fedFeedbackUpperBound(undefined)).toBeNull();
    expect(fedFeedbackUpperBound(null)).toBeNull();
  });

  it('取该批最大 id（不限顺序，因为 SQL 是 ASC 但投影可能被重排）', () => {
    expect(fedFeedbackUpperBound(info(3, 17, 9))).toBe(17);
    expect(fedFeedbackUpperBound(info(1))).toBe(1);
    expect(fedFeedbackUpperBound(info(0))).toBe(0);
  });
});

describe('F41-F1 absorbedWatermarkFor（min 收敛）', () => {
  it('withdrawn 的 id 更大时，水位不得越过 informative 实喂上界', () => {
    // 交错场景：informative 喂到 40，withdrawn 喂到 91。
    // 水位必须停在 40——否则 informative 里 id 41..40 之后的未喂行会被误清。
    expect(absorbedWatermarkFor(info(5, 12, 40), wd(60, 91))).toBe(40);
  });

  it('informative 的 id 更大时，对称地停在 withdrawn 实喂上界', () => {
    expect(absorbedWatermarkFor(info(50, 88), wd(7, 20))).toBe(20);
  });

  it('某一类本轮 0 行 → 只受另一类约束', () => {
    expect(absorbedWatermarkFor(info(31), [])).toBe(31);
    expect(absorbedWatermarkFor([], wd(44))).toBe(44);
    // 两类都空：无行喂过，水位 0（调用方不会推进）。
    expect(absorbedWatermarkFor([], [])).toBe(0);
  });

  it('相等时取该值', () => {
    expect(absorbedWatermarkFor(info(9, 9), wd(9))).toBe(9);
  });

  it('绝不返回超过任一实喂上界的值（漏行禁止）', () => {
    // 全表 max 假设是 5000（enqueue 用 max(id) 记的 pending 上界）。
    // 无论怎么组合，水位都 ≤ 两个实喂上界里的较小者。
    for (const a of [1, 50, 500, 5000]) {
      for (const b of [2, 60, 900, 5000]) {
        expect(absorbedWatermarkFor(info(a), wd(b))).toBe(Math.min(a, b));
      }
    }
  });
});

describe('F41-F1 feedbackForPrompt', () => {
  it('投影剔除 feedbackId：内部水位字段绝不进模型输入', () => {
    const prompt = feedbackForPrompt([{ title: '书甲', author: '作者', status: 'dropped', note: '雷点', feedbackId: 41 }]);
    expect(prompt).toEqual([{ title: '书甲', author: '作者', status: 'dropped', note: '雷点' }]);
    expect(Object.keys(prompt[0])).toEqual(['title', 'author', 'status', 'note']);
    expect(JSON.stringify(prompt)).not.toContain('feedbackId');
    expect(JSON.stringify(prompt)).not.toContain('41');
  });

  it('空批与未定义入参都安全', () => {
    expect(feedbackForPrompt([])).toEqual([]);
  });
});
