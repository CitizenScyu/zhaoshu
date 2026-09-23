// 41-MANIFESTFIX:v2 清单的 chapter_index 必须与 chapters 逐章对应(读端 parseVolumeManifest 的完整性闸门)。
// 端到端走真实引擎 downloadBook(builtin 分支,离线合成页面)→ createEngineAdapter → runDownloadTask /
// publishBookVersion,再用读端同一个 parseVolumeManifest 解析落下的清单。源站目录标题故意不规整
// (「13.第13章」「30.第30章 上架感言！」「完本感言」),第二章正文里还夹一行像标题的句子「第二十章 回忆」——
// 按标题二次解析会并章又拆章,章数与引擎对不上;只有用引擎拼接时的真实边界才对得上(生产 1038 同型)。
// 不联网:fetch 被桩成抛错,页面全部由合成 transport 返回。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from './rule-engine/api';
import * as compile from './rule-engine/compile';
import * as parser from './source-parser';
import { downloadBook } from '../../scripts/engine-download.mjs';
import { readBookText } from '../../runtime-download/read-book-text';
import {
  createEngineAdapter, runDownloadTask, type AdapterOutcome, type EngineDownloadLike, type TaskRow, type WorkerStorage,
} from './download-worker';
import { publishBookVersion, snapshotPaths, type GitHubContents } from './download-publisher';
import { parseVolumeManifest, type VolumeManifest } from './volume-manifest';
import { MAX_READER_BYTES, splitChapterParts } from './txt-chapters';

const TITLE = '测试书';
const AUTHOR = '作者甲';
const BOOK_URL = 'https://book15.net/books/details1.html';

// 阅读端 parseTxtChapters 认得出的只有 序章/第一章/第二章/第14章/番外一 这 5 个;另外 3 个认不出(并章),
// 第二章正文里的「第二十章 回忆」又会被认成标题(拆章)⇒ 二次解析得 6 章,引擎是 8 章。
const CHAPTERS: { title: string; paragraphs: string[] }[] = [
  { title: '序章', paragraphs: ['序章正文第一段。', '第二段含表情😀与扩展区汉字𠀀。'] },
  { title: '第一章 开端', paragraphs: ['开端正文。', '第1段不是标题。'] },
  { title: '第二章', paragraphs: ['回忆之前。', '第二十章 回忆', '回忆之后。'] },
  { title: '13.第13章', paragraphs: ['十三章正文。'] },
  { title: '第14章 转折', paragraphs: ['转折正文。', '另一段。'] },
  { title: '30.第30章 上架感言！', paragraphs: ['感谢订阅。'] },
  { title: '番外一 月下', paragraphs: ['番外正文。'] },
  { title: '完本感言', paragraphs: ['完结撒花。', '江湖再见。'] },
];

/** 引擎拼整本的段形态(engine-download.mjs:`${title}\n\n${正文}\n\n`),正文 = 各段以 \n 相接。 */
const segment = (index: number) => `${CHAPTERS[index].title}\n\n${CHAPTERS[index].paragraphs.join('\n')}\n\n`;

const identity = `<h1>${TITLE}</h1><meta property="og:novel:book_name" content="${TITLE}">`
  + `<meta property="og:novel:author" content="${AUTHOR}">`;
const catalog = CHAPTERS.map((chapter, index) => `<dd><a href="/chapter/index1-${index + 1}.html">${chapter.title}</a></dd>`).join('');

async function transport(url: string, options: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) {
  await options.beforeRequest?.(options.signal);
  if (url.includes('/search')) return { url, text: `<a href="${BOOK_URL}">${TITLE}</a>` };
  if (url === BOOK_URL) return { url, text: identity + catalog };
  const matched = /\/chapter\/index1-(\d+)\.html$/.exec(url);
  if (matched) {
    const chapter = CHAPTERS[Number(matched[1]) - 1];
    return { url, text: `<li class="chapter-content" id="article-content">${chapter.paragraphs.map((p) => `<p>${p}</p>`).join('')}</li>` };
  }
  throw new Error(`unexpected url ${url}`);
}

const source = { url: 'https://book15.net/', name: 'synthetic', searchUrl: '/search?q={{key}}', rules: {} };
const task: TaskRow = {
  id: 15, book_id: 1038, title: TITLE, author: AUTHOR, status: 'running',
  source_url: BOOK_URL, source_kind: 'builtin', source_id: null, requested_by: 'user',
};
const lease = { id: task.id, leaseGeneration: 1, leaseOwner: 'test', attemptCount: 0 };

class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function engineAdapter() {
  vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
  const outRoot = mkdtempSync(join(tmpdir(), 'manifestfix-'));
  dirs.push(outRoot);
  return createEngineAdapter({
    downloadBook: downloadBook as unknown as EngineDownloadLike,
    modules: { api, compile, parser },
    resolveSource: async () => ({ source, builtin: true }),
    transport,
    readBookText,
    outRoot,
    rateMs: 0,
    timeoutMs: 5_000,
    sourceKind: 'builtin',
  });
}

function memoryStorage() {
  const state: { finished?: { status: string; error?: string }; deferred?: { delayMs: number; error?: string } } = {};
  const storage: WorkerStorage = {
    claim: async () => null,
    taskRow: async () => task,
    heartbeat: async () => true,
    progress: async () => true,
    finish: async (_lease, result) => { state.finished = result; return true; },
    // 合成书源永远可达,不该走到退避放回(41-EXEC-SRCUNAVAIL 的 defer);真走到就记下来,由用例①断言兜住。
    defer: async (_lease, input) => { state.deferred = input; return '2026-09-24T03:15:00.000Z'; },
    reserveArtifactPath: async () => 7,
    registerArtifact: async () => true,
  };
  return { storage, state };
}

/** 读端口径取清单:与 reader-server / download file 路由同一个 parseVolumeManifest。 */
function readManifest(github: MemoryGitHub): VolumeManifest | null {
  const text = github.files.get(snapshotPaths(TITLE, AUTHOR).canonicalPath);
  if (text === undefined) throw new Error('canonical manifest not published');
  return parseVolumeManifest(Buffer.from(text, 'utf8'));
}

/** 按清单顺序拼回各卷(下载端 volumeConcatStream 同口径)。 */
function concatVolumes(github: MemoryGitHub, manifest: VolumeManifest): Buffer {
  return Buffer.concat(manifest.volumes.map((volume) => Buffer.from(github.files.get(volume.path) ?? '', 'utf8')));
}

describe('v2 清单 chapter_index 用引擎章节边界(41-MANIFESTFIX)', () => {
  it('① 不规整标题 + 正文夹像标题的句子:清单 chapter_index.length === chapters === 引擎章数,读端 round-trip 通过', async () => {
    const github = new MemoryGitHub();
    const { storage, state } = memoryStorage();
    const result = await runDownloadTask({ storage, github, adapters: [engineAdapter()], repositoryId: 1, branch: 'main' }, lease);
    expect(result).toMatchObject({ processed: true, terminal: 'done' });
    expect(state.finished).toEqual({ status: 'done', error: '' });
    expect(state.deferred).toBeUndefined();

    const manifest = readManifest(github);
    expect(manifest, '读端 parseVolumeManifest 拒收 = 生产读回 502「无效的章节目录」').not.toBeNull();
    expect(manifest!.chapters).toBe(CHAPTERS.length);
    expect(manifest!.chapter_index).toHaveLength(CHAPTERS.length);
    expect(manifest!.chapter_index.map((entry) => entry.t)).toEqual(CHAPTERS.map((chapter) => chapter.title));
  });

  it('② 按索引切出的字节与引擎原章节逐字节相等(不并章、不拆章),首行 trim 后即章名', async () => {
    const github = new MemoryGitHub();
    const { storage } = memoryStorage();
    await runDownloadTask({ storage, github, adapters: [engineAdapter()], repositoryId: 1, branch: 'main' }, lease);
    const manifest = readManifest(github);
    expect(manifest).not.toBeNull();
    const book = concatVolumes(github, manifest!);
    expect(book.toString('utf8')).toBe(CHAPTERS.map((_, index) => segment(index)).join(''));
    for (const entry of manifest!.chapter_index) {
      const text = book.toString('utf8', entry.s, entry.e);
      expect(text).toBe(segment(entry.i));
      // ReaderClient 按「首行 trim 后等于章名」去掉重复标题行,章名必须就是该段首行。
      expect(text.split('\n')[0].trim()).toBe(entry.t);
    }
    // 重点抽查:二次解析会并掉的「13.第13章」「完本感言」、会被拆开的第二章都各自成章。
    for (const title of ['13.第13章', '完本感言', '第二章']) {
      const entry = manifest!.chapter_index.find((item) => item.t === title);
      expect(entry, title).toBeDefined();
      expect(book.toString('utf8', entry!.s, entry!.e)).toBe(segment(entry!.i));
    }
  });

  it('③ 多卷下卷间索引连续:每章按卷拼回逐字节相等,读端重算段数与清单 p 一致', async () => {
    const outcome = await engineAdapter().download(task, { signal: new AbortController().signal, progress: async () => {} });
    expect(outcome.kind).toBe('complete');
    const complete = outcome as Extract<AdapterOutcome, { kind: 'complete' }>;
    const github = new MemoryGitHub();
    await publishBookVersion(github, { check: async () => {} }, {
      taskId: task.id, title: TITLE, author: AUTHOR, txt: complete.txt,
      chaptersDone: complete.chaptersDone, chaptersTotal: complete.chaptersTotal, charsTotal: complete.charsTotal,
      chapterRanges: complete.chapterRanges,
    }, { maxVolumeBytes: 160 });
    const manifest = readManifest(github);
    expect(manifest).not.toBeNull();
    expect(manifest!.volumes.length).toBeGreaterThanOrEqual(2);
    expect(manifest!.chapter_index).toHaveLength(CHAPTERS.length);

    let previousVolume = 0;
    for (const [position, entry] of manifest!.chapter_index.entries()) {
      expect(entry.i).toBe(position);
      expect(entry.v).toBeGreaterThanOrEqual(previousVolume);
      previousVolume = entry.v;
      const home = manifest!.volumes[entry.v];
      expect(entry.s).toBeGreaterThanOrEqual(home.first_byte);
      expect(entry.s).toBeLessThan(home.last_byte);
      // 读端 readRange 同口径:遍历与 [s,e) 重叠的卷,按卷内偏移切片后拼接。
      const chunks = manifest!.volumes
        .filter((volume) => volume.last_byte > entry.s && volume.first_byte < entry.e)
        .map((volume) => Buffer.from(github.files.get(volume.path) ?? '', 'utf8')
          .subarray(Math.max(entry.s, volume.first_byte) - volume.first_byte, Math.min(entry.e, volume.last_byte) - volume.first_byte));
      const chapterBytes = Buffer.concat(chunks);
      expect(chapterBytes.toString('utf8')).toBe(segment(entry.i));
      // 读端 chapterParts:只拿本章字节重算段数,必须与清单 p 相等(否则读端 502)。
      const parts = splitChapterParts(chapterBytes, { startByte: 0, endByte: chapterBytes.byteLength },
        undefined, Math.max(chapterBytes.byteLength, MAX_READER_BYTES));
      expect(parts.length).toBe(entry.p);
    }
  });
});
