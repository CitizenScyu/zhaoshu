// scanmiss1101：选源扫描的「确认无书」记忆 DOWNLOAD_SCAN_MISS_MEMO（=1 开；缺省关，零行为变化）。
//
// 动机（2026-11-01 phoenix 只读）：dlb 24h 选源 2977 次、实探 46.8 万源次，其中 2702 次零候选（book.qq/yunqi
// 换源书为主）。DOWNLOAD_SCAN_ROTATE 让每次重试扫下一个 160 窗口，约 4 次转完全池（~600 可扫源），之后
// no_candidates 长退避（1h/2h/4h…共 16 次 ≈ 55h）里的第 5 次起又从头把刚确认没书的源再搜一遍——免费站收录
// 以天计，同一（书, 源）几小时内重搜几乎必然还是没有，白给源站加压（搜索阶段 host_suspect 成串）。
//
// 做法：搜索/详情走完、正常判「这个源没这本书」（sourceHasBook 返回 false，非异常）的源记进本书的记忆；
// TTL 内的再扫跳过它们（不出网、不扣出网额度，但照旧占扫描窗口名额，轮转窗口划分不变）。异常（超时/不可达/
// 熔断）不记，下次照旧重试。记忆按任务（书名, 作者）原值键，20 实例共用 <state>/scan-miss/ 一个目录（实例
// 随机领任务，进程内记忆命中率只有 1/20）。读写失败一律当无记忆（优化不是门，退回整扫）。
// 文件只存源 URL 的 sha256 前缀与时刻，不存书名、作者、URL。
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** 确认无书的记忆时长：覆盖一轮全池轮转之后的重扫（第 5–8 次约在首扫后 11–23h），过期即重新实探。 */
export const SCAN_MISS_TTL_MS = 24 * 60 * 60_000;
/** 过期文件清扫节拍（每实例）：文件 mtime 超过 TTL 即删，目录规模 ≈ 一天内扫过的书数。 */
export const SCAN_MISS_SWEEP_MS = 60 * 60_000;

export function scanMissMemoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_MISS_MEMO?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export type ScanMissTask = { title: string; author: string };

export interface ScanMissMemo {
  /** 该书 TTL 内确认无书的源 URL 判定函数。 */
  load(task: ScanMissTask): (url: string) => boolean;
  /** 追加本轮确认无书的源（与盘上记录合并；并发写丢更新只会少记，不会错记）。 */
  record(task: ScanMissTask, urls: readonly string[]): void;
}

const sha = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length);

/** workDir = <base>/<inst-N>/<work> 的多实例布局 ⇒ <base>/scan-miss；否则 <workDir>/scan-miss。 */
export function scanMissDir(workDir: string): string {
  const inst = dirname(workDir);
  return /\d$/.test(basename(inst)) ? join(dirname(inst), 'scan-miss') : join(workDir, 'scan-miss');
}

export function createScanMissMemo(dir: string, now: () => number = Date.now): ScanMissMemo {
  let lastSweep = 0;
  const fileOf = (task: ScanMissTask) => join(dir, `${sha(`${task.title}\0${task.author}`, 32)}.json`);
  const read = (file: string): Record<string, number> => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { misses?: unknown };
      const misses = parsed?.misses;
      if (!misses || typeof misses !== 'object') return {};
      const cutoff = now() - SCAN_MISS_TTL_MS;
      const out: Record<string, number> = {};
      for (const [key, at] of Object.entries(misses)) if (typeof at === 'number' && at > cutoff && at <= now()) out[key] = at;
      return out;
    } catch {
      return {};
    }
  };
  const sweep = () => {
    if (now() - lastSweep < SCAN_MISS_SWEEP_MS) return;
    lastSweep = now();
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try { if (now() - statSync(path).mtimeMs > SCAN_MISS_TTL_MS) unlinkSync(path); } catch { /* 别的实例刚删/刚写 */ }
      }
    } catch { /* 目录还没建 */ }
  };
  return {
    load(task) {
      const misses = read(fileOf(task));
      return url => misses[sha(url, 16)] !== undefined;
    },
    record(task, urls) {
      if (!urls.length) return;
      try {
        mkdirSync(dir, { recursive: true });
        const file = fileOf(task);
        const misses = read(file);
        const at = now();
        for (const url of urls) misses[sha(url, 16)] = at;
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ v: 1, misses }));
        renameSync(tmp, file);
      } catch { /* 记不上 = 下次整扫，同改前 */ }
      sweep();
    },
  };
}
