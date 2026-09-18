// 支持源注册表（设计 §5.2）：代码仓库内的单一事实源，替代散落的 book15 硬编码
// （config-audit 修复批次 #4：policy / parser / SQL / labeler / defaultSearch 五处）。
//
// 静态条目**只有** book15 内建适配器（tier='builtin'，继续走 source-parser 的站点特化解析）；
// 引擎档（M1/T7）条目不落本文件，运行时由 shuyuan.ts 的 getEngineSources 从
// shuyuan_sources JOIN source_admission 合成（源资格是「代码 + DB 数据」的联合事实）。
//
// import 约束：本文件**不得静态 import './db'**——依赖链 db → llm-usage → sanitize →
// source-policy → supported-sources 会成环（TDZ：source-policy 在模块初始化期读常量）。
// 故 engineHosts 用动态 import 取 sql。

/** 引擎支持档位（与 rule-engine/types.ts 的 Tier 同名同义；builtin 是本注册表专有档）。 */
export type SupportedSourceTier = 'builtin' | 'M1' | 'T7';

export interface SupportedSource {
  /** 规范化 bookSourceUrl（过 validateSourceUrl）。 */
  url: string;
  name: string;
  /** 含 {{key}}/{{page}} 模板。 */
  searchUrl: string;
  /** legado 规则原文；book15 内建条目为 {}（继续走 source-parser 适配器）。 */
  rules: Record<string, unknown>;
  /** builtin=book15 内建适配器；M1/T7=引擎解释。 */
  tier: SupportedSourceTier;
  enabled: boolean;
}

/**
 * book15 双 host（apex + www 同站别名，见 better-source-survey §1.2）。
 * 运行时 host 门（source-policy.ts）的内建兜底集合：冷启动/DB 不可达时**仍含**这两个 host，
 * fail-closed 语义是「收窄到内建集合」，绝不空集（空集会杀死全部现有阅读）。
 */
export const BUILTIN_SOURCE_HOSTS = ['book15.net', 'www.book15.net'] as const;
export type BuiltinSourceHost = (typeof BUILTIN_SOURCE_HOSTS)[number];

/** book15 内建适配器条目（迁移自五处硬编码里的 policy / SQL / defaultSearch 三处）。 */
export const BUILTIN_SOURCES: readonly SupportedSource[] = [
  {
    url: 'https://book15.net/',
    name: 'book15.net',
    searchUrl: 'https://book15.net/books/search.html?kw={{key}}',
    rules: {},
    tier: 'builtin',
    enabled: true,
  },
];

/** 内建源 URL 前缀（origin），供 getReadingSources 选行，替代硬编码的 ILIKE 字面量。 */
export function builtinUrlPrefixes(): string[] {
  return BUILTIN_SOURCES.map((source) => new URL(source.url).origin);
}

/** 内建兜底单源条目（合集里没有该 host 记录时复用，与 worker 同一适配器）。 */
export function builtinFallbackSource(): SupportedSource {
  return BUILTIN_SOURCES[0];
}

interface AdmissionHostRow { host: string }

/**
 * 从 DB source_admission 读「三滤网全过」源的 host 集合（设计 §5.2/§6.1）。
 * ok 态判据：compile_ok ∧ search_ok IS TRUE（滤网 3 probe 是 host 级健康态，由 probeWorker
 * 另行表达）。DB 不可达时**抛错**，由调用方 fail-closed 保持既有集合（绝不放大）。
 */
export async function engineHosts(signal?: AbortSignal): Promise<string[]> {
  const { getSql } = await import('./db');
  const sql = getSql();
  const query = sql`
    SELECT DISTINCT host FROM source_admission
    WHERE compile_ok AND search_ok IS TRUE AND host <> ''`;
  const [rows] = await sql.transaction([query], {
    readOnly: true, ...(signal ? { fetchOptions: { signal } } : {}),
  });
  return (rows as AdmissionHostRow[]).map((row) => row.host);
}
