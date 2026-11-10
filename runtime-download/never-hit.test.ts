// neverhit1110 从没搜到过书的 host 判定（临时目录 + mock 候选查询，不连库、不联网）：开关/门槛口径、记忆聚合
// （同书同 host 只算一本、TTL、池外键、坏文件）、阈值与候选 host 排除、读失败与空候选不跳过、TTL 记忆。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recent = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/download-source-candidates', () => ({ recentCandidateHosts: recent }));

import {
  createNeverHit, missBooksByHost, NEVER_HIT_MIN_BOOKS, NEVER_HIT_TTL_MS, neverHitMinBooks, skipNeverHitEnabled,
} from './never-hit';
import { createScanMissMemo, SCAN_MISS_TTL_MS, scanMissKey } from './scan-miss-memo';

const sql = {} as never;
const signal = new AbortController().signal;
const POOL = ['https://n.example/', 'https://n.example/v2', 'https://h.example/', 'https://q.example/'].map(url => ({ url }));
const fresh = () => join(mkdtempSync(join(tmpdir(), 'neverhit-')), 'scan-miss');

/** books 本书在 urls 上确认无书（每本一个记忆文件）。 */
function seed(dir: string, at: number, books: number, urls: string[], prefix = 'b') {
  const memo = createScanMissMemo(dir, () => at);
  for (let i = 0; i < books; i += 1) memo.record({ title: `${prefix}${i}`, author: '' }, urls);
}

describe('neverhit1110 never-hit', () => {
  beforeEach(() => { recent.mockReset(); });

  it('开关仅 1/true/on；门槛缺省 200、非法回缺省、低于 50 按 50', () => {
    expect(skipNeverHitEnabled({})).toBe(false);
    for (const v of ['1', 'true', ' On ']) expect(skipNeverHitEnabled({ DOWNLOAD_SCAN_SKIP_NEVER_HIT: v })).toBe(true);
    for (const v of ['0', 'yes', '']) expect(skipNeverHitEnabled({ DOWNLOAD_SCAN_SKIP_NEVER_HIT: v })).toBe(false);
    expect(neverHitMinBooks({})).toBe(NEVER_HIT_MIN_BOOKS);
    expect(neverHitMinBooks({ DOWNLOAD_SCAN_NEVER_HIT_MIN: 'many' })).toBe(NEVER_HIT_MIN_BOOKS);
    expect(neverHitMinBooks({ DOWNLOAD_SCAN_NEVER_HIT_MIN: '-5' })).toBe(NEVER_HIT_MIN_BOOKS);
    expect(neverHitMinBooks({ DOWNLOAD_SCAN_NEVER_HIT_MIN: ' 300 ' })).toBe(300);
    expect(neverHitMinBooks({ DOWNLOAD_SCAN_NEVER_HIT_MIN: '3' })).toBe(50);
  });

  it('聚合：同书同 host 多 URL 只算一本；过期/未来/池外键、坏文件、.tmp 不计；目录不存在 ⇒ 空表', async () => {
    const dir = fresh();
    const t = 10 * SCAN_MISS_TTL_MS;
    seed(dir, t, 3, ['https://n.example/', 'https://n.example/v2', 'https://h.example/']);
    seed(dir, t - SCAN_MISS_TTL_MS - 1, 4, ['https://q.example/'], 'old');
    seed(dir, t + 1, 2, ['https://q.example/'], 'future');
    seed(dir, t, 2, ['https://gone.example/'], 'gone');
    writeFileSync(join(dir, 'bad.json'), '{not json');
    writeFileSync(join(dir, 'x.json.1.tmp'), JSON.stringify({ v: 1, misses: { [scanMissKey('https://h.example/')]: t } }));
    expect(await missBooksByHost(dir, POOL, t)).toEqual(new Map([['n.example', 3], ['h.example', 3]]));
    expect(await missBooksByHost(join(dir, 'missing'), POOL, t)).toEqual(new Map());
  });

  it('门槛 + 候选 host 排除：达门槛且 30 天无候选/done 才跳；结果按 TTL 记忆', async () => {
    const dir = fresh();
    let t = 10 * SCAN_MISS_TTL_MS;
    seed(dir, t, 60, ['https://n.example/', 'https://h.example/']);
    seed(dir, t, 49, ['https://q.example/'], 'q');
    recent.mockResolvedValue(new Set(['h.example', 'other.example']));
    const neverHit = createNeverHit(sql, dir, 50, () => t);
    expect(await neverHit(POOL, signal)).toEqual(new Set(['n.example']));
    seed(dir, t, 1, ['https://q.example/'], 'q-more');
    t += NEVER_HIT_TTL_MS - 1;
    expect(await neverHit(POOL, signal)).toEqual(new Set(['n.example']));
    expect(recent).toHaveBeenCalledTimes(1);
    t += 1;
    expect(await neverHit(POOL, signal)).toEqual(new Set(['n.example', 'q.example']));
    expect(recent).toHaveBeenCalledTimes(2);
  });

  it('候选查询失败 / 30 天全库无候选 ⇒ 不跳过且不缓存', async () => {
    const dir = fresh();
    const t = 10 * SCAN_MISS_TTL_MS;
    seed(dir, t, 60, ['https://n.example/']);
    recent.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set(['h.example']));
    const neverHit = createNeverHit(sql, dir, 50, () => t);
    expect(await neverHit(POOL, signal)).toEqual(new Set());
    expect(await neverHit(POOL, signal)).toEqual(new Set());
    expect(await neverHit(POOL, signal)).toEqual(new Set(['n.example']));
    expect(recent).toHaveBeenCalledTimes(3);
  });
});
