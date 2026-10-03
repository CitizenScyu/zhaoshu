import { alternateSourceHost, checkSourceUrl, refreshSupportedHosts, SourcePolicyError, validateSourceUrl } from './source-policy';
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
  const source = pool.find((s) => {
    const candidate = new URL(s.url).hostname;
    return candidate === host || alternateSourceHost(host) === candidate;
  });
  if (!source) throw new SourcePolicyError('该来源暂不支持全书下载');
  return { url, kind: 'engine', id: source.url, revision: sourceRevision(source) };
}
