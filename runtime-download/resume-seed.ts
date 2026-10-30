// resumeseed1031：跨实例续传种子 DOWNLOAD_RESUME_PEERS（=1 开；缺省关，零行为变化）。
//
// 动机（2026-10-31 phoenix 只读）：dlb 20 个实例各自一个 out 根（<state>/inst-N/download/out），
// 引擎续传只读本实例的 manifest。任务重试（hostWait 排队、熔断让出、退避）几乎总落到别的实例 →
// previous 读不到，已抓章节全部重抓：sto66 f1355f 5 次重试分落 inst-17/1/4/13/6，每次重抓前 20 章；
// 72h 内 143 本跨实例、按上界估约 3.7 万章重抓（还在给源站加压、触发限速熔断）。
//
// 做法：引擎开跑前（adapter 已算出 out=<outRoot>/<任务键>），在同级实例的同名任务键目录里找
// done 章最多的 manifest；比本实例的多才种入——manifest 拷贝、done 章文件硬链接（引擎写章是
// 临时文件 + rename，不原地改，硬链接两边互不影响；跨设备退回拷贝）。引擎侧照旧逐章核 sha256，
// 种错/半截的文件只会被重抓，不会被采信。持锁（download.lock）的同级目录跳过（可能正在跑）。
// 本实例并发=1（同一时刻只有一次 downloadBook），开跑前本任务键下残留的 download.lock 必是崩溃/
// SIGKILL 遗留，一并清掉（否则 openSync 'wx' 抛 EEXIST → adapter_runtime_error）。
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const flagOn = (raw: string | undefined): boolean => {
  const value = raw?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
};

export function resumePeersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(env.DOWNLOAD_RESUME_PEERS);
}

// stalelock1031：DOWNLOAD_RESUME_STALE_LOCKS（=1 开；缺省关 = 持锁同级一律跳过，逐字同改前）。
// 生产 2026-10-31 只读：同级目录残留锁 129 个（117 个 >24h，全是 partial，锁与 manifest 都 >1h 未动），
// 背后压着 8.8 万 done 章，其中 103 个任务键已在别的实例重跑过——崩溃/SIGKILL 遗留的锁把种子源挡死。
// 活的运行每推进一章最多 5s 落一次 manifest，锁与 manifest 都 1h 未动即判失效。误判也安全：只读同级，
// 章文件与 manifest 都是临时文件 + rename 落盘，读到的是一致快照，引擎照旧逐章核 sha256。
export const PEER_LOCK_STALE_MS = 60 * 60_000;

export function resumeStaleLocksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(env.DOWNLOAD_RESUME_STALE_LOCKS);
}

const mtimeMs = (path: string): number => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;

/** outRoot = <base>/<inst>/<work>/out ⇒ 同前缀（去尾部数字后相同）兄弟实例的 <base>/<peer>/<work>/out，不含自身、只取存在的。 */
export function peerOutRoots(outRoot: string): string[] {
  const work = dirname(outRoot);
  const inst = dirname(work);
  const base = dirname(inst);
  const own = basename(inst);
  const prefix = own.replace(/\d+$/, '');
  if (prefix === own) return []; // 实例名不带序号：不是多实例布局
  let names: string[];
  try { names = readdirSync(base); } catch { return []; }
  return names
    .filter(name => name !== own && name.replace(/\d+$/, '') === prefix && /\d$/.test(name))
    .map(name => join(base, name, basename(work), basename(outRoot)))
    .filter(root => existsSync(root));
}

interface ManifestLike { chapters?: Array<{ status?: unknown; file?: unknown }> }

function readManifest(dir: string): { manifest: ManifestLike; done: string[] } | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ManifestLike;
    if (!Array.isArray(manifest.chapters)) return null;
    // 章文件名只认引擎固定口径 <index>.txt，防 manifest 里的路径穿越。
    const done = manifest.chapters
      .filter(c => c?.status === 'done' && typeof c.file === 'string' && /^\d+\.txt$/.test(c.file))
      .map(c => c.file as string);
    return { manifest, done };
  } catch { return null; }
}

function place(src: string, dst: string): void {
  try { unlinkSync(dst); } catch { /* 不存在 */ }
  try { linkSync(src, dst); } catch { copyFileSync(src, dst); }
}

export interface SeedResult { chapters: number; unlocked: number }
export interface SeedOptions { staleLocks?: boolean; now?: number }

/** 尽力而为：任何异常吞掉（照常从头抓）；只返回计数，不带路径。 */
export function seedFromPeers(out: string, peers: readonly string[], options: SeedOptions = {}): SeedResult {
  const result: SeedResult = { chapters: 0, unlocked: 0 };
  const now = options.now ?? Date.now();
  const lockLive = (dir: string): boolean => {
    const lock = join(dir, 'download.lock');
    if (!existsSync(lock)) return false;
    if (!options.staleLocks) return true;
    return Math.max(mtimeMs(lock), mtimeMs(join(dir, 'manifest.json'))) > now - PEER_LOCK_STALE_MS;
  };
  const key = basename(out);
  try {
    for (const sub of existsSync(out) ? readdirSync(out) : []) {
      const lock = join(out, sub, 'download.lock');
      if (existsSync(lock)) { unlinkSync(lock); result.unlocked += 1; }
    }
  } catch { /* 清锁失败交给引擎照旧报错 */ }
  const best = new Map<string, { dir: string; done: string[] }>();
  for (const root of peers) {
    let subs: string[];
    try { subs = readdirSync(join(root, key)); } catch { continue; }
    for (const sub of subs) {
      const dir = join(root, key, sub);
      if (lockLive(dir)) continue;
      const read = readManifest(dir);
      if (!read || !read.done.length) continue;
      const current = best.get(sub);
      if (!current || read.done.length > current.done.length) best.set(sub, { dir, done: read.done });
    }
  }
  for (const [sub, peer] of best) {
    try {
      const dst = join(out, sub);
      const own = readManifest(dst);
      if (own && own.done.length >= peer.done.length) continue;
      mkdirSync(dst, { recursive: true });
      let placed = 0;
      for (const file of peer.done) {
        const src = join(peer.dir, file);
        if (!statSync(src, { throwIfNoEntry: false })?.isFile()) continue;
        place(src, join(dst, file));
        placed += 1;
      }
      // manifest 最后落（临时文件 + rename）：中途失败时本地仍是旧 manifest，多出的章文件无害。
      const tmp = join(dst, 'manifest.json.seed');
      writeFileSync(tmp, readFileSync(join(peer.dir, 'manifest.json')));
      renameSync(tmp, join(dst, 'manifest.json'));
      result.chapters += placed;
    } catch { /* 该子目录种子失败：照常从头抓 */ }
  }
  return result;
}
