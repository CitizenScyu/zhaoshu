// W1 灰度名单复算脚本（m2-scaleout-design §2.2 / §9 M2-3 验收 8，v2）。
//
// 用法：node --experimental-strip-types scripts/w1-candidates.mjs [surveyDir]
// 默认 surveyDir = <repo>/../.rule-survey（含 candidates.json + probe_results.json）。
// 命中设计基准（T1 6 / T2 2 / T6 20 …）且复算名单 = W1 四源时退出码 0，否则 1。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_TIER_DISTRIBUTION, W1_SOURCES, checkW1Criteria, recomputeTierDistribution, recomputeW1,
} from '../src/lib/rule-engine/w1-candidates.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const surveyDir = resolve(process.argv[2] || resolve(repoRoot, '..', '.rule-survey'));
const read = (name) => JSON.parse(readFileSync(resolve(surveyDir, name), 'utf8'));

const candidates = read('candidates.json');
const probes = read('probe_results.json');

const distribution = recomputeTierDistribution(candidates);
assert.deepEqual(distribution, EXPECTED_TIER_DISTRIBUTION,
  `档位分布漂移：${JSON.stringify(distribution)} ≠ 基准 ${JSON.stringify(EXPECTED_TIER_DISTRIBUTION)}`);
console.log('档位分布（enabled ∧ cn_novel ∧ checkKeyWord）:', JSON.stringify(distribution));

const result = recomputeW1(candidates, probes);
console.log('复算名单:', result.selected.map((item) => `${item.host} [${item.tier}]`).join(', '));
assert.equal(result.matchesDesign, true, '复算名单与设计 W1 四源不一致，需重跑并重选');

for (const source of W1_SOURCES) {
  const candidate = candidates.find((item) => new URL(item.url).hostname === source.host);
  assert.ok(candidate, `candidates.json 缺少 W1 源 ${source.host}`);
  const check = checkW1Criteria(candidate, probes);
  assert.deepEqual(check, { reachable: true, thinSurface: true, uniqueSite: true, noEncoding: true, cleanQuality: true },
    `W1 源 ${source.host} 不再满足 §2.2 五条标准：${JSON.stringify(check)}`);
}
console.log(`W1 复算通过：${W1_SOURCES.length} 源满足 §2.2 五条标准`);
