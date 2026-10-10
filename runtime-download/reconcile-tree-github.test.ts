// capacity964/965 GitHub 只读树端口适配边界草稿（合成 request 桩，**只写不跑**）。
//
// 诚实边界：本文件证明的是**适配器契约**——注入式已认证相对路由请求函数映射到 962 `GitTreePort`：
// commit 嵌套响应映射、branch **整体**编码（允内部斜杠）、owner/repo 单段编码、固定 SHA 树路径+recursive=1、
// 点段/孤立代理项/错绑/非法请求**零调用**拒绝、私有目标不漂移、响应信封 status/json 校验、
// truncated 真实值保留（缺省不补 false）、条目 mode/type/sha/path/size 语义保留不修、畸形响应拒绝不假补、异常原引用无重试。
// 桩**不**执行真实 HTTP、不使用真实网络/token。**本片不**证明调用者认证安全，生产装配未交。
// 本文件为静态草稿，未在本次任务中执行（禁跑测试）。

import { describe, expect, it } from 'vitest';
import { captureTreeSnapshot, type TreeSnapshotResult } from './reconcile-tree-snapshot';
import {
  createGitHubTreePort,
  GitHubTreeError,
  type GitHubJsonRequest,
  type GitHubJsonResponse,
} from './reconcile-tree-github';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const target = { repositoryId: 7, owner: 'acme', repo: 'books', branch: 'release/2026' };

/** 合成 request 桩：记录收到的**相对路由**，按 handler 返回合成响应信封。不触真实网络。 */
function synth(handler: (route: string) => GitHubJsonResponse): { request: GitHubJsonRequest; routes: string[] } {
  const routes: string[] = [];
  const request: GitHubJsonRequest = async (route) => {
    routes.push(route);
    return handler(route);
  };
  return { request, routes };
}

const ok200 = (body: unknown): GitHubJsonResponse => ({ status: 200, json: async () => body });
const okCommit = (commitSha: string, treeSha: string): GitHubJsonResponse => ok200({
  // 真实 GitHub commit 响应含大量额外字段；保留嵌套 commit.tree.sha + 额外字段，验证允许额外字段/不依赖顺序。
  extra: 'ignored', commit: { message: 'm', tree: { sha: treeSha } }, sha: commitSha, node_id: 'x',
});
const okTree = (sha: string, truncated: unknown, tree: unknown): GitHubJsonResponse => ok200({ sha, truncated, tree, extra: 1 });
const blob = (path: string, sha: string, mode = '100644', size?: number) =>
  size === undefined ? { path, mode, type: 'blob', sha } : { path, mode, type: 'blob', sha, size };

describe('createGitHubTreePort (github read-only tree port adapter, static draft)', () => {
  it('1: real nested commit response maps to {commitSha, treeSha} (extra fields allowed, no order dependence)', async () => {
    const { request, routes } = synth((r) =>
      r.endsWith('/commits/release%2F2026') ? okCommit(SHA_B, SHA_A) : okTree(SHA_A, false, []));
    const port = createGitHubTreePort({ request, target });
    expect(await port.getCommit(target)).toEqual({ commitSha: SHA_B, treeSha: SHA_A });
    expect(routes).toEqual(['/repos/acme/books/commits/release%2F2026']); // 只发一次
  });

  it('2: a legal branch with internal slashes is encoded *as a whole* into one ref segment (F1)', async () => {
    const branch = 'feat/a/b𝄞';
    const { request, routes } = synth(() => okCommit(SHA_B, SHA_A));
    const port = createGitHubTreePort({ request, target: { ...target, branch } });
    // 默认目标 release/2026 与含内部斜杠/Unicode 的 branch 现均可构造并到达真正断言。
    await port.getCommit({ ...target, branch });
    expect(routes[0]).toBe(`/repos/acme/books/commits/${encodeURIComponent(branch)}`);
    expect(routes[0].includes('feat/a/')).toBe(false); // 斜杠 → %2F，不产生新路径段
    expect(routes[0].endsWith('/commits/feat%2Fa%2Fb%F0%9D%84%9E')).toBe(true); // 一次整体编码
  });

  it('3: URL-type owner (contains a slash) is *rejected* (F4); success uses a legal single-segment', async () => {
    const { request, routes } = synth(() => okCommit(SHA_B, SHA_A));
    // 含 scheme/斜杠的 owner → 构造即抛 INVALID_TARGET，request 零调用。
    expect(() => createGitHubTreePort({ request, target: { ...target, owner: 'https://evil.example', repo: 'r' } }))
      .toThrow(GitHubTreeError);
    // 合法单段 owner（需编码但不含斜杠）→ 单路径段编码，不改 scheme/host。
    const port = createGitHubTreePort({ request, target: { ...target, owner: 'acme corp', repo: 'r' } });
    await port.getCommit({ ...target, owner: 'acme corp', repo: 'r' });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toBe('/repos/acme%20corp/r/commits/release%2F2026');
    expect(routes[0].includes('://')).toBe(false);
  });

  it('3b: owner/repo containing a slash or empty is rejected at construction (no extra segment)', () => {
    const { request } = synth(() => okCommit(SHA_B, SHA_A));
    expect(() => createGitHubTreePort({ request, target: { ...target, owner: 'a/b' } })).toThrow(GitHubTreeError);
    expect(() => createGitHubTreePort({ request, target: { ...target, repo: '' } })).toThrow(GitHubTreeError);
  });

  it('4: tree is fetched by the fixed 40-hex treeSha with recursive=1', async () => {
    const { request, routes } = synth(() => okTree(SHA_A, false, []));
    const port = createGitHubTreePort({ request, target });
    await port.getTree(target, SHA_A, { recursive: true });
    expect(routes).toEqual([`/repos/acme/books/git/trees/${SHA_A}?recursive=1`]); // 只发一次
  });

  it('5: wrong target or illegal request params → reject *before* any request (zero calls)', async () => {
    const { request, routes } = synth(() => okCommit(SHA_B, SHA_A));
    const port = createGitHubTreePort({ request, target });
    await expect(port.getCommit({ ...target, branch: 'other' })).rejects.toMatchObject({ code: 'GITHUB_TREE_TARGET_MISMATCH' });
    await expect(port.getCommit({ ...target, repositoryId: 99 })).rejects.toMatchObject({ code: 'GITHUB_TREE_TARGET_MISMATCH' });
    await expect(port.getTree(target, 'XYZ', { recursive: true })).rejects.toMatchObject({ code: 'GITHUB_TREE_INVALID_REQUEST' }); // 非法 SHA
    await expect(port.getTree(target, SHA_A.toUpperCase(), { recursive: true })).rejects.toMatchObject({ code: 'GITHUB_TREE_INVALID_REQUEST' }); // 大写不合契约
    await expect(port.getTree(target, SHA_A, { recursive: false } as unknown as { recursive: true })).rejects.toMatchObject({ code: 'GITHUB_TREE_INVALID_REQUEST' });
    expect(routes).toHaveLength(0); // 全部在请求前拒绝
  });

  it('5b: dot-segment owner/repo/branch (. or ..) rejected before request, no percent-escape masking (F2)', () => {
    const { request, routes } = synth(() => okCommit(SHA_B, SHA_A));
    const err = (t: typeof target): unknown => {
      try { createGitHubTreePort({ request, target: t }); return null; } catch (e) { return e; }
    };
    for (const t of [
      { ...target, owner: '..', repo: 'books', branch: 'main' },
      { ...target, owner: 'acme', repo: '..', branch: 'main' },
      { ...target, owner: 'acme', repo: 'books', branch: '.' },
      { ...target, owner: 'acme', repo: 'books', branch: '..' },
    ]) {
      expect(err(t)).toMatchObject({ code: 'GITHUB_TREE_INVALID_TARGET' });
    }
    // 合法内部斜杠分支仍支持（点段拒绝不得误伤）。
    expect(err({ ...target, branch: 'feat/a/b' })).toBeNull();
    expect(routes).toHaveLength(0); // 点段在构造期拒绝，请求零调用
  });

  it('5c: isolated UTF-16 surrogate in owner/repo/branch → fixed INVALID_TARGET (not a local URIError) (F2)', async () => {
    const { request, routes } = synth(() => okCommit(SHA_B, SHA_A));
    const err = (t: typeof target): unknown => {
      try { createGitHubTreePort({ request, target: t }); return null; } catch (e) { return e; }
    };
    for (const t of [
      { ...target, owner: 'a\uD800b', repo: 'books', branch: 'main' },
      { ...target, owner: 'acme', repo: 'a\uDC00b', branch: 'main' },
      { ...target, owner: 'acme', repo: 'books', branch: 'a\uD800b' },
    ]) {
      const e = err(t);
      expect(e).toBeInstanceOf(GitHubTreeError);   // 固定错误，非 URIError
      expect(e).toMatchObject({ code: 'GITHUB_TREE_INVALID_TARGET' });
    }
    expect(routes).toHaveLength(0); // 编码前拒绝，请求零调用
  });

  it('6: mutating the caller-side target object does not drift the fixed binding', async () => {
    const { request, routes } = synth(() => okCommit(SHA_B, SHA_A));
    const mutable = { ...target };
    const port = createGitHubTreePort({ request, target: mutable });
    mutable.branch = 'hacked';            // 工厂已保存私有原语副本
    mutable.repositoryId = 12345;
    const viaCopy = { repositoryId: 7, owner: 'acme', repo: 'books', branch: 'release/2026' };
    expect(await port.getCommit(viaCopy)).toEqual({ commitSha: SHA_B, treeSha: SHA_A }); // 仍绑定原值
    expect(routes[0]).toBe('/repos/acme/books/commits/release%2F2026');
  });

  it('7: truncated=true or missing is *preserved* (not patched to false) and rejected by the real algorithm', async () => {
    for (const truncated of [true, undefined]) {
      const { request } = synth((r) =>
        r.endsWith('/git/trees/' + SHA_A + '?recursive=1') ? okTree(SHA_A, truncated, []) : okCommit(SHA_B, SHA_A));
      const port = createGitHubTreePort({ request, target });
      const res = await captureTreeSnapshot({ target }, port);
      expect(res).toEqual({ status: 'rejected', reason: 'incomplete_tree' }); // 不当空树
    }
  });

  it('7b: truncated=false is preserved as false (complete empty tree passes the real algorithm with both flags false)', async () => {
    const { request } = synth((r) =>
      r.endsWith('/git/trees/' + SHA_A + '?recursive=1') ? okTree(SHA_A, false, []) : okCommit(SHA_B, SHA_A));
    const port = createGitHubTreePort({ request, target });
    const res = await captureTreeSnapshot({ target }, port);
    expect(res).toEqual({
      status: 'tree_snapshot', target, commitSha: SHA_B, treeSha: SHA_A, entries: [],
      activationEligible: false, logicalInventoryVerified: false,
    });
  });

  it('8: a malformed commit/tree body is rejected without fabricating a usable snapshot', async () => {
    // 缺 commit.tree.sha
    const { request: r1 } = synth(() => ok200({ sha: SHA_B, commit: { tree: {} } }));
    await expect(createGitHubTreePort({ request: r1, target }).getCommit(target)).rejects.toMatchObject({ code: 'GITHUB_TREE_MALFORMED' });
    // 缺顶层 sha
    const { request: r2 } = synth(() => ok200({ commit: { tree: { sha: SHA_A } } }));
    await expect(createGitHubTreePort({ request: r2, target }).getCommit(target)).rejects.toMatchObject({ code: 'GITHUB_TREE_MALFORMED' });
    // tree 非数组（不用空数组掩盖非法）
    const { request: r3 } = synth(() => okTree(SHA_A, false, 'not-an-array'));
    await expect(createGitHubTreePort({ request: r3, target }).getTree(target, SHA_A, { recursive: true })).rejects.toMatchObject({ code: 'GITHUB_TREE_MALFORMED' });
    // 条目缺必需形状
    const { request: r4 } = synth(() => okTree(SHA_A, false, [{ path: 'a.txt', mode: '100644' }]));
    await expect(createGitHubTreePort({ request: r4, target }).getTree(target, SHA_A, { recursive: true })).rejects.toMatchObject({ code: 'GITHUB_TREE_MALFORMED' });
  });

  it('8b: illegal envelope status (NaN/fractional/out-of-range/Infinity) → fixed MALFORMED, never an HTTP field (F3)', async () => {
    for (const status of [NaN, 200.5, 99, 600, Infinity]) {
      const { request, routes } = synth(() => ({ status, json: async () => ({ sha: SHA_B, commit: { tree: { sha: SHA_A } } }) } as GitHubJsonResponse));
      const port = createGitHubTreePort({ request, target });
      const e = await port.getCommit(target).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(GitHubTreeError);
      expect(e).toMatchObject({ code: 'GITHUB_TREE_MALFORMED' });
      expect((e as GitHubTreeError).status).toBeUndefined(); // 非法值**不进** HTTP 错误字段
      expect(routes).toHaveLength(1); // 信封校验发生在请求之后
    }
  });

  it('8c: 2xx with missing/non-function json → fixed MALFORMED; legal non-2xx carries only the status and does not read the body (F3)', async () => {
    // 缺 json
    const { request: r1 } = synth(() => ({ status: 200 } as GitHubJsonResponse));
    await expect(createGitHubTreePort({ request: r1, target }).getCommit(target)).rejects.toMatchObject({ code: 'GITHUB_TREE_MALFORMED' });
    // json 非函数
    const { request: r2 } = synth(() => ({ status: 200, json: 42 } as unknown as GitHubJsonResponse));
    await expect(createGitHubTreePort({ request: r2, target }).getCommit(target)).rejects.toMatchObject({ code: 'GITHUB_TREE_MALFORMED' });
    // 合法非 2xx：仅携合法状态、不读正文
    let jsonRead = 0;
    const { request: r3 } = synth(() => ({ status: 404, json: async () => { jsonRead++; return { secret: 'leak' }; } }));
    const e = await createGitHubTreePort({ request: r3, target }).getCommit(target).then(() => null, (x) => x);
    expect(e).toMatchObject({ code: 'GITHUB_TREE_HTTP', status: 404 });
    expect(jsonRead).toBe(0); // 非 2xx 不读响应正文
  });

  it('9: entry mode/type/sha/path/size semantics are preserved (links/gitlink/dirs not filtered, size not rewritten)', async () => {
    const raw = [
      blob('txt/a.txt', SHA_C, '100644', 5),
      { path: 'link', mode: '120000', type: 'blob', sha: SHA_C },   // 符号链接保留
      { path: 'sub', mode: '040000', type: 'tree', sha: SHA_B },    // 目录保留
      { path: 'mod', mode: '160000', type: 'commit', sha: SHA_C },  // gitlink 保留
    ];
    const { request } = synth(() => okTree(SHA_A, false, raw));
    const port = createGitHubTreePort({ request, target });
    const listing = await port.getTree(target, SHA_A, { recursive: true });
    expect(listing.sha).toBe(SHA_A);
    expect(listing.truncated).toBe(false);
    expect(listing.tree).toEqual(raw); // 逐条原样保留，不额外字段、不造 size、不过滤
  });

  it('10: request exception is rethrown as-is, with no retry', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'E_PORT' });
    let calls = 0;
    const request: GitHubJsonRequest = async () => { calls++; throw boom; };
    const port = createGitHubTreePort({ request, target });
    await expect(port.getCommit(target)).rejects.toBe(boom); // 原引用
    expect(calls).toBe(1); // 无重试
  });

  it('11: illegal target at construction throws (no request, no drift)', () => {
    const { request, routes } = synth(() => okCommit(SHA_B, SHA_A));
    expect(() => createGitHubTreePort({ request, target: { ...target, repositoryId: 0 } })).toThrow(GitHubTreeError);
    expect(() => createGitHubTreePort({ request, target: { ...target, branch: '' } })).toThrow(GitHubTreeError);
    expect(() => createGitHubTreePort({ request: null as unknown as GitHubJsonRequest, target })).toThrow(GitHubTreeError);
    expect(routes).toHaveLength(0);
  });

  it('12: full happy path composes adapter + real algorithm (adapter never fabricates eligibility)', async () => {
    const { request } = synth((r) => {
      if (r.endsWith('/commits/release%2F2026')) return okCommit(SHA_B, SHA_A);
      return okTree(SHA_A, false, [blob('txt/a.txt', SHA_C, '100644', 5)]);
    });
    const port = createGitHubTreePort({ request, target });
    const res: TreeSnapshotResult = await captureTreeSnapshot({ target }, port);
    expect(res).toMatchObject({
      status: 'tree_snapshot', commitSha: SHA_B, treeSha: SHA_A,
      activationEligible: false, logicalInventoryVerified: false,
      entries: [{ path: 'txt/a.txt', kind: 'regular-blob', size: 5 }],
    });
    // 适配器不返回任何 verified/granted/ready 字段——由算法恒置 false 两资格字段。
    expect(JSON.stringify(res)).not.toMatch(/verified":true|granted|ready/);
  });
});
