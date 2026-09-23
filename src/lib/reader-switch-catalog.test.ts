import { describe, expect, it } from 'vitest';
import { attachSwitchedCatalog } from './reader-switch-catalog';
import type { ReaderPart } from './reader-types';
import type { SourceCatalog } from './source-reader';

const session = 'b'.repeat(40);
const catalog = (titles: string[]): SourceCatalog => ({
  title: '测试书', author: '作者', sourceUrl: 'https://backup.test/', sourceName: '备用书源',
  sourceRevision: 'rev', bookUrl: 'https://backup.test/books/details777.html',
  sourceId: 'source-two', version: session,
  chapters: titles.map((title) => ({ url: 'https://backup.test/chapter/' + title, title })),
});
const part = (over: Partial<ReaderPart> = {}): ReaderPart => ({
  taskId: null, sourceId: 'source-two', servedFrom: '备用书源', version: session, sourceSession: session,
  chapterIndex: 0, partIndex: 0, partCount: 1, title: '第一章', startByte: 0, endByte: 6, text: '正文', ...over,
});

describe('attachSwitchedCatalog(H7 换源响应附新目录)', () => {
  it('换源时附上新目录章节列表与本章的新序号,字段集与 index 一致、不含上游 URL', async () => {
    const attached = await attachSwitchedCatalog(part(), async () => catalog(['序言', '第一章', '第二章']));
    expect(attached.switchedChapterIndex).toBe(1);
    expect(attached.switchedChapters).toEqual([
      { index: 0, title: '序言', startByte: 0, endByte: 0, partCount: 1 },
      { index: 1, title: '第一章', startByte: 0, endByte: 0, partCount: 1 },
      { index: 2, title: '第二章', startByte: 0, endByte: 0, partCount: 1 },
    ]);
    // 上游 URL 等 index 资源不暴露的字段不得出现。
    expect(JSON.stringify(attached.switchedChapters)).not.toContain('http');
    expect(JSON.stringify(attached)).not.toContain('backup.test');
  });

  it('新目录只来自注入的读函数:未换源(无 sourceSession)时一次都不读', async () => {
    let reads = 0;
    const attached = await attachSwitchedCatalog(part({ sourceSession: undefined }), async () => {
      reads += 1;
      return catalog(['第一章']);
    });
    expect(reads).toBe(0);
    expect(attached.switchedChapters).toBeUndefined();
    expect(attached).toEqual(part({ sourceSession: undefined }));
  });

  it('目录读不到或本章标题对不上时不附目录(退回旧响应形状)', async () => {
    expect((await attachSwitchedCatalog(part(), async () => null)).switchedChapters).toBeUndefined();
    const mismatched = await attachSwitchedCatalog(part({ title: '不存在的章' }), async () => catalog(['序言', '第一章']));
    expect(mismatched.switchedChapters).toBeUndefined();
    expect(mismatched.switchedChapterIndex).toBeUndefined();
  });
});
