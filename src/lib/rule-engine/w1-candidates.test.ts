import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_TIER_DISTRIBUTION, W1_SOURCES, checkW1Criteria, recomputeTierDistribution, recomputeW1,
  type SurveyCandidate, type SurveyProbe,
} from './w1-candidates';

// W1 名单可复算（m2-scaleout §2.2 / §9 M2-3 验收 8，v2）。
// 绝对分布断言用真实 survey 数据（存在才跑）；纯函数逻辑用内联合成数据恒跑。

const surveyDir = process.env.RULE_SURVEY_DIR
  ?? fileURLToPath(new URL('../../../../.rule-survey/', import.meta.url));
const candidatesPath = `${surveyDir.replace(/[\\/]$/, '')}/candidates.json`;
const probesPath = `${surveyDir.replace(/[\\/]$/, '')}/probe_results.json`;
const hasSurvey = existsSync(candidatesPath) && existsSync(probesPath);
const load = <T,>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const syntheticCandidates: SurveyCandidate[] = [
  { name: '📂小刀阅读', url: 'https://www.yingsx.com', tier: 'T1', core_feats: [], checkKeyWord: '我的', enabled: true, cn_novel: true },
  { name: '精华书阁', url: 'https://m.jhssd.com/', tier: 'T1', core_feats: [], checkKeyWord: 'k', enabled: true, cn_novel: true },
  { name: '精华书阁', url: 'https://wap.jhssd.com/', tier: 'T1', core_feats: [], checkKeyWord: 'k', enabled: true, cn_novel: true },
  { name: '📂看书', url: 'https://www.kanshuw.com', tier: 'T6', core_feats: ['regex_sub'], checkKeyWord: '我的', enabled: true, cn_novel: true },
  { name: '新笔趣阁2', url: 'https://wap2.xinbiquge.org/', tier: 'T2', core_feats: ['css_attr'], checkKeyWord: '剑来', enabled: true, cn_novel: true },
  { name: '有料🈲🔍', url: 'https://yp.ylwx71.xyz', tier: 'T6', core_feats: ['regex_sub'], checkKeyWord: 'k', enabled: true, cn_novel: true },
  { name: '知妖-中国妖怪百集', url: 'https://www.czhiyao.com', tier: 'T1', core_feats: [], checkKeyWord: '山海经', enabled: true, cn_novel: true },
  { name: '被禁', url: 'https://dead.example', tier: 'T6', core_feats: ['regex_sub'], checkKeyWord: 'k', enabled: true, cn_novel: true },
];
const syntheticProbes: SurveyProbe[] = [
  { host: 'https://www.yingsx.com', verdict: 'ok' },
  { host: 'https://m.jhssd.com/', verdict: 'ok' },
  { host: 'https://wap.jhssd.com/', verdict: 'ok' },
  { host: 'https://www.kanshuw.com', verdict: 'ok' },
  { host: 'https://wap2.xinbiquge.org/', verdict: 'ok' },
  { host: 'https://yp.ylwx71.xyz', verdict: 'ok' },
  { host: 'https://www.czhiyao.com', verdict: 'ok' },
  { host: 'https://dead.example', verdict: 'conn_fail' },
];

describe('W1 名单可复算（§2.2 五条标准 / §9 验收 8）', () => {
  it('纯函数：①②④⑤ 过滤 + ③ 同站去重后得到设计名单；不探测/编码/质量项各自剔除一条', () => {
    const result = recomputeW1(syntheticCandidates, syntheticProbes);
    // dead.example 不探测（①）、新笔趣阁2 编码排除（④）、有料 质量标记（⑤）各自出局。
    expect(result.culled.map((item) => item.host).sort()).toEqual([
      'm.jhssd.com', 'wap.jhssd.com', 'www.czhiyao.com', 'www.kanshuw.com', 'www.yingsx.com',
    ]);
    // ③ 同站去重：m./wap.jhssd.com 归一为 jhssd.com，保留首个（m）。
    expect(result.selected.map((item) => item.host)).toEqual([
      'www.yingsx.com', 'm.jhssd.com', 'www.kanshuw.com', 'www.czhiyao.com',
    ]);
    expect(result.matchesDesign).toBe(true);
  });

  it('W1 四源逐条满足 §2.2 五条标准', () => {
    const candidates = syntheticCandidates;
    const probes = syntheticProbes;
    for (const source of W1_SOURCES) {
      const candidate = candidates.find((item) => new URL(item.url).hostname === source.host)!;
      expect(candidate, `W1 源 ${source.host} 必须在 candidates.json 中`).toBeDefined();
      const check = checkW1Criteria(candidate, probes);
      expect(check).toEqual({ reachable: true, thinSurface: true, uniqueSite: true, noEncoding: true, cleanQuality: true });
    }
  });

  it.skipIf(!hasSurvey)('真实数据：档位分布命中设计基准，且 W1 四源仍可复算出', () => {
    const candidates = load<SurveyCandidate[]>(candidatesPath);
    const probes = load<SurveyProbe[]>(probesPath);
    // §2.2 复算表：T1 6 / T2 2 / T6 20 / T7 1 / T8 3 / T9 1 / 未定档 1（共 34）。
    expect(recomputeTierDistribution(candidates)).toEqual(EXPECTED_TIER_DISTRIBUTION);
    const result = recomputeW1(candidates, probes);
    expect(result.matchesDesign).toBe(true);
    expect(result.selected.map((item) => item.host).sort()).toEqual(
      W1_SOURCES.map((source) => source.host).sort(),
    );
    // 逐条五标准（真实数据）仍全部为真。
    for (const source of W1_SOURCES) {
      const candidate = candidates.find((item) => new URL(item.url).hostname === source.host)!;
      expect(checkW1Criteria(candidate, probes)).toEqual({
        reachable: true, thinSurface: true, uniqueSite: true, noEncoding: true, cleanQuality: true,
      });
    }
  });
});
