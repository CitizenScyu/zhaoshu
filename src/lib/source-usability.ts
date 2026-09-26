// 引擎源在运行时能否用于搜索取书：probe 的 compile_failed 判据与取书池/扇出的名额筛选共用这一处（41-swq）。
// 准入表的 compile_ok/search_ok 是准入当时的结论；这里按**当前**引擎语义与 host 门重算，二者可能不一致
// （41-swq 实测：sfacg 两条规则 searchUrl 指向门外的 m.sfacg.com，准入记 search_ok，运行时必拒）。
import { compileSource } from './rule-engine/compile';
import { engineSyntaxOrEnabled } from './rule-engine/syntax-flags';
import { sourceSearchUrl } from './source-parser';
import { SourcePolicyError } from './source-policy';

/**
 * 引擎源能跑通「搜索 → 详情 → 目录」的最低字段组:与准入 compileAdmission 的 REQUIRED_FIELDS 同口径
 * (rule-engine/admission.ts),去掉引擎有默认值的 ruleToc.chapterUrl。ruleContent.content 保留:没有它源读不了正文。
 */
export const REQUIRED_ENGINE_FIELDS = [
  'ruleSearch.bookList', 'ruleSearch.name', 'ruleSearch.bookUrl',
  'ruleToc.chapterList', 'ruleToc.chapterName', 'ruleContent.content',
] as const;

interface RuleSource { url: string; searchUrl: unknown; rules: Record<string, unknown> }

/** 搜索模板按运行时口径（含 host 门）展不开时返回 true。非 SourcePolicyError 的异常照常抛。 */
export function searchTemplateRejected(source: RuleSource, title: string): boolean {
  try {
    sourceSearchUrl(source.searchUrl, title, source.url);
    return false;
  } catch (error) {
    if (error instanceof SourcePolicyError) return true;
    throw error;
  }
}

/** 必需字段里缺失或编译不过（skipped）的那些；空数组 = 规则可用。编译结果走 compileSource 的 LRU 缓存。 */
export function missingEngineFields(source: RuleSource): string[] {
  const compiled = compileSource(source);
  return REQUIRED_ENGINE_FIELDS.filter((name) => {
    const ir = compiled.get(name);
    return !ir || 'skipped' in ir;
  });
}

/**
 * 必需字段编译结论按规则对象记忆（池合成每次请求都要筛全部准入源，≈180 条，超出 compileSource 的 64 条 LRU；
 * 规则对象来自 shuyuan 的读缓存，TTL 内是同一个对象）。语义开关变了就重算。
 */
const rulesUsable = new WeakMap<object, { orEnabled: boolean; usable: boolean }>();

/** 引擎源能否进取书池/扇出：搜索模板展得开且必需字段都编译得出。调用前 host 门须已刷新（门的结论不记忆）。 */
export function engineSourceUsable(source: RuleSource): boolean {
  if (searchTemplateRejected(source, '书')) return false;
  const orEnabled = engineSyntaxOrEnabled();
  const hit = rulesUsable.get(source.rules);
  if (hit?.orEnabled === orEnabled) return hit.usable;
  const usable = missingEngineFields(source).length === 0;
  rulesUsable.set(source.rules, { orEnabled, usable });
  return usable;
}
