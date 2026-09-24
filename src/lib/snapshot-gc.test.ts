// B2-05 快照卷 GC:用发布器本身落多个版本(小卷,内容相同的卷跨版本共用快照),
// 再对内存存储跑 GC。不联网、不碰真实存储。
import { describe, expect, it, vi } from 'vitest';
import { publishBookVersion, snapshotPaths, type GitHubContents } from './download-publisher';
import { collectSnapshotGarbage, type SnapshotGcStore } from './snapshot-gc';
import { parseVolumeManifest, type VolumeManifest } from './volume-manifest';

const TITLE = '测试书';
const AUTHOR = '佚名';
const DAY = 24 * 60 * 60_000;
const guardOk = { check: async () => {} };

class MemoryStore implements GitHubContents, SnapshotGcStore {
  files = new Map<string, string>();
  deleteFile = vi.fn(async (path: string) => { this.files.delete(path); });
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
  async listFiles(dir: string): Promise<string[]> {
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(path => path.slice(prefix.length));
  }
}

const paths = snapshotPaths(TITLE, AUTHOR);
const stem = paths.dir.split('/').pop()!;

/** 每章 3.6 KB,卷软目标 3000 B ⇒ 一章一卷;章正文相同的卷跨版本共用同一快照文件。无前言,章数 = bodies.length。 */
function book(bodies: string[]): string {
  const lines: string[] = [];
  bodies.forEach((body, i) => lines.push(`【第${i + 1}章 合成】`, '', body.repeat(1200)));
  return lines.join('\n');
}

async function publish(store: MemoryStore, bodies: string[], taskId: number): Promise<VolumeManifest> {
  const result = await publishBookVersion(store, guardOk, {
    taskId, title: TITLE, author: AUTHOR, txt: book(bodies),
    chaptersDone: bodies.length, chaptersTotal: bodies.length, charsTotal: bodies.length * 2400,
  }, { maxVolumeBytes: 3000 });
  if (!result.promoted) throw new Error('fixture must promote');
  return parseVolumeManifest(Buffer.from(store.files.get(`${paths.dir}/${result.version}.json`)!, 'utf8'))!;
}

const snaps = (manifest: VolumeManifest) => manifest.volumes.map(volume => volume.snapshot_path);

/** 三个版本:A=[甲乙丙] → B=[甲乙丁] → C=[甲戊丁]。甲卷三版共用;乙卷只在 A/B;丙卷只在 A。 */
async function threeVersions() {
  const store = new MemoryStore();
  const a = await publish(store, ['甲', '乙', '丙'], 1);
  const b = await publish(store, ['甲', '乙', '丁'], 2);
  const c = await publish(store, ['甲', '戊', '丁'], 3);
  return { store, a, b, c };
}

const LATER = Date.now() + 30 * DAY; // 三份清单都在 7 天保护窗外

describe('B2-05 快照卷 GC', () => {
  it('夹具自检:一章一卷,甲卷在三版间共用同一快照文件', async () => {
    const { a, b, c } = await threeVersions();
    expect([a, b, c].map(m => m.volumes.length)).toEqual([3, 3, 3]);
    expect(snaps(a)[0]).toBe(snaps(b)[0]);
    expect(snaps(b)[0]).toBe(snaps(c)[0]);
    expect(snaps(a)[1]).toBe(snaps(b)[1]); // 乙
    expect(snaps(c)[1]).not.toBe(snaps(b)[1]); // 戊 ≠ 乙
  });

  it('共用快照不被删:甲卷同时被已过期的 A 与存活的 C 引用 ⇒ 保留', async () => {
    const { store, a, c } = await threeVersions();
    const report = await collectSnapshotGarbage(store, stem, { now: LATER });
    expect(report.skipped).toBeNull();
    expect(snaps(a)[0]).toBe(snaps(c)[0]);
    expect(report.retained).toContain(snaps(a)[0]);
    expect(report.orphans).not.toContain(snaps(a)[0]);
  });

  it('上一版引用的保留:乙卷只被 A(过期)与 B(上一版)引用 ⇒ 保留;默认 keepVersions<2 也按 2 算', async () => {
    const { store, b, c } = await threeVersions();
    for (const keepVersions of [undefined, 1, 0]) {
      const report = await collectSnapshotGarbage(store, stem, { now: LATER, keepVersions });
      expect(report.liveVersions).toEqual([b.version, c.version].sort());
      expect(report.retained).toContain(snaps(b)[1]);
      expect(report.orphans).not.toContain(snaps(b)[1]);
    }
  });

  it('孤儿被列出:只被过期 A 引用的丙卷 + 无任何清单引用的残卷;清单/指针/非卷文件不在候选内', async () => {
    const { store, a, b, c } = await threeVersions();
    const stray = `${paths.dir}/v-deadbeef.txt`; // 发布阶段 1 已写、清单未落的残卷
    store.files.set(stray, '残卷');
    store.files.set(`${paths.dir}/0badf00d.txt`, '旧单文件时代的整本快照');
    const report = await collectSnapshotGarbage(store, stem, { now: LATER });
    expect(report.orphans).toEqual([snaps(a)[2], stray].sort());
    const kept = new Set([...snaps(b), ...snaps(c)]);
    expect(report.retained).toEqual([...kept].sort());
    expect(report.orphans.every(path => /\/v-[a-f0-9]{8}\.txt$/.test(path))).toBe(true);
  });

  it('dry-run 不删:默认模式只报告,存储逐字节不变、deleteFile 零调用', async () => {
    const { store } = await threeVersions();
    const before = new Map(store.files);
    const report = await collectSnapshotGarbage(store, stem, { now: LATER });
    expect(report.mode).toBe('dry-run');
    expect(report.orphans.length).toBeGreaterThan(0);
    expect(report.deleted).toEqual([]);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(store.files).toEqual(before);
  });

  it('execute:只删孤儿;删后当前版、上一版与规范清单引用的每个快照卷仍在', async () => {
    const { store, a, b, c } = await threeVersions();
    const isPublishing = vi.fn(async () => false);
    const report = await collectSnapshotGarbage(store, stem, { now: LATER, execute: true, isPublishing });
    expect(isPublishing).toHaveBeenCalledWith(stem);
    expect(report.deleted).toEqual([snaps(a)[2]]);
    expect(store.files.has(snaps(a)[2])).toBe(false);
    const canonical = parseVolumeManifest(Buffer.from(store.files.get(paths.canonicalPath)!, 'utf8'))!;
    for (const path of [...snaps(b), ...snaps(c), ...snaps(canonical)]) expect(store.files.has(path)).toBe(true);
    expect(store.files.has(`${paths.dir}/${a.version}.json`)).toBe(true); // 版本清单不动
  });

  it('execute 但该书有在途发布 ⇒ 整本跳过,零删除', async () => {
    const { store } = await threeVersions();
    const report = await collectSnapshotGarbage(store, stem, { now: LATER, execute: true, isPublishing: async () => true });
    expect(report.skipped).toBe('publishing');
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('规范 index.json 引用的版本(指针未跟上)同样存活:其快照卷保留', async () => {
    const { store, a } = await threeVersions();
    // 线上 index.json 仍是 A(如回滚或规范阶段中途失败后的残局),指针已指 C。
    store.files.set(paths.canonicalPath, store.files.get(`${paths.dir}/${a.version}.json`)!);
    const report = await collectSnapshotGarbage(store, stem, { now: LATER });
    expect(report.orphans).toEqual([]);
    expect(report.retained).toContain(snaps(a)[2]);
  });

  it('保护窗:清单生成于 7 天内 ⇒ 视为存活,A 的丙卷不列为孤儿', async () => {
    const { store, a } = await threeVersions();
    const report = await collectSnapshotGarbage(store, stem, { now: Date.now() });
    expect(report.liveVersions).toContain(a.version);
    expect(report.orphans).toEqual([]);
  });

  it('fail closed:任一清单或指针读不懂 ⇒ 整本跳过,execute 也零删除', async () => {
    const { store, a } = await threeVersions();
    const manifestPath = `${paths.dir}/${a.version}.json`;
    const original = store.files.get(manifestPath)!;
    store.files.set(manifestPath, '{truncated');
    const opts = { now: LATER, execute: true as const, isPublishing: async () => false };
    expect((await collectSnapshotGarbage(store, stem, opts)).skipped).toBe('unreadable_manifest');
    store.files.set(manifestPath, original);
    store.files.set(`${paths.dir}/current.json`, 'not json');
    expect((await collectSnapshotGarbage(store, stem, opts)).skipped).toBe('unreadable_pointer');
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('非法 stem 直接拒绝', async () => {
    const store = new MemoryStore();
    for (const bad of ['', '.', '..', 'a/b']) {
      await expect(collectSnapshotGarbage(store, bad)).rejects.toThrow('snapshot stem is invalid');
    }
  });
});

