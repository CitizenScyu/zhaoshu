// Read-only: list free hosts to register — pool hosts[] that are also the host of an enabled engine source,
// absent from the registry with no host dir under the data root, minus paywall/deny hosts. Sorted, first <max>.
// usage (as zsdownload): node pool-unregistered.mjs <max>; stdout one host per line, stderr one stats line.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const RT = '/opt/zhaoshu-download-b/runtime/lib/shared-rate';
const { hostKeyFor, hostDirRelative } = await import(join(RT, 'encoding.mjs'));
const POOL = '/var/lib/zhaoshu-sync/pool-artifact.json';
const REGISTRY = '/var/lib/zhaoshu-download-b/control/registry.json';
const DATA_ROOT = '/var/lib/zhaoshu-download-b/shared-rate-data';
const DENY = new Set(['book.qq.com', 'chuangshi.qq.com', 'ubook.reader.qq.com', 'yunqi.qq.com',
  'm.yuedu.163.com', 'www.ciweimao.com', 'so.html.qq.com']);
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const max = Number(process.argv[2]);
if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('usage: pool-unregistered.mjs <max 1..20>');
const norm = (h) => String(h).toLowerCase().replace(/\.$/, '');
const hostOf = (u) => { const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/:?#]+)/.exec(u ?? ''); return m ? norm(m[1]) : null; };
const pool = JSON.parse(readFileSync(POOL, 'utf8'));
const enabled = new Set(pool.engine.filter((s) => !s.disabled_at).map((s) => hostOf(s.source_url)).filter(Boolean));
const registered = JSON.parse(readFileSync(REGISTRY, 'utf8')).hosts;
let denied = 0, badName = 0;
const eligible = [];
for (const h of new Set(pool.hosts.map(norm))) {
  if (!enabled.has(h)) continue;
  if (!HOST_RE.test(h)) { badName++; continue; }
  const key = hostKeyFor(h);
  if (registered[key] || existsSync(join(DATA_ROOT, hostDirRelative(key)))) continue;
  if (DENY.has(h)) { denied++; continue; }
  eligible.push(h);
}
eligible.sort();
const picked = eligible.slice(0, max);
console.error(`pool=${pool.hosts.length} enabledEngineHosts=${enabled.size} eligible=${eligible.length} picked=${picked.length} deniedUnregistered=${denied} badName=${badName}`);
if (picked.length) console.log(picked.join('\n'));
