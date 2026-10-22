import { checkSourceUrl, refreshSupportedHosts, SourcePolicyError, stationKeyOfHost, validateSourceUrl } from './source-policy';
import { builtinSourceForHost, isRetiredBuiltinHost } from './supported-sources';
import { getBuiltinRequestSource, getEngineSources, getPoolEngineHosts } from './shuyuan';
import { sourceRevision } from './source-revision';

/**
 * builtin 请求许可复用阅读池的注册/禁用/探测过滤；退休立即拒绝。
 * 引擎源沿用准入池及原 host 匹配。CLI 接入公共 builtin 查询另行实施。
 */
export async function resolveDownloadSource(value: string) {
  // Syntax/security checks happen before the admission lookup; this does not grant source capability.
  const target = checkSourceUrl(value, undefined, { hostAllowed: () => true });
  const host = target.hostname;
  const signal = AbortSignal.timeout(10_000);
  if (isRetiredBuiltinHost(host)) throw new SourcePolicyError('该来源暂不支持全书下载');
  if (builtinSourceForHost(host)) {
    const source = await getBuiltinRequestSource(host, signal);
    if (!source) throw new SourcePolicyError('该来源暂不支持全书下载');
    // 许可查询认同源尾点别名；规范请求 host 后仍过原安全门。
    target.hostname = target.hostname.replace(/\.$/, '');
    return { url: validateSourceUrl(target.href).href, kind: 'builtin', id: null, revision: '' };
  }
  // 41-poolimpl：门与池取自同一来源（源池产物优先，开关关/产物不可用即鲜读准入表，与改前相同）。
  refreshSupportedHosts(await getPoolEngineHosts(signal));
  const url = validateSourceUrl(value).href;
  const pool = await getEngineSources(signal);
  // 池内认源按全站统一站键（stationKeyOfHost：www./m./apex 同站，与阅读侧确认反查同一口径）；
  // 池序即质量序，首个同站匹配即得。用户 URL 仍逐字过 validateSourceUrl 的门，不引入新 host。
  const station = stationKeyOfHost(host);
  const source = pool.find((s) => {
    const candidate = stationKeyOfHost(new URL(s.url).hostname);
    return candidate.length > 0 && candidate === station;
  });
  if (!source) throw new SourcePolicyError('该来源暂不支持全书下载');
  return { url, kind: 'engine', id: source.url, revision: sourceRevision(source) };
}
