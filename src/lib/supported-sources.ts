// 支持源注册表（设计 §5.2）：代码仓库内的单一事实源，替代散落的 book15 硬编码
// （config-audit 修复批次 #4：policy / parser / SQL / labeler / defaultSearch 五处）。
//
// 静态条目**只有** book15 内建适配器（tier='builtin'，继续走 source-parser 的站点特化解析）；
// 引擎档（M1/T7）条目不落本文件，运行时由 shuyuan.ts 的 getEngineSources 从
// shuyuan_sources JOIN source_admission 合成（源资格是「代码 + DB 数据」的联合事实）。
//
// 本模块进入客户端依赖图，必须保持无服务端导入（包括动态 import）。
// 数据库准入查询 engineHosts 位于 supported-sources-server.ts，不从这里重导出。

/** 引擎支持档位（与 rule-engine/types.ts 的 Tier 同名同义；builtin 是本注册表专有档）。 */
export type SupportedSourceTier = 'builtin' | 'M1' | 'T7';

/**
 * 内建源生命周期（618-stalesource）。**静态、代码内声明**，不读 DB、不读 env、不受缓存影响——
 * 冷启动、库不可达、缓存过期都不改变结论（任务书判据 4：缓存/冷启动/DB 不可用不得使退役源复活）。
 *
 * - active：允许发实际取文/搜索/下载请求的源。只有 active 源进取书池/扇出/下载；
 * - retired：站点已死/长期不可达，**默认退出活跃集**。不删旧书/标签/URL 数据（任务书判据 1）：
 *   旧 book15 URL 仍可被身份解析（parseSourceIdentity/parseSourceChapters 不看本表），
 *   阅读请求可凭书名/作者换到活跃引擎源——但任何对 retired host 的**新 HTTP 请求**都必须被拒。
 *
 * 退休优先级高于一切运行期信号：DB 里 enabled=true、probe reachable、健康记忆成功、
 * 源池产物缓存里的旧 builtin 行，都不能让 retired 源回到活跃集（主协调红线）。
 */
export type BuiltinSourceLifecycle = 'active' | 'retired';

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
  /** ⚠️ 历史字段：仅表示「条目登记在册」，不再是「允许发请求」。活跃性一律看 lifecycle。 */
  enabled: boolean;
  /** 生命周期（618-stalesource）：active=允许发请求；retired=默认退休（host 门仍识别、活跃集剔除）。 */
  lifecycle: BuiltinSourceLifecycle;
  /** retired 的稳定原因码（进日志/观测；不进用户文案）。active 条目为 null。 */
  retiredReason: string | null;
}

/**
 * book15 双 host（apex + www 同站别名，见 better-source-survey §1.2）。
 * host **识别**集合：validateSourceUrl 的内建兜底、旧 URL 身份解析、同站归一键仍认这两个 host——
 * 「认得旧 URL」与「允许向它发请求」是两件事（任务书判据 3：允许识别 ≠ 允许请求）。
 * 618-stalesource：book15 自 09-21 Cloudflare 522 长期不可达（read-smoke-41 §0），默认退休。
 */
export const BUILTIN_SOURCE_HOSTS = ['book15.net', 'www.book15.net'] as const;
export type BuiltinSourceHost = (typeof BUILTIN_SOURCE_HOSTS)[number];

/**
 * book15 内建适配器条目（迁移自五处硬编码里的 policy / SQL / defaultSearch 三处）。
 * 618-stalesource：lifecycle='retired'——book15 长期 522，默认退出活跃源。旧书 source_url/
 * 标签/URL 数据不动；entry 保留是为了 (a) 旧 URL 仍能解析身份 (b) 显式复活时只改这一处。
 */
export const BUILTIN_SOURCES: readonly SupportedSource[] = [
  {
    url: 'https://book15.net/',
    name: 'book15.net',
    searchUrl: 'https://book15.net/books/search.html?kw={{key}}',
    rules: {},
    tier: 'builtin',
    enabled: true,
    lifecycle: 'retired',
    retiredReason: 'host_dead_cloudflare_522_since_2026_09_21',
  },
];

/** 内建源 URL 前缀（origin），供 getReadingSources 选行，替代硬编码的 ILIKE 字面量。 */
export function builtinUrlPrefixes(): string[] {
  return BUILTIN_SOURCES.map((source) => new URL(source.url).origin);
}

/**
 * 活跃内建源（618-stalesource）：lifecycle='active' 的条目，类型上可为空数组。
 *
 * 这是「允许发请求的内建源」的唯一判据——取书池/扇出/下载/confirm 反查全部经它，不各自读
 * BUILTIN_SOURCES 再自判（防散落 if）。返回**新数组**，调用方不得原地改。
 * 空数组是合法结论：无活跃 builtin 时允许返回空集合，调用方走活跃引擎源或给有限失败，
 ** 不得用非空断言造默认源（任务书判据 2）。
 */
export function activeBuiltinSources(): readonly SupportedSource[] {
  return BUILTIN_SOURCES.filter((source) => source.lifecycle === 'active');
}

/**
 * 首个活跃内建源；无活跃 builtin 时返回 **null**（可空类型，逼调用点显式处理，任务书判据 2）。
 * 旧 builtinFallbackSource() 的「无记录即补回默认源」语义在此终结：退休源不再被静默复活。
 */
export function activeBuiltinSource(): SupportedSource | null {
  return activeBuiltinSources()[0] ?? null;
}

/**
 * 内建档条目（兼容既有 CLI 合同，engine-fetch.mjs / runtime-download/engine.ts 读
 * BUILTIN_SOURCES[0] 构造 ReadingSource）：**识别用**，不判活跃性。调用方若要发请求，
 * 必须先经 activeBuiltinSource() 判定。
 */
export function builtinFallbackSource(): SupportedSource {
  return BUILTIN_SOURCES[0];
}

/**
 * host 是否属于某个**活跃**内建源（请求许可判定；识别判定见 BUILTIN_SOURCE_HOSTS）。
 * retired host 即便在 BUILTIN_SOURCE_HOSTS 里也返回 false——同站双 host 跟随主条目状态。
 */
export function isActiveBuiltinHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return BUILTIN_SOURCES.some((source) => source.lifecycle === 'active'
    && (hostOfUrl(source.url) === normalized || alternateBuiltinHost(source, normalized)));
}

function hostOfUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 同站别名判定：BUILTIN_SOURCE_HOSTS 里与该条目同站（apex ↔ www）的另一个 host。 */
function alternateBuiltinHost(source: SupportedSource, host: string): boolean {
  const primary = hostOfUrl(source.url);
  return BUILTIN_SOURCE_HOSTS.some((candidate) => candidate !== primary && candidate === host);
}
