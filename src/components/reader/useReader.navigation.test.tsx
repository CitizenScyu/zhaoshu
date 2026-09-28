// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReader, partKey } from './useReader';
import { indexProgressKey, READER_SETTINGS_KEY } from '@/lib/reader-preferences';
import type { ReaderIndex, ReaderPart, ReadingSession } from '@/lib/reader-types';

type Reader = ReturnType<typeof useReader>;
type ApiFetch = Parameters<typeof useReader>[1];
const USER_ID = 99;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify({ preloadNext: false }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  // jsdom 没有排版：提供长章滚动几何，真实 hook 仍负责恢复、捕获及保存位置。
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const viewport = this.closest<HTMLElement>('[data-viewport]');
    const isPart = this.hasAttribute('data-part');
    return new DOMRect(0, isPart ? -(viewport?.scrollTop ?? 0) : 0, 400, isPart ? 1000 : 100);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountReader(session: ReadingSession, apiFetch: ApiFetch) {
  let seen: Reader;
  function Probe() {
    const reader = useReader(session, apiFetch, USER_ID);
    seen = reader;
    return <main data-viewport ref={reader.scroller}>
      <article ref={reader.article}>
        {reader.reading?.parts.map(part => <section data-part key={partKey(part)}
          ref={element => reader.setSection(part, element)}>{part.text}</section>)}
      </article>
    </main>;
  }
  const view = render(<Probe />);
  return { reader: () => seen, viewport: view.container.querySelector('main')! };
}

function catalog(source: boolean): ReaderIndex {
  return {
    taskId: source ? null : 123,
    ...(source ? { source: { id: 'source-a', name: '合成源甲', url: 'https://synthetic.invalid/book', session: 'a'.repeat(40) } } : {}),
    title: '合成测试书', author: '合成作者', version: 'a'.repeat(40), totalBytes: 3000,
    chapters: ['第一章', '第二章', '第三章'].map((title, index) => ({ index, title, startByte: index * 1000, endByte: (index + 1) * 1000, partCount: 1 })),
  };
}

function mockFetch(index: ReaderIndex, switchKind: 'none' | 'legacy' | 'catalog') {
  return vi.fn<ApiFetch>(async input => {
    const url = new URL(String(input), 'https://synthetic.invalid');
    if (url.pathname.endsWith('/index')) return Response.json(index);
    const chapterIndex = Number(url.searchParams.get('chapter'));
    const part: ReaderPart = {
      taskId: index.taskId, ...(index.source ? { sourceId: index.source.id } : {}),
      version: index.version, chapterIndex, partIndex: 0, partCount: 1,
      title: index.chapters[chapterIndex].title, startByte: chapterIndex * 1000,
      endByte: (chapterIndex + 1) * 1000, text: `纯合成正文 ${chapterIndex}`,
    };
    if (chapterIndex === 1 && switchKind !== 'none') {
      part.sourceId = 'source-b';
      part.version = part.sourceSession = 'b'.repeat(40);
      if (switchKind === 'catalog') {
        part.switchedChapterIndex = 2;
        part.switchedChapters = [
          { index: 0, title: '序言', startByte: 0, endByte: 0, partCount: 1 },
          ...index.chapters.map(chapter => ({ ...chapter, index: chapter.index + 1 })),
        ];
      }
    }
    return Response.json(part);
  });
}

describe('章节导航的位置、滚动与进度一致性', () => {
  it.each([
    { label: '下载阅读普通跳章', source: false, switchKind: 'none' as const, expectedChapter: 1, expectedRatio: 0 },
    { label: '在线阅读未换源跳章', source: true, switchKind: 'none' as const, expectedChapter: 1, expectedRatio: 0 },
    { label: '旧形状换源没有迁移目录时采用导航目标', source: true, switchKind: 'legacy' as const, expectedChapter: 1, expectedRatio: 0 },
    { label: '实际换源目录保留迁移后的序号与进度', source: true, switchKind: 'catalog' as const, expectedChapter: 2, expectedRatio: 0.3 },
  ])('$label', async ({ source, switchKind, expectedChapter, expectedRatio }) => {
    const index = catalog(source);
    const session: ReadingSession = source
      ? { kind: 'source', title: index.title, author: index.author }
      : { kind: 'download', taskId: 123 };
    const apiFetch = mockFetch(index, switchKind);
    const { reader, viewport } = mountReader(session, apiFetch);
    const saved = (current: ReaderIndex) => JSON.parse(window.localStorage.getItem(indexProgressKey(current, USER_ID)) ?? 'null');
    await waitFor(() => expect(saved(index)?.chapterIndex).toBe(0));
    // 从第一章中段跳转；若错用旧 position，既不会滚回章首，也不会保存新章节。
    act(() => { viewport.scrollTop = 270; reader().onScroll(); });
    await waitFor(() => expect(saved(index)?.ratio).toBeCloseTo(0.3));
    await act(async () => { await reader().navigate({ chapterIndex: 1, partIndex: 0, ratio: 0 }); });
    expect(reader().failure).toBeNull();
    expect(reader().activePart?.chapterIndex).toBe(expectedChapter);
    expect(reader().reading?.position).toMatchObject({ chapterIndex: expectedChapter, partIndex: 0, ratio: expectedRatio });
    expect(viewport.scrollTop).toBe(expectedRatio * 900);
    const adopted = reader().reading!.index;
    await waitFor(() => expect(saved(adopted)).toMatchObject({ chapterIndex: expectedChapter, partIndex: 0, ratio: expectedRatio, version: adopted.version }));
    if (switchKind === 'catalog') {
      expect(adopted.source?.id).toBe('source-b');
      expect(adopted.chapters[expectedChapter].title).toBe('第二章');
    }
  });
});
