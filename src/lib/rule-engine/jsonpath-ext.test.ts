// jsonpath1028：ENGINE_SYNTAX_JSON_PATH —— off 态解析不了的 `$` 路径再试 Jayway 的 `.[` 与 `[?(表达式)]`；
// 语义版本位、off/on IR 一致、过滤器文法与求值口径（Jayway 2.9.0 + legado SUPPRESS_EXCEPTIONS）、按源判定、source-usability 缓存口径。
// 全部为合成形态。
import { afterEach, describe, expect, it } from 'vitest';
import { compileSource, engineSourceRevision, sourceUsesJsonPathSyntax } from './compile';
import { createJsonScope, evaluateField, evaluateFieldList } from './evaluate';
import { evalJsonPath, parseJsonPath } from './jsonpath';
import { parseFieldRule } from './parse';
import { ENGINE_SEMANTICS_JSON_PATH_BIT, engineSemanticsVersion, engineSyntaxJsonPathEnabled } from './syntax-flags';
import { RuleEngineError } from './types';

const errorOf = (fn: () => unknown): { code?: string; message: string } | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (!(err instanceof RuleEngineError)) return { message: `non-engine:${String(err)}` };
    return { code: err.diagnostic?.code ?? err.code, message: err.message };
  }
};

const SITE = 'https://book15.net';
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const LIST = 'ruleSearch.bookList';
const BOOK_URL = 'ruleSearch.bookUrl';
const ext = (path: string) => parseJsonPath(path, true);
const run = (path: string, json: unknown) => evalJsonPath(ext(path), json);

describe('开关与语义版本', () => {
  it('engineSyntaxJsonPathEnabled 严格口径', () => {
    expect(engineSyntaxJsonPathEnabled({})).toBe(false);
    expect(engineSyntaxJsonPathEnabled({ ENGINE_SYNTAX_JSON_PATH: '0' })).toBe(false);
    expect(engineSyntaxJsonPathEnabled({ ENGINE_SYNTAX_JSON_PATH: 'yes' })).toBe(false);
    expect(engineSyntaxJsonPathEnabled({ ENGINE_SYNTAX_JSON_PATH: ' On ' })).toBe(true);
    expect(engineSyntaxJsonPathEnabled({ ENGINE_SYNTAX_JSON_PATH: 'TRUE' })).toBe(true);
    expect(engineSyntaxJsonPathEnabled({ ENGINE_SYNTAX_JSON_PATH: '1' })).toBe(true);
  });

  it('JSONPath 位 +16384，1–16384 逐字不变', () => {
    expect(ENGINE_SEMANTICS_JSON_PATH_BIT).toBe(16384);
    const all = [true, true, true, true, true, true, true, true, true, true, true, true, true, true] as const;
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 16384);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, false, false, false, false, false, false, false, true))
      .toBe(engineSemanticsVersion(false) + 16384);
  });
});

describe('parseJsonPath：off 态能解析的路径 IR 不变，扩展只接 off 拒的', () => {
  it('off 已接受的路径（含旧 filterEq）两态 IR 逐字一致', () => {
    for (const path of ['$.a.b', "$['x']", '$.list[?(@.id == 3)]', '$..[0]', '$.a[1:2]', '$.a[0,1]', '$..name', '$.*']) {
      expect(ext(path)).toEqual(parseJsonPath(path));
    }
  });

  it('扩展也解析不了时抛 off 态原错误（诊断桶与文案不变）', () => {
    for (const path of ['$.a.[?(@.x =~ /y/)]', '$.a[?(@.x in \'y\')]', '$..*', '$.a[ ?(@.x)]', '$..[?(@.x)]']) {
      const offErr = errorOf(() => parseJsonPath(path));
      expect(offErr?.code).toBe('unsupported_jsonpath');
      expect(errorOf(() => ext(path))).toEqual(offErr);
    }
  });

  it('`.[`（Jayway readDotToken）：`$.x.[0]` ≡ `$.x[0]`、`$.[*]` ≡ `$[*]`、`$.x.[\'a\']` ≡ `$.x[\'a\']`', () => {
    expect(errorOf(() => parseJsonPath('$.x.[0]'))?.code).toBe('unsupported_jsonpath');
    expect(ext('$.x.[0]')).toEqual(parseJsonPath('$.x[0]'));
    expect(ext('$.[*]')).toEqual(parseJsonPath('$[*]'));
    expect(ext("$.x.['a']")).toEqual(parseJsonPath("$.x['a']"));
    expect(ext('$.x.[1:3].y')).toEqual(parseJsonPath('$.x[1:3].y'));
  });

  it('扩展态方括号字段名含逗号/引号/反斜杠拒（Jayway 多属性或转义）', () => {
    for (const path of ["$.x.['a,b']", `$.x.['a"b']`, "$.x.['a\\b']"]) {
      expect(errorOf(() => ext(path))?.code).toBe('unsupported_jsonpath');
    }
  });
});

describe('过滤器文法', () => {
  it('存在性 / ! 存在性 / 比较 / && || ! 括号 解析为 IR', () => {
    expect(ext('$.a[?(@.x)]').segments[2]).toEqual({ kind: 'filter', expr: { kind: 'exists', path: ['x'], negate: false } });
    expect(ext('$.a[?(!@.x.y)]').segments[2]).toEqual({ kind: 'filter', expr: { kind: 'exists', path: ['x', 'y'], negate: true } });
    expect(ext('$.a[?(@.x && @.y > 2)]').segments[2]).toEqual({
      kind: 'filter',
      expr: {
        kind: 'and',
        items: [
          { kind: 'exists', path: ['x'], negate: false },
          { kind: 'cmp', path: ['y'], op: '>', value: { kind: 'number', value: 2, canonical: '2' } },
        ],
      },
    });
    expect(ext("$.a[?(!(@.x || @.y != 'z'))]").segments[2]).toEqual({
      kind: 'filter',
      expr: {
        kind: 'not',
        item: {
          kind: 'or',
          items: [
            { kind: 'exists', path: ['x'], negate: false },
            { kind: 'cmp', path: ['y'], op: '!=', value: { kind: 'string', value: 'z' } },
          ],
        },
      },
    });
    const name = String.fromCharCode(0x4e66, 0x540d);
    expect(ext(`$.a[?(@.${name} && @.b-c <= null)]`).segments[2]).toMatchObject({ kind: 'filter', expr: { kind: 'and' } });
  });

  it('数字字面量按 BigDecimal.toString() 记规范串：去整数前导零、留小数尾零、零不带负号', () => {
    const lit = (text: string) => {
      const seg = ext(`$.a[?(@.x && @.y < ${text})]`).segments[2];
      if (seg.kind !== 'filter' || seg.expr.kind !== 'and') throw new Error('shape');
      const cmp = seg.expr.items[1];
      if (cmp.kind !== 'cmp') throw new Error('shape');
      return cmp.value;
    };
    expect(lit('007')).toEqual({ kind: 'number', value: 7, canonical: '7' });
    expect(lit('1.50')).toEqual({ kind: 'number', value: 1.5, canonical: '1.50' });
    expect(lit('-0')).toEqual({ kind: 'number', value: -0, canonical: '0' });
    expect(lit('-0.0')).toMatchObject({ canonical: '0.0' });
    expect(lit('-12.30')).toMatchObject({ canonical: '-12.30' });
    expect(lit('0.000001')).toMatchObject({ canonical: '0.000001' });
  });

  it('子集外一律拒（不猜测）', () => {
    const bs = String.fromCharCode(92);
    const arabicOne = String.fromCharCode(0x661);
    const rejected = [
      '$.a[?(@.x =~ /y/)]', // 正则
      '$.a[?(@.x > $.y)]', // $ 路径
      "$.a[?(@.x in 'y')]", // 词运算符
      '$.a[?(@.x && @.y === 1)]', // 非法运算符
      '$.a[?(!@.x == 1)]', // Jayway 静默忽略 !，不复刻
      `$.a[?(@.x && @.y == 'a${bs}b')]`, // 转义
      '$.a[?(@.x&&@.y)]', // 名字后紧跟 &
      '$.a[?(@.x < 0.0000001)]', // Jayway 会转科学计数法
      '$.a[?(@.x < 1234567890123456)]', // 超 15 位
      "$.a[?(@.x < '1234567890123456')]", // 数值串超 double 精度
      `$.a[?(@.x < '${arabicOne}')]`, // 非 ASCII 数字
      '$.a[?(@.x < 1e5)]', // 数字字面量不收指数
      '$.a[?(@.x < truex)]',
      '$.a[?(@)]', // 左值必须 @.字段
      '$.a[?(@.x)', // 未闭合
      '$.a[?(@.x) ]', // ) 后不是 ]
      '$.a[?((@.x)]',
      '$.a[?(@.x\t)]',
      `$.a[?(@.x && ${'@.y && '.repeat(80)}@.z)]`, // 过长
    ];
    for (const path of rejected) {
      expect(errorOf(() => parseJsonPath(path))?.code, path).toBe('unsupported_jsonpath');
      expect(errorOf(() => ext(path))?.code, path).toBe('unsupported_jsonpath');
    }
  });
});

// 以 `@.字段 ==` 开头的过滤器 off 态旧 filterEq 就收（扩展不接管，IR 不变），故这里的等值用例套一层括号或前置存在性，
// 确保走扩展文法。
describe('过滤器求值（Jayway PredicatePathToken + EvaluatorFactory）', () => {
  it('数组逐元素判、对象判自身、标量不产出', () => {
    const json = { arr: [{ ok: 1 }, { no: 1 }, 5, null, [1]], obj: { ok: 0, v: 2 }, bad: { v: 2 }, n: 5 };
    expect(run('$.arr[?(@.ok)]', json)).toEqual([{ ok: 1 }]);
    expect(run('$.obj[?(@.ok)]', json)).toEqual([{ ok: 0, v: 2 }]);
    expect(run('$.bad[?(@.ok)]', json)).toEqual([]);
    expect(run('$.n[?(@.ok)]', json)).toEqual([]);
    expect(run('$.arr[?(@.ok)].ok', json)).toEqual([1]);
  });

  it('存在性：每步须是对象且有自有属性，null 叶子算存在', () => {
    const arr = [{ a: { b: null } }, { a: 5 }, { a: [{ b: 1 }] }, { a: {} }, {}];
    expect(run('$[?(@.a.b)]', arr)).toEqual([{ a: { b: null } }]);
    expect(run('$[?(!@.a.b)]', arr)).toEqual([{ a: 5 }, { a: [{ b: 1 }] }, { a: {} }, {}]);
    expect(run('$[?(@.toString)]', [{}])).toEqual([]);
  });

  it('比较左值缺失/中间非对象读成 null：== null 命中，!= 字面量为真', () => {
    const arr = [{}, { v: null }, { v: 0 }, { a: 5 }];
    expect(run('$[?((@.v == null))]', arr)).toEqual([{}, { v: null }, { a: 5 }]);
    expect(run('$[?(@.v != 1 && @.v != null)]', arr)).toEqual([{ v: 0 }]);
    expect(run('$[?((@.a.b == null))]', arr)).toEqual(arr);
    expect(run('$[?(@.a && @.v != 1)]', arr)).toEqual([{ a: 5 }]);
  });

  it('等值：数字对数字比数值；数字对字符串按 BigDecimal 解析该串；字符串对数字比规范串', () => {
    expect(run('$[?(@.v && @.v == 1.0)]', [{ v: 1 }, { v: '1' }])).toEqual([{ v: 1 }]);
    expect(run("$[?(@.v && @.v == '1.50')]", [{ v: 1.5 }, { v: 2 }])).toEqual([{ v: 1.5 }]);
    expect(run("$[?(@.v && @.v == '1e0')]", [{ v: 1 }])).toEqual([{ v: 1 }]);
    expect(run("$[?(@.v && @.v == ' 1')]", [{ v: 1 }])).toEqual([]);
    expect(run("$[?(@.v && @.v == 'abc')]", [{ v: 1 }])).toEqual([]);
    expect(run("$[?(@.v && @.v != 'abc')]", [{ v: 1 }])).toEqual([{ v: 1 }]);
    expect(run('$[?(@.v && @.v == 007)]', [{ v: '7' }, { v: '007' }, { v: 7 }])).toEqual([{ v: '7' }, { v: 7 }]);
    expect(run('$[?(@.v && @.v == 1.50)]', [{ v: '1.50' }, { v: '1.5' }])).toEqual([{ v: '1.50' }]);
    expect(run('$[?(@.v && @.v == -0)]', [{ v: '0' }, { v: '-0' }, { v: 0 }])).toEqual([{ v: '0' }, { v: 0 }]);
  });

  it('等值：布尔只等布尔；对象/数组不等于任何字面量', () => {
    const arr = [{ v: true }, { v: 'true' }, { v: 1 }, { v: {} }, { v: [] }];
    expect(run('$[?(@.v && @.v == true)]', arr)).toEqual([{ v: true }]);
    expect(run("$[?(@.v && @.v == 'true')]", arr)).toEqual([{ v: 'true' }]);
    expect(run('$[?(@.v && @.v != true)]', arr)).toEqual(arr.slice(1));
  });

  it('大小：只在数字对数字、字符串对字符串之间成立，其余为假', () => {
    const arr = [{ v: 5 }, { v: '5' }, { v: 'b' }, { v: null }, {}];
    expect(run('$[?(@.v > 3)]', arr)).toEqual([{ v: 5 }]);
    expect(run('$[?(@.v <= 5)]', arr)).toEqual([{ v: 5 }]);
    expect(run("$[?(@.v > 'a')]", arr)).toEqual([{ v: 'b' }]);
    expect(run("$[?(@.v < '6')]", arr)).toEqual([{ v: '5' }]);
    expect(run('$[?(@.v >= 0 || @.v < 0)]', arr)).toEqual([{ v: 5 }]);
  });

  it('&& || ! 括号的布尔组合', () => {
    const arr = [{ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 2 }];
    expect(run('$[?((@.a == 1 && @.b == 3 || @.a == 2))]', arr)).toEqual([{ a: 1, b: 3 }, { a: 2 }]);
    expect(run('$[?((@.a == 1 && (@.b == 3 || @.b == 2)))]', arr)).toEqual(arr.slice(0, 2));
    expect(run('$[?(!(@.b && @.b == 2))]', arr)).toEqual(arr.slice(1));
  });
});

describe('经 parseFieldRule 求值（字段层）', () => {
  it('off 照旧拒；on 列表字段与模板里的扩展路径取值', () => {
    const rule = '$.data.list[?(@.name && @.vip != true)]';
    expect(errorOf(() => parseFieldRule(rule, { jsonPathEnabled: false, field: LIST }))).toBeDefined();
    const scope = createJsonScope({
      data: { list: [{ name: '书一', id: 1 }, { name: '书二', vip: true, id: 2 }, { id: 3 }, { name: '书四', vip: false, ids: [4, 5] }] },
    }, `${SITE}/`);
    const items = evaluateFieldList(parseFieldRule(rule, { jsonPathEnabled: true, field: LIST }), scope);
    expect(items).toHaveLength(2);
    expect(evaluateField(parseFieldRule('$.name', { jsonPathEnabled: true, field: 'ruleSearch.name' }), items[0])).toBe('书一');
    const url = `${SITE}/b/{{$.ids.[0]}}.html`;
    expect(errorOf(() => parseFieldRule(url, { jsonPathEnabled: false, field: BOOK_URL }))).toBeDefined();
    expect(evaluateField(parseFieldRule(url, { jsonPathEnabled: true, field: BOOK_URL }), items[1])).toBe(`${SITE}/b/4.html`);
  });

  it('默认读 env：未设 ENGINE_SYNTAX_JSON_PATH 时同 off', () => {
    const saved = process.env.ENGINE_SYNTAX_JSON_PATH;
    delete process.env.ENGINE_SYNTAX_JSON_PATH;
    try {
      expect(errorOf(() => parseFieldRule('$.a[?(@.x)]', { field: LIST }))).toBeDefined();
    } finally {
      if (saved !== undefined) process.env.ENGINE_SYNTAX_JSON_PATH = saved;
    }
  });

  it('嵌套 parseFieldRule 后外层开关恢复（模块级状态不泄漏）', () => {
    parseFieldRule('$.a[?(@.x)]', { jsonPathEnabled: true, field: LIST });
    expect(errorOf(() => parseFieldRule('$.a[?(@.x)]', { jsonPathEnabled: false, field: LIST }))).toBeDefined();
    expect(() => parseFieldRule('$.a[?(@.x)]', { jsonPathEnabled: true, field: LIST })).not.toThrow();
  });
});

describe('按源判定与 compileSource', () => {
  const opts = (jsonPathEnabled: boolean) => ({
    orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled: false, xpathEvalEnabled: false, regexEnabled: false,
    andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false,
    jsGetEnabled: false, jsUtilEnabled: false, jsonPathEnabled,
  });
  const flags = {
    orEnabled: false, varsEnabled: false, jsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false,
    andEnabled: false, aioEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false, jsGetEnabled: false,
    jsUtilEnabled: false,
  };

  it('只有 off 拒、on 过的字段所在源换版本', () => {
    const filter = raw({ ruleSearch: { bookList: '$.data[?(@.id)]' } });
    const dotBracket = raw({ ruleToc: { chapterList: '$.list.[*]' } });
    const tpl = raw({ ruleSearch: { bookUrl: `${SITE}/b/{{$.ids.[0]}}` } });
    const oldFilter = raw({ ruleSearch: { bookList: '$.data[?(@.id == 3)]' } });
    const plain = raw({ ruleSearch: { bookList: '$.data[*]' } });
    const bothReject = raw({ ruleSearch: { bookList: '$.data[?(@.id =~ /x/)]' } });
    const htmlBracket = raw({ ruleContent: { content: '#c.[x]@text' } });
    for (const s of [filter, dotBracket, tpl]) {
      expect(engineSourceRevision(s, opts(true))).not.toBe(engineSourceRevision(s, opts(false)));
      expect(sourceUsesJsonPathSyntax(s.rules, flags)).toBe(true);
    }
    for (const s of [oldFilter, plain, bothReject, htmlBracket]) {
      expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
      expect(sourceUsesJsonPathSyntax(s.rules, flags)).toBe(false);
    }
  });

  it('compileSource：off 态 skipped，on 态编译；两态缓存互不污染', () => {
    const rules = { ruleSearch: { bookList: '$.data[?(@.id)]' } };
    const compiled = (jsonPathEnabled: boolean) => compileSource(raw(rules), { jsonPathEnabled }).get(LIST);
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true)).not.toHaveProperty('skipped');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
  });
});

describe('source-usability 缓存口径', () => {
  const saved = process.env.ENGINE_SYNTAX_JSON_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENGINE_SYNTAX_JSON_PATH;
    else process.env.ENGINE_SYNTAX_JSON_PATH = saved;
  });

  it('翻 ENGINE_SYNTAX_JSON_PATH 后 engineSourceUsable 重新判定', async () => {
    const { engineSourceUsable } = await import('../source-usability');
    const source = {
      url: 'https://book15.net/', name: 'x', searchUrl: 'https://book15.net/s?q={{key}}', // 默认 host 门白名单
      rules: {
        ruleSearch: { bookList: '$.data[?(@.id)]', name: '$.name', bookUrl: '$.url' },
        ruleToc: { chapterList: '$.list[*]', chapterName: '$.title', chapterUrl: '$.url' },
        ruleContent: { content: '$.content' },
      },
    };
    process.env.ENGINE_SYNTAX_JSON_PATH = '0';
    const offState = engineSourceUsable(source as never);
    process.env.ENGINE_SYNTAX_JSON_PATH = '1';
    const onState = engineSourceUsable(source as never);
    expect(offState).toBe(false);
    expect(onState).toBe(true);
  });
});
