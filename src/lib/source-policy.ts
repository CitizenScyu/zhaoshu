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
let supportedHostsVersion = 0;

/** 发布版本包含同集合重刷，用于阻止在途旧读取覆盖外部更新。 */
export function supportedHostVersion(): number { return supportedHostsVersion; }

/**
 * 用一批 host 重算运行时集合（设计 §6.1 第 2 条）。语义：
 * - 始终以内建集合为底（book15 双 host 永不被移除，绝不空集）；
 * - 只并入**规范 hostname** 形态的条目（无端口/路径/userinfo/方括号），且非裸 IP/私网/环回；
 * - 传入空/全非法时结果 = 内建集合（收窄，绝不放大）。
 * cron 与运行时源池/下载定位均可更新本进程集合；这里不写数据库。
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
  supportedHostsVersion += 1;
}

/** 当前运行时 host 门的只读快照（字典序）。供 DB 读投影按门预筛（shuyuan.ts poolProbeMeta），不改门。 */
export function supportedHostList(): string[] {
  return [...supportedHosts].sort();
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

/**
 * 模板 URL 的 http→https 升级（41-urlfix）。
 *
 * 上游合集里的 URL 模板（searchUrl / bookUrl / tocUrl / 翻页模板）常写死 `http://`，而站点与源声明
 * 同 host、https 证书可用（srcfail-41 §5 实测：`sma.yueyouxs.com` 搜索模板改 https 后 200 + 合法 JSON；
 * 库里 17 行 url_invalid 里 7 行的错误正是「来源仅支持 HTTPS 完整地址」）。这类源此前准入连请求都不发，
 * 「改库里源数据」又会被每天重新拉取的合集覆盖，所以在代码层做规范化。
 *
 * 安全性：只改 scheme，host / 端口 / 路径 / 查询串**逐字不变**，然后再交给同一把锁的
 * `checkSourceUrl` 走完整检查（host 白名单、端口 443、userinfo、IP/私网红线一个不少）。
 * 因此本函数**不引入任何新的 host 授权**，只是把「注定被 scheme 判死」的模板换成同 host 的 https 再判一次；
 * 非白名单 host、非 443 端口、IP 直连升级后仍被拒（见 source-policy.test.ts 的反例）。
 *
 * 只识别**字面** `http://` 前缀（大小写不敏感）：其它 scheme（ftp:/javascript:/data:…）原样返回，
 * 交给 `checkSourceUrl` 照旧拒；相对引用（`/search?q=`、`//host/x`）原样返回，仍按基址解析。
 *
 * 刻意放在「模板展开后、过锁前」的调用点，而**不改 `checkSourceUrl` 本身**：
 * ① 跳转 Location 是服务端自己的指示，不属于「源模板」，不走升级（保持改动前语义）；
 * ② `validateSourceUrl` / `validateAdmissionUrl` 的既有语义与跨仓夹具
 *    `src/lib/fixtures/source-policy.json`（与 ../zhaoshu-books 逐字 deepEqual）都不需要改。
 */
export function upgradeSourceTemplateUrl(value: string): string {
  return /^http:\/\//i.test(value) ? `https://${value.slice(7)}` : value;
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

/**
 * 永久排除名单（Policy §4 红线）：取自主机会永远不再准入的 host 列表。
 * 匹配方式：精确 hostname 或后缀匹配（`banned.com` 同 `*.banned.com` 一起拒）。
 *
 * 硬默认名单：wnreader（历史 22 次复生投放源——Vercel cron 每 6h + admission timer 每 :17 复写）
 * 追加 via 环境变量 SHUYUAN_PERMANENT_DISABLE（分号分隔，支持 `api.xxx.com` 或 `xxx.com`）。
 *
 * 判定层只在 entry-point admission 候选筛选 + merge-url 入池两处使用；
 * 不重删既有 source_admission 行（由池合成侧按 disabled_at 落终态）。
 */
const DEFAULT_PERMANENT_DISABLE_HOSTS = ['api.wnreader.com', 'wnreader.com'] as const;

interface PermanentDisableCache {
  hosts: ReadonlySet<string>;
  suffixes: readonly string[];
  builtAt: number;
}

let permanentDisableCache: PermanentDisableCache | null = null;

function parsePermanentDisableEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SHUYUAN_PERMANENT_DISABLE;
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(/[;,]/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .filter((token) => !token.includes('/') && !token.includes(':') && !token.startsWith('['))
    .filter((token) => {
      try { return new URL(`https://${token}`).hostname === token; } catch { return false; }
    });
}

function permanentDisableHostsCache(env: NodeJS.ProcessEnv = process.env): PermanentDisableCache {
  if (permanentDisableCache && permanentDisableCache.builtAt >= 0) return permanentDisableCache;
  const extra = parsePermanentDisableEnv(env);
  const hosts = new Set<string>(DEFAULT_PERMANENT_DISABLE_HOSTS);
  for (const h of extra) hosts.add(h);
  // 同时加 suffix 形态：wnreader.com → 也匹  api.wnreader.com / sub.wnreader.com
  const suffixes: string[] = [];
  for (const h of hosts) suffixes.push(`.${h}`);
  permanentDisableCache = { hosts, suffixes, builtAt: Date.now() };
  return permanentDisableCache;
}

/** 命中即入的名单本身（供 shuyuan.ts 在每次 refresh 时随行挂 probeSnapshot.permanentDisable.hosts 观测用）。 */
export function permanentDisableHostList(): string[] {
  return [...permanentDisableHostsCache().hosts].sort();
}

/** url 是否命中永久排除名单（读侧调用前先做 URL 解析，host 取 lowercase+去尾点）。
 * 只认 https：其它 scheme（ftp:、file:、javascript:…）不属于「来源 URL」，一律当未命中，
 * 保持与 validateAdmissionUrl / validateSourceUrl 的 scheme 线一致。 */
export function isPermanentlyDisabledUrl(url: string): boolean {
  let hostname: string;
  let protocol: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    protocol = parsed.protocol;
  } catch { return false; }
  void protocol; // 仅供未来调试/审计扩展（当前不计入 suffix 判断）
  const { hosts, suffixes } = permanentDisableHostsCache();
  if (hosts.has(hostname)) return true;
  return suffixes.some((suffix) => hostname.endsWith(suffix));
}
