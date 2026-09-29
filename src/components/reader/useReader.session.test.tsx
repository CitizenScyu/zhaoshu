// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReader, partKey } from './useReader';
import { READER_SETTINGS_KEY } from '@/lib/reader-preferences';
import type { ReadingSession } from '@/lib/reader-types';

type Reader = ReturnType<typeof useReader>;
type ApiFetch = Parameters<typeof useReader>[1];
let current = true;
const isSessionCurrent = () => current;
const session: ReadingSession = { kind: 'source', title: '合成书', author: '合成作者', bookUrl: 'https://synthetic.example/book', sourceUrl: 'https://synthetic.example' };
const index = { taskId: null, source: { id: 'synthetic', name: '合成源', url: 'https://synthetic.example/book', sourceUrl: 'https://synthetic.example', session: 'synthetic-session' },
  title: '合成书', author: '合成作者', version: 'synthetic-v1', totalBytes: 0,
  chapters: [{ index: 0, title: '合成章节', startByte: 0, endByte: 4, partCount: 1 }] };
const part = { taskId: null, sourceId: 'synthetic', version: 'synthetic-v1', chapterIndex: 0, partIndex: 0,
  partCount: 1, title: '合成章节', startByte: 0, endByte: 4, text: '合成正文' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function mount(apiFetch: ApiFetch) {
  let reader!: Reader;
  function Probe() {
    reader = useReader(session, apiFetch, 2, isSessionCurrent);
    return <main ref={reader.scroller}><article ref={reader.article}>
      {reader.reading?.parts.map(item => <section key={partKey(item)}
        ref={element => reader.setSection(item, element)}>{item.text}</section>)}
    </article></main>;
  }
  return { ...render(<Probe />), reader: () => reader };
}
beforeEach(() => {
  current = true;
  window.localStorage.clear();
  window.localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify({ preloadNext: false }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ['index', 'session'], ['index', 'unmount'], ['index', 'normal'],
  ['part', 'session'], ['part', 'unmount'], ['part', 'normal'],
])('%s JSON 迟到：%s 仅有效会话交付正文和路由', async (stage, mode) => {
  const body = deferred<unknown>();
  let bodyStarted = false;
  let partGets = 0;
  const apiFetch = vi.fn<ApiFetch>(async input => {
    const isPart = String(input).includes('/chapter?');
    if (isPart) partGets += 1;
    const response = Response.json(isPart ? part : index);
    if ((stage === 'part') === isPart) response.json = () => { bodyStarted = true; return body.promise; };
    return response;
  });
  const ui = mount(apiFetch);
  const commit = vi.fn();
  ui.reader().registerSwitchCommitted(commit);
  await waitFor(() => expect(bodyStarted).toBe(true));
  if (mode === 'session') current = false;
  if (mode === 'unmount') ui.unmount();
  await act(async () => { body.resolve(stage === 'part' ? part : index); });
  expect(partGets).toBe(stage === 'part' || mode === 'normal' ? 1 : 0);
  expect(commit).toHaveBeenCalledTimes(mode === 'normal' ? 1 : 0);
  if (mode === 'normal') {
    expect(ui.reader().reading?.parts[0].text).toBe('合成正文');
    expect(commit).toHaveBeenCalledWith('https://synthetic.example/book', 'https://synthetic.example');
  } else if (mode === 'session') expect(ui.reader().reading).toBeNull();
});

it('旧确认与重试入口在换代后不重新取目录', async () => {
  const apiFetch = vi.fn<ApiFetch>(async input => Response.json(String(input).includes('/chapter?') ? part : index));
  const ui = mount(apiFetch);
  await waitFor(() => expect(ui.reader().reading).not.toBeNull());
  const before = apiFetch.mock.calls.length;
  current = false;
  await act(async () => {
    ui.reader().loadConfirmedBook('https://synthetic.example/other', 'https://synthetic.example');
    ui.reader().retry();
  });
  expect(apiFetch).toHaveBeenCalledTimes(before);
});

it('初始加载微任务执行前会话失效，不发目录请求', async () => {
  const apiFetch = vi.fn<ApiFetch>(async () => Response.json(index));
  mount(apiFetch);
  current = false;
  await act(async () => {});
  expect(apiFetch).not.toHaveBeenCalled();
});
