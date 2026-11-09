import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findReplay, publishReplayEnabled, recordReplay } from './publish-replay';
import { readBookText } from './read-book-text';
import { createEngineAdapter, type EngineDownloadLike, type TaskRow } from '../src/lib/download-worker';

// pubreplay1110：合成目录布局 <base>/inst-N/download/out/<适配键>/<引擎键>/，全部假数据。
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ADAPTER_KEY = 'a'.repeat(24);
const ENGINE_KEY = 'b'.repeat(24);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

function layout() {
  const base = mkdtempSync(join(tmpdir(), 'pub-replay-'));
  dirs.push(base);
  const outOf = (inst: string) => { const out = join(base, inst, 'download', 'out'); mkdirSync(out, { recursive: true }); return out; };
  return { base, outOf };
}

/** 照 engine-download 落一本 done：章文件 + manifest（逐章 sha256）+ book.txt。返回整本 sha。 */
function writeBook(adapterDir: string, n = 3): { dir: string; txt: string } {
  const dir = join(adapterDir, ENGINE_KEY);
  mkdirSync(dir, { recursive: true });
  const chapters = Array.from({ length: n }, (_, index) => {
    const title = `第${index + 1}章 合成`;
    const text = `合成正文${index}`.repeat(50);
    writeFileSync(join(dir, `${index}.txt`), text);
    return { index, title, url: `https://reader.test/${index}`, chars: [...text].length, status: 'done', file: `${index}.txt`, sha256: sha(text) };
  });
  const txt = chapters.map(c => `${c.title}\n\n${readFileSync(join(dir, c.file), 'utf8')}\n\n`).join('');
  writeFileSync(join(dir, 'book.txt'), txt);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    status: 'done', errors: [], chapters_total: n, chapters_done: n, chars: chapters.reduce((s, c) => s + c.chars, 0),
    chapters, artifact: { file: 'book.txt', sha256: sha(txt), bytes: Buffer.byteLength(txt) },
  }, null, 2));
  return { dir, txt };
}

describe('pubreplay1110 发布退避重领复用本地整本', () => {
  it('开关解析：缺省/0 关，1/true/on 开', () => {
    expect(publishReplayEnabled({})).toBe(false);
    expect(publishReplayEnabled({ DOWNLOAD_PUBLISH_REPLAY: '0' })).toBe(false);
    expect(publishReplayEnabled({ DOWNLOAD_PUBLISH_REPLAY: '1' })).toBe(true);
    expect(publishReplayEnabled({ DOWNLOAD_PUBLISH_REPLAY: ' On ' })).toBe(true);
  });

  it('记标记后同任务 id 命中（book.txt 已被 prune 删也能按章拼回），别的任务 id 不命中', () => {
    const { outOf } = layout();
    const out = join(outOf('inst-1'), ADAPTER_KEY);
    const { dir, txt } = writeBook(out);
    recordReplay(out, 7, sha(txt));
    expect(existsSync(join(dir, 'publish-replay.json'))).toBe(true);
    unlinkSync(join(dir, 'book.txt'));
    expect(findReplay(out, [], 7)).toEqual(expect.objectContaining({ txt, peer: false }));
    expect(findReplay(out, [], 8)).toBeNull();
  });

  it('重领落到别的实例：在兄弟实例同适配键下找到', () => {
    const { outOf } = layout();
    const peerRoot = outOf('inst-2');
    const { txt } = writeBook(join(peerRoot, ADAPTER_KEY));
    recordReplay(join(peerRoot, ADAPTER_KEY), 7, sha(txt));
    const own = join(outOf('inst-1'), ADAPTER_KEY);
    expect(findReplay(own, [peerRoot], 7)).toEqual(expect.objectContaining({ txt, peer: true }));
  });

  it('章被改、持锁、manifest 被别的任务重写 → 不命中', () => {
    const { outOf } = layout();
    const out = join(outOf('inst-1'), ADAPTER_KEY);
    const { dir, txt } = writeBook(out);
    recordReplay(out, 7, sha(txt));
    writeFileSync(join(dir, 'download.lock'), '');
    expect(findReplay(out, [], 7)).toBeNull();
    unlinkSync(join(dir, 'download.lock'));
    writeFileSync(join(dir, '1.txt'), '被改动的正文');
    expect(findReplay(out, [], 7)).toBeNull();
    writeBook(out, 4); // 同目录被别的任务重跑：manifest 的 artifact sha 变了
    expect(findReplay(out, [], 7)).toBeNull();
  });

  it('manifest 未 done 或 sha 不符时不记标记', () => {
    const { outOf } = layout();
    const out = join(outOf('inst-1'), ADAPTER_KEY);
    const { dir } = writeBook(out);
    recordReplay(out, 7, 'f'.repeat(64));
    expect(existsSync(join(dir, 'publish-replay.json'))).toBe(false);
  });
});

describe('pubreplay1110 引擎 adapter 接线', () => {
  const task = (id: number): TaskRow => ({
    id, book_id: 1, title: '合成书', author: '合成作者', status: 'running',
    source_url: 'https://reader.test/book', source_kind: 'engine', source_id: null, requested_by: 'system',
  });
  const context = () => ({ signal: new AbortController().signal, progress: async () => {} });

  it('首领下完记标记；同任务重领不调引擎、原样返回整本（含章节边界）；新任务照常调引擎', async () => {
    const { outOf } = layout();
    const outRoot = outOf('inst-1');
    const engine = vi.fn<EngineDownloadLike>(async (_m, args) => {
      writeBook(args.out as string);
      const manifest = JSON.parse(readFileSync(join(args.out as string, ENGINE_KEY, 'manifest.json'), 'utf8'));
      return { code: 0, manifest };
    });
    const adapter = createEngineAdapter({
      downloadBook: engine, modules: {}, resolveSource: async () => ({}), readBookText, outRoot,
      replay: { find: (out, taskId) => findReplay(out, [], taskId), record: recordReplay },
    });
    const first = await adapter.download(task(7), context());
    expect(first.kind).toBe('complete');
    expect(engine).toHaveBeenCalledTimes(1);

    const again = await adapter.download(task(7), context());
    expect(engine).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);
    expect(again.kind === 'complete' && again.chapterRanges?.length).toBe(3);

    await adapter.download(task(8), context());
    expect(engine).toHaveBeenCalledTimes(2);
  });

  it('未装 replay（开关关）⇒ 同任务重领照常调引擎', async () => {
    const { outOf } = layout();
    const engine = vi.fn<EngineDownloadLike>(async (_m, args) => {
      writeBook(args.out as string);
      return { code: 0, manifest: JSON.parse(readFileSync(join(args.out as string, ENGINE_KEY, 'manifest.json'), 'utf8')) };
    });
    const adapter = createEngineAdapter({ downloadBook: engine, modules: {}, resolveSource: async () => ({}), readBookText, outRoot: outOf('inst-1') });
    await adapter.download(task(7), context());
    await adapter.download(task(7), context());
    expect(engine).toHaveBeenCalledTimes(2);
  });
});
