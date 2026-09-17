import { describe, expect, it } from 'vitest';
import { canonicalBookKey, normalizeBookAuthor, normalizeBookTitle } from './book-identity';

// 身份键对照表。右值 = JS 侧实际返回值，语义对齐 SQL 权威键
// lower(btrim(regexp_replace(btrim(normalize(x, NFKC)), '^《(.+)》$', '\1')))。
//
// 空白字符一律写成 \uXXXX 转义（U+3000 除外，它在中日文里肉眼可辨）：
// 让"被搬运的到底是哪个码位"在 diff 里可见，避免不可见的 NBSP / U+2028 混进源码。

describe('normalizeBookTitle', () => {
  it.each([
    // 外层书名号：剥一层，且只剥一层
    ['《修真聊天群》', '修真聊天群'],
    ['《《红楼梦》研究》', '《红楼梦》研究'],
    ['《》', '《》'],                  // PG 的 (.+) 要求至少 1 个字符，空书名号不动
    ['《x》y》', 'x》y'],              // 贪婪匹配到最后一个 》
    // 空白规则：只剥 U+0020，与 PG btrim() 一致
    ['  修真聊天群  ', '修真聊天群'],
    ['\t修真聊天群', '\t修真聊天群'],   // 🔴 TAB 不剥
    ['修真聊天群\n', '修真聊天群\n'],   // 🔴 换行不剥
    ['　修真聊天群', '修真聊天群'], // U+3000 先被 NFKC 折成 U+0020
    ['《 修真聊天群 》', '修真聊天群'], // 剥书名号后暴露的空格由第二次 btrim 收掉
    // 全半角：NFKC
    ['ＡＢＣ', 'abc'],
    ['修真聊天群：', '修真聊天群:'],  // 全角冒号 → 半角
    // 大小写
    ['Foo BAR', 'foo bar'],
    ['', ''],
  ])('归一 %j → %j', (input, expected) => {
    expect(normalizeBookTitle(input)).toBe(expected);
  });

  it('作者的《》不被剥（SQL 只对 title 做 regexp_replace）', () => {
    expect(normalizeBookAuthor('《佚名》')).toBe('《佚名》');
    expect(normalizeBookTitle('《佚名》')).toBe('佚名');
  });

  it('点号不跨行：与 PG 正则的 . 一致（\\n 阻断，\\r 不阻断）', () => {
    // PG 的 `.` 不匹配 \n 但匹配 \r；JS 侧用 [^\n]+ 才对得上
    expect(normalizeBookTitle('《修真\n聊天群》')).toBe('《修真\n聊天群》');
    expect(normalizeBookTitle('《修真\r聊天群》')).toBe('修真\r聊天群');
  });
});

describe('空白规则（显式钉住，防止有人换回 trim()）', () => {
  // NFKC 会把大部分 Unicode 空白折叠成 U+0020（实测：NBSP / EN QUAD / EM SPACE /
  // THIN SPACE / NARROW NBSP / MEDIUM MATH SPACE / IDEOGRAPHIC SPACE），折叠后由
  // btrim 规则剥掉 —— 这些与 String.prototype.trim() 结果相同，不构成分叉。
  const FOLDED_TO_SPACE = [
    '\u00a0', '\u2000', '\u2003', '\u2009', '\u202f', '\u205f', '\u3000',
  ];
  it.each(FOLDED_TO_SPACE)('先被 NFKC 折成 U+0020 再剥掉的空白 %j', (ws) => {
    expect(ws.normalize('NFKC')).toBe(' ');
    expect(normalizeBookTitle(ws + '书' + ws)).toBe('书');
    expect(normalizeBookAuthor(ws + '人' + ws)).toBe('人');
  });

  // 真正的分叉：NFKC 不动它们，宿主 trim() 会剥，PG btrim() 不剥。
  // 这里刻意选 SQL 一侧（保留），让应用侧键与 Phase 2 的唯一索引是同一个函数。
  const NOT_FOLDED = [
    '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u1680', '\ufeff', '\u2028',
  ];
  it.each(NOT_FOLDED)('trim() 会剥、但这里刻意保留的空白 %j', (ws) => {
    expect((ws + '书').trim()).toBe('书');
    expect(normalizeBookTitle(ws + '书')).toBe(ws + '书');
    expect(normalizeBookAuthor('人' + ws)).toBe('人' + ws);
  });

  it('硬约束：只剥 U+0020，与 SQL btrim 一致，与 JS .trim() 不一致', () => {
    // 保留 TAB —— 有意为之的与 SQL 一致，不是遗漏
    expect(normalizeBookTitle('\t修真聊天群')).toBe('\t修真聊天群');
    expect(normalizeBookAuthor('\t佚名')).toBe('\t佚名');
    // 剥掉 U+0020
    expect(normalizeBookTitle(' 修真聊天群 ')).toBe('修真聊天群');
    expect(normalizeBookAuthor(' 佚名 ')).toBe('佚名');
    // 分歧点就在这里：宿主 trim() 会剥 TAB，我们刻意不剥
    expect('\t修真聊天群'.trim()).toBe('修真聊天群');
  });

  it('首尾 TAB / 换行的书名与干净写法是两个键（与 SQL 一致）', () => {
    const clean = canonicalBookKey('修真聊天群', '作者');
    expect(canonicalBookKey('\t修真聊天群', '作者')).not.toBe(clean);
    expect(canonicalBookKey('修真聊天群\n', '作者')).not.toBe(clean);
  });
});

describe('已知差异（保留原样，不掩盖）', () => {
  it('🔴 U+0130 İ：JS 得到 2 个码位，PG C.UTF-8 lower() 得到 1 个', () => {
    const js = normalizeBookTitle('İ');
    // JS/ICU：'i' + U+0307 COMBINING DOT ABOVE
    expect([...js].map((c) => c.codePointAt(0))).toEqual([0x69, 0x307]);
    expect(js).toHaveLength(2);
    // PG 在 C.UTF-8 下的 lower('İ') = 'i'（1 个码位）——JS 侧到不了这个结果，
    // 所以二者不是同一个函数。生产数据实测 0 命中，此处只钉住现状。
    expect(js).not.toBe('i');
    expect(normalizeBookAuthor('İ')).toBe(js);
  });

  it('🔴 同一差异会让含 İ 的书名与全小写写法分成两键', () => {
    expect(canonicalBookKey('İ', 'a')).not.toBe(canonicalBookKey('i', 'a'));
  });

  it('大小写不依赖宿主 locale（toLowerCase，不是 toLocaleLowerCase）', () => {
    // tr/az 下 toLocaleLowerCase('I') = 'ı'；我们用 toLowerCase() 固定得到 'i'
    expect('I'.toLocaleLowerCase('tr')).toBe('ı');
    expect(normalizeBookAuthor('I')).toBe('i');
    expect(normalizeBookAuthor('阎ZK')).toBe('阎zk');
    expect(normalizeBookAuthor('Maxwell')).toBe('maxwell');
    // 与 SQL C.UTF-8 的 lower() 一致：ASCII 大写 → ASCII 小写
    expect(normalizeBookTitle('TMW')).toBe('tmw');
  });
});

describe('canonicalBookKey', () => {
  it('NUL 分隔 title/author，边界不串键', () => {
    expect(canonicalBookKey('a,b', 'c')).not.toBe(canonicalBookKey('a', 'b,c'));
    expect(canonicalBookKey('ab', 'c')).not.toBe(canonicalBookKey('a', 'bc'));
    expect(canonicalBookKey('a', 'b')).toContain(String.fromCharCode(0));
  });

  it('《》变体与全半角变体收进同一个键', () => {
    expect(canonicalBookKey('《修真聊天群》', '作者'))
      .toBe(canonicalBookKey('修真聊天群', '作者'));
    expect(canonicalBookKey('修真聊天群：', 'ＡＢＣ'))
      .toBe(canonicalBookKey('修真聊天群:', 'abc'));
    expect(canonicalBookKey('修真聊天群', ' 作者 '))
      .toBe(canonicalBookKey('修真聊天群', '作者'));
  });

  it('幂等性边界：只有"剥完仍是《…》形状"的输入才会被剥第二层', () => {
    // 《《红楼梦》研究》 剥一次后不再首尾配对，所以对它 f(f(x)) === f(x)
    const once = normalizeBookTitle('《《红楼梦》研究》');
    expect(once).toBe('《红楼梦》研究');
    expect(normalizeBookTitle(once)).toBe('《红楼梦》研究');
    // 但《《x》》 会 —— 所以全链路仍然只允许归一一次
    expect(normalizeBookTitle('《《x》》')).toBe('《x》');
    expect(normalizeBookTitle(normalizeBookTitle('《《x》》'))).toBe('x');
  });
});
