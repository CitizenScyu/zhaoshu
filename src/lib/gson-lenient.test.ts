import { describe, expect, it } from 'vitest';
import { gsonAsString, gsonPlainInteger, gsonPrettyJson, parseGsonLenient, type GsonValue } from './gson-lenient';

// searchopt1028：Gson 2.11 宽松读取子集。形态均为合成值。
const plain = (v: GsonValue | null): unknown => {
  if (v === null) return undefined;
  switch (v.kind) {
    case 'string': return v.value;
    case 'number': return `#${v.raw}`;
    case 'boolean': return v.value;
    case 'null': return null;
    case 'array': return v.items.map(plain);
    case 'object': return Object.fromEntries([...v.entries].map(([k, item]) => [k, plain(item)]));
  }
};
const read = (text: string) => plain(parseGsonLenient(text));

describe('parseGsonLenient 接受集', () => {
  it('严格 JSON 照读', () => {
    expect(read('{"a":"x","b":12,"c":[true,null]}')).toEqual({ a: 'x', b: '#12', c: [true, null] });
  });

  it('单引号、裸键裸值、关键字不分大小写', () => {
    expect(read("{method:POST, 'body':'k=v', flag:TRUE, n:Null}")).toEqual({ method: 'POST', body: 'k=v', flag: true, n: null });
  });

  it('`=`/`=>` 作键值分隔、`;` 作成员分隔', () => {
    expect(read('{a=1;b=>"x"}')).toEqual({ a: '#1', b: 'x' });
  });

  it('三种注释与 )]}\' 前缀', () => {
    expect(read(")]}'\n{ // c\n a: 1, # c\n /* c */ b: 2 }")).toEqual({ a: '#1', b: '#2' });
    expect(read('{"a":1} // 尾注释')).toEqual({ a: '#1' });
  });

  it('数组里多余逗号读作 null', () => {
    expect(read('[1,,2]')).toEqual(['#1', null, '#2']);
    expect(read('[1,]')).toEqual(['#1', null]);
  });

  it('前导 0 等非 JSON 数字读作裸串', () => {
    expect(read('{a:01,b:1.5,c:-2e3}')).toEqual({ a: '01', b: '#1.5', c: '#-2e3' });
  });

  it('转义：\\u、\\/、\\\' 认，未知转义拒', () => {
    expect(read('{"a":"\\u4e66\\/\\\'"}')).toEqual({ a: "书/'" });
    expect(parseGsonLenient('{"a":"\\x"}')).toBeNull();
  });

  it('重复键标记 duplicate（后值覆盖）', () => {
    const v = parseGsonLenient('{"a":1,"a":2}');
    expect(v?.kind === 'object' && v.duplicate).toBe(true);
    expect(plain(v)).toEqual({ a: '#2' });
  });
});

describe('parseGsonLenient 拒绝集', () => {
  it.each([
    ['对象尾逗号', '{"a":1,}'],
    ['未闭合串', '{"a":"x}'],
    ['未闭合注释', '{"a":1} /* x'],
    ['值后残留', '{"a":1} x'],
    ['两个值', '{} {}'],
    ['缺键值分隔', '{"a" 1}'],
    ['空文档', '   '],
  ])('%s → null', (_name, text) => {
    expect(parseGsonLenient(text)).toBeNull();
  });

  it('嵌套超 255 层拒，255 层内照读', () => {
    expect(parseGsonLenient('['.repeat(255) + ']'.repeat(255))).not.toBeNull();
    expect(parseGsonLenient('['.repeat(256) + ']'.repeat(256))).toBeNull();
  });
});

describe('gson 取值帮手', () => {
  it('gsonAsString：基本值取原文、null 为 null、容器非 null', () => {
    const v = parseGsonLenient('{s:"x",n:10,b:false,z:null,o:{}}');
    const field = (k: string) => (v?.kind === 'object' ? v.entries.get(k) : undefined);
    expect(gsonAsString(field('s'))).toBe('x');
    expect(gsonAsString(field('n'))).toBe('10');
    expect(gsonAsString(field('b'))).toBe('false');
    expect(gsonAsString(field('z'))).toBeNull();
    expect(gsonAsString(field('missing'))).toBeNull();
    expect(gsonAsString(field('o'))).not.toBeNull();
  });

  it('gsonPlainInteger 只认普通整数', () => {
    expect(gsonPlainInteger({ kind: 'number', raw: '-12' })).toBe(true);
    expect(gsonPlainInteger({ kind: 'number', raw: '1.0' })).toBe(false);
    expect(gsonPlainInteger({ kind: 'number', raw: '1e2' })).toBe(false);
    expect(gsonPlainInteger({ kind: 'number', raw: '99999999999999999999' })).toBe(false);
  });

  it('gsonPrettyJson：两空格缩进、`": "` 分隔、空容器紧凑', () => {
    const v = parseGsonLenient("{k:'书',n:1,a:[true,'x'],e:{},l:[]}")!;
    expect(gsonPrettyJson(v)).toBe('{\n  "k": "书",\n  "n": 1,\n  "a": [\n    true,\n    "x"\n  ],\n  "e": {},\n  "l": []\n}');
  });

  it('gsonPrettyJson：null、非整数、U+2028 口径不定 → null', () => {
    expect(gsonPrettyJson(parseGsonLenient('{a:null}')!)).toBeNull();
    expect(gsonPrettyJson(parseGsonLenient('{a:1.5}')!)).toBeNull();
    expect(gsonPrettyJson(parseGsonLenient('{a:"\\u2028"}')!)).toBeNull();
  });
});
