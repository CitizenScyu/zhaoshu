// T8 接线：GitHubContents 的运行时绑定（T3 五阶段发布的 GitHub 侧接缝）。
//
// 与现役 worker.mjs 的 commitFile/getContentsFileBytes 同口径（contents API + base64 信封写），
// 但走注入的 GitHubContents 接口，不读全局环境、不在任何错误里带 token/响应体。
// 404 返回 null（发布器据此判定「文件不存在」）。token 只进 Authorization 头。
//
// Accept 头按请求类型分开，**不共用**（曾因共用 raw+json 触发 P0，已对真实 GitHub 证实）。
// 订正一条曾坑人的假注释（旧代码注释称 "raw+json still yields the sha field"——**错，与真实
// GitHub 相反**，这正是「注释与代码相反」缺陷）：
//   - `application/vnd.github.raw+json` / `application/vnd.github.raw` 都返回**文件原始字节**，
//     不是 JSON 信封，没有 sha/encoding/content 字段；对它 res.json() 直接抛 SyntaxError。
//   - 只有 `application/vnd.github.object+json`（或 vnd.github+json）才返回含 `sha` 的 JSON 信封；
//     它对 >1MB 文件会把 content 降级成 `encoding:"none"`+空，但 **sha 一直在**。
// 故：currentSha 用 object 信封只取 sha；getBytes 用 raw + arrayBuffer 取原始字节。

import type { GitHubContents } from '../src/lib/download-publisher';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'zhaoshu-downloader/1.0';

/** object JSON 信封：含 `sha`/`encoding`/`content`；>1MB 时 content 可能降级为空但 sha 一直在。 */
const ACCEPT_OBJECT_JSON = 'application/vnd.github.object+json';
/** raw 媒体类型：返回文件原始字节（非 JSON），必须用 arrayBuffer 读，不能 res.json()。 */
const ACCEPT_RAW = 'application/vnd.github.raw';

export interface GitHubContentsOptions {
  token: string;
  /** owner/repo（现役键 GITHUB_REPOSITORY 形态）。 */
  repository: string;
  /**
   * 发布目标分支（DOWNLOAD_TARGET_BRANCH 反查 storage_repositories 出的同一条 branch）。
   * GET 带 `?ref=`、PUT body 带 `branch`，避免 contents API 落到仓库默认分支导致 DB 登记与真实写入分家。
   */
  branch: string;
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

export function createGitHubContents({ token, repository, branch, fetchImpl = fetch, timeoutMs = 60_000 }: GitHubContentsOptions): GitHubContents {
  if (!branch) throw new Error('createGitHubContents requires branch');
  // 共享头不含 Accept：每个调用按用途显式传（见文件头说明），避免 GET/PUT 共用一个媒体类型。
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
  const request = (url: string, accept: string, init: RequestInit = {}) =>
    fetchImpl(url, { ...init, headers: { ...headers, Accept: accept, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  // GET 落到 `?ref=<branch>`，与 PUT body 的 branch 同一条，读写不分叉到默认分支。
  const withRef = (url: string) => `${url}?ref=${encodeURIComponent(branch)}`;

  // object JSON 信封取 sha：即使文件 >1MB（encoding:"none"/空 content），sha 仍返回，currentSha 只读它。
  async function currentSha(url: string): Promise<string | null> {
    const res = await request(withRef(url), ACCEPT_OBJECT_JSON);
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res.status);
    const value = (await res.json()) as { sha?: unknown };
    return typeof value?.sha === 'string' ? value.sha : null;
  }

  return {
    async put(path, text, message) {
      const { url } = apiUrl(repository, path);
      const sha = await currentSha(url);
      const res = await request(url, 'application/vnd.github+json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          content: Buffer.from(text, 'utf8').toString('base64'),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!res.ok) throw httpError(res.status);
    },

    async getBytes(path) {
      const { url } = apiUrl(repository, path);
      // raw 媒体类型返回文件原始字节；用 arrayBuffer 读，绝不能 res.json()（会抛 SyntaxError）。
      const res = await request(withRef(url), ACCEPT_RAW);
      if (res.status === 404) return null;
      if (!res.ok) throw httpError(res.status);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
