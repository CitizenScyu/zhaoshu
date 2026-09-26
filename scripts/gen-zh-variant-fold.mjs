// 从 OpenCC 字表生成 src/lib/zh-variant-fold.ts（书源身份比对用的繁→简单字折叠表）。
// 用法：node scripts/gen-zh-variant-fold.mjs <TSCharacters.txt> <STCharacters.txt> src/lib/zh-variant-fold.ts
// 两个字表取自 https://github.com/BYVoid/OpenCC data/dictionary/（Apache-2.0），不入库。
//
// 规则（41-swq 审查修复）：折叠两侧同时做，所以只能吸收「同一个字的繁简两种写法」，不能把两个不同的字折成一个。
//   1. 取 TSCharacters 的「单字 → 单字」条目，多候选取首个，链式映射解到终点。
//   2. 剔除多前像：简体目标 s 本身在繁体里也是独立的字（STCharacters 中 s 的繁体候选含 s 自身，如 干/后/系/蒙）
//      → 所有折到 s 的条目全删（否则 乾≡干、後≡后）。
//   3. 其余 s 只留一个前像：STCharacters 中 s 的首选繁体（蘇→苏 留，囌→苏 删；發→发 留，髮→发 删）；
//      STCharacters 无 s 时，仅当 s 恰有一个前像才留。
//   结果是一对一映射：每个等价类恰为 {繁体字, 它的简体}，不同的字不会判等。
import { readFileSync, writeFileSync } from 'node:fs';

const [tsPath, stPath, outPath] = process.argv.slice(2);
if (!tsPath || !stPath || !outPath) throw new Error('用法：gen-zh-variant-fold.mjs <TSCharacters.txt> <STCharacters.txt> <out.ts>');

function readTable(path) {
  const table = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [key, value] = line.split('\t');
    if (value) table.set(key, value.trim().split(' '));
  }
  return table;
}

const ts = readTable(tsPath);
const st = readTable(stPath);

const chained = new Map();
for (const [key, [first]] of ts) {
  if ([...key].length !== 1 || [...first].length !== 1 || key === first) continue;
  chained.set(key, first);
}
for (const [key, value] of chained) {
  let end = value;
  while (chained.has(end)) end = chained.get(end);
  chained.set(key, end);
}

const preimages = new Map();
for (const [key, value] of chained) preimages.set(value, [...(preimages.get(value) ?? []), key]);

const fold = new Map();
let droppedSelf = 0;
let droppedSecondary = 0;
for (const [simplified, keys] of preimages) {
  const traditional = st.get(simplified);
  if (traditional?.includes(simplified)) { droppedSelf += keys.length; continue; }
  const keep = traditional ? keys.find((key) => key === traditional[0]) : keys.length === 1 ? keys[0] : undefined;
  droppedSecondary += keys.length - (keep ? 1 : 0);
  if (keep) fold.set(keep, simplified);
}

const pairs = [...fold].sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0)).map(([k, s]) => k + s);
const rows = [];
for (let i = 0; i < pairs.length; i += 40) rows.push(`  '${pairs.slice(i, i + 40).join('')}',`);
const out = `// 繁→简单字折叠表（41-swq）：只给「书源身份比对」用（source-parser 的 sourceBookMatches / sourceTitleSimilarity），
// 两侧同时折叠后再比，不改任何存储值、不参与 DB 身份键（book-identity.ts 与 SQL 权威键逐字对齐，不能动）。
//
// 数据来源：OpenCC（https://github.com/BYVoid/OpenCC）data/dictionary/TSCharacters.txt 与 STCharacters.txt，
// Apache License 2.0，Copyright (c) 2010-2020 Carbo Kuo and contributors。
// 生成规则（一对一，只吸收同一个字的繁简两种写法）：取 TSCharacters「单字 → 单字」条目、多候选取首个、链式解到终点；
// 再剔除多前像——简体目标本身也是独立繁体字的（STCharacters 候选含自身：干⇐乾/幹、后⇐後、系⇐係/繫、蒙⇐濛）整组不折，
// 其余每个简体只留 STCharacters 首选繁体一个前像（蘇→苏 留、囌→苏 不折；發→发 留、髮→发 不折）。
// 共 ${fold.size} 对（剔除 ${droppedSelf} 个自身为繁体字的前像、${droppedSecondary} 个非首选前像）。
// 生成脚本：scripts/gen-zh-variant-fold.mjs（字表不入库，按脚本头注释的路径取）。
const PAIRS = [
${rows.join('\n')}
].join('');

const FOLD = new Map<string, string>();
for (let index = 0; index < PAIRS.length;) {
  const traditional = String.fromCodePoint(PAIRS.codePointAt(index)!);
  index += traditional.length;
  const simplified = String.fromCodePoint(PAIRS.codePointAt(index)!);
  index += simplified.length;
  FOLD.set(traditional, simplified);
}

/** 逐字把繁体字形折成简体（表外字符原样保留）。 */
export function foldTraditional(value: string): string {
  let out = '';
  for (const char of value) out += FOLD.get(char) ?? char;
  return out;
}

/** 表大小（测试钉住生成结果没有被截断）。 */
export const TRADITIONAL_FOLD_SIZE = FOLD.size;
`;
writeFileSync(outPath, out);
console.log('pairs', fold.size, 'droppedSelf', droppedSelf, 'droppedSecondary', droppedSecondary);
