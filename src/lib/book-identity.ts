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

// 空白规则：只剥 U+0020，**刻意对齐 SQL 侧 btrim(text) 的默认语义，与 JS 的
// String.prototype.trim() 不同**（trim() 剥的是宿主定义的一整组 Unicode 空白）。
//
// 为什么不用 String.prototype.trim()：它剥 TAB / LF / CR / FF / VT / U+1680 /
// U+FEFF / U+2028 等，比 btrim() 宽。任何绕过应用归一化的写入路径（导入脚本 /
// backfill / 直接 SQL）只要落了含 TAB 的值，SQL 键保留 TAB 而应用键剥掉 ⇒ 分叉
// ⇒ Phase 2 的生成列唯一索引上必出 23505 或 42P10。
// 反向（让应用归一得更激进）同样不安全，所以两侧必须逐字对齐。
//
// 这里用显式码位常量做循环，等价于 /^ +| +$/g，但不依赖宿主默认 trim() 的
// 隐式字符集，行为不随引擎或 locale 变化。
//
// 🔴 首尾 TAB / 换行 / U+1680 / U+FEFF / U+2028 **不会被剥除——这是有意为之的
// 与 SQL 一致，不是遗漏**。代价已钉在测试里（'\\t修真聊天群' 必须原样保留）。
// 生产 books/labeled_books 实测首尾空白 0 行，改这条规则对存量数据无影响。
//
// 注意区分：NBSP(U+00A0) / U+2000 / U+2003 / U+2009 / U+202F / U+205F /
// U+3000 会被剥掉，但**不是 trim() 泄漏**——NFKC 先把它们折叠成 U+0020，再由本
// 规则剥除；SQL 侧 normalize(t,NFKC) 同样先折叠，所以两侧一致。同样已钉在测试里。
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

// 大小写用 toLowerCase()：按 Unicode 默认（root）映射，**不依赖宿主 locale**。
//
// 为什么不用 toLocaleLowerCase()（原 bookKey/canonicalBookKey 用的是它）：无参时它取
// 宿主默认 locale，而生产 Node 的默认 locale 由运行环境决定。危险集合极小但非空——
// 实测全码位扫描：tr / az 只有 U+0049 `I` 与 U+0130 `İ`（→ `ı`），lt 只有 U+00CC `Ì`、
// U+00CD `Í`、U+0128 `Ĩ`。生产作者名里确实有 ASCII 大写（`阎ZK` / `TMW` / `Maxwell` 等），
// 一旦宿主 locale 落到 tr/az/lt，`I` 会被 lower 成 `ı`，与 SQL lower() 的 `i` 分叉，
// Phase 2 的唯一索引 / ON CONFLICT 就会炸。
//
// 换成 toLowerCase() 在**当前可观测的所有输入上是等价变换**：本机（默认 locale zh-CN）
// 全码位扫描 0x0000–0x10FFFF，两者结果不同的码位 = 0。只有当宿主 locale 是 tr/az/lt 时
// 行为才变，而那时旧行为本身就是那个 bug。所以这次改动对存量数据 0 影响，换来确定化。
//
// 🔴 已知差异（仅剩这一条，无法对齐，保留原样，不做 hack）：
//   U+0130 'İ' 在 JS 走 Unicode 完整大小写映射 → 'i' + U+0307（2 个码位）；
//   生产 PG 在 C.UTF-8 下 lower() → 'i'（1 个码位）。同一输入两种键。
//   本机实测 Node v22.17.0：'İ'.toLowerCase() = 'i̇'（与 toLocaleLowerCase 结果相同，
//   换 toLowerCase() 并不能消除这一条，它来自 Unicode 版本而非 locale）。
//   生产 books/labeled_books 实测 0 命中（task-49 交接报告）。
//   不掩盖：一旦出现含 'İ' 的书名，该分叉会在 Phase 2 的唯一索引上直接暴露。
function lower(value: string): string {
  return value.toLowerCase();
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
