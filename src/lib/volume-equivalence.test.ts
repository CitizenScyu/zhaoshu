// 分卷 v2 验收:等价性(设计 §十四 最强判据)。
//
// 同一份字节,「发布器分卷 → 清单 → parseVolumeManifest 建索引」得到的每章
// (序号/标题/startByte/endByte/partCount)与「整本 parseTxtChapters + splitChapterParts」
// 必须逐项相等。这是「客户端零改动」的前提:阅读端看到的目录/偏移与整本阅读完全同口径。
//
// 覆盖三本合成书:普通多章 / 无章节标题 / 单章 > 16 MiB 病态。
// 走真实发布器(publishBookVersion)+ 内存 GitHub 接缝 ⇒ 序列化/校验路径也被覆盖。
import { describe, expect, it } from 'vitest';
import { publishBookVersion, snapshotPaths, gitBlobSha } from './download-publisher';
import type { GitHubContents } from './download-publisher';
import { parseVolumeManifest } from './volume-manifest';
import { parseTxtChapters, splitChapterParts, MAX_READER_BYTES, MAX_CHAPTER_PART_BYTES } from './txt-chapters';

const guardOk = { check: async () => {} };

/** 最小内存 GitHub:put 落 map,getBytes 从未落盘的路径返回 null。绝不联网。 */
class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

const TITLE = '等价性测试书';
const AUTHOR = '佚名';

/** 发布一本书,返回解析回来的清单 + 原始字节。 */
async function publishAndParse(txt: string, chaptersDone: number) {
  const github = new MemoryGitHub();
  const result = await publishBookVersion(github, guardOk, {
    taskId: 1, title: TITLE, author: AUTHOR, txt,
    chaptersDone, chaptersTotal: chaptersDone, charsTotal: Array.from(txt).length,
  });
  if (!result.promoted) throw new Error('合成书必须晋升');
  const { canonicalPath } = snapshotPaths(TITLE, AUTHOR);
  const canonicalText = github.files.get(canonicalPath)!;
  const manifest = parseVolumeManifest(Buffer.from(canonicalText, 'utf8'));
  if (!manifest) throw new Error('清单必须可解析');
  return { manifest, buf: Buffer.from(txt, 'utf8'), github };
}

/**
 * 核心断言:清单索引 vs 整本解析逐项相等。
 * partCount 在两侧都由 splitChapterParts(同段上限、同字节)算出 —— 读端在「章字节」上重算,
 * 发布端在「全书缓冲」上算同一章区间,两者必须一致(设计 §六「同函数同字节 ⇒ 同结果」)。
 */
function assertEquivalent(manifest: NonNullable<ReturnType<typeof parseVolumeManifest>>, buf: Buffer) {
  const txtChapters = parseTxtChapters(buf, Math.max(buf.byteLength, MAX_READER_BYTES));
  // 「整本解析」侧:每章的 partCount 用章内字节重算(与读端 readBookPart 同路径)。
  const wholeBookIndex = txtChapters.map((chapter) => {
    const range = buf.subarray(chapter.startByte, chapter.endByte);
    const parts = splitChapterParts(range, { startByte: 0, endByte: range.byteLength },
      MAX_CHAPTER_PART_BYTES, Math.max(range.byteLength, MAX_READER_BYTES));
    return {
      index: chapter.index,
      title: chapter.title,
      startByte: chapter.startByte,
      endByte: chapter.endByte,
      partCount: parts.length,
    };
  });
  // 「分卷清单」侧:与 reader-server.readBookIndex 完全同映射。
  const manifestIndex = manifest.chapter_index.map(entry => ({
    index: entry.i, title: entry.t, startByte: entry.s, endByte: entry.e, partCount: entry.p,
  }));
  expect(manifestIndex).toEqual(wholeBookIndex);
  expect(manifest.bytes).toBe(buf.byteLength);
  // 卷偏移首尾相接且 Σbytes === 全书
  const sum = manifest.volumes.reduce((acc, volume) => acc + volume.bytes, 0);
  expect(sum).toBe(buf.byteLength);
  expect(manifest.volumes[0].first_byte).toBe(0);
  expect(manifest.volumes.at(-1)!.last_byte).toBe(buf.byteLength);
  // 逐卷 blob_sha 自洽(读端据此校验卷字节)
  for (const volume of manifest.volumes) {
    const slice = buf.subarray(volume.first_byte, volume.last_byte).toString('utf8');
    expect(gitBlobSha(slice)).toBe(volume.blob_sha);
    expect(volume.bytes).toBeLessThanOrEqual(MAX_READER_BYTES);
  }
}

describe('分卷等价性:清单索引 ≡ 整本解析(设计 §十四 判据 1)', () => {
  it('普通多章书:逐项相等(序号/标题/startByte/endByte/partCount/totalBytes)', async () => {
    const lines = [TITLE, AUTHOR, ''];
    for (let i = 0; i < 5; i++) lines.push(`【第${i + 1}章 合成】`, '', '正文'.repeat(400));
    const txt = lines.join('\n');
    const chapters = parseTxtChapters(Buffer.from(txt, 'utf8')).length;
    const { manifest, buf } = await publishAndParse(txt, chapters);
    expect(manifest.chapters).toBe(chapters);
    assertEquivalent(manifest, buf);
  });

  it('无章节标题书:整本一章「正文」,仍逐项相等', async () => {
    const txt = '没有任何章节标题的连续正文。'.repeat(200);
    const chapters = parseTxtChapters(Buffer.from(txt, 'utf8')).length;
    expect(chapters).toBe(1);
    const { manifest, buf } = await publishAndParse(txt, chapters);
    assertEquivalent(manifest, buf);
    expect(manifest.chapter_index[0].t).toBe('正文');
  });

  it('单章 > 16 MiB 病态书:章跨卷,索引与整本解析仍逐项相等', async () => {
    // 无标题 ⇒ 整本一章「正文」;总量 > 16 MiB 硬上限 ⇒ 该章被切成多卷。
    const line = 'x'.repeat(79) + '\n';
    const total = 16 * 1024 * 1024 + 8192;
    const txt = line.repeat(Math.ceil(total / line.length));
    const buf = Buffer.from(txt, 'utf8');
    expect(buf.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    const chapters = parseTxtChapters(buf, Math.max(buf.byteLength, MAX_READER_BYTES)).length;
    expect(chapters).toBe(1);
    const { manifest } = await publishAndParse(txt, chapters);
    // 病态章确实跨了多卷
    expect(manifest.volumes.length).toBeGreaterThan(1);
    expect(manifest.chapter_index).toHaveLength(1);
    assertEquivalent(manifest, buf);
  });
});
