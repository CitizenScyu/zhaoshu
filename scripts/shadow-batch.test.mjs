import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSource, evaluateSources, summarize, hostOf, parseArgs } from './shadow-batch.mjs';

// 三个合成源覆盖三条对拍路径(任务书要求 ≥3):
//   both-ok   :off 可编译、on 也可编译 → 无差异
//   or-rescued:含顶层 ||  → off 拒、on 可编译(影子救回)
//   both-bad  :含 @js:    → 两态都不可编译(非 || 救得回)
const BOTH_OK = {
  bookSourceUrl: 'https://both-ok.example.com/',
  searchUrl: 'https://both-ok.example.com/s?q={{key}}',
  ruleSearch: { bookList: '.list li', name: 'h3@text', bookUrl: 'a@href', author: '.author@text' },
  ruleToc: { chapterList: '#toc li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '#content@html' },
};
const OR_RESCUED = {
  bookSourceUrl: 'https://or-rescued.example.com/',
  searchUrl: 'https://or-rescued.example.com/s?q={{key}}',
  ruleSearch: { bookList: '.list||ul li', name: 'h3@text||.title@text', bookUrl: 'a@href||b@href' },
  ruleToc: { chapterList: '#toc li||.toc a', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '#content@html||.body@html' },
};
const BOTH_BAD = {
  bookSourceUrl: 'https://both-bad.example.com/',
  searchUrl: 'https://both-bad.example.com/s?q={{key}}',
  ruleSearch: { bookList: '.list li', name: 'h3@text', bookUrl: 'a@href' },
  ruleToc: { chapterList: '#toc li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '@js:document.body.innerHTML' },
};

describe('shadow-batch:单源对拍', () => {
  it('both-ok:off 与 on 都可编译,无差异字段、无 error', () => {
    const r = evaluateSource(BOTH_OK);
    assert.equal(r.offCompileOk, true);
    assert.equal(r.onShadowCompileOk, true);
    assert.equal(r.diffFields, 0);
    assert.equal(r.rescued, 0);
    assert.equal(r.regressed, 0);
    assert.equal(r.errorSummaries.length, 0);
    assert.equal(r.host, 'both-ok.example.com');
  });

  it('or-rescued:off 拒、on 可编译(|| 影子救回),rescued>0', () => {
    const r = evaluateSource(OR_RESCUED);
    assert.equal(r.offCompileOk, false);
    assert.equal(r.onShadowCompileOk, true);
    assert.ok(r.rescued > 0, `期望有救回字段,实际 rescued=${r.rescued}`);
    assert.equal(r.regressed, 0);
    assert.equal(r.diffFields, r.rescued);
  });

  it('both-bad:@js: 两态都不可编译,非 || 救得回', () => {
    const r = evaluateSource(BOTH_BAD);
    assert.equal(r.offCompileOk, false);
    assert.equal(r.onShadowCompileOk, false);
    assert.equal(r.regressed, 0);
    assert.equal(r.rescued, 0);
    assert.ok(r.errorSummaries.some((e) => e.startsWith('ruleContent.content:')), JSON.stringify(r.errorSummaries));
  });
});

describe('shadow-batch:批量汇总计数', () => {
  it('合计 3 源,源级/字段级两列单位分开且计数正确', () => {
    const rows = evaluateSources([BOTH_OK, OR_RESCUED, BOTH_BAD]);
    const s = summarize(rows);
    // 源级列(Sources 后缀):
    assert.equal(s.totalSources, 3);
    assert.equal(s.offOkSources, 1); // 仅 both-ok off 可编译
    assert.equal(s.onOkSources, 2); // both-ok + or-rescued
    assert.equal(s.withErrorsSources, 1); // 仅 both-bad 有 error 摘要
    // 源级 rescued/regressed:off 拒 ∧ on 可 ∧ 该源字段 rescued>0
    assert.equal(s.rescuedSources, 1); // or-rescued
    assert.equal(s.regressedSources, 0);
    // 字段级列(Fields 后缀):字段加总,单位与源级不同,不可与 Sources 相加
    assert.equal(s.rescuedFields, 5); // or-rescued 的 5 个 || 字段
    assert.equal(s.regressedFields, 0);
    // 谓词标注必须进汇总 JSON(两列源级谓词不同)
    assert.ok(s.offOkPredicate.includes('compileAdmission'), s.offOkPredicate);
    assert.ok(s.onOkPredicate.includes('shadowCompileOk'), s.onOkPredicate);
  });

  it('旧无后缀键已移除(防误读:顶层不得再出现 rescued/offOk 等歧义键)', () => {
    const s = summarize(evaluateSources([BOTH_OK, OR_RESCUED, BOTH_BAD]));
    for (const legacy of ['total', 'offOk', 'onOk', 'withErrors', 'rescued', 'regressed']) {
      assert.equal(legacy in s, false, `汇总不应再含无单位键 ${legacy}`);
    }
  });
});

describe('shadow-batch:参数与工具', () => {
  it('--limit 非法即拒', () => {
    assert.throws(() => parseArgs(['--limit', '0']), /--limit/);
    assert.throws(() => parseArgs(['--limit', 'x']), /--limit/);
  });
  it('未知参数即拒', () => {
    assert.throws(() => parseArgs(['--bogus']), /未知参数/);
  });
  it('hostOf 对非法 URL 返回空串', () => {
    assert.equal(hostOf('not a url'), '');
    assert.equal(hostOf('https://a.b/c'), 'a.b');
  });
});
