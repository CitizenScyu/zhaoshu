// volume-manifest 校验单测(设计 v2 §五)。构造-变异:每个校验项一条反例,必须返回 null。
import { describe, expect, it } from 'vitest';
import {
  VOLUME_MANIFEST_FORMAT,
  VOLUME_MANIFEST_SCHEMA,
  isVolumeManifestPath,
  parseVolumeManifest,
  stringifyVolumeManifest,
} from './volume-manifest';
import type { VolumeManifest } from './volume-manifest';
import { MAX_READER_BYTES } from './txt-chapters';

const HEX40 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/** 合法基线:2 卷、2 章、偏移首尾相接,blob_sha 前 8 位 === version。 */
function baseManifest(): VolumeManifest {
  return {
    schema: VOLUME_MANIFEST_SCHEMA,
    format: VOLUME_MANIFEST_FORMAT,
    version: HEX40.slice(0, 8),
    blob_sha: HEX40,
    bytes: 3000,
    chars: 1000,
    chapters: 2,
    chapters_total: 2,
    title: '测试书',
    author: '作者',
    generated_at: '2026-09-21T00:00:00.000Z',
    task_id: 71,
    volumes: [
      {
        path: 'books/stem/vol-001.txt',
        snapshot_path: 'books/.snapshots/stem/v-a1b2c3d4.txt',
        blob_sha: 'b'.repeat(40),
        bytes: 2000,
        first_byte: 0,
        last_byte: 2000,
      },
      {
        path: 'books/stem/vol-002.txt',
        snapshot_path: 'books/.snapshots/stem/v-a1b2c3d4.txt',
        blob_sha: 'c'.repeat(40),
        bytes: 1000,
        first_byte: 2000,
        last_byte: 3000,
      },
    ],
    chapter_index: [
      { i: 0, t: '第一章', v: 0, s: 0, e: 1500, p: 1 },
      { i: 1, t: '第二章', v: 1, s: 2000, e: 2500, p: 2 },
    ],
  };
}

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

/** 序列化后走真实解析路径,变异经 mutate 作用于 JSON 对象。 */
function parseMutated(mutate: (raw: Record<string, unknown>) => void): VolumeManifest | null {
  const raw = JSON.parse(JSON.stringify(baseManifest())) as Record<string, unknown>;
  mutate(raw);
  return parseVolumeManifest(encode(raw));
}

describe('isVolumeManifestPath', () => {
  it('只认 index.json 结尾', () => {
    expect(isVolumeManifestPath('books/stem/index.json')).toBe(true);
    expect(isVolumeManifestPath('books/stem/vol-001.txt')).toBe(false);
    expect(isVolumeManifestPath('index.json.bak')).toBe(false);
  });
});

describe('parseVolumeManifest 正例', () => {
  it('解析合法清单为强类型', () => {
    const manifest = parseVolumeManifest(encode(baseManifest()));
    expect(manifest).not.toBeNull();
    expect(manifest!.volumes).toHaveLength(2);
    expect(manifest!.chapter_index).toHaveLength(2);
    expect(manifest!.version).toBe(HEX40.slice(0, 8));
  });

  it('stringify 往返后仍能解析(每章一行紧凑)', () => {
    const text = stringifyVolumeManifest(baseManifest());
    expect(text).toContain('"chapter_index": [');
    // 每章一行:chapter_index 数组内不含多于 2 个换行的连续紧凑结构。
    expect(text.split('\n').filter(line => line.includes('"i":')).length).toBe(2);
    const parsed = parseVolumeManifest(encode(text));
    expect(parsed).not.toBeNull();
    expect(parsed!.chapter_index[1].p).toBe(2);
  });
});

describe('parseVolumeManifest 反例(一律 null)', () => {
  it('非法 JSON', () => {
    expect(parseVolumeManifest(encode('{not json'))).toBeNull();
  });

  it('schema 不符', () => {
    expect(parseMutated(raw => { raw.schema = 1; })).toBeNull();
  });

  it('format 不符', () => {
    expect(parseMutated(raw => { raw.format = 'single'; })).toBeNull();
  });

  it('version 非 8hex', () => {
    expect(parseMutated(raw => { raw.version = 'A1B2C3D4'; })).toBeNull();
  });

  it('blob_sha 非 40hex', () => {
    expect(parseMutated(raw => { raw.blob_sha = 'abc'; })).toBeNull();
  });

  it('version 与 blob_sha 前 8 位不自洽', () => {
    expect(parseMutated(raw => { raw.version = 'ffffffff'; })).toBeNull();
  });

  it('volumes 为空', () => {
    expect(parseMutated(raw => { raw.volumes = []; })).toBeNull();
  });

  it('卷 path 越界(..)', () => {
    expect(parseMutated(raw => { (raw.volumes as any)[0].path = 'books/../etc/passwd'; })).toBeNull();
  });

  it('卷 bytes 为 0', () => {
    expect(parseMutated(raw => { (raw.volumes as any)[0].bytes = 0; })).toBeNull();
  });

  it('卷 bytes 超 MAX_READER_BYTES', () => {
    expect(parseMutated(raw => { (raw.volumes as any)[0].bytes = MAX_READER_BYTES + 1; })).toBeNull();
  });

  it('首卷 first_byte !== 0', () => {
    expect(parseMutated(raw => { (raw.volumes as any)[0].first_byte = 5; })).toBeNull();
  });

  it('卷偏移不首尾相接(断缝)', () => {
    expect(parseMutated(raw => { (raw.volumes as any)[1].first_byte = 2001; })).toBeNull();
  });

  it('Σvolumes.bytes !== bytes', () => {
    expect(parseMutated(raw => { raw.bytes = 9999; })).toBeNull();
  });

  it('末卷 last_byte !== bytes', () => {
    expect(parseMutated(raw => { (raw.volumes as any)[1].last_byte = 2999; })).toBeNull();
  });

  it('chapter_index.length !== chapters', () => {
    expect(parseMutated(raw => { raw.chapters = 3; })).toBeNull();
  });

  it('i 不连续', () => {
    expect(parseMutated(raw => { (raw.chapter_index as any)[1].i = 5; })).toBeNull();
  });

  it('v 越界', () => {
    expect(parseMutated(raw => { (raw.chapter_index as any)[0].v = 2; })).toBeNull();
  });

  it('s >= e', () => {
    expect(parseMutated(raw => { (raw.chapter_index as any)[0].e = 0; })).toBeNull();
  });

  it('e > bytes', () => {
    expect(parseMutated(raw => { (raw.chapter_index as any)[1].e = 3001; })).toBeNull();
  });

  it('p < 1', () => {
    expect(parseMutated(raw => { (raw.chapter_index as any)[0].p = 0; })).toBeNull();
  });

  it('章起点不落在其卷区间(错标卷号)', () => {
    // 章 0 实际在卷 0(s=0),谎报 v=1。
    expect(parseMutated(raw => { (raw.chapter_index as any)[0].v = 1; })).toBeNull();
  });
});
