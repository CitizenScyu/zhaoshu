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
    expect(TRADITIONAL_FOLD_SIZE).toBe(2884);
    expect(foldTraditional('苧')).toBe('苎');
    for (const sample of ['薴苧樂園蘇著乾隆後來', '𠵾㑯䰾']) expect(foldTraditional(foldTraditional(sample))).toBe(foldTraditional(sample));
  });

  // 41-swq 审查 §1.1：两侧都折，多前像映射会把不同的字判等（李乾≡李干）。表只留一对一映射。
  it('一对一：简体本身也是繁体字的整组不折，其余只留首选繁体前像', () => {
    for (const [left, right] of [
      ['乾', '干'], ['幹', '干'], ['乾', '幹'], ['後', '后'], ['發', '髮'], ['濛', '蒙'],
      ['係', '系'], ['繫', '系'], ['儘', '尽'], ['嚮', '向'], ['藉', '借'], ['蘇', '甦'], ['蘇', '囌'],
    ]) expect(foldTraditional(left), `${left} vs ${right}`).not.toBe(foldTraditional(right));
    // 首选前像照常折：同一个字的繁简两种写法。
    expect(foldTraditional('蘇')).toBe('苏');
    expect(foldTraditional('發')).toBe('发');
    expect(foldTraditional('盡')).toBe('尽');
    expect(foldTraditional('機')).toBe('机');
  });

  it('表内每个简体目标恰有一个前像', () => {
    const seen = new Map<string, string>();
    for (let code = 0x3400; code <= 0x3ffff; code += 1) {
      const char = String.fromCodePoint(code);
      const folded = foldTraditional(char);
      if (folded === char) continue;
      expect(seen.get(folded), `${char}/${seen.get(folded)} -> ${folded}`).toBeUndefined();
      seen.set(folded, char);
      expect(foldTraditional(folded)).toBe(folded);
    }
    expect(seen.size).toBe(TRADITIONAL_FOLD_SIZE);
  });
});
