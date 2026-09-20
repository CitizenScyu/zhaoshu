// 174 源 compile 冒烟支撑：把 survey.py 的初筛函数移植为 TS（select_candidates），
// 并对核心字段口径跑 parseFieldRule。供 admission-smoke.test.ts 消费。
// 设计依据：m1-engine-design.md v3 §8.2；移植逻辑参考 .rule-survey/survey.py。

import { parseFieldRule } from './parse';
import { RuleEngineError, type RuleDiagnostic } from './types';

// survey.py CORE_FIELDS（阅读路径必需字段）
export const CORE_FIELDS = [
  'ruleSearch.bookList',
  'ruleSearch.bookUrl',
  'ruleSearch.name',
  'ruleSearch.author',
  'ruleBookInfo.name',
  'ruleBookInfo.author',
  'ruleBookInfo.tocUrl',
  'ruleToc.chapterList',
  'ruleToc.chapterName',
  'ruleToc.chapterUrl',
  'ruleToc.nextTocUrl',
  'ruleContent.content',
  'ruleContent.nextContentUrl',
] as const;

const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleContent', 'ruleToc', 'ruleExplore'] as const;

export interface RawSource {
  bookSourceUrl?: unknown;
  bookSourceName?: unknown;
  bookSourceType?: unknown;
  searchUrl?: unknown;
  ruleSearch?: Record<string, unknown>;
  ruleBookInfo?: Record<string, unknown>;
  ruleToc?: Record<string, unknown>;
  ruleContent?: Record<string, unknown>;
  ruleExplore?: Record<string, unknown>;
  [k: string]: unknown;
}

/** yield [字段全名, 规则字符串] for every non-empty string rule value. */
export function* iterRulePairs(src: RawSource): Generator<[string, string]> {
  for (const group of RULE_GROUPS) {
    const g = src[group];
    if (g && typeof g === 'object' && !Array.isArray(g)) {
      for (const [k, v] of Object.entries(g)) {
        if (typeof v === 'string' && v.trim()) yield [`${group}.${k}`, v];
      }
    }
  }
}

function rulesNoJs(src: RawSource): boolean {
  for (const [, v] of iterRulePairs(src)) {
    if (v.includes('@js:') || v.includes('<js')) return false;
  }
  return true;
}

/** 搜索为纯 GET 模板：含 {{key}}，无 POST/JSON 选项/@ 动词。 */
function searchIsPureGet(su: unknown): boolean {
  if (typeof su !== 'string') return false;
  if (!su.includes('{{key}}')) return false;
  const base = su.split('##')[0];
  if (/,\s*\{/.test(base)) return false;
  if (/@[a-zA-Z]/.test(base)) return false;
  return true;
}

/** 复现主会话初筛（survey.py select_candidates），预期 174 条。 */
export function selectCandidates(data: RawSource[]): RawSource[] {
  const out: RawSource[] = [];
  for (const s of data) {
    if (!String(s.bookSourceUrl ?? '').startsWith('https://')) continue;
    if (!rulesNoJs(s)) continue;
    if (!searchIsPureGet(s.searchUrl)) continue;
    const rs = (s.ruleSearch ?? {}) as Record<string, unknown>;
    const rc = (s.ruleContent ?? {}) as Record<string, unknown>;
    if (!(rs && typeof rs === 'object' && rs.bookList)) continue;
    if (!(rc && typeof rc === 'object' && rc.content)) continue;
    if (s.bookSourceType === 2) continue; // 听书源
    out.push(s);
  }
  return out;
}

export interface CompileResult {
  /** 核心字段全部编译成功（无 RULE_UNSUPPORTED）。 */
  ok: boolean;
  /** 编译失败的核心字段 → 原因。 */
  failures: { field: string; rule: string; message: string; diagnostic: RuleDiagnostic }[];
}

/** 对一个源的核心字段跑 parseFieldRule；任一核心字段 RULE_UNSUPPORTED → ok=false。 */
export function compileCoreFields(src: RawSource, options: { orEnabled?: boolean } = {}): CompileResult {
  const core: Record<string, string> = {};
  const coreSet = new Set<string>(CORE_FIELDS);
  for (const [field, rule] of iterRulePairs(src)) {
    if (coreSet.has(field)) core[field] = rule;
  }
  return compileCoreFieldsFromRules(core, options);
}

/**
 * 对「字段名→规则文本」映射（核心字段冻结 fixture smoke-174.json 的 coreRules）跑编译。
 * 任一核心字段 RULE_UNSUPPORTED → ok=false。
 * `orEnabled`（P1a，默认 off）透传 parseFieldRule：on 态顶层 || 编译成 OrNode。
 */
export function compileCoreFieldsFromRules(
  coreRules: Record<string, string>, options: { orEnabled?: boolean } = {},
): CompileResult {
  const failures: CompileResult['failures'] = [];
  for (const [field, rule] of Object.entries(coreRules)) {
    if (typeof rule !== 'string' || !rule.trim()) continue;
    try {
      parseFieldRule(rule, options);
    } catch (err) {
      if (err instanceof RuleEngineError && err.code === 'RULE_UNSUPPORTED') {
        failures.push({ field, rule, message: err.message, diagnostic: err.diagnostic ?? { code: 'unsupported_rule' } });
      } else {
        failures.push({ field, rule, message: `非 RULE_UNSUPPORTED: ${String(err)}`, diagnostic: { code: 'unexpected_compile_error' } });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
