// hostshare1102：同机多实例共享 host suspect 记忆 DOWNLOAD_SHARED_HOST_SUSPECT（=1 开；缺省关，零行为变化）。
//
// 动机（2026-11-02 phoenix 只读，24h）：dlb 20 实例各自记 source-host-health（进程内），host_suspect 3848 次、
// 涉 35 个站（network 2223 / timeout 1499 / 5xx 126），其中 2717 次发生在别的实例已判同站 suspect 的 10 分钟内——
// 每次都是本实例再付 ≥2 次硬失败（超时最长 30s）才知道这个站正挂着。
//
// 做法：任一实例的站刚跨进 suspect（setHostHealthListener）就在 <state>/host-suspect/ 下 touch 一个文件（文件名 =
// 站键 sha256 前缀，mtime = 时刻）；选源/回退判 suspect 时，本进程记忆或共享目录里窗口内（SOURCE_HOST_SUSPECT_MS）
// 有记录都算。本进程对记过失败的站拿到成功就删掉文件（站恢复了）。窗口过期自然失效，与进程内半开语义一致。
// 目录列表按 SHARED_SUSPECT_CACHE_MS 缓存（站数几十个，一次 readdir+stat）。读写失败一律当无共享记忆。
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stationKeyOfHost } from '../src/lib/source-policy';

/** 共享目录列表缓存时长：判 suspect 的读路径（选源每源一次）不逐次碰盘。 */
export const SHARED_SUSPECT_CACHE_MS = 15_000;
/** 文件 mtime 超过此值即在刷新时清掉（窗口上限 1h，过了就没用了）。 */
const STALE_MS = 3_600_000;

export function sharedHostSuspectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DOWNLOAD_SHARED_HOST_SUSPECT?.trim() === '1';
}

/** workDir = <base>/<inst-N>/<work> 的多实例布局 ⇒ <base>/host-suspect；否则 <workDir>/host-suspect（同 scanMissDir）。 */
export function hostSuspectDir(workDir: string): string {
  const inst = dirname(workDir);
  return /\d$/.test(basename(inst)) ? join(dirname(inst), 'host-suspect') : join(workDir, 'host-suspect');
}

export interface SharedHostSuspect {
  /** 站刚判 suspect：广播给同目录的其他实例。参数可以是 host 或站键。 */
  mark(host: string): void;
  /** 站恢复：撤掉广播。 */
  clear(host: string): void;
  /** 共享目录里该站在窗口内被判过 suspect。 */
  isSuspect(host: string): boolean;
}

const fileName = (host: string) => createHash('sha256').update(stationKeyOfHost(host)).digest('hex').slice(0, 24);

export function createSharedHostSuspect(dir: string, windowMs: number, now: () => number = Date.now): SharedHostSuspect {
  let cache = new Map<string, number>();
  let cachedAt = -Infinity;
  const refresh = () => {
    if (now() - cachedAt < SHARED_SUSPECT_CACHE_MS) return;
    cachedAt = now();
    const next = new Map<string, number>();
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try {
          const at = statSync(path).mtimeMs;
          if (now() - at > STALE_MS) unlinkSync(path);
          else next.set(name, at);
        } catch { /* 别的实例刚删 */ }
      }
    } catch { /* 目录还没建 */ }
    cache = next;
  };
  return {
    mark(host) {
      if (!host) return;
      const name = fileName(host);
      try {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, '');
        const at = now() / 1000;
        utimesSync(path, at, at);
        cache.set(name, now());
      } catch { /* 记不上 = 其他实例各自探测，同改前 */ }
    },
    clear(host) {
      if (!host) return;
      const name = fileName(host);
      cache.delete(name);
      try { unlinkSync(join(dir, name)); } catch { /* 本来就没有 */ }
    },
    isSuspect(host) {
      if (!host) return false;
      refresh();
      const at = cache.get(fileName(host));
      return at !== undefined && now() - at < windowMs && at <= now() + 1000;
    },
  };
}
