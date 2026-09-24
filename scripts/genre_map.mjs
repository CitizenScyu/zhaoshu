// 分类规范化：站点分类 + LLM genre → 标准主分类 + 次级标签。
// import_labels.mjs 与 backfill_quality.mjs 共用。

// 标准主分类（书库筛选/排行的基础维度）
const PRIMARY_GENRES = [
  '玄幻', '仙侠', '武侠', '都市', '历史', '科幻', '悬疑灵异',
  '无限流', '游戏竞技', '轻小说', '奇幻', '言情', '其他',
];

// LLM genre 关键词 → 主分类，按优先级排列（先匹配到的优先）
const GENRE_RULES = [
  ['无限流', /无限流/],
  ['仙侠', /仙侠|修真|修仙|洪荒/],
  ['武侠', /武侠/],
  // 灵异/惊悚优先于都市:"都市灵异"按灵异归类,读感由灵异决定
  ['悬疑灵异', /灵异|恐怖|悬疑|惊悚|诡/],
  ['都市', /都市/],
  ['历史', /历史/],
  ['科幻', /科幻|末世|星际|废土/],
  ['游戏竞技', /游戏|电竞/],
  ['轻小说', /轻小说|日系/],
  ['奇幻', /西幻|西方奇幻|蒸汽朋克|克苏鲁|剑与魔法/],
  ['玄幻', /玄幻/],
  ['言情', /言情|女频/],
];

// 站点分类兜底映射（LLM genre 匹配不上时）
const SITE_CATEGORY_MAP = {
  玄幻奇幻: '玄幻',
  武侠修真: '仙侠',
  恐怖灵异: '悬疑灵异',
  都市言情: '都市',
  历史军事: '历史',
};

function normalizeGenre(siteCategory, llmGenre) {
  const llm = String(llmGenre ?? '');
  let primary = null;
  for (const [name, re] of GENRE_RULES) {
    if (re.test(llm)) {
      primary = name;
      break;
    }
  }
  if (!primary) {
    const site = String(siteCategory ?? '').trim();
    primary = SITE_CATEGORY_MAP[site] ?? (PRIMARY_GENRES.includes(site) ? site : null);
  }
  if (!primary) primary = '其他';

  // 次级标签：genre 里的词去掉主分类词，保留 2-8 字的标签
  const words = llm.split(/[、,，;；/|]/).map((w) => w.trim()).filter(Boolean);
  const sub = [...new Set(words)]
    .filter((w) => w.length >= 2 && w.length <= 8 && !PRIMARY_GENRES.includes(w) && w !== primary)
    .slice(0, 5);
  return { primary, sub };
}

export { PRIMARY_GENRES, normalizeGenre };

// 自测（直接运行时）
if (process.argv[1] && process.argv[1].endsWith('genre_map.mjs')) {
  const cases = [
    ['玄幻奇幻', '东方玄幻、重生、魔道流', '玄幻'],
    ['恐怖灵异', '都市灵异/惊悚悬疑', '悬疑灵异'],
    ['武侠修真', '', '仙侠'],
    ['', '克苏鲁式神秘奇幻、蒸汽朋克、异世界穿越', '奇幻'],
    ['', '仙侠/穿越', '仙侠'],
    ['', '无限流团队作战', '无限流'],
    ['玄幻奇幻', '', '玄幻'],
    ['', '', '其他'],
    ['', '末世废土生存', '科幻'],
    ['', '轻小说风格日常', '轻小说'],
    ['未知站点类', '武侠江湖恩怨', '武侠'],
    ['', '言情女频古风', '言情'],
  ];
  let pass = 0;
  for (const [site, llm, expect] of cases) {
    const { primary } = normalizeGenre(site, llm);
    const ok = primary === expect;
    if (ok) pass += 1;
    else console.log(`FAIL: site=${site} llm=${llm} → ${primary}（期望 ${expect}）`);
  }
  console.log(`normalizeGenre 自测: ${pass}/${cases.length} 通过`);
  process.exit(pass === cases.length ? 0 : 1);
}
