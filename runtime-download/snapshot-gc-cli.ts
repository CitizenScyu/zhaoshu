// B2-05 快照 GC 只读核对 CLI 主体(gcls-41)。外壳:scripts/snapshot-gc-dry-run.mjs。
//
// 凭据:只认三个键 GITHUB_TOKEN / GITHUB_REPOSITORY / DOWNLOAD_TARGET_BRANCH。给了 --env-file 就按键名
// 白名单逐行读(流式,不整文件读入,非白名单行直接丢弃,文件里其它键不进进程);否则取进程环境。token 只进请求头,
// 输出里只有仓库名、分支与统计,不出现任何凭据。只发 GET(见 snapshot-gc-store.ts)。

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createSnapshotGcStore } from './snapshot-gc-store';
import { runSnapshotGcDryRun, type DryRunRow, type DryRunStore } from './snapshot-gc-dry-run';

const ENV_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'DOWNLOAD_TARGET_BRANCH'] as const;
type EnvKey = typeof ENV_KEYS[number];

export async function readEnvKeys(path: string): Promise<Partial<Record<EnvKey, string>>> {
  const found: Partial<Record<EnvKey, string>> = {};
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (eq < 1 || line.startsWith('#')) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '') as EnvKey;
      if (!ENV_KEYS.includes(key)) continue;
      let value = line.slice(eq + 1).trim();
      if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      found[key] = value; // 重复键后值生效(与 systemd EnvironmentFile 同口径),故不提前停
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return found;
}

interface CliArgs { envFile?: string; limit?: number; offset?: number; stems: string[]; json: boolean; minRate?: number }

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { stems: [], json: false };
  const value = (i: number, flag: string) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`缺少参数值:${flag}`);
    return next;
  };
  const integer = (text: string, flag: string) => {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`参数必须是非负整数:${flag}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--env-file') args.envFile = value(i++, flag);
    else if (flag === '--limit') args.limit = integer(value(i++, flag), flag);
    else if (flag === '--offset') args.offset = integer(value(i++, flag), flag);
    else if (flag === '--min-rate') args.minRate = integer(value(i++, flag), flag);
    else if (flag === '--stem') args.stems.push(value(i++, flag));
    else if (flag === '--json') args.json = true;
    else throw new Error(`未知参数:${flag}`);
  }
  return args;
}

function formatRow(row: DryRunRow): string {
  const skip = row.skipped ? ` 跳过=${row.skipped}${row.detail ? `(${row.detail})` : ''}` : '';
  const unsized = row.unsizedOrphans ? ` 无大小孤儿=${row.unsizedOrphans}` : '';
  return `${row.name}\t卷=${row.volumes} 引用=${row.referenced} 孤儿=${row.orphans} 孤儿字节=${row.orphanBytes}${unsized}${skip}`;
}

export async function main(argv: string[], options: { env?: Record<string, string | undefined>; store?: DryRunStore; write?: (line: string) => void } = {}): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const args = parseCliArgs(argv);
  let store = options.store;
  let target = '(injected store)';
  if (!store) {
    const source = args.envFile ? await readEnvKeys(args.envFile) : (options.env ?? process.env);
    const token = source.GITHUB_TOKEN;
    const repository = source.GITHUB_REPOSITORY;
    const branch = source.DOWNLOAD_TARGET_BRANCH || 'main';
    if (!token) throw new Error('missing environment key: GITHUB_TOKEN'); // 只报键名
    if (!repository) throw new Error('missing environment key: GITHUB_REPOSITORY');
    store = createSnapshotGcStore({ token, repository, branch, timeoutMs: 30_000 });
    target = `${repository}@${branch}`;
  }
  write(`# snapshot-gc dry-run(只读,不删除) target=${target} at=${new Date().toISOString()}`);
  const { rows, summary } = await runSnapshotGcDryRun(store, {
    stems: args.stems.length ? args.stems : undefined,
    offset: args.offset, limit: args.limit, minRateRemaining: args.minRate,
    onRow: args.json ? undefined : row => write(formatRow(row)),
  });
  if (args.json) write(JSON.stringify({ rows, summary }, null, 2));
  const skipped = Object.entries(summary.skipped).map(([reason, n]) => `${reason}:${n}`).join(',') || '无';
  write(`# 汇总 书目录=${summary.booksListed} 本次扫描=${summary.booksScanned} 有快照卷=${summary.booksWithVolumes}`
    + ` 快照卷=${summary.volumes} 被引用=${summary.referenced} 孤儿=${summary.orphans} 孤儿字节=${summary.orphanBytes}`
    + ` 有孤儿的书=${summary.booksWithOrphans} 跳过=${skipped}`
    + (summary.stoppedEarly ? ` 提前停止=${summary.stoppedEarly}` : ''));
  const rate = store.rateLimit?.();
  if (rate) write(`# github rate remaining=${rate.remaining} reset=${new Date(rate.resetAt).toISOString()}`);
  return 0;
}
