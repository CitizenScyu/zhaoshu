import { alternateSourceHost, checkSourceUrl, refreshSupportedHosts, SourcePolicyError, validateSourceUrl } from './source-policy';
import { BUILTIN_SOURCE_HOSTS, engineHosts } from './supported-sources';
import { getEngineSources } from './shuyuan';
import { sourceRevision } from './source-revision';

/** Same admission, disabled/probe filtering and host matching as T4 engine-fetch. */
export async function resolveDownloadSource(value: string) {
  // Syntax/security checks happen before the admission lookup; this does not grant source capability.
  const host = checkSourceUrl(value, undefined, { hostAllowed: () => true }).hostname;
  if ((BUILTIN_SOURCE_HOSTS as readonly string[]).includes(host)) {
    return { url: validateSourceUrl(value).href, kind: 'builtin', id: null, revision: '' };
  }
  const signal = AbortSignal.timeout(10_000);
  refreshSupportedHosts(await engineHosts(signal));
  const url = validateSourceUrl(value).href;
  const pool = await getEngineSources(signal);
  const source = pool.find((s) => {
    const candidate = new URL(s.url).hostname;
    return candidate === host || alternateSourceHost(host) === candidate;
  });
  if (!source) throw new SourcePolicyError('该来源暂不支持全书下载');
  return { url, kind: 'engine', id: source.url, revision: sourceRevision(source) };
}
