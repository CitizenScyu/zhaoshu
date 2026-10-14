// 固定清单 blob 只读取回适配 —— 草稿向量（只写不跑）。
// 全部使用合成 request/json 与真实 gitBlobSha 算法表达；不创建网络请求器、不发真实请求。
// 正常夹具使用真实 GitHubJsonResponse/GitHubJsonRequest（json 必填）；仅在负例注入边界把畸形信封转 unknown。

import { describe, it, expect } from 'vitest';
import { gitBlobSha } from '../src/lib/artifact-bytes';
import {
  createGitHubManifestBlobReader,
  GitHubManifestBlobError,
  type FixedManifestBlobBytes,
} from './reconcile-manifest-blob-github';
import type { GitHubJsonRequest, GitHubJsonResponse } from './reconcile-tree-github';
import type { TreeTarget } from './reconcile-tree-snapshot';

// ---------- 合成材料 ----------

/** 合成响应信封：真实 GitHubJsonResponse（json 必填）；可注入异步拒绝值。 */
function res(status: number, body: unknown, opts?: { jsonReject?: unknown }): GitHubJsonResponse {
  return {
    status,
    json(): Promise<unknown> {
      if (opts && 'jsonReject' in opts) return Promise.reject(opts.jsonReject);
      return Promise.resolve(body);
    },
  };
}

/** 合法 git blob JSON 体。 */
function blobBody(content: string, size: number, sha: string): Record<string, unknown> {
  return { sha, encoding: 'base64', content, size };
}

/** 记录路由的合成 request（真实 GitHubJsonRequest）。 */
function recordingRequest(respond: (route: string) => GitHubJsonResponse | Promise<GitHubJsonResponse>) {
  const routes: string[] = [];
  const request: GitHubJsonRequest = async (route: string) => {
    routes.push(route);
    return respond(route);
  };
  return { request, routes };
}

const FIXED: TreeTarget = { repositoryId: 7, owner: 'acme', repo: 'books', branch: 'main' };
const EXPECTED = 'a'.repeat(40); // 40 位十六进制占位（真实用例替换为真 hash）

/** 由原始字节构造成功用例的（content/size/sha）。 */
function materialFromBytes(bytes: Uint8Array): { content: string; size: number; sha: string } {
  const content = Buffer.from(bytes).toString('base64');
  return { content, size: bytes.byteLength, sha: gitBlobSha(bytes) };
}

function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  return fn().then(
    () => { throw new Error(`expected throw ${code}`); },
    (e: unknown) => {
      expect(e).toBeInstanceOf(GitHubManifestBlobError);
      expect((e as GitHubManifestBlobError).code).toBe(code);
    },
  );
}

// ---------- 1. 折行同字节 / 边界 ----------
describe('capacity971 组1：折行不变量与边界', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]); // 非 3 对齐
  const { content, size, sha } = materialFromBytes(bytes);

  it('标准无折行 → 返回原始字节，request=1/json=1，路由不含 branch/contents', async () => {
    let reqCalls = 0, jsonCalls = 0;
    const routes: string[] = [];
    const request: GitHubJsonRequest = async (route: string) => {
      reqCalls++;
      routes.push(route);
      return {
        status: 200,
        json: async () => { jsonCalls++; return blobBody(content, size, sha); },
      };
    };
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    const out = await reader.readManifestBlob(FIXED, sha);
    expect(out.status).toBe('fixed_manifest_blob_bytes');
    expect(Array.from(out.bytes)).toEqual(Array.from(bytes));
    expect(out.manifestGitBlobSha).toBe(sha);
    expect(routes).toEqual([`/repos/acme/books/git/blobs/${sha}`]);
    expect(reqCalls).toBe(1);
    expect(jsonCalls).toBe(1);
  });

  it('LF / CRLF / 尾折行 → 同一规范内容得到同一字节；折行宽度不固定', async () => {
    const withLf = content.replace(/(.{4})/g, '$1\n');
    const withCrlf = content.replace(/(.{4})/g, '$1\r\n');
    const trailing = content + '\n\n';
    for (const variant of [withLf, withCrlf, trailing]) {
      const { request } = recordingRequest(() => res(200, blobBody(variant, size, sha)));
      const reader = createGitHubManifestBlobReader({ request, target: FIXED });
      const out = await reader.readManifestBlob(FIXED, sha);
      expect(Array.from(out.bytes)).toEqual(Array.from(bytes));
    }
  });

  it('空 blob（size=0）可返回固定空字节，但不判为有效清单', async () => {
    const empty = new Uint8Array(0);
    const emptySha = gitBlobSha(empty);
    const { request } = recordingRequest(() => res(200, blobBody('', 0, emptySha)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    const out = await reader.readManifestBlob(FIXED, emptySha);
    expect(out.bytes.byteLength).toBe(0);
    expect(out.status).toBe('fixed_manifest_blob_bytes'); // 不附带任何清单有效性声明
  });

  it('恰好 M 字节边界（E 字符、尾 ==）→ 成功返回', async () => {
    const M = 4 * 1024 * 1024;
    const big = new Uint8Array(M);
    for (let i = 0; i < M; i++) big[i] = i & 0xff;
    const m = materialFromBytes(big);
    const { request } = recordingRequest(() => res(200, blobBody(m.content, m.size, m.sha)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    const out: FixedManifestBlobBytes = await reader.readManifestBlob(FIXED, m.sha);
    expect(out.bytes.byteLength).toBe(M);
  });
});

// ---------- 2. 前置身份门：零请求 ----------
describe('capacity971 组2：前置身份门零请求', () => {
  it('repositoryId/owner/repo/branch 任一不符 → TARGET_MISMATCH 且 request=0', async () => {
    const { request, routes } = recordingRequest(() => res(200, blobBody('', 0, EXPECTED)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    const bad: TreeTarget[] = [
      { ...FIXED, repositoryId: 8 },
      { ...FIXED, owner: 'other' },
      { ...FIXED, repo: 'other' },
      { ...FIXED, branch: 'dev' },
    ];
    for (const t of bad) {
      await expectCode(() => reader.readManifestBlob(t, EXPECTED), 'GITHUB_BLOB_TARGET_MISMATCH');
    }
    expect(routes).toHaveLength(0);
  });

  it('非法 SHA（长度/大写/非 hex/非串）→ INVALID_REQUEST 且 request=0', async () => {
    const { request, routes } = recordingRequest(() => res(200, blobBody('', 0, EXPECTED)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'z'.repeat(40), 123 as unknown as string]) {
      await expectCode(() => reader.readManifestBlob(FIXED, bad), 'GITHUB_BLOB_INVALID_REQUEST');
    }
    expect(routes).toHaveLength(0);
  });

  it('工厂目标非法（owner 点段/斜杠/孤立代理项）→ INVALID_TARGET', () => {
    const mk = (target: TreeTarget) => () =>
      createGitHubManifestBlobReader({ request: async () => res(200, {}), target });
    expect(mk({ ...FIXED, owner: '.' })).toThrow(GitHubManifestBlobError);
    expect(mk({ ...FIXED, owner: 'a/b' })).toThrow(GitHubManifestBlobError);
    expect(mk({ ...FIXED, owner: '\ud800' })).toThrow(GitHubManifestBlobError);
    expect(mk({ ...FIXED, repo: '..' })).toThrow(GitHubManifestBlobError);
  });

  it('目标错且 SHA 也错 → 目标优先（TARGET_MISMATCH）', async () => {
    const { request } = recordingRequest(() => res(200, {}));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    await expectCode(() => reader.readManifestBlob({ ...FIXED, owner: 'x' }, 'bad'), 'GITHUB_BLOB_TARGET_MISMATCH');
  });
});

// ---------- 3. 信封形状 ----------
describe('capacity971 组3：信封与 JSON 形状', () => {
  it('status 非法（NaN/非整数/越界/非数字）→ MALFORMED 且不调 json', async () => {
    for (const bad of [NaN, 200.5, 99, 600, '200', undefined]) {
      let jsonCalls = 0;
      const env = { status: bad, json: async () => { jsonCalls++; return {}; } } as unknown as GitHubJsonResponse;
      const { request } = recordingRequest(() => env);
      const reader = createGitHubManifestBlobReader({ request, target: FIXED });
      await expectCode(() => reader.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_MALFORMED');
      expect(jsonCalls).toBe(0);
    }
  });

  it('404/302 → HTTP（带合法 status）且 json=0', async () => {
    for (const status of [404, 302]) {
      let jsonCalls = 0;
      const env: GitHubJsonResponse = { status, json: async () => { jsonCalls++; return {}; } };
      const { request } = recordingRequest(() => env);
      const reader = createGitHubManifestBlobReader({ request, target: FIXED });
      await reader.readManifestBlob(FIXED, EXPECTED).then(
        () => { throw new Error('expected throw'); },
        (e: unknown) => {
          expect((e as GitHubManifestBlobError).code).toBe('GITHUB_BLOB_HTTP');
          expect((e as GitHubManifestBlobError).status).toBe(status);
        },
      );
      expect(jsonCalls).toBe(0);
    }
  });

  it('2xx 缺 json 函数 / JSON 为数组 / encoding=none / size 非法 → MALFORMED', async () => {
    const cases: GitHubJsonResponse[] = [
      { status: 200 } as unknown as GitHubJsonResponse, // 缺 json：仅负例注入边界转换，不放宽正常类型
      res(200, []),
      res(200, { sha: EXPECTED, encoding: 'none', content: '', size: 0 }),
      res(200, { sha: EXPECTED, encoding: 'base64', content: '', size: -1 }),
      res(200, { sha: EXPECTED, encoding: 'base64', content: '', size: 1.5 }),
      res(200, { sha: EXPECTED, encoding: 'base64', content: '', size: '0' }),
    ];
    for (const env of cases) {
      const { request } = recordingRequest(() => env);
      const reader = createGitHubManifestBlobReader({ request, target: FIXED });
      await expectCode(() => reader.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_MALFORMED');
    }
  });
});

// ---------- 4. SHA / SIZE / HASH 三类不混 ----------
describe('capacity971 组4：三类不符不混', () => {
  it('响应 sha 与固定期望不同 → SHA_MISMATCH', async () => {
    const other = 'b'.repeat(40);
    const { request } = recordingRequest(() => res(200, blobBody('', 0, other)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    await expectCode(() => reader.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_SHA_MISMATCH');
  });

  it('shape 合法但 size 与解码长度不符 → SIZE_MISMATCH', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { content, sha } = materialFromBytes(bytes);
    const { request } = recordingRequest(() => res(200, blobBody(content, 4, sha))); // size 声明 4，实际 5
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    await expectCode(() => reader.readManifestBlob(FIXED, sha), 'GITHUB_BLOB_SIZE_MISMATCH');
  });

  it('响应 sha 伪称匹配但内容 hash 不同 → HASH_MISMATCH', async () => {
    // content 合法解码，size 自洽，但字节 hash 不等于请求期望。
    const bytes = new Uint8Array([9, 9, 9]);
    const content = Buffer.from(bytes).toString('base64');
    const expected = gitBlobSha(new Uint8Array([1, 1, 1])); // 与 bytes 不同
    const { request } = recordingRequest(() => res(200, blobBody(content, 3, expected)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    await expectCode(() => reader.readManifestBlob(FIXED, expected), 'GITHUB_BLOB_HASH_MISMATCH');
  });
});

// ---------- 5. 严格 base64 ----------
describe('capacity971 组5：严格 base64 唯一表示', () => {
  async function decodeOnly(content: string, size: number, sha: string) {
    const { request } = recordingRequest(() => res(200, blobBody(content, size, sha)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    return reader.readManifestBlob(FIXED, sha);
  }

  it('缺 padding / 中间 padding / 末尾 3 个 = / URL-safe / 空格 tab NBSP BOM → INVALID_BASE64', async () => {
    const one = new Uint8Array([0x66]); // 'f'
    const goodSha = gitBlobSha(one);
    const bad = [
      'Zg',       // 缺 padding
      'Z=g=',     // 中间 padding（独立到四元组门）
      'Z===',     // 末尾 3 个 =（长度 4，独立到 pad>2 门）
      'Z-8=',     // URL-safe
      'Zg ==',    // 空格
      'Zg\t=',    // tab
      'Zg\u00a0=', // NBSP：源码保留反斜杠 u 转义，防不可见字符再次丢失
      '\ufeffZg==', // BOM：源码保留反斜杠 u 转义，防不可见字符再次丢失
    ];
    for (const c of bad) {
      await expectCode(() => decodeOnly(c, 1, goodSha), 'GITHUB_BLOB_INVALID_BASE64');
    }
  });

  it("'Zh==' 虽可能宽松解成同一字节，因重编码不等仍 INVALID_BASE64", async () => {
    const one = new Uint8Array([0x66]);
    const goodSha = gitBlobSha(one);
    await expectCode(() => decodeOnly('Zh==', 1, goodSha), 'GITHUB_BLOB_INVALID_BASE64');
  });

  it("'Zg==' 为单字节 'f' 的规范表示 → 成功", async () => {
    const one = new Uint8Array([0x66]);
    const goodSha = gitBlobSha(one);
    const out = await decodeOnly('Zg==', 1, goodSha);
    expect(Array.from(out.bytes)).toEqual([0x66]);
  });
});

// ---------- 6. SIZE_LIMIT ----------
describe('capacity971 组6：额度门', () => {
  const readerFor = (body: Record<string, unknown>) => {
    const { request } = recordingRequest(() => res(200, body));
    return createGitHubManifestBlobReader({ request, target: FIXED });
  };
  const M = 4 * 1024 * 1024;
  const E = 4 * Math.ceil(M / 3);
  const N = 192 * 1024;
  const C = E + N;

  it('size=M+1 → SIZE_LIMIT', async () => {
    const r = readerFor(blobBody('', M + 1, EXPECTED));
    await expectCode(() => r.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_SIZE_LIMIT');
  });

  it('content 长度=C+1 → SIZE_LIMIT', async () => {
    const r = readerFor(blobBody('A'.repeat(C + 1), 0, EXPECTED));
    await expectCode(() => r.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_SIZE_LIMIT');
  });

  it('CR/LF 计数=N+1（去掉后很短）→ SIZE_LIMIT', async () => {
    const r = readerFor(blobBody('AAAA' + '\n'.repeat(N + 1), 3, EXPECTED));
    await expectCode(() => r.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_SIZE_LIMIT');
  });

  it('规范字符>E → SIZE_LIMIT', async () => {
    const r = readerFor(blobBody('A'.repeat(E + 1), 0, EXPECTED));
    await expectCode(() => r.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_SIZE_LIMIT');
  });

  it('预计 d>M（E 长无 padding）→ SIZE_LIMIT', async () => {
    const r = readerFor(blobBody('A'.repeat(E), 0, EXPECTED)); // d=4194306>M
    await expectCode(() => r.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_SIZE_LIMIT');
  });
});

// ---------- 7. 异常原引用透传 / receiver ----------
describe('capacity971 组7：异常与 receiver', () => {
  it('request 同步抛出/异步拒绝 → 原引用透传、无重试', async () => {
    const boom = new Error('sync-boom');
    let calls = 0;
    const syncThrow: GitHubJsonRequest = () => { calls++; throw boom; };
    const reader = createGitHubManifestBlobReader({ request: syncThrow, target: FIXED });
    await reader.readManifestBlob(FIXED, EXPECTED).then(
      () => { throw new Error('expected throw'); },
      (e: unknown) => { expect(e).toBe(boom); },
    );
    expect(calls).toBe(1);

    const rejectVal = { marker: 'async-boom' };
    let calls2 = 0;
    const asyncReject: GitHubJsonRequest = () => { calls2++; return Promise.reject(rejectVal); };
    const reader2 = createGitHubManifestBlobReader({ request: asyncReject, target: FIXED });
    await reader2.readManifestBlob(FIXED, EXPECTED).then(
      () => { throw new Error('expected throw'); },
      (e: unknown) => { expect(e).toBe(rejectVal); },
    );
    expect(calls2).toBe(1);
  });

  it('json 同步抛出合成对象 → 原引用透传、调用一次、无重试', async () => {
    const jsonSyncBoom = { marker: 'json-sync-boom' };
    let jsonCalls = 0;
    const { request } = recordingRequest(() => ({
      status: 200,
      json(): Promise<unknown> { jsonCalls++; throw jsonSyncBoom; },
    }));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    await reader.readManifestBlob(FIXED, EXPECTED).then(
      () => { throw new Error('expected throw'); },
      (e: unknown) => { expect(e).toBe(jsonSyncBoom); },
    );
    expect(jsonCalls).toBe(1);
  });

  it('json 异步拒绝 → 原引用透传；非 2xx 的 json 根本不被调用', async () => {
    const jsonBoom = new Error('json-boom');
    const { request } = recordingRequest(() => res(200, {}, { jsonReject: jsonBoom }));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    await reader.readManifestBlob(FIXED, EXPECTED).then(
      () => { throw new Error('expected throw'); },
      (e: unknown) => { expect(e).toBe(jsonBoom); },
    );

    let jsonCalls = 0;
    const { request: req2 } = recordingRequest(() => ({
      status: 403,
      json: async () => { jsonCalls++; return {}; },
    }));
    const reader2 = createGitHubManifestBlobReader({ request: req2, target: FIXED });
    await expectCode(() => reader2.readManifestBlob(FIXED, EXPECTED), 'GITHUB_BLOB_HTTP');
    expect(jsonCalls).toBe(0);
  });

  it('json 以原 receiver 调用（this 为信封对象）', async () => {
    const emptySha = gitBlobSha(new Uint8Array(0));
    let seen: unknown = null;
    const envelope: GitHubJsonResponse = {
      status: 200,
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- 测试意图即捕获方法 receiver 以断言 this === envelope
      json(): Promise<unknown> { seen = this; return Promise.resolve({ sha: emptySha, encoding: 'base64', content: '', size: 0 }); },
    };
    const request: GitHubJsonRequest = async () => envelope;
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    await reader.readManifestBlob(FIXED, emptySha);
    expect(seen).toBe(envelope);
  });
});

// ---------- 8. 异步身份快照 / 副本隔离 ----------
describe('capacity971 组8：异步身份快照与副本', () => {
  it('request 悬而未决时改工厂目标/options.request/调用对象 → 本次与后续调用保持原快照', async () => {
    const emptySha = gitBlobSha(new Uint8Array(0));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const routes: string[] = [];
    const request: GitHubJsonRequest = async (route: string) => {
      routes.push(route);
      await gate; // 悬而未决
      return res(200, blobBody('', 0, emptySha));
    };
    let altCalls = 0;
    const altRequest: GitHubJsonRequest = async () => { altCalls++; return res(200, blobBody('', 0, emptySha)); };

    // 独立局部：工厂目标、options、调用目标（不污染共享 FIXED）。
    const factoryTarget: TreeTarget = { ...FIXED };
    const callTarget: TreeTarget = { ...FIXED };
    const options = { request, target: factoryTarget };
    const reader = createGitHubManifestBlobReader(options);
    const pending = reader.readManifestBlob(callTarget, emptySha);
    // 挂起期间篡改工厂目标、options.request 与调用目标。
    factoryTarget.owner = 'hacked';
    factoryTarget.branch = 'hacked';
    options.request = altRequest;
    callTarget.owner = 'hacked';
    callTarget.branch = 'hacked';
    release();
    const out = await pending;
    // 路由在 await 前已定型，未被篡改。
    expect(routes[0]).toBe(`/repos/acme/books/git/blobs/${emptySha}`);
    // 返回身份保持调用前快照。
    expect(out.target.owner).toBe('acme');
    expect(out.target.branch).toBe('main');

    // 以原身份第二次调用：仍走工厂原 request 引用，替代 request 零调用。
    const second = await reader.readManifestBlob({ ...FIXED }, emptySha);
    expect(altCalls).toBe(0);
    expect(routes).toHaveLength(2);
    expect(second.target.owner).toBe('acme');
  });

  it('返回后修改 bytes/target 不影响适配器固定身份或下一次结果', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { content, size, sha } = materialFromBytes(bytes);
    const { request } = recordingRequest(() => res(200, blobBody(content, size, sha)));
    const reader = createGitHubManifestBlobReader({ request, target: FIXED });
    const first = await reader.readManifestBlob(FIXED, sha);
    first.bytes.fill(0);
    first.target.owner = 'mutated';
    const second = await reader.readManifestBlob(FIXED, sha);
    expect(Array.from(second.bytes)).toEqual([1, 2, 3]);
    expect(second.target.owner).toBe('acme');
    expect(first.bytes).not.toBe(second.bytes); // 每次独立副本
  });
});
