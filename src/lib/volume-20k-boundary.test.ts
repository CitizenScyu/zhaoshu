// 分卷 v2 边界:2 万章 × 长转义标题的清单 raw 字节是否顶穿读端 4 MiB 门(MAX_INDEX_JSON_BYTES)。
//
// 结论:**P1 真 bug,已修**。发布侧原本无任何清单/索引字节门,2 万章 × 长标题会 splitBookVolumes
// 成功落地 index.json,读端 readBookIndex 却因 ReaderIndex > 4 MiB 抛 422 —— 「能发布读不了」。
//
// 关键:读端每章行(键名 index/title/startByte/endByte/partCount)比清单每章行(i/t/v/s/e/p)更长,
// 存在「清单 < 4 MiB 但读端索引 > 4 MiB」的窗口。故发布侧门必须按**读端会看到的索引字节**判
// (download-publisher.readerIndexBytes),不能按清单自身字节,否则漏掉该窗口。
//
// 实测(pad=44,2 万章,正文每章 200 字):stringifyVolumeManifest ≈ 3.797 MiB(< 读端清单门 4 MiB
// ⇒ 未修时读端 readManifest 不拒、能发布),读端 ReaderIndex ≈ 4.255 MiB(> 4 MiB ⇒ readBookIndex 422)。
//
// 本文件:护栏(短标题两侧在门内)+ 缺口成因证明 + 修法护栏(发布即拒)+ 修法不误伤(短标题仍 promoted)。
import { describe, expect, it } from 'vitest';
import {
  publishBookVersion, snapshotPaths, readerIndexBytes, gitBlobSha, MAX_READER_INDEX_BYTES,
  type GitHubContents,
} from './download-publisher';
import { parseVolumeManifest } from './volume-manifest';
import type { VolumeChapterEntry } from './volume-manifest';
import { parseTxtChapters } from './txt-chapters';

const guardOk = { check: async () => {} };
const TITLE = '边界书';
const AUTHOR = '佚名';
const N = 20_000;
/** 读端 MAX_INDEX_JSON_BYTES / MAX_MANIFEST_BYTES,同值 4 MiB(reader-server.ts)。 */
const READER_INDEX_GATE = 4 * 1024 * 1024;
/** 40 hex 占位(version/blob_sha 长度量级);真实发布侧用全书 gitBlobSha。 */
const VERSION40 = '0'.repeat(40);
/** readerIndexBytes 的固定 wrapper(与发布侧写入清单的 taskId/title/author 对齐)。 */
const testWrapper = { taskId: 7, title: TITLE, author: AUTHOR, version: VERSION40, totalBytes: 0 };

/** 最小内存 GitHub(绝不联网):put 落 map,getBytes 从未落盘的路径返回 null。 */
class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

/**
 * 构造 N 章 × 指定标题的书。标题形如 `第{i+1}章 {CJK×pad}`(带空格分隔 ⇒ 被 parseTxtChapters
 * 识别为章,标题逐字回读);纯 CJK 或带反斜杠的后缀会把 JSON 单章行撑大,逼近两侧字节门。
 * 每章正文刻意 < 32 KiB ⇒ 每章 partCount 恒 1(段数不进本边界判据)。
 */
function bookText(pad: number, n = N, bodyChars = 200): string {
  // 无书头前缀:否则首个标题前的「书/作者」会被当成 前言 多生成一章 ⇒ 20001 章顶 MAX_READER_CHAPTERS。
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`第${i + 1}章 ${'风'.repeat(pad)}`, '', '正文'.repeat(bodyChars));
  return lines.join('\n');
}

/** 读端 readBookIndex(清单分支)的等价映射:只取清单,把 chapter_index 翻成 ReaderChapter。 */
function readerIndexFromManifest(manifest: NonNullable<ReturnType<typeof parseVolumeManifest>>) {
  return {
    taskId: 7, title: TITLE, author: AUTHOR,
    version: manifest.blob_sha, totalBytes: manifest.bytes,
    chapters: manifest.chapter_index.map(entry => ({
      index: entry.i, title: entry.t, startByte: entry.s, endByte: entry.e, partCount: entry.p,
    })),
  };
}

/**
 * 真实读端字节(读端 readBookIndex 清单分支同口径):用整本书 txt 算出 blob_sha 与 bytes,
 * 组装 **ReaderIndex 整体** 后一次 stringify —— 与 reader-server.ts:469-486 逐字节等价
 * (包含顶层包裹、每章键名/键序、数组分隔逗号)。**刻意不复用** readerIndexBytes,
 * 用来独立对拍:readerIndexBytes 与其比较,低估会在此露馅。
 */
function readerIndexRealBytes(
  entries: VolumeChapterEntry[],
  wrapper: { taskId: number; title: string; author: string; version: string; totalBytes: number },
): number {
  const index = {
    taskId: wrapper.taskId, title: wrapper.title, author: wrapper.author,
    version: wrapper.version, totalBytes: wrapper.totalBytes,
    chapters: entries.map((entry) => ({
      index: entry.i, title: entry.t, startByte: entry.s, endByte: entry.e, partCount: entry.p,
    })),
  };
  return Buffer.byteLength(JSON.stringify(index), 'utf8');
}

/** 发布一本书,返回解析回来的清单 + 落地的清单 raw 字节 + 读端索引字节。 */
async function publish(pad: number, n = N) {
  const txt = bookText(pad, n);
  const chapters = parseTxtChapters(Buffer.from(txt, 'utf8'), 64 * 1024 * 1024).length;
  expect(chapters).toBe(n); // 标题必须被识别成章
  const github = new MemoryGitHub();
  const result = await publishBookVersion(github, guardOk, {
    taskId: 7, title: TITLE, author: AUTHOR, txt,
    chaptersDone: chapters, chaptersTotal: chapters, charsTotal: Array.from(txt).length,
    // 发布侧内存上限:2 万章整本 ≈ 8 MiB,给 ≥ MAX_BOOK_BYTES(64 MiB)空间;
    // parseTxtChapters 的 size 预检与「清单字节门」是两回事,这里只关心后者。
  }, { maxBookBytes: 64 * 1024 * 1024 });
  expect(result.promoted).toBe(true); // 护栏书必须在门内:发布侧不拒、读端也不拒
  const { canonicalPath } = snapshotPaths(TITLE, AUTHOR);
  const canonicalText = github.files.get(canonicalPath)!;
  const manifest = parseVolumeManifest(Buffer.from(canonicalText, 'utf8'));
  expect(manifest).not.toBeNull(); // 读端 readManifest 能解析(读端清单门内)
  return {
    manifest: manifest!,
    manifestBytes: Buffer.byteLength(canonicalText, 'utf8'),
    indexBytes: Buffer.byteLength(JSON.stringify(readerIndexFromManifest(manifest!)), 'utf8'),
  };
}

/** 走**加门后**的发布路径(publishBookVersion 内部已含 readerIndexBytes 门)。 */
async function publishGuarded(pad: number, n = N): Promise<unknown> {
  const txt = bookText(pad, n);
  const chapters = parseTxtChapters(Buffer.from(txt, 'utf8'), 64 * 1024 * 1024).length;
  const github = new MemoryGitHub();
  return publishBookVersion(github, guardOk, {
    taskId: 7, title: TITLE, author: AUTHOR, txt,
    chaptersDone: chapters, chaptersTotal: chapters, charsTotal: Array.from(txt).length,
  }, { maxBookBytes: 64 * 1024 * 1024 });
}

describe('2 万章清单字节边界:发布 vs 读回(rev41vol2 P1 缺口)', () => {
  it('护栏:2 万章短标题(第N章),发布清单与读回索引都在 4 MiB 门内', async () => {
    // 短标题是生产最常见形态:两侧都必须稳稳在门内(否则正常书读不了 = 回归)。
    const { manifest, manifestBytes, indexBytes } = await publish(0);
    expect(manifest.chapters).toBe(N);
    expect(manifestBytes).toBeLessThan(READER_INDEX_GATE);
    expect(indexBytes).toBeLessThan(READER_INDEX_GATE);
  });

  it('缺口成因:同样 2 万章 × 长标题,清单字节在 4 MiB 门内而读端索引顶穿(证明门必须加在发布侧)', async () => {
    // 直接比较两个 JSON 形状的字节(不经过发布门,单独证明「读端索引比清单更容易顶穿」):
    // 清单每章行更短(键名 i/t/v/s/e/p),读端 ReaderChapter 每章更长(键名 index/title/startByte/
    // endByte/partCount)。同一份 2 万章长标题数据,存在「清单 < 4 MiB 但读端索引 > 4 MiB」的窗口。
    const pad = 44;
    const txt = bookText(pad);
    const chapters = parseTxtChapters(Buffer.from(txt, 'utf8'), 64 * 1024 * 1024);
    expect(chapters).toHaveLength(N);
    // 清单侧:每章一行紧凑 {i,t,v,s,e,p}(stringifyVolumeManifest 同口径)。
    const manifestChapters = chapters.map((c, i) => ({ i, t: c.title, v: 0, s: c.startByte, e: c.endByte, p: 1 }));
    const manifestBytes = Buffer.byteLength(JSON.stringify(manifestChapters), 'utf8');
    // 读端侧:ReaderChapter 每章 {index,title,startByte,endByte,partCount}。
    const readerChapters = chapters.map((c, i) => ({ index: i, title: c.title, startByte: c.startByte, endByte: c.endByte, partCount: 1 }));
    const indexBytes = Buffer.byteLength(JSON.stringify(readerChapters), 'utf8');
    console.log('gap window: manifest≈' + (manifestBytes / 1024 / 1024).toFixed(3) + 'MiB reader≈' + (indexBytes / 1024 / 1024).toFixed(3) + 'MiB gate=4MiB');
    expect(manifestBytes).toBeLessThan(READER_INDEX_GATE); // 读端能取清单、能解析 ⇒ 未修时「能发布」
    expect(indexBytes).toBeGreaterThan(READER_INDEX_GATE); // 但目录索引被读端 422 门拒 ⇒ 未修时「读不了」
    // 发布侧门必须按读端等价字节判:同一份 chapter_index 序列化成读端形状更大。
    const entries = chapters.map((c, i) => ({ i, t: c.title, v: 0, s: c.startByte, e: c.endByte, p: 1 }));
    expect(readerIndexBytes(entries, testWrapper)).toBeGreaterThan(manifestBytes); // 读端形状 > 清单形状
    expect(MAX_READER_INDEX_BYTES).toBe(READER_INDEX_GATE); // 门与读端严格同值
  });

  it('修法护栏:加发布侧清单门后,长标题书发布即被 PublicationStageError 拒绝(不再「能发布读不了」)', async () => {
    // 修法 = 发布侧镜像读端 4 MiB 索引门。这本书发布阶段就该被拒(stage=manifest),
    // 而不是发布成功、读端才 422。未修时会 promoted=true ⇒ 本断言红;修后转绿。
    await expect(publishGuarded(44)).rejects.toMatchObject({ name: 'PublicationStageError', stage: 'manifest' });
  });

  it('修法不误伤:短标题书(生产最常见)发布侧门放行,仍能正常 promoted', async () => {
    const outcome = await publishGuarded(0) as { promoted: boolean; volumeCount: number };
    expect(outcome.promoted).toBe(true);
    expect(outcome.volumeCount).toBeGreaterThanOrEqual(1);
  });

  // rev41vol2 复审 P1:readerIndexBytes 旧写法逐章 stringify 再求和,漏掉了顶层包裹与
  // 数组元素间逗号,实测恒定低估(2 万章 ≈ -19,882 B / 1.99 万章 ≈ -19,782 B),在 4 MiB 门
  // 边缘留下「能发布读不了」盲区。下面两条把该判据钉成回归门:估算必须**逐字节等于**读端
  // 真实序列化字节(不再低估也不高估),且复审构造的 pad=40/n=19900 边界书必须发布即拒。

  it('P1 对拍:readerIndexBytes 逐字节等于读端真实 JSON.stringify(ReaderIndex) 字节', () => {
    // 覆盖规模:几百 ~ 几千 ~ 8500 ~ 19700 ~ 19900 ~ 20000 章 × 多档标题长度(含转义/超长)。
    // totalBytes 取该书真实 UTF-8 字节,version 用真实全书 gitBlobSha(40 hex)—— 与发布侧
    // 写入清单、读端将读到的 wrapper 完全同值,故估算应当与读端**精确相等**。
    const shapes: Array<{ pad: number; n: number }> = [
      { pad: 0, n: 300 }, { pad: 6, n: 500 }, { pad: 10, n: 1200 }, { pad: 14, n: 3000 },
      { pad: 20, n: 6000 }, { pad: 24, n: 8500 }, { pad: 30, n: 9000 }, { pad: 36, n: 19_000 },
      { pad: 38, n: 19_700 }, { pad: 40, n: 19_900 }, { pad: 42, n: 19_900 }, { pad: 44, n: 20_000 },
    ];
    for (const { pad, n } of shapes) {
      const txt = bookText(pad, n);
      const chapters = parseTxtChapters(Buffer.from(txt, 'utf8'), 64 * 1024 * 1024);
      expect(chapters).toHaveLength(n);
      const entries: VolumeChapterEntry[] = chapters.map((c, i) =>
        ({ i, t: c.title, v: 0, s: c.startByte, e: c.endByte, p: 1 }));
      const wrapper = { taskId: 7, title: TITLE, author: AUTHOR, version: gitBlobSha(txt), totalBytes: Buffer.byteLength(txt, 'utf8') };
      const est = readerIndexBytes(entries, wrapper);
      const real = readerIndexRealBytes(entries, wrapper);
      const delta = est - real;
      const where = `pad=${pad} n=${n}`;
      if (process.env.VOL_DEBUG) console.log(`对拍 ${where}: est=${est} real=${real} delta=${delta}`);
      expect(est, `估算不得低估读端真实字节(${where},差 ${delta})`).toBeGreaterThanOrEqual(real);
      // 既不高估到误拒:差值必须为 0(同对象同 stringify ⇒ 逐字节相等)。
      expect(delta, `估算不得过度高估(${where},差 ${delta})`).toBe(0);
    }
  });

  it('P1 盲区堵死:复审构造 pad=40/n=19900 的书,修后发布即被拒(promoted=false)', async () => {
    // 这是复审 rev41vol2 A.4 的可达反例:est(old)=4,180,175 < 门 ⇒ 旧代码 promoted=true,
    // 而读端 real=4,199,957 > 门 ⇒ 读端 422「能发布读不了」。修后估算 == 读端真实,发布门
    // 在第一个 PUT 前就拒绝(stage=manifest),不再漏放。用 try/catch 捕获以同时打印两侧字节。
    const pad = 40;
    const n = 19_900;
    const txt = bookText(pad, n);
    const chapters = parseTxtChapters(Buffer.from(txt, 'utf8'), 64 * 1024 * 1024);
    const entries: VolumeChapterEntry[] = chapters.map((c, i) =>
      ({ i, t: c.title, v: 0, s: c.startByte, e: c.endByte, p: 1 }));
    const wrapper = { taskId: 7, title: TITLE, author: AUTHOR, version: gitBlobSha(txt), totalBytes: Buffer.byteLength(txt, 'utf8') };
    const est = readerIndexBytes(entries, wrapper);
    const real = readerIndexRealBytes(entries, wrapper);
    console.log(`P1 盲区 pad=${pad}/n=${n}: 修后估算=${est} 读端真实=${real} gate=${READER_INDEX_GATE}`);
    expect(real).toBeGreaterThan(READER_INDEX_GATE); // 读端若取这本书必 422:确实是「读不了」形态
    expect(est).toBeGreaterThan(READER_INDEX_GATE); //  修后估算也 > 门 ⇒ 发布门会拒
    let err: unknown;
    try {
      await publishGuarded(pad, n);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ name: 'PublicationStageError', stage: 'manifest' }); // 发布即拒,没 promoted
  });
});
