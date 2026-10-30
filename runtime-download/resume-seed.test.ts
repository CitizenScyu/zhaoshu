import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peerOutRoots, resumePeersEnabled, seedFromPeers } from './resume-seed';

// resumeseed1031：合成目录布局 <base>/inst-N/download/out/<任务键>/<书键>/，全部假数据。
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function layout() {
  const base = mkdtempSync(join(tmpdir(), 'resume-seed-'));
  dirs.push(base);
  const outOf = (inst: string) => { const out = join(base, inst, 'download', 'out'); mkdirSync(out, { recursive: true }); return out; };
  return { base, outOf };
}

function book(out: string, statuses: string, opts: { lock?: boolean; key?: string; sub?: string } = {}) {
  const dir = join(out, opts.key ?? 'taskkey', opts.sub ?? 'bookkey');
  mkdirSync(dir, { recursive: true });
  const chapters = [...statuses].map((s, index) => ({ index, file: `${index}.txt`, status: s === 'd' ? 'done' : s === 'f' ? 'failed' : 'pending' }));
  chapters.forEach((c, index) => { if (c.status === 'done') writeFileSync(join(dir, c.file), `第${index}章正文`); });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ tocHash: 'h', chapters }));
  if (opts.lock) writeFileSync(join(dir, 'download.lock'), '');
  return dir;
}

describe('resumeseed1031 跨实例续传种子', () => {
  it('开关解析：缺省/0 关，1/true/on 开', () => {
    expect(resumePeersEnabled({})).toBe(false);
    expect(resumePeersEnabled({ DOWNLOAD_RESUME_PEERS: '0' })).toBe(false);
    expect(resumePeersEnabled({ DOWNLOAD_RESUME_PEERS: '1' })).toBe(true);
    expect(resumePeersEnabled({ DOWNLOAD_RESUME_PEERS: ' On ' })).toBe(true);
  });

  it('peerOutRoots：同前缀带序号的兄弟实例，不含自身/无 out 的/别的目录', () => {
    const { base, outOf } = layout();
    const own = outOf('inst-1');
    outOf('inst-2'); outOf('inst-13');
    mkdirSync(join(base, 'inst-7')); // 无 out
    mkdirSync(join(base, 'shared-rate-data', 'download', 'out'), { recursive: true });
    mkdirSync(join(base, 'inst-x', 'download', 'out'), { recursive: true });
    expect(peerOutRoots(own).sort()).toEqual([
      join(base, 'inst-13', 'download', 'out'),
      join(base, 'inst-2', 'download', 'out'),
    ].sort());
    // 不带序号的单实例布局：没有兄弟
    expect(peerOutRoots(join(base, 'solo', 'download', 'out'))).toEqual([]);
  });

  it('同级实例 done 更多 ⇒ 种入 manifest 与 done 章（硬链接/拷贝），本地清残留锁', () => {
    const { outOf } = layout();
    const own = outOf('inst-1');
    const peerA = outOf('inst-2');
    const peerB = outOf('inst-3');
    book(peerA, 'ddp');
    const src = book(peerB, 'dddffp');
    const mine = book(own, 'dpp', { lock: true });
    const out = join(own, 'taskkey');
    expect(seedFromPeers(out, [peerA, peerB])).toEqual({ chapters: 3, unlocked: 1 });
    expect(existsSync(join(mine, 'download.lock'))).toBe(false);
    expect(readFileSync(join(mine, 'manifest.json'), 'utf8')).toBe(readFileSync(join(src, 'manifest.json'), 'utf8'));
    for (const i of [0, 1, 2]) expect(readFileSync(join(mine, `${i}.txt`), 'utf8')).toBe(`第${i}章正文`);
    expect(existsSync(join(mine, '3.txt'))).toBe(false);
    expect(existsSync(join(mine, 'manifest.json.seed'))).toBe(false);
    // 源目录原样
    expect(statSync(join(src, '0.txt')).isFile()).toBe(true);
  });

  it('本地已不少于同级 / 同级持锁 / 别的任务键 ⇒ 不种', () => {
    const { outOf } = layout();
    const own = outOf('inst-1');
    const peer = outOf('inst-2');
    const locked = outOf('inst-3');
    book(peer, 'ddp');
    book(locked, 'dddd', { lock: true });
    book(peer, 'dddddd', { key: 'otherkey' });
    const mine = book(own, 'ddd');
    const before = readFileSync(join(mine, 'manifest.json'), 'utf8');
    expect(seedFromPeers(join(own, 'taskkey'), [peer, locked])).toEqual({ chapters: 0, unlocked: 0 });
    expect(readFileSync(join(mine, 'manifest.json'), 'utf8')).toBe(before);
  });

  it('本地无目录 ⇒ 新建；manifest 里非 <index>.txt 的文件名不采信', () => {
    const { outOf } = layout();
    const own = outOf('inst-1');
    const peer = outOf('inst-2');
    const src = book(peer, 'dd');
    const m = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
    m.chapters[1].file = '../../../evil.txt';
    writeFileSync(join(src, 'manifest.json'), JSON.stringify(m));
    expect(seedFromPeers(join(own, 'taskkey'), [peer])).toEqual({ chapters: 1, unlocked: 0 });
    expect(readFileSync(join(own, 'taskkey', 'bookkey', '0.txt'), 'utf8')).toBe('第0章正文');
  });

  it('同级 manifest 损坏 / 无同级 ⇒ 不抛、不种', () => {
    const { outOf } = layout();
    const own = outOf('inst-1');
    const peer = outOf('inst-2');
    mkdirSync(join(peer, 'taskkey', 'bookkey'), { recursive: true });
    writeFileSync(join(peer, 'taskkey', 'bookkey', 'manifest.json'), '{not json');
    expect(seedFromPeers(join(own, 'taskkey'), [peer, join(peer, 'missing')])).toEqual({ chapters: 0, unlocked: 0 });
    expect(existsSync(join(own, 'taskkey'))).toBe(false);
  });
});
