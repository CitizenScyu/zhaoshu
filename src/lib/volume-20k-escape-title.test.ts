// 分卷 v2 转义标题字节边界:章标题含 JSON 转义字符(`"` `\` 制表符/垂直制表/换页/NUL 等
// C0 控制符、以及直接构造里的换行符)时,发布侧 readerIndexBytes 的估算是否仍**逐字节等于**
// 读端 readBookIndex 真实 stringify 字节 —— 转义会让 JSON 表示**变大**,若将来精确组装被改回
// 「原始字节逐项求和」式估算,既有 volume-20k-boundary.test.ts 的**纯 CJK 标题**语料不含任何
// 转义字符,字节前后一致 ⇒ 仍绿,缺一道转义维度的回归网。本文件补上这张网。
//
// 实测(Node JSON.stringify 语义,单字符)：
//   `"`(1B) → `\"`(2B)  +1      `\`(1B) → `\\`(2B)  +1      TAB → `\t`  +1
//   FF(1B)  → `\f`(2B)  +1      VT/NUL/SOH/US 等 → `\uXXXX`(6B)  +5
//   LF/CR 在**书源标题**里不可能出现(parseTxtChapters 按 LF/CR 切行);但它们仍可经手写清单/
//   上游脏数据进入 chapter_index,故以**纯函数对拍**覆盖,不经 parseTxtChapters。
//
// 与 volume-20k-boundary.test.ts 的分工:那文件钉「EI 组装 vs 读端同形状」的总体形状(顶层包裹、
// 键名、元素间逗号),语料全是纯 CJK;本文件钉「标题里的转义字符也必须被算进去」这一个维度,
// 因此刻意用**含转义**的标题、并让转义成为**跨门与否的决定性字节**。
//
// 变异测试(防恒真,任务书第 3 条)的做法:不向生产代码注入开关,而是在本测试文件里**直接定义**
// 「逐章原始字节求和 + 固定 pad」的旧 bug 估算函数,断言它对含转义语料必然低估 —— 本文件的
// 对拍型/门型用例在那种实现下会红。报告里另附把 readerIndexBytes 临时改回旧写法后
// **真实跑红** 的原始 vitest 输出(变异红)与还原后**真实跑绿** 的输出(还原绿)。
import { describe, expect, it } from 'vitest';
import {
  publishBookVersion, snapshotPaths, readerIndexBytes, gitBlobSha,
  MAX_READER_INDEX_BYTES, type GitHubContents,
} from './download-publisher';
import { parseVolumeManifest } from './volume-manifest';
import type { VolumeChapterEntry } from './volume-manifest';
import { parseTxtChapters } from './txt-chapters';

const guardOk = { check: async () => {} };
const TITLE = '边界书';
const AUTHOR = '佚名';
const N = 20_000;
/** 读端 MAX_INDEX_JSON_BYTES,同值 4 MiB(reader-server.ts:19);发布侧同名门 MAX_READER_INDEX_BYTES。 */
const READER_INDEX_GATE = MAX_READER_INDEX_BYTES;
const VERSION40 = '0'.repeat(40);
const testWrapper = { taskId: 7, title: TITLE, author: AUTHOR, version: VERSION40, totalBytes: 0 };

/** 可从真实书源标题进入的 JSON 转义字符(parseTxtChapters 会把 LF/CR 当行分隔,标题里留不住)。 */
const DQ = '"';          // → \"
const BS = '\\';          // → \\
const TAB = '\t';         // → \t
const VT = String.fromCharCode(11); // 垂直制表 →
const FF = String.fromCharCode(12); // 换页       → \f
const NUL = String.fromCharCode(0); // NUL       → \u0000
const US = String.fromCharCode(31); // 单元分隔   → \u001f
/**
 * 真实书源里一类"脏标题"的形状:序号 + CJK 填充 + 一段带引号/反斜杠/制表/控制符的后缀。
 * 单章 JSON 表示会被这些转义撑大(见文件头实测),20000 章累计足以决定跨不跨 4 MiB 门。
 */
const ESCAPE_TAIL = '杂' + DQ + BS + TAB + VT + FF + NUL + US + '注';

/** 最小内存 GitHub(绝不联网)。 */
class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

/** 标题里含换行符的书源不存在(LF/CR 被 parseTxtChapters 当行分隔),故此类语料直接造 entries。 */
function escapedEntries(pad: number, n: number, tail: string): VolumeChapterEntry[] {
  const entries: VolumeChapterEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({ i, t: `第${i + 1}章 ${'风'.repeat(pad)}${tail}`, v: 0, s: i * 200, e: i * 200 + 190, p: 1 });
  }
  return entries;
}

/** 书文本:标题行 + 空行 + 正文行;正文 200 字(≤ 32 KiB) ⇒ 每章 partCount 恒 1。 */
function bookText(pad: number, n = N, tail = ''): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`第${i + 1}章 ${'风'.repeat(pad)}${tail}`, '', '正文'.repeat(200));
  return lines.join('\n');
}

/** 读端 readBookIndex 清单分支的等价映射(reader-server.ts:469-486):只独立复现形状,不复用实现。 */
function readerIndexFromEntries(entries: VolumeChapterEntry[]) {
  return {
    taskId: testWrapper.taskId, title: testWrapper.title, author: testWrapper.author,
    version: testWrapper.version, totalBytes: testWrapper.totalBytes,
    chapters: entries.map((entry) => ({
      index: entry.i, title: entry.t, startByte: entry.s, endByte: entry.e, partCount: entry.p,
    })),
  };
}

/** 读端真实字节:整个 ReaderIndex 一次 JSON.stringify(读端口径),独立于 readerIndexBytes。 */
function readerIndexRealBytes(entries: VolumeChapterEntry[]): number {
  return Buffer.byteLength(JSON.stringify(readerIndexFromEntries(entries)), 'utf8');
}

/**
 * 旧 bug / 未来回退形态:逐章**原始 UTF-8 字节**求和 + 固定 pad。它漏掉了三样字节:
 * 顶层 wrapper 包裹、每章 JSON 结构(键名/冒号/引号/逗号)、以及标题里的 JSON 转义扩容。
 * 纯 CJK 语料下它与真实值的偏差仍可观(旧 Rev P1 实测 ≈ -19.8 KB);含转义语料下**必然低估**。
 * 只在本文件内定义,供变异测试断言 —— 绝不进生产代码。
 */
function naiveIndexBytes(entries: VolumeChapterEntry[]): number {
  return entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.t, 'utf8'), 144);
}

/** 断言发布侧估算与读端真实字节逐字节相等(est>=real 且 delta==0),两者都贴门量级。 */
function expectExactAtGate(entries: VolumeChapterEntry[]): void {
  const est = readerIndexBytes(entries, testWrapper);
  const real = readerIndexRealBytes(entries);
  const delta = est - real;
  expect(est, `估算不得低估读端真实字节(差 ${delta})`).toBeGreaterThanOrEqual(real);
  expect(delta, `估算不得过度高估(差 ${delta})`).toBe(0);
}

describe('2 万章转义标题字节边界:发布估算 vs 读端真实(escape-aware 回归网)', () => {
  it('转义字符确实被算进字节:每个转义簇都在单章 JSON 里扩容', () => {
    // 先把「转义会加字节」钉成事实(否则下面的大规模对拍可以在语料退化后仍绿)。
    const cases: Array<[string, string]> = [
      ['引号', `第1章 ${DQ}`],
      ['反斜杠', `第1章 ${BS}`],
      ['制表符', `第1章 ${TAB}`],
      ['垂直制表', `第1章 ${VT}`],
      ['换页', `第1章 ${FF}`],
      ['NUL', `第1章 ${NUL}`],
      ['单元分隔', `第1章 ${US}`],
      ['混簇', `第1章 ${ESCAPE_TAIL}`],
    ];
    for (const [name, title] of cases) {
      const raw = Buffer.byteLength(title, 'utf8');
      const json = Buffer.byteLength(JSON.stringify(title), 'utf8');
      expect(json, `${name} 的 JSON 表示必须比原始 UTF-8 更长`).toBeGreaterThan(raw);
    }
    // 混簇的真实增量:`x"` `x\` `x\t` `x\f` 各 +1,VT/NUL/US 各 +5 ⇒ +4+15 = 19(相对原始 UTF-8)。
    const head = `第1章 ${'风'.repeat(3)}`;
    const headRaw = Buffer.byteLength(head, 'utf8');
    const tailRaw = Buffer.byteLength(head + ESCAPE_TAIL, 'utf8');
    expect(tailRaw - headRaw).toBe(Buffer.byteLength(ESCAPE_TAIL, 'utf8')); // 原文字节确定
    expect(Buffer.byteLength(JSON.stringify(head + ESCAPE_TAIL), 'utf8')
      - Buffer.byteLength(JSON.stringify(head), 'utf8')).toBeGreaterThan(tailRaw - headRaw);
  });

  it('纯函数对拍:含转义(引号/反斜杠/制表/控制符/换行)标题,est 逐字节等于读端 stringify', () => {
    // 规模:几百 ~ 几千 ~ 19900 ~ 20000 章;每档都含换行符与全套 C0 转义,delta 必须恒 0。
    const shapes: Array<{ pad: number; n: number }> = [
      { pad: 0, n: 300 }, { pad: 4, n: 1200 }, { pad: 8, n: 5000 },
      { pad: 12, n: 12_000 }, { pad: 16, n: 19_900 }, { pad: 18, n: 20_000 },
    ];
    for (const { pad, n } of shapes) {
      // LF(以及 CR)不能来自书源标题,直接造 entries 覆盖:它们是唯一能让标题 JSON 明显变大的行分隔符。
      const tail = ESCAPE_TAIL + `\n${ESCAPE_TAIL}`;
      const entries = escapedEntries(pad, n, tail);
      expectExactAtGate(entries);
      // 转义语料必须在场:至少有标题含引号/反斜杠/制表。
      expect(entries.some((entry) => /["\\\t]/.test(entry.t))).toBe(true);
      // 且各章标题互不相同(序号进标题),避免退化供给。
      expect(new Set(entries.map((entry) => entry.t)).size).toBe(n);
    }
  });

  it('n=20000 贴近 4 MiB 门:转义语料的发布估算与读端逐字节相等,且发布即被拒(index_too_large)', async () => {
    // pad=29/n=20000 的转义书:读端索引 ≈ 4,201,005 B,仅高出门 6,701 B(0.16%)⇒「贴近门」。
    // 同一 pad 去掉转义尾的纯 CJK 书读端索引 ≈ 3,560,899 B,比门低 ~633 KB
    // ⇒ **转义字节就是跨门的决定性差数**。这一档钉住:估算必须把转义算进去,才拒得对。
    const pad = 29;
    const n = N;
    const txt = bookText(pad, n, ESCAPE_TAIL);
    const chapters = parseTxtChapters(Buffer.from(txt, 'utf8'), 64 * 1024 * 1024);
    expect(chapters).toHaveLength(n);
    // 标题必须真的带转义进来:整份语料里引号/反斜杠/制表符都要出现。
    expect(chapters.filter((c) => /["\\\t]/.test(c.title))).toHaveLength(n);
    const codes = Array.from(chapters[0].title).map((c) => c.codePointAt(0)!);
    expect(codes).toContain(DQ.codePointAt(0)!);
    expect(codes).toContain(BS.codePointAt(0)!);
    expect(codes).toContain(TAB.codePointAt(0)!);
    expect(codes).toContain(VT.codePointAt(0)!);

    const entries: VolumeChapterEntry[] = chapters.map((c, i) =>
      ({ i, t: c.title, v: 0, s: c.startByte, e: c.endByte, p: 1 }));
    const wrapper = { taskId: 7, title: TITLE, author: AUTHOR, version: gitBlobSha(txt), totalBytes: Buffer.byteLength(txt, 'utf8') };
    const est = readerIndexBytes(entries, wrapper);
    const real = readerIndexRealBytes(entries);
    expect(est).toBeGreaterThanOrEqual(real); // 不得低估(等价 est>=real,不弱化既有对拍口径)
    expect(est).toBeGreaterThan(READER_INDEX_GATE); // 修后估算也 > 门 ⇒ 发布门会拒

    const github = new MemoryGitHub();
    await expect(publishBookVersion(github, guardOk, {
      taskId: 7, title: TITLE, author: AUTHOR, txt,
      chaptersDone: chapters.length, chaptersTotal: chapters.length, charsTotal: Array.from(txt).length,
    }, { maxBookBytes: 64 * 1024 * 1024 }))
      .rejects.toMatchObject({ name: 'PublicationStageError', stage: 'manifest' });
    // 发布即拒:任何 PUT 都没发生(连清单都没有)。
    expect(snapshotPaths(TITLE, AUTHOR).canonicalPath).toBeTruthy();
    expect(github.files.size).toBe(0);
  }, 60_000);

  it('同规模纯 CJK 标题在门内而转义标题顶穿:证明「读端侧字节才判得准」,且不误伤未转义书', async () => {
    // pad=29/n=20000:去掉转义尾的纯 CJK 书必须照常 promoted(生产最常见形态不被误伤),
    // 而加回转义尾的同一本书必须被拒 —— 两侧字节差就是转义扩容。
    const pad = 29;
    const n = N;

    const plainTxt = bookText(pad, n, '');
    const plainChapters = parseTxtChapters(Buffer.from(plainTxt, 'utf8'), 64 * 1024 * 1024);
    expect(plainChapters).toHaveLength(n);
    const plainEntries = plainChapters.map((c, i) =>
      ({ i, t: c.title, v: 0, s: c.startByte, e: c.endByte, p: 1 }));
    const githubPlain = new MemoryGitHub();
    const plainOutcome = await publishBookVersion(githubPlain, guardOk, {
      taskId: 7, title: TITLE, author: AUTHOR, txt: plainTxt,
      chaptersDone: plainChapters.length, chaptersTotal: plainChapters.length, charsTotal: Array.from(plainTxt).length,
    }, { maxBookBytes: 64 * 1024 * 1024 }) as { promoted: boolean };
    expect(plainOutcome.promoted).toBe(true);

    // 读端真实字节(与发布侧 readerIndexBytes 估计逐字节相等)确实在门内。
    const plainReal = readerIndexRealBytes(plainEntries);
    expect(plainReal).toBeLessThan(READER_INDEX_GATE);
    expect(readerIndexBytes(plainEntries, testWrapper)).toBe(plainReal);

    // 落下的清单能被读端解析,且读端索引字节在门内 ⇒ 真「读得了」,不是被门放过的坏书。
    const manifest = parseVolumeManifest(Buffer.from(
      githubPlain.files.get(snapshotPaths(TITLE, AUTHOR).canonicalPath)!, 'utf8'));
    expect(manifest).not.toBeNull();
    const manifestBytes = Buffer.byteLength(
      githubPlain.files.get(snapshotPaths(TITLE, AUTHOR).canonicalPath)!, 'utf8');
    // 清单自身每章用更短的 i/t/v/s/e/p 形状 ⇒ 同一份数据下小于读端 ReaderIndex。转义标题会把
    // 读端索引推到 4 MiB 之上,而清单仍在门内 ⇒ 这就是必须按**读端形状**设门的原因。
    expect(manifestBytes).toBeLessThan(plainReal);
  }, 60_000);

  it('变异测试:估算退化成「逐章原始字节求和 + 固定 pad」时,转义用例必须被抓红', () => {
    // 复现 rev41vol2 的旧 bug/未来回退形态:只在注释里声称精确,实际 JIT 分支走逐章求和。
    // 纯 CJK 语料下这种估算可能与真实值碰巧接近(或旧测试本就含 escape),故本文件用
    // **必含 escape 的语料**保证它一定低估 —— 这就是「转义维度」的回归价值。
    //
    // pad=29/n=20000 的真实读端索引 ≈ 4,201,005 B(见上一个用例),转义尾使每章多 ~32 B;
    // naive 逐章求和把每章 JSON 结构(键名/逗号/顶层包裹/转义)全漏掉,必然大幅低估。
    const pad = 29;
    const n = N;
    const entries = escapedEntries(pad, n, ESCAPE_TAIL);
    const wrapper = { taskId: 7, title: TITLE, author: AUTHOR, version: VERSION40, totalBytes: Buffer.byteLength(bookText(pad, n, ESCAPE_TAIL), 'utf8') };
    const est = readerIndexBytes(entries, wrapper);
    const real = readerIndexRealBytes(entries);
    const naive = naiveIndexBytes(entries);
    // naive 把结构字节与转义字节都漏了 ⇒ 相对真实读端字节是低估(正是旧 bug 的系统性偏差)。
    expect(naive).toBeLessThan(real);
    expect(est).toBeGreaterThanOrEqual(real); // 精确实现仍不低于真实
    // 关键回归:若 naive 值就是估算函数,贴近门的转义书会被**放行**(读端 422),本文件前一个
    // 用例的「发布即被拒」就会失效。这里把「naive 小于真实」钉成事实,让对拍型用例不会因
    // 估算退化而变绿。
    if (process.env.VOL_DEBUG) console.log(`变异 naive=${naive} 精确est=${est} 读端real=${real}`);
  });
});
