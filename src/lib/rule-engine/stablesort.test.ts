// stablesort1030：ENGINE_SYNTAX_STABLE_SORT —— jsoup 包装里的 Array.sort 按 Rhino 1.8.0（Java Arrays.sort = TimSort）求值。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createScope, evaluateField, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule } from './parse';
import { engineSyntaxStableSortEnabled } from './syntax-flags';
import { RuleEngineError } from './types';

const PAGE = '<ul><li>一</li><li>二</li></ul>';
const CONTENT = 'ruleContent.content';
// java.getElements 让整段走 jsoup 包装（sort 换成包装版）。
const rule = (body: string) => parseFieldRule(`@js:var els = java.getElements("li"); ${body}`, {
  field: CONTENT, jsEnabled: true, jsoupEnabled: true,
});
const run = (body: string) => evaluateField(rule(body), createScope(normalizeBody(PAGE), 'https://sort.test/c/1.html'));
const failure = (body: string): string | undefined => {
  try {
    run(body);
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.message : `non-engine:${String(err)}`;
  }
};

const TIES = 'var a = [{k:1,v:"a"},{k:0,v:"b"},{k:1,v:"c"},{k:0,v:"d"}]; a.sort(function(x, y){ return x.k - y.k; });'
  + ' a.map(function(e){ return e.v; }).join(",") + "|" + els.text()';

beforeAll(async () => {
  await preloadJsSandbox();
});
afterEach(() => vi.unstubAllEnvs());

describe('开关', () => {
  it('engineSyntaxStableSortEnabled 严格口径', () => {
    expect(engineSyntaxStableSortEnabled({})).toBe(false);
    expect(engineSyntaxStableSortEnabled({ ENGINE_SYNTAX_STABLE_SORT: '0' })).toBe(false);
    expect(engineSyntaxStableSortEnabled({ ENGINE_SYNTAX_STABLE_SORT: 'yes' })).toBe(false);
    expect(engineSyntaxStableSortEnabled({ ENGINE_SYNTAX_STABLE_SORT: ' On ' })).toBe(true);
    expect(engineSyntaxStableSortEnabled({ ENGINE_SYNTAX_STABLE_SORT: 'true' })).toBe(true);
  });
});

describe('求值', () => {
  it('非同值并列项：off 失败，on 按稳定次序', () => {
    expect(failure(TIES)).toContain('并列项');
    vi.stubEnv('ENGINE_SYNTAX_STABLE_SORT', '1');
    expect(run(TIES)).toBe('b,d,a,c|一 二');
  });

  it('无并列项与同值并列两态相同', () => {
    const plain = '[3, 1, 2, 1].sort().join(",") + [10, 9, 1].sort(function(x, y){ return y - x; }).join(",")';
    expect(run(plain)).toBe('1,1,2,310,9,1');
    vi.stubEnv('ENGINE_SYNTAX_STABLE_SORT', '1');
    expect(run(plain)).toBe('1,1,2,310,9,1');
  });

  it('比较器 NaN 记 +1、-0 记 -1（Double.compare）：off 失败，on 按 Java TimSort 走法', () => {
    const nan = '[{k:1},{k:2},{k:0}].sort(function(x, y){ return x.z - y.z; }).map(function(e){ return e.k; }).join(",")';
    const negZero = '[1, 2].sort(function(){ return -0; }).join(",")';
    const always = '[1, 2, 3].sort(function(){ return 1; }).join(",")';
    expect(failure(nan)).toBeDefined();
    expect(failure(always)).toContain('前后不一致');
    vi.stubEnv('ENGINE_SYNTAX_STABLE_SORT', '1');
    expect(run(nan)).toBe('1,2,0');
    expect(run(negZero)).toBe('2,1');
    expect(run(always)).toBe('1,2,3');
  });

  it('undefined 排后、空位最后并删除', () => {
    const body = 'var a = [3, undefined, 1, , 2]; a.sort(); a.length + ":" + a.join(",") + ":" + (3 in a) + (4 in a)';
    vi.stubEnv('ENGINE_SYNTAX_STABLE_SORT', '1');
    expect(run(body)).toBe('5:1,2,3,,:truefalse');
  });

  // 期望值取自 JDK 21 Arrays.sort（TimSort 与 OpenJDK 17 / Android libcore 同码）同输入同比较器的实跑结果。
  const incons = (n: number, m: number) => `var a = []; for (var i = 0; i < ${n}; i++) a.push((i * 7) % ${n});`
    + ` a.sort(function(x, y){ return Math.sign(((x * 7 + y * 3) % ${m}) - ${m >> 1}); }); a.join(",")`;
  it('不一致比较器（n≥32 走归并）：结果与 Java 逐位一致', () => {
    vi.stubEnv('ENGINE_SYNTAX_STABLE_SORT', '1');
    expect(run(incons(40, 13))).toBe('4,0,14,18,27,1,36,10,19,12,38,25,20,7,17,8,34,30,21,22,31,5,3,29,33,37,11,24,15,35,9,16,28,2,13,39,23,32,6,26');
  });

  it('TimSort 抛 IllegalArgumentException：数组原样返回', () => {
    vi.stubEnv('ENGINE_SYNTAX_STABLE_SORT', '1');
    expect(run(incons(70, 3))).toBe(Array.from({ length: 70 }, (_v, i) => (i * 7) % 70).join(','));
  });
});
