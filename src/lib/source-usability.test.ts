import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineSourceUsable, missingEngineFields, searchTemplateRejected } from './source-usability';

// 41-swq：引擎源运行时可用性判据（取书池/扇出进池前筛选与 probe compile_failed 共用）。
// host 门用默认白名单（book15.net ↔ www.book15.net），不刷全局门状态。
const usableRules = () => ({
  ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
  ruleToc: { chapterList: '.ch', chapterName: 'a@text' },
  ruleContent: { content: '.c' },
});
const sourceWith = (searchUrl: unknown, rules: Record<string, unknown> = usableRules()) => ({
  url: 'https://book15.net/', searchUrl, rules,
});
// rvswq-scratch/probe-searchurl.mjs 的反例：legado `url,{options}` POST 模板（gbk 表单 body + 白名单头）。
const POST_TEMPLATE = 'https://book15.net/search,{"method":"POST","body":"kw={{key}}","charset":"gbk","headers":{"Referer":"https://book15.net/"}}';

afterEach(() => { vi.unstubAllEnvs(); });

describe('source-usability（41-swq 引擎源运行时可用性）', () => {
  it('可用源不被筛：GET 模板在门内、必需字段齐全', () => {
    const source = sourceWith('https://book15.net/s?q={{key}}');
    expect(searchTemplateRejected(source, '书')).toBe(false);
    expect(missingEngineFields(source)).toEqual([]);
    expect(engineSourceUsable(source)).toBe(true);
  });

  it('筛除一：搜索模板指向 host 门外（准入记 search_ok、运行时必拒的 sfacg 形态）', () => {
    const source = sourceWith('https://m.sfacg.com/s?q={{key}}');
    expect(searchTemplateRejected(source, '书')).toBe(true);
    expect(engineSourceUsable(source)).toBe(false);
  });

  it('筛除二：动态搜索模板（JS / 缺 {{key}}）', () => {
    for (const searchUrl of ['https://book15.net/s?q={{key}}@js:result', 'https://book15.net/s', undefined]) {
      expect(searchTemplateRejected(sourceWith(searchUrl), '书'), String(searchUrl)).toBe(true);
      expect(engineSourceUsable(sourceWith(searchUrl)), String(searchUrl)).toBe(false);
    }
  });

  it('筛除三：必需字段缺失或编译不过', () => {
    const missing = sourceWith('https://book15.net/s?q={{key}}', { ...usableRules(), ruleContent: {} });
    expect(missingEngineFields(missing)).toEqual(['ruleContent.content']);
    expect(engineSourceUsable(missing)).toBe(false);
    const rules = usableRules();
    const skipped = sourceWith('https://book15.net/s?q={{key}}', { ...rules, ruleToc: { ...rules.ruleToc, chapterList: '<js>result</js>' } });
    expect(missingEngineFields(skipped)).toEqual(['ruleToc.chapterList']);
    expect(engineSourceUsable(skipped)).toBe(false);
  });

  // 审查 §6.1：判据须与 engineSearchBook 同一分支，否则 ENGINE_POST_SEARCH 开时可用的 POST 源被整类误筛。
  it('POST 选项模板：ENGINE_POST_SEARCH 关时筛掉（与现网 GET 口径一致），开时不筛', () => {
    vi.stubEnv('ENGINE_POST_SEARCH', '');
    expect(searchTemplateRejected(sourceWith(POST_TEMPLATE), '书')).toBe(true);
    expect(engineSourceUsable(sourceWith(POST_TEMPLATE))).toBe(false);
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    expect(searchTemplateRejected(sourceWith(POST_TEMPLATE), '书')).toBe(false);
    expect(engineSourceUsable(sourceWith(POST_TEMPLATE))).toBe(true);
    // 开关开时照样守 host 门、照样拒 JS 与非白名单选项。
    expect(searchTemplateRejected(sourceWith(POST_TEMPLATE.replace('book15.net/search', 'm.sfacg.com/search')), '书')).toBe(true);
    expect(searchTemplateRejected(sourceWith('https://book15.net/s,{"method":"POST","body":"k={{key}}@js:1"}'), '书')).toBe(true);
    expect(searchTemplateRejected(sourceWith('https://book15.net/s,{"method":"POST","body":"k={{key}}","webView":true}'), '书')).toBe(true);
  });
});
