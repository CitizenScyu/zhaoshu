import { describe, expect, it } from 'vitest';
import { missingLedgerVersions } from './schema-ledger.ts';

// 记账连续性判据的唯一口径：assertAuthSchema（运行期闸门）与 evaluateSchema（db:check）共用。
describe('missingLedgerVersions', () => {
  it.each([
    ['空账本', [], 7, [1, 2, 3, 4, 5, 6, 7]],
    ['连续齐全', [1, 2, 3, 4, 5, 6, 7], 7, []],
    ['中间缺号', [1, 2, 3, 4, 5, 7], 7, [6]],
    ['缺多个中间号', [1, 2, 5, 7], 7, [3, 4, 6]],
    ['只有 max（缺 1..6）', [7], 7, [1, 2, 3, 4, 5, 6]],
    ['齐全且另有更高版本', [1, 2, 3, 4, 5, 6, 7, 8, 99], 7, []],
    ['artifact 口径（requiredVersion=2）齐全', [1, 2], 2, []],
    ['artifact 缺 v1', [2], 2, [1]],
  ])('%s', (_label, present, required, expected) => {
    expect(missingLedgerVersions(present, required)).toEqual(expected);
  });

  it('忽略 null/undefined 元素', () => {
    expect(missingLedgerVersions([1, null, 3, undefined, 4, 5, 6, 7], 7)).toEqual([2]);
  });
});
