// P1a 影子求值接口（task-syntax-p1a 范围 4；rule-syntax-extension-design.md §7 P1a 行
// 「仅候选源影子求值，关闭即恢复旧 parser」）。
//
// 用途：ENGINE_SYNTAX_OR **保持 off**（生产准入/入池口径完全不变）时，对候选源跑一遍
// on 态编译 + 求值，产出**可对比的观测数据**（新语义下的逐字段结果），供后续放量决策。
// 纪律（红线）：
// - 不写库、不改 source_admission、不改任何准入结论——纯函数，输出只给调用方观察；
// - 不发网络请求：求值输入由调用方传入（与 evaluate.ts 同口径，引擎零网络）；
// - off 态生产路径（compileAdmission/compileSource 默认参数）完全不经本文件。
import { compileSource } from './compile';
import { compileAdmission } from './admission';
import { engineSyntaxOrEnabled } from './syntax-flags';
import type { RawSource } from './compile-smoke';
import { createScope, evaluateField, evaluateFieldNodes, normalizeBody } from './evaluate';

/** 单字段影子求值结果（脱敏观测口径；不进库）。 */
export interface ShadowFieldResult {
  field: string;
  /** on 态编译是否可解释（RULE_UNSUPPORTED 视为 false）。 */
  compiled: boolean;
  /** on 态求值输出（编译失败或求值异常时为空串，error 留原因摘要）。 */
  value: string;
  /** 列表字段：on 态首个非空节点集的命中数（bookList/chapterList 口径）。 */
  nodes?: number;
  error?: string;
}

export interface ShadowEvalResult {
  sourceUrl: string;
  /** 生产（off）态结论，作对照列——本函数不改它，只复述。 */
  currentCompileOk: boolean;
  /** 影子（on）态：核心字段是否全部可解释。 */
  shadowCompileOk: boolean;
  fields: ShadowFieldResult[];
  /** 影子口径的语义版本（观测对齐用；当前为 2）。 */
  shadowSemanticsVersion: 2;
}

const SHADOW_CORE_FIELDS = [
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

const LIST_FIELDS = new Set(['ruleSearch.bookList', 'ruleToc.chapterList']);

/**
 * 影子求值一个候选源（ENGINE_SYNTAX_OR=on 语义），**不改准入结论、不写库**。
 *
 * @param source 上游源条目（RawSource，同 compileAdmission 输入口径）
 * @param pages  供求值的页面文本（字段 → {text, contentType?, pageUrl}）；缺页的字段
 *               只产出 compile 结论，value 留空——影子求值不替调用方发请求。
 */
export function shadowEvaluateSource(
  source: RawSource,
  pages: Partial<Record<string, { text: string; contentType?: string; pageUrl: string }>> = {},
): ShadowEvalResult {
  if (engineSyntaxOrEnabled()) {
    // 开关已 on 时生产路径本身就是新语义，「影子」失去对照意义——拒绝执行而不是
    // 把 on 态结果冒充影子对照（观测纪律：两列必须来自两个明确口径）。
    throw new Error('ENGINE_SYNTAX_OR 已开启：影子求值仅在开关 off 时提供对照，请直接使用生产口径');
  }
  // off 态结论（复述，不修改）：compileAdmission 内含 survey 初筛 + 必需组校验。
  const current = compileAdmission(source);
  // on 态影子编译（orEnabled: true 显式覆盖，不受 env 影响；缓存键带语义版本 2，不污染 off 缓存）。
  const shadowCompiled = compileSource(
    { url: typeof source.bookSourceUrl === 'string' ? source.bookSourceUrl : '', searchUrl: source.searchUrl, rules: source as Record<string, unknown> },
    { orEnabled: true },
  );
  const fields: ShadowFieldResult[] = [];
  let shadowCompileOk = true;
  for (const name of SHADOW_CORE_FIELDS) {
    const entry = shadowCompiled.get(name);
    const rule = readRule(source, name);
    if (!entry || !rule) {
      // 源里根本没有这条规则：不算「影子编译失败」，与 compileAdmission 的字段位图口径一致。
      continue;
    }
    if ('skipped' in entry) {
      shadowCompileOk = false;
      fields.push({ field: name, compiled: false, value: '', error: 'RULE_UNSUPPORTED' });
      continue;
    }
    const result: ShadowFieldResult = { field: name, compiled: true, value: '' };
    const page = pages[name];
    if (page) {
      try {
        const scope = createScope(normalizeBody(page.text, page.contentType), page.pageUrl);
        if (LIST_FIELDS.has(name)) {
          const nodes = evaluateFieldNodes(entry, scope);
          result.nodes = nodes.length;
          result.value = String(nodes.length);
        } else {
          result.value = evaluateField(entry, scope, name === 'ruleContent.content').slice(0, 500);
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      }
    }
    fields.push(result);
  }
  return {
    sourceUrl: typeof source.bookSourceUrl === 'string' ? source.bookSourceUrl : '',
    currentCompileOk: current.ok,
    shadowCompileOk,
    fields,
    shadowSemanticsVersion: 2,
  };
}

/** 从 RawSource 读 `ruleSearch.bookList` 形式的字段原文（分组 → 字段）。 */
function readRule(source: RawSource, fieldName: string): string | undefined {
  const [group, key] = fieldName.split('.');
  const groupRules = source[group as keyof RawSource];
  if (!groupRules || typeof groupRules !== 'object' || Array.isArray(groupRules)) return undefined;
  const rule = (groupRules as Record<string, unknown>)[key];
  return typeof rule === 'string' && rule.trim() ? rule : undefined;
}
