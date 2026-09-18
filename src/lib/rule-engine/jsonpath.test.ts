import { describe, expect, it } from 'vitest';
import { evalJsonPath, parseJsonPath } from './jsonpath';
import { RuleEngineError } from './types';

const doc = {
  bookName: '剑来',
  bookAuthor: '烽火戏诸侯',
  books: [
    { id: 1, title: 'A', tag: 'hot' },
    { id: 2, title: 'B', tag: 'new' },
    { id: 3, title: 'C', tag: 'hot' },
  ],
  detail: { info: { chapters: [{ n: 'c1' }, { n: 'c2' }] } },
};

function query(path: string, root: unknown): unknown[] {
  return evalJsonPath(parseJsonPath(path), root);
}

describe('jsonpath: 5 构件', () => {
  it('$.child 取值', () => {
    expect(query('$.bookName', doc)).toEqual(['剑来']);
  });

  it('$.a.b 嵌套', () => {
    expect(query('$.detail.info.chapters', doc)).toEqual([doc.detail.info.chapters]);
  });

  it('$..recursive 递归', () => {
    expect(query('$..title', doc)).toEqual(['A', 'B', 'C']);
    expect(query('$..n', doc)).toEqual(['c1', 'c2']);
  });

  it('[*] 通配', () => {
    expect(query('$.books[*]', doc)).toEqual(doc.books);
  });

  it('.* 通配', () => {
    expect(query('$.detail.info.*', doc)).toEqual([doc.detail.info.chapters]);
  });

  it('[n] 下标（含负数从尾）', () => {
    expect(query('$.books[0]', doc)).toEqual([doc.books[0]]);
    expect(query('$.books[-1]', doc)).toEqual([doc.books[2]]);
  });

  it('[n,m] 下标列表', () => {
    expect(query('$.books[0,2]', doc)).toEqual([doc.books[0], doc.books[2]]);
  });

  it('[a:b] 切片', () => {
    expect(query('$.books[0:2]', doc)).toEqual([doc.books[0], doc.books[1]]);
    expect(query('$.books[1:]', doc)).toEqual([doc.books[1], doc.books[2]]);
    expect(query('$.books[:1]', doc)).toEqual([doc.books[0]]);
  });

  it('[?(@.x==y)] 等值过滤', () => {
    expect(query("$.books[?(@.tag=='hot')]", doc)).toEqual([doc.books[0], doc.books[2]]);
    expect(query('$.books[?(@.id==2)]', doc)).toEqual([doc.books[1]]);
  });

  it("['name'] 引号字段名", () => {
    expect(query("$['bookName']", doc)).toEqual(['剑来']);
  });

  it('递归 + 通配组合 $..books[*]', () => {
    expect(query('$..books[*]', doc)).toEqual(doc.books);
  });

  it('$..name 在多层深树命中所有层级（回归）', () => {
    const deep = {
      n: 'L0',
      child: { n: 'L1', child: { n: 'L2', items: [{ n: 'L3' }, { other: { n: 'L4' } }] } },
    };
    expect(query('$..n', deep)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });

  it('$.* 单层通配仍为 wildcard（回归）', () => {
    expect(query('$.*', { a: 1, b: 2 })).toEqual([1, 2]);
  });
});

describe('jsonpath: 越界/缺字段/非 JSON = 空（不抛业务错）', () => {
  it('越界下标 → 空', () => {
    expect(query('$.books[9]', doc)).toEqual([]);
  });

  it('缺字段 → 空', () => {
    expect(query('$.missing', doc)).toEqual([]);
    expect(query('$.a.b.c', doc)).toEqual([]);
  });

  it('对非对象求 child → 空', () => {
    expect(query('$.bookName.x', doc)).toEqual([]);
  });

  it('null / 原始值输入 → 空', () => {
    expect(query('$.x', null)).toEqual([]);
    expect(query('$.x', 42)).toEqual([]);
  });

  it('过滤器无匹配 → 空', () => {
    expect(query("$.books[?(@.tag=='none')]", doc)).toEqual([]);
  });
});

describe('jsonpath: 非子集语法 → RULE_UNSUPPORTED', () => {
  it.each([
    '$2', //          非 . / [ 起始
    'bookName', //    不以 $ 开头
    '$.books[?(@.id>1)]', // 非等值过滤
    '$.a[', //        未闭合 [
    '$.', //          . 后缺字段
    '$..', //         .. 后缺字段
    '$..*', //        递归通配不在 M1 子集（B.8：不静默塌缩为 $.*）
    '$..[*]', //      递归 .. 后缺字段名（回归）
  ])('%s', (bad) => {
    let caught: unknown;
    try {
      parseJsonPath(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuleEngineError);
    expect((caught as RuleEngineError).code).toBe('RULE_UNSUPPORTED');
  });

  it('$..* 错误信息点明递归通配不在 M1 子集', () => {
    let caught: unknown;
    try {
      parseJsonPath('$..*');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuleEngineError);
    expect((caught as RuleEngineError).message).toContain('$..*');
    expect((caught as RuleEngineError).message).toContain('M1');
  });
});
