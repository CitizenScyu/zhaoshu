// yield1030：host 优先分提供方（开关、TTL 记忆、失败不缓存）。SQL 语义见 download-source-candidates.pglite.test.ts。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scores = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/download-source-candidates', () => ({ productiveHostScores: scores }));

import { createHostPriority, HOST_PRIORITY_TTL_MS, productiveFirstEnabled, scanRotateEnabled } from './host-priority';

const sql = {} as never;
const signal = new AbortController().signal;

describe('yield1030 host-priority', () => {
  beforeEach(() => { scores.mockReset(); });

  it('开关缺省/非真值 ⇒ undefined（selector 池序原样）', () => {
    expect(createHostPriority(sql, {})).toBeUndefined();
    expect(createHostPriority(sql, { DOWNLOAD_SCAN_PRODUCTIVE_FIRST: '0' })).toBeUndefined();
    expect(productiveFirstEnabled({ DOWNLOAD_SCAN_PRODUCTIVE_FIRST: ' On ' })).toBe(true);
    expect(productiveFirstEnabled({ DOWNLOAD_SCAN_PRODUCTIVE_FIRST: 'true' })).toBe(true);
    expect(scores).not.toHaveBeenCalled();
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
});
