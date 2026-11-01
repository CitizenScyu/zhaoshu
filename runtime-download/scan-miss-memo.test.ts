// scanmiss1101 确认无书记忆单元层（临时目录，不连库、不联网）：开关口径、目录布局、合并/TTL/清扫、
// 读写失败退回无记忆、落盘内容不含书名作者 URL。
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createScanMissMemo, scanMissDir, scanMissMemoEnabled, SCAN_MISS_SWEEP_MS, SCAN_MISS_TTL_MS,
} from './scan-miss-memo';

const TASK = { title: '测试书', author: '佚名' };
const fresh = () => join(mkdtempSync(join(tmpdir(), 'scanmiss-')), 'scan-miss');

describe('scanmiss1101 确认无书记忆', () => {
  it('开关：仅 1/true/on 开，缺省与其他值关', () => {
    expect(scanMissMemoEnabled({})).toBe(false);
    for (const v of ['1', 'true', ' ON ']) expect(scanMissMemoEnabled({ DOWNLOAD_SCAN_MISS_MEMO: v })).toBe(true);
    for (const v of ['0', '', 'yes']) expect(scanMissMemoEnabled({ DOWNLOAD_SCAN_MISS_MEMO: v })).toBe(false);
  });

  it('目录：多实例布局 <base>/inst-N/download ⇒ <base>/scan-miss（20 实例共用）；否则 workDir 下', () => {
    expect(scanMissDir(join('/var/lib/dlb', 'inst-7', 'download'))).toBe(join('/var/lib/dlb', 'scan-miss'));
    expect(scanMissDir(join('/var/lib/dl', 'work'))).toBe(join('/var/lib/dl', 'work', 'scan-miss'));
  });

  it('记录后可读、跨实例共享、与盘上合并；别的书不受影响；落盘不含书名作者 URL', () => {
    const dir = fresh();
    let t = 1_000_000;
    const a = createScanMissMemo(dir, () => t);
    const b = createScanMissMemo(dir, () => t);
    a.record(TASK, ['https://x.example/']);
    t += 1000;
    b.record(TASK, ['https://y.example/']);
    const has = a.load(TASK);
    expect([has('https://x.example/'), has('https://y.example/'), has('https://z.example/')]).toEqual([true, true, false]);
    expect(a.load({ title: TASK.title, author: '别人' })('https://x.example/')).toBe(false);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dir, files[0]), 'utf8');
    for (const secret of [TASK.title, TASK.author, 'example', 'https']) expect(text).not.toContain(secret);
  });

  it('TTL：超过 24h 的记录失效（重新实探），未来时刻的记录不认', () => {
    const dir = fresh();
    let t = 5_000_000;
    const memo = createScanMissMemo(dir, () => t);
    memo.record(TASK, ['https://x.example/']);
    t += SCAN_MISS_TTL_MS - 1;
    expect(memo.load(TASK)('https://x.example/')).toBe(true);
    t += 2;
    expect(memo.load(TASK)('https://x.example/')).toBe(false);
    t -= 10 * SCAN_MISS_TTL_MS;
    expect(memo.load(TASK)('https://x.example/')).toBe(false);
  });

  it('坏文件/空记录/目录不可写 ⇒ 当无记忆，不抛', () => {
    const dir = fresh();
    const memo = createScanMissMemo(dir);
    memo.record(TASK, []);
    expect(() => readdirSync(dir)).toThrow();
    memo.record(TASK, ['https://x.example/']);
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file), '{not json');
    expect(memo.load(TASK)('https://x.example/')).toBe(false);
    memo.record(TASK, ['https://y.example/']);
    expect(memo.load(TASK)('https://y.example/')).toBe(true);

    const blocked = join(mkdtempSync(join(tmpdir(), 'scanmiss-')), 'f');
    writeFileSync(blocked, '');
    const broken = createScanMissMemo(join(blocked, 'scan-miss'));
    expect(() => broken.record(TASK, ['https://x.example/'])).not.toThrow();
    expect(broken.load(TASK)('https://x.example/')).toBe(false);
  });

  it('清扫：每实例至多每小时一次，删 mtime 超过 TTL 的文件', () => {
    const dir = fresh();
    let t = Date.now();
    const memo = createScanMissMemo(dir, () => t);
    memo.record({ title: 'old', author: 'a' }, ['https://x.example/']);
    const [oldFile] = readdirSync(dir);
    const past = (t - SCAN_MISS_TTL_MS - 60_000) / 1000;
    utimesSync(join(dir, oldFile), past, past);
    memo.record(TASK, ['https://x.example/']);
    expect(readdirSync(dir)).toHaveLength(2);
    t += SCAN_MISS_SWEEP_MS;
    memo.record(TASK, ['https://y.example/']);
    expect(readdirSync(dir)).not.toContain(oldFile);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
