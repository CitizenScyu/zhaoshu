// hostshare1102 同机共享 host suspect 单元层（临时目录，不连库、不联网）：开关口径、目录布局、跨实例可见、
// 窗口过期、清除、列表缓存、过期清扫、读写失败当无共享记忆、文件名不含站名。
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSharedHostSuspect, hostSuspectDir, SHARED_SUSPECT_CACHE_MS, sharedHostSuspectEnabled,
} from './shared-host-suspect';

const WINDOW = 600_000;
const fresh = () => join(mkdtempSync(join(tmpdir(), 'hostshare-')), 'host-suspect');

describe('hostshare1102 共享 host suspect', () => {
  it('开关：仅 1 开（容忍空白），缺省与其他值关', () => {
    expect(sharedHostSuspectEnabled({})).toBe(false);
    for (const v of ['1', ' 1 ']) expect(sharedHostSuspectEnabled({ DOWNLOAD_SHARED_HOST_SUSPECT: v })).toBe(true);
    for (const v of ['0', '', 'true']) expect(sharedHostSuspectEnabled({ DOWNLOAD_SHARED_HOST_SUSPECT: v })).toBe(false);
  });

  it('目录：多实例布局 <base>/inst-N/download ⇒ <base>/host-suspect；否则 workDir 下', () => {
    expect(hostSuspectDir(join('/var/lib/dlb', 'inst-7', 'download'))).toBe(join('/var/lib/dlb', 'host-suspect'));
    expect(hostSuspectDir(join('/var/lib/dl', 'work'))).toBe(join('/var/lib/dl', 'work', 'host-suspect'));
  });

  it('一个实例 mark，另一个实例（缓存过期后）按站键看到；窗口过期后不再算；文件名不含站名', () => {
    const dir = fresh();
    let t = 1_000_000_000;
    const a = createSharedHostSuspect(dir, WINDOW, () => t);
    const b = createSharedHostSuspect(dir, WINDOW, () => t);
    expect(b.isSuspect('dead.test')).toBe(false); // 读一次：目录还没建，缓存为空
    a.mark('dead.test');
    expect(a.isSuspect('www.dead.test')).toBe(true); // 本实例 mark 直接进缓存
    expect(b.isSuspect('m.dead.test')).toBe(false); // b 的列表缓存未到期
    t += SHARED_SUSPECT_CACHE_MS;
    expect(b.isSuspect('m.dead.test')).toBe(true);
    expect(b.isSuspect('ok.test')).toBe(false);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{24}$/);
    t += WINDOW - SHARED_SUSPECT_CACHE_MS;
    expect(a.isSuspect('dead.test')).toBe(false);
    expect(b.isSuspect('dead.test')).toBe(false);
  });

  it('clear 删文件：其他实例缓存到期后不再算 suspect', () => {
    const dir = fresh();
    let t = 1_000_000_000;
    const a = createSharedHostSuspect(dir, WINDOW, () => t);
    const b = createSharedHostSuspect(dir, WINDOW, () => t);
    a.mark('dead.test');
    expect(b.isSuspect('dead.test')).toBe(true);
    a.clear('www.dead.test');
    expect(a.isSuspect('dead.test')).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
    expect(b.isSuspect('dead.test')).toBe(true); // 缓存未到期
    t += SHARED_SUSPECT_CACHE_MS;
    expect(b.isSuspect('dead.test')).toBe(false);
  });

  it('刷新时清掉超过 1h 的旧文件；mtime 在未来（时钟漂移）的不算', () => {
    const dir = fresh();
    let t = 1_000_000_000;
    const a = createSharedHostSuspect(dir, WINDOW, () => t);
    a.mark('old.test');
    t += 3_600_000 + 1000;
    const b = createSharedHostSuspect(dir, WINDOW, () => t);
    expect(b.isSuspect('old.test')).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
    const future = createSharedHostSuspect(dir, WINDOW, () => t + 60_000);
    future.mark('skew.test');
    const c = createSharedHostSuspect(dir, WINDOW, () => t);
    expect(c.isSuspect('skew.test')).toBe(false);
  });

  it('读写失败当无共享记忆：目录位置是个文件也不抛', () => {
    const base = mkdtempSync(join(tmpdir(), 'hostshare-'));
    const dir = join(base, 'host-suspect');
    writeFileSync(dir, '');
    const s = createSharedHostSuspect(dir, WINDOW, () => 1_000_000_000);
    expect(() => s.mark('dead.test')).not.toThrow();
    expect(() => s.clear('dead.test')).not.toThrow();
    expect(s.isSuspect('dead.test')).toBe(false);
    expect(s.isSuspect('')).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});
