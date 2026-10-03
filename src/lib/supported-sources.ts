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
 * 内建源生命周期。**静态、代码内声明**，不读 DB、不读 env、不受缓存影响——冷启动、库不可达、
 * 缓存过期都不改变结论。
 *
 * - active：允许发实际取文/搜索/下载请求（还须 enabled 开关同真，见 activeBuiltinSources）；
 * - retired：站点已死/长期不可达，退出活跃集。不删旧书/标签/URL 数据：旧 URL 仍可被身份解析
 *   （parseSourceIdentity/parseSourceChapters 不看本表），有书名/作者的阅读请求可换活跃引擎源，
 *   但对 retired host 的任何新 HTTP 请求都必须被拒。
 *
 * retired 优先级高于一切运行期信号：DB enabled=true、probe reachable、健康记忆成功、源池产物
 * 缓存里的旧 builtin 行，都不能让 retired 源回到活跃集。
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
  /** 可用开关：false 时条目不进活跃集（即便 lifecycle='active'）。活跃 = active 且 enabled 同真。 */
  enabled: boolean;
  /** 生命周期：active=允许发请求；retired=默认退休（host 门仍识别、活跃集剔除）。 */
  lifecycle: BuiltinSourceLifecycle;
  /** retired 的稳定原因码（进日志/观测；不进用户文案）。active 条目为 null。 */
  retiredReason: string | null;
}

/**
 * book15 双 host（apex + www 同站别名，见 better-source-survey §1.2）。
 * host **识别**集合：validateSourceUrl 的内建兜底、旧 URL 身份解析、同站归一键仍认这两个 host——
 * 「认得旧 URL」与「允许向它发请求」是两件事（识别 ≠ 许可，许可判定见 isActiveBuiltinHost）。
 * book15 自 09-21 Cloudflare 522 长期不可达（read-smoke-41 §0），已退休。
 */
export const BUILTIN_SOURCE_HOSTS = ['book15.net', 'www.book15.net'] as const;
export type BuiltinSourceHost = (typeof BUILTIN_SOURCE_HOSTS)[number];

/**
 * book15 内建适配器条目（迁移自五处硬编码里的 policy / SQL / defaultSearch 三处）。
 * lifecycle='retired'——长期 522，退出活跃源。旧书 source_url/标签/URL 数据不动；条目保留是
 * 为了 (a) 旧 URL 仍能解析身份 (b) 显式复活时只改这一处。
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
 * 活跃内建源：lifecycle='active' **且** enabled!==false（两条件缺一不可），可为空数组。
 *
 * 「允许发请求的内建源」判据——取书池/扇出/下载/confirm 反查全部经它（或 isActiveBuiltinHost），
 * 不各自读 BUILTIN_SOURCES 再自判（防散落 if）。返回**新数组**，调用方不得原地改。
 * 空数组是合法结论：无活跃 builtin 时允许空集合，调用方走活跃引擎源或给有限失败，
 * 不得用非空断言造默认源。
 */
export function activeBuiltinSources(): readonly SupportedSource[] {
  return BUILTIN_SOURCES.filter((source) => source.lifecycle === 'active' && source.enabled !== false);
}

/** 首个活跃内建源；无活跃 builtin 时返回 **null**（可空类型，逼调用点显式处理）。 */
export function activeBuiltinSource(): SupportedSource | null {
  return activeBuiltinSources()[0] ?? null;
}

/**
 * 内建档条目（兼容既有 CLI 合同，engine-fetch.mjs / runtime-download/engine.ts 读
 * BUILTIN_SOURCES[0] 构造 ReadingSource）：**识别用**，不判活跃性。调用方若要发请求，
 * 必须先经 isActiveBuiltinHost 判定。
 */
export function builtinFallbackSource(): SupportedSource {
  return BUILTIN_SOURCES[0];
}

/**
 * 注册表里 host（primary 或同源 apex/www 别名）对应的档条目；无匹配返回 null。
 * 识别/许可共用的 host 归一：trim + 小写 + 剥单个尾随根点（DNS FQDN 的 `book15.net.` 与
 * `book15.net` 是同一台服务器，只 trim/lowercase 会把它当不同 host 放过）。IDNA 域名由
 * URL.hostname 先行归一；裸字符串传入时本键只做字符级归一。
 */
export function builtinSourceForHost(host: string): SupportedSource | null {
  return sourceForHostIn(host, BUILTIN_SOURCES);
}

/** builtinSourceForHost 的可注入核心：以给定注册表为判据（测试可用合成注册表构造反例）。
 *  注册表序即优先序：首个命中（primary 直配或同源别名）的条目胜出。 */
export function sourceForHostIn(host: string, sources: readonly SupportedSource[]): SupportedSource | null {
  const normalized = normalizeBuiltinHost(host);
  return sources.find((source) => {
    const primary = normalizeBuiltinHost(hostOfUrl(source.url));
    return primary === normalized || aliasHostsOf(primary).includes(normalized);
  }) ?? null;
}

/**
 * host 是否属于某个**活跃**内建源（请求许可判定；识别判定见 BUILTIN_SOURCE_HOSTS）。
 * 须 lifecycle='active' 且 enabled!==false 同时成立；retired host 即便在识别集合里也返回
 * false——同站双 host 跟随主条目状态。本函数只做许可判定、不产生新授权：归一后仍走调用方
 * 既有的门/校验（不放宽 SSRF）。
 */
export function isActiveBuiltinHost(host: string): boolean {
  return isHostActiveInSources(host, BUILTIN_SOURCES);
}

/** isActiveBuiltinHost 的可注入核心：以给定注册表为判据（测试用合成注册表构造反例）。 */
export function isHostActiveInSources(host: string, sources: readonly SupportedSource[]): boolean {
  const source = sourceForHostIn(host, sources);
  return source !== null && source.lifecycle === 'active' && source.enabled !== false;
}

function normalizeBuiltinHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.length > 1 && trimmed.endsWith('.')
    && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.$/.test(trimmed)
    ? trimmed.slice(0, -1)
    : trimmed;
}

function hostOfUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * 同一注册域的 apex ↔ www 配对。**不跨源**：别名只在本源 primary 的 www/apex 形态间配对，
 * 其他内建源（即便同在识别集合里）的 host 不是本源别名——否则另一个 active 源的存在会让
 * retired 源的 host 借「别名」判定复活。
 */
function aliasHostsOf(primary: string): string[] {
  const match = /^www\.(.+)$/.exec(primary);
  return match ? [match[1]] : primary ? [`www.${primary}`] : [];
}
