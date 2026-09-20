// T8 验收：生产 GitHubContents 适配器（合成 fetch，不联网）。
// 判别力覆盖（删掉修复即失败）：
//   - 404 → getBytes 返回 null；
//   - 401/403 错误消息脱敏（不含 token、不透传响应体）；
//   - 同内容重复 PUT 带 sha（幂等，不覆盖误建）；
//   - base64/utf8 口径双向；
//   - 非默认分支：GET 带 `?ref=<branch>`、PUT body 带 `branch`（发现 1：读写不落默认分支）。
import { describe, expect, it } from 'vitest';
import { createGitHubContents } from './github-contents';

const TOKEN = 'ghp_SECRET_TOKEN_should_never_surface';
const REPO = 'zhaoshu-owner/novel-store';

interface FetchCall { url: string; method: string; body?: Record<string, unknown> }

/** 合成 fetch：按 method 交给 handler；记录每次调用的 url/method/body（PUT 解析 JSON body）。 */
function makeFetch(handler: (call: FetchCall) => { status: number; json?: unknown }) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const call: FetchCall = { url: String(url), method, body };
    calls.push(call);
    const { status, json } = handler(call);
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return json ?? {}; },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('T8 GitHubContents 生产适配器（合成 fetch）', () => {
  it('getBytes 404 → null', async () => {
    const { impl } = makeFetch(() => ({ status: 404 }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    expect(await gh.getBytes('a/b.txt')).toBeNull();
  });

  it('base64/utf8 口径：getBytes 解出 base64 内容为 utf8 Buffer', async () => {
    const content = Buffer.from('整本合成正文', 'utf8').toString('base64');
    const { impl } = makeFetch(() => ({ status: 200, json: { encoding: 'base64', content } }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    const bytes = await gh.getBytes('a/b.txt');
    expect(bytes?.toString('utf8')).toBe('整本合成正文');
  });

  it('put 编码：body.content 为 utf8→base64，且不裸传明文', async () => {
    const { impl, calls } = makeFetch((c) => (c.method === 'GET' ? { status: 404 } : { status: 201 }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await gh.put('a/b.txt', '整本合成正文', 'msg');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(Buffer.from(String(put.body!.content), 'base64').toString('utf8')).toBe('整本合成正文');
  });

  it('同内容重复 PUT 带 sha（先 GET 拿到 sha，PUT body 带上）', async () => {
    const { impl, calls } = makeFetch((c) =>
      c.method === 'GET' ? { status: 200, json: { sha: 'existing-sha-123' } } : { status: 200 });
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await gh.put('a/b.txt', 'x', 'msg');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body!.sha).toBe('existing-sha-123');
  });

  it('首次 PUT（GET 404）不带 sha', async () => {
    const { impl, calls } = makeFetch((c) => (c.method === 'GET' ? { status: 404 } : { status: 201 }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await gh.put('a/b.txt', 'x', 'msg');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect('sha' in put.body!).toBe(false);
  });

  it('401 错误脱敏：消息只带状态，不含 token', async () => {
    const { impl } = makeFetch(() => ({ status: 401, json: { message: 'Bad credentials', token: TOKEN } }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await expect(gh.getBytes('a/b.txt')).rejects.toThrow('github_http_401');
    await gh.getBytes('a/b.txt').catch((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain('Bad credentials');
    });
  });

  it('403 错误脱敏（put 路径）：消息不含 token/响应体', async () => {
    const { impl } = makeFetch((c) => (c.method === 'GET' ? { status: 404 } : { status: 403, json: { message: 'forbidden', token: TOKEN } }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await gh.put('a/b.txt', 'x', 'msg').catch((e: Error) => {
      expect(e.message).toBe('github_http_403');
      expect(e.message).not.toContain(TOKEN);
    });
  });

  it('发现 1：非默认分支 → GET 带 ?ref、PUT body 带 branch', async () => {
    const branch = 'release-2026';
    const { impl, calls } = makeFetch((c) => (c.method === 'GET' ? { status: 404 } : { status: 201 }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch, fetchImpl: impl });
    await gh.put('books/x.txt', 'content', 'msg');
    const get = calls.find((c) => c.method === 'GET')!;
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(get.url).toContain(`?ref=${branch}`);
    expect(put.body!.branch).toBe(branch);
    // getBytes 同样带 ref
    calls.length = 0;
    await gh.getBytes('books/x.txt');
    expect(calls[0].url).toContain(`?ref=${branch}`);
  });

  it('branch 缺省即抛（不静默落默认分支）', () => {
    expect(() => createGitHubContents({ token: TOKEN, repository: REPO, branch: '', fetchImpl: makeFetch(() => ({ status: 200 })).impl }))
      .toThrow('createGitHubContents requires branch');
  });
});
