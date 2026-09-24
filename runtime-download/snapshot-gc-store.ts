// B2-05 快照 GC 的只读 GitHub 存储(gcls-41):列快照目录 + 读清单,只发 GET。
//
// - 读文件:直接复用 createGitHubContents 的 getBytes(raw 媒体类型、?ref=<branch>、404→null)。
// - 列目录:Git Trees API `git/trees/<branch>:<dir>`(非递归),一次拿到目录项名字与 blob 字节数;
//   contents API 列目录有 1000 项上限且不回大小,不用它。tree 响应 truncated ⇒ 抛错(GC 侧按
//   store_error 整本跳过),绝不拿半截列表判孤儿。
// - 路径口径与发布器一致:`books/.snapshots/<encodeURIComponent(stem)>/...` 原样拼进 URL,由 GitHub
//   解码成真实目录名;列根目录拿到的是真实名,故 stem = encodeURIComponent(真实名)。
// - **不实现删除**:deleteFile 恒抛错。所有请求经 readOnlyFetch 二次把关,非 GET 直接拒绝。
// - 凭据只进 Authorization 头(createGitHubRequest);错误只带状态码(httpError),不带响应体。

import { SNAPSHOT_DIR } from '../src/lib/download-publisher';
import type { SnapshotGcStore } from '../src/lib/snapshot-gc';
import { createGitHubContents, createGitHubRequest, httpError, repoApiBase } from './github-contents';

const ACCEPT_JSON = 'application/vnd.github+json';

export interface SnapshotGcStoreOptions {
  token: string;
  /** owner/repo。 */
  repository: string;
  branch: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GitHubRateLimit { remaining: number; resetAt: number }

export interface ReadOnlySnapshotGcStore extends SnapshotGcStore {
  /** `books/.snapshots` 下的书目录(编码 stem,与 snapshotPaths 同口径),按真实名排序。 */
  listStems(): Promise<string[]>;
  /** 最近一次 listFiles 得到的 blob 字节数;没列过或不是文件返回 undefined。 */
  sizeOf(path: string): number | undefined;
  /** 最近一次响应头里的速率限制余量(没有该头时为 null)。 */
  rateLimit(): GitHubRateLimit | null;
}

interface TreeEntry { path?: unknown; type?: unknown; size?: unknown }

export function createSnapshotGcStore({ token, repository, branch, fetchImpl = fetch, timeoutMs = 60_000 }: SnapshotGcStoreOptions): ReadOnlySnapshotGcStore {
  if (!branch) throw new Error('createSnapshotGcStore requires branch');
  const base = repoApiBase(repository);
  let rate: GitHubRateLimit | null = null;
  const readOnlyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') throw new Error(`snapshot GC store is read-only (refused ${method})`);
    const res = await fetchImpl(input, init);
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.headers.has('x-ratelimit-remaining') && Number.isFinite(remaining)) {
      rate = { remaining, resetAt: Number.isFinite(reset) ? reset * 1000 : 0 };
    }
    return res;
  }) as typeof fetch;
  const request = createGitHubRequest({ token, fetchImpl: readOnlyFetch, timeoutMs });
  const contents = createGitHubContents({ token, repository, branch, fetchImpl: readOnlyFetch, timeoutMs });
  const sizes = new Map<string, number>();

  /** 非递归列目录;目录不存在返回 null。 */
  async function listTree(dir: string): Promise<{ name: string; type: string; size?: number }[] | null> {
    const res = await request(`${base}/git/trees/${encodeURIComponent(branch)}:${dir}`, ACCEPT_JSON);
    if (res.status === 404) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw httpError(res.status);
    }
    const value = (await res.json()) as { tree?: unknown; truncated?: unknown };
    if (value.truncated === true) throw new Error('github_tree_truncated');
    if (!Array.isArray(value.tree)) throw new Error('github_tree_malformed');
    return (value.tree as TreeEntry[]).map(entry => {
      if (typeof entry.path !== 'string' || typeof entry.type !== 'string') throw new Error('github_tree_malformed');
      return { name: entry.path, type: entry.type, ...(typeof entry.size === 'number' ? { size: entry.size } : {}) };
    });
  }

  return {
    async listStems() {
      const entries = await listTree(SNAPSHOT_DIR);
      return (entries ?? []).filter(entry => entry.type === 'tree').map(entry => encodeURIComponent(entry.name));
    },

    async listFiles(dir) {
      const entries = await listTree(dir);
      const names: string[] = [];
      for (const entry of entries ?? []) {
        if (entry.type !== 'blob') continue;
        names.push(entry.name);
        if (entry.size !== undefined) sizes.set(`${dir}/${entry.name}`, entry.size);
      }
      return names;
    },

    getBytes: path => contents.getBytes(path),

    async deleteFile() {
      throw new Error('snapshot GC store is read-only: deleteFile is not implemented');
    },

    sizeOf: path => sizes.get(path),
    rateLimit: () => rate,
  };
}
