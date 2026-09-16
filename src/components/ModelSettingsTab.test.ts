import { describe, expect, it } from 'vitest';
import { reasoningLabel, savedNotice } from './ModelSettingsTab';

// 回归护栏（判据说谎）：页面文案只能转述三态判定。'unknown' 一旦被写成「否」，
// 保存推理模型时 owner 就会看到「不是推理模型」——那正是 2026-09-17 修掉的说谎。
describe('页面上的推理模型判定', () => {
  it('unknown 只说「未观察到」，绝不说成「否」', () => {
    const label = reasoningLabel('unknown');
    expect(label).toContain('未观察到');
    expect(label).not.toBe('否');
    expect(label).not.toMatch(/^否/);
  });

  it('只有 yes 才说「是」，no 才说「否」', () => {
    expect(reasoningLabel('yes')).toMatch(/^是/);
    expect(reasoningLabel('no')).toMatch(/^否/);
  });

  it('GET 没有探测过时说未知并说明保存时会实测', () => {
    expect(reasoningLabel(null)).toContain('未知');
    expect(reasoningLabel(null)).toContain('保存');
  });

  it('保存后判定为推理模型时主动提示，未知时说明探测的局限', () => {
    expect(savedNotice('m', { reasoning: 'yes' })).toContain('推理模型');
    expect(savedNotice('m', { reasoning: 'unknown' })).toContain('不代表它不是推理模型');
    expect(savedNotice('m', { reasoning: 'unknown' })).not.toContain('不是推理模型。');
  });

  it('上游给的 warning 优先原样透出，不与页面文案重复', () => {
    const notice = savedNotice('m', { reasoning: 'yes', warning: '预算被思维链用尽' });
    expect(notice).toContain('预算被思维链用尽');
    expect(notice).not.toContain('探测观察到该模型会输出思维链');
  });
});
