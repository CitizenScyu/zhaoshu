// yield1030：host 优先分提供方（开关、TTL 记忆、失败不缓存）。SQL 语义见 download-source-candidates.pglite.test.ts。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scores = vi.hoisted(() => vi.fn());
const zero = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/download-source-candidates', () => ({ productiveHostScores: scores, zeroYieldHosts: zero }));

import {
  createHostPriority, dedupeVariantsEnabled, demoteZeroYieldEnabled, HOST_PRIORITY_TTL_MS, productiveFirstEnabled, scanConcurrency, scanRotateEnabled,
  skipStrictTocEnabled, skipZeroYieldEnabled,
} from './host-priority';

const sql = {} as never;
const signal = new AbortController().signal;

describe('yield1030 host-priority', () => {
  beforeEach(() => { scores.mockReset(); zero.mockReset(); });

  it('开关缺省/非真值 ⇒ undefined（selector 池序原样）', () => {
    expect(createHostPriority(sql, {})).toBeUndefined();
    expect(createHostPriority(sql, { DOWNLOAD_SCAN_PRODUCTIVE_FIRST: '0' })).toBeUndefined();
    expect(productiveFirstEnabled({ DOWNLOAD_SCAN_PRODUCTIVE_FIRST: ' On ' })).toBe(true);
    expect(productiveFirstEnabled({ DOWNLOAD_SCAN_PRODUCTIVE_FIRST: 'true' })).toBe(true);
    expect(scores).not.toHaveBeenCalled();
  });

  it('toctgate1030：DOWNLOAD_SCAN_SKIP_STRICT_TOC 缺省/非真值关，1/true/on 开', () => {
    expect(skipStrictTocEnabled({})).toBe(false);
    expect(skipStrictTocEnabled({ DOWNLOAD_SCAN_SKIP_STRICT_TOC: 'yes' })).toBe(false);
    expect(skipStrictTocEnabled({ DOWNLOAD_SCAN_SKIP_STRICT_TOC: ' On ' })).toBe(true);
  });

  it('zeroskip1105：DOWNLOAD_SCAN_SKIP_ZERO_YIELD 缺省/非真值关，1/true/on 开', () => {
    expect(skipZeroYieldEnabled({})).toBe(false);
    expect(skipZeroYieldEnabled({ DOWNLOAD_SCAN_SKIP_ZERO_YIELD: 'yes' })).toBe(false);
    expect(skipZeroYieldEnabled({ DOWNLOAD_SCAN_SKIP_ZERO_YIELD: '0' })).toBe(false);
    expect(skipZeroYieldEnabled({ DOWNLOAD_SCAN_SKIP_ZERO_YIELD: ' On ' })).toBe(true);
    expect(skipZeroYieldEnabled({ DOWNLOAD_SCAN_SKIP_ZERO_YIELD: '1' })).toBe(true);
  });

  it('variantdup1105：DOWNLOAD_SCAN_DEDUPE_VARIANTS 缺省/非真值关，1/true/on 开', () => {
    expect(dedupeVariantsEnabled({})).toBe(false);
    expect(dedupeVariantsEnabled({ DOWNLOAD_SCAN_DEDUPE_VARIANTS: 'yes' })).toBe(false);
    expect(dedupeVariantsEnabled({ DOWNLOAD_SCAN_DEDUPE_VARIANTS: '0' })).toBe(false);
    expect(dedupeVariantsEnabled({ DOWNLOAD_SCAN_DEDUPE_VARIANTS: ' On ' })).toBe(true);
    expect(dedupeVariantsEnabled({ DOWNLOAD_SCAN_DEDUPE_VARIANTS: '1' })).toBe(true);
  });

  it('scanpar1104：DOWNLOAD_SCAN_CONCURRENCY 缺省/非法 = 1，正整数夹到 1..8', () => {
    expect(scanConcurrency({})).toBe(1);
    expect(scanConcurrency({ DOWNLOAD_SCAN_CONCURRENCY: 'four' })).toBe(1);
    expect(scanConcurrency({ DOWNLOAD_SCAN_CONCURRENCY: '-2' })).toBe(1);
    expect(scanConcurrency({ DOWNLOAD_SCAN_CONCURRENCY: '0' })).toBe(1);
    expect(scanConcurrency({ DOWNLOAD_SCAN_CONCURRENCY: ' 4 ' })).toBe(4);
    expect(scanConcurrency({ DOWNLOAD_SCAN_CONCURRENCY: '32' })).toBe(8);
  });

  it('rotate1030：DOWNLOAD_SCAN_ROTATE 缺省/非真值关，1/true/on 开', () => {
    expect(scanRotateEnabled({})).toBe(false);
    expect(scanRotateEnabled({ DOWNLOAD_SCAN_ROTATE: '0' })).toBe(false);
    expect(scanRotateEnabled({ DOWNLOAD_SCAN_ROTATE: ' On ' })).toBe(true);
    expect(scanRotateEnabled({ DOWNLOAD_SCAN_ROTATE: '1' })).toBe(true);
  });

  it('成功结果按 TTL 记忆，过期重查', async () => {
    let t = 1_000;
    scores.mockResolvedValueOnce(new Map([['a.example', 3]])).mockResolvedValueOnce(new Map([['b.example', 1]]));
    const priority = createHostPriority(sql, { DOWNLOAD_SCAN_PRODUCTIVE_FIRST: '1' }, () => t)!;
    expect(await priority(signal)).toEqual(new Map([['a.example', 3]]));
    t += HOST_PRIORITY_TTL_MS - 1;
    expect(await priority(signal)).toEqual(new Map([['a.example', 3]]));
    expect(scores).toHaveBeenCalledTimes(1);
    t += 1;
    expect(await priority(signal)).toEqual(new Map([['b.example', 1]]));
    expect(scores).toHaveBeenCalledTimes(2);
  });

  it('查询失败 ⇒ 空表且不缓存，下次重查', async () => {
    scores.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(new Map([['a.example', 1]]));
    const priority = createHostPriority(sql, { DOWNLOAD_SCAN_PRODUCTIVE_FIRST: '1' }, () => 0)!;
    expect(await priority(signal)).toEqual(new Map());
    expect(await priority(signal)).toEqual(new Map([['a.example', 1]]));
    expect(scores).toHaveBeenCalledTimes(2);
  });

  it('zeroyield1102：开关 1/true/on；只开降级 ⇒ 零产出 -1、不查 done 分；两者都开 ⇒ 合并（有 done 分的不降）', async () => {
    expect(demoteZeroYieldEnabled({})).toBe(false);
    expect(demoteZeroYieldEnabled({ DOWNLOAD_SCAN_DEMOTE_ZERO_YIELD: 'yes' })).toBe(false);
    expect(demoteZeroYieldEnabled({ DOWNLOAD_SCAN_DEMOTE_ZERO_YIELD: ' On ' })).toBe(true);
    zero.mockResolvedValue(new Map([['z.example', 9], ['a.example', 5]]));
    const only = createHostPriority(sql, { DOWNLOAD_SCAN_DEMOTE_ZERO_YIELD: '1' }, () => 0)!;
    expect(await only(signal)).toEqual(new Map([['z.example', -1], ['a.example', -1]]));
    expect(scores).not.toHaveBeenCalled();
    scores.mockResolvedValue(new Map([['a.example', 2]]));
    const both = createHostPriority(sql, { DOWNLOAD_SCAN_PRODUCTIVE_FIRST: '1', DOWNLOAD_SCAN_DEMOTE_ZERO_YIELD: '1' }, () => 0)!;
    expect(await both(signal)).toEqual(new Map([['a.example', 2], ['z.example', -1]]));
    const productiveOnly = createHostPriority(sql, { DOWNLOAD_SCAN_PRODUCTIVE_FIRST: '1' }, () => 0)!;
    zero.mockClear();
    expect(await productiveOnly(signal)).toEqual(new Map([['a.example', 2]]));
    expect(zero).not.toHaveBeenCalled();
  });

  it('zeroyield1102：任一查询失败 ⇒ 空表且不缓存', async () => {
    scores.mockResolvedValue(new Map([['a.example', 1]]));
    zero.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(new Map([['z.example', 6]]));
    const priority = createHostPriority(sql, { DOWNLOAD_SCAN_PRODUCTIVE_FIRST: '1', DOWNLOAD_SCAN_DEMOTE_ZERO_YIELD: '1' }, () => 0)!;
    expect(await priority(signal)).toEqual(new Map());
    expect(await priority(signal)).toEqual(new Map([['a.example', 1], ['z.example', -1]]));
  });
});
