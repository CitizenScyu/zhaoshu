import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FILTER_COUNT_KEYS, MAX_SOURCE_PAGE, SOURCE_FILTERS, SOURCE_PAGE_SIZE, availabilityLabel, filterLabel,
  offsetFor, pageCount, parseSourceFilter, parseSourcePage, participationHint, participatesInSearch,
  type ShuyuanSourceFilter,
} from './shuyuan-view';

describe('parseSourceFilter 白名单', () => {
  it('只接受已知筛选 id', () => {
    for (const filter of SOURCE_FILTERS) expect(parseSourceFilter(filter)).toBe(filter);
  });

  // filter 会被拼进 SQL 的谓词比较里，原样透传一个没在白名单里的值等于把判别式交给调用方。
  it.each([null, undefined, '', 'ALL', 'enabled ', 'unknown', "all' OR 1=1 --", 'all"', '0', 'true'])(
    '拒绝非白名单值 %j 并退回 all',
    (value) => expect(parseSourceFilter(value)).toBe('all'),
  );
});

describe('parseSourcePage 页码归一', () => {
  it.each([null, undefined, '', '   ', '0', '-1', '-0.5', 'abc', 'NaN', 'Infinity', '-Infinity', '1.5', '1,000', '٣'])(
    '非法输入 %j 回第 1 页',
    (value) => expect(parseSourcePage(value)).toBe(1),
  );

  it('接受的页码原样返回', () => {
    expect(parseSourcePage('1')).toBe(1);
    expect(parseSourcePage('7')).toBe(7);
    expect(parseSourcePage(' 42 ')).toBe(42);
  });

  // Number() 也认指数和十六进制，所以 '1e3'/'0x10' 不是「非数字」，会各自解析成 1000/16。
  // 与其在这里假装它们非法，不如把真实行为钉住：反正任何接受值都被上限夹住。
  it('指数与十六进制写法按 Number() 取值，仍受上限约束', () => {
    expect(parseSourcePage('1e3')).toBe(MAX_SOURCE_PAGE);
    expect(parseSourcePage('0x10')).toBe(16);
  });

  // OFFSET 直接由页码算出，不封顶的话一个手改的 page=1e9 就是一次全表顺序扫描。
  it('超过上限封顶而不是回退', () => {
    expect(parseSourcePage(String(MAX_SOURCE_PAGE))).toBe(MAX_SOURCE_PAGE);
    expect(parseSourcePage(String(MAX_SOURCE_PAGE + 1))).toBe(MAX_SOURCE_PAGE);
    expect(parseSourcePage('1e9')).toBe(MAX_SOURCE_PAGE);
    expect(parseSourcePage('9007199254740991')).toBe(MAX_SOURCE_PAGE);
  });

  // 任何输入都必须落在一个有限的小区间里：这是 OFFSET 安全性的唯一保证。
  it('任意字符串输入都落在 [1, MAX_SOURCE_PAGE] 内', () => {
    const inputs = [
      '', '0', '-0', '1', '500', '501', '99999999999999999999', '1e309', '-1e309', 'NaN', 'Infinity',
      'abc', '../..', '${offsetFor}', '1 OR 1=1', '\u0000', ' 12 ', '0b101', '0o17', '1.9999999',
    ];
    for (const input of inputs) {
      const page = parseSourcePage(input);
      expect(Number.isSafeInteger(page)).toBe(true);
      expect(page).toBeGreaterThanOrEqual(1);
      expect(page).toBeLessThanOrEqual(MAX_SOURCE_PAGE);
    }
  });
});

describe('pageCount 至少 1 页', () => {
  it.each([[0, 1], [1, 1], [20, 1], [21, 2], [40, 2], [41, 3], [995, 50]])(
    '%i 条按每页 %i 条算出的页数正确',
    (total, expectedPages) => expect(pageCount(total, SOURCE_PAGE_SIZE)).toBe(expectedPages),
  );

  // 空结果必须停在第 1 页，否则页脚会显示「第 1 / 0 页」，上一页按钮的 disabled 条件也会失真。
  it('空结果与非法总数都回落到 1 页，不会返回 0', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(-5)).toBe(1);
    expect(pageCount(Number.NaN)).toBe(1);
    expect(pageCount(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('pageSize 非法时退回默认单页条数，不产生除零或无限页', () => {
    expect(pageCount(25, 0)).toBe(pageCount(25, SOURCE_PAGE_SIZE));
    expect(pageCount(25, -3)).toBe(pageCount(25, SOURCE_PAGE_SIZE));
    expect(pageCount(25, Number.NaN)).toBe(pageCount(25, SOURCE_PAGE_SIZE));
    expect(pageCount(25, 1.5)).toBe(pageCount(25, SOURCE_PAGE_SIZE));
    expect(Number.isFinite(pageCount(25, 0))).toBe(true);
  });
});

describe('offsetFor', () => {
  it('第 1 页偏移 0，之后按单页条数递增', () => {
    expect(offsetFor(1, 20)).toBe(0);
    expect(offsetFor(2, 20)).toBe(20);
    expect(offsetFor(5, 20)).toBe(80);
  });

  it('页码下取整并至少为 1，非法页码不会算出负偏移', () => {
    expect(offsetFor(0, 20)).toBe(0);
    expect(offsetFor(-9, 20)).toBe(0);
    expect(offsetFor(2.9, 20)).toBe(20);
  });

  it('与 SOURCE_PAGE_SIZE 的默认值一致', () => {
    expect(offsetFor(3)).toBe(offsetFor(3, SOURCE_PAGE_SIZE));
    expect(offsetFor(3)).toBe(2 * SOURCE_PAGE_SIZE);
  });
});

describe('文案与计数键完整覆盖', () => {
  it('每个筛选 id 都有非空标签，且互不重复', () => {
    const labels = SOURCE_FILTERS.map(filterLabel);
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(SOURCE_FILTERS.length);
  });

  it('未知筛选 id 退回 all 的标签，而不是 undefined', () => {
    expect(filterLabel('nope' as ShuyuanSourceFilter)).toBe(filterLabel('all'));
  });

  it.each([['unprobed'], ['pending'], ['reachable'], ['failed']] as const)(
    '%s 的探测状态有对应标签',
    (availability) => expect(availabilityLabel(availability)).toBeTruthy(),
  );

  it('未知探测状态回落成未探测，不会渲染出空标签', () => {
    expect(availabilityLabel('bogus' as 'unprobed')).toBe(availabilityLabel('unprobed'));
  });

  it('FILTER_COUNT_KEYS 与 SOURCE_FILTERS 一一对应，没有多余或缺失的键', () => {
    expect(Object.keys(FILTER_COUNT_KEYS).sort()).toEqual([...SOURCE_FILTERS].sort());
  });
});

describe('participationHint 标注「已启用但探测失败」', () => {
  it('已启用且探测失败时必须给出提示，这是开关看不出的一态', () => {
    const source = { disabled: false, availability: 'failed' as const };
    expect(participatesInSearch(source)).toBe(false);
    expect(participationHint(source)).toContain('已启用');
    expect(participationHint(source)).toContain('探测失败');
  });

  it('已禁用时提示禁用，且禁用优先于探测失败', () => {
    expect(participationHint({ disabled: true, availability: 'failed' })).toContain('已禁用');
    expect(participationHint({ disabled: true, availability: 'unprobed' })).toContain('已禁用');
    expect(participationHint({ disabled: true, availability: 'reachable' })).toContain('已禁用');
  });

  it.each([['unprobed'], ['pending'], ['reachable']] as const)(
    '已启用且状态为 %s 时不加提示（这些状态仍会参与搜索）',
    (availability) => {
      expect(participatesInSearch({ disabled: false, availability })).toBe(true);
      expect(participationHint({ disabled: false, availability })).toBe('');
    },
  );

  it('提示与「是否参与搜索」严格互补，没有既无提示又不参与的空档', () => {
    for (const disabled of [true, false]) {
      for (const availability of ['unprobed', 'pending', 'reachable', 'failed'] as const) {
        const source = { disabled, availability };
        expect(participationHint(source) === '').toBe(participatesInSearch(source));
      }
    }
  });
});

// 「卡片上的数字 = 点进去看到的条数」靠的是列表谓词与 countsFromStates 的 FILTER 子句逐条同源。
// 两边都是 SQL 文本，类型系统管不到；加一个筛选 id 只改界面或只改一边时会静默对不上，
// 所以这里从源码里把两处谓词解析出来配对，而不是断言某个固定字符串。
describe('筛选谓词与统计口径同源', () => {
  const source = readFileSync(new URL('./shuyuan.ts', import.meta.url), 'utf8');
  // countsFromStates 的统计列：从它的 SELECT 起、到它自己的 FROM 为止。
  // 必须从这里再找 FROM，否则会命中 getReadingSources 里更早的那一处而切出空串。
  const countsStart = source.indexOf('SELECT count(*)::int AS total');
  const countsBlock = source.slice(countsStart, source.indexOf('FROM shuyuan_sources', countsStart));
  const listBlock = source.slice(
    source.indexOf("WHERE ${filter} = 'all'"), source.indexOf('ORDER BY COALESCE'),
  );

  it('源码里能定位到两段谓词（防止本用例因重命名而静默失效）', () => {
    expect(countsStart).toBeGreaterThan(-1);
    expect(countsBlock).toContain('FILTER (WHERE');
    expect(listBlock).toContain("${filter} = 'all'");
    // LIMIT/OFFSET 排在 ORDER BY 之后，不在 listBlock 里，单独在实现函数体内查。
    const implementation = source.slice(source.indexOf('export async function getShuyuanStats'));
    expect(implementation).toContain('LIMIT ${pageSize} OFFSET ${offsetFor(page, pageSize)}');
  });

  it('每个非 all 的筛选 id 在列表谓词里各出现一次，顺序与 SOURCE_FILTERS 一致', () => {
    const pairs = [...listBlock.matchAll(/\$\{filter\} = '([a-z]+)' AND ([^)]+)\)/g)];
    expect(pairs.map((pair) => pair[1])).toEqual(SOURCE_FILTERS.filter((filter) => filter !== 'all'));
  });

  it('列表谓词与对应的 counts FILTER 子句是同一个条件，数字不会和明细对不上', () => {
    const pairs = [...listBlock.matchAll(/\$\{filter\} = '([a-z]+)' AND ([^)]+)\)/g)];
    expect(pairs.length).toBe(SOURCE_FILTERS.length - 1);
    for (const [, id, predicate] of pairs) {
      expect(countsBlock).toContain(`FILTER (WHERE ${predicate})`);
      // 计数键必须真的出现在统计列里，否则 total 会取到 undefined。
      expect(countsBlock).toMatch(new RegExp(`AS ${FILTER_COUNT_KEYS[id as ShuyuanSourceFilter]}\\b`));
    }
  });

  it('all 分支落到无条件统计，并直接复用 total 计数键', () => {
    expect(FILTER_COUNT_KEYS.all).toBe('total');
    expect(countsBlock).toContain('count(*)::int AS total');
  });

  it('单页条数只用常量 SOURCE_PAGE_SIZE，没有散落的字面量', () => {
    const shuyuan = source.slice(source.indexOf('export async function getShuyuanStats'));
    expect(shuyuan).toContain('SOURCE_PAGE_SIZE');
    expect(shuyuan).not.toMatch(/LIMIT \$\{20\}/);
  });
});
