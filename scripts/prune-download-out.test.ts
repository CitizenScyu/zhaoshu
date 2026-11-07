import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProtect, manifestStatus, prune, removeDir } from './prune-download-out.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const K = (n: number) => n.toString(16).repeat(24);
const ENGINE = 'e'.repeat(24);
const SCRIPT = fileURLToPath(new URL('./prune-download-out.mjs', import.meta.url));
// 写够 15KB：太小的文件可能被内联进 inode/元数据，st_blocks 为 0，字节断言就测不出东西。
const CHAPTER = '第一章正文'.repeat(1000);

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prune1108-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const setAge = (path: string, ageMs: number) => {
  const t = (NOW - ageMs) / 1000;
  utimesSync(path, t, t);
};
const outOf = (inst = 1) => join(root, `inst-${inst}`, 'download', 'out');

interface DirSpec {
  adapter: string;
  inst?: number;
  /** null = 无 manifest */
  status?: 'done' | 'partial' | null;
  manifestAge?: number;
  bookAge?: number;
  lockAge?: number;
  dirAge?: number;
}

function engineDir(spec: DirSpec): string {
  const dir = join(outOf(spec.inst), spec.adapter, ENGINE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0.txt'), CHAPTER);
  if (spec.status !== null) {
    const manifest = {
      schemaVersion: 1, contentFormat: 4, status: spec.status ?? 'done', title: '书', author: '作者',
      chapters: [{ index: 0, title: '第一章', url: 'https://example.invalid/1', chars: 5, status: 'done', file: '0.txt' }],
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    setAge(join(dir, 'manifest.json'), spec.manifestAge ?? 0);
  }
  if (spec.bookAge !== undefined) {
    writeFileSync(join(dir, 'book.txt'), `第一章\n\n${CHAPTER}\n\n`);
    setAge(join(dir, 'book.txt'), spec.bookAge);
  }
  if (spec.lockAge !== undefined) {
    writeFileSync(join(dir, 'download.lock'), '');
    setAge(join(dir, 'download.lock'), spec.lockAge);
  }
  if (spec.dirAge !== undefined) setAge(dir, spec.dirAge);
  return dir;
}

function writeProtect(keys: string[], { ageMs = 0, header = `# protect-ok ${keys.length}` } = {}): string {
  const file = join(root, 'protect.txt');
  writeFileSync(file, [header, ...keys].map(line => `${line}\n`).join(''));
  setAge(file, ageMs);
  return file;
}

describe('manifestStatus', () => {
  it('只认顶层 status（两格缩进），章节里的 status 不算；无文件 → null', () => {
    const path = join(engineDir({ adapter: K(1), status: 'partial' }), 'manifest.json');
    expect(manifestStatus(path)).toBe('partial');
    writeFileSync(path, JSON.stringify({ chapters: [{ status: 'done' }] }, null, 2));
    expect(manifestStatus(path)).toBe('unknown');
    expect(manifestStatus(join(root, 'missing.json'))).toBeNull();
  });
});

describe('loadProtect', () => {
  it('头行计数对得上且 2h 内更新才可用；空名单也可用', () => {
    expect(loadProtect(writeProtect([K(1), K(2)]), NOW)?.size).toBe(2);
    expect(loadProtect(writeProtect([]), NOW)?.size).toBe(0);
  });

  it('过期、截断（计数不符）、坏键、坏头行、缺文件、未给 → null', () => {
    expect(loadProtect(writeProtect([K(1)], { ageMs: 3 * HOUR }), NOW)).toBeNull();
    expect(loadProtect(writeProtect([K(1)], { header: '# protect-ok 2' }), NOW)).toBeNull();
    expect(loadProtect(writeProtect(['not-a-key'], { header: '# protect-ok 1' }), NOW)).toBeNull();
    expect(loadProtect(writeProtect([K(1)], { header: 'protect 1' }), NOW)).toBeNull();
    expect(loadProtect(join(root, 'missing.txt'), NOW)).toBeNull();
    expect(loadProtect(undefined, NOW)).toBeNull();
  });
});

describe('prune 规则', () => {
  function fixture() {
    const dirs = {
      fresh: engineDir({ adapter: K(1), manifestAge: 10 * MIN, bookAge: 10 * MIN }),
      bookOld: engineDir({ adapter: K(2), manifestAge: 2 * HOUR, bookAge: 2 * HOUR }),
      manifestFresh: engineDir({ adapter: K(3), manifestAge: 30 * MIN, bookAge: 5 * HOUR }),
      doneOld: engineDir({ adapter: K(4), manifestAge: 4 * DAY, bookAge: 4 * DAY }),
      doneOldProtected: engineDir({ adapter: K(5), manifestAge: 4 * DAY, bookAge: 4 * DAY }),
      partialOld: engineDir({ adapter: K(6), status: 'partial', manifestAge: 15 * DAY }),
      partialYoung: engineDir({ adapter: K(7), status: 'partial', manifestAge: 10 * DAY }),
      noManifestOld: engineDir({ adapter: K(8), status: null, dirAge: 15 * DAY }),
      liveLock: engineDir({ adapter: K(9), manifestAge: 4 * DAY, bookAge: 4 * DAY, lockAge: HOUR }),
      staleLock: engineDir({ adapter: K(10), status: 'partial', manifestAge: 15 * DAY, lockAge: 20 * DAY }),
      otherInst: engineDir({ adapter: K(11), inst: 2, manifestAge: 4 * DAY }),
    };
    mkdirSync(join(outOf(), 'not-a-key'));
    mkdirSync(join(outOf(), K(12), 'weird'), { recursive: true });
    writeFileSync(join(outOf(), 'stray.txt'), '');
    const nonInst = join(root, 'fanqie', 'out', K(13), ENGINE);
    mkdirSync(nonInst, { recursive: true });
    setAge(nonInst, 30 * DAY);
    return { ...dirs, nonInst };
  }
  const deleted = ['doneOld', 'otherInst', 'partialOld', 'noManifestOld', 'staleLock'] as const;
  const counts = { roots: 2, dirs: 11, live: 1, kept: 3, foreign: 3, bookTxt: 2, doneDirs: 2, otherDirs: 3, raced: 0, errors: 0 };

  it('dry-run：计数与 apply 一致，但盘上一样不动', async () => {
    const f = fixture();
    const report = await prune({ root, protectFile: writeProtect([K(5)]), now: NOW });
    expect(report).toMatchObject({ mode: 'dry-run', protect: 'ok', protectKeys: 1, freedBytes: null, ...counts });
    if (process.platform !== 'win32') expect(report.dirBytesMin).toBeGreaterThan(0);
    for (const name of deleted) expect(existsSync(f[name])).toBe(true);
    expect(existsSync(join(f.bookOld, 'book.txt'))).toBe(true);
  });

  it('apply：R1 删旧 book.txt、R2/R3 删过龄整目录；活锁、保护、未过龄、非实例目录不动；再跑一轮无事可做', async () => {
    const f = fixture();
    const protectFile = writeProtect([K(5)]);
    const report = await prune({ root, protectFile, apply: true, now: NOW });
    expect(report).toMatchObject({ mode: 'apply', protect: 'ok', dirBytesMin: null, adaptersRemoved: 5, ...counts });
    expect(typeof report.freedBytes).toBe('number');
    if (process.platform !== 'win32') expect(report.bookTxtBytes).toBeGreaterThan(0);

    for (const name of deleted) {
      expect(existsSync(f[name]), name).toBe(false);
      expect(existsSync(join(f[name], '..')), `${name} 的适配键目录`).toBe(false);
    }
    for (const name of ['bookOld', 'doneOldProtected'] as const) {
      expect(existsSync(join(f[name], 'book.txt')), name).toBe(false);
      expect(existsSync(join(f[name], 'manifest.json')), name).toBe(true);
      expect(existsSync(join(f[name], '0.txt')), name).toBe(true);
    }
    for (const name of ['fresh', 'manifestFresh', 'liveLock'] as const) expect(existsSync(join(f[name], 'book.txt')), name).toBe(true);
    expect(existsSync(join(f.liveLock, 'download.lock'))).toBe(true);
    expect(existsSync(f.partialYoung)).toBe(true);
    expect(existsSync(f.nonInst)).toBe(true);
    expect(existsSync(join(outOf(), 'not-a-key'))).toBe(true);
    expect(existsSync(join(outOf(), K(12), 'weird'))).toBe(true);
    expect(existsSync(join(outOf(1), '.prune-trash'))).toBe(false);
    expect(existsSync(join(outOf(2), '.prune-trash'))).toBe(false);

    const again = await prune({ root, protectFile, apply: true, now: NOW });
    expect(again).toMatchObject({ dirs: 6, bookTxt: 0, doneDirs: 0, otherDirs: 0, errors: 0 });
  });

  it('保护名单不可用（过期）→ 只做 R1，不删任何整目录', async () => {
    const f = fixture();
    const report = await prune({ root, protectFile: writeProtect([K(5)], { ageMs: 3 * HOUR }), apply: true, now: NOW });
    expect(report).toMatchObject({ protect: 'unavailable', protectKeys: 0, dirs: 11, live: 1, bookTxt: 3, kept: 7, doneDirs: 0, otherDirs: 0 });
    for (const name of deleted) expect(existsSync(f[name]), name).toBe(true);
    expect(existsSync(join(f.doneOld, 'book.txt'))).toBe(false);
  });

  it('上轮中断残留的回收目录：dry-run 只计数，apply 清掉', async () => {
    const leftover = join(outOf(), '.prune-trash', `${K(1)}.${ENGINE}.123`);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, '0.txt'), 'x');
    expect((await prune({ root, now: NOW })).trashLeftover).toBe(1);
    expect(existsSync(leftover)).toBe(true);
    expect((await prune({ root, apply: true, now: NOW })).trashLeftover).toBe(1);
    expect(existsSync(join(outOf(), '.prune-trash'))).toBe(false);
  });
});

describe('removeDir', () => {
  const trash = () => join(outOf(), '.prune-trash');

  it('改名后发现判定时没有的锁（worker 恰好开跑）→ 原样放回', () => {
    const dir = engineDir({ adapter: K(1), status: 'partial', manifestAge: 15 * DAY, lockAge: 0 });
    expect(removeDir(dir, trash(), 'race', undefined)).toBe(false);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, 'download.lock'))).toBe(true);
  });

  it('判定时就在的陈旧锁不算新锁 → 照删', () => {
    const dir = engineDir({ adapter: K(1), status: 'partial', manifestAge: 15 * DAY, lockAge: 20 * DAY });
    expect(removeDir(dir, trash(), 'stale', statSync(join(dir, 'download.lock')).mtimeMs)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(trash(), 'stale'))).toBe(false);
  });
});

describe('CLI', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('默认 dry-run：一行 JSON 计数，不含路径，盘上不动', () => {
    const dir = engineDir({ adapter: K(4), manifestAge: 4 * DAY, bookAge: 4 * DAY });
    const result = run('--root', root);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', protect: 'unavailable', dirs: 1, bookTxt: 1, doneDirs: 0 });
    expect(result.stdout).not.toContain(root);
    expect(existsSync(join(dir, 'book.txt'))).toBe(true);
  });

  it('天数 <1、缺 --root、未知参数 → 非零退出', () => {
    expect(run('--root', root, '--done-days', '0').status).not.toBe(0);
    expect(run('--root', root, '--partial-days', 'x').status).not.toBe(0);
    expect(run().status).not.toBe(0);
    expect(run('--root', root, '--bogus').status).not.toBe(0);
  });
});
