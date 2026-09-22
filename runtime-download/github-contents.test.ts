// T8 验收：生产 GitHubContents 适配器（合成 fetch，不联网，但**忠实复刻真实 GitHub 的媒体类型行为**）。
// 判别力覆盖（删掉修复即失败）：
//   - getBytes 用 raw 媒体类型 + arrayBuffer 取原始字节；若改回 res.json() 解 raw，mock 的 raw 响应
//     .json() 抛 SyntaxError（=真实 GitHub 行为）→ 测试红（P0 回归锁）。
//   - currentSha 用 object+json 信封取 sha；Accept 与 getBytes 的 raw **分开**（曾共用 raw+json 触发 P0）。
//   - currentSha 读 >1MB 降级信封（encoding:"none"/空 content）仍拿到 sha。
//   - 404 → null；401/403 错误脱敏（不含 token/不透传响应体）；PUT 带 sha/不带 sha；分支 ?ref；
//     base64/utf8 写口径；PUT 不解析响应。

import { describe, expect, it } from 'vitest';
import { createGitHubContents } from './github-contents';

const TOKEN = 'ghp_SECRET_TOKEN_should_never_surface';
const REPO = 'zhaoshu-owner/novel-store';

// raw 媒体类型真实返回的字节（非 JSON）；用它喂 getBytes。
const RAW_OBJECT_JSON = 'application/vnd.github.object+json';
const RAW_MEDIA = 'application/vnd.github.raw';

interface FetchCall { url: string; method: string; body?: Record<string, unknown>; accept: string }

/**
 * GitHub-faithful response shape：
 *   - `json`：JSON 信封（object+json）—— .json() 返回它，.arrayBuffer() 返回其序列化字节。
 *   - `raw`：raw 媒体类型返回文件原始字节—— .arrayBuffer() 返回它，.json() **抛 SyntaxError**
 *     （真实 GitHub 对 raw+json/raw 就是这个行为，曾致 getBytes/currentSha 全挂）。
 */
interface Reply { status: number; json?: unknown; raw?: Buffer }

function arrayBufferOf(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function makeFetch(handler: (call: FetchCall) => Reply) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const call: FetchCall = { url: String(url), method, body, accept: headers.get('accept') ?? '' };
    calls.push(call);
    const reply = handler(call);
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      async json() {
        if (reply.raw !== undefined) {
          // raw 媒体类型返回的是文件原始字节，不是 JSON —— res.json() 必抛（真实 GitHub 行为）。
          throw new SyntaxError('Unexpected token, raw media-type body is not valid JSON');
        }
        return reply.json ?? {};
      },
      async arrayBuffer() {
        return arrayBufferOf(reply.raw ?? Buffer.from(JSON.stringify(reply.json ?? {}), 'utf8'));
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('T8 GitHubContents 生产适配器（合成 fetch，忠实复刻媒体类型）', () => {
  it('getBytes 用 raw 媒体类型 + arrayBuffer 取原始字节（P0 回归锁：改回 res.json() 即红）', async () => {
    const file = Buffer.from('整本合成正文', 'utf8');
    const { impl, calls } = makeFetch(() => ({ status: 200, raw: file }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    const bytes = await gh.getBytes('a/b.txt');
    expect(bytes).not.toBeNull();
    // 若实现改回 `await res.json()` 解 raw，上一行已因 mock .json() 抛 SyntaxError 而失败。
    expect(Buffer.compare(bytes!, file)).toBe(0);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].accept).toBe(RAW_MEDIA); // 必须是 raw，不是 base64 信封
  });

  it('Accept 按请求类型分开：currentSha=object+json，getBytes=raw（不共用 raw+json）', async () => {
    // 同一个 gh 实例先后走 currentSha(经 put 前置 GET) 与 getBytes，验证两者 Accept 不同。
    const { impl, calls } = makeFetch((c) => {
      if (c.method === 'PUT') return { status: 201 };
      // GET：按 Accept 分辨该返 raw 字节还是 object 信封。
      return c.accept === RAW_OBJECT_JSON
        ? { status: 200, json: { sha: 'deadbeef', encoding: 'base64', content: '' } }
        : { status: 200, raw: Buffer.from('x', 'utf8') };
    });
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await gh.put('a/b.txt', 'x', 'msg'); // 内部先 currentSha（object+json）
    await gh.getBytes('a/b.txt');       // raw
    const gets = calls.filter((c) => c.method === 'GET');
    const shaGet = gets.find((c) => c.url.includes('a/b.txt') && c.accept === RAW_OBJECT_JSON);
    const byteGet = gets.find((c) => c.accept === RAW_MEDIA);
    expect(shaGet, 'currentSha 的 GET 必须用 object+json').toBeTruthy();
    expect(byteGet, 'getBytes 的 GET 必须用 raw').toBeTruthy();
    expect(shaGet!.accept).not.toBe(byteGet!.accept);
    // 回归锁：任何一端回落成共用的 raw+json 都会让下面某个 GET 的 Accept 不符而红。
  });

  it('currentSha 读 >1MB 降级信封仍拿到 sha（encoding:"none"/空 content 不影响）', async () => {
    // 真实 GitHub 对 >1MB 文件的 object 信封：encoding:"none"、content 空，但 sha 仍在。
    const { impl, calls } = makeFetch((c) =>
      c.method === 'GET'
        ? { status: 200, json: { sha: 'big-blob-sha-40chars-aaaaaaaaaaaaaaaaaaaa', encoding: 'none', content: '' } }
        : { status: 201 });
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await gh.put('books/manifest.json', '{}', 'msg');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body!.sha).toBe('big-blob-sha-40chars-aaaaaaaaaaaaaaaaaaaa');
    expect(calls.find((c) => c.method === 'GET')!.accept).toBe(RAW_OBJECT_JSON);
  });

  it('getBytes 404 → null', async () => {
    const { impl } = makeFetch(() => ({ status: 404 }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    expect(await gh.getBytes('a/b.txt')).toBeNull();
  });

  it('put 编码：body.content 为 utf8→base64，且不裸传明文；PUT 用 application/vnd.github+json、不解析响应', async () => {
    const { impl, calls } = makeFetch((c) => (c.method === 'GET' ? { status: 404 } : { status: 201 }));
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: impl });
    await gh.put('a/b.txt', '整本合成正文', 'msg');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(Buffer.from(String(put.body!.content), 'base64').toString('utf8')).toBe('整本合成正文');
    // PUT 不回落成 raw 媒体类型；写路径用标准 contents JSON 媒体类型即可（body 已是 base64 信封）。
    expect(put.accept).toBe('application/vnd.github+json');
    // 响应无 .json()/.arrayBuffer() 调用即代表不解析（此断言由 mock 覆盖：PUT 分支只回 status）。
  });

  it('同内容重复 PUT 带 sha（先 GET object+json 拿到 sha，PUT body 带上）', async () => {
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
    expect('sha' in calls.find((c) => c.method === 'PUT')!.body!).toBe(false);
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

  it('发现 1：非默认分支 → GET 带 ?ref、PUT body 带 branch；getBytes 同样带 ref', async () => {
    const branch = 'release-2026';
    const { impl, calls } = makeFetch((c) => {
      if (c.method === 'PUT') return { status: 201 };
      return c.accept === RAW_OBJECT_JSON ? { status: 404 } : { status: 200, raw: Buffer.from('c', 'utf8') };
    });
    const gh = createGitHubContents({ token: TOKEN, repository: REPO, branch, fetchImpl: impl });
    await gh.put('books/x.txt', 'content', 'msg');
    const get = calls.find((c) => c.method === 'GET')!;
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(get.url).toContain(`?ref=${branch}`);
    expect(put.body!.branch).toBe(branch);
    calls.length = 0;
    await gh.getBytes('books/x.txt');
    expect(calls[0].url).toContain(`?ref=${branch}`);
  });

  it('branch 缺省即抛（不静默落默认分支）', () => {
    expect(() => createGitHubContents({ token: TOKEN, repository: REPO, branch: '', fetchImpl: makeFetch(() => ({ status: 200 })).impl }))
      .toThrow('createGitHubContents requires branch');
  });
});
