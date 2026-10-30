// toctime1030：strict 目录（下载）不因只供展示的 ruleToc.updateTime 编不过而整源拒绝（ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME）。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchToc, strictTocUnsupported, type EngineSource } from './api';
import { compileSource } from './compile';
import { engineTocStrictIgnoreUpdateTimeEnabled } from './syntax-flags';

const SITE = 'https://book15.net'; // 过 host 门（.example 保留域取页被拒）
const TOC = `${SITE}/t/1.html`;
const page = `<ul>${[1, 2].map((n) => `<li class="ch"><a href="/c/${n}.html">第${n}章</a></li>`).join('')}</ul>`;
const src = (toc: Record<string, string>): EngineSource => {
  const rules = { ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href', ...toc }, ruleContent: { content: '.content@html' } };
  return { url: SITE, name: '合成源', searchUrl: `${SITE}/s?q={{key}}`, compiled: compileSource({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules }) };
};
const ctx = (): SourceRequestContext => ({
  page: async (url: string) => {
    if (url !== TOC) throw new Error('Unexpected request: ' + url);
    return { url, text: page };
  },
}) as unknown as SourceRequestContext;

describe('toctime1030', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('开关严格口径', () => {
    expect(engineTocStrictIgnoreUpdateTimeEnabled({})).toBe(false);
    expect(engineTocStrictIgnoreUpdateTimeEnabled({ ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME: '0' })).toBe(false);
    expect(engineTocStrictIgnoreUpdateTimeEnabled({ ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME: 'yes' })).toBe(false);
    expect(engineTocStrictIgnoreUpdateTimeEnabled({ ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME: ' On ' })).toBe(true);
    expect(engineTocStrictIgnoreUpdateTimeEnabled({ ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME: 'true' })).toBe(true);
  });

  it('只有 updateTime 被 skip：on strict 出章节，off strict 抛 unsupported_toc_rule', async () => {
    const s = src({ updateTime: '{{java.timeFormat(1)}}' });
    expect('skipped' in (s.compiled.get('ruleToc.updateTime') ?? {})).toBe(true);
    await expect(engineFetchToc(s, TOC, ctx(), true)).rejects.toThrow('unsupported_toc_rule');
    vi.stubEnv('ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME', '1');
    const toc = await engineFetchToc(s, TOC, ctx(), true);
    expect(toc.chapters.map((c) => c.title)).toEqual(['第1章', '第2章']);
  });

  it('其他 ruleToc 字段被 skip 时 on 照旧抛', async () => {
    vi.stubEnv('ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME', '1');
    const s = src({ updateTime: '{{java.timeFormat(2)}}', isVip: '@js:true' });
    expect('skipped' in (s.compiled.get('ruleToc.isVip') ?? {})).toBe(true);
    await expect(engineFetchToc(s, TOC, ctx(), true)).rejects.toThrow('unsupported_toc_rule');
  });

  it('非 strict 两态都出章节', async () => {
    const toc = await engineFetchToc(src({ updateTime: '{{java.timeFormat(3)}}' }), TOC, ctx());
    expect(toc.chapters).toHaveLength(2);
  });

  it('toctgate1030：strictTocUnsupported 与 strict 目录同判', () => {
    expect(strictTocUnsupported(src({}).compiled)).toBe(false);
    const time = src({ updateTime: '{{java.timeFormat(4)}}' }).compiled;
    expect(strictTocUnsupported(time)).toBe(true);
    vi.stubEnv('ENGINE_TOC_STRICT_IGNORE_UPDATE_TIME', '1');
    expect(strictTocUnsupported(time)).toBe(false);
    expect(strictTocUnsupported(src({ isVip: '@js:false' }).compiled)).toBe(true);
  });
});
