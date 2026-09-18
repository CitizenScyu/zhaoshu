// W1 灰度名单可复算（m2-scaleout-design §2.2 / §9 M2-3 验收 8，v2）。
//
// 档位分布口径：`.rule-survey/candidates.json` 里 `enabled ∧ cn_novel ∧ checkKeyWord`
// 的源按 tier 计数（设计 §2.2「② 口径为什么给 T6 开口子」：T1 6 / T2 2 / T6 20）。
// W1 四源（§2.2 名单）必须能用同一份数据 + 同一份 E 节探测结果复算出来，而不是手抄常量。
//
// 本模块**零依赖**（不 import 任何 @/ 别名或运行时模块），以便 `node --experimental-strip-types`
// 的 `scripts/w1-candidates.mjs` 与 vitest 共用同一实现。
//
// 五条标准的可复算口径（§2.2 W1 行）：
//   ① 在 E 节 probe 可达目标内（probe_results.json verdict='ok'）；
//   ② tier ≤ T6 且核心字段构件面小（core_feats 长度 ≤ 1：T6 相对 T1 的全部增量是 regex_sub）；
//   ③ 每 host 只取一条（同站 m./wap./www. 归一后去重，保留首个）；
//   ④ 无传输编码包裹——E 节实测判定，落成显式排除名单（candidates.json 无此字段，不伪造推导）；
//   ⑤ 无内容质量硬伤——同 ④，落成显式排除标记 + 名单常量，不伪造推导。
//
// 设计 §2.2 对 ① 的原文是「Top6 内」，但同节「代价与对冲」把它表述为「锁在 E 节 12 个
// 目标内」（看书是 sample 行、非 top6）——本复算按后者的实际口径（E 节探测可达）执行。

export interface SurveyCandidate {
  name: string;
  url: string;
  tier?: string | null;
  core_feats?: string[];
  checkKeyWord?: string | null;
  searchUrl?: string;
  enabled?: boolean;
  cn_novel?: boolean;
}

export interface SurveyProbe {
  name?: string;
  host?: string;
  tier?: string | null;
  verdict?: string;
  status?: number | null;
}

/** W1 名单（§2.2）：site 归一后的 host，顺序即设计表格顺序。 */
export const W1_SOURCES = [
  { site: 'jhssd.com', host: 'm.jhssd.com', name: '精华书阁（m）', tier: 'T1' },
  { site: 'yingsx.com', host: 'www.yingsx.com', name: '小刀阅读', tier: 'T1' },
  { site: 'czhiyao.com', host: 'www.czhiyao.com', name: '知妖-中国妖怪百集', tier: 'T1' },
  { site: 'kanshuw.com', host: 'www.kanshuw.com', name: '看书', tier: 'T6' },
] as const;

/** ④ 传输编码包裹的显式排除（E 节实测：正文需 b64 解包，属 W2 编码路径）。 */
export const W1_ENCODING_EXCLUDED_HOSTS = ['wap2.xinbiquge.org'] as const;
/** ④ 构件名里出现即视为编码/脚本包裹（当前数据无命中，作为防线保留）。 */
const ENCODING_FEAT_MARKERS = ['base64', 'inte_base64', 'aes', 'zip', 'js_decrypt'] as const;
/** ⑤ 内容质量硬伤标记（成人/听书类，survey §C 排除口径）。 */
const QUALITY_EXCLUDED_MARKERS = ['🈲', '🔞'] as const;
/** ② 允许的档位（tier ≤ T6）。 */
const ALLOWED_TIERS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] as const;

/** 设计里的档位分布基准（§2.2 表）：复算必须命中，变了就是素材更新，需重选 W1。 */
export const EXPECTED_TIER_DISTRIBUTION: Record<string, number> = {
  T1: 6, T2: 2, T6: 20, T7: 1, T8: 3, T9: 1, 'null': 1,
};

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** 站点归一：去掉 m./wap./www. 前导子域，用于「每 host（同站）只取一条」。 */
function siteOf(host: string): string {
  return host.replace(/^(m|wap|www)\./, '');
}

/** 档位分布（enabled ∧ cn_novel ∧ checkKeyWord）。 */
export function recomputeTierDistribution(candidates: SurveyCandidate[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const candidate of candidates) {
    if (!(candidate.enabled && candidate.cn_novel && candidate.checkKeyWord)) continue;
    const tier = candidate.tier == null ? 'null' : String(candidate.tier);
    dist[tier] = (dist[tier] ?? 0) + 1;
  }
  return dist;
}

export interface W1CriterionCheck {
  /** ① E 节探测可达。 */
  reachable: boolean;
  /** ② tier ≤ T6 且核心字段构件面 ≤ 1 件。 */
  thinSurface: boolean;
  /** ③ 同站唯一。 */
  uniqueSite: boolean;
  /** ④ 无传输编码包裹。 */
  noEncoding: boolean;
  /** ⑤ 无内容质量硬伤标记。 */
  cleanQuality: boolean;
}

/** 按 §2.2 五条标准逐条判定一个候选（供测试逐条断言）。 */
export function checkW1Criteria(
  candidate: SurveyCandidate, probes: SurveyProbe[],
): W1CriterionCheck {
  const host = hostOf(candidate.url);
  const site = siteOf(host);
  const reachable = probes.some((probe) => siteOf(hostOf(probe.host ?? '')) === site && probe.verdict === 'ok');
  const features = candidate.core_feats ?? [];
  const uniqueSite = W1_SOURCES.filter((source) => source.site === site).length === 1;
  const encodingExcluded = (W1_ENCODING_EXCLUDED_HOSTS as readonly string[]).includes(host)
    || features.some((feature) => ENCODING_FEAT_MARKERS.some((marker) => feature.includes(marker)));
  const qualityFlagged = QUALITY_EXCLUDED_MARKERS.some((marker) => candidate.name.includes(marker));
  return {
    reachable,
    thinSurface: ALLOWED_TIERS.includes(String(candidate.tier) as typeof ALLOWED_TIERS[number]) && features.length <= 1,
    uniqueSite,
    noEncoding: !encodingExcluded,
    cleanQuality: !qualityFlagged,
  };
}

export interface W1Recompute {
  distribution: Record<string, number>;
  /** 通过 ①②④ 的候选（同站去重前）。 */
  culled: { name: string; host: string; tier: string }[];
  /** 同站去重后的最终名单（应等于 W1_SOURCES）。 */
  selected: { name: string; host: string; tier: string }[];
  /** 复算名单与设计名单是否逐条一致。 */
  matchesDesign: boolean;
}

/**
 * 复算 W1 名单：候选 → ①②④⑤ 过滤 → ③ 同站去重（保留候选数组里的首个，设计保留 m.jhssd.com）。
 * 返回的 selected 必须等于 W1_SOURCES，matchesDesign 为 true。
 */
export function recomputeW1(candidates: SurveyCandidate[], probes: SurveyProbe[]): W1Recompute {
  const distribution = recomputeTierDistribution(candidates);
  const culled: W1Recompute['culled'] = [];
  for (const candidate of candidates) {
    const check = checkW1Criteria(candidate, probes);
    if (!(check.reachable && check.thinSurface && check.noEncoding && check.cleanQuality)) continue;
    culled.push({ name: candidate.name, host: hostOf(candidate.url), tier: String(candidate.tier) });
  }
  const seen = new Set<string>();
  const selected: W1Recompute['selected'] = [];
  for (const item of culled) {
    const site = siteOf(item.host);
    if (seen.has(site)) continue;
    seen.add(site);
    selected.push(item);
  }
  const matchesDesign = selected.length === W1_SOURCES.length
    && W1_SOURCES.every((source) => selected.some((item) => item.host === source.host));
  return { distribution, culled, selected, matchesDesign };
}
