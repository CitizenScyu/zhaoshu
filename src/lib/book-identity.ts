// 书籍身份键的唯一实现。sanitize.ts 的 bookKey 与 db.ts 的 canonicalBookKey 都委托到这里。
//
// 语义对齐 SQL 权威键（生产 PG 实测可用的那一条）：
//   title : lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\1')))
//   author: lower(btrim(normalize(author, NFKC)))
// 本文件不拼 SQL，只保证"同输入同输出"，供 Phase 2 的唯一索引与此处的应用侧键取到同一个值。
// 注意 PG 的 normalize() 第二参数是关键字：normalize(x, NFKC) 可以，normalize(x, 'NFKC') 报 42601。
//
// 流水线（顺序与 SQL 表达式逐字对应，不可调换）：
//   NFKC → 剥首尾 U+0020 → 剥一层外层《》 → 剥首尾 U+0020 → 小写
// 最后一次去空格不是多余的：`《 书名 》` 剥掉书名号后会把内侧空格暴露到两端。

const NUL = String.fromCharCode(0);

// 空白规则：只剥 U+0020，与 PostgreSQL btrim(text) 的默认行为逐字对齐。
//
// 为什么不用 String.prototype.trim()：它剥的是宿主定义的一整组 Unicode 空白
// （TAB / CR / LF / 全角空格 U+3000 / NBSP 等），比 btrim() 宽。用 trim() 会让
// JS 侧算出与 SQL 权威键不同的键——那正是本任务要消灭的那类分叉（生产数据里
// `《修真聊天群》` 就是这么裂成两行的）。这里显式写成 0x20 常量，行为不随引擎
// 或宿主 locale 变化，也不依赖 trim() 的隐式字符集。
//
// 代价（已知、已钉在测试里）：首尾 TAB / 换行不再被视为可忽略，与 SQL 一致。
// 生产 books/labeled_books 实测首尾空白 0 行，改这条规则对存量数据无影响。
const BTRIM_CODE_POINT = 0x20;

function btrimSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === BTRIM_CODE_POINT) start += 1;
  while (end > start && value.charCodeAt(end - 1) === BTRIM_CODE_POINT) end -= 1;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

// PG 正则里 `.` 不匹配 \n（未开启 newline-sensitive matching 时也只排除 \n），
// 所以用 [^\n]+ 而不是 .+：两者对 \r、U+2028、U+2029 才算一致（那三个 `.` 不匹配、
// [^\n] 匹配，与 PG 的行为对齐）。
// 只剥一层（regexp_replace 默认替换首个匹配），所以 `《《红楼梦》研究》` → `《红楼梦》研究`。
// 注意：剥完仍是 `《…》` 形状时会被再剥一层（`《《x》》` → `《x》` → `x`），
// 所以本函数不幂等，全链路只允许归一一次（见 user-data.ts 的 identityOf）。
const OUTER_TITLE_BRACKETS = /^《([^\n]+)》$/;

function stripOuterTitleBrackets(value: string): string {
  return value.replace(OUTER_TITLE_BRACKETS, '$1');
}

// 大小写走 ICU（toLocaleLowerCase），与既有的 bookKey/canonicalBookKey 行为一致。
//
// 🔴 已知差异 1（无法对齐，保留原样，不做 hack）：
//   U+0130 'İ' 在 JS 走 Unicode 完整大小写映射 → 'i' + U+0307（2 个码位）；
//   生产 PG 在 C.UTF-8 下 lower() → 'i'（1 个码位）。同一输入两种键。
//   本机实测 Node v22.17.0、默认 locale zh-CN：'İ'.toLocaleLowerCase() = 'i̇'。
//   生产 books/labeled_books 实测 0 命中（task-49 交接报告）。
//   不掩盖：一旦出现含 'İ' 的书名，该分叉会在 Phase 2 的唯一索引上直接暴露。
//
// 🔴 已知差异 2（同上，属同一类）：toLocaleLowerCase() 的结果依赖宿主默认 locale
//   （tr/az/lt 下大小写映射不同）。这里刻意沿用既有实现不改，避免在本次改动里
//   引入未经评审的行为变化；如需彻底确定化应改为 toLowerCase()，另批处理。
function lower(value: string): string {
  return value.toLocaleLowerCase();
}

export function normalizeBookTitle(raw: string): string {
  return lower(btrimSpace(stripOuterTitleBrackets(btrimSpace(raw.normalize('NFKC')))));
}

export function normalizeBookAuthor(raw: string): string {
  return lower(btrimSpace(raw.normalize('NFKC')));
}

// 组合键：NUL 分隔，避免 'a,b'+'c' 与 'a'+'b,c' 撞键。
export function canonicalBookKey(title: string, author: string): string {
  return `${normalizeBookTitle(title)}${NUL}${normalizeBookAuthor(author)}`;
}
