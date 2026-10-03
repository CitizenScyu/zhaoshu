import { alternateSourceHost, checkSourceUrl, refreshSupportedHosts, SourcePolicyError, validateSourceUrl } from './source-policy';
import { isActiveBuiltinHost } from './supported-sources';
import { getEngineSources, getPoolEngineHosts } from './shuyuan';
import { sourceRevision } from './source-revision';

/**
 * Same admission, disabled/probe filtering and host matching as T4 engine-fetch.
 *
 * 618-stalesource：builtin host 识别（旧书 source_url 仍是 book15.net）与 builtin 请求许可分离——
 * host 属内建集合但已退休（isActiveBuiltinHost=false）时，不直接放行 builtin 下载腿，改走引擎源池
 * 反查（找不到同站引擎源 ⇒ 与「该来源暂不支持全书下载」同一有限失败，不复活退休源）。
 */
export async function resolveDownloadSource(value: string) {
  // Syntax/security checks happen before the admission lookup; this does not grant source capability.
  const host = checkSourceUrl(value, undefined, { hostAllowed: () => true }).hostname;
  if (isActiveBuiltinHost(host)) {
    return { url: validateSourceUrl(value).href, kind: 'builtin', id: null, revision: '' };
  }
  const signal = AbortSignal.timeout(10_000);
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
