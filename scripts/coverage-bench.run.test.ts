// 换源覆盖率基准：联网实测运行器（vitest）。
// 为什么是 vitest 而不是纯 .mjs：生产 getFanoutPool/probeSourceForBook 从 @/lib/db.getSql 取库句柄，
// 离线复现只能像 swq41 那样用 vi.mock 把 getSql 换成 PGlite（灌入 ssh docker exec 只读导出的临时库快照）。
// 其余（池合成、扇出、身份校验、引擎出网）全是被测仓库真代码。只读：不写任何生产数据，出网只到书源站点。
//
// 运行（默认 skip，避免进 npm test）：
//   COVBENCH_RUN=1 COVBENCH_DUMP=<dump.json> [COVBENCH_SAMPLE=30] [COVBENCH_LABEL=master-41e0d0c] \
//     npx vitest run scripts/coverage-bench.run.test.ts
// 依赖代理出网国内站点：HTTP(S)_PROXY 由外部 env 传入（如 127.0.0.1:7891）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { it, vi } from 'vitest';

const { getSql } = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));

import { loadPGlite } from '@/lib/fixtures/pglite';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { initializeBusinessSchema } from '@/lib/business-schema';
import { getFanoutPool } from '@/lib/shuyuan';
import { probeSourceForBook } from '@/lib/source-reader';
import { canonicalBookKey } from '@/lib/book-identity';
import { summarize, renderMarkdown } from './coverage-bench-stats.mjs';

const RUN = process.env.COVBENCH_RUN === '1';
const DUMP = process.env.COVBENCH_DUMP;
const FIXTURE = process.env.COVBENCH_FIXTURE || resolve(__dirname, 'fixtures/coverage-bench.json');
const OUTDIR = process.env.COVBENCH_OUT || resolve(__dirname, '../../covbench-scratch');
const LABEL = process.env.COVBENCH_LABEL || 'run';
const SAMPLE = Number.parseInt(process.env.COVBENCH_SAMPLE || '0', 10);
const BUDGET = Number(process.env.PROBE_BUDGET_MS || 12000);
const GLOBAL_LIMIT = Number(process.env.COVBENCH_GLOBAL || 8);
const HOST_LIMIT = Number(process.env.COVBENCH_PER_HOST || 2);

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };

function lazySql(pg: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) {
  type Statement = { text: string; params: unknown[] };
  const run = async ({ text, params }: Statement) => (await pg.query(text, params)).rows;
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = ''; const params: unknown[] = [];
    parts.forEach((part, i) => { text += part; if (i < values.length) { params.push(values[i]); text += `$${params.length}`; } });
    const statement = { text, params };
    return { ...statement, then: (ok: (r: unknown[]) => unknown, fail: (e: unknown) => unknown) => run(statement).then(ok, fail) };
  };
  return Object.assign(tag, {
    transaction: async (qs: Statement[]) => { const out: unknown[][] = []; for (const q of qs) out.push(await run(q)); return out; },
    query: async (text: string, params: unknown[] = []) => run({ text, params }),
  });
}

// 全局并发 ≤ GLOBAL_LIMIT，每 host 并发 ≤ HOST_LIMIT 的任务跑批。
async function runTasks<T>(tasks: { host: string; fn: () => Promise<T> }[], onDone: (t: T) => void) {
  const pending = [...tasks];
  let active = 0;
  const hostActive = new Map<string, number>();
  return new Promise<void>((resolveAll) => {
    const pump = () => {
      if (pending.length === 0 && active === 0) return resolveAll();
      while (active < GLOBAL_LIMIT) {
        const i = pending.findIndex((t) => (hostActive.get(t.host) || 0) < HOST_LIMIT);
        if (i === -1) break;
        const task = pending.splice(i, 1)[0];
        active++;
        hostActive.set(task.host, (hostActive.get(task.host) || 0) + 1);
        task.fn().then(onDone).catch(() => {}).finally(() => {
          active--;
          hostActive.set(task.host, (hostActive.get(task.host) || 1) - 1);
          pump();
        });
      }
    };
    pump();
  });
}

// COVBENCH_APPEND

type Book = { title: string; author: string; tier: string; genre: string };

function stratifiedSample(books: Book[], n: number): Book[] {
  if (!n || n >= books.length) return books;
  const byTier = new Map<string, Book[]>();
  for (const b of books) (byTier.get(b.tier) || byTier.set(b.tier, []).get(b.tier)!).push(b);
  const out: Book[] = [];
  for (const [, arr] of byTier) {
    const take = Math.max(1, Math.round(n * (arr.length / books.length)));
    out.push(...arr.slice(0, take));
  }
  return out.slice(0, n);
}

it.skipIf(!RUN)('coverage bench 联网实测', async () => {
  if (!DUMP) throw new Error('COVBENCH_DUMP 未设置（临时库只读快照 dump.json 路径）');
  process.env.READING_ENGINE_SOURCES = process.env.READING_ENGINE_SOURCES || '1';
  process.env.SOURCE_FANOUT_ENABLED = process.env.SOURCE_FANOUT_ENABLED || '1';
  process.env.SOURCE_FANOUT_LIMIT = process.env.SOURCE_FANOUT_LIMIT || '60';

  // 出网走代理（如 mihomo 127.0.0.1:7891）：引擎 fetch 用全局 fetch，设 undici 全局 dispatcher 即可。
  const proxy = process.env.COVBENCH_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy) {
    const { setGlobalDispatcher, ProxyAgent } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.error(`[proxy] ${proxy}`);
  }

  const PG = (await loadPGlite())!;
  const pg = new PG();
  await pg.exec('CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY)');
  await initializeBusinessSchema(createPGliteSql(pg) as never);
  const dump = JSON.parse(readFileSync(DUMP, 'utf8'));
  await pg.query(`INSERT INTO shuyuan_sources (source_url, name, source, disabled_at, last_error)
    SELECT source_url, name, source, disabled_at::timestamptz, last_error
    FROM jsonb_to_recordset($1::jsonb) AS x(source_url text, name text, source jsonb, disabled_at text, last_error text)`,
  [JSON.stringify(dump.sources)]);
  await pg.query(`INSERT INTO source_admission SELECT * FROM jsonb_populate_recordset(null::source_admission, $1::jsonb)`,
    [JSON.stringify(dump.admission)]);
  await pg.query(`UPDATE shuyuan_meta SET collections = $1::jsonb, refreshed_at = $2::timestamptz WHERE id = 1`,
    [JSON.stringify(dump.meta.collections), dump.meta.refreshed_at]);
  await pg.exec('ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS title_key text');
  getSql.mockReturnValue(lazySql(pg));

  const pool = await getFanoutPool(AbortSignal.timeout(30000));
  const readableCount = pool.filter((s) => s.readable).length;
  console.error(`[pool] ${pool.length} 条，readable=${readableCount}，hosts=${new Set(pool.map((s) => hostOf(s.url))).size}`);

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const books: Book[] = stratifiedSample(fixture.books as Book[], SAMPLE);
  console.error(`[books] 全量 ${fixture.books.length}，本次 ${books.length}${SAMPLE ? `（分层抽样 ${SAMPLE}）` : ''}`);

  const perBook = new Map<string, { title: string; author: string; tier: string; genre: string; perSource: unknown[] }>();
  for (const b of books) perBook.set(`${b.title}|${b.author}`, { title: b.title, author: b.author, tier: b.tier, genre: b.genre, perSource: [] });

  const tasks: { host: string; fn: () => Promise<void> }[] = [];
  for (const b of books) {
    const rec = perBook.get(`${b.title}|${b.author}`)!;
    for (const source of pool) {
      const host = hostOf(source.url);
      tasks.push({ host, fn: async () => {
        const t0 = Date.now();
        let r: { status: string; code?: string; book?: { title?: string; author?: string } };
        try {
          r = await probeSourceForBook(source, { title: b.title, author: b.author }, AbortSignal.timeout(BUDGET + 2000), { budgetMs: BUDGET });
        } catch (e) { r = { status: 'threw', code: (e as Error)?.name }; }
        const idExact = r.status === 'ok' && r.book
          ? canonicalBookKey(r.book.title || '', r.book.author || '') === canonicalBookKey(b.title, b.author)
          : undefined;
        // 源返回的书名/作者落盘，供离线逐条复核（covid41：算完 idExact 就丢，raw 无法回看）。
        // 截断 100 字；缺失存 null。fuzzy 记下是否走了模糊降级（probe 判 ok 时恒 false，旧 raw 无此字段）。
        const clip = (v: string | undefined) => (v ? v.slice(0, 100) : null);
        const gotTitle = r.status === 'ok' && r.book ? clip(r.book.title) : null;
        const gotAuthor = r.status === 'ok' && r.book ? clip(r.book.author) : null;
        rec.perSource.push({
          host, name: source.name, status: r.status, readable: source.readable, ms: Date.now() - t0, code: r.code, idExact,
          gotTitle, gotAuthor, fuzzy: false,
        });
      } });
    }
  }
  console.error(`[tasks] ${tasks.length} 次探测（${books.length} 本 × ${pool.length} 源），全局≤${GLOBAL_LIMIT}/host≤${HOST_LIMIT}`);

  let done = 0;
  await runTasks(tasks, () => { if (++done % 100 === 0) console.error(`[progress] ${done}/${tasks.length}`); });

  const results = [...perBook.values()];
  const meta = { generatedAt: new Date().toISOString(), label: LABEL, codeVersion: process.env.COVBENCH_CODE || null, poolSize: pool.length, sample: SAMPLE || null };
  const summary = summarize(results, meta);
  mkdirSync(OUTDIR, { recursive: true });
  const stem = `${OUTDIR}/coverage-${LABEL}`;
  writeFileSync(`${stem}.raw.json`, JSON.stringify({ meta, pool: pool.map((s) => [s.name, s.url, s.readable]), results }, null, 2));
  writeFileSync(`${stem}.summary.json`, JSON.stringify(summary, null, 2));
  writeFileSync(`${stem}.report.md`, renderMarkdown(summary, { title: LABEL }));
  console.error(`[done] 覆盖率 ${(summary.totals.coverageRate * 100).toFixed(1)}%（${summary.totals.covered}/${summary.totals.books}），单点依赖 ${(summary.singlePoint.ratio * 100).toFixed(1)}% → ${stem}.{raw,summary,report}`);
  await pg.close();
}, 3_600_000);
