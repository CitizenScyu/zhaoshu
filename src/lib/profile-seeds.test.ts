import { describe, expect, it } from 'vitest';
import { removedSeedBooks, seedRemovalMessage } from './profile-seeds';
import type { SeedBook } from './types';

const seeds: SeedBook[] = [{ title: '甲书', author: '作者', kind: 'love' }, { title: '乙书', kind: 'drop' }];

describe('seed removal confirmation', () => {
  it('identifies each removed book and shows old/new counts', () => {
    expect(removedSeedBooks(seeds, seeds.slice(0, 1))).toEqual([seeds[1]]);
    expect(seedRemovalMessage(seeds, seeds.slice(0, 1))).toContain('2 本变为 1 本');
    expect(seedRemovalMessage(seeds, seeds.slice(0, 1))).toContain('《乙书》');
  });

  it('also guards equal-count replacement and author substitution', () => {
    expect(removedSeedBooks(seeds, [{ ...seeds[0], title: '新书' }, seeds[1]])).toEqual([seeds[0]]);
    expect(removedSeedBooks(seeds, [{ ...seeds[0], author: '其他作者' }, seeds[1]])).toEqual([seeds[0]]);
  });

  it('does not mistake reordering, reason edits or equivalent spelling for removal', () => {
    expect(removedSeedBooks(seeds, [{ ...seeds[1], reason: '补充原因' }, { ...seeds[0], title: ' 甲书 ' }])).toEqual([]);
    expect(removedSeedBooks([{ title: 'ＡＢＣ', kind: 'love' }], [{ title: 'abc', kind: 'love' }])).toEqual([]);
  });

  it('does not let an empty placeholder conceal removal and counts duplicates', () => {
    expect(removedSeedBooks(seeds, [{ title: '', kind: 'love' }])).toEqual(seeds);
    expect(removedSeedBooks([seeds[0], seeds[0]], [seeds[0]])).toEqual([seeds[0]]);
  });
});
