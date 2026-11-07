#!/usr/bin/env node
// prune1108：B 线下载缓存保留。<root>/inst-N/download/out/<适配键>/<引擎键>/ 此前从不清理
// （2026-11-08 现网 51G、日增约 10G，与 Postgres 同盘且根分区无保留块，盘满即全站停）。
// 判龄只看 mtime 与 manifest 顶层 status（读前 512 字节），不解析整份 manifest：
//   活锁：download.lock 在且 max(锁, manifest) 不足 6h（任务预算 5.5h）→ 整目录不动；
//   R1：book.txt 只在完成当刻被 readBookText 读一次、可由章文件重建 → max(book.txt, manifest) 超 1h 即删；
//   R2：done 超 --done-days（默认 3）、R3：其余超 --partial-days（默认 14）→ 不在保护名单则整目录删；
//   保护名单（--protect，用户书的适配键）缺失/格式不对/超 2h 未更新 → 只做 R1。
// 整目录先 rename 进 <out>/.prune-trash 再删：worker 只会看到「完整目录」或「没有目录」。
// 默认 dry-run，--apply 才动盘；只输出计数，不输出路径与书名。
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const BOOK_TXT_MS = HOUR;
export const LIVE_LOCK_MS = 6 * HOUR;
export const PROTECT_MAX_AGE_MS = 2 * HOUR;
const KEY = /^[0-9a-f]{24}$/;
const TRASH = '.prune-trash';
// 引擎以 JSON.stringify(manifest, null, 2) 落盘，顶层键恰两格缩进；章节里的 status 缩进更深，不会误中。
const STATUS = /^ {2}"status": "([a-z_]+)"/m;

const statOf = path => lstatSync(path, { throwIfNoEntry: false });
const freeBytes = path => { const s = statfsSync(path); return s.bavail * s.bsize; };

/** manifest 顶层 status；无 manifest → null，前 512 字节里认不出 → 'unknown'。 */
export function manifestStatus(path) {
  let fd;
  try { fd = openSync(path, 'r'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return STATUS.exec(buf.toString('utf8', 0, n))?.[1] ?? 'unknown';
  } finally { closeSync(fd); }
}

/** 保护名单：首行 `# protect-ok <n>`，其后恰 n 个适配键。不可用 → null（调用方只做 R1）。 */
export function loadProtect(file, now = Date.now()) {
  if (!file) return null;
  try {
    if (now - statSync(file).mtimeMs > PROTECT_MAX_AGE_MS) return null;
    const [header = '', ...keys] = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const count = /^# protect-ok (\d+)$/.exec(header)?.[1];
    if (count === undefined || keys.length !== Number(count) || !keys.every(key => KEY.test(key))) return null;
    return new Set(keys);
  } catch { return null; }
}

/** 单个引擎目录的处置：live（活锁不动）| keep | book（只删 book.txt）| dir（整目录删）。 */
export function decide(dir, adapterKey, { now, protect, doneMs, partialMs }) {
  const manifest = statOf(join(dir, 'manifest.json'));
  const lock = statOf(join(dir, 'download.lock'));
  const manifestMs = manifest?.mtimeMs ?? 0;
  if (lock && Math.max(lock.mtimeMs, manifestMs) > now - LIVE_LOCK_MS) return { action: 'live' };
  const status = manifest ? manifestStatus(join(dir, 'manifest.json')) : null;
  // 有 manifest 时不看目录 mtime：R1 删 book.txt 会刷新它，把 R2 的判龄整体推后。
  const last = Math.max(manifestMs, lock?.mtimeMs ?? 0, manifest ? 0 : statOf(dir)?.mtimeMs ?? now);
  if (protect && !protect.has(adapterKey) && now - last > (status === 'done' ? doneMs : partialMs)) {
    return { action: 'dir', status, lockMs: lock?.mtimeMs };
  }
  const book = statOf(join(dir, 'book.txt'));
  if (book?.isFile() && Math.max(book.mtimeMs, manifestMs) <= now - BOOK_TXT_MS) return { action: 'book', bytes: book.blocks * 512 };
  return { action: 'keep' };
}

/** 整目录删：先改名进回收目录再删。判定后 worker 恰好拿到锁（锁的 mtime 与判定时不同）→ 原样放回，返回 false。 */
export function removeDir(dir, trash, tag, lockMs) {
  mkdirSync(trash, { recursive: true });
  const tomb = join(trash, tag);
  renameSync(dir, tomb);
  const lock = statOf(join(tomb, 'download.lock'));
  if (lock && lock.mtimeMs !== lockMs) { renameSync(tomb, dir); return false; }
  rmSync(tomb, { recursive: true, force: true });
  return true;
}

/** 目录内独占（nlink=1）文件的占用字节：与别的实例硬链接共享的章文件删了也不释放，不计——是下界。 */
function exclusiveBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { total += exclusiveBytes(path); continue; }
    const st = statOf(path);
    if (st?.nlink === 1) total += st.blocks * 512;
  }
  return total;
}

/** @param {{ root: string, protectFile?: string, apply?: boolean, doneDays?: number, partialDays?: number, paceMs?: number, now?: number }} options */
export async function prune({ root, protectFile, apply = false, doneDays = 3, partialDays = 14, paceMs = 0, now = Date.now() }) {
  const protect = loadProtect(protectFile, now);
  const ctx = { now, protect, doneMs: doneDays * DAY, partialMs: partialDays * DAY };
  const report = {
    mode: apply ? 'apply' : 'dry-run', protect: protect ? 'ok' : 'unavailable', protectKeys: protect?.size ?? 0,
    roots: 0, dirs: 0, live: 0, kept: 0, foreign: 0,
    bookTxt: 0, bookTxtBytes: 0, doneDirs: 0, otherDirs: 0,
    // dry-run 估整目录可释放字节（下界）；apply 不估、改报 statfs 实测差值。
    dirBytesMin: apply ? null : 0, freedBytes: null,
    raced: 0, errors: 0, trashLeftover: 0, adaptersRemoved: 0,
  };
  const before = apply ? freeBytes(root) : 0;
  for (const inst of readdirSync(root).filter(name => /^inst-\d+$/.test(name)).sort()) {
    const out = join(root, inst, 'download', 'out');
    if (!statOf(out)?.isDirectory()) continue;
    report.roots += 1;
    const trash = join(out, TRASH);
    if (statOf(trash)) {
      report.trashLeftover += readdirSync(trash).length;
      if (apply) rmSync(trash, { recursive: true, force: true });
    }
    for (const adapter of readdirSync(out, { withFileTypes: true })) {
      if (adapter.name === TRASH) continue;
      if (!adapter.isDirectory() || !KEY.test(adapter.name)) { report.foreign += 1; continue; }
      const adapterDir = join(out, adapter.name);
      let removedHere = false;
      let engines;
      try { engines = readdirSync(adapterDir, { withFileTypes: true }); } catch { report.errors += 1; continue; }
      for (const engine of engines) {
        if (!engine.isDirectory() || !KEY.test(engine.name)) { report.foreign += 1; continue; }
        report.dirs += 1;
        const dir = join(adapterDir, engine.name);
        try {
          const verdict = decide(dir, adapter.name, ctx);
          if (verdict.action === 'live') report.live += 1;
          else if (verdict.action === 'keep') report.kept += 1;
          else if (verdict.action === 'book') {
            if (apply) unlinkSync(join(dir, 'book.txt'));
            report.bookTxt += 1;
            report.bookTxtBytes += verdict.bytes;
          } else {
            if (!apply) report.dirBytesMin += exclusiveBytes(dir);
            else if (!removeDir(dir, trash, `${adapter.name}.${engine.name}.${process.pid}`, verdict.lockMs)) { report.raced += 1; continue; }
            else removedHere = true;
            report[verdict.status === 'done' ? 'doneDirs' : 'otherDirs'] += 1;
            if (apply && paceMs > 0) await sleep(paceMs);
          }
        } catch { report.errors += 1; }
      }
      if (removedHere) {
        try { rmdirSync(adapterDir); report.adaptersRemoved += 1; } catch { /* 还有别的引擎目录 */ }
      }
    }
    if (apply) { try { rmdirSync(trash); } catch { /* 本轮没删目录 */ } }
  }
  if (apply) report.freedBytes = freeBytes(root) - before;
  return report;
}

// 经软链路径启动时 argv[1] 不是 realpath 而 import.meta.url 是；两边都 realpath 再比，免得静默空跑。
const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      protect: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'done-days': { type: 'string', default: '3' },
      'partial-days': { type: 'string', default: '14' },
      'pace-ms': { type: 'string', default: '10' },
    },
  });
  const atLeast = (name, min) => {
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${name} 须为 ≥${min} 的数`);
    return n;
  };
  if (!values.root) throw new Error('缺 --root');
  const report = await prune({
    root: values.root,
    protectFile: values.protect,
    apply: values.apply,
    doneDays: atLeast('done-days', 1),
    partialDays: atLeast('partial-days', 1),
    paceMs: atLeast('pace-ms', 0),
  });
  console.log(JSON.stringify(report));
}
