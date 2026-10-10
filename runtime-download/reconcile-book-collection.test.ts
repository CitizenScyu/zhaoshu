// capacity974 固定材料单本采集组合边界测试草稿（只写不跑）。
// 编排真实 captureTreeSnapshot / createGitHubManifestBlobReader / parseFixedBookManifestCandidate；
// 合成 GitTreePort 与 B 的已类型化 request/json。端口包装器记录方法进入次数（非 HTTP 次数）。
// 桩不读网络/盘/凭据。本文件为静态草稿，未执行。

import { describe, expect, it } from 'vitest';
import { gitBlobSha } from '../src/lib/artifact-bytes';
import { stringifyVolumeManifest, type VolumeManifest } from '../src/lib/volume-manifest';
import type { GitTreePort, TreeListing, RawTreeEntry, TreeTarget } from './reconcile-tree-snapshot';
import type { GitHubJsonRequest, GitHubJsonResponse } from './reconcile-tree-github';
import { createGitHubManifestBlobReader, type GitHubManifestBlobReader } from './reconcile-manifest-blob-github';
import { collectFixedBookManifestCandidate } from './reconcile-book-collection';

const SHA = (c: string) => c.repeat(40);

const target: TreeTarget = { repositoryId: 3, owner: 'acme', repo: 'books', branch: 'main' };
const COMMIT_SHA = SHA('c');
const TREE_SHA = SHA('d');
const CANONICAL_PATH = 'books/stem-abc/index.json';

// 两卷各 40 字节的合成内容；卷/全书 SHA 由内容算出（非 40hex 占位）。
const volumeBytes = (seed: number): Uint8Array => {
  const out = new Uint8Array(40);
  for (let i = 0; i < out.length; i++) out[i] = (seed + i) & 0xff;
  return out;
};
const VOL1_BYTES = volumeBytes(0x41);
const VOL2_BYTES = volumeBytes(0x81);
const VOL1_SHA = gitBlobSha(VOL1_BYTES);
const VOL2_SHA = gitBlobSha(VOL2_BYTES);
const FULL_TEXT_BYTES = new Uint8Array(80);
FULL_TEXT_BYTES.set(VOL1_BYTES, 0);
FULL_TEXT_BYTES.set(VOL2_BYTES, 40);
const FULL_TEXT_BLOB_SHA = gitBlobSha(FULL_TEXT_BYTES);

/** 合成两卷合法清单：各 40 字节、全书 80；章 0/1 分别覆盖 [0,40)/[40,80)。 */
function buildTwoVolumeManifest(): { bytes: Uint8Array; text: string; version: string } {
  const version = FULL_TEXT_BLOB_SHA.slice(0, 8);
  const manifest: VolumeManifest = {
    schema: 2, format: 'volumes', version, blob_sha: FULL_TEXT_BLOB_SHA,
    bytes: 80, chars: 100, chapters: 2, chapters_total: 2, title: 'T', author: 'A',
    generated_at: '2026-01-01T00:00:00.000Z', task_id: 1,
    volumes: [
      { path: 'books/stem-abc/vol-001.txt', snapshot_path: 'books/.snapshots/stem-abc/v-11111111.txt', blob_sha: VOL1_SHA, bytes: 40, first_byte: 0, last_byte: 40 },
      { path: 'books/stem-abc/vol-002.txt', snapshot_path: 'books/.snapshots/stem-abc/v-22222222.txt', blob_sha: VOL2_SHA, bytes: 40, first_byte: 40, last_byte: 80 },
    ],
    chapter_index: [
      { i: 0, t: 'c0', v: 0, s: 0, e: 40, p: 1 },
      { i: 1, t: 'c1', v: 1, s: 40, e: 80, p: 1 },
    ],
  };
  const text = stringifyVolumeManifest(manifest);
  return { bytes: new Uint8Array(Buffer.from(text, 'utf8')), text, version };
}

/** 合成原始树条目（未分类；S 会分类）。 */
const rawEntry = (path: string, sha: string, mode = '100644', type = 'blob'): RawTreeEntry =>
  ({ path, mode, type, sha });

/** 从原始条目列表造真实 GitTreePort 桩；getCommit/getTree 各回固定材料（不读网络）。 */
function treePortOf(
  entries: RawTreeEntry[],
  over: { commitSha?: string; treeSha?: string; listingSha?: string; truncated?: boolean } = {},
): GitTreePort {
  const commitSha = over.commitSha ?? COMMIT_SHA;
  const treeSha = over.treeSha ?? TREE_SHA;
  return {
    getCommit: async () => ({ commitSha, treeSha }),
    getTree: async () => ({
      sha: over.listingSha ?? treeSha,
      truncated: (over.truncated ?? false) as boolean,
      tree: entries,
    } as TreeListing),
  };
}

/** 计数包装：记录方法进入次数。 */
function countTree(base: GitTreePort) {
  const counts = { getCommit: 0, getTree: 0 };
  const port: GitTreePort = {
    getCommit: (t) => { counts.getCommit++; return base.getCommit(t); },
    getTree: (t, sha, o) => { counts.getTree++; return base.getTree(t, sha, o); },
  };
  return { counts, port };
}
function countBlob(base: GitHubManifestBlobReader) {
  const counts = { read: 0 };
  const port: GitHubManifestBlobReader = {
    readManifestBlob: (t, sha) => { counts.read++; return base.readManifestBlob(t, sha); },
  };
  return { counts, port };
}

/** 合成 B 的 request：按官方 git blobs 端点形状返回 base64 信封（不读网络）。 */
function manifestRequest(
  bytes: Uint8Array,
  sha: string,
  over: { status?: number; shaOverride?: string; contentOverride?: string; sizeOverride?: number } = {},
): GitHubJsonRequest {
  return async (_route: string): Promise<GitHubJsonResponse> => ({
    status: over.status ?? 200,
    json: async () => ({
      sha: over.shaOverride ?? sha,
      encoding: 'base64',
      content: over.contentOverride ?? Buffer.from(bytes).toString('base64'),
      size: over.sizeOverride ?? bytes.byteLength,
    }),
  });
}

function realBlob(bytes: Uint8Array, sha: string): GitHubManifestBlobReader {
  return createGitHubManifestBlobReader({ request: manifestRequest(bytes, sha), target });
}

describe('collectFixedBookManifestCandidate (fixed single-book collection composition, static draft)', () => {
  it('1: real S/B/P success chain — two volumes, complete binding, four false, 3 port entries', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries: RawTreeEntry[] = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
      rawEntry('books/stem-abc/vol-001.txt', SHA('9')),   // canonical 卷代次不同 → 未归类
      rawEntry('books/stem-abc/vol-002.txt', SHA('9')),
      rawEntry(`books/.snapshots/stem-abc/${built.version}.json`, SHA('f')),
      rawEntry('books/.snapshots/stem-abc/current.json', SHA('0')),
    ];
    const { counts: tc, port: tree } = countTree(treePortOf(entries));
    const { counts: bc, port: blob } = countBlob(realBlob(built.bytes, manifestSha));

    const res = await collectFixedBookManifestCandidate(
      { target: { ...target }, canonicalPath: CANONICAL_PATH },
      { tree, blob },
    );

    expect(res).toMatchObject({
      status: 'fixed_book_manifest_candidate', scope: 'single_book',
      manifestGitBlobSha: manifestSha, declaredFullTextBlobSha: FULL_TEXT_BLOB_SHA,
      declaredLogicalTxtBytes: 80, referenceMatch: 'fixed_tree_object_ids_only',
      volumeContentVerified: false, logicalInventoryVerified: false,
      activationEligible: false, repositoryInventoryComplete: false,
    });
    const out = res as unknown as { binding: { target: TreeTarget; commitSha: string; treeSha: string; canonicalPath: string }; volumes: { snapshotPath: string }[]; observedUnclassifiedEntries: { path: string }[] };
    expect(out.binding.target).toEqual(target);
    expect(out.binding.commitSha).toBe(COMMIT_SHA);
    expect(out.binding.treeSha).toBe(TREE_SHA);
    expect(out.binding.canonicalPath).toBe(CANONICAL_PATH);
    expect(out.volumes.map((v) => v.snapshotPath)).toEqual([
      'books/.snapshots/stem-abc/v-11111111.txt', 'books/.snapshots/stem-abc/v-22222222.txt',
    ]);
    expect(out.observedUnclassifiedEntries.map((e) => e.path).sort()).toEqual([
      `books/.snapshots/stem-abc/${built.version}.json`,
      'books/.snapshots/stem-abc/current.json',
      'books/stem-abc/vol-001.txt', 'books/stem-abc/vol-002.txt',
    ]);
    // 端口方法进入次数：S 内 getCommit/getTree 各 1，blob.read 1（合计 3）。
    expect(tc).toEqual({ getCommit: 1, getTree: 1 });
    expect(bc).toEqual({ read: 1 });
  });

  it('2: input shape gate — bad target or non-canonical path is invalid_input with zero port calls', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const { counts: tc, port: tree } = countTree(treePortOf([rawEntry(CANONICAL_PATH, manifestSha)]));
    const { counts: bc, port: blob } = countBlob(realBlob(built.bytes, manifestSha));
    const ports = { tree, blob };

    // canonicalPath 非 books/<单段>/index.json。
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: 'books/stem-abc/other.json' }, ports))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'invalid_input' });
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: 'books/a/b/index.json' }, ports))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'invalid_input' });
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: '/books/stem-abc/index.json' }, ports))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'invalid_input' });
    // 目标非法（repositoryId 非正）。
    expect(await collectFixedBookManifestCandidate({ target: { ...target, repositoryId: 0 }, canonicalPath: CANONICAL_PATH }, ports))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'invalid_input' });
    // 零端口调用。
    expect(tc).toEqual({ getCommit: 0, getTree: 0 });
    expect(bc).toEqual({ read: 0 });
  });

  it('3: missing port (tree/blob/方法缺失) is missing_port with zero port calls', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const { counts: tc, port: tree } = countTree(treePortOf([rawEntry(CANONICAL_PATH, manifestSha)]));
    const { counts: bc, port: blob } = countBlob(realBlob(built.bytes, manifestSha));

    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: null as unknown as GitTreePort, blob }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'missing_port' });
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree, blob: null as unknown as GitHubManifestBlobReader }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'missing_port' });
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: { getCommit: tree.getCommit } as unknown as GitTreePort, blob }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'missing_port' });
    expect(tc).toEqual({ getCommit: 0, getTree: 0 });
    expect(bc).toEqual({ read: 0 });
  });

  it('4: tree domain preserved — truncated=true → tree/incomplete_tree; listing sha mismatch → tree/binding_conflict; blob/P=0', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [rawEntry(CANONICAL_PATH, manifestSha), rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA)];

    const trunc = countTree(treePortOf(entries, { truncated: true }));
    const { counts: bc1, port: blob1 } = countBlob(realBlob(built.bytes, manifestSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: trunc.port, blob: blob1 }))
      .toEqual({ status: 'rejected', domain: 'tree', reason: 'incomplete_tree' });
    expect(trunc.counts).toEqual({ getCommit: 1, getTree: 1 });
    expect(bc1).toEqual({ read: 0 });

    const wrongTree = countTree(treePortOf(entries, { listingSha: SHA('9') }));
    const { counts: bc2, port: blob2 } = countBlob(realBlob(built.bytes, manifestSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: wrongTree.port, blob: blob2 }))
      .toEqual({ status: 'rejected', domain: 'tree', reason: 'binding_conflict' });
    expect(bc2).toEqual({ read: 0 });
  });

  it('5: getCommit non-40hex material is rejected by S; getTree/blob never called', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const base = treePortOf([rawEntry(CANONICAL_PATH, manifestSha)]);
    // 直接计数真正被调用的 badCommit 两个方法（不绕过计数包装）。
    const counts = { getCommit: 0, getTree: 0 };
    const badCommit: GitTreePort = {
      getCommit: (t) => { counts.getCommit++; return Promise.resolve({ commitSha: 'not-hex', treeSha: TREE_SHA }); },
      getTree: (t, sha, o) => { counts.getTree++; return base.getTree(t, sha, o); },
    };
    const { counts: bc, port: blob } = countBlob(realBlob(built.bytes, manifestSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: badCommit, blob }))
      .toEqual({ status: 'rejected', domain: 'tree', reason: 'invalid_tree' });
    // 非法 commit 材料在 S 内即返回，getTree 未进入；blob 零调用。
    expect(counts).toEqual({ getCommit: 1, getTree: 0 });
    expect(bc).toEqual({ read: 0 });
  });

  it('6: canonical gate after real tree — missing path / other same-SHA path / symlink → composition/canonical_binding_conflict, blob=0', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const snap = [rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA)];

    // 精确路径缺失。
    const c1 = countTree(treePortOf(snap));
    const { port: b1 } = countBlob(realBlob(built.bytes, manifestSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c1.port, blob: b1 }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'canonical_binding_conflict' });

    // 另一条同 SHA 路径存在，但请求路径缺失（不得补位）。
    const c2 = countTree(treePortOf([...snap, rawEntry('books/stem-xyz/index.json', manifestSha)]));
    const { counts: bc2, port: b2 } = countBlob(realBlob(built.bytes, manifestSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c2.port, blob: b2 }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'canonical_binding_conflict' });
    expect(bc2).toEqual({ read: 0 });

    // 目标条目为一致链接（120000/blob=symlink）。
    const c3 = countTree(treePortOf([rawEntry(CANONICAL_PATH, manifestSha, '120000', 'blob'), ...snap]));
    const { counts: bc3, port: b3 } = countBlob(realBlob(built.bytes, manifestSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c3.port, blob: b3 }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'canonical_binding_conflict' });
    expect(bc3).toEqual({ read: 0 });
  });

  it('7: blob return binding — tampered target or returned SHA → composition/blob_binding_conflict, P not run', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
    ];
    const real = realBlob(built.bytes, manifestSha);

    // 篡改返回 target 一个原语。
    const tamperTarget: GitHubManifestBlobReader = {
      readManifestBlob: async (t, sha) => {
        const r = await real.readManifestBlob(t, sha);
        return { ...r, target: { ...r.target, branch: 'hacked' } };
      },
    };
    const c1 = countTree(treePortOf(entries));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c1.port, blob: tamperTarget }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'blob_binding_conflict' });

    // 篡改返回 manifestGitBlobSha（仍合法 40hex，但 ≠ 期望）。
    const tamperSha: GitHubManifestBlobReader = {
      readManifestBlob: async (t, sha) => {
        const r = await real.readManifestBlob(t, sha);
        return { ...r, manifestGitBlobSha: SHA('9') };
      },
    };
    const c2 = countTree(treePortOf(entries));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c2.port, blob: tamperSha }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'blob_binding_conflict' });
  });

  it('8: double hash boundary — real B throws on content/hash mismatch; tampered returned bytes → manifest/manifest_hash_mismatch', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
    ];

    // JSON 声称正确 sha 且 size 自洽，但内容字节不同 → 真实 B 抛 GITHUB_BLOB_HASH_MISMATCH（按 name/code 形状断言；该分支未进入 P）。
    const lyingBytes = new Uint8Array(built.bytes);
    lyingBytes[0] ^= 0x01; // 同长度、异字节：越过 size 门、命中 hash 门
    const lyingBlob = createGitHubManifestBlobReader({
      request: manifestRequest(built.bytes, manifestSha, {
        contentOverride: Buffer.from(lyingBytes).toString('base64'),
        sizeOverride: lyingBytes.byteLength,
      }),
      target,
    });
    const c1 = countTree(treePortOf(entries));
    await expect(collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c1.port, blob: lyingBlob }))
      .rejects.toMatchObject({ name: 'GitHubManifestBlobError', code: 'GITHUB_BLOB_HASH_MISMATCH' });

    // 装饰器先让真实 B 成功，再仅改返回 bytes 一个字节 → 真实 P 给 manifest/manifest_hash_mismatch。
    const real = realBlob(built.bytes, manifestSha);
    const tamperBytes: GitHubManifestBlobReader = {
      readManifestBlob: async (t, sha) => {
        const r = await real.readManifestBlob(t, sha);
        const copy = new Uint8Array(r.bytes);
        copy[copy.length - 2] ^= 0x01;
        return { ...r, bytes: copy };
      },
    };
    const c2 = countTree(treePortOf(entries));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c2.port, blob: tamperBytes }))
      .toEqual({ status: 'rejected', domain: 'manifest', reason: 'manifest_hash_mismatch' });
  });

  it('9: blob shape gates — wrong status / non-Uint8Array / oversize → blob_result_invalid; empty bytes reach P', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
    ];
    const make = (bytes: unknown, sha = manifestSha): GitHubManifestBlobReader =>
      ({ readManifestBlob: async () => ({ status: 'fixed_manifest_blob_bytes', target: { ...target }, manifestGitBlobSha: sha, bytes }) as never });

    // 仅 status 错误：目标/SHA/字节均正确 → 组合形状门先于绑定门 → composition/blob_result_invalid。
    const wrongStatus: GitHubManifestBlobReader =
      ({ readManifestBlob: async () => ({ status: 'other_bytes', target: { ...target }, manifestGitBlobSha: manifestSha, bytes: built.bytes }) as never });
    const c0 = countTree(treePortOf(entries));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c0.port, blob: wrongStatus }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'blob_result_invalid' });

    const c1 = countTree(treePortOf(entries));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c1.port, blob: make([1, 2, 3]) }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'blob_result_invalid' });

    const c2 = countTree(treePortOf(entries));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c2.port, blob: make(new Uint8Array(4 * 1024 * 1024 + 1), manifestSha) }))
      .toEqual({ status: 'rejected', domain: 'composition', reason: 'blob_result_invalid' });

    // 空字节 → 进入真实 P → manifest/no_authoritative_source（缺材料）。
    const empty = make(new Uint8Array(0));
    const c3 = countTree(treePortOf(entries));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c3.port, blob: empty }))
      .toEqual({ status: 'rejected', domain: 'manifest', reason: 'no_authoritative_source' });
  });

  it('10: real B non-2xx (404) propagates as GitHubManifestBlobError (not a composition result)', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
    ];
    const notFound = createGitHubManifestBlobReader({ request: manifestRequest(built.bytes, manifestSha, { status: 404 }), target });
    const c = countTree(treePortOf(entries));
    await expect(collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c.port, blob: notFound }))
      .rejects.toMatchObject({ name: 'GitHubManifestBlobError', code: 'GITHUB_BLOB_HTTP', status: 404 });
  });

  it('11: port exceptions propagate by reference; no catch/retry', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const boom = new Error('boom');
    const entries = [rawEntry(CANONICAL_PATH, manifestSha), rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA), rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA)];

    const commitThrows: GitTreePort = { getCommit: async () => { throw boom; }, getTree: treePortOf(entries).getTree };
    const { port: blobA } = countBlob(realBlob(built.bytes, manifestSha));
    await expect(collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: commitThrows, blob: blobA })).rejects.toBe(boom);

    const treeThrows: GitTreePort = { getCommit: async () => ({ commitSha: COMMIT_SHA, treeSha: TREE_SHA }), getTree: async () => { throw boom; } };
    const { port: blobB } = countBlob(realBlob(built.bytes, manifestSha));
    await expect(collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: treeThrows, blob: blobB })).rejects.toBe(boom);

    const blobThrows: GitHubManifestBlobReader = { readManifestBlob: async () => { throw boom; } };
    const c = countTree(treePortOf(entries));
    await expect(collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c.port, blob: blobThrows })).rejects.toBe(boom);
  });

  it('12: real B json() rejection propagates the held object by reference; single call, no retry', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
    ];
    // 真实 B 合成 request：json() 抛出已持有对象（非 Error），须原引用透传。
    const held = { marker: 'held-json-error' };
    const throwingRequest: GitHubJsonRequest = async () => ({ status: 200, json: async () => { throw held; } });
    const blob = createGitHubManifestBlobReader({ request: throwingRequest, target });
    const { counts: bc, port: countedBlob } = countBlob(blob);
    const c = countTree(treePortOf(entries));
    await expect(collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c.port, blob: countedBlob }))
      .rejects.toBe(held);
    // 异常后无后续调用（无重试）：blob 只进入一次、树各一次。
    expect(bc).toEqual({ read: 1 });
    expect(c.counts).toEqual({ getCommit: 1, getTree: 1 });
  });

  it('13: await-time input mutation cannot change fixed identity/path (getCommit pending)', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
    ];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated: GitTreePort = {
      getCommit: async (t) => { await gate; return { commitSha: COMMIT_SHA, treeSha: TREE_SHA }; },
      getTree: treePortOf(entries).getTree,
    };
    const { port: blob } = countBlob(realBlob(built.bytes, manifestSha));
    const mutableInput: { target: TreeTarget; canonicalPath: string } = { target: { ...target }, canonicalPath: CANONICAL_PATH };
    const p = collectFixedBookManifestCandidate(mutableInput, { tree: gated, blob });
    // await 期间改原 input 的身份/路径。
    mutableInput.target.branch = 'hacked';
    mutableInput.canonicalPath = 'books/other/index.json';
    release();
    const res = await p;
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate' });
    const out = res as { binding: { target: TreeTarget; canonicalPath: string } };
    expect(out.binding.target.branch).toBe('main');
    expect(out.binding.canonicalPath).toBe(CANONICAL_PATH);
  });

  it('14: internal expectation is isolated from the target object handed to the blob port (mutate while real B pending)', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
    ];
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gatedRequest: GitHubJsonRequest = async () => {
      entered();
      await gate;
      return { status: 200, json: async () => ({ sha: manifestSha, encoding: 'base64', content: Buffer.from(built.bytes).toString('base64'), size: built.bytes.byteLength }) };
    };
    const gatedReal = createGitHubManifestBlobReader({ request: gatedRequest, target });
    // 端口持有组合传入的 target 副本；真实 B 进入 request（挂起）后再篡改该副本。
    let heldTarget: TreeTarget | undefined;
    const mutatingBlob: GitHubManifestBlobReader = {
      readManifestBlob: (t, sha) => { heldTarget = t; return gatedReal.readManifestBlob(t, sha); },
    };
    const c = countTree(treePortOf(entries));
    const p = collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c.port, blob: mutatingBlob });
    await enteredP;
    (heldTarget as TreeTarget).branch = 'hacked';
    release();
    const res = await p;
    expect(res).toMatchObject({ status: 'fixed_book_manifest_candidate' });
    expect((res as { binding: { target: TreeTarget } }).binding.target.branch).toBe('main');
  });

  it('15: mutating the old getTree response during blob await cannot drift binding/volumes/unclassified', async () => {
    const built = buildTwoVolumeManifest();
    const manifestSha = gitBlobSha(built.bytes);
    const entries: RawTreeEntry[] = [
      rawEntry(CANONICAL_PATH, manifestSha),
      rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA),
      rawEntry('books/.snapshots/stem-abc/v-22222222.txt', VOL2_SHA),
      { path: 'books/stem-abc/vol-001.txt', mode: '100644', type: 'blob', sha: SHA('9'), size: 40 }, // 未归类，带 size
    ];
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gatedRequest: GitHubJsonRequest = async () => {
      entered();
      await gate;
      return { status: 200, json: async () => ({ sha: manifestSha, encoding: 'base64', content: Buffer.from(built.bytes).toString('base64'), size: built.bytes.byteLength }) };
    };
    const gatedBlob = createGitHubManifestBlobReader({ request: gatedRequest, target });

    // 树端口返回同一数组/条目对象，供测试在 blob 挂起期间改「旧 getTree 响应」。
    const treeBase: GitTreePort = {
      getCommit: async () => ({ commitSha: COMMIT_SHA, treeSha: TREE_SHA }),
      getTree: async () => ({ sha: TREE_SHA, truncated: false, tree: entries }),
    };
    const { counts: tc, port: tree } = countTree(treeBase);
    const { counts: bc, port: blob } = countBlob(gatedBlob);

    const p = collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree, blob });
    await enteredP; // 组合已复制树材料并构造 binding，正等待 blob
    // 修改旧 getTree 响应数组与条目：canonical 条目的 path/sha、快照条目 sha、未归类条目 size，并追加一条。
    entries[0].sha = SHA('9');
    entries[0].path = 'books/evil/index.json';
    entries[1].sha = SHA('9');
    entries[3].size = 999;
    entries.push(rawEntry('books/injected/index.json', SHA('9')));
    release();

    const res = await p;
    expect(res).toMatchObject({
      status: 'fixed_book_manifest_candidate',
      manifestGitBlobSha: manifestSha,
      declaredFullTextBlobSha: FULL_TEXT_BLOB_SHA,
    });
    const out = res as unknown as {
      binding: { commitSha: string; treeSha: string; canonicalPath: string; manifestGitBlobSha: string };
      volumes: { snapshotPath: string; declaredBlobSha: string }[];
      observedUnclassifiedEntries: { path: string; size?: number }[];
    };
    expect(out.binding.commitSha).toBe(COMMIT_SHA);
    expect(out.binding.treeSha).toBe(TREE_SHA);
    expect(out.binding.canonicalPath).toBe(CANONICAL_PATH);
    expect(out.binding.manifestGitBlobSha).toBe(manifestSha);
    expect(out.volumes.map((v) => v.snapshotPath)).toEqual([
      'books/.snapshots/stem-abc/v-11111111.txt', 'books/.snapshots/stem-abc/v-22222222.txt',
    ]);
    expect(out.volumes.map((v) => v.declaredBlobSha)).toEqual([VOL1_SHA, VOL2_SHA]);
    // 未归类旧值不漂移（旧 size=40，非 999；追加条目不在结果内）。
    expect(out.observedUnclassifiedEntries.map((e) => e.path)).toEqual(['books/stem-abc/vol-001.txt']);
    expect(out.observedUnclassifiedEntries[0].size).toBe(40);
    // 端口方法进入次数仍 1/1/1。
    expect(tc).toEqual({ getCommit: 1, getTree: 1 });
    expect(bc).toEqual({ read: 1 });
  });

  it('16: P rejection domain mapping — schema tampered → manifest/manifest_unreadable; missing snapshot volume → manifest/volume_missing_in_tree', async () => {
    const built = buildTwoVolumeManifest();
    // 仅改 schema 并重序列化/hash：树与 blob 均按新字节一致，真实 P 给 manifest_unreadable。
    const badSchemaText = built.text.replace('"schema": 2', '"schema": 1');
    const badSchema = new Uint8Array(Buffer.from(badSchemaText, 'utf8'));
    const badSchemaSha = gitBlobSha(badSchema);
    const c1 = countTree(treePortOf([rawEntry(CANONICAL_PATH, badSchemaSha)]));
    const { port: b1 } = countBlob(realBlob(badSchema, badSchemaSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c1.port, blob: b1 }))
      .toEqual({ status: 'rejected', domain: 'manifest', reason: 'manifest_unreadable' });

    // 合法清单但缺所需快照卷引用 → manifest/volume_missing_in_tree。
    const manifestSha = gitBlobSha(built.bytes);
    const c2 = countTree(treePortOf([rawEntry(CANONICAL_PATH, manifestSha), rawEntry('books/.snapshots/stem-abc/v-11111111.txt', VOL1_SHA)])); // 缺 v-22222222
    const { port: b2 } = countBlob(realBlob(built.bytes, manifestSha));
    expect(await collectFixedBookManifestCandidate({ target: { ...target }, canonicalPath: CANONICAL_PATH }, { tree: c2.port, blob: b2 }))
      .toEqual({ status: 'rejected', domain: 'manifest', reason: 'volume_missing_in_tree' });
  });
});
