// capacity962 固定 Git 树快照采集器边界草稿（合成桩，**只写不跑**）。
//
// 诚实边界：本文件证明的是**纯函数契约**——端口缺失失败关闭、目标私有副本、branch 只解析一次、
// 固定 treeSha、truncated 正面完整性、Git 对象 ID 契约、路径/mode/type/size 校验、去重排序、
// 分类保留、恒 false 许可字段、异常原样抛出。桩**不执行真实请求**，不证明真实 GitHub 采集。
// 本文件为静态草稿，未在本次任务中执行（禁跑测试）。

import { describe, expect, it } from 'vitest';
import {
  captureTreeSnapshot,
  type CommitResolution,
  type GitTreePort,
  type RawTreeEntry,
  type TreeListing,
  type TreeTarget,
} from './reconcile-tree-snapshot';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const target: TreeTarget = { repositoryId: 1, owner: 'acme', repo: 'books', branch: 'release/a' };

const blob = (path: string, sha: string, mode = '100644', size?: number): RawTreeEntry =>
  size === undefined ? { path, mode, type: 'blob', sha } : { path, mode, type: 'blob', sha, size };

/** 端口桩：记录调用参数；commit/tree 可由用例覆写。 */
function port(over: {
  commit?: CommitResolution;
  listing?: TreeListing | ((treeSha: string) => TreeListing);
  onGetTree?: (treeSha: string, t: TreeTarget) => void;
} = {}): { port: GitTreePort; calls: { getCommit: TreeTarget[]; getTree: [TreeTarget, string][] } } {
  const calls = { getCommit: [] as TreeTarget[], getTree: [] as [TreeTarget, string][] };
  const commit = over.commit ?? { commitSha: SHA_B, treeSha: SHA_A };
  const p: GitTreePort = {
    async getCommit(t) { calls.getCommit.push(t); return commit; },
    async getTree(t, treeSha) {
      calls.getTree.push([t, treeSha]);
      over.onGetTree?.(treeSha, t);
      const listing = over.listing ?? { sha: treeSha, truncated: false, tree: [] };
      return typeof listing === 'function' ? listing(treeSha) : listing;
    },
  };
  return { port: p, calls };
}

describe('captureTreeSnapshot (frozen git tree snapshot, no I/O)', () => {
  it('1: a complete empty tree yields a snapshot with no entries and both flags false', async () => {
    const { port: p } = port({ listing: { sha: SHA_A, truncated: false, tree: [] } });
    expect(await captureTreeSnapshot({ target }, p)).toEqual({
      status: 'tree_snapshot', target, commitSha: SHA_B, treeSha: SHA_A, entries: [],
      activationEligible: false, logicalInventoryVerified: false,
    });
  });

  it('1b: missing port → no_authoritative_source', async () => {
    expect(await captureTreeSnapshot({ target }, null)).toEqual({ status: 'rejected', reason: 'no_authoritative_source' });
    expect(await captureTreeSnapshot({ target }, undefined)).toEqual({ status: 'rejected', reason: 'no_authoritative_source' });
    expect(await captureTreeSnapshot({ target }, {} as GitTreePort)).toEqual({ status: 'rejected', reason: 'no_authoritative_source' });
  });

  it('2: missing truncated / truncated=true (incl. empty) → incomplete_tree, never an empty tree', async () => {
    expect(await captureTreeSnapshot({ target }, port({
      listing: { sha: SHA_A, tree: [] } as unknown as TreeListing,
    }).port)).toEqual({ status: 'rejected', reason: 'incomplete_tree' });
    expect(await captureTreeSnapshot({ target }, port({
      listing: { sha: SHA_A, truncated: true, tree: [] },
    }).port)).toEqual({ status: 'rejected', reason: 'incomplete_tree' });
    expect(await captureTreeSnapshot({ target }, port({
      listing: { sha: SHA_A, truncated: true, tree: [blob('a.txt', SHA_C)] },
    }).port)).toEqual({ status: 'rejected', reason: 'incomplete_tree' });
  });

  it('3: branch resolved once and the tree is fetched by the fixed treeSha', async () => {
    const { port: p, calls } = port({ commit: { commitSha: SHA_B, treeSha: SHA_A }, listing: { sha: SHA_A, truncated: false, tree: [] } });
    const res = await captureTreeSnapshot({ target }, p);
    expect(res).toMatchObject({ status: 'tree_snapshot' });
    expect(calls.getCommit).toHaveLength(1);             // 只解析一次
    expect(calls.getTree).toHaveLength(1);
    expect(calls.getTree[0][1]).toBe(SHA_A);             // 用固定 treeSha，非 branch
  });

  it('4: a tree listing whose sha does not match the requested treeSha → binding_conflict', async () => {
    const { port: p } = port({ commit: { commitSha: SHA_B, treeSha: SHA_A }, listing: { sha: SHA_C, truncated: false, tree: [] } });
    expect(await captureTreeSnapshot({ target }, p)).toEqual({ status: 'rejected', reason: 'binding_conflict' });
  });

  it('4b: malformed commit/tree object id → invalid_tree', async () => {
    expect(await captureTreeSnapshot({ target }, port({ commit: { commitSha: 'XYZ', treeSha: SHA_A } }).port))
      .toEqual({ status: 'rejected', reason: 'invalid_tree' });
    expect(await captureTreeSnapshot({ target }, port({ commit: { commitSha: SHA_B.toUpperCase(), treeSha: SHA_A } }).port))
      .toEqual({ status: 'rejected', reason: 'invalid_tree' }); // 大写不合契约
  });

  it('5: a complete normal tree is sorted and consistently de-duplicated', async () => {
    const { port: p } = port({
      commit: { commitSha: SHA_B, treeSha: SHA_A },
      listing: { sha: SHA_A, truncated: false, tree: [blob('txt/b.txt', SHA_C, '100644', 5), blob('txt/a.txt', SHA_B), blob('txt/b.txt', SHA_C, '100644', 5)] },
    });
    const res = await captureTreeSnapshot({ target }, p);
    expect(res).toMatchObject({ status: 'tree_snapshot' });
    const entries = (res as { entries: { path: string }[] }).entries;
    expect(entries.map(e => e.path)).toEqual(['txt/a.txt', 'txt/b.txt']); // 去重 + 排序
  });

  it('6: same path with conflicting content → invalid_tree', async () => {
    expect(await captureTreeSnapshot({ target }, port({
      commit: { commitSha: SHA_B, treeSha: SHA_A },
      listing: { sha: SHA_A, truncated: false, tree: [blob('txt/a.txt', SHA_B), blob('txt/a.txt', SHA_C)] },
    }).port)).toEqual({ status: 'rejected', reason: 'invalid_tree' });
  });

  it('7: illegal paths (dot/parent/absolute/backslash/empty/trailing/edge-whitespace) → invalid_tree', async () => {
    for (const bad of ['.', '..', 'a/../b.txt', '/a.txt', 'a\\b.txt', 'a//b.txt', 'a.txt/', ' a.txt', 'a.txt ']) {
      expect(await captureTreeSnapshot({ target }, port({
        commit: { commitSha: SHA_B, treeSha: SHA_A },
        listing: { sha: SHA_A, truncated: false, tree: [blob(bad, SHA_C)] },
      }).port)).toEqual({ status: 'rejected', reason: 'invalid_tree' });
    }
  });

  it('7b: isolated surrogate path rejected; valid supplementary-plane path accepted', async () => {
    expect(await captureTreeSnapshot({ target }, port({
      commit: { commitSha: SHA_B, treeSha: SHA_A },
      listing: { sha: SHA_A, truncated: false, tree: [blob('txt/\uD800a.txt', SHA_C)] },
    }).port)).toEqual({ status: 'rejected', reason: 'invalid_tree' });

    const p = port({
      commit: { commitSha: SHA_B, treeSha: SHA_A },
      listing: { sha: SHA_A, truncated: false, tree: [blob('txt/𝄞.txt', SHA_C)] },
    });
    const res = await captureTreeSnapshot({ target }, p.port);
    expect(res).toMatchObject({ status: 'tree_snapshot', entries: [{ path: 'txt/𝄞.txt' }] });
  });

  it('8: illegal mode/type pairing and bad sha/size → invalid_tree', async () => {
    const cases: RawTreeEntry[] = [
      { path: 'a.txt', mode: '999999', type: 'blob', sha: SHA_C },       // 未知 mode
      { path: 'a.txt', mode: '100644', type: 'tree', sha: SHA_C },       // mode/type 不符
      { path: 'a.txt', mode: '120000', type: 'tree', sha: SHA_C },       // 链接须 blob
      { path: 'a.txt', mode: '100644', type: 'blob', sha: 'zz' },        // 非法 sha
      { path: 'a.txt', mode: '100644', type: 'blob', sha: SHA_C, size: -1 }, // 负 size
      { path: 'a.txt', mode: '100644', type: 'blob', sha: SHA_C, size: 1.5 }, // 非安全整数
    ];
    for (const entry of cases) {
      expect(await captureTreeSnapshot({ target }, port({
        commit: { commitSha: SHA_B, treeSha: SHA_A },
        listing: { sha: SHA_A, truncated: false, tree: [entry] },
      }).port)).toEqual({ status: 'rejected', reason: 'invalid_tree' });
    }
  });

  it('9: symlink and gitlink keep their non-regular classification; missing size stays unknown (not 0)', async () => {
    const { port: p } = port({
      commit: { commitSha: SHA_B, treeSha: SHA_A },
      listing: {
        sha: SHA_A, truncated: false, tree: [
          { path: 'txt/a.txt', mode: '100644', type: 'blob', sha: SHA_C, size: 5 },
          { path: 'link', mode: '120000', type: 'blob', sha: SHA_C },
          { path: 'sub', mode: '040000', type: 'tree', sha: SHA_B },
          { path: 'mod', mode: '160000', type: 'commit', sha: SHA_C },
        ],
      },
    });
    const res = await captureTreeSnapshot({ target }, p);
    expect(res).toMatchObject({ status: 'tree_snapshot' });
    const entries = (res as { entries: { path: string; kind: string; size?: number }[] }).entries;
    const byPath = Object.fromEntries(entries.map(e => [e.path, e]));
    expect(byPath['txt/a.txt'].kind).toBe('regular-blob');
    expect(byPath['txt/a.txt'].size).toBe(5);
    expect(byPath['link'].kind).toBe('symlink');
    expect(byPath['sub'].kind).toBe('tree');
    expect(byPath['mod'].kind).toBe('gitlink');
    expect('size' in byPath['link']).toBe(false);   // 缺 size 保持未知，不造 0
    expect(byPath['link'].size).toBeUndefined();
  });

  it('10: mutating the port-received target copy cannot drift the later requests or output', async () => {
    let seenBranch = '';
    const { port: p } = port({
      commit: { commitSha: SHA_B, treeSha: SHA_A },
      listing: { sha: SHA_A, truncated: false, tree: [] },
      onGetTree: (treeSha, t) => { seenBranch = t.branch; },
    });
    const evil: GitTreePort = {
      async getCommit(t) {
        try { (t as { branch: string }).branch = 'other'; } catch { /* frozen */ }
        return p.getCommit(t);
      },
      async getTree(t, treeSha, o) {
        try { (t as { repositoryId: number }).repositoryId = 99; } catch { /* frozen */ }
        return p.getTree(t, treeSha, o);
      },
    };
    const res = await captureTreeSnapshot({ target }, evil);
    expect(res).toEqual({
      status: 'tree_snapshot', target, commitSha: SHA_B, treeSha: SHA_A, entries: [],
      activationEligible: false, logicalInventoryVerified: false,
    });
    expect(seenBranch).toBe('release/a'); // 端口侧未被漂移
  });

  it('11: port exception is rethrown as-is, without retry', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'E_PORT' });
    let treeCalls = 0;
    const p: GitTreePort = {
      async getCommit() { throw boom; },
      async getTree() { treeCalls++; return { sha: SHA_A, truncated: false, tree: [] }; },
    };
    await expect(captureTreeSnapshot({ target }, p)).rejects.toBe(boom);
    expect(treeCalls).toBe(0); // getCommit 抛出后不再取树、无重试
  });

  it('12: invalid target → binding_conflict before any port call', async () => {
    let called = 0;
    const p: GitTreePort = {
      async getCommit() { called++; return { commitSha: SHA_B, treeSha: SHA_A }; },
      async getTree() { called++; return { sha: SHA_A, truncated: false, tree: [] }; },
    };
    expect(await captureTreeSnapshot({ target: { ...target, repositoryId: 0 } }, p)).toEqual({ status: 'rejected', reason: 'binding_conflict' });
    expect(await captureTreeSnapshot({ target: { ...target, branch: '' } }, p)).toEqual({ status: 'rejected', reason: 'binding_conflict' });
    expect(called).toBe(0);
  });
});
