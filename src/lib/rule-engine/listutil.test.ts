// listutil1029：ENGINE_SYNTAX_JS_UTIL 的加解密 / toNumChapter / t2s 帮手在列表字段（bookList / chapterList）的 JS 链里同样放行，
// 求值期只给标了 jsUtil 的列表字段装帮手。编译口径、按源判定、门面求值。规则与页面均为合成形态。
import { beforeAll, describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchToc, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesJsUtilSyntax } from './compile';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions, type SourceConsts } from './parse';
import { RuleEngineError } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const TOC_URL = `${SITE}/book/1/`;
const ON = { jsEnabled: true, listJsEnabled: true, jsUtilEnabled: true } as const;
const OFF = { ...ON, jsUtilEnabled: false } as const;
const TOC = 'ruleToc.chapterList';
const list = (rule: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field: TOC });
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const tocRules = (chapterList: string) => ({ ruleToc: { chapterList, chapterName: 'a@text', chapterUrl: 'a@href' } });
const PAGE = '<ul><li><a href="/c/1.html">第一章 這裡</a></li><li><a href="/c/2.html">光碟機</a></li></ul>';

function source(rules: Record<string, unknown>, options: ParseOptions = ON): EngineSource {
  const r = raw(rules);
  return { url: SITE, name: '列表帮手源', searchUrl: r.searchUrl, compiled: compileSource(r, options) };
}

const anyPage = (text: string) => ({ page: async (url: string) => ({ url, text }) } as unknown as SourceRequestContext);

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('编译', () => {
  it('on 态列表 JS 收帮手并标 jsUtil；不用帮手的列表 JS 不标', () => {
    expect(list('<js>java.t2s(result)</js>tag.li').jsUtil).toBe(true);
    expect(list('@js:var a = java.toNumChapter("第一章"); [{text: String(a), href: "/c/1.html"}]').jsUtil).toBe(true);
    expect(list('<js>result</js>tag.li').jsUtil).toBeUndefined();
  });

  it('off 态照旧拒；t2s 结果当 JS 字符串用照旧拒', () => {
    expect(codeOf(() => list('<js>java.t2s(result)</js>tag.li', OFF))).toBe('unsupported_js');
    expect(codeOf(() => list('<js>java.t2s(result).length</js>tag.li'))).toBe('unsupported_js');
    expect(codeOf(() => list('<js>"x" + java.t2s(result)</js>tag.li'))).toBeUndefined();
  });

  it('注释 eval 同字段口径：注释里的完成值拒，String() 包住过', () => {
    const at = (comment: string) => () => list('<js>eval(String(source.bookSourceComment)); f(result)</js>tag.li',
      { jsExtEnabled: true, jsBindEnabled: true, sourceConsts: { key: SITE, comment } satisfies SourceConsts });
    expect(codeOf(at('function f(s) { return s }\njava.t2s("x")'))).toBe('unsupported_js');
    expect(codeOf(at('function f(s) { return String(java.t2s(s)) }'))).toBeUndefined();
  });
});

describe('按源判定', () => {
  it('只有列表 JS 里 off 拒、on 过的源换版本、算用到帮手', () => {
    const opts = (jsUtilEnabled: boolean) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled: true, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: true, jsExtEnabled: false, jsBindEnabled: false,
      jsGetEnabled: false, jsUtilEnabled,
    });
    const used = raw(tocRules('<js>java.t2s(result)</js>tag.li'));
    const plain = raw(tocRules('<js>result</js>tag.li'));
    expect(engineSourceRevision(used, opts(true))).not.toBe(engineSourceRevision(used, opts(false)));
    expect(engineSourceRevision(plain, opts(true))).toBe(engineSourceRevision(plain, opts(false)));
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: true, jsExtEnabled: false, jsBindEnabled: false, jsGetEnabled: false,
    };
    expect(sourceUsesJsUtilSyntax(used.rules, flags)).toBe(true);
    expect(sourceUsesJsUtilSyntax(plain.rules, flags)).toBe(false);
    expect(sourceUsesJsUtilSyntax(used.rules, { ...flags, listJsEnabled: false })).toBe(false);
  });
});

describe('门面求值', () => {
  it('engineFetchToc：列表 JS 先繁转简再取条目', async () => {
    const toc = await engineFetchToc(source(tocRules('<js>java.t2s(result)</js>tag.li')), TOC_URL, anyPage(PAGE));
    expect(toc.chapters).toEqual([
      { url: `${SITE}/c/1.html`, title: '第一章 这里' },
      { url: `${SITE}/c/2.html`, title: '光驱' },
    ]);
  });

  it('engineFetchToc：off 态列表 skipped，无章节', async () => {
    const toc = await engineFetchToc(source(tocRules('<js>java.t2s(result)</js>tag.li'), OFF), TOC_URL, anyPage(PAGE))
      .catch(() => undefined);
    expect(toc?.chapters ?? []).toEqual([]);
  });

  it('末段 JS 用帮手产出对象条目', async () => {
    const rule = '@js:[{text: String(java.toNumChapter("第一章")) + "|" + java.t2s("這裡"), href: "/c/9.html"}]';
    const toc = await engineFetchToc(source({ ruleToc: { chapterList: rule, chapterName: 'text', chapterUrl: 'href' } }), TOC_URL,
      anyPage(PAGE));
    expect(toc.chapters).toEqual([{ url: `${SITE}/c/9.html`, title: '第1章|这里' }]);
  });
});
