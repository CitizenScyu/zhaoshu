// 41-RESUMEFMT:续传判定含正文格式版本(ENGINE_CONTENT_FORMAT)。章节缓存是旧格式正文时(如 41-HTMLFIX 之前
// 带 <p> 的 @html 原文),续传会把它原样拼进新书 ⇒ 整本 blob 不变 ⇒ 发布器保留旧清单,修复对已缓存过的书不生效
// (生产 1038 同型)。每条用例先完整下一遍,再把第 1 章缓存换成旧格式正文(记录里的 sha 同步改,保证只剩
// 「格式」这一个判据能拦住它),然后重下看是否重抓。离线:fetch 桩成抛错,页面全部由合成 transport 返回。
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as api from '../src/lib/rule-engine/api';
import * as compile from '../src/lib/rule-engine/compile';
import * as parser from '../src/lib/source-parser';
import { ENGINE_CONTENT_FORMAT, downloadBook, downloadOptions } from './engine-download.mjs';

const TITLE = '测试书';
const AUTHOR = '作者甲';
const BOOK_URL = 'https://book15.net/books/details1.html';
const CHAPTERS = [
  { title: '第一章 开端', text: '第一章新格式正文。' },
  { title: '第二章 转折', text: '第二章新格式正文。' },
  { title: '第三章 收束', text: '第三章新格式正文。' },
];
/** 旧格式正文(带标记),模拟格式变更之前缓存下来的章节。 */
const STALE = '<p>旧格式正文</p>';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const source = { url: 'https://book15.net/', name: 'synthetic', searchUrl: '/search?q={{key}}', rules: {} };

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  vi.stubGlobal('fetch', () => { throw new Error('network forbidden'); });
  const out = mkdtempSync(join(tmpdir(), 'resumefmt-'));
  dirs.push(out);
  const options = downloadOptions({ source: source.url, title: TITLE, author: AUTHOR, out, 'rate-ms': 0, 'timeout-ms': 5000 });
  const calls: string[] = [];
  const transport = async (url: string, opts: { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> }) => {
    calls.push(url);
    await opts.beforeRequest?.(opts.signal);
    if (url.includes('/search')) return { url, text: `<a href="${BOOK_URL}">${TITLE}</a>` };
    if (url === BOOK_URL) {
      return {
        url,
        text: `<h1>${TITLE}</h1><meta property="og:novel:book_name" content="${TITLE}"><meta property="og:novel:author" content="${AUTHOR}">`
          + CHAPTERS.map((chapter, index) => `<dd><a href="/chapter/index1-${index + 1}.html">${chapter.title}</a></dd>`).join(''),
      };
    }
    const matched = /\/chapter\/index1-(\d+)\.html$/.exec(url);
    if (matched) return { url, text: `<li class="chapter-content" id="article-content"><p>${CHAPTERS[Number(matched[1]) - 1].text}</p></li>` };
    throw new Error(`unexpected url ${url}`);
  };
  const run = () => downloadBook({ api, compile, parser }, options, async () => ({ source, builtin: true }), transport);
  const chapterCalls = () => calls.filter((url) => url.includes('/chapter/')).length;
  return { run, calls, chapterCalls };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const bookText = (manifestPath: string) => readFileSync(join(dirname(manifestPath), 'book.txt'), 'utf8');

/** 第 1 章缓存换成旧格式正文(sha/chars 同步改),检查点的 contentFormat 按参数删除、改写或保留。 */
function plantStaleCheckpoint(manifestPath: string, contentFormat: number | 'missing' | 'keep') {
  const saved = readJson(manifestPath);
  writeFileSync(join(dirname(manifestPath), saved.chapters[0].file), STALE);
  saved.chapters[0].sha256 = sha256(STALE);
  saved.chapters[0].chars = [...STALE].length;
  if (contentFormat === 'missing') delete saved.contentFormat;
  else if (contentFormat !== 'keep') saved.contentFormat = contentFormat;
  writeFileSync(manifestPath, JSON.stringify(saved, null, 2) + '\n');
}

/** 不续传的判据:章节全部重新请求,旧缓存正文不进新书,新检查点写回当前格式。 */
async function expectRefetched(f: ReturnType<typeof setup>) {
  f.calls.length = 0;
  const second = await f.run();
  expect(second.code).toBe(0);
  expect(f.chapterCalls()).toBe(CHAPTERS.length);
  const text = bookText(second.manifestPath);
  expect(text).not.toContain(STALE);
  expect(text).toContain(CHAPTERS[0].text);
  expect(readJson(second.manifestPath).contentFormat).toBe(ENGINE_CONTENT_FORMAT);
}

describe('续传判定含正文格式版本(41-RESUMEFMT)', () => {
  it('旧检查点(无 contentFormat,视为 1)⇒ 不续传:章节全部重新请求,旧缓存正文不进新书', async () => {
    const f = setup();
    const first = await f.run();
    expect(first.code).toBe(0);
    plantStaleCheckpoint(first.manifestPath, 'missing');
    await expectRefetched(f);
  });

  it('同格式 ⇒ 续传命中:章节零请求,沿用缓存(连缓存里的旧正文也原样沿用,所以格式变了必须让它失效)', async () => {
    const f = setup();
    const first = await f.run();
    expect(first.code).toBe(0);
    expect(readJson(first.manifestPath).contentFormat).toBe(ENGINE_CONTENT_FORMAT);
    plantStaleCheckpoint(first.manifestPath, 'keep');
    f.calls.length = 0;
    const second = await f.run();
    expect(second.code).toBe(0);
    expect(f.chapterCalls()).toBe(0);
    expect(bookText(second.manifestPath)).toContain(STALE);
  });

  // +1 对应回滚:新版本写下的检查点,旧版本也不能续传(它不认得那种格式)。
  it.each([ENGINE_CONTENT_FORMAT - 1, ENGINE_CONTENT_FORMAT + 1])('格式不同(检查点为 %s)⇒ 不续传:章节全部重新请求', async (format) => {
    const f = setup();
    const first = await f.run();
    expect(first.code).toBe(0);
    plantStaleCheckpoint(first.manifestPath, format);
    await expectRefetched(f);
  });
});
