import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { withAuthHeaders } from '@/lib/auth-http';
import { ensureSchema } from '@/lib/db';
import { createDeadline, raceDeadline } from '@/lib/deadline';
import { cleanString } from '@/lib/sanitize';
import { getFanoutPool, sourceFanoutEnabled, sourceFanoutLimit } from '@/lib/shuyuan';
import { SOURCE_PROBE_BUDGET_MS, probeSourceForBook } from '@/lib/source-reader';

// 41-fanout 第一期（服务端）：浏览器换源面板逐源并发的单源入口。一次调用只查一个源，不循环、不遍历池。
//   GET /api/read/source-probe                              → 扇出候选列表（面板据此决定发哪些 probe）
//   GET /api/read/source-probe?title=&author=&source=<url>  → 单源 probe 结果（status 见 SourceProbeStatus）
// 开关 SOURCE_FANOUT_ENABLED 默认关：关闭时鉴权通过后一律 404 SOURCE_FANOUT_DISABLED。鉴权与阅读路由相同（read 能力）。
export const runtime = 'nodejs';
// 路由总预算 20s = 候选池合成（DB）+ 单源 probe（内部 SOURCE_PROBE_BUDGET_MS=15s，登记在 check-deploy-config
// 的 CROSS_FILE_BUDGETS）；maxDuration 再留 5s 给平台冷启动与响应序列化。
export const maxDuration = 25;
const SOURCE_PROBE_ROUTE_BUDGET_MS = 20_000;
const HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, X-Owner-Token', 'X-Content-Type-Options': 'nosniff' };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...HEADERS, ...(status === 503 || status === 504 ? { 'Retry-After': '5' } : {}) } });
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

export async function GET(req: NextRequest) {
  const auth = await requirePermission(req, 'read');
  if (!auth.ok) {
    const rejected = withAuthHeaders(auth.response);
    rejected.headers.set('X-Content-Type-Options', 'nosniff');
    return rejected;
  }
  if (!sourceFanoutEnabled()) return response({ error: '换源扇出未开启。', code: 'SOURCE_FANOUT_DISABLED' }, 404);
  const query = req.nextUrl.searchParams;
  const sourceUrl = cleanString(query.get('source') ?? '', 2048);
  const title = cleanString(query.get('title'), 200);
  const author = cleanString(query.get('author') ?? '', 200);
  const listOnly = !query.has('source');
  if (!listOnly && (!sourceUrl || !title || (query.get('author') && !author))) {
    return response({ error: '请输入有效的书名、作者和书源。', code: 'SOURCE_BOOK_INVALID' }, 400);
  }
  const deadline = createDeadline(SOURCE_PROBE_ROUTE_BUDGET_MS);
  const signal = AbortSignal.any([req.signal, deadline.signal]);
  try {
    await raceDeadline(signal, ensureSchema);
    const pool = await getFanoutPool(signal);
    if (listOnly) {
      return response({
        limit: sourceFanoutLimit(),
        sources: pool.map(({ url, name, tier, readable }) => ({ url, name, tier: tier ?? 'builtin', readable })),
      });
    }
    const source = pool.find((item) => item.url === sourceUrl);
    if (!source) return response({ error: '该书源不在可探测的候选里，请刷新候选列表。', code: 'SOURCE_PROBE_UNKNOWN_SOURCE' }, 404);
    // 单源预算取 min(15s, 路由余量)：前面合成候选池的耗时从 probe 里扣，绝不重获整份预算。
    const result = await probeSourceForBook(source, { title, author }, signal, {
      budgetMs: Math.min(SOURCE_PROBE_BUDGET_MS, deadline.remainingMs),
    });
    // 逐 probe 一行观测（E.4 墙钟/请求数标定用）：只记 host、结果、耗时、请求数，不记书名、作者、URL 路径与查询串。
    console.log(JSON.stringify({
      event: 'source_probe', status: result.status, sourceHost: hostOf(source.url),
      elapsedMs: result.elapsedMs, requests: result.requests, ...(result.code ? { code: result.code } : {}),
    }));
    return response({ ...result, readable: source.readable });
  } catch {
    if (signal.aborted) return response({ error: '书源查询已取消或超时，可稍后重试。', code: 'SOURCE_TIMEOUT' }, 504);
    console.error('Source probe request failed');
    return response({ error: '书源探测服务暂时不可用，请稍后重试。', code: 'SOURCE_INTERNAL' }, 500);
  } finally {
    deadline.dispose();
  }
}
