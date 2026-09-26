import { describe, expect, it } from 'vitest';
import { foldTraditional, TRADITIONAL_FOLD_SIZE } from './zh-variant-fold';

describe('zh-variant-fold（41-swq 书源身份比对用的繁→简字形折叠）', () => {
  it('常见繁体字形折成简体，简体/表外字符原样', () => {
    expect(foldTraditional('木蘇里')).toBe('木苏里');
    expect(foldTraditional('末日樂園')).toBe('末日乐园');
    expect(foldTraditional('劍來')).toBe('剑来');
    expect(foldTraditional('全球高考 abc 123')).toBe('全球高考 abc 123');
    expect(foldTraditional('')).toBe('');
  });

  it('生成表完整、幂等（链式映射已解到终点）', () => {
    expect(TRADITIONAL_FOLD_SIZE).toBe(3221);
    expect(foldTraditional('薴')).toBe('苎');
    for (const sample of ['薴苧樂園蘇著乾隆後來', '𠵾㑯䰾']) expect(foldTraditional(foldTraditional(sample))).toBe(foldTraditional(sample));
  });
});
