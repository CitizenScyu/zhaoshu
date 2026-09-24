// gcls-41:快照 GC 只读存储 + dry-run 汇总 + CLI。用发布器真实落版本进内存,再经一个忠实复刻
// GitHub 语义的合成 fetch(Trees API 列目录带 blob size、contents raw 读、路径百分号解码、速率限制头)
// 端到端跑 createSnapshotGcStore → runSnapshotGcDryRun。不联网、不碰真实存储。
import { describe, expect, it, vi } from 'vitest';
import { publishBookVersion, snapshotPaths, type GitHubContents } from '../src/lib/download-publisher';
import { createSnapshotGcStore } from './snapshot-gc-store';
import { runSnapshotGcDryRun } from './snapshot-gc-dry-run';
import { main, parseCliArgs, readEnvKeys } from './snapshot-gc-cli';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'ghp_SECRET_TOKEN_should_never_surface';
const REPO = 'zhaoshu-owner/novel-store';
const DAY = 24 * 60 * 60_000;
const LATER = Date.now() + 30 * DAY;
const guardOk = { check: async () => {} };

/** 发布器写入的内存仓:键是发布器用的(百分号编码)路径。 */
class PublishStore implements GitHubContents {
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

function book(bodies: string[]): string {
  const lines: string[] = [];
  bodies.forEach((body, i) => lines.push(`【第${i + 1}章 合成】`, '', body.repeat(1200)));
  return lines.join('\n');
}

async function publish(store: PublishStore, title: string, bodies: string[], taskId: number) {
  const result = await publishBookVersion(store, guardOk, {
    taskId, title, author: '佚名', txt: book(bodies),
    chaptersDone: bodies.length, chaptersTotal: bodies.length, charsTotal: bodies.length * 2400,
  }, { maxVolumeBytes: 3000 });
  if (!result.promoted) throw new Error('fixture must promote');
  return result.version;
}

interface Call { method: string; url: string; auth: string | null; accept: string | null }

/**
 * 合成 GitHub:仓内文件按**解码后**的真实路径存(GitHub 会解码 URL 里的百分号),
 * 支持 `git/trees/<branch>:<dir>`(非递归,带 blob size)与 `contents/<path>?ref=`(raw)。
 */
function fakeGitHub(published: Map<string, string>, options: { rateRemaining?: () => number; fail?: (path: string) => number | null; truncate?: (dir: string) => boolean } = {}) {
  const repo = new Map<string, Buffer>();
  for (const [path, text] of published) repo.set(decodeURIComponent(path), Buffer.from(text, 'utf8'));
  const calls: Call[] = [];
  const base = `https://api.github.com/repos/${REPO}`;
  const headers = () => ({ 'x-ratelimit-remaining': String(options.rateRemaining?.() ?? 4999), 'x-ratelimit-reset': '1790000000' });
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const h = new Headers(init.headers);
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), url, auth: h.get('authorization'), accept: h.get('accept') });
    if (url.startsWith(`${base}/git/trees/`)) {
      const spec = decodeURIComponent(url.slice(`${base}/git/trees/`.length));
      const dir = spec.slice(spec.indexOf(':') + 1);
      const failed = options.fail?.(dir);
      if (failed) return new Response('{"message":"upstream echo with secret"}', { status: failed, headers: headers() });
      const prefix = `${dir}/`;
      const entries = new Map<string, { path: string; type: string; size?: number }>();
      for (const [path, bytes] of repo) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.set(rest, { path: rest, type: 'blob', size: bytes.byteLength });
        else entries.set(rest.slice(0, slash), { path: rest.slice(0, slash), type: 'tree' });
      }
      if (entries.size === 0) return new Response('{"message":"Not Found"}', { status: 404, headers: headers() });
      return new Response(JSON.stringify({ sha: 'x', tree: [...entries.values()], truncated: options.truncate?.(dir) ?? false }), { status: 200, headers: headers() });
    }
    if (url.startsWith(`${base}/contents/`)) {
      const [rawPath, query] = url.slice(`${base}/contents/`.length).split('?');
      const path = decodeURIComponent(rawPath!);
      expect(query).toBe('ref=main');
      const failed = options.fail?.(path);
      if (failed) return new Response('upstream echo', { status: failed, headers: headers() });
      const bytes = repo.get(path);
      return bytes ? new Response(new Uint8Array(bytes), { status: 200, headers: headers() }) : new Response('{"message":"Not Found"}', { status: 404, headers: headers() });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { impl, calls, repo };
}

/** 四本书 + 一个旧单文件目录:普通(共享+孤儿)、清单缺失、只有两版(上一版引用)、无分卷。 */
async function fixture() {
  const store = new PublishStore();
  const normal = snapshotPaths('普通书', '佚名');
  await publish(store, '普通书', ['甲', '乙', '丙'], 1);
  await publish(store, '普通书', ['甲', '乙', '丁'], 2);
  await publish(store, '普通书', ['甲', '戊', '丁'], 3);
  store.files.set(`${normal.dir}/v-deadbeef.txt`, '残卷残卷'); // 12 字节,无任何清单引用

  const broken = snapshotPaths('缺清单书', '佚名');
  const brokenA = await publish(store, '缺清单书', ['子', '丑'], 4);
  await publish(store, '缺清单书', ['子', '寅'], 5);
  await publish(store, '缺清单书', ['卯', '寅'], 6);
  store.files.delete(`${broken.dir}/${brokenA}.json`); // 清单文件整体缺失

  await publish(store, '两版书', ['天', '地'], 7);
  await publish(store, '两版书', ['天', '玄'], 8);

  const legacy = snapshotPaths('旧书', '佚名');
  store.files.set(`${legacy.dir}/0badf00d.txt`, '旧整本快照');
  return { store, normal };
}

const stemOf = (title: string) => snapshotPaths(title, '佚名').dir.split('/').pop()!;

describe('gcls-41 快照 GC 只读 GitHub 存储', () => {
  it('列根目录得到编码 stem;列书目录只要 blob 名并记下大小;只发带鉴权的 GET', async () => {
    const { store } = await fixture();
    const dir = snapshotPaths('普通书', '佚名').dir;
    store.files.set('books/.snapshots/README.md', '根目录散文件不是书目录');
    store.files.set(`${dir}/nested/v-00000000.txt`, '子目录里的文件不属于本层');
    const gh = fakeGitHub(store.files);
    const gc = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: gh.impl });
    const stems = await gc.listStems();
    expect(stems.sort()).toEqual(['普通书', '缺清单书', '两版书', '旧书'].map(stemOf).sort());
    const files = await gc.listFiles(dir);
    expect(files).toContain('current.json');
    expect(files).toContain('v-deadbeef.txt');
    expect(files).not.toContain('nested');
    expect(gc.sizeOf(`${dir}/v-deadbeef.txt`)).toBe(Buffer.byteLength('残卷残卷'));
    expect(await gc.listFiles('books/.snapshots/nope')).toEqual([]);
    expect(gh.calls.every(call => call.method === 'GET' && call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(gc.rateLimit()).toEqual({ remaining: 4999, resetAt: 1790000000 * 1000 });
  });

  it('书名含保留字符(%)的 stem 可列目录:必须用 <branch>:<已编码 dir> 形,整段编码(N1 式)会双重编码 404', async () => {
    const store = new PublishStore();
    const pct = snapshotPaths('100%纯度', '佚名');
    await publish(store, '100%纯度', ['甲', '乙'], 21);
    store.files.set(`${pct.dir}/v-deadbeef.txt`, '残卷');
    const gh = fakeGitHub(store.files);
    const gc = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: gh.impl });
    expect(await gc.listStems()).toContain(pct.dir.split('/').pop());
    const files = await gc.listFiles(pct.dir);
    expect(files).toContain('current.json');
    expect(files).toContain('v-deadbeef.txt');
    // 真实 api.github.com 的对照(一手实测):`main:books%2F...`,即分支冒号与目录斜杠原样、stem 保持发布器口径的 %XX;
    // 整段 encodeURIComponent(`${branch}:${dir}`) 会把 %25 变 %2525(a%2525),对真实 GitHub 返回 404。
    const treeCall = gh.calls.find(call => call.url.includes('/git/trees/') && call.url.includes('100%25'))!;
    expect(treeCall.url).toContain('/git/trees/main:books/.snapshots/100%25%E7%BA%AF');
    expect(treeCall.url).toContain('%25'); // stem 里的 % 仍是单层 %25,不是 %2525
    expect(treeCall.url).not.toContain('main%3A');
  });

  it('tree 截断 ⇒ 抛错(不拿半截列表判孤儿);非 2xx 只带状态码,不透传响应体/token', async () => {
    const { store, normal } = await fixture();
    const truncated = fakeGitHub(store.files, { truncate: dir => dir === decodeURIComponent(normal.dir) });
    const gc1 = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: truncated.impl });
    await expect(gc1.listFiles(normal.dir)).rejects.toThrow('github_tree_truncated');
    const failing = fakeGitHub(store.files, { fail: () => 502 });
    const gc2 = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: failing.impl });
    const error = await gc2.listFiles(normal.dir).catch((e: Error) => e);
    expect(String((error as Error).message)).toBe('github_http_502');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('deleteFile 恒拒绝且不发任何请求', async () => {
    const gh = fakeGitHub(new Map());
    const gc = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: gh.impl });
    await expect(gc.deleteFile('books/.snapshots/x/v-00000000.txt')).rejects.toThrow('read-only');
    expect(gh.calls).toEqual([]);
  });
});

describe('gcls-41 dry-run 汇总(端到端经只读存储)', () => {
  it('逐书:普通书列出孤儿与字节、共享卷保留;缺清单书整本跳过;两版书无孤儿;旧书无卷', async () => {
    const { store, normal } = await fixture();
    const gh = fakeGitHub(store.files);
    const gc = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: gh.impl });
    const { rows, summary } = await runSnapshotGcDryRun(gc, { now: LATER });
    const normalRow = rows.find(row => row.stem === stemOf('普通书'))!;
    expect(normalRow.name).toBe(decodeURIComponent(stemOf('普通书')));
    expect(normalRow).toMatchObject({ volumes: 6, referenced: 4, orphans: 2, skipped: null, unsizedOrphans: 0 });
    const orphanBytes = normalRow.sample.reduce((sum, path) => sum + gh.repo.get(decodeURIComponent(path))!.byteLength, 0);
    expect(normalRow.orphanBytes).toBe(orphanBytes);
    expect(normalRow.sample).toContain(`${normal.dir}/v-deadbeef.txt`);

    const brokenRow = rows.find(row => row.stem === stemOf('缺清单书'))!;
    expect(brokenRow).toMatchObject({ skipped: 'missing_manifest', orphans: 0, orphanBytes: 0, volumes: 4 });
    expect(rows.find(row => row.stem === stemOf('两版书'))).toMatchObject({ skipped: null, orphans: 0, volumes: 3, referenced: 3 });
    expect(rows.find(row => row.stem === stemOf('旧书'))).toMatchObject({ skipped: null, orphans: 0, volumes: 0 });

    expect(summary).toMatchObject({
      booksListed: 4, booksScanned: 4, booksWithVolumes: 3, volumes: 13, referenced: 7,
      orphans: 2, orphanBytes, booksWithOrphans: 1, skipped: { missing_manifest: 1 }, stoppedEarly: null,
    });
    expect(gh.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('读取失败的书计 store_error 跳过,其余书照常', async () => {
    const { store } = await fixture();
    const target = decodeURIComponent(`books/${stemOf('两版书')}/index.json`);
    const gh = fakeGitHub(store.files, { fail: path => (path === target ? 503 : null) });
    const gc = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: gh.impl });
    const { rows, summary } = await runSnapshotGcDryRun(gc, { now: LATER });
    expect(rows.find(row => row.stem === stemOf('两版书'))).toMatchObject({ skipped: 'store_error', detail: 'github_http_503' });
    expect(summary.skipped).toEqual({ missing_manifest: 1, store_error: 1 });
    expect(summary.orphans).toBe(2);
  });

  it('limit/offset 限量;速率限制余量不足就提前停', async () => {
    const { store } = await fixture();
    let remaining = 5000;
    const gh = fakeGitHub(store.files, { rateRemaining: () => (remaining -= 1) });
    const gc = createSnapshotGcStore({ token: TOKEN, repository: REPO, branch: 'main', fetchImpl: gh.impl });
    const limited = await runSnapshotGcDryRun(gc, { now: LATER, offset: 1, limit: 2 });
    expect(limited.summary).toMatchObject({ booksListed: 4, booksScanned: 2 });
    remaining = 10;
    const stopped = await runSnapshotGcDryRun(gc, { now: LATER, minRateRemaining: 100 });
    expect(stopped.summary.booksScanned).toBe(0);
    expect(stopped.summary.stoppedEarly).toMatch(/^rate_limit_remaining=\d+ < 100$/);
  });
});

describe('gcls-41 dry-run CLI', () => {
  it('输出逐书行 + 汇总行,且不含 token', async () => {
    const { store } = await fixture();
    const gh = fakeGitHub(store.files);
    vi.stubGlobal('fetch', gh.impl);
    const lines: string[] = [];
    try {
      const code = await main([], { env: { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO, DOWNLOAD_TARGET_BRANCH: 'main' }, write: line => lines.push(line) });
      expect(code).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    const out = lines.join('\n');
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(`target=${REPO}@main`);
    // CLI 用真实时钟:三份清单都在 7 天保护窗内 ⇒ A 也存活,只剩无引用残卷 v-deadbeef(12 字节)是孤儿。
    expect(out).toMatch(/普通书[^\n]*\t卷=6 引用=5 孤儿=1 孤儿字节=12\n/);
    expect(out).toMatch(/缺清单书[^\n]*跳过=missing_manifest/);
    expect(out).toMatch(/# 汇总 书目录=4 本次扫描=4 有快照卷=3 快照卷=13 被引用=8 孤儿=1 孤儿字节=12 有孤儿的书=1 跳过=missing_manifest:1/);
    expect(gh.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('缺凭据只报键名;参数校验', async () => {
    await expect(main([], { env: {}, write: () => {} })).rejects.toThrow('missing environment key: GITHUB_TOKEN');
    expect(parseCliArgs(['--limit', '20', '--stem', 'a', '--stem', 'b'])).toMatchObject({ limit: 20, stems: ['a', 'b'] });
    expect(() => parseCliArgs(['--limit', '-1'])).toThrow('非负整数');
    expect(() => parseCliArgs(['--execute'])).toThrow('未知参数');
  });

  it('--env-file 只取白名单键(其它键不进结果),重复键后值生效,剥引号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcls41-'));
    const path = join(dir, 'env');
    writeFileSync(path, [
      'DATABASE_URL=postgresql://user:pw@host/db',
      `GITHUB_TOKEN="${TOKEN}"`,
      '# comment',
      `GITHUB_REPOSITORY=${REPO}`,
      'DOWNLOAD_TARGET_BRANCH=dev',
      'DOWNLOAD_TARGET_BRANCH=main',
      'LLM_API_KEY=sk-should-not-load',
    ].join('\n'));
    const keys = await readEnvKeys(path);
    expect(keys).toEqual({ GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO, DOWNLOAD_TARGET_BRANCH: 'main' });
  });
});
