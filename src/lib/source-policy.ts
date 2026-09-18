// 只允许代码实际支持的书源；该策略不代替 DNS/实际连接地址防护。
// www 与 apex 是同一站点的两个 host（同内容、故障路径不相关，见 better-source-survey §1.2），
// fetch 层据此做请求级换 host 兜底；SUPPORTED_SOURCE_HOST 仍是规范化后的主 host。
export const SUPPORTED_SOURCE_HOSTS = ['book15.net', 'www.book15.net'] as const;
export type SupportedSourceHost = (typeof SUPPORTED_SOURCE_HOSTS)[number];
export const SUPPORTED_SOURCE_HOST: SupportedSourceHost = 'book15.net';

const supportedHosts = new Set<string>(SUPPORTED_SOURCE_HOSTS);

// 同站备用 host：输入集合内的 host 时返回另一个，否则 null（无备用可换）。
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
  if (typeof value !== 'string' || !value || value.length > 2048 ||
      value.includes('\\') || [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw new SourcePolicyError('来源地址为空、过长或包含异常字符');
  }
  const baseUrl = base === undefined ? undefined : validateSourceUrl(base);
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
  if (url.protocol !== 'https:' || !supportedHosts.has(url.hostname) ||
      url.port !== '' || url.username !== '' || url.password !== '') {
    throw new SourcePolicyError('仅支持 HTTPS book15.net 精确域名和默认端口/443');
  }
  url.hash = '';
  return url;
}
