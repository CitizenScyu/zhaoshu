// purememo1031（ENGINE_JS_PURE_MEMO）：只读 baseUrl 的纯模板 `{{JS}}` 按（代码, baseUrl）记忆；preludegrace1031（ENGINE_JS_PRELUDE_GRACE）
// 只放宽 prelude 段时限，规则代码照旧 250ms 中断。规则均为合成形态（kuwo 目录 chapterUrl 同形）。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createScope, evaluateField, evaluateFieldList, normalizeBody, pureTemplateJs } from './evaluate';
import * as sandbox from './js-sandbox';
import { parseFieldRule } from './parse';
import { engineJsPreludeGraceEnabled, engineJsPureMemoEnabled } from './syntax-flags';
import { RuleEngineError } from './types';

vi.mock('./js-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./js-sandbox')>();
  return { ...actual, runJs: vi.fn(actual.runJs) };
});

const PAGE = 'https://appi.kuwo.cn/novels/api/book/1/chapters?paging=0';
const BODY = JSON.stringify({ data: [{ chapter_id: 11 }, { chapter_id: 12 }, { chapter_id: 13 }] });
const URL_RULE = "{{baseUrl.replace('?paging=0','')}}/{{$.chapter_id}}";

function chapterUrls(pageUrl: string): string[] {
  const page = createScope(normalizeBody(BODY), pageUrl);
  const items = evaluateFieldList(parseFieldRule('$.data', { field: 'ruleToc.chapterList' }), page);
  const url = parseFieldRule(URL_RULE, { jsEnabled: true, jsBindEnabled: true, field: 'ruleToc.chapterUrl' });
  return items.map((item) => evaluateField(url, item));
}

beforeAll(async () => { await sandbox.preloadJsSandbox(); });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(sandbox.runJs).mockClear();
});

describe('开关', () => {
  it('两个开关严格口径、缺省关', () => {
    for (const fn of [engineJsPureMemoEnabled, engineJsPreludeGraceEnabled]) {
      expect(fn({})).toBe(false);
      expect(fn({ ENGINE_JS_PURE_MEMO: 'yes', ENGINE_JS_PRELUDE_GRACE: 'yes' })).toBe(false);
      expect(fn({ ENGINE_JS_PURE_MEMO: ' On ', ENGINE_JS_PRELUDE_GRACE: ' On ' })).toBe(true);
    }
  });
});

describe('purememo1031 纯模板判据', () => {
  it.each([
    "baseUrl.replace('?paging=0','')",
    'baseUrl.split("?").toString()',
    'String(baseUrl).toLowerCase() + "/x"',
    "'abc'",
  ])('纯：%s', (code) => expect(pureTemplateJs(code)).toBe(true));

  it.each([
    'result.replace("a","b")',
    'src.length',
    'java.base64Encode(baseUrl)',
    'book.origin + baseUrl',
    'String(baseUrl).match(/\\d+/)',
    'baseUrl.split("?")[0]',
    '`${baseUrl}`',
    "baseUrl['constructor']",
    'baseUrl.replace("a", Math.random())',
    '(function(){ return baseUrl })()',
  ])('不纯：%s', (code) => expect(pureTemplateJs(code)).toBe(false));
});

describe('purememo1031 目录 chapterUrl', () => {
  const expected = (base: string) => [11, 12, 13].map((id) => `${base}/${id}`);

  it('缺省关：逐条进沙箱', () => {
    expect(chapterUrls(PAGE)).toEqual(expected('https://appi.kuwo.cn/novels/api/book/1/chapters'));
    expect(sandbox.runJs).toHaveBeenCalledTimes(3);
  });

  it('开：同页同值只进一次沙箱，换页另算，结果与关态逐字相同', () => {
    vi.stubEnv('ENGINE_JS_PURE_MEMO', '1');
    const other = PAGE.replace('/book/1/', '/book/2/');
    expect(chapterUrls(PAGE)).toEqual(expected('https://appi.kuwo.cn/novels/api/book/1/chapters'));
    expect(chapterUrls(PAGE)).toEqual(expected('https://appi.kuwo.cn/novels/api/book/1/chapters'));
    expect(chapterUrls(other)).toEqual(expected('https://appi.kuwo.cn/novels/api/book/2/chapters'));
    expect(sandbox.runJs).toHaveBeenCalledTimes(2);
  });

  it('开：名单外的模板（Math.*）照旧逐条求值', () => {
    vi.stubEnv('ENGINE_JS_PURE_MEMO', '1');
    const page = createScope(normalizeBody(BODY), PAGE);
    const items = evaluateFieldList(parseFieldRule('$.data', { field: 'ruleToc.chapterList' }), page);
    const url = parseFieldRule('{{Math.max(1, 2)}}-{{$.chapter_id}}', { jsEnabled: true, jsBindEnabled: true, field: 'ruleToc.chapterUrl' });
    expect(items.map((item) => evaluateField(url, item))).toEqual(['2-11', '2-12', '2-13']);
    expect(sandbox.runJs).toHaveBeenCalledTimes(3);
  });
});

describe('preludegrace1031', () => {
  it('开：正常求值不变，死循环照旧按规则时限中断', () => {
    vi.stubEnv('ENGINE_JS_PRELUDE_GRACE', '1');
    expect(sandbox.runJs('baseUrl + 1', { result: '', baseUrl: PAGE })).toBe(`${PAGE}1`);
    const started = Date.now();
    let error: unknown;
    try { sandbox.runJs('while (true) {} // grace-loop', { result: '', baseUrl: PAGE }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RuleEngineError);
    expect((error as Error).message).toContain('JS 执行失败');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
