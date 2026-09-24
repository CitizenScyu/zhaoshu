'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceProbePanelResult } from '@/lib/source-reader';

// 41-panel:浏览器换源面板的扇出调度(接口约定见 fanout-41-report §6)。
//   1. GET /api/read/source-probe            → 候选列表(不计限流、不出网)
//   2. 逐源 GET ...?title=&author=&source=   → 单源 probe,每行到达即渲染
// 前端并发有界(SOURCE_PROBE_CONCURRENCY),同 host 的候选不同时在飞(服务端节流只在单实例内有效)。
// 404 ⇒ 扇出未开(或旧部署无此路由),面板退回旧 alternates 路径;429/503 ⇒ 停发剩余 probe,不自动重试。

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 前端同时在飞的单源 probe 上限;服务端灰度建议 ≤6,这里留余量给同页的章节/预取请求。 */
export const SOURCE_PROBE_CONCURRENCY = 4;

export interface FanoutCandidate { url: string; name: string; tier: string; readable: boolean }

export type FanoutRow = FanoutCandidate & (
  | { state: 'pending' | 'probing' | 'skipped' | 'current' }
  | { state: 'done'; result: SourceProbePanelResult }
  | { state: 'failed'; message: string }
);

/**
 * loading:取候选中;disabled:扇出未开(退回旧面板);running/done:扫描中/结束;
 * rate_limited:429 停发(retryAfter 秒);unavailable:503 限流计数不可用;error:候选列表拿不到或鉴权失败。
 */
export type FanoutPhase = 'loading' | 'disabled' | 'running' | 'done' | 'rate_limited' | 'unavailable' | 'error';

export interface FanoutState { phase: FanoutPhase; rows: FanoutRow[]; retryAfter: number | null; message: string }

/** 同一阅读会话内的 probe 结果缓存:不对同一 (书, 源) 重复 probe(第一期服务端无缓存,每次都出网计数)。 */
export type ProbeCache = Map<string, SourceProbePanelResult>;

type Outcome =
  | { kind: 'result'; result: SourceProbePanelResult }
  | { kind: 'failed'; message: string }
  | { kind: 'stop'; phase: 'rate_limited' | 'unavailable' | 'error' | 'disabled'; retryAfter?: number | null; message: string }
  | { kind: 'aborted' };

const INITIAL: FanoutState = { phase: 'loading', rows: [], retryAfter: null, message: '' };

export function probeCacheKey(title: string, author: string, sourceUrl: string): string {
  return JSON.stringify([title, author, sourceUrl]);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 429 的等待秒数:body.retryAfterSeconds 优先,其次 Retry-After 头;都没有则 null(文案不写秒数)。 */
export function retryAfterSeconds(res: Response, data: unknown): number | null {
  const body = (data as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (typeof body === 'number' && Number.isFinite(body) && body > 0) return Math.ceil(body);
  const header = Number(res.headers.get('Retry-After'));
  return Number.isFinite(header) && header > 0 ? Math.ceil(header) : null;
}

function errorText(data: unknown, fallback: string): string {
  const error = (data as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error ? error : fallback;
}

function parseCandidates(data: unknown): FanoutCandidate[] | null {
  const sources = (data as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) return null;
  const seen = new Set<string>();
  const list: FanoutCandidate[] = [];
  for (const item of sources as Record<string, unknown>[]) {
    if (!item || typeof item.url !== 'string' || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    list.push({
      url: item.url, name: typeof item.name === 'string' && item.name ? item.name : item.url,
      tier: typeof item.tier === 'string' ? item.tier : 'builtin', readable: item.readable === true,
    });
  }
  return list;
}

function parseProbe(data: unknown, source: FanoutCandidate): SourceProbePanelResult | null {
  const body = data as Partial<SourceProbePanelResult> | null;
  if (!body || typeof body.status !== 'string') return null;
  return {
    ...body, status: body.status, sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : source.url,
    sourceName: typeof body.sourceName === 'string' ? body.sourceName : source.name,
    elapsedMs: Number(body.elapsedMs) || 0, requests: Number(body.requests) || 0, readable: body.readable === true,
  };
}

async function probeOne(apiFetch: ApiFetch, title: string, author: string, source: FanoutCandidate, signal: AbortSignal): Promise<Outcome> {
  const query = new URLSearchParams({ title, ...(author ? { author } : {}), source: source.url });
  let res: Response;
  let data: unknown;
  try {
    res = await apiFetch('/api/read/source-probe?' + query, { signal, cache: 'no-store' });
    data = await res.json().catch(() => null);
  } catch {
    return signal.aborted ? { kind: 'aborted' } : { kind: 'failed', message: '网络异常,未能检测该书源' };
  }
  if (signal.aborted) return { kind: 'aborted' };
  const code = (data as { code?: unknown } | null)?.code;
  if (res.ok) {
    const result = parseProbe(data, source);
    return result ? { kind: 'result', result } : { kind: 'failed', message: '检测结果无法识别' };
  }
  // 扫描途中开关被关:整体退回旧面板(与候选列表 404 同口径)。
  if (res.status === 404 && code === 'SOURCE_FANOUT_DISABLED') return { kind: 'stop', phase: 'disabled', message: '' };
  if (res.status === 404) return { kind: 'failed', message: '该书源已不在候选中,可点「重新检测」刷新候选' };
  if (res.status === 429) {
    return { kind: 'stop', phase: 'rate_limited', retryAfter: retryAfterSeconds(res, data), message: errorText(data, '换源探测过于频繁,请稍后再试。') };
  }
  if (res.status === 503) return { kind: 'stop', phase: 'unavailable', message: '换源探测暂时不可用,请稍后再试。' };
  if (res.status === 401 || res.status === 403) return { kind: 'stop', phase: 'error', message: errorText(data, '登录状态已失效,请重新登录后再试。') };
  // 504 = 准备阶段(鉴权后的建表/限流计数/候选池合成)超时,与 200 {status:'timeout'}(probe 本身超时)区分。
  if (res.status === 504) return { kind: 'failed', message: '服务繁忙,本源未开始检测(准备超时)' };
  return { kind: 'failed', message: errorText(data, '检测该书源失败') };
}

/**
 * 换源扇出:挂载即取候选并逐源 probe;卸载(关面板)即 abort 全部在途请求。
 * rescan() 只重测没有定论的行(超时/失败/未测),已有结果的行复用 cache,不重复计数。
 */
export function useSourceFanout({ apiFetch, title, author, currentSourceName, cache }: {
  apiFetch: ApiFetch; title: string; author: string; currentSourceName?: string; cache: ProbeCache;
}) {
  const [state, setState] = useState<FanoutState>(INITIAL);
  const [generation, setGeneration] = useState(0);
  // 当前源只在一次扫描开始时读:它不必 probe(已在读),变化也不应让在飞的扫描重来。
  // 按源名比对:阅读目录的 source.url 是书的详情页(sourceReaderIndex 填 bookUrl),不是源 url,见报告「契约缺口」。
  const current = useRef(currentSourceName);
  useEffect(() => { current.current = currentSourceName; }, [currentSourceName]);

  const scan = useCallback(async (signal: AbortSignal) => {
    const set = (update: (previous: FanoutState) => FanoutState) => { if (!signal.aborted) setState(update); };
    let res: Response;
    let data: unknown;
    try {
      res = await apiFetch('/api/read/source-probe', { signal, cache: 'no-store' });
      data = await res.json().catch(() => null);
    } catch {
      set(() => ({ ...INITIAL, phase: 'error', message: '换源候选加载失败,请重试。' }));
      return;
    }
    if (signal.aborted) return;
    // 404 SOURCE_FANOUT_DISABLED(开关关)或旧部署没有这条路由:都退回旧面板,不当错误提示。
    if (res.status === 404) { set(() => ({ ...INITIAL, phase: 'disabled' })); return; }
    if (res.status === 503) { set(() => ({ ...INITIAL, phase: 'unavailable', message: '换源探测暂时不可用,请稍后再试。' })); return; }
    const candidates = res.ok ? parseCandidates(data) : null;
    if (!candidates) { set(() => ({ ...INITIAL, phase: 'error', message: errorText(data, '换源候选加载失败,请重试。') })); return; }

    const exclude = current.current;
    const rows: FanoutRow[] = candidates.map((source) => {
      const cached = cache.get(probeCacheKey(title, author, source.url));
      if (cached) return { ...source, state: 'done', result: cached };
      return { ...source, state: exclude && source.name === exclude ? 'current' : 'pending' };
    });
    set(() => ({ phase: 'running', rows, retryAfter: null, message: '' }));
    const patch = (url: string, row: (source: FanoutCandidate) => FanoutRow) => set((previous) => ({
      ...previous, rows: previous.rows.map((item) => (item.url === url ? row(item) : item)),
    }));

    const queue = rows.filter((row) => row.state === 'pending');
    const busyHosts = new Set<string>();
    let active = 0;
    let stop: Extract<Outcome, { kind: 'stop' }> | null = null;
    await new Promise<void>((resolve) => {
      const pump = () => {
        if (signal.aborted || (stop && active === 0)) { resolve(); return; }
        for (let i = 0; !stop && i < queue.length && active < SOURCE_PROBE_CONCURRENCY;) {
          const source = queue[i];
          const host = hostOf(source.url);
          // 同 host 的候选排在前一个之后发,不同时在飞(跨实例的服务端节流不共享)。
          if (host && busyHosts.has(host)) { i++; continue; }
          queue.splice(i, 1);
          active++;
          if (host) busyHosts.add(host);
          patch(source.url, (item) => ({ ...item, state: 'probing' }));
          void probeOne(apiFetch, title, author, source, signal).then((outcome) => {
            active--;
            if (host) busyHosts.delete(host);
            if (outcome.kind === 'result') {
              // 超时不缓存:下次「重新检测」可以再试;其它结论(含 miss)同一会话内复用。
              if (outcome.result.status !== 'timeout') cache.set(probeCacheKey(title, author, source.url), outcome.result);
              patch(source.url, (item) => ({ ...item, state: 'done', result: outcome.result }));
            } else if (outcome.kind === 'failed') {
              patch(source.url, (item) => ({ ...item, state: 'failed', message: outcome.message }));
            } else if (outcome.kind === 'stop') {
              patch(source.url, (item) => ({ ...item, state: 'skipped' }));
              stop ??= outcome;
            }
            pump();
          });
        }
        if (!stop && active === 0 && queue.length === 0) resolve();
      };
      pump();
    });
    if (signal.aborted) return;
    const halted = stop as Extract<Outcome, { kind: 'stop' }> | null;
    if (!halted) { set((previous) => ({ ...previous, phase: 'done' })); return; }
    // 停发:队列里没发出去的行标「未检测」;不自动重试(429 要求等 Retry-After 秒)。
    const skipped = new Set(queue.map((source) => source.url));
    set((previous) => ({
      phase: halted.phase, retryAfter: halted.retryAfter ?? null, message: halted.message,
      rows: previous.rows.map((item) => (skipped.has(item.url) ? { ...item, state: 'skipped' } : item)),
    }));
  }, [apiFetch, title, author, cache]);

  useEffect(() => {
    const controller = new AbortController();
    void scan(controller.signal);
    return () => controller.abort();
  }, [scan, generation]);

  const rescan = useCallback(() => {
    setState(INITIAL);
    setGeneration((value) => value + 1);
  }, []);

  return { ...state, rescan };
}
