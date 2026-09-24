// 大书分卷发布 + 按卷阅读(设计 v2 §五):清单数据形状与解析校验。
//
// 清单 index.json 回答「有哪些章、每章在哪个卷的哪个字节区间、分几段」;正文按需只取
// 该章所在的一个卷。整本正文永不下载、永不拼进内存。
//
// 本模块是纯函数层(不联网、不读盘、不碰 DB),解析失败一律返回 null,由调用方转 502 ——
// 「绝不猜」:清单任一校验项不成立都不能当成可读产物。

import { MAX_READER_BYTES } from './txt-chapters';
import { validateArtifactPath } from './artifact-locator';

/** 清单序列号。v1(服务端拼回整本)作废,只有 schema 2 可读。 */
export const VOLUME_MANIFEST_SCHEMA = 2;
export const VOLUME_MANIFEST_FORMAT = 'volumes';

/**
 * 清单(章节/卷索引)raw 拉取上限;20000 章 ≈ 1.7 MB,4 MiB 门内。
 * 读端(reader-server)与下载端(download file 路由)同值 —— 判据只此一处。
 */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface VolumeEntry {
  /** 规范区卷路径(books/<stem>/vol-001.txt)。跨版本共享固定名,读端只作快照缺失时的回退。 */
  path: string;
  /** 快照区卷路径(books/.snapshots/<stem>/v-<sha8>.txt)。内容寻址,读端优先取它。 */
  snapshot_path: string;
  /** 卷文本 git blob sha40(读端逐卷校验)。 */
  blob_sha: string;
  bytes: number;
  /** 全书逻辑偏移,首尾相接:first_byte[0] === 0,last_byte.at(-1) === bytes。 */
  first_byte: number;
  last_byte: number;
}

/** 章节索引项。s/e 用全书逻辑偏移(客户端零改动的前提);卷内偏移 = s - volumes[v].first_byte。 */
export interface VolumeChapterEntry {
  /** 章节序号(0 起,连续)。 */
  i: number;
  /** 标题。 */
  t: string;
  /** 卷号(volumes 下标)。 */
  v: number;
  /** 章起点(全书逻辑偏移)。 */
  s: number;
  /** 章终点(全书逻辑偏移,独占)。 */
  e: number;
  /** 段数(发布时 splitChapterParts 在全书缓冲上算出;读端重算交叉校验)。 */
  p: number;
}

export interface VolumeManifest {
  schema: number;
  format: string;
  /** 全书文本 git blob sha 前 8 位(内容决定,重试必命中同一路径)。 */
  version: string;
  /** 全书文本 git blob sha40(DB 的 blob_sha 同口径)。 */
  blob_sha: string;
  /** 全书逻辑字节数 = Σ各卷 bytes。 */
  bytes: number;
  chars: number;
  chapters: number;
  chapters_total: number;
  title: string;
  author: string;
  generated_at: string;
  task_id: number | string;
  volumes: VolumeEntry[];
  chapter_index: VolumeChapterEntry[];
}

/** 规范路径是清单而不是单文件产物:所有发布统一 `books/<stem>/index.json`。 */
export function isVolumeManifestPath(path: string): boolean {
  return /\/index\.json$/.test(path);
}

/**
 * 取卷字节的候选路径,按序尝试:前一个 404 才试下一个。读端(reader-server)与下载端
 * (download file 路由)共用此处,次序只在这里定。
 *
 * 先取快照卷 `snapshot_path`:发布阶段 1 写入,先于任何引用它的清单落地,且内容寻址、跨版本
 * 永不覆盖 ⇒ 字节恒与本清单声明的 blob_sha 一致。规范卷 `path`(vol-00N.txt)是跨版本共享的
 * 固定名,发布窗口内或规范阶段中途失败后会出现「清单代次 ≠ 卷代次」,只读它会恒 409(B2-01)。
 * 规范卷只作快照缺失时的回退;无论取自哪条路径,调用方都仍按 blob_sha 校验。
 *
 * 约束:今后若给快照区加 GC,必须保留当前及上一版清单引用的全部快照卷(读者可能仍持上一版
 * 清单读章);删掉被引用的快照会让读端退回规范卷,重新暴露跨版本 409。
 */
export function volumeReadPaths(entry: VolumeEntry): readonly [snapshot: string, canonical: string] {
  return [entry.snapshot_path, entry.path];
}

const HEX8 = /^[a-f0-9]{8}$/;
const HEX40 = /^[a-f0-9]{40}$/;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseVolume(value: unknown): VolumeEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== 'string' || typeof entry.snapshot_path !== 'string') return null;
  try {
    validateArtifactPath(entry.path);
    validateArtifactPath(entry.snapshot_path);
  } catch {
    return null;
  }
  if (typeof entry.blob_sha !== 'string' || !HEX40.test(entry.blob_sha)) return null;
  // 0 < bytes ≤ 单文件硬上限:防被篡改的清单让读端去拉一个超大「卷」。
  if (!isPositiveInteger(entry.bytes) || entry.bytes > MAX_READER_BYTES) return null;
  if (!isNonNegativeInteger(entry.first_byte) || !isNonNegativeInteger(entry.last_byte)) return null;
  if (entry.last_byte <= entry.first_byte) return null;
  return {
    path: entry.path,
    snapshot_path: entry.snapshot_path,
    blob_sha: entry.blob_sha,
    bytes: entry.bytes,
    first_byte: entry.first_byte,
    last_byte: entry.last_byte,
  };
}

function parseChapter(value: unknown): VolumeChapterEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (!isNonNegativeInteger(entry.i) || typeof entry.t !== 'string') return null;
  if (!isNonNegativeInteger(entry.v) || !isNonNegativeInteger(entry.s) || !isNonNegativeInteger(entry.e)) return null;
  if (!isPositiveInteger(entry.p)) return null;
  return { i: entry.i, t: entry.t, v: entry.v, s: entry.s, e: entry.e, p: entry.p };
}

/**
 * 解析并全量校验清单字节。任一校验项不成立返回 null(调用方 502),绝不猜:
 * schema/format;version 8hex、blob_sha 40hex;volumes ≥ 1 且逐卷 path/sha/bytes 合规;
 * 偏移首尾相接单调且 Σvolumes.bytes === bytes;chapter_index.length === chapters、
 * i 连续、v ∈ [0,volumes.length)、0 < s < e ≤ bytes、p ≥ 1,章起点落在其卷区间内。
 */
export function parseVolumeManifest(bytes: Uint8Array): VolumeManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== VOLUME_MANIFEST_SCHEMA || raw.format !== VOLUME_MANIFEST_FORMAT) return null;
  if (typeof raw.version !== 'string' || !HEX8.test(raw.version)) return null;
  if (typeof raw.blob_sha !== 'string' || !HEX40.test(raw.blob_sha)) return null;
  // version 必须是全书 blob_sha 的前 8 位(DB 的 version 与清单自述必须自洽)。
  if (raw.blob_sha.slice(0, 8) !== raw.version) return null;
  if (!isPositiveInteger(raw.bytes) || !isNonNegativeInteger(raw.chars)) return null;
  if (!isNonNegativeInteger(raw.chapters) || !isNonNegativeInteger(raw.chapters_total)) return null;
  if (typeof raw.title !== 'string' || typeof raw.author !== 'string') return null;
  if (typeof raw.generated_at !== 'string') return null;
  if (typeof raw.task_id !== 'number' && typeof raw.task_id !== 'string') return null;
  if (!Array.isArray(raw.volumes) || raw.volumes.length < 1) return null;
  if (!Array.isArray(raw.chapter_index)) return null;

  const volumes: VolumeEntry[] = [];
  for (const item of raw.volumes) {
    const entry = parseVolume(item);
    if (!entry) return null;
    volumes.push(entry);
  }
  // 偏移首尾相接且单调:卷拼接 === 原文逐字节的前提。
  if (volumes[0].first_byte !== 0) return null;
  let sum = 0;
  for (let index = 0; index < volumes.length; index++) {
    if (volumes[index].first_byte !== sum) return null;
    if (index > 0 && volumes[index].first_byte !== volumes[index - 1].last_byte) return null;
    if (volumes[index].last_byte - volumes[index].first_byte !== volumes[index].bytes) return null;
    sum += volumes[index].bytes;
  }
  if (volumes[volumes.length - 1].last_byte !== raw.bytes) return null;
  if (sum !== raw.bytes) return null;

  const chapterIndex: VolumeChapterEntry[] = [];
  for (const item of raw.chapter_index) {
    const entry = parseChapter(item);
    if (!entry) return null;
    if (entry.i !== chapterIndex.length) return null;
    if (entry.v >= volumes.length) return null;
    if (entry.s >= entry.e || entry.e > raw.bytes) return null;
    if (entry.s < volumes[entry.v].first_byte || entry.s >= volumes[entry.v].last_byte) return null;
    chapterIndex.push(entry);
  }
  if (chapterIndex.length !== raw.chapters) return null;

  return {
    schema: raw.schema,
    format: raw.format,
    version: raw.version,
    blob_sha: raw.blob_sha,
    bytes: raw.bytes,
    chars: raw.chars,
    chapters: raw.chapters,
    chapters_total: raw.chapters_total,
    title: raw.title,
    author: raw.author,
    generated_at: raw.generated_at,
    task_id: raw.task_id as number | string,
    volumes,
    chapter_index: chapterIndex,
  };
}

/**
 * 序列化清单:顶层 pretty(人类可读),但 `chapter_index` **每章一行紧凑 JSON**
 * (设计 v2 §五「序列化规定」)。若章节索引跟着顶层展开缩进,每章多约 120 B,
 * 20000 章会顶穿读端 4 MiB 的索引门。
 *
 * 顶层键序与解构无关(JSON.parse 不关心顺序),这里显式拼装以保证「每章一行」。
 */
export function stringifyVolumeManifest(manifest: VolumeManifest): string {
  const lines: string[] = ['{'];
  lines.push(`  "schema": ${JSON.stringify(manifest.schema)},`);
  lines.push(`  "format": ${JSON.stringify(manifest.format)},`);
  lines.push(`  "version": ${JSON.stringify(manifest.version)},`);
  lines.push(`  "blob_sha": ${JSON.stringify(manifest.blob_sha)},`);
  lines.push(`  "bytes": ${JSON.stringify(manifest.bytes)},`);
  lines.push(`  "chars": ${JSON.stringify(manifest.chars)},`);
  lines.push(`  "chapters": ${JSON.stringify(manifest.chapters)},`);
  lines.push(`  "chapters_total": ${JSON.stringify(manifest.chapters_total)},`);
  lines.push(`  "title": ${JSON.stringify(manifest.title)},`);
  lines.push(`  "author": ${JSON.stringify(manifest.author)},`);
  lines.push(`  "generated_at": ${JSON.stringify(manifest.generated_at)},`);
  lines.push(`  "task_id": ${JSON.stringify(manifest.task_id)},`);
  lines.push('  "volumes": ' + JSON.stringify(manifest.volumes, null, 2).split('\n').join('\n  ') + ',');
  lines.push('  "chapter_index": [');
  manifest.chapter_index.forEach((entry, index) => {
    const suffix = index === manifest.chapter_index.length - 1 ? '' : ',';
    lines.push(`    ${JSON.stringify({ i: entry.i, t: entry.t, v: entry.v, s: entry.s, e: entry.e, p: entry.p })}${suffix}`);
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}