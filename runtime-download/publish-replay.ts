// pubreplay1110：发布退避重领时复用本任务上次的完整缓存，不再重跑 search/toc（DOWNLOAD_PUBLISH_REPLAY=1 开；缺省关）。
//
// 动机（2026-11-10 phoenix 只读）：引擎整本下完、发布撞可重试错（409 等）→ 任务退避放回，重领后整条链路
// 从 search 重跑；源 host 熔断/不可达时整本明明在盘上也发不出去（4 天 4 本卡死、189 个任务重复 complete）。
//
// 做法：adapter 拿到 complete 后在该引擎目录写 publish-replay.json {taskId, sha256}。同一任务 id 再领时，
// 在本实例与兄弟实例的同适配键下找此标记，按 manifest 逐章核 sha256、照引擎口径拼回整本（book.txt 1h 后
// 会被 prune 删掉，不依赖它），整本 sha256 须等于 manifest.artifact.sha256 才当 complete 返回。
// 按任务 id 限定：追更/补缺/重排都是新任务行，照常联网。目录被别的任务重跑、章文件被删、持锁或任一校验
// 不过 → 不命中，照常下载。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EngineManifest } from '../src/lib/download-worker';

const MARKER = 'publish-replay.json';
const ENGINE_KEY = /^[0-9a-f]{24}$/;

export function publishReplayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.DOWNLOAD_PUBLISH_REPLAY?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function engineDirs(root: string): string[] {
  try { return readdirSync(root).filter(name => ENGINE_KEY.test(name)).map(name => join(root, name)); } catch { return []; }
}

/** 与 engine-download 拼 book.txt 同口径；任一章缺失/改动或整本 sha 不符 → null。 */
function rebuild(dir: string, manifest: EngineManifest): string | null {
  const chapters = manifest.chapters;
  if (manifest.status !== 'done' || !manifest.artifact || !Array.isArray(chapters) || !chapters.length) return null;
  let txt = '';
  for (const chapter of chapters) {
    const file = (chapter as { file?: unknown }).file;
    const heading = chapter.heading === undefined ? chapter.title : chapter.heading; // titleclean1111
    if (chapter.status !== 'done' || typeof heading !== 'string' || typeof chapter.sha256 !== 'string'
      || typeof file !== 'string' || !/^\d+\.txt$/.test(file)) return null;
    let text: string;
    try { text = readFileSync(join(dir, file), 'utf8'); } catch { return null; }
    if (sha256(text) !== chapter.sha256) return null;
    txt += `${heading}\n\n${text}\n\n`;
  }
  return sha256(txt) === manifest.artifact.sha256 ? txt : null;
}

export interface ReplayHit { manifest: EngineManifest; txt: string; peer: boolean }

/** 尽力而为：只读，异常一律按不命中。 */
export function findReplay(out: string, peers: readonly string[], taskId: number): ReplayHit | null {
  const key = basename(out);
  const roots = [out, ...peers.map(root => join(root, key))];
  for (const [index, root] of roots.entries()) {
    for (const dir of engineDirs(root)) {
      const marker = readJson(join(dir, MARKER)) as { taskId?: unknown; sha256?: unknown } | null;
      if (marker?.taskId !== taskId || typeof marker.sha256 !== 'string') continue;
      if (existsSync(join(dir, 'download.lock'))) continue;
      const manifest = readJson(join(dir, 'manifest.json')) as EngineManifest | null;
      if (!manifest || manifest.artifact?.sha256 !== marker.sha256) continue;
      const txt = rebuild(dir, manifest);
      if (txt !== null) return { manifest, txt, peer: index > 0 };
    }
  }
  return null;
}

/** 给本次 complete 的引擎目录（manifest done 且 artifact sha 相符）打标记；找不到就不写。 */
export function recordReplay(out: string, taskId: number, artifactSha256: string): void {
  for (const dir of engineDirs(out)) {
    const manifest = readJson(join(dir, 'manifest.json')) as EngineManifest | null;
    if (manifest?.status !== 'done' || manifest.artifact?.sha256 !== artifactSha256) continue;
    const tmp = join(dir, `${MARKER}.tmp`);
    writeFileSync(tmp, JSON.stringify({ taskId, sha256: artifactSha256 }));
    renameSync(tmp, join(dir, MARKER));
    return;
  }
}
