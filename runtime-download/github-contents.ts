// T8 接线：GitHubContents 的运行时绑定（T3 五阶段发布的 GitHub 侧接缝）。
//
// 与现役 worker.mjs 的 commitFile/getContentsFileBytes 同口径（contents API + base64 信封），
// 但走注入的 GitHubContents 接口，不读全局环境、不在任何错误里带 token/响应体。
// 404 返回 null（发布器据此判定「文件不存在」）。token 只进 Authorization 头。

import type { GitHubContents } from '../src/lib/download-publisher';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'zhaoshu-downloader/1.0';

export interface GitHubContentsOptions {
  token: string;
  /** owner/repo（现役键 GITHUB_REPOSITORY 形态）。 */
  repository: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function apiUrl(repository: string, path: string): { owner: string; repo: string; url: string } {
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra !== undefined) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  return { owner, repo, url: `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}` };
}

/** 错误只保留 HTTP 状态/类别，绝不透传响应体（可能含服务端回显）。 */
function httpError(status: number): Error {
  return Object.assign(new Error(`github_http_${status}`), { status });
}

export function createGitHubContents({ token, repository, fetchImpl = fetch, timeoutMs = 60_000 }: GitHubContentsOptions): GitHubContents {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
  const request = (url: string, init: RequestInit = {}) =>
    fetchImpl(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });

  async function currentSha(url: string): Promise<string | null> {
    const res = await request(url);
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res.status);
    const value = (await res.json()) as { sha?: unknown };
    return typeof value?.sha === 'string' ? value.sha : null;
  }

  return {
    async put(path, text, message) {
      const { url } = apiUrl(repository, path);
      const sha = await currentSha(url);
      const res = await request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          content: Buffer.from(text, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
      if (!res.ok) throw httpError(res.status);
    },

    async getBytes(path) {
      const { url } = apiUrl(repository, path);
      const res = await request(url);
      if (res.status === 404) return null;
      if (!res.ok) throw httpError(res.status);
      const value = (await res.json()) as { encoding?: unknown; content?: unknown };
      if (value?.encoding !== 'base64' || typeof value.content !== 'string') {
        throw new Error('github_contents_bad_payload');
      }
      return Buffer.from(value.content, 'base64');
    },
  };
}
