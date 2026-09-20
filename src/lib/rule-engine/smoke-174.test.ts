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

  it('结构化诊断保持 114/60 行为基线，并覆盖设计中的主要拒绝桶', () => {
    const rejected = sources.map((source) => compileCoreFieldsFromRules(source.coreRules)).filter((result) => !result.ok);
    expect(rejected).toHaveLength(60);
    const codes = new Set(rejected.flatMap((result) => result.failures.map((failure) => failure.diagnostic.code)));
    expect([...codes]).toEqual(expect.arrayContaining([
      'unsupported_operator', 'unsupported_var_get', 'unsupported_var_put',
      'unsupported_template_var', 'unsupported_template_js', 'unsupported_xpath', 'regex_only',
    ]));
  });

  it('结构化拒绝桶计数与设计 §2.5 一致（按源去重）', () => {
    const counts: Record<string, number> = {};
    for (const source of sources) {
      const buckets = new Set(compileCoreFieldsFromRules(source.coreRules).failures.map(({ diagnostic }) =>
        diagnostic.code === 'unsupported_operator' ? diagnostic.operator! : diagnostic.code));
      for (const bucket of buckets) counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    expect(counts).toMatchObject({
      '||': 30,
      unsupported_var_get: 13,
      unsupported_template_var: 12,
      unsupported_var_put: 7,
      regex_only: 6,
      unsupported_template_js: 5,
      unsupported_xpath: 3,
      '&&': 2,
      '%%': 2,
      unsupported_template_rule: 1,
      unsupported_special_var: 1,
      unsupported_jsonpath: 1,
    });
  });

  it('book15（📂网阅小说）在通过集内——M1 对拍基线（任务 2 依赖）', () => {
    const book15 = sources.find((s) => s.name === '📂网阅小说');
    expect(book15, 'fixture 应含 book15 条目').toBeDefined();
    const result = compileCoreFieldsFromRules(book15!.coreRules);
    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
  });

  // ---------------- P1a（task-syntax-p1a 验收）：ENGINE_SYNTAX_OR 两态口径 ----------------
  // off（默认 env）：全量 174/114/60 与旧基线逐字一致——上面的冻结断言即 off 态，
  // 这里再显式传 { orEnabled: false } 跑一遍，锁住「显式 off」与「默认 off」等价。
  it('P1a off（显式 orEnabled:false）：114/60 与默认态完全一致', () => {
    const explicitOff = sources.filter((s) => compileCoreFieldsFromRules(s.coreRules, { orEnabled: false }).ok);
    expect(explicitOff.length).toBe(114);
    const rejected = sources.map((s) => compileCoreFieldsFromRules(s.coreRules, { orEnabled: false })).filter((r) => !r.ok);
    expect(rejected).toHaveLength(60);
  });

  it('P1a on：|| 桶 30 源全部 compile-ok（133/41）；其余桶结论不因 || 放开而漂移', () => {
    const onOk = sources.filter((s) => compileCoreFieldsFromRules(s.coreRules, { orEnabled: true }).ok);
    expect(onOk.length).toBe(133); // 114 + 19（|| 单桶救回：9559 之外的 19 源，见报告）
    // || 桶（off 态诊断 operator='||' 的 30 源）在 on 态的结局：
    const orBucket = sources.filter((s) => compileCoreFieldsFromRules(s.coreRules).failures.some((f) => f.diagnostic.operator === '||'));
    expect(orBucket.length).toBe(30);
    // 其一：30 源中 19 源 on 态全核心字段编译通过（其余 11 源还叠着 @get/@put/{{var}}/regex_only/&& 桶）。
    const rescued = orBucket.filter((s) => compileCoreFieldsFromRules(s.coreRules, { orEnabled: true }).ok);
    expect(rescued.length).toBe(19);
    // 其二：|| 桶之外（144 源）两态结论必须逐源一致——|| 不连带救回/误伤别的桶。
    for (const s of sources) {
      if (orBucket.includes(s)) continue;
      expect(
        compileCoreFieldsFromRules(s.coreRules).ok,
        `${s.name} 非 || 桶源在 on 态漂移`,
      ).toBe(compileCoreFieldsFromRules(s.coreRules, { orEnabled: true }).ok);
    }
    // 其三：on 态新失败的诊断全部是既有已知桶（无 || 之外的新构件被引进；
    // 与 off 态同款已知桶集合——unsupported_template_rule/special_var/jsonpath 也在
    // 既有 60 拒绝的诊断集内，见上面「结构化诊断保持 114/60 行为基线」）。
    const onRejected = sources.flatMap((s) => compileCoreFieldsFromRules(s.coreRules, { orEnabled: true }).failures.map((f) => f.diagnostic.code));
    expect(new Set(onRejected)).toEqual(new Set([
      'unsupported_operator', 'unsupported_var_get', 'unsupported_var_put',
      'unsupported_template_var', 'unsupported_template_js', 'unsupported_xpath', 'regex_only',
      'unsupported_template_rule', 'unsupported_special_var', 'unsupported_jsonpath',
    ]));
  });

  it('P1a on：|| 诊断桶清零（operator:"||" 不再出现在 on 态 failures）', () => {
    const orFailures = sources.flatMap((s) => compileCoreFieldsFromRules(s.coreRules, { orEnabled: true }).failures)
      .filter((f) => f.diagnostic.operator === '||');
    expect(orFailures).toEqual([]);
    // && / %% 桶不受影响（P1b 前仍拒）。
    const mixed = sources.flatMap((s) => compileCoreFieldsFromRules(s.coreRules, { orEnabled: true }).failures)
      .filter((f) => f.diagnostic.operator === '&&' || f.diagnostic.operator === '%%');
    expect(mixed.length).toBeGreaterThan(0);
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
