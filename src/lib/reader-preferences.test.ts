import { describe, expect, it } from 'vitest';
import { catalogPrefixKey, DEFAULT_READER_SETTINGS, parseReaderSettings, parseReadingProgress, readingPercent, readingProgressKey } from './reader-preferences';
import type { ReaderIndex, ReaderPart } from './reader-types';

const index: ReaderIndex = {
  taskId: 42, title: '测试书', author: '作者', version: 'a'.repeat(40), totalBytes: 10_000,
  chapters: [
    { index: 0, title: '第一章', startByte: 0, endByte: 1000, partCount: 1 },
    { index: 1, title: '第二章', startByte: 1000, endByte: 10_000, partCount: 3 },
  ],
};
const saved = { schema: 1, version: index.version, chapterIndex: 1, partIndex: 2, ratio: 0.45, updatedAt: 1234 };

describe('reader preferences and resume positions', () => {
  it.each([null, '', '{broken', 'null', '[]', '42'])('recovers defaults from invalid storage: %s', (raw) => {
    expect(parseReaderSettings(raw)).toEqual(DEFAULT_READER_SETTINGS);
    expect(parseReadingProgress(raw, index)).toBeNull();
  });

  it('bounds font sizes, validates line spacing, and ignores arbitrary theme names', () => {
    expect(parseReaderSettings('{"fontSize":200,"lineHeight":0,"theme":"url(evil)"}'))
      .toEqual({ ...DEFAULT_READER_SETTINGS, fontSize: 30, lineHeight: 1.9, theme: 'day' });
    expect(parseReaderSettings('{"fontSize":10,"lineHeight":2.2,"theme":"night"}'))
      .toEqual({ ...DEFAULT_READER_SETTINGS, fontSize: 16, lineHeight: 2.2, theme: 'night' });
    expect(parseReaderSettings('{"fontSize":22,"lineHeight":1.6,"theme":"sage"}'))
      .toEqual({ ...DEFAULT_READER_SETTINGS, fontSize: 22, lineHeight: 1.6, theme: 'sage' });
  });

  it('preserves typography and explicit opt-outs while extending older settings', () => {
    expect(parseReaderSettings('{"font":"serif","width":"wide","continuous":false,"preloadNext":false}'))
      .toEqual({ ...DEFAULT_READER_SETTINGS, font: 'serif', width: 'wide', continuous: false, preloadNext: false });
    expect(parseReaderSettings('{"fontSize":24,"theme":"night"}'))
      .toEqual({ ...DEFAULT_READER_SETTINGS, fontSize: 24, theme: 'night' });
    expect(parseReaderSettings('{"font":"url(evil)","width":999,"continuous":"false","preloadNext":0}'))
      .toEqual(DEFAULT_READER_SETTINGS);
  });

  it('resumes the exact chapter, section, and relative scroll position', () => {
    expect(parseReadingProgress(JSON.stringify(saved), index)).toEqual(saved);
    expect(readingProgressKey(42, 1)).toBe('novel-finder-reading-progress-u1-42');
    expect(readingProgressKey(43, 1)).not.toBe(readingProgressKey(42, 1));
    // 同一本书在两个账号下必须是两个键，不能互相覆盖进度。
    expect(readingProgressKey(42, 2)).not.toBe(readingProgressKey(42, 1));
  });

  it.each([
    { schema: 2 }, { version: 'b'.repeat(40) }, { chapterIndex: -1 }, { chapterIndex: 2 },
    { chapterIndex: 0.5 }, { chapterIndex: '1' }, { partIndex: -1 }, { partIndex: 3 },
    { partIndex: 0.5 }, { ratio: '0.5' }, { updatedAt: null },
  ])('rejects stale or invalid saved positions: %j', (change) => {
    expect(parseReadingProgress(JSON.stringify({ ...saved, ...change }), index)).toBeNull();
  });

  it('clamps a saved scroll position when the viewport changes', () => {
    expect(parseReadingProgress(JSON.stringify({ ...saved, ratio: 1.1 }), index)?.ratio).toBe(1);
    expect(parseReadingProgress(JSON.stringify({ ...saved, ratio: -0.1 }), index)?.ratio).toBe(0);
  });

  it('restores an exact text anchor without invalidating legacy ratio-only records', () => {
    const anchored = { ...saved, textOffset: 1200, viewportOffset: -8.5 };
    expect(parseReadingProgress(JSON.stringify(anchored), index)).toEqual(anchored);
    expect(parseReadingProgress(JSON.stringify(saved), index)).toEqual(saved);
    expect(parseReadingProgress(JSON.stringify({ ...anchored, viewportOffset: 900 }), index)?.viewportOffset).toBe(256);
  });

  it.each([{ textOffset: -1 }, { textOffset: 32769 }, { textOffset: 1.5 }, { viewportOffset: '12' }])('falls back to ratio for a corrupt optional anchor: %j', (change) => {
    expect(parseReadingProgress(JSON.stringify({ ...saved, textOffset: 1200, viewportOffset: 4, ...change }), index)).toEqual(saved);
  });

  it('weights progress by bytes and reaches 100% only at the end of the file', () => {
    const part = { startByte: 7000, endByte: 10_000 } as ReaderPart;
    expect(readingPercent(index, part, 0)).toBe(70);
    expect(readingPercent(index, part, 0.5)).toBe(85);
    expect(readingPercent(index, part, 1)).toBe(100);
  });
});

// 在线目录（source、taskId=null）可增长：追加章节后 version 必然变化。下载类
// （taskId!=null）的字节区间语义不受影响，仍走原来的「版本不符即失效」。
function onlineIndex(version: string, titles: string[]): ReaderIndex {
  return {
    taskId: null, title: '连载', author: '作者', version, totalBytes: 0,
    source: { id: 'src-1', name: '合成书源', url: 'https://example.invalid/book', session: version },
    chapters: titles.map((title, i) => ({ index: i, title, startByte: 0, endByte: 0, partCount: 1 })),
  };
}

/** 新版进度：在旧格式上补稳定章节键与前缀指纹（模拟 F11 修复后的写入）。 */
function onlineProgress(source: ReaderIndex, chapterIndex: number, extra: Record<string, unknown> = {}) {
  return {
    schema: 1, version: source.version, chapterIndex, partIndex: 0, ratio: 0.6,
    chapterTitle: source.chapters[chapterIndex].title,
    catalogPrefix: catalogPrefixKey(source, chapterIndex),
    updatedAt: 1, ...extra,
  };
}

describe('online catalog growth keeps a verifiable resume position', () => {
  it('纯追加：旧进度第 3 章（索引 2），目录追加第 4 章后仍回到第 3 章', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(before, 2, { ratio: 0.6, textOffset: 40, viewportOffset: 3 });
    const after = onlineIndex('rev-2', ['第1章', '第2章', '第3章', '第4章']);
    const restored = parseReadingProgress(JSON.stringify(saved), after);
    expect(restored).toMatchObject({
      schema: 1, version: 'rev-2', chapterIndex: 2, partIndex: 0, ratio: 0.6,
      chapterTitle: '第3章', textOffset: 40, viewportOffset: 3,
    });
    // 迁移后的 version 指向新目录，下一次保存不会再反复迁移。
    expect(restored?.version).toBe(after.version);
  });

  it('中间插入到阅读位置之前：内容错位，返回 null 而不是跳到错章', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(before, 2);
    // 在索引 1 插入新章，原「第3章」被挤到索引 3。
    const after = onlineIndex('rev-2', ['第1章', '插页', '第2章', '第3章']);
    expect(parseReadingProgress(JSON.stringify(saved), after)).toBeNull();
  });

  it('章节被删：后续章节整体前移，索引处标题不符，返回 null', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章', '第4章']);
    const saved = onlineProgress(before, 2); // 第3章
    const after = onlineIndex('rev-2', ['第1章', '第3章', '第4章']); // 删掉第2章
    expect(parseReadingProgress(JSON.stringify(saved), after)).toBeNull();
  });

  it('章节被替换：标题变化即无法证明是同一章，返回 null', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(before, 2);
    const after = onlineIndex('rev-2', ['第1章', '第2章', '重写后的第3章']);
    expect(parseReadingProgress(JSON.stringify(saved), after)).toBeNull();
  });

  // 下列两条唯一能拦住「当前章标题仍在原位且唯一、但读取位置之前的标题序列已被改写/交换」的窗口：
  // 标题与唯一性两道门都会放过，只有前缀指纹能证明原章位置未被打乱。删掉指纹判断必须变红。
  it('位置之前的两章被交换：当前章壳仍在原位且唯一，但前缀已变 → null', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(before, 2); // 第3章
    const after = onlineIndex('rev-2', ['第2章', '第1章', '第3章']);
    // 索引 2 仍是「第3章」且全目录唯一；若不比指纹会静默续读到被换了前文的目录。
    expect(parseReadingProgress(JSON.stringify(saved), after)).toBeNull();
  });

  it('位置之前的某章被改题：当前章壳仍在原位且唯一，但前缀已变 → null', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(before, 2); // 第3章
    const after = onlineIndex('rev-2', ['序章', '第2章', '第3章']);
    expect(parseReadingProgress(JSON.stringify(saved), after)).toBeNull();
  });

  it('对照：位置之后插入一章（前缀未变）仍恢复到同一章', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(before, 2); // 第3章，位于索引 2
    const after = onlineIndex('rev-2', ['第1章', '第2章', '第3章', '插页', '第4章']);
    expect(parseReadingProgress(JSON.stringify(saved), after)?.chapterIndex).toBe(2);
  });

  it('同名章多匹配：追加一章与进度章同名 → 无法唯一命中，返回 null', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(before, 2);
    const after = onlineIndex('rev-2', ['第1章', '第2章', '第3章', '第3章']);
    expect(parseReadingProgress(JSON.stringify(saved), after)).toBeNull();
  });

  it('旧格式（无稳定章节键）版本不符时仍按现行逻辑失效，不会猜测', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const legacy = { schema: 1, version: before.version, chapterIndex: 2, partIndex: 0, ratio: 0.6, updatedAt: 1 };
    const after = onlineIndex('rev-2', ['第1章', '第2章', '第3章', '第4章']);
    expect(parseReadingProgress(JSON.stringify(legacy), after)).toBeNull();
    // 版本相同则旧格式照常可读（向后兼容）。
    expect(parseReadingProgress(JSON.stringify(legacy), before)?.chapterIndex).toBe(2);
  });

  it('下载类（taskId≠null）版本不符时即使带稳定键也仍失效', () => {
    const download: ReaderIndex = { ...index, version: 'old' };
    const saved = {
      schema: 1, version: 'old', chapterIndex: 1, partIndex: 2, ratio: 0.45,
      chapterTitle: download.chapters[1].title, catalogPrefix: catalogPrefixKey(download, 1), updatedAt: 1,
    };
    const updated: ReaderIndex = {
      ...download, version: 'new',
      chapters: [...download.chapters, { index: 2, title: '第三章', startByte: 10_000, endByte: 12_000, partCount: 1 }],
    };
    expect(parseReadingProgress(JSON.stringify(saved), updated)).toBeNull();
  });

  it('新格式在同版本下原样保留稳定章节键（写入格式可往返）', () => {
    const source = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    const saved = onlineProgress(source, 1);
    expect(parseReadingProgress(JSON.stringify(saved), source)).toMatchObject({
      chapterIndex: 1, chapterTitle: '第2章', catalogPrefix: catalogPrefixKey(source, 1),
    });
  });

  it('迁移后分段越界（partCount 真的缩短）时返回 null', () => {
    const before = onlineIndex('rev-1', ['第1章', '第2章', '第3章']);
    before.chapters[1] = { ...before.chapters[1], partCount: 3 };
    const saved = onlineProgress(before, 1, { partIndex: 2 }); // 旧「第2章」有 3 段，读到第 3 段
    const after = onlineIndex('rev-2', ['第1章', '第2章', '第3章', '第4章']);
    after.chapters[1] = { ...after.chapters[1], partCount: 1 }; // 新目录里同一章只剩 1 段
    expect(parseReadingProgress(JSON.stringify(saved), after)).toBeNull();
  });
});

