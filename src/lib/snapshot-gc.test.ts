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

// gcls-41:复审 b203rev §12-2「清单文件整体缺失」窗口 —— 目录有快照卷却读不到应有的清单 ⇒ 整本跳过。
describe('B2-05 快照卷 GC:清单/指针缺失与存储错误一律 fail closed', () => {
  const exec = { now: LATER, execute: true as const, isPublishing: async () => false };

  it('volumeCount 照实报告目录里的快照卷数', async () => {
    const { store } = await threeVersions();
    const report = await collectSnapshotGarbage(store, stem, { now: LATER });
    expect(report.volumeCount).toBe(5); // 甲乙丙丁戊
    expect(report.retained.length + report.orphans.length).toBe(5);
  });

  it('过期版本 A 的清单文件整体缺失(仍在指针 history 里)⇒ missing_manifest,丙卷不被当孤儿删', async () => {
    const { store, a } = await threeVersions();
    store.files.delete(`${paths.dir}/${a.version}.json`);
    const report = await collectSnapshotGarbage(store, stem, exec);
    expect(report.skipped).toBe('missing_manifest');
    expect(report.orphans).toEqual([]);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(store.files.has(snaps(a)[2])).toBe(true);
  });

  it('目录有快照卷但所有版本清单都不在 ⇒ missing_manifest', async () => {
    const { store } = await threeVersions();
    for (const path of [...store.files.keys()]) if (/\/[a-f0-9]{8}\.json$/.test(path)) store.files.delete(path);
    expect((await collectSnapshotGarbage(store, stem, exec)).skipped).toBe('missing_manifest');
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('目录有快照卷但没有 current.json ⇒ missing_pointer', async () => {
    const { store } = await threeVersions();
    store.files.delete(`${paths.dir}/current.json`);
    expect((await collectSnapshotGarbage(store, stem, exec)).skipped).toBe('missing_pointer');
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('列目录看得到、读回却 404(清单或指针)⇒ 整本跳过', async () => {
    const { store, a } = await threeVersions();
    const realGet = store.getBytes.bind(store);
    const gone = new Set([`${paths.dir}/${a.version}.json`]);
    store.getBytes = async path => (gone.has(path) ? null : realGet(path));
    expect((await collectSnapshotGarbage(store, stem, exec)).skipped).toBe('missing_manifest');
    gone.clear();
    gone.add(`${paths.dir}/current.json`);
    expect((await collectSnapshotGarbage(store, stem, exec)).skipped).toBe('missing_pointer');
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('指针 current 不是 8hex ⇒ unreadable_pointer', async () => {
    const { store } = await threeVersions();
    store.files.set(`${paths.dir}/current.json`, JSON.stringify({ current: 'nope', history: [] }));
    expect((await collectSnapshotGarbage(store, stem, exec)).skipped).toBe('unreadable_pointer');
  });

  it('读取抛错(网络/限流/5xx)⇒ store_error,只带错误摘要,零删除', async () => {
    const { store, b } = await threeVersions();
    const realGet = store.getBytes.bind(store);
    store.getBytes = async path => {
      if (path.endsWith(`${b.version}.json`)) throw Object.assign(new Error('github_http_502'), { status: 502 });
      return realGet(path);
    };
    const report = await collectSnapshotGarbage(store, stem, exec);
    expect(report).toMatchObject({ skipped: 'store_error', detail: 'github_http_502', orphans: [], deleted: [] });
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('列目录抛错 ⇒ store_error', async () => {
    const store = new MemoryStore();
    store.listFiles = async () => { throw new Error('github_tree_truncated'); };
    const report = await collectSnapshotGarbage(store, stem, exec);
    expect(report).toMatchObject({ skipped: 'store_error', detail: 'github_tree_truncated', volumeCount: 0 });
  });

  it('清单里某项 snapshot_path 缺失/非字符串 ⇒ 整份清单不可读(fail closed),不得跳过该项漏记引用', async () => {
    const { store, a } = await threeVersions();
    const manifestPath = `${paths.dir}/${a.version}.json`;
    const manifest = JSON.parse(store.files.get(manifestPath)!) as { volumes: Record<string, unknown>[] };
    // 丙卷只被 A 引用:若实现「跳过坏项」而非「整份判不可读」,这条引用会被漏记 ⇒ 丙卷被误判孤儿。
    delete manifest.volumes[2]!.snapshot_path;
    store.files.set(manifestPath, JSON.stringify(manifest));
    const report = await collectSnapshotGarbage(store, stem, exec);
    expect(report).toMatchObject({ skipped: 'unreadable_manifest', orphans: [], deleted: [] });
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(store.files.has(snaps(a)[2])).toBe(true);

    // 非字符串(这里是数字)同理。
    manifest.volumes[2]!.snapshot_path = 123 as unknown as string;
    store.files.set(manifestPath, JSON.stringify(manifest));
    expect((await collectSnapshotGarbage(store, stem, exec)).skipped).toBe('unreadable_manifest');

    // 规范清单的单项缺字段同样整份判不可读(requireVolumes 路径)。
    store.files.set(paths.canonicalPath, JSON.stringify({ schema: 2, format: 'volumes', volumes: [{ path: 'books/x/vol-001.txt' }] }));
    expect((await collectSnapshotGarbage(store, stem, exec)).skipped).toBe('unreadable_canonical');
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('规范 index.json 整体不在(读回 null)⇒ 不跳过,只少一个引用来源;仍按指针/保护窗判定', async () => {
    const { store, a } = await threeVersions();
    store.files.delete(paths.canonicalPath); // 规范清单整份缺失,不是「读不懂」
    const report = await collectSnapshotGarbage(store, stem, { now: LATER });
    expect(report.skipped).toBeNull();
    // 存活集仍来自指针 current/history(实现现有语义:规范清单只是额外引用来源)。
    const pointer = JSON.parse(store.files.get(`${paths.dir}/current.json`)!) as { current: string; history: string[] };
    expect(report.liveVersions).toEqual([...new Set([pointer.current, ...pointer.history.slice(-2)])].sort());
    // A 的丙卷不被任何人引用 ⇒ 仍是孤儿(不因缺规范清单而误保全,也不整本跳过)。
    expect(report.orphans).toContain(snaps(a)[2]);
  });

  it('目录里没有快照卷(旧单文件时代)⇒ 不读任何清单、不跳过、无孤儿', async () => {
    const store = new MemoryStore();
    store.files.set(`${paths.dir}/0badf00d.txt`, '旧整本快照');
    store.files.set(`${paths.dir}/0badf00d.json`, '{broken');
    const getBytes = vi.spyOn(store, 'getBytes');
    const report = await collectSnapshotGarbage(store, stem, exec);
    expect(report).toMatchObject({ skipped: null, volumeCount: 0, orphans: [] });
    expect(getBytes).not.toHaveBeenCalled();
  });
});

