import { describe, expect, it } from 'vitest';
import { absorbedWatermarkFor, fedFeedbackUpperBound, feedbackForPrompt } from './db';

// F41-F1 纯函数契约：水位 = 本轮**实喂**上界，不是全表 max。
//
// 核心不变量（任务书已定，不许推翻）：**任何反馈行除非真喂给模型，不得被标记已消费**。
// 多保留（下轮重喂）可接受，多推进（漏行）禁止。
//
// `absorbedWatermarkFor(informative, withdrawn, combine)` 的 combine 由**该轮查询是否带
// afterId 过滤**决定（见 db.ts 上的长注释）：
//   - 异步吸收：informative 带 afterId、withdrawn 不带 ⇒ 'max'
//   - 重建路径：两类都全量读 ⇒ 'min'
// 这里把两种组合都钉住，因为它们回答的是不同问题、不能互相替代。

const info = (...ids: number[]) => ids.map((id) => ({ feedbackId: id }));
const wd = (...ids: number[]) => ids.map((id) => ({ feedbackId: id }));

describe('F41-F1 fedFeedbackUpperBound', () => {
  it('空批不设上界（null），调用方只受另一类约束', () => {
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

describe("F41-F1 absorbedWatermarkFor(combine='max') 异步吸收路径", () => {
  it('撤回书目的 id 更大时，水位跟着撤回走（撤回是更新证据，必须告知过模型）', () => {
    // informative 喂到 40，撤回书目在 id 91：afterId=40 之后的新 informative 与全量撤回
    // 都进了输入 ⇒ 水位 = 91。
    expect(absorbedWatermarkFor(info(5, 12, 40), wd(60, 91), 'max')).toBe(91);
  });

  it('informative 的 id 更大时，水位 = informative 上界（id ≤ 它的撤回已告知）', () => {
    expect(absorbedWatermarkFor(info(50, 88), wd(7, 20), 'max')).toBe(88);
  });

  it('某一类本轮 0 行 → 只受另一类约束', () => {
    expect(absorbedWatermarkFor(info(31), [], 'max')).toBe(31);
    expect(absorbedWatermarkFor([], wd(44), 'max')).toBe(44);
    expect(absorbedWatermarkFor([], [], 'max')).toBe(0);
  });

  it('相等时取该值；默认 combine 就是 max（防止误用 min 悄悄漏掉撤回）', () => {
    expect(absorbedWatermarkFor(info(9, 9), wd(9), 'max')).toBe(9);
    expect(absorbedWatermarkFor(info(5, 40), wd(60, 91))).toBe(91); // 默认 = max
  });
});

describe("F41-F1 absorbedWatermarkFor(combine='min') 重建路径", () => {
  it('withdrawn 的 id 更大时，水位不得越过 informative 实喂上界', () => {
    // 两类都全量读：informative 只喂了 LIMIT 50 之内，withdrawn 超出的部分没告知模型
    // ⇒ 取 min，别把未覆盖的撤回标成已吸收。
    expect(absorbedWatermarkFor(info(5, 12, 40), wd(60, 91), 'min')).toBe(40);
  });

  it('informative 的 id 更大时，对称地停在 withdrawn 实喂上界', () => {
    expect(absorbedWatermarkFor(info(50, 88), wd(7, 20), 'min')).toBe(20);
  });

  it('某一类本轮 0 行 → 只受另一类约束；都空 → 0', () => {
    expect(absorbedWatermarkFor(info(31), [], 'min')).toBe(31);
    expect(absorbedWatermarkFor([], wd(44), 'min')).toBe(44);
    expect(absorbedWatermarkFor([], [], 'min')).toBe(0);
  });
});

describe('F41-F1 absorbedWatermarkFor 不变量：绝不返回超过实喂上界', () => {
  it('穷举 a,b ∈ {1,50,500,5000}：max 组合恒等于 max(a,b)，min 组合恒等于 min(a,b)', () => {
    // 强不变式锚：pending=5000（enqueue 记的全表上界）绝不被采用，
    // 因为两侧入参都只是本轮真正喂过/告知过的行。
    for (const a of [1, 50, 500, 5000]) {
      for (const b of [2, 60, 900, 5000]) {
        expect(absorbedWatermarkFor(info(a), wd(b), 'max')).toBe(Math.max(a, b));
        expect(absorbedWatermarkFor(info(a), wd(b), 'min')).toBe(Math.min(a, b));
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
