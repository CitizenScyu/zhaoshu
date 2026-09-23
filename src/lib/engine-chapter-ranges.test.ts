// 41-MANIFESTFIX 单元层:engineChapterRanges(引擎章节边界还原)+ 发布器 chapterRanges 闸门 + 缺省退回解析。
// 端到端(真实引擎 downloadBook → adapter → 发布 → 读端解析)见 download-manifest-boundaries.test.ts。
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { engineChapterRanges, type EngineChapterRecord } from './download-worker';
import {
  PublicationStageError, publishBookVersion, snapshotPaths, type GitHubContents, type PublishCandidate,
} from './download-publisher';
import { MAX_READER_CHAPTERS, parseTxtChapters, type TxtChapter } from './txt-chapters';
import { parseVolumeManifest } from './volume-manifest';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 按 engine-download.mjs 的方式拼整本并产出同形的章记录(title/chars/sha256/status)。 */
function engineBook(chapters: { title: string; text: string }[]) {
  const txt = chapters.map(({ title, text }) => `${title}\n\n${text}\n\n`).join('');
  const records: EngineChapterRecord[] = chapters.map(({ title, text }) => ({
    title, chars: [...text].length, sha256: sha256(text), status: 'done',
  }));
  return { txt, records };
}

const MIXED = [
  { title: '序章', text: '序章正文😀𠀀\r\n第二行。' },
  { title: '  13.第13章  ', text: '十三章正文。' },
  { title: '完本感言', text: '完结撒花。' },
];

class RecordingGitHub implements GitHubContents {
  files = new Map<string, string>();
  calls = 0;
  async put(path: string, text: string): Promise<void> { this.calls++; this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    this.calls++;
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

const guardOk = { check: async () => {} };

function candidate(txt: string, chapters: number, overrides: Partial<PublishCandidate> = {}): PublishCandidate {
  return {
    taskId: 7, title: '测试书', author: '作者甲', txt,
    chaptersDone: chapters, chaptersTotal: chapters, charsTotal: [...txt].length, ...overrides,
  };
}

describe('engineChapterRanges:按引擎拼接方式还原章节字节边界', () => {
  it('逐章偏移与拼接段逐字节相等(代理对按一个码点计,正文内 CRLF 原样保留),章名去首尾空白', () => {
    const { txt, records } = engineBook(MIXED);
    const ranges = engineChapterRanges(txt, records);
    expect(ranges).not.toBeNull();
    const buf = Buffer.from(txt, 'utf8');
    expect(ranges!.map((range) => range.title)).toEqual(['序章', '13.第13章', '完本感言']);
    let at = 0;
    for (const [index, range] of ranges!.entries()) {
      expect(range.index).toBe(index);
      expect(range.startByte).toBe(at);
      expect(buf.toString('utf8', range.startByte, range.endByte)).toBe(`${MIXED[index].title}\n\n${MIXED[index].text}\n\n`);
      at = range.endByte;
    }
    expect(at).toBe(buf.byteLength);
  });

  it.each([
    ['正文被改(sha256 不符)', (b: ReturnType<typeof engineBook>) => ({ ...b, txt: b.txt.replace('十三章正文', '十三章正闻') })],
    ['码点数不符', (b: ReturnType<typeof engineBook>) => ({ ...b, records: b.records.map((r, i) => (i === 0 ? { ...r, chars: (r.chars as number) + 1 } : r)) })],
    ['标题与 txt 不符', (b: ReturnType<typeof engineBook>) => ({ ...b, records: b.records.map((r, i) => (i === 2 ? { ...r, title: '完本感言!' } : r)) })],
    ['txt 末尾多出字节', (b: ReturnType<typeof engineBook>) => ({ ...b, txt: `${b.txt}尾巴` })],
    ['有章未完成', (b: ReturnType<typeof engineBook>) => ({ ...b, records: b.records.map((r, i) => (i === 1 ? { ...r, status: 'failed' } : r)) })],
    ['缺 sha256', (b: ReturnType<typeof engineBook>) => ({ ...b, records: b.records.map((r, i) => (i === 1 ? { ...r, sha256: undefined } : r)) })],
    ['少记一章', (b: ReturnType<typeof engineBook>) => ({ ...b, records: b.records.slice(0, 2) })],
  ])('%s ⇒ null(不猜,调用方不给边界)', (_name, tamper) => {
    const { txt, records } = tamper(engineBook(MIXED));
    expect(engineChapterRanges(txt, records)).toBeNull();
  });

  it('没有章记录 ⇒ null', () => {
    expect(engineChapterRanges('x', undefined)).toBeNull();
    expect(engineChapterRanges('x', [])).toBeNull();
  });
});

describe('publishBookVersion 的 chapterRanges', () => {
  it('给了边界:chapter_index 逐章等于边界,长度 === chapters,读端 round-trip 通过', async () => {
    const { txt, records } = engineBook(MIXED);
    const ranges = engineChapterRanges(txt, records)!;
    const github = new RecordingGitHub();
    const outcome = await publishBookVersion(github, guardOk, candidate(txt, MIXED.length, { chapterRanges: ranges }));
    expect(outcome.promoted).toBe(true);
    const manifest = parseVolumeManifest(Buffer.from(github.files.get(snapshotPaths('测试书', '作者甲').canonicalPath)!, 'utf8'));
    expect(manifest).not.toBeNull();
    expect(manifest!.chapters).toBe(MIXED.length);
    expect(manifest!.chapter_index.map(({ i, t, s, e }) => ({ i, t, s, e })))
      .toEqual(ranges.map((range) => ({ i: range.index, t: range.title, s: range.startByte, e: range.endByte })));
  });

  // 基准边界在用例内现算(不在收集期算):还原逻辑被改坏时是具名用例红,而不是整文件收集失败。
  const baseline = () => {
    const { txt, records } = engineBook(MIXED);
    const good = engineChapterRanges(txt, records);
    expect(good).not.toBeNull();
    return { txt, good: good!, size: Buffer.byteLength(txt, 'utf8') };
  };
  const shift = (ranges: TxtChapter[], index: number, patch: Partial<TxtChapter>) =>
    ranges.map((range, i) => (i === index ? { ...range, ...patch } : range));
  it.each<[string, (good: TxtChapter[], size: number) => TxtChapter[]]>([
    ['中间有缺口', (good) => shift(good, 1, { startByte: good[1].startByte + 1 })],
    ['相邻重叠', (good) => shift(good, 1, { startByte: good[1].startByte - 1 })],
    ['没铺到全书末尾', (good, size) => shift(good, 2, { endByte: size - 1 })],
    ['越过全书末尾', (good, size) => shift(good, 2, { endByte: size + 1 })],
    ['空章', (good) => [...good.slice(0, 2), { ...good[2], endByte: good[2].startByte }]],
    // 第 3 章以「完」(3 字节)开头:边界右移 1 字节正好落在它的 UTF-8 续字节上(铺满、首尾相接都仍成立)。
    ['起点落在 UTF-8 续字节上', (good) => [good[0], { ...good[1], endByte: good[1].endByte + 1 }, { ...good[2], startByte: good[2].startByte + 1 }]],
  ])('边界%s ⇒ 发布前拒绝(invalid_chapter_ranges),零 GitHub 调用', async (_name, build) => {
    const { txt, good, size } = baseline();
    const github = new RecordingGitHub();
    await expect(publishBookVersion(github, guardOk, candidate(txt, MIXED.length, { chapterRanges: build(good, size) })))
      .rejects.toMatchObject({ stage: 'manifest', detail: 'invalid_chapter_ranges' });
    expect(github.calls).toBe(0);
  });

  it('边界章数 ≠ chaptersDone ⇒ 发布前拒绝(chapter_count_mismatch),零 GitHub 调用', async () => {
    const { txt, good } = baseline();
    const github = new RecordingGitHub();
    const error = await publishBookVersion(github, guardOk, candidate(txt, MIXED.length + 1, { chapterRanges: good }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublicationStageError);
    expect(error).toMatchObject({ stage: 'manifest', detail: 'chapter_count_mismatch' });
    expect(github.calls).toBe(0);
  });

  it('边界章数超过读端上限 ⇒ index_too_large,零 GitHub 调用', async () => {
    const count = MAX_READER_CHAPTERS + 1;
    const tiny = 'x'.repeat(count);
    const ranges = Array.from({ length: count }, (_, index) => ({ index, title: 'x', startByte: index, endByte: index + 1 }));
    const github = new RecordingGitHub();
    await expect(publishBookVersion(github, guardOk, candidate(tiny, count, { chapterRanges: ranges })))
      .rejects.toMatchObject({ stage: 'manifest', detail: 'index_too_large' });
    expect(github.calls).toBe(0);
  });

  it('不给边界:退回 parseTxtChapters 二次解析,行为同旧(非引擎来源)', async () => {
    const book = '第一章 甲\n\n甲正文。\n\n第二章 乙\n\n乙正文。\n\n';
    const github = new RecordingGitHub();
    await publishBookVersion(github, guardOk, candidate(book, 2));
    const manifest = parseVolumeManifest(Buffer.from(github.files.get(snapshotPaths('测试书', '作者甲').canonicalPath)!, 'utf8'));
    expect(manifest!.chapter_index.map(({ t, s, e }) => ({ t, s, e })))
      .toEqual(parseTxtChapters(Buffer.from(book, 'utf8')).map(({ title, startByte, endByte }) => ({ t: title, s: startByte, e: endByte })));
  });

  it('夹具有区分力:同一本书按标题二次解析得 6 章(并章 3、拆章 1),引擎是 8 章', () => {
    const titles = ['序章', '第一章 开端', '第二章', '13.第13章', '第14章 转折', '30.第30章 上架感言！', '番外一 月下', '完本感言'];
    const book = titles.map((title, index) => `${title}\n\n${index === 2 ? '回忆之前。\n第二十章 回忆\n回忆之后。' : '正文。'}\n\n`).join('');
    expect(parseTxtChapters(Buffer.from(book, 'utf8'))).toHaveLength(6);
  });
});

// 任务书第 4 条:生产 artifact 2 的坏清单(chapters 753 / chapter_index 625)不在本件修,等 HTML 修复后重下替换。
// 这里钉住那条推断的三面:同内容重发会保留原清单字节(坏的修不好);不同内容 ⇒ 新 version ⇒ 新清单换掉旧的;
// 但新版字数跌破旧版 70%(晋升门)时不晋升,坏清单照旧 —— 重下前要核字数比(1038 估算约 0.8,门内)。
describe('第 4 条:已发布的坏清单只能靠「不同内容」换掉', () => {
  const titles = ['序章', '第一章 开端', '第二章', '13.第13章', '第14章 转折', '30.第30章 上架感言！', '番外一 月下', '完本感言'];
  const filler = '字'.repeat(40);
  const book = (body: string) => engineBook(titles.map((title, index) => ({
    title, text: index === 2 ? `回忆之前${body}\n第二十章 回忆\n回忆之后。` : `正文${body}`,
  })));
  const { canonicalPath, dir } = snapshotPaths('测试书', '作者甲');
  const readerManifest = (github: RecordingGitHub) => parseVolumeManifest(Buffer.from(github.files.get(canonicalPath)!, 'utf8'));
  const pointer = (github: RecordingGitHub) => JSON.parse(github.files.get(`${dir}/current.json`)!).current as string;

  /** 旧行为落一份读端拒收的清单(不给边界 ⇒ 二次解析 6 章 vs chapters 8),与生产 artifact 2 同型。 */
  async function publishBroken(github: RecordingGitHub, body: string): Promise<string> {
    const { txt } = book(body);
    const outcome = await publishBookVersion(github, guardOk, candidate(txt, titles.length));
    expect(readerManifest(github)).toBeNull();
    return outcome.version;
  }

  it('同内容重发(即便这次给了边界):清单保留原字节,坏清单修不好', async () => {
    const github = new RecordingGitHub();
    await publishBroken(github, `<p>${filler}</p>`);
    const { txt, records } = book(`<p>${filler}</p>`);
    const outcome = await publishBookVersion(github, guardOk,
      candidate(txt, titles.length, { taskId: 8, chapterRanges: engineChapterRanges(txt, records)! }));
    expect(outcome.promoted).toBe(true);
    expect(readerManifest(github)).toBeNull();
  });

  it('不同内容(去掉标记,字数仍在旧版 70% 以上):新 version ⇒ 新清单写到快照与规范路径,指针切换,读端通过', async () => {
    const github = new RecordingGitHub();
    const old = await publishBroken(github, `<p>${filler}</p>`);
    const { txt, records } = book(filler);
    const outcome = await publishBookVersion(github, guardOk,
      candidate(txt, titles.length, { taskId: 9, chapterRanges: engineChapterRanges(txt, records)! }));
    expect(outcome.promoted).toBe(true);
    expect(outcome.version).not.toBe(old);
    const manifest = readerManifest(github);
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(outcome.version);
    expect(manifest!.chapter_index).toHaveLength(titles.length);
    expect(github.files.has(`${dir}/${outcome.version}.json`)).toBe(true);
    expect(pointer(github)).toBe(outcome.version);
  });

  it('风险:不同内容但字数跌破旧版 70%(晋升门)⇒ superseded_by_incomplete,坏清单与指针原样保留', async () => {
    const github = new RecordingGitHub();
    const old = await publishBroken(github, '<p>正文</p>');
    const { txt, records } = book('正文');
    const outcome = await publishBookVersion(github, guardOk,
      candidate(txt, titles.length, { taskId: 10, chapterRanges: engineChapterRanges(txt, records)! }));
    expect(outcome).toMatchObject({ promoted: false, reason: 'superseded_by_incomplete' });
    expect(readerManifest(github)).toBeNull();
    expect(pointer(github)).toBe(old);
  });
});
