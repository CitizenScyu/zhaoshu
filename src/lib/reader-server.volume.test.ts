import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringifyVolumeManifest } from './volume-manifest';
import type { VolumeManifest } from './volume-manifest';
import { MAX_READER_BYTES } from './txt-chapters';
import type { ReadableTask } from './reader-server';

const { getSql, sql, fetchMock } = vi.hoisted(() => ({
  getSql: vi.fn(), sql: vi.fn(), fetchMock: vi.fn<typeof fetch>(),
}));
vi.mock('@/lib/db', () => ({ getSql }));

let server: typeof import('./reader-server');

const OWNER = 'owner';
const REPO = 'repo';
const BRANCH = 'main';
const STEM = 'volbook';
const DIR = `books/${STEM}`;
const ARTIFACT_ID = 7;

function gitBlobSha(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return createHash('sha1').update(`blob ${buf.byteLength}\0`).update(buf).digest('hex');
}

const ARTIFACT = {
  owner: OWNER, repo: REPO, branch: BRANCH,
  canonical_path: `${DIR}/index.json`, blob_sha: 'a'.repeat(40), bytes: 100,
};

/** 构造一份含 2 卷 / 2 章的合法 v2 清单与其卷字节。 */
function fixture() {
  const vol1 = `【第1章 合成】\n\n${'正文一'.repeat(40)}\n`;
  const vol2 = `【第2章 合成】\n\n${'正文二'.repeat(40)}\n`;
  const book = vol1 + vol2;
  const v1Bytes = Buffer.from(vol1, 'utf8');
  const v2Bytes = Buffer.from(vol2, 'utf8');
  const manifest: VolumeManifest = {
    schema: 2, format: 'volumes',
    version: gitBlobSha(book).slice(0, 8), blob_sha: gitBlobSha(book),
    bytes: Buffer.byteLength(book), chars: 400, chapters: 2, chapters_total: 2,
    title: '测试书', author: '作者', generated_at: '2026-09-21T00:00:00.000Z', task_id: 7,
    volumes: [
      { path: `${DIR}/vol-001.txt`, snapshot_path: `books/.snapshots/${STEM}/v-${gitBlobSha(vol1).slice(0, 8)}.txt`,
        blob_sha: gitBlobSha(vol1), bytes: v1Bytes.byteLength, first_byte: 0, last_byte: v1Bytes.byteLength },
      { path: `${DIR}/vol-002.txt`, snapshot_path: `books/.snapshots/${STEM}/v-${gitBlobSha(vol2).slice(0, 8)}.txt`,
        blob_sha: gitBlobSha(vol2), bytes: v2Bytes.byteLength, first_byte: v1Bytes.byteLength, last_byte: v1Bytes.byteLength + v2Bytes.byteLength },
    ],
    chapter_index: [
      { i: 0, t: '【第1章 合成】', v: 0, s: 0, e: v1Bytes.byteLength, p: 1 },
      { i: 1, t: '【第2章 合成】', v: 1, s: v1Bytes.byteLength, e: v1Bytes.byteLength + v2Bytes.byteLength, p: 1 },
    ],
  };
  const task: ReadableTask = { id: 1, title: '测试书', author: '作者', status: 'done', artifact_id: ARTIFACT_ID };
  return { manifest, vol1, vol2, v1Bytes, v2Bytes, task };
}

/** 以 URL 路径末段(百分号编码)为键的资源表,值用工厂每次返回新 Response(可多次取用)。 */
type Resources = Map<string, () => Response>;
function resourceServer(resources: Resources, hit: (name: string) => void): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    const pathname = new URL(url, 'https://api.github.com').pathname;
    const name = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
    hit(name);
    const factory = resources.get(name);
    return factory ? factory() : new Response(null, { status: 404 });
  }) as typeof fetch;
}

function volumeResources(fx: ReturnType<typeof fixture>): Resources {
  return new Map<string, () => Response>([
    ['index.json', () => new Response(stringifyVolumeManifest(fx.manifest))],
    ['vol-001.txt', () => new Response(fx.vol1)],
    ['vol-002.txt', () => new Response(fx.vol2)],
  ]);
}

describe('reader server: v2 分卷(§七)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('GITHUB_TOKEN', 'reader-volume-test-github');
    vi.stubGlobal('fetch', fetchMock);
    getSql.mockReturnValue(sql);
    // locateTaskArtifact 的 SQL 调用返回一条 v2 artifact 行。
    sql.mockResolvedValue([ARTIFACT]);
    server = await import('./reader-server');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('readBookIndex 只取清单 1 次、绝不含任何卷取用;version 用全书 blob_sha、偏移为全书口径', async () => {
    const fx = fixture();
    const hits: string[] = [];
    fetchMock.mockImplementation(resourceServer(volumeResources(fx), name => hits.push(name)));
    const index = await server.readBookIndex(fx.task);
    expect(index.version).toBe(fx.manifest.blob_sha);
    expect(index.totalBytes).toBe(fx.manifest.bytes);
    expect(index.chapters).toEqual([
      { index: 0, title: '【第1章 合成】', startByte: 0, endByte: fx.v1Bytes.byteLength, partCount: 1 },
      { index: 1, title: '【第2章 合成】', startByte: fx.v1Bytes.byteLength, endByte: fx.v1Bytes.byteLength + fx.v2Bytes.byteLength, partCount: 1 },
    ]);
    // 只拉清单,零卷取用。
    expect(hits).toEqual(['index.json']);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/contents/books/volbook/index.json'),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/vnd.github.raw+json' }) }));
  });

  it('readBookPart 只取该章所在的那一卷(另一卷零取用),startByte/endByte 为全书偏移', async () => {
    const fx = fixture();
    const hits: string[] = [];
    fetchMock.mockImplementation(resourceServer(volumeResources(fx), name => hits.push(name)));
    const part = await server.readBookPart(fx.task, 1, 0, fx.manifest.blob_sha);
    expect(part).toMatchObject({
      version: fx.manifest.blob_sha, chapterIndex: 1, partIndex: 0, partCount: 1, title: '【第2章 合成】',
      startByte: fx.v1Bytes.byteLength, endByte: fx.v1Bytes.byteLength + fx.v2Bytes.byteLength,
      text: fx.vol2,
    });
    // 清单 1 次 + 卷 2 一次;卷 1 从未取用。
    expect(hits).toEqual(['index.json', 'vol-002.txt']);
    expect(hits).not.toContain('vol-001.txt');
  });

  it('expectedVersion 与清单 version 不符 → 409(绝不用别的版本字节)', async () => {
    const fx = fixture();
    fetchMock.mockImplementation(resourceServer(volumeResources(fx), () => {}));
    await expect(server.readBookPart(fx.task, 0, 0, 'b'.repeat(40))).rejects.toMatchObject({ status: 409 });
  });

  it('篡改卷:卷字节 gitBlobSha ≠ 清单 blob_sha → 409(重取清单确认版本未变后仍拒)', async () => {
    const fx = fixture();
    const resources = volumeResources(fx);
    resources.set('vol-001.txt', () => new Response('被篡改的卷内容\n')); // sha 不再匹配
    fetchMock.mockImplementation(resourceServer(resources, () => {}));
    await expect(server.readBookPart(fx.task, 0, 0, fx.manifest.blob_sha)).rejects.toMatchObject({ status: 409 });
  });

  it('越界章索引 → 400;越界段索引 → 400', async () => {
    const fx = fixture();
    fetchMock.mockImplementation(resourceServer(volumeResources(fx), () => {}));
    await expect(server.readBookPart(fx.task, 99, 0, fx.manifest.blob_sha)).rejects.toMatchObject({ status: 400 });
    await expect(server.readBookPart(fx.task, 0, 99, fx.manifest.blob_sha)).rejects.toMatchObject({ status: 400 });
  });

  it('坏清单(JSON 不合法)→ 502', async () => {
    const fx = fixture();
    const resources = volumeResources(fx);
    resources.set('index.json', () => new Response('{not json'));
    fetchMock.mockImplementation(resourceServer(resources, () => {}));
    await expect(server.readBookIndex(fx.task)).rejects.toMatchObject({ status: 502 });
  });

  it('清单声明 p 与读端重算段数不一致 → 502(交叉校验)', async () => {
    const fx = fixture();
    // 让第 0 章跨 1 段以上:正文 > 32 KiB 时 p 应为多段;这里谎报 p=1。
    const bigVol1 = `【第1章 合成】\n\n${'正文一'.repeat(60_000)}`; // > 32 KiB,多段
    const v1Bytes = Buffer.from(bigVol1, 'utf8');
    const vol2 = '【第2章 合成】\n\n' + '正文二'.repeat(40) + '\n';
    const v2Bytes = Buffer.from(vol2, 'utf8');
    const book = bigVol1 + vol2;
    const manifest: VolumeManifest = {
      ...fx.manifest,
      blob_sha: gitBlobSha(book), version: gitBlobSha(book).slice(0, 8), bytes: Buffer.byteLength(book),
      volumes: [
        { ...fx.manifest.volumes[0], blob_sha: gitBlobSha(bigVol1), bytes: v1Bytes.byteLength, last_byte: v1Bytes.byteLength },
        { ...fx.manifest.volumes[1], blob_sha: gitBlobSha(vol2), bytes: v2Bytes.byteLength, first_byte: v1Bytes.byteLength, last_byte: v1Bytes.byteLength + v2Bytes.byteLength },
      ],
      chapter_index: [
        { i: 0, t: '【第1章 合成】', v: 0, s: 0, e: v1Bytes.byteLength, p: 1 }, // 谎报:实为多段
        { i: 1, t: '【第2章 合成】', v: 1, s: v1Bytes.byteLength, e: v1Bytes.byteLength + v2Bytes.byteLength, p: 1 },
      ],
    };
    const resources = new Map<string, () => Response>([
      ['index.json', () => new Response(stringifyVolumeManifest(manifest))],
      ['vol-001.txt', () => new Response(bigVol1)],
      ['vol-002.txt', () => new Response(vol2)],
    ]);
    fetchMock.mockImplementation(resourceServer(resources, () => {}));
    await expect(server.readBookPart(fx.task, 0, 0, manifest.blob_sha)).rejects.toMatchObject({ status: 502 });
  });

  it('readerAvailability:v2 = 清单可取且可解析 → true(无大小门槛);清单 404 → false', async () => {
    const fx = fixture();
    fetchMock.mockImplementation(resourceServer(volumeResources(fx), () => {}));
    await expect(server.readerAvailability(fx.task)).resolves.toEqual({ available: true });

    // 换仓库 ⇒ 缓存键不同,强制走真实拉取;清单不在 → 404 → available false。
    sql.mockResolvedValue([{ ...ARTIFACT, repo: 'missing-repo' }]);
    const missing = new Map<string, () => Response>();
    fetchMock.mockImplementation(resourceServer(missing, () => {}));
    await expect(server.readerAvailability(fx.task)).resolves.toEqual({ available: false });
  });

  it('清单 Σvolumes.bytes 与全书 bytes 不符 → 502(绝不猜)', async () => {
    const fx = fixture();
    // 篡改清单:把声明 bytes 改大,卷偏移不再首尾相接/求和不等 ⇒ parseVolumeManifest 返回 null
    const bad = { ...fx.manifest, bytes: fx.manifest.bytes + 1 };
    const resources = volumeResources(fx);
    resources.set('index.json', () => new Response(stringifyVolumeManifest(bad)));
    fetchMock.mockImplementation(resourceServer(resources, () => {}));
    await expect(server.readBookIndex(fx.task)).rejects.toMatchObject({ status: 502 });
  });

  it('清单某卷 bytes > 16 MiB 硬上限 → 502(防被篡改清单拉超大「卷」)', async () => {
    const fx = fixture();
    const bad = {
      ...fx.manifest,
      volumes: [
        { ...fx.manifest.volumes[0], bytes: MAX_READER_BYTES + 1, last_byte: MAX_READER_BYTES + 1 },
        { ...fx.manifest.volumes[1], first_byte: MAX_READER_BYTES + 1, last_byte: MAX_READER_BYTES + 1 + fx.v2Bytes.byteLength },
      ],
      bytes: MAX_READER_BYTES + 1 + fx.v2Bytes.byteLength,
      chapter_index: [
        { i: 0, t: '【第1章 合成】', v: 0, s: 0, e: fx.v1Bytes.byteLength, p: 1 },
        { i: 1, t: '【第2章 合成】', v: 1, s: MAX_READER_BYTES + 1, e: MAX_READER_BYTES + 1 + fx.v2Bytes.byteLength, p: 1 },
      ],
    };
    const resources = volumeResources(fx);
    resources.set('index.json', () => new Response(stringifyVolumeManifest(bad)));
    fetchMock.mockImplementation(resourceServer(resources, () => {}));
    await expect(server.readBookIndex(fx.task)).rejects.toMatchObject({ status: 502 });
  });

  it('chapter_index 章终点越界(e > bytes)→ 502;章起点不在其卷区间 → 502', async () => {
    const fx = fixture();
    // e 越界
    const outOfRange = {
      ...fx.manifest,
      chapter_index: [
        fx.manifest.chapter_index[0],
        { ...fx.manifest.chapter_index[1], e: fx.manifest.bytes + 100 },
      ],
    };
    const r1 = volumeResources(fx);
    r1.set('index.json', () => new Response(stringifyVolumeManifest(outOfRange)));
    fetchMock.mockImplementation(resourceServer(r1, () => {}));
    await expect(server.readBookIndex(fx.task)).rejects.toMatchObject({ status: 502 });

    // 章起点 s 落在第 0 卷区间之外(谎报 v=0,但 s 在第 1 卷)
    const wrongVolume = {
      ...fx.manifest,
      chapter_index: [
        fx.manifest.chapter_index[0],
        { ...fx.manifest.chapter_index[1], v: 0 },
      ],
    };
    const r2 = volumeResources(fx);
    r2.set('index.json', () => new Response(stringifyVolumeManifest(wrongVolume)));
    fetchMock.mockImplementation(resourceServer(r2, () => {}));
    await expect(server.readBookIndex(fx.task)).rejects.toMatchObject({ status: 502 });
  });

  it('卷缓存:同章重复读只拉一次卷;清单 5 分钟内复用', async () => {
    const fx = fixture();
    const hits: string[] = [];
    fetchMock.mockImplementation(resourceServer(volumeResources(fx), name => hits.push(name)));
    await server.readBookPart(fx.task, 0, 0, fx.manifest.blob_sha);
    await server.readBookPart(fx.task, 0, 0, fx.manifest.blob_sha);
    expect(hits).toEqual(['index.json', 'vol-001.txt']); // 第二读全命中缓存
  });

  it('清单 raw 上限 4 MiB:声称超限的清单体 → 413(不缓冲整包)', async () => {
    const fx = fixture();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel }, { highWaterMark: 0 });
    fetchMock.mockImplementation((async () => new Response(body, { headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) } })) as typeof fetch);
    await expect(server.readBookIndex(fx.task)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('旧单文件产物(非 index.json)不回归:仍走目录 + 单文件分支', async () => {
    // artifact canonical_path 不是清单 ⇒ 旧路径。这里仅验证分流:清单路径判定为 false 时不应请求 index.json。
    const hits: string[] = [];
    sql.mockResolvedValue([{ owner: OWNER, repo: REPO, branch: BRANCH,
      canonical_path: `${DIR}/legacy.txt`, blob_sha: gitBlobSha('第一章 正文\n'), bytes: 20 }]);
    const resources = new Map<string, () => Response>([
      ['legacy.txt', () => new Response('第一章 正文\n')],
    ]);
    fetchMock.mockImplementation(resourceServer(resources, name => hits.push(name)));
    const task: ReadableTask = { id: 1, title: '测试书', author: '作者', status: 'done', artifact_id: ARTIFACT_ID };
    const index = await server.readBookIndex(task);
    expect(index.chapters).toHaveLength(1);
    expect(hits).toEqual(['legacy.txt']);
    expect(hits).not.toContain('index.json');
    void MAX_READER_BYTES;
  });
});
