// capacity968 固定单本清单候选解析边界草稿（**只写不跑**）。
//
// 诚实边界：本文件证明的是**纯函数声明级契约**——固定 tree 材料与 canonical 清单原始字节的对账：
// 显式 canonical 路径逐字匹配、原字节内部 Git hash 绑定、仅快照卷引用匹配、缺材料/形状/身份/
// 超界/hash/解析/卷缺失分级拒绝、四资格恒 false、未归类条目保留、输入/输出副本隔离。
// 合成合法清单用**既有 schema 与真实 Git 原始字节 hash**（stringifyVolumeManifest + gitBlobSha），
// 不虚构简化 schema。桩**不**读网络/盘/凭据。本文件为静态草稿，未在本次任务中执行（禁跑测试）。

import { describe, expect, it } from 'vitest';
import { gitBlobSha } from '../src/lib/artifact-bytes';
import { stringifyVolumeManifest, type VolumeManifest } from '../src/lib/volume-manifest';
import type { SnapshotEntry, TreeEntryKind, TreeTarget } from './reconcile-tree-snapshot';
import {
  parseFixedBookManifestCandidate,
  type BookManifestBinding,
  type TreeSnapshotMaterial,
} from './reconcile-book-manifest';

const SHA = (c: string) => c.repeat(40);

const target: TreeTarget = { repositoryId: 3, owner: 'acme', repo: 'books', branch: 'main' };
const COMMIT_SHA = SHA('c');
const TREE_SHA = SHA('d');
const CANONICAL_PATH = 'books/stem-abc/index.json';
const FULL_TEXT_BLOB_SHA = SHA('e');

interface VolSpec {
  canonical: string;
  snapshot: string;
  blobSha: string;
  bytes: number;
  first: number;
  last: number;
}

/** 用既有 schema 造合法清单原始字节，并回传其真实 Git blob SHA。 */
function buildManifest(over: {
  version?: string;
  blobSha?: string;
  bytes?: number;
  chapters?: number;
  volumes: VolSpec[];
}): { bytes: Uint8Array; text: string; version: string; blobSha: string } {
  const blobSha = over.blobSha ?? FULL_TEXT_BLOB_SHA;
  const version = over.version ?? blobSha.slice(0, 8);
  const bytes = over.bytes ?? over.volumes.reduce((sum, v) => sum + v.bytes, 0);
  const chapters = over.chapters ?? 1;
  const manifest: VolumeManifest = {
    schema: 2, format: 'volumes', version, blob_sha: blobSha, bytes,
    chars: 100, chapters, chapters_total: chapters,
    title: 'T', author: 'A', generated_at: '2026-01-01T00:00:00.000Z', task_id: 1,
    volumes: over.volumes.map((v) => ({
      path: v.canonical, snapshot_path: v.snapshot, blob_sha: v.blobSha,
      bytes: v.bytes, first_byte: v.first, last_byte: v.last,
    })),
    chapter_index: [{ i: 0, t: 'c0', v: 0, s: 0, e: bytes, p: 1 }],
  };
  const text = stringifyVolumeManifest(manifest);
  return { bytes: new Uint8Array(Buffer.from(text, 'utf8')), text, version, blobSha };
}

const blobEntry = (
  path: string, sha: string, mode = '100644', type = 'blob',
  kind: TreeEntryKind = 'regular-blob', size?: number,
): SnapshotEntry =>
  size === undefined ? { path, mode, type, kind, sha } : { path, mode, type, kind, sha, size };

function snapshotOf(entries: SnapshotEntry[]): TreeSnapshotMaterial {
  return { target, commitSha: COMMIT_SHA, treeSha: TREE_SHA, entries };
}

function bindingOf(over: Partial<BookManifestBinding> = {}): BookManifestBinding {
  return {
    target, commitSha: COMMIT_SHA, treeSha: TREE_SHA,
    canonicalPath: CANONICAL_PATH, manifestGitBlobSha: FULL_TEXT_BLOB_SHA,
    ...over,
  };
}

describe('parseFixedBookManifestCandidate (fixed single-book manifest candidate, static draft)', () => {
  it('1: normal multi-volume layout succeeds with four false flags; redundant items stay unclassified', () => {
    const built = buildManifest({
      volumes: [
        { canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-11111111.txt', blobSha: SHA('1'), bytes: 100, first: 0, last: 100 },
        { canonical: 'books/stem-abc/vol-002.txt', snapshot: 'books/.snapshots/stem-abc/v-22222222.txt', blobSha: SHA('2'), bytes: 50, first: 100, last: 150 },
      ],
    });
    const manifestSha = gitBlobSha(built.bytes);
    const entries: SnapshotEntry[] = [
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry('books/stem-abc/vol-001.txt', SHA('1')),
      blobEntry('books/stem-abc/vol-002.txt', SHA('2')),
      blobEntry('books/.snapshots/stem-abc/v-11111111.txt', SHA('1'), '100644', 'blob', 'regular-blob', 100),
      blobEntry('books/.snapshots/stem-abc/v-22222222.txt', SHA('2')),
      blobEntry(`books/.snapshots/stem-abc/${built.version}.json`, SHA('f')),
      blobEntry('books/.snapshots/stem-abc/current.json', SHA('0')),
    ];
    const res = parseFixedBookManifestCandidate({
      binding: bindingOf({ manifestGitBlobSha: manifestSha }),
      snapshot: snapshotOf(entries),
      manifestBytes: built.bytes,
    });
    expect(res).toMatchObject({
      status: 'fixed_book_manifest_candidate', scope: 'single_book',
      manifestVersion: built.version, manifestGitBlobSha: manifestSha,
      declaredFullTextBlobSha: FULL_TEXT_BLOB_SHA, declaredLogicalTxtBytes: 150,
      referenceMatch: 'fixed_tree_object_ids_only',
      volumeContentVerified: false, logicalInventoryVerified: false,
      activationEligible: false, repositoryInventoryComplete: false,
    });
    const out = res as { volumes: { snapshotPath: string }[]; observedUnclassifiedEntries: { path: string }[] };
    expect(out.volumes.map((v) => v.snapshotPath)).toEqual([
      'books/.snapshots/stem-abc/v-11111111.txt', 'books/.snapshots/stem-abc/v-22222222.txt',
    ]);
    // 无整本 SHA 对应的 TXT 仍成功；canonical 卷/版本清单/current 均保留为未归类。
    expect(out.observedUnclassifiedEntries.map((e) => e.path).sort()).toEqual([
      'books/.snapshots/stem-abc/current.json',
      `books/.snapshots/stem-abc/${built.version}.json`,
      'books/stem-abc/vol-001.txt', 'books/stem-abc/vol-002.txt',
    ]);
  });

  it('2: same bytes at two canonical paths keep per-request path binding; missing/other path or identity mismatch reject', () => {
    const built = buildManifest({ volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-33333333.txt', blobSha: SHA('3'), bytes: 80, first: 0, last: 80 }] });
    const manifestSha = gitBlobSha(built.bytes);
    const otherPath = 'books/stem-xyz/index.json';
    const entries: SnapshotEntry[] = [
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry(otherPath, manifestSha), // 同字节、不同路径
      blobEntry('books/.snapshots/stem-abc/v-33333333.txt', SHA('3')),
    ];
    const snap = snapshotOf(entries);
    // 分别请求：各自路径绑定保留。
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snap, manifestBytes: built.bytes }))
      .toMatchObject({ status: 'fixed_book_manifest_candidate', binding: { canonicalPath: CANONICAL_PATH } });
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ canonicalPath: otherPath, manifestGitBlobSha: manifestSha }), snapshot: snap, manifestBytes: built.bytes }))
      .toMatchObject({ status: 'fixed_book_manifest_candidate', binding: { canonicalPath: otherPath } });
    // 只给 SHA、请求路径缺失 → canonical_binding_conflict（不得用另一条路径补位）。
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ canonicalPath: 'books/stem-none/index.json', manifestGitBlobSha: manifestSha }), snapshot: snap, manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'canonical_binding_conflict' });
    // 身份不符（target/commit/tree 任一）→ canonical_binding_conflict。
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha, commitSha: SHA('9') }), snapshot: snap, manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'canonical_binding_conflict' });
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha, treeSha: SHA('9') }), snapshot: snap, manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'canonical_binding_conflict' });
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha, target: { ...target, branch: 'other' } }), snapshot: snap, manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'canonical_binding_conflict' });
  });

  it('3: hash mismatch / size limit / empty / illegal JSON are separated (never a silent success)', () => {
    const built = buildManifest({ volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-44444444.txt', blobSha: SHA('4'), bytes: 60, first: 0, last: 60 }] });
    const manifestSha = gitBlobSha(built.bytes);
    const entries: SnapshotEntry[] = [
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry('books/.snapshots/stem-abc/v-44444444.txt', SHA('4')),
    ];
    const snap = snapshotOf(entries);
    // 篡改字节（仍用旧期望 SHA）→ manifest_hash_mismatch。
    const tampered = new Uint8Array(built.bytes);
    tampered[tampered.length - 2] ^= 0x01;
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snap, manifestBytes: tampered }))
      .toEqual({ status: 'rejected', reason: 'manifest_hash_mismatch' });
    // 语义相同但空白不同（仍用旧期望 SHA）→ manifest_hash_mismatch。
    const spaced = new Uint8Array(Buffer.from(`${built.text}\n\n`, 'utf8'));
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snap, manifestBytes: spaced }))
      .toEqual({ status: 'rejected', reason: 'manifest_hash_mismatch' });
    // 超界（非空 >4 MiB，对象 ID 已匹配）→ manifest_size_limit。
    const huge = new Uint8Array(4 * 1024 * 1024 + 1);
    const hugeSha = gitBlobSha(huge);
    expect(parseFixedBookManifestCandidate({
      binding: bindingOf({ manifestGitBlobSha: hugeSha }),
      snapshot: snapshotOf([blobEntry(CANONICAL_PATH, hugeSha)]),
      manifestBytes: huge,
    })).toEqual({ status: 'rejected', reason: 'manifest_size_limit' });
    // 空材料 → no_authoritative_source（缺材料）。
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snap, manifestBytes: new Uint8Array(0) }))
      .toEqual({ status: 'rejected', reason: 'no_authoritative_source' });
    // 非法 JSON（SHA 已匹配，进到解析）→ manifest_unreadable。
    const bad = new Uint8Array(Buffer.from('not json', 'utf8'));
    const badSha = gitBlobSha(bad);
    expect(parseFixedBookManifestCandidate({
      binding: bindingOf({ manifestGitBlobSha: badSha }),
      snapshot: snapshotOf([blobEntry(CANONICAL_PATH, badSha)]),
      manifestBytes: bad,
    })).toEqual({ status: 'rejected', reason: 'manifest_unreadable' });
  });

  it('4: illegal schema or version≠full-sha prefix, with raw hash matched, → manifest_unreadable', () => {
    // schema 非法。
    const wrongSchemaText = stringifyVolumeManifest({
      schema: 2, format: 'volumes', version: FULL_TEXT_BLOB_SHA.slice(0, 8), blob_sha: FULL_TEXT_BLOB_SHA,
      bytes: 10, chars: 1, chapters: 1, chapters_total: 1, title: 'T', author: 'A',
      generated_at: '2026-01-01T00:00:00.000Z', task_id: 1,
      volumes: [{ path: 'books/stem-abc/vol-001.txt', snapshot_path: 'books/.snapshots/stem-abc/v-55555555.txt', blob_sha: SHA('5'), bytes: 10, first_byte: 0, last_byte: 10 }],
      chapter_index: [{ i: 0, t: 'c', v: 0, s: 0, e: 10, p: 1 }],
    }).replace('"schema": 2', '"schema": 1');
    const ws = new Uint8Array(Buffer.from(wrongSchemaText, 'utf8'));
    const wsSha = gitBlobSha(ws);
    expect(parseFixedBookManifestCandidate({
      binding: bindingOf({ manifestGitBlobSha: wsSha }),
      snapshot: snapshotOf([blobEntry(CANONICAL_PATH, wsSha)]),
      manifestBytes: ws,
    })).toEqual({ status: 'rejected', reason: 'manifest_unreadable' });

    // version 与全书 SHA 前缀不符。
    const bad = buildManifest({ version: '12345678', blobSha: FULL_TEXT_BLOB_SHA, volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-55555555.txt', blobSha: SHA('5'), bytes: 10, first: 0, last: 10 }] });
    const badSha = gitBlobSha(bad.bytes);
    expect(parseFixedBookManifestCandidate({
      binding: bindingOf({ manifestGitBlobSha: badSha }),
      snapshot: snapshotOf([blobEntry(CANONICAL_PATH, badSha)]),
      manifestBytes: bad.bytes,
    })).toEqual({ status: 'rejected', reason: 'manifest_unreadable' });
  });

  it('5: a snapshot volume missing / symlink / wrong SHA → volume_missing_in_tree; canonical volume alone never rescues', () => {
    const built = buildManifest({ volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-66666666.txt', blobSha: SHA('6'), bytes: 70, first: 0, last: 70 }] });
    const manifestSha = gitBlobSha(built.bytes);
    // canonical 卷为**不同代次**（SHA 0），与所需快照 SHA 6 不同，仅改 canonical 条目。
    const base: SnapshotEntry[] = [blobEntry(CANONICAL_PATH, manifestSha), blobEntry('books/stem-abc/vol-001.txt', SHA('0'))];
    const snap = (extra: SnapshotEntry[]) => snapshotOf([...base, ...extra]);
    // 快照卷缺失（仅 canonical 卷存在）。
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snap([]), manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'volume_missing_in_tree' });
    // 快照卷是符号链接。
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snap([blobEntry('books/.snapshots/stem-abc/v-66666666.txt', SHA('6'), '120000', 'blob', 'symlink')]), manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'volume_missing_in_tree' });
    // 快照卷 SHA 不符。
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snap([blobEntry('books/.snapshots/stem-abc/v-66666666.txt', SHA('7'))]), manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'volume_missing_in_tree' });
    // 快照匹配而 canonical 卷代次不同 → 候选仍成功，**不同 SHA** 的 canonical 条目未归类。
    const res = parseFixedBookManifestCandidate({
      binding: bindingOf({ manifestGitBlobSha: manifestSha }),
      snapshot: snap([blobEntry('books/.snapshots/stem-abc/v-66666666.txt', SHA('6'))]),
      manifestBytes: built.bytes,
    });
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate' });
    const unclassified = (res as { observedUnclassifiedEntries: { path: string; sha: string }[] }).observedUnclassifiedEntries;
    expect(unclassified).toContainEqual(expect.objectContaining({ path: 'books/stem-abc/vol-001.txt', sha: SHA('0') }));
    // manifest 与快照保持一致：声明的快照 SHA 仍为 6。
    expect((res as { volumes: { declaredBlobSha: string }[] }).volumes[0].declaredBlobSha).toBe(SHA('6'));
  });

  it('6: history/orphan/other-book/symlink/gitlink stay unclassified; a link used as required reference rejects', () => {
    const built = buildManifest({ volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-77777777.txt', blobSha: SHA('7'), bytes: 90, first: 0, last: 90 }] });
    const manifestSha = gitBlobSha(built.bytes);
    const entries: SnapshotEntry[] = [
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry('books/.snapshots/stem-abc/v-77777777.txt', SHA('7')),
      blobEntry('books/.snapshots/stem-abc/v-aaaaaaaa.txt', SHA('8')),            // 历史卷
      blobEntry('books/stem-abc/vol-001.txt', SHA('9')),                          // canonical 卷
      blobEntry('books/stem-other/index.json', SHA('a')),                         // 其它书
      blobEntry('books/stem-abc/link', SHA('7'), '120000', 'blob', 'symlink'),    // 链接
      blobEntry('books/stem-abc/sub', SHA('7'), '160000', 'commit', 'gitlink'),   // gitlink
    ];
    const res = parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snapshotOf(entries), manifestBytes: built.bytes });
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate', repositoryInventoryComplete: false });
    const paths = (res as { observedUnclassifiedEntries: { path: string }[] }).observedUnclassifiedEntries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining([
      'books/.snapshots/stem-abc/v-aaaaaaaa.txt', 'books/stem-abc/vol-001.txt',
      'books/stem-other/index.json', 'books/stem-abc/link', 'books/stem-abc/sub',
    ]));
    // 若所需快照引用本身是链接 → volume_missing_in_tree。
    const linkSnap = snapshotOf([blobEntry(CANONICAL_PATH, manifestSha), blobEntry('books/.snapshots/stem-abc/v-77777777.txt', SHA('7'), '120000', 'blob', 'symlink')]);
    expect(parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: linkSnap, manifestBytes: built.bytes }))
      .toEqual({ status: 'rejected', reason: 'volume_missing_in_tree' });
  });

  it('7: declared lengths/bytes consistent with matching object IDs and no volume bytes → only declarative success (no dedup by content SHA)', () => {
    // 两个逻辑卷内容 SHA 相同 → 同一快照路径；声明量不因 SHA 相同而 dedup。
    const built = buildManifest({
      volumes: [
        { canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-bbbbbbbb.txt', blobSha: SHA('b'), bytes: 40, first: 0, last: 40 },
        { canonical: 'books/stem-abc/vol-002.txt', snapshot: 'books/.snapshots/stem-abc/v-bbbbbbbb.txt', blobSha: SHA('b'), bytes: 40, first: 40, last: 80 },
      ],
    });
    const manifestSha = gitBlobSha(built.bytes);
    const entries: SnapshotEntry[] = [
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry('books/.snapshots/stem-abc/v-bbbbbbbb.txt', SHA('b')),
    ];
    const res = parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snapshotOf(entries), manifestBytes: built.bytes });
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate', declaredLogicalTxtBytes: 80 }); // 声明量 80，非 dedup 后的 40
    const out = res as { volumes: { declaredBlobSha: string }[]; volumeContentVerified: false; logicalInventoryVerified: false };
    expect(out.volumes).toHaveLength(2);
    expect(out.volumeContentVerified).toBe(false);
    expect(out.logicalInventoryVerified).toBe(false);
  });

  it('9: mode/type/kind contradictions reject invalid_tree; consistent unrelated links stay unclassified (F1)', () => {
    const built = buildManifest({ volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-dddddddd.txt', blobSha: SHA('d'), bytes: 20, first: 0, last: 20 }] });
    const manifestSha = gitBlobSha(built.bytes);
    const rejectInvalid = (entries: SnapshotEntry[]) =>
      parseFixedBookManifestCandidate({ binding: bindingOf({ manifestGitBlobSha: manifestSha }), snapshot: snapshotOf(entries), manifestBytes: built.bytes });
    // canonical 条目矛盾分类：120000+blob 应=symlink，却称 regular-blob。
    expect(rejectInvalid([
      blobEntry(CANONICAL_PATH, manifestSha, '120000', 'blob', 'regular-blob'),
      blobEntry('books/.snapshots/stem-abc/v-dddddddd.txt', SHA('d')),
    ])).toEqual({ status: 'rejected', reason: 'invalid_tree' });
    // 160000+commit 应=gitlink，却称 regular-blob。
    expect(rejectInvalid([
      blobEntry(CANONICAL_PATH, manifestSha, '160000', 'commit', 'regular-blob'),
      blobEntry('books/.snapshots/stem-abc/v-dddddddd.txt', SHA('d')),
    ])).toEqual({ status: 'rejected', reason: 'invalid_tree' });
    // 所需快照条目矛盾分类：120000+blob 却称 regular-blob。
    expect(rejectInvalid([
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry('books/.snapshots/stem-abc/v-dddddddd.txt', SHA('d'), '120000', 'blob', 'regular-blob'),
    ])).toEqual({ status: 'rejected', reason: 'invalid_tree' });
    // 未知 mode 组合 → invalid_tree。
    expect(rejectInvalid([
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry('books/.snapshots/stem-abc/v-dddddddd.txt', SHA('d')),
      blobEntry('books/stem-abc/weird', SHA('9'), '999999', 'blob', 'regular-blob'),
    ])).toEqual({ status: 'rejected', reason: 'invalid_tree' });
    // 一致的无关链接（120000+blob=symlink，未被引用）→ 成功且未归类。
    const res = rejectInvalid([
      blobEntry(CANONICAL_PATH, manifestSha),
      blobEntry('books/.snapshots/stem-abc/v-dddddddd.txt', SHA('d')),
      blobEntry('books/stem-abc/link', SHA('9'), '120000', 'blob', 'symlink'),
    ]);
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate' });
    expect((res as { observedUnclassifiedEntries: { path: string }[] }).observedUnclassifiedEntries.map((e) => e.path))
      .toContain('books/stem-abc/link');
  });

  it('10: a Buffer input is copied unconditionally, so later mutation cannot affect the returned result', () => {
    const built = buildManifest({ volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-eeeeeeee.txt', blobSha: SHA('e'), bytes: 25, first: 0, last: 25 }] });
    const manifestSha = gitBlobSha(built.bytes);
    const buf = Buffer.from(built.bytes); // 输入使用 Buffer（slice 会共享底层，new Uint8Array 才复制）
    const res = parseFixedBookManifestCandidate({
      binding: bindingOf({ manifestGitBlobSha: manifestSha }),
      snapshot: snapshotOf([blobEntry(CANONICAL_PATH, manifestSha), blobEntry('books/.snapshots/stem-abc/v-eeeeeeee.txt', SHA('e'))]),
      manifestBytes: buf,
    });
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate' });
    buf.fill(0); // 事后清空输入 Buffer，不得影响已返回结果
    expect((res as { manifestVersion: string }).manifestVersion).toBe(FULL_TEXT_BLOB_SHA.slice(0, 8));
  });

  it('8: input/output primitive copies are isolated from later caller mutation', () => {
    const built = buildManifest({ volumes: [{ canonical: 'books/stem-abc/vol-001.txt', snapshot: 'books/.snapshots/stem-abc/v-cccccccc.txt', blobSha: SHA('c'), bytes: 30, first: 0, last: 30 }] });
    const manifestSha = gitBlobSha(built.bytes);
    const mutableTarget = { ...target };
    const mutableEntry = blobEntry('books/.snapshots/stem-abc/v-cccccccc.txt', SHA('c'));
    const binding = bindingOf({ manifestGitBlobSha: manifestSha, target: mutableTarget });
    const snapshot = snapshotOf([blobEntry(CANONICAL_PATH, manifestSha), mutableEntry]);
    const res = parseFixedBookManifestCandidate({ binding, snapshot, manifestBytes: built.bytes });
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate' });
    // 事后改动输入原对象，不得污染输出。
    mutableTarget.branch = 'hacked';
    mutableEntry.sha = SHA('9');
    expect((res as { binding: { target: TreeTarget } }).binding.target.branch).toBe('main');
    expect((res as { volumes: { snapshot: { sha: string } }[] }).volumes[0].snapshot.sha).toBe(SHA('c'));
    expect((res as { binding: { target: TreeTarget } }).binding.target).not.toBe(mutableTarget);
  });
});
