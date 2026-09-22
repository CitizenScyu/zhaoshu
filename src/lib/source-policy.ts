import { BUILTIN_SOURCE_HOSTS, type BuiltinSourceHost } from './supported-sources';

// 只允许代码实际支持的书源；该策略不代替 DNS/实际连接地址防护。
// www 与 apex 是同一站点的两个 host（同内容、故障路径不相关，见 better-source-survey §1.2），
// fetch 层据此做请求级换 host 兜底；SUPPORTED_SOURCE_HOST 仍是规范化后的主 host。
// 静态内建集合迁自 supported-sources.ts 注册表（设计 §5.3）。
export const SUPPORTED_SOURCE_HOSTS = BUILTIN_SOURCE_HOSTS;
export type SupportedSourceHost = BuiltinSourceHost;
export const SUPPORTED_SOURCE_HOST: SupportedSourceHost = 'book15.net';

// 运行时 host 白名单：常态 = 内建集合；cron 准入批次经 refreshSupportedHosts 并入
// source_admission ok 态 host（§6.1）。冷启动/加载失败保持内建集合——
// **绝不放大、也绝不空集**（空集会杀死全部现有阅读）。
const builtinHosts: ReadonlySet<string> = new Set(BUILTIN_SOURCE_HOSTS);
let supportedHosts: ReadonlySet<string> = builtinHosts;

/**
 * 用一批 host 重算运行时集合（设计 §6.1 第 2 条）。语义：
 * - 始终以内建集合为底（book15 双 host 永不被移除，绝不空集）；
 * - 只并入**规范 hostname** 形态的条目（无端口/路径/userinfo/方括号），且非裸 IP/私网/环回；
 * - 传入空/全非法时结果 = 内建集合（收窄，绝不放大）。
 * 写入口只在 cron 准入批次（shuyuan.ts refreshWithinBudget）；运行时请求无写路径。
 */
export function refreshSupportedHosts(hosts: Iterable<string>): void {
  const next = new Set<string>(builtinHosts);
  for (const host of hosts) {
    if (typeof host !== 'string') continue;
    const normalized = host.trim().toLowerCase();
    // 只接受规范 hostname：允许字母/数字/连字符/点，至少一个点，首尾非点，且非 IP/私网字面量。
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(normalized) || isForbiddenHostAddress(normalized)) continue;
    next.add(normalized);
  }
  supportedHosts = next;
}

// 同站备用 host：输入集合内的 host 时返回另一个，否则 null（无备用可换）。
// 这里的 length 守卫不是「常量恒为 2 所以永假」的装饰：SUPPORTED_SOURCE_HOSTS 是
// as const 二元组（apex ↔ www 同站别名），但「返回另一个」的 `1 - index` 只在集合恰为
// 二元组时有唯一解——集合扩到 3 个 host 时 `SUPPORTED_SOURCE_HOSTS[-1]` 会静默给出
// undefined。守卫把「集合形态不支持换位」归一成「无备用」这一个安全结果。
export function alternateSourceHost(hostname: string): SupportedSourceHost | null {
  if (SUPPORTED_SOURCE_HOSTS.length !== 2) return null;
  const index = SUPPORTED_SOURCE_HOSTS.indexOf(hostname as SupportedSourceHost);
  return index === -1 ? null : SUPPORTED_SOURCE_HOSTS[1 - index];
}

export class SourcePolicyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SourcePolicyError';
  }
}

// 相对引用只接受已验证的基址；返回规范 URL，供请求、入队和循环检测使用。
export function validateSourceUrl(value: unknown, base?: string): URL {
  return checkSourceUrl(value, base, { hostAllowed: (hostname) => supportedHosts.has(hostname) });
}

/**
 * 两把锁共享的检查函数源（设计 §4.4 / v3 E4）：validateSourceUrl（运行时门）与
 * admission.ts 的 validateAdmissionUrl（准入门）逐条同款，**只有 host 白名单来源不同**
 * （前者=已准入 ok host，后者=shuyuan_sources 声明的 bookSourceUrl host）。
 * 任何检查项改动必须只改这里，禁止在两把锁里各写一份（防漂移）。
 */
export interface SourceUrlPolicy {
  /** host 白名单判定（hostname 已由 URL 小写与规范化）。 */
  hostAllowed(hostname: string): boolean;
}

export function checkSourceUrl(value: unknown, base: string | undefined, policy: SourceUrlPolicy): URL {
  if (typeof value !== 'string' || !value || value.length > 2048 ||
      value.includes('\\') || [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw new SourcePolicyError('来源地址为空、过长或包含异常字符');
  }
  const baseUrl = base === undefined ? undefined : checkSourceUrl(base, undefined, policy);
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https:\/\//i.test(value)) {
    throw new SourcePolicyError('来源仅支持 HTTPS 完整地址');
  }
  const authority = /^(?:https:)?\/\/([^/?#]*)/i.exec(value)?.[1];
  // URL 会丢弃空 userinfo（https://@host），因此还必须检查原始 authority。
  if (authority !== undefined && (!authority || authority.includes('@') ||
      (authority.includes(':') && !authority.endsWith(':443')))) {
    throw new SourcePolicyError('来源地址不能包含 userinfo、空 authority 或非 443 端口');
  }
  let url: URL;
  try {
    url = new URL(value, baseUrl?.href);
  } catch {
    throw new SourcePolicyError('来源地址无法解析');
  }
  if (url.protocol !== 'https:' || !policy.hostAllowed(url.hostname) ||
      url.port !== '' || url.username !== '' || url.password !== '') {
    throw new SourcePolicyError('仅支持 HTTPS 精确域名和默认端口/443');
  }
  // IP/私网红线（v3 E4）：两把锁同防线。裸 IP 直连（WHATWG URL 已把十进制/十六进制
  // 归一化为点分 IPv4）与 IPv6 字面量（含 ::1、fc00::/7）一律拒，即便它出现在
  // shuyuan_sources 声明的 bookSourceUrl 里。
  if (isForbiddenHostAddress(url.hostname)) {
    throw new SourcePolicyError('来源地址禁止直连 IP 或私网/环回地址');
  }
  url.hash = '';
  return url;
}

/** 裸 IP / IPv6 字面量判定（URL.hostname 形态：IPv4 点分、IPv6 带方括号）。 */
export function isForbiddenHostAddress(hostname: string): boolean {
  if (hostname.includes(':') || hostname.startsWith('[')) return true; // IPv6 字面量（含 ::1、fc00::/7）
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname); // 任意 IPv4 直连（公网/私网/环回/链路本地全拒）
}
