// M1 准入门（设计 §4）：三滤网。本文件是 cron 侧准入的纯逻辑层——DB 读写留在
// shuyuan.ts（runAdmissionBatch 只吃内存态、吐要写库的行），便于单测与判定隔离。
//
// 关键防线（设计 §4.4 / v3 E4）：
// - 滤网 1 compileAdmission：纯本地，survey 初筛 + 核心字段 compile；
// - 滤网 2 searchAdmission：真实搜索一次，走独立 admissionFetch 通道（自带
//   validateAdmissionUrl），**不经过运行时 host 门 fetchSourceText/validateSourceUrl**；
// - 两把锁共享 source-policy.ts 的 checkSourceUrl（检查项逐条同款，仅 host 白名单来源不同）；
// - admissionFetch / validateAdmissionUrl **不导出**（任务 4 有导出快照断言）。

import { createHash } from 'node:crypto';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import { sourceAbortable } from '@/lib/source-fetch';
import { CORE_FIELDS, iterRulePairs, selectCandidates, type RawSource } from './compile-smoke';
import { parseFieldRule } from './parse';
import {
  createScope, evaluateField, evaluateFieldNodes, insideNode, normalizeBody, type HtmlScope,
} from './evaluate';
import { RuleEngineError } from './types';

// ---------------------------------------------------------------- 常量
export const DEFAULT_ADMISSION_KEYWORD = '斗破苍穹';
export const ADMISSION_TIMEOUT_MS = 8_000;
export const ADMISSION_MAX_BYTES = 2 * 1024 * 1024;
export const ADMISSION_MAX_REDIRECTS = 3;
export const ADMISSION_THROTTLE_MS = 350;
/** 每轮刷新最多跑几个新源的真实搜索（对齐 PROBE_DISCOVERY_PER_REFRESH 模式，设计 §4.2）。 */
export const ADMISSION_MAX_PROBES_PER_REFRESH = 5;
/** deferred 态重测间隔（设计 §4.2：软故障/url_invalid 每 24h 重测）。 */
export const ADMISSION_RETEST_INTERVAL_MS = 24 * 3_600_000;
/** 剩余预算低于此值即整批跳过，绝不挤占 90s 刷新（设计风险台账 #4）。 */
export const ADMISSION_MIN_BUDGET_MS = 10_000;

// CHALLENGE_MARKERS 口径对齐 probe-reachability.py:33。cloudflare 字样过宽（正常经 CF CDN
// 的页面 meta 也可能有），单列 weak；强标记要求 status 403/503 或命中弱集合外的 marker。
const CHALLENGE_MARKERS = [
  'just a moment', 'cf-mitigated', 'ge_js_validator', 'cf-challenge',
  'challenge-platform', 'attention required', 'cloudflare',
  'checking your browser', '请开启 javascript', 'enable javascript',
  'ddos protection by', '安全验证', '人机验证',
] as const;
const STRONG_CHALLENGE_MARKERS = CHALLENGE_MARKERS.filter((marker) => marker !== 'cloudflare');

// ---------------------------------------------------------------- 滤网 1（compileAdmission，纯本地）
export type AdmissionTier = 'M1' | 'T7';

export interface AdmissionCompile {
  /** 核心字段全部可解释（无 RULE_UNSUPPORTED），且通过 survey 初筛。 */
  ok: boolean;
  tier: AdmissionTier;
  /** 13 核心字段的可用性位图（诊断用，设计 §4.3 core_field_mask）。 */
  coreFieldMask: Record<string, boolean>;
  failures: { field: string; rule: string; message: string }[];
  /** 失败摘要（空串=通过），写进 source_admission.error。 */
  reason: string;
}

/**
 * 滤网 1：规则可解释（设计 §4.1）。survey 初筛（HTTPS 源 URL、纯 GET 搜索模板、
 * bookSourceType≠2、无 JS）+ 对全部核心字段跑 compile；任一核心字段
 * RULE_UNSUPPORTED → 拒。装饰字段不阻断（本层只看核心字段）。
 */
export function compileAdmission(source: RawSource): AdmissionCompile {
  const coreFieldMask: Record<string, boolean> = {};
  for (const field of CORE_FIELDS) coreFieldMask[field] = false;

  if (selectCandidates([source]).length !== 1) {
    return {
      ok: false, tier: 'T7', coreFieldMask, failures: [],
      reason: '未通过 survey 初筛（HTTPS/无JS/纯GET搜索/非听书/含 bookList+content）',
    };
  }
  const failures: AdmissionCompile['failures'] = [];
  for (const [field, rule] of iterRulePairs(source)) {
    if (!(field in coreFieldMask)) continue;
    try {
      parseFieldRule(rule);
      coreFieldMask[field] = true;
    } catch (error) {
      const message = error instanceof RuleEngineError ? error.message : String(error);
      failures.push({ field, rule, message });
    }
  }
  const ok = failures.length === 0;
  return {
    ok, tier: ok ? 'M1' : 'T7', coreFieldMask, failures,
    reason: ok ? '' : failures.map((f) => `${f.field}: ${f.message}`).join('; ').slice(0, 200),
  };
}

// ---------------------------------------------------------------- 滤网 2（searchAdmission）
export type AdmissionVerdict =
  | 'ok' | 'challenge' | 'conn_fail' | 'http_5xx' | 'http_4xx' | 'shell' | 'url_invalid' | 'no_result';

/** 判定分桶（设计 §4.1 v3 E2）：ok / rejected（站点行为终态）/ deferred（可复测）。 */
export function admissionBucket(verdict: string): 'ok' | 'rejected' | 'deferred' {
  switch (verdict) {
    case 'ok': return 'ok';
    case 'challenge':
    case 'conn_fail':
    case 'shell':
      return 'rejected';
    default: // http_5xx / http_4xx / url_invalid / no_result（含空 verdict=未测）
      return 'deferred';
  }
}

/** 可注入的传输层（测试用）。校验函数不可注入——见 admissionFetch 内部。 */
export type AdmissionTransport = (input: string, init: {
  signal: AbortSignal;
  redirect: 'manual';
  headers: Record<string, string>;
}) => Promise<Response>;

export const defaultAdmissionTransport: AdmissionTransport = (input, init) => fetch(input, init);

/** 准入门校验（设计 §4.4）：与 validateSourceUrl 共享 checkSourceUrl，仅 host 白名单来源不同。 */
function validateAdmissionUrl(value: unknown, base: string | undefined, declaredHosts: ReadonlySet<string>): URL {
  return checkSourceUrl(value, base, { hostAllowed: (hostname) => declaredHosts.has(hostname) });
}

interface AdmissionFetchOptions {
  fetchPage: AdmissionTransport;
  declaredHosts: ReadonlySet<string>;
  signal: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  throttleMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function cancelBody(response: Response, reason?: unknown) {
  if (response.body && !response.body.locked) void response.body.cancel(reason).catch(() => {});
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function readCappedBody(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    cancelBody(response);
    throw new SourcePolicyError('书源响应体积超限');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  let text = '';
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await sourceAbortable(reader.read(), signal);
      if (done) { complete = true; return text + decoder.decode(); }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new SourcePolicyError('书源响应体积超限');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!complete) void reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  }
}

/**
 * 准入专用探测通道（设计 §4.4，内部函数，不导出）。
 * 最小复制 fetchSourceText 的既有参数（8s 总超时、2MB 上限、3 跳重定向、350ms 节流、
 * 跳转逐跳复验），但**不经过运行时 host 门**，改用 validateAdmissionUrl；不做换 host 重试
 * （alternateSourceHost 是 book15 专有语义，准入对象无备用 host 概念）。
 * HTTP 状态码不抛错——challenge/http_5xx 分桶需要拿到 status 与 body。
 */
async function admissionFetch(input: string, options: AdmissionFetchOptions): Promise<{ url: string; status: number; text: string }> {
  const {
    fetchPage, declaredHosts, signal, timeoutMs = ADMISSION_TIMEOUT_MS,
    maxRedirects = ADMISSION_MAX_REDIRECTS, maxBytes = ADMISSION_MAX_BYTES,
    throttleMs = ADMISSION_THROTTLE_MS, sleep = defaultSleep,
  } = options;
  const initial = validateAdmissionUrl(input, undefined, declaredHosts);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('准入探测超时', 'TimeoutError')), timeoutMs);
  const probeSignal = controller.signal;
  let lastRequestAt = 0;
  const throttle = async () => {
    if (throttleMs <= 0) return;
    const wait = lastRequestAt + throttleMs - Date.now();
    if (wait > 0) await sleep(wait, probeSignal);
    lastRequestAt = Date.now();
  };
  try {
    let current = initial.href;
    const visited = new Set([current]);
    for (let redirects = 0; ; redirects += 1) {
      probeSignal.throwIfAborted();
      await throttle();
      probeSignal.throwIfAborted();
      const response = await fetchPage(current, {
        signal: probeSignal, redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; novel-finder-admission/1.0)' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        cancelBody(response);
        if (!location) throw new SourcePolicyError('书源跳转缺少 Location');
        if (redirects >= maxRedirects) throw new SourcePolicyError('书源跳转次数超限');
        const next = validateAdmissionUrl(location, current, declaredHosts).href;
        if (visited.has(next)) throw new SourcePolicyError('书源跳转形成循环');
        visited.add(next);
        current = next;
        continue;
      }
      const text = await readCappedBody(response, probeSignal, maxBytes);
      probeSignal.throwIfAborted();
      return { url: current, status: response.status, text };
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** 用源模板展开一次搜索 URL（复用 sourceSearchUrl 的纯 GET 口径，但走准入门校验）。 */
function expandAdmissionSearchUrl(source: RawSource, declaredHosts: ReadonlySet<string>): string {
  const template = source.searchUrl;
  if (typeof template !== 'string' || template.length > 2048 || !/\{\{key\}\}/.test(template)) {
    throw new SourcePolicyError('书源缺少支持的搜索模板');
  }
  const keyword = typeof source.checkKeyWord === 'string' && source.checkKeyWord.trim()
    ? source.checkKeyWord.trim() : DEFAULT_ADMISSION_KEYWORD;
  const expanded = template.replace(/\{\{key\}\}/g, encodeURIComponent(keyword)).replace(/\{\{page\}\}/g, '1');
  if (/[{}]|@js:|<js>|,\s*\[/i.test(expanded)) throw new SourcePolicyError('不支持该书源的动态搜索规则');
  const base = typeof source.bookSourceUrl === 'string' ? source.bookSourceUrl : undefined;
  return validateAdmissionUrl(expanded, base, declaredHosts).href;
}

const MAX_CANDIDATE_SCAN = 50;

/** bookList 求值 → 逐条 name/bookUrl 可解析的候选数（设计 §4.1：≥1 即 ok）。 */
function countSearchCandidates(source: RawSource, text: string, pageUrl: string): number {
  const rules = source.ruleSearch;
  if (!rules || typeof rules !== 'object') return 0;
  const bookList = (rules as Record<string, unknown>).bookList;
  const name = (rules as Record<string, unknown>).name;
  const bookUrl = (rules as Record<string, unknown>).bookUrl;
  if (typeof bookList !== 'string') return 0;
  const parseSafe = (rule: unknown) => {
    if (typeof rule !== 'string' || !rule.trim()) return undefined;
    try { return parseFieldRule(rule); } catch { return undefined; }
  };
  const listIr = parseSafe(bookList);
  if (!listIr) return 0;
  const nameIr = parseSafe(name);
  const bookUrlIr = parseSafe(bookUrl);
  let scope;
  try { scope = createScope(normalizeBody(text), pageUrl); } catch { return 0; }
  if (scope.kind !== 'html') return 0;
  let nodes;
  try { nodes = evaluateFieldNodes(listIr, scope); } catch { return 0; }
  let count = 0;
  for (let i = 0; i < nodes.length && i < MAX_CANDIDATE_SCAN; i += 1) {
    const inner = insideNode(scope as HtmlScope, nodes[i]);
    try {
      const title = nameIr ? evaluateField(nameIr, inner) : '';
      const url = bookUrlIr ? evaluateField(bookUrlIr, inner) : '';
      if (title.trim() && url.trim()) count += 1;
    } catch { /* 单条候选求值失败：跳过，不影响整页判定（§3.4 失败隔离） */ }
  }
  return count;
}

export interface AdmissionSearchResult {
  verdict: AdmissionVerdict;
  candidateCount: number;
  status?: number;
  error: string;
}

/**
 * 滤网 2：真实搜索一次（设计 §4.1）。传输层可注入；校验函数不可注入。
 * 返回分桶 verdict，由调用方（runAdmissionBatch）决定状态转移与写库。
 */
export async function searchAdmission(source: RawSource, options: {
  fetchPage: AdmissionTransport;
  declaredHosts: ReadonlySet<string>;
  signal: AbortSignal;
  throttleMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
}): Promise<AdmissionSearchResult> {
  let url: string;
  try {
    url = expandAdmissionSearchUrl(source, options.declaredHosts);
  } catch (error) {
    return { verdict: 'url_invalid', candidateCount: 0, error: errorMessage(error) };
  }
  let response: { url: string; status: number; text: string };
  try {
    response = await admissionFetch(url, options);
  } catch (error) {
    if (options.signal.aborted) throw error; // 调用方中止（预算耗尽/取消）：不写判定
    if (error instanceof SourcePolicyError) {
      return { verdict: 'url_invalid', candidateCount: 0, error: errorMessage(error) };
    }
    return { verdict: 'conn_fail', candidateCount: 0, error: errorMessage(error) };
  }
  const low = response.text.toLowerCase();
  // 判定顺序（P1-2 裁定）：403/503 与 5xx/4xx 状态先判，**候选计数先于强标记**。
  // 反例教训：200 正常搜索页页脚含「安全验证/enable javascript/人机验证」时，若标记先判
  // 会把它误判成 challenge（rejected 终态、24h 不重测）；probe-reachability.py 只是一次性
  // 探测，准入把它升级成了永久拒。故「有 ≥1 候选的正常页一律 ok」，墙只在 403/503 或
  // 「0 候选 + 强标记」成立。弱标记 cloudflare 仍不判墙。
  if (response.status === 403 || response.status === 503) {
    return { verdict: 'challenge', candidateCount: 0, status: response.status, error: String(response.status) };
  }
  if (response.status >= 500) return { verdict: 'http_5xx', candidateCount: 0, status: response.status, error: String(response.status) };
  if (response.status >= 400) return { verdict: 'http_4xx', candidateCount: 0, status: response.status, error: String(response.status) };
  const candidateCount = countSearchCandidates(source, response.text, response.url);
  if (candidateCount >= 1) return { verdict: 'ok', candidateCount, status: response.status, error: '' };
  const marker = STRONG_CHALLENGE_MARKERS.find((item) => low.includes(item));
  if (marker !== undefined) {
    return { verdict: 'challenge', candidateCount: 0, status: response.status, error: marker };
  }
  if (response.text.length < 3000 && (low.match(/<script/g)?.length ?? 0) >= 2 &&
      !low.includes('<h') && !low.includes('book') && !low.includes('novel')) {
    return { verdict: 'shell', candidateCount: 0, status: response.status, error: `len=${response.text.length}` };
  }
  return { verdict: 'no_result', candidateCount: 0, status: response.status, error: 'bookList 未解析出候选' };
}

// ---------------------------------------------------------------- 状态机（runAdmissionBatch）
export interface AdmissionSourceRow {
  source_url: string;
  tier: string;
  compile_ok: boolean;
  core_field_mask: Record<string, boolean>;
  search_ok: boolean | null;
  search_verdict: string;
  search_checked_at: string | null;
  rules_hash: string;
  host: string;
  error: string;
}

export interface AdmissionCandidate {
  /** 规范化后的 bookSourceUrl（与 shuyuan_sources.source_url 对齐）。 */
  url: string;
  /** 上游源条目原文（ruleSearch/bookSourceUrl/searchUrl/checkKeyWord ...）。 */
  source: RawSource;
}

export interface AdmissionBatchInput {
  candidates: AdmissionCandidate[];
  /** shuyuan_sources 声明的全部 bookSourceUrl host（候选池，设计 §4.4）。 */
  declaredHosts: ReadonlySet<string>;
  /** 库里既有 source_admission 行（source_url → row），无则空 Map。 */
  existing: Map<string, AdmissionSourceRow>;
  fetchPage: AdmissionTransport;
  signal: AbortSignal;
  now?: () => Date;
  maxProbes?: number;
  throttleMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 每次网络探测前的预算判定；返回 false 即停止继续探测（已写的本地结论不受影响）。 */
  canProbe?: () => boolean;
}

export interface AdmissionBatchResult {
  /** 需要 upsert 的行（可能少于 candidates——规则未变、结论不变的不重写）。 */
  rows: AdmissionSourceRow[];
  compileOk: number;
  compileRejected: number;
  probed: number;
  verdicts: Record<string, number>;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** revision(source) 同款 stable-sha1：jsonb 键顺序不算变化，数组顺序算。 */
export function rulesHash(source: unknown): string {
  const stable = JSON.stringify(source, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
      : item);
  return createHash('sha1').update(stable ?? '').digest('hex');
}

function isRetestDue(row: AdmissionSourceRow, nowMs: number): boolean {
  if (row.search_ok === null) return true; // 未测（含被限流跳过的新源）
  if (admissionBucket(row.search_verdict) !== 'deferred') return false;
  if (!row.search_checked_at) return true;
  const checked = Date.parse(row.search_checked_at);
  return !Number.isFinite(checked) || nowMs - checked >= ADMISSION_RETEST_INTERVAL_MS;
}

/**
 * 跑一轮准入批次（设计 §4.2）。纯逻辑：不碰 DB，输入既有行、输出要写库的行。
 * 状态机：new → compile_rejected（终态，规则不变不复测）｜new → deferred → (ok|rejected)｜ok。
 * 每轮真实搜索 ≤ maxProbes（默认 5）；canProbe 为 false 时停止探测但仍写出可离线得到的结论。
 */
export async function runAdmissionBatch(input: AdmissionBatchInput): Promise<AdmissionBatchResult> {
  const now = input.now ?? (() => new Date());
  const rows: AdmissionSourceRow[] = [];
  const verdicts: Record<string, number> = {};
  let compileOk = 0;
  let compileRejected = 0;
  let probed = 0;
  let probeSlots = Math.max(0, input.maxProbes ?? ADMISSION_MAX_PROBES_PER_REFRESH);
  const canProbe = input.canProbe ?? (() => true);

  for (const candidate of input.candidates) {
    const hash = rulesHash(candidate.source);
    const previous = input.existing.get(candidate.url);
    const host = hostOf(candidate.url);
    const compile = compileAdmission(candidate.source);

    if (!compile.ok) {
      compileRejected += 1;
      // 规则未变且上一轮已是 compile 拒 → 终态不重写（§4.2）。
      if (previous && previous.rules_hash === hash && previous.compile_ok === false) continue;
      rows.push({
        source_url: candidate.url, tier: 'T7', compile_ok: false, core_field_mask: compile.coreFieldMask,
        search_ok: null, search_verdict: '', search_checked_at: null, rules_hash: hash, host, error: compile.reason,
      });
      continue;
    }
    compileOk += 1;

    const rulesChanged = !previous || previous.rules_hash !== hash;
    const needsProbe = !previous || previous.rules_hash !== hash || isRetestDue(previous, now().getTime());
    if (!needsProbe) continue; // 结论仍有效，不重写

    if (probeSlots > 0 && canProbe() && !input.signal.aborted) {
      probeSlots -= 1;
      probed += 1;
      const result = await searchAdmission(candidate.source, {
        fetchPage: input.fetchPage, declaredHosts: input.declaredHosts, signal: input.signal,
        throttleMs: input.throttleMs, sleep: input.sleep,
      });
      verdicts[result.verdict] = (verdicts[result.verdict] ?? 0) + 1;
      rows.push({
        source_url: candidate.url, tier: 'M1', compile_ok: true, core_field_mask: compile.coreFieldMask,
        search_ok: result.verdict === 'ok', search_verdict: result.verdict,
        search_checked_at: now().toISOString(), rules_hash: hash, host,
        error: result.error,
      });
      continue;
    }
    // 本轮没轮到/预算不足：仅在「规则变过或库中无行」时写一条未测行占位，下一轮接着测。
    if (rulesChanged) {
      rows.push({
        source_url: candidate.url, tier: 'M1', compile_ok: true, core_field_mask: compile.coreFieldMask,
        search_ok: null, search_verdict: '', search_checked_at: null, rules_hash: hash, host, error: '',
      });
    }
  }
  return { rows, compileOk, compileRejected, probed, verdicts };
}
