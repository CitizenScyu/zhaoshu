import { describe, expect, it } from 'vitest';
import corpus from './fixtures/smoke-174.json';
import { compileCoreFieldsFromRules, selectCandidates, type RawSource } from './compile-smoke';

// 174 源 compile 冒烟（设计 §8.2；滤网 1 验收仪表）。
//
// 冻结数字 = 114（design-faithful compile），非设计文档写的 113、亦非中途 111。
// 差异全部已排查并归因（不硬调数字凑绿，见 m1-task1-report.md「冒烟数字」节）：
//   设计 113 来自 survey.py 构件模型，该模型有两类系统性误差：
//   (A) 5 处 false-reject：CSS `:contains()` 被 survey 的 xpath 正则（含 `contains(`）误判为 xpath
//       —— 实为合法 M1 css_pseudo，faithful compile 正确接纳（+5）。
//   (B) 4 处 false-accept：survey 无以下检测器，faithful compile 正确拒绝（-4）：
//       - 2× `%%` 拼接（双语小说英/中；设计 §2.1 归 T7）；
//       - 1× `@baseUrl` legado 特殊变量（知妖；§2.3 第5条不猜测，主会话已裁定拒绝）；
//       - 1× `$2` 非法 JSONPath（疯情阅读2；§2.2「$ 后跟非上述语法 → RULE_UNSUPPORTED」）。
//   113 = 114 − 5(A) + 4(B)。faithful = 114。

interface FixtureSource {
  name: string;
  url: string;
  coreRules: Record<string, string>;
}

const sources = corpus as FixtureSource[];

describe('174 源 compile 冒烟', () => {
  it('fixture 冻结了 174 个初筛候选源的核心字段', () => {
    expect(sources.length).toBe(174);
  });

  it('核心字段可解释源数 = 114（数字冻结；变动即提醒重新决策档位）', () => {
    const passed = sources.filter((s) => compileCoreFieldsFromRules(s.coreRules).ok);
    expect(passed.length).toBe(114);
  });

  it('book15（📂网阅小说）在通过集内——M1 对拍基线（任务 2 依赖）', () => {
    const book15 = sources.find((s) => s.name === '📂网阅小说');
    expect(book15, 'fixture 应含 book15 条目').toBeDefined();
    const result = compileCoreFieldsFromRules(book15!.coreRules);
    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
  });

  it('失败源的原因全部落在已知不支持构件（无非预期错误）', () => {
    const knownReasons = [
      '||', '&&', '%%', // 并联/拼接（T7）
      '@get', '@put', // 变量存取
      'XPath', 'xpath',
      'tpl_var', 'tpl_rule', 'tpl_js_expr', '模板含',
      'baseUrl', '特殊变量',
      'JSONPath 不支持',
      '@js:', '<js>',
      'match:',
      '正则-only', // 无选择器主体的独立正则（非 M1 集）
    ];
    const unexpected: { name: string; message: string }[] = [];
    for (const s of sources) {
      const r = compileCoreFieldsFromRules(s.coreRules);
      if (r.ok) continue;
      for (const f of r.failures) {
        if (!knownReasons.some((k) => f.message.includes(k))) {
          unexpected.push({ name: s.name, message: f.message });
        }
      }
    }
    expect(unexpected, JSON.stringify(unexpected)).toEqual([]);
  });
});

describe('survey 初筛函数移植（selectCandidates）', () => {
  it('在合成数据上复现初筛门槛（HTTPS+无JS+纯GET+bookList+content+非听书）', () => {
    const synthetic: RawSource[] = [
      {
        // 合格
        bookSourceUrl: 'https://ok.example.com',
        searchUrl: 'https://ok.example.com/s?key={{key}}',
        ruleSearch: { bookList: '.list', name: 'h3@text' },
        ruleContent: { content: '.c@html' },
      },
      { bookSourceUrl: 'http://insecure.example.com', searchUrl: 'http://x/s?key={{key}}', ruleSearch: { bookList: '.l' }, ruleContent: { content: '.c' } },
      { bookSourceUrl: 'https://js.example.com', searchUrl: 'https://x/s?key={{key}}', ruleSearch: { bookList: '@js:x' }, ruleContent: { content: '.c' } },
      { bookSourceUrl: 'https://nopget.example.com', searchUrl: 'https://x/s?q=1', ruleSearch: { bookList: '.l' }, ruleContent: { content: '.c' } },
      { bookSourceUrl: 'https://nolist.example.com', searchUrl: 'https://x/s?key={{key}}', ruleSearch: {}, ruleContent: { content: '.c' } },
      { bookSourceUrl: 'https://audio.example.com', searchUrl: 'https://x/s?key={{key}}', bookSourceType: 2, ruleSearch: { bookList: '.l' }, ruleContent: { content: '.c' } },
    ];
    const out = selectCandidates(synthetic);
    expect(out.length).toBe(1);
    expect(out[0].bookSourceUrl).toBe('https://ok.example.com');
  });
});
