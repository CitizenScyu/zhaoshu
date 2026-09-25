// M1 准入门（设计 §4）：三滤网。本文件是 cron 侧准入的纯逻辑层——DB 读写留在
// shuyuan.ts（runAdmissionBatch 只吃内存态、吐要写库的行），便于单测与判定隔离。
//
// 关键防线（设计 §4.4 / v3 E4）：
// - 滤网 1 compileAdmission：纯本地，survey 初筛 + 核心字段 compile + 最低必需组（N03：
//   缺目录/搜索/正文任一必需规则 = 无可执行阅读路径，compile 拒）；
// - 滤网 2 searchAdmission：真实搜索一次，走独立 admissionFetch 通道（自带
//   validateAdmissionUrl），**不经过运行时 host 门 fetchSourceText/validateSourceUrl**；
// - 两把锁共享 source-policy.ts 的 checkSourceUrl（检查项逐条同款，仅 host 白名单来源不同）；
// - admissionFetch / validateAdmissionUrl **不导出**（任务 4 有导出快照断言）。

import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import { sourceRevision } from '@/lib/source-revision';
import { sourceAbortable } from '@/lib/source-fetch';
import { CORE_FIELDS, iterRulePairs, selectCandidates, type RawSource } from './compile-smoke';
import { parseFieldRule } from './parse';
import {
  createScope, evaluateField, evaluateFieldNodes, insideNode, normalizeBody, type HtmlScope,
} from './evaluate';
import { RuleEngineError, type RuleDiagnostic } from './types';
import { engineSourceRevision } from './compile';
import { engineSemanticsVersion, engineSyntaxOrEnabled } from './syntax-flags';

// ---------------------------------------------------------------- 常量
export const DEFAULT_ADMISSION_KEYWORD = '斗破苍穹';
export const ADMISSION_TIMEOUT_MS = 8_000;
export const ADMISSION_MAX_BYTES = 2 * 1024 * 1024;
export const ADMISSION_MAX_REDIRECTS = 3;
export const ADMISSION_THROTTLE_MS = 350;
/**
 * 每轮刷新最多跑几个新源的真实搜索（对齐 PROBE_DISCOVERY_PER_REFRESH 模式，设计 §4.2）。
 * 名额上限的**默认值**：实际生效值走 `admissionMaxProbes()`——env `ADMISSION_MAX_PROBES`
 * 可覆盖（非法/≤0/缺失回退本默认），便于不发版调吞吐。env 可调的理由（41-ADMIT-THROUGHPUT）：
 * 全库 1681 源、准入未测占大头，而 cron 每天只跑一轮 ⇒ 名额直接决定每天探测量。默认 20 的
 * 安全边际：单源最坏墙钟 ≈ 8.4s（8s 超时 + 350ms 节流）⇒ 20 源最坏 ≈ 168s，加写库与 compile
 * 余量后总墙钟 ≈ 264s，仍在平台 maxDuration=295s 与 REFRESH_BUDGET_MS=180s 之上的整批
 * canProbe 止损（`shuyuan.ts` 剩 ≤ ADMISSION_TIMEOUT_MS+WRITE_RESERVE_MS 即停探）保护下。
 * 提到 25 会顶破 295s，故 20 是当前安全上限。
 */
export const DEFAULT_ADMISSION_MAX_PROBES = 20;
/**
 * 每轮准入探测名额：env `ADMISSION_MAX_PROBES` 生效；非法/≤0/缺失回退默认（同款
 * `readingPoolLimit()` 口径）。参数化 env 便于单测注入，不改动真实 process.env。
 */
export function admissionMaxProbes(env: AdmissionProbesEnv = process.env): number {
  const parsed = Number.parseInt(env.ADMISSION_MAX_PROBES ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ADMISSION_MAX_PROBES;
}
/** env 形状（宽松：process.env 与测试注入对象都可直接代入）。 */
interface AdmissionProbesEnv {
  ADMISSION_MAX_PROBES?: string | undefined;
  ADMISSION_PROBE_CONCURRENCY?: string | undefined;
  [key: string]: string | undefined;
}
/**
 * 探测并发度**默认值**:1 = 与历史逐源串行行为逐行一致(零行为变更)。
 * 实际生效值走 `admissionProbeConcurrency()`——env `ADMISSION_PROBE_CONCURRENCY` 可覆盖
 * (非法/≤0/缺失回退本默认,再夹上限)。
 *
 * 吞吐算式(41-ADMIT-CONC):单源最坏墙钟 ≈ 8.4s(8s 超时 + 350ms 节流)。并发 c 时
 * 最坏墙钟 ≈ ceil(名额/c) × 8.4s——**仅在候选 host 两两互异时成立**;同 host 候选被
 * 互斥串行化,最坏仍是 名额 × 8.4s。c=4、名额 20 ⇒ ceil(20/4)=5 × 8.4s ≈ 42s,远小于
 * 串行 20×8.4≈168s 的包络;因此开到 c=4 后名额可经 env `ADMISSION_MAX_PROBES` 提到约 60
 * (ceil(60/4)=15 × 8.4 ≈ 126s,仍落在今天 168s 的包络内)。**默认名额 20 不变**——并发
 * 与名额是两个独立旋钮,本改造只引入并发、默认不放大名额。
 */
export const DEFAULT_ADMISSION_PROBE_CONCURRENCY = 1;
/**
 * 并发度硬上限:8。上游是小说站,同站并发易被 429/封;同站互斥(见 runAdmissionBatch,
 * 互斥键取 `admissionMutexHost`:searchUrl 展开后的 host,展开失败退回 bookSourceUrl host,
 * 41-fanout)把同一目标站的并发压到 1——实际请求打向的就是展开后的 host,两个源 bookSourceUrl
 * 不同但 searchUrl 同站时也串行。跨站 8 路已足够吃掉「名额/并发」的墙钟。夹上限防 env
 * 误配(c=100)把探测风暴打向上游。
 */
export const MAX_ADMISSION_PROBE_CONCURRENCY = 8;
/**
 * 探测并发度:env `ADMISSION_PROBE_CONCURRENCY` 生效;非法/≤0/缺失回退默认(=1,串行),
 * 合法值再夹上限 8。解析口径与 `admissionMaxProbes()` 完全同款(parseInt + SafeInteger + >0)。
 */
export function admissionProbeConcurrency(env: AdmissionProbesEnv = process.env): number {
  const parsed = Number.parseInt(env.ADMISSION_PROBE_CONCURRENCY ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_ADMISSION_PROBE_CONCURRENCY;
  return Math.min(parsed, MAX_ADMISSION_PROBE_CONCURRENCY);
}
/**
 * deferred 态重测间隔（设计 §4.2：软故障定期重测）。适用 http_4xx/http_5xx/query_insensitive、
 * 网络期 url_invalid 与可疑 ok；no_result 与本地确定性 url_invalid 另见 ADMISSION_NO_RESULT_RETEST_MS、
 * isRetestDue（41-srcfix P2）。
 * 取 20h 而非 24h：cron 有分钟级抖动/偶发漏触发，严格 24h 判据会把前一日刚测过的
 * deferred 源推迟一整周期才复测；20h 留 4h 余量，保证每个自然日至少复测一次。
 */
export const ADMISSION_RETEST_INTERVAL_MS = 20 * 3_600_000;
/**
 * no_result 复测窗（41-srcfix P2）：no_result 是「页面拿到了、bookList 解析不出候选」，主因是规则/
 * 引擎解析缺口（srcfail-41 §2），站点侧抖动少见——规则变 rules_hash 就变、自动重排，引擎语义变
 * 也随语义版本前缀进 hash；剩下按时间复测只为兜「站点暂时空结果」这一小类。20h 窗下 30 行
 * no_result 每天吃 30 个名额（名额默认 20/天），把 class 2 的 ok 复核饿死（srclife-41b G1/G2）。
 * 取 72h：需求降到 1/3，站点恢复最迟晚 3 天回池。http_4xx/5xx、query_insensitive 仍按 20h。
 */
export const ADMISSION_NO_RESULT_RETEST_MS = 72 * 3_600_000;
/**
 * conn_fail 衰减复测窗（41-B1-RETRY）：conn_fail 仍归 rejected 桶（出池、漏斗口径不变），
 * 但不再是「一次 8s 超时定终身」——search_checked_at 距今超过该窗即回到待复探，下一轮
 * cron 拿到名额就重探。取 7d 而非 20h：死站每源每周最多吃 1 个探测名额（名额默认 20/轮 ×
 * cron 每日 1 轮，env ADMISSION_MAX_PROBES 可调；K 个死站只占 K/7 每天），瞬时抖动误杀的源最迟 7 天回池。
 * challenge/shell 是站点行为（非网络层），维持终态不衰减。
 */
export const ADMISSION_CONN_FAIL_RETEST_MS = 7 * 24 * 3_600_000;
/**
 * ok 源长周期复核窗（41-B2-OK-RECHECK）：源一旦判 ok 即永久在池，站点改版/上反爬/关站后
 * 系统仍认为它 search_ok=true，用户每次阅读都白等它一轮切片。ok 行 search_checked_at 距今
 * ≥ 本窗（或时间戳缺失/非法）即到期复核。取 7d 与 conn_fail 衰减同窗：池内源每周最多吃
 * 1 个名额，且 ok 复核排在 class 2（名额最后），名额紧时不抢未测与复测源。
 */
export const ADMISSION_OK_RECHECK_MS = 7 * 24 * 3_600_000;
/**
 * 可疑 ok 的 strike 标记前缀（41-B2-OK-RECHECK）：ok 复核首次失败**不直接出池**——
 * error 写成 `recheck_fail:<本次真实 verdict>`，search_ok/verdict 保持 ok（源留池）。
 * 不加列、不加 verdict 字面量：池谓词 `search_ok IS TRUE` 与漏斗口径都不看 error 内容。
 * 可疑行按 ADMISSION_RETEST_INTERVAL_MS(20h) 到期走 class 1 再确认，再失败才写真实结论出池。
 */
export const ADMISSION_RECHECK_FAIL_PREFIX = 'recheck_fail:';
/** 剩余预算低于此值即整批跳过，绝不挤占刷新预算（设计风险台账 #4）。 */
export const ADMISSION_MIN_BUDGET_MS = 10_000;

// ---------------------------------------------------------------- 查询不敏感判据（espfix41）
// 反例：4702.zejfxszmh.cc 对任何书名都回同一批无关条目。准入只看「checkKeyWord 搜出 ≥1 候选」就判 ok，
// 它因此进了 engineHosts 池，打标线每本书都白请求+解析它一次（书名校验挡掉，但时间照花）。
// 判据：主关键词搜出候选后，再用一个与主关键词**无公共字**的对照书名搜一次；两次候选 URL 集的
// Jaccard ≥ QUERY_INSENSITIVE_OVERLAP ⇒ 搜索结果不随查询变化 ⇒ verdict=query_insensitive（出池）。
// 正常站：对照书名要么 0 候选、要么是另一批书，重合度远低于阈值。对照词取与主关键词无公共字者，免得
// 「修仙」vs「凡人修仙传」这类真实相关结果被误判。
// 已知窄口径误杀（esprev41 B1/B3）：站点对任何查询（含主查询）都回同一固定列表、且目标书恰在该列表里
// 时，两批相同 ⇒ 判 query_insensitive 出池，哪怕该书确实能在这个站读到（单结果时 1/1 同理）。
// 可接受：①这种站本来就不按查询搜索，对其它书名一律回无关条目，打标线每本书都要白付它一次请求+解析，
// 留池的代价远大于偶尔命中一本的收益；②query_insensitive 归 deferred 桶，ADMISSION_RETEST_INTERVAL_MS
// 到期复测，站点恢复正常搜索即自动回池，不是永久出池。
// 「无结果时展示热门榜」的站不在此列：主关键词命中真结果、对照词落到热门榜，两批通常不同。
/** 对照书名候选（按序取第一个与主关键词无公共字的）。 */
export const QUERY_CONTROL_KEYWORDS = ['凡人修仙传', '诡秘之主', '庆余年', '斗破苍穹'] as const;
/** 两次搜索候选 URL 集 Jaccard 达到此值即判查询不敏感。 */
export const QUERY_INSENSITIVE_OVERLAP = 0.8;
/**
 * 开启对照搜索后单个探测的最坏墙钟：主搜索 + 节流 + 对照搜索。调用方的逐探预算止损（canProbe）
 * 必须按这个值预留，否则最后一个探测会越过刷新预算。
 */
export const ADMISSION_PROBE_WORST_MS = 2 * ADMISSION_TIMEOUT_MS + ADMISSION_THROTTLE_MS;

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
  failures: { field: string; rule: string; message: string; diagnostic: RuleDiagnostic }[];
  /** 失败摘要（空串=通过），写进 source_admission.error。 */
  reason: string;
}

/**
 * 最低必需组（N03）：「可执行阅读路径」的最小字段集——搜索三件（bookList/name/bookUrl）
 * + 目录三件（chapterList/chapterName/chapterUrl）+ 正文 content。缺任一 → compile 拒：
 *   - 无 chapterList/chapterName/chapterUrl：engineFetchToc 对真实目录页必产出空 chapters
 *     （反例：正常搜索+正文、删 ruleToc → 旧版仍 compile_ok/search_ok，进池后目录恒空）；
 *   - 无 content：正文恒空；无搜索三件：搜不到书，阅读链路起点即断。
 * 能力可选字段（author/tocUrl/nextTocUrl/nextContentUrl/ruleBookInfo.*）不机械要求——
 * 缺了只是能力降级（作者未知/单页目录/单页正文），不阻断准入。
 * 注意 ruleToc.chapterUrl 缺失但 chapterList/chapterName 在的源（174 fixture 有 10 条）
 * 旧行为放行、本修复起拒——对已 admitted 源的影响见 isGrandfatheredAdmitted。
 */
const REQUIRED_FIELDS = [
  'ruleSearch.bookList',
  'ruleSearch.name',
  'ruleSearch.bookUrl',
  'ruleToc.chapterList',
  'ruleToc.chapterName',
  'ruleToc.chapterUrl',
  'ruleContent.content',
] as const;

/**
 * 引擎内置默认值可覆盖的字段（对齐 legado 语义）：规则缺失时引擎仍能产出有效值，
 * 准入必需组的缺位判据据此放宽为「显式规则存在 ∨ 引擎默认可产」。
 * 目前仅 ruleToc.chapterUrl —— legado BookChapterList.kt:230-244（取证快照
 * Jer-Chao@c2c4775 / vvb2060@5a65aa42，摘录见 docs/legado-semantics/）在规则
 * 缺失/求值空时用当前目录页 URL 兜底，api.ts engineFetchToc 已实现同款。
 * 注意这只覆盖「规则不存在」；规则存在但编译不过（例 @baseUrl）仍走 failures 拒，
 * failures.length === 0 这一条不放松。非 URL 字段（name/content）legado 无默认
 * （BookList.kt:220 / BookContent.kt:179），不得加入本集合。
 */
const ENGINE_DEFAULT_FIELDS = new Set<string>(['ruleToc.chapterUrl']);

/**
 * 滤网 1：规则可解释（设计 §4.1）。survey 初筛（HTTPS 源 URL、纯 GET 搜索模板、
 * bookSourceType≠2、无 JS）+ 对全部核心字段跑 compile；任一核心字段
 * RULE_UNSUPPORTED → 拒。装饰字段不阻断（本层只看核心字段）。
 * N03：核心字段全部可解释**且必需组全部在场**才 ok——只查 failures 会放行
 * 「删掉 ruleToc 的源」（规则不存在就没有 failure），它进池后目录必空。
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
      failures.push({
        field, rule, message,
        diagnostic: error instanceof RuleEngineError
          ? (error.diagnostic ?? { code: 'unsupported_rule' })
          : { code: 'unexpected_compile_error' },
      });
    }
  }
  // 必需组缺位判据（准入兼容 L2）：从「显式规则存在」升级为「显式规则存在或引擎默认可产」
  // （ENGINE_DEFAULT_FIELDS，对齐 legado「URL 类规则缺失 → 当前页 URL」语义）。
  // 规则存在但编译不过的仍走 failures 拒（上面那段），本判据只放宽「缺位」。
  const missing = REQUIRED_FIELDS.filter((f) => !coreFieldMask[f] && !ENGINE_DEFAULT_FIELDS.has(f));
  const ok = failures.length === 0 && missing.length === 0;
  const reason = failures.length > 0
    ? failures.map((f) => `${f.field}: ${f.message}`).join('; ').slice(0, 200)
    : missing.length > 0 ? `缺少必需规则（无可执行阅读路径）: ${missing.join(', ')}` : '';
  return { ok, tier: ok ? 'M1' : 'T7', coreFieldMask, failures, reason };
}

/**
 * W1 现网池豁免（N03 红线）：新校验收紧后，既有 source_admission 行可能被判
 * compile_ok=false（例：174 池里 10 条缺 ruleToc.chapterUrl 的源）。若该源此前
 * search_ok=true（已在运行时阅读池，如 yingsx/jhsssd），直接改判会在下轮 cron
 * 把它写出池。豁免条件（窄）：
 *   - 既有行 rules_hash === 当前 hash（规则未变——资格评审对象没换）；
 *   - 既有行 compile_ok=true ∧ search_ok===true（已在池、已实证可搜索）。
 * 规则一变（hash 变）资格评审重开，新校验立即生效——豁免只保护「旧行为下已进池
 * 且规则未变」的存量，不给新源留后门（新源无既有行，不满足第一条）。
 */
export function isGrandfatheredAdmitted(
  previous: AdmissionSourceRow | undefined, currentHash: string,
): boolean {
  return previous !== undefined
    && previous.rules_hash === currentHash
    && previous.compile_ok === true
    && previous.search_ok === true;
}

// ---------------------------------------------------------------- 滤网 2（searchAdmission）
export type AdmissionVerdict =
  | 'ok' | 'challenge' | 'conn_fail' | 'http_5xx' | 'http_4xx' | 'shell' | 'url_invalid' | 'no_result'
  | 'query_insensitive';

/** 判定分桶（设计 §4.1 v3 E2）：ok / rejected（站点行为终态）/ deferred（可复测）。 */
export function admissionBucket(verdict: string): 'ok' | 'rejected' | 'deferred' {
  switch (verdict) {
    case 'ok': return 'ok';
    case 'challenge':
    case 'conn_fail':
    case 'shell':
      return 'rejected';
    default: // http_5xx / http_4xx / url_invalid / no_result / query_insensitive（含空 verdict=未测）
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
  // 纵深防御(41-ADMIT-CONC-FIX,S5):signal 在注册监听前就已中止时,监听永不触发、
  // 传输层会拿到未中止的 probeSignal。补一次同步转发,使已中止的调用方不再发出新请求。
  if (signal.aborted) controller.abort(signal.reason);
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

/** 准入主关键词：legado 标准位置是嵌套 ruleSearch.checkKeyWord（DB 995 源顶层无此字段）；
 * 顶层 source.checkKeyWord 仅作非标准源兼容，都无才落兜底词。 */
function admissionKeyword(source: RawSource): string {
  const nestedKeyword = (source.ruleSearch as Record<string, unknown> | undefined)?.checkKeyWord;
  return (typeof nestedKeyword === 'string' && nestedKeyword.trim() ? nestedKeyword
    : typeof source.checkKeyWord === 'string' && source.checkKeyWord.trim() ? source.checkKeyWord
      : DEFAULT_ADMISSION_KEYWORD).trim();
}

/** 对照书名：与主关键词无公共字的第一个；都有公共字则 undefined（不做对照判定）。 */
export function queryControlKeyword(keyword: string): string | undefined {
  const used = new Set(keyword.replace(/\s/g, ''));
  return QUERY_CONTROL_KEYWORDS.find((candidate) => ![...candidate].some((ch) => used.has(ch)));
}

/** 用源模板展开一次搜索 URL（复用 sourceSearchUrl 的纯 GET 口径，但走准入门校验）。
 * keyword 缺省取 admissionKeyword（主关键词）；对照搜索传对照书名。 */
function expandAdmissionSearchUrl(
  source: RawSource, declaredHosts: ReadonlySet<string>, keyword = admissionKeyword(source),
): string {
  const template = source.searchUrl;
  if (typeof template !== 'string' || template.length > 2048 || !/\{\{key\}\}/.test(template)) {
    throw new SourcePolicyError('书源缺少支持的搜索模板');
  }
  const expanded = template.replace(/\{\{key\}\}/g, encodeURIComponent(keyword)).replace(/\{\{page\}\}/g, '1');
  if (/[{}]|@js:|<js>|,\s*\[/i.test(expanded)) throw new SourcePolicyError('不支持该书源的动态搜索规则');
  const base = typeof source.bookSourceUrl === 'string' ? source.bookSourceUrl : undefined;
  return validateAdmissionUrl(expanded, base, declaredHosts).href;
}

const MAX_CANDIDATE_SCAN = 50;

/** bookList 求值 → 逐条 name/bookUrl 可解析的候选 URL（设计 §4.1：≥1 条即 ok；对照判据比 URL 集）。 */
function searchCandidateUrls(source: RawSource, text: string, pageUrl: string): string[] {
  const rules = source.ruleSearch;
  if (!rules || typeof rules !== 'object') return [];
  const bookList = (rules as Record<string, unknown>).bookList;
  const name = (rules as Record<string, unknown>).name;
  const bookUrl = (rules as Record<string, unknown>).bookUrl;
  if (typeof bookList !== 'string') return [];
  const parseSafe = (rule: unknown) => {
    if (typeof rule !== 'string' || !rule.trim()) return undefined;
    try { return parseFieldRule(rule); } catch { return undefined; }
  };
  const listIr = parseSafe(bookList);
  if (!listIr) return [];
  const nameIr = parseSafe(name);
  const bookUrlIr = parseSafe(bookUrl);
  let scope;
  try { scope = createScope(normalizeBody(text), pageUrl); } catch { return []; }
  if (scope.kind !== 'html') return [];
  let nodes;
  try { nodes = evaluateFieldNodes(listIr, scope); } catch { return []; }
  const urls: string[] = [];
  for (let i = 0; i < nodes.length && i < MAX_CANDIDATE_SCAN; i += 1) {
    const inner = insideNode(scope as HtmlScope, nodes[i]);
    try {
      const title = nameIr ? evaluateField(nameIr, inner) : '';
      const url = bookUrlIr ? evaluateField(bookUrlIr, inner) : '';
      if (title.trim() && url.trim()) urls.push(url.trim());
    } catch { /* 单条候选求值失败：跳过，不影响整页判定（§3.4 失败隔离） */ }
  }
  return urls;
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
  /** 主搜索 ok 后再做一次对照搜索，判查询不敏感（espfix41）。缺省关：纯函数调用方逐字不变。 */
  controlQuery?: boolean;
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
  // 会把它误判成 challenge（rejected 终态、20h 不重测）；probe-reachability.py 只是一次性
  // 探测，准入把它升级成了永久拒。故「有 ≥1 候选的正常页一律 ok」，墙只在 403/503 或
  // 「0 候选 + 强标记」成立。弱标记 cloudflare 仍不判墙。
  if (response.status === 403 || response.status === 503) {
    return { verdict: 'challenge', candidateCount: 0, status: response.status, error: String(response.status) };
  }
  if (response.status >= 500) return { verdict: 'http_5xx', candidateCount: 0, status: response.status, error: String(response.status) };
  if (response.status >= 400) return { verdict: 'http_4xx', candidateCount: 0, status: response.status, error: String(response.status) };
  const urls = searchCandidateUrls(source, response.text, response.url);
  const candidateCount = urls.length;
  if (candidateCount >= 1) {
    if (options.controlQuery) {
      const overlap = await controlQueryOverlap(source, options, urls);
      if (overlap !== undefined && overlap >= QUERY_INSENSITIVE_OVERLAP) {
        return {
          verdict: 'query_insensitive', candidateCount, status: response.status,
          error: `对照搜索结果重合 ${Math.round(overlap * 100)}%`,
        };
      }
    }
    return { verdict: 'ok', candidateCount, status: response.status, error: '' };
  }
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

/**
 * 对照搜索（espfix41）：用与主关键词无公共字的对照书名再搜一次，返回两次候选 URL 集的 Jaccard。
 * 拿不到可比结论（无可用对照词、URL 展开失败、网络失败、非 2xx）⇒ undefined，调用方维持 ok——
 * 对照只负责「拿到证据才出池」，不把一次抖动升级成出池。调用方中止则照常抛出（不写判定）。
 */
async function controlQueryOverlap(
  source: RawSource,
  options: Parameters<typeof searchAdmission>[1],
  primary: string[],
): Promise<number | undefined> {
  const control = queryControlKeyword(admissionKeyword(source));
  if (!control) return undefined;
  let url: string;
  try {
    url = expandAdmissionSearchUrl(source, options.declaredHosts, control);
  } catch {
    return undefined;
  }
  const throttleMs = options.throttleMs ?? ADMISSION_THROTTLE_MS;
  // 同站第二次请求：admissionFetch 的节流只在单次调用内生效，这里显式补一次间隔。
  if (throttleMs > 0) await (options.sleep ?? defaultSleep)(throttleMs, options.signal);
  let response: { url: string; status: number; text: string };
  try {
    response = await admissionFetch(url, options);
  } catch (error) {
    if (options.signal.aborted) throw error;
    return undefined;
  }
  if (response.status < 200 || response.status >= 300) return undefined;
  const a = new Set(primary);
  const b = new Set(searchCandidateUrls(source, response.text, response.url));
  if (b.size === 0) return 0;
  let shared = 0;
  for (const item of b) if (a.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
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
  engine_semantics_version: number;
  host: string;
  error: string;
  compile_diagnostics: { field: string; code: string; operator?: '||' | '&&' | '%%' }[];
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
  /**
   * 探测并发度覆盖(测试注入用);缺省走 `admissionProbeConcurrency()`(env 或默认 1=串行)。
   * 归一后夹在 [1, MAX_ADMISSION_PROBE_CONCURRENCY]。
   */
  probeConcurrency?: number;
  /**
   * 查询不敏感判据（espfix41）：主搜索 ok 后加一次对照搜索，结果不随查询变化即判 query_insensitive 出池。
   * 生产两条写库路径（shuyuan.ts 刷新批次、scripts/seed-admission.mjs）都开；开启后单探最坏
   * ADMISSION_PROBE_WORST_MS，canProbe 须按它预留。缺省关（单测的固定页桩对任何查询都回同一页）。
   */
  controlQuery?: boolean;
}

export interface AdmissionBatchResult {
  /** 需要 upsert 的行（可能少于 candidates——规则未变、结论不变的不重写）。 */
  rows: AdmissionSourceRow[];
  compileOk: number;
  compileRejected: number;
  probed: number;
  verdicts: Record<string, number>;
  /** N03 祖父条款命中数（新校验下本会拒、因「规则未变 ∧ 已在池」维持既有资格的源）。 */
  grandfathered: number;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * 准入同站互斥键(41-fanout,archrev41 §5-2):探测请求真正打向的是 searchUrl 展开后的 host,
 * 不是源声明的 bookSourceUrl host。展开失败(模板非法/动态规则/host 不在声明池)时这个源
 * 注定判 url_invalid、不发请求,退回声明 URL 的 host 即可。只做互斥键,写库的 host 列不变。
 */
function admissionMutexHost(candidate: AdmissionCandidate, declaredHosts: ReadonlySet<string>): string {
  try {
    return hostOf(expandAdmissionSearchUrl(candidate.source, declaredHosts)) || hostOf(candidate.url);
  } catch {
    return hostOf(candidate.url);
  }
}

/**
 * source_admission.rules_hash：内容 identity 沿用目录的 sourceRevision，再加引擎语义版本前缀。
 * 入参形状由调用方按 reader 的 `{url, searchUrl, rules}` 组配——rules 传整个源对象；
 * 源内容或引擎语义任一变化，准入 identity 都会变化。
 */
export function rulesHash(source: unknown): string {
  const raw = (source && typeof source === 'object' ? source : {}) as RawSource;
  return engineSourceRevision({
    url: typeof raw.bookSourceUrl === 'string' ? raw.bookSourceUrl : '',
    searchUrl: raw.searchUrl,
    rules: raw,
  });
}

/**
 * 落库的 engine_semantics_version：必须与 rulesHash 的版本前缀同一口径
 * （engineSourceRevision → engineSemanticsVersion(engineSyntaxOrEnabled())，P1a off=1/on=2）。
 * P1a 开闸前置修复：此前三处落库写死常量 ENGINE_SEMANTICS_VERSION（恒 1），而 rulesHash
 * 在 ENGINE_SYNTAX_OR=1 时产出 `2:<hash>`，会写下行内自相矛盾的元数据
 * （hash 带 2 前缀、版本列写 1）。off 态两式逐字等值：engineSyntaxOrEnabled()=false
 * ⇒ engineSemanticsVersion(false)===ENGINE_SEMANTICS_VERSION===1，行为不变。
 */
function admissionSemanticsVersion(): number {
  return engineSemanticsVersion(engineSyntaxOrEnabled());
}

/**
 * 版本自洽守卫（复审 P3 单一真源）：source_admission 每行的 `engine_semantics_version` 必须等于
 * `rules_hash` 的版本前缀（rules_hash 形如 `<engine_semantics_version>:<contentRevision>`，见
 * engineSourceRevision / admissionSemanticsVersion）。**两条写库路径**——`scripts/seed-admission.mjs`
 * 与 `src/lib/shuyuan.ts` 的 `writeAdmissionRows`——都在写库之前调用此函数，判据集中在此、两侧不各自抄一份
 * （两处复制正是复审发现的成因）。发现错配即抛错、拒绝写库：防的是 INSERT 列清单漏写版本列时行内元数据
 * 自相矛盾（版本列取 schema 默认 0，rules_hash 却带真实 `1:`/`2:` 前缀）。当前落库靠 P1a 让
 * runAdmissionBatch 同源产出保证一致（by construction），此守卫把该不变式钉死在写库边界。
 */
export function assertAdmissionVersionConsistent(
  rows: ReadonlyArray<Pick<AdmissionSourceRow, 'rules_hash' | 'engine_semantics_version' | 'host'>>,
): void {
  for (const row of rows) {
    const prefix = Number(String(row.rules_hash).split(':', 1)[0]);
    if (!Number.isInteger(prefix)) {
      throw new Error(`[admission] 版本自查失败：host=${row.host} rules_hash 无版本前缀`);
    }
    if (row.engine_semantics_version !== prefix) {
      throw new Error(
        `[admission] 版本自查失败：host=${row.host} engine_semantics_version=${row.engine_semantics_version} ` +
        `≠ rules_hash 版本前缀=${prefix}（行内元数据不自洽，拒绝写库）`,
      );
    }
  }
}

function compileDiagnostics(compile: AdmissionCompile): AdmissionSourceRow['compile_diagnostics'] {
  return compile.failures.map(({ field, diagnostic }) => ({ field, ...diagnostic }));
}

/**
 * 搜索模板在**当前代码 + 当前声明 host 集**下本地展开仍失败（41-srcfix P2）：url_invalid 的本地确定性
 * 形态（模板缺 {{key}}/动态规则/非 HTTPS/非精确域名/IP/host 未声明）不发请求，同输入必同结论，按时间
 * 复测纯耗名额。只看 rules_hash 不够：source-policy 判据（如 http→https 升级、搜索 host 放行）或声明
 * host 集变了，结论会变而 hash 不变。所以不引入判据版本号（要人记得手动递增，漏递增就永不重测），
 * 而是每轮直接用现行代码重跑这一步纯本地展开——判据怎么变都自动跟上，零网络、不占名额。
 */
function searchUrlStillInvalid(source: RawSource, declaredHosts: ReadonlySet<string>): boolean {
  try {
    expandAdmissionSearchUrl(source, declaredHosts);
    return false;
  } catch {
    return true;
  }
}

/** deferred 各 verdict 的时间复测窗（41-srcfix P2）。 */
function deferredRetestWindowMs(verdict: string): number {
  return verdict === 'no_result' ? ADMISSION_NO_RESULT_RETEST_MS : ADMISSION_RETEST_INTERVAL_MS;
}

function isRetestDue(row: AdmissionSourceRow, nowMs: number, urlStillInvalid: () => boolean): boolean {
  if (row.search_ok === null) return true; // 未测（含被限流跳过的新源）
  const bucket = admissionBucket(row.search_verdict);
  if (bucket === 'deferred') {
    // url_invalid 且现行判据本地展开仍失败 ⇒ 结论不会变，不按时间复测（规则变走 rulesChanged 重排）。
    // 本地展开已能通过的 url_invalid：要么判据/声明集变了（该重测），要么当初是网络期策略拒
    // （跳转越界/超体积，站点行为可变）——两者都按 20h 窗复测。
    if (row.search_verdict === 'url_invalid' && urlStillInvalid()) return false;
    if (!row.search_checked_at) return true;
    const checked = Date.parse(row.search_checked_at);
    return !Number.isFinite(checked) || nowMs - checked >= deferredRetestWindowMs(row.search_verdict);
  }
  // 41-B1-RETRY：conn_fail 的 rejected 终态带时间衰减——超 7 天回到待复探（见常量注释）。
  // 复探仍可能再判 conn_fail（checked_at 刷新、再等 7 天），但站点恢复后能自动回池。
  if (row.search_verdict === 'conn_fail') {
    if (!row.search_checked_at) return true;
    const checked = Date.parse(row.search_checked_at);
    return !Number.isFinite(checked) || nowMs - checked >= ADMISSION_CONN_FAIL_RETEST_MS;
  }
  // 41-B2-OK-RECHECK：ok 源不再永久免检。可疑行（error 带 recheck_fail: 前缀）按 20h 窗
  // 到期（class 1，在池里的可疑源最该早点确认）；干净 ok 行按 7 天长周期复核到期（class 2）。
  if (row.search_verdict === 'ok') {
    if (!row.search_checked_at) return true;
    const checked = Date.parse(row.search_checked_at);
    const window = row.error.startsWith(ADMISSION_RECHECK_FAIL_PREFIX)
      ? ADMISSION_RETEST_INTERVAL_MS : ADMISSION_OK_RECHECK_MS;
    return !Number.isFinite(checked) || nowMs - checked >= window;
  }
  return false;
}

/**
 * N04 公平调度：探测优先序（小者先）。**未测过的源优先**（class 0），其次复测到期者
 * 按 search_checked_at **最旧优先**（class 1，天然轮转——上轮刚测过的时间戳最新、排最后），
 * 结论仍有效者不占探测名额（class 3）。同 class 内保持输入序（稳定排序，可复算）。
 * 反例背景：旧版按输入顺序最多探 5 个，前 5 个持续 http_5xx 的源每轮吃满全部名额，
 * 第 6 个源永远 search_ok=null（饿死）。
 * 41-B1-RETRY 注：conn_fail 衰减到期的行也走 class 1（复测到期），与 deferred 同档——
 * 它们共享同一个公平轮转，不抢未测源（class 0）的队。
 * 41-B2-OK-RECHECK 注：ok 长周期复核到期走 class 2（名额最后，名额紧时不抢队、名额宽时
 * 自动巡检）；可疑 ok（error 带 recheck_fail: 前缀）走 class 1（在池里的可疑源最该早点确认）。
 */
type ProbeClass = 0 | 1 | 2 | 3;

interface AdmissionPlanEntry {
  candidate: AdmissionCandidate;
  /** 输入序（稳定排序次键）。 */
  index: number;
  previous: AdmissionSourceRow | undefined;
  hash: string;
  probeClass: ProbeClass;
  /** search_checked_at 毫秒（未测/缺时间戳 = -Infinity，最旧优先语义下排最前）。 */
  checkedAtMs: number;
}

function planProbeOrder(input: AdmissionBatchInput, nowMs: number): AdmissionPlanEntry[] {
  const entries: AdmissionPlanEntry[] = input.candidates.map((candidate, index) => {
    const previous = input.existing.get(candidate.url);
    const hash = rulesHash(candidate.source);
    const rulesChanged = !previous || previous.rules_hash !== hash;
    let probeClass: ProbeClass = 3;
    if (!previous || previous.search_ok === null) probeClass = 0; // 从未测过（含占位行）
    else if (rulesChanged
      || isRetestDue(previous, nowMs, () => searchUrlStillInvalid(candidate.source, input.declaredHosts))) {
      // 41-B2-OK-RECHECK：干净 ok 行的长周期复核排最后（class 2），其余到期者（deferred /
      // conn_fail 衰减 / 可疑 ok / 规则变）走 class 1。
      probeClass = !rulesChanged
        && previous.search_verdict === 'ok'
        && !previous.error.startsWith(ADMISSION_RECHECK_FAIL_PREFIX) ? 2 : 1;
    }
    const checked = previous?.search_checked_at ? Date.parse(previous.search_checked_at) : Number.NaN;
    return {
      candidate, index, previous, hash, probeClass,
      checkedAtMs: Number.isFinite(checked) ? checked : Number.NEGATIVE_INFINITY,
    };
  });
  return entries.sort((a, b) =>
    a.probeClass - b.probeClass
    || a.checkedAtMs - b.checkedAtMs
    || a.index - b.index);
}

/**
 * 并发度归一:注入值(测试)或 env 值 → [1, MAX] 整数。非有限值回退默认(=1,串行)。
 */
function normalizeAdmissionConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ADMISSION_PROBE_CONCURRENCY;
  return Math.max(1, Math.min(Math.trunc(value), MAX_ADMISSION_PROBE_CONCURRENCY));
}

/**
 * ok 复核的写库结论（41-B2-OK-RECHECK，纯函数）：一次失败不出池。
 * - 非 ok 行的复核、或复核成功：照实写（error 清空回普通 ok）。
 * - 干净 ok 行首次复核失败：写 strike 标记（search_ok/verdict 保持 ok，error=`recheck_fail:<真实 verdict>`），
 *   源留池，20h 后走 class 1 再确认。
 * - 可疑行（已带 strike）再失败：strike 耗尽，写真实结论出池，之后走既有 deferred/conn_fail 复测回路。
 */
export function recheckOutcome(previous: AdmissionSourceRow | undefined, result: AdmissionSearchResult): {
  search_ok: boolean; search_verdict: string; error: string;
} {
  // query_insensitive 是拿到两次搜索结果后的正面证据（不是抖动），不走 strike、直接出池。
  const striking = result.verdict !== 'query_insensitive'
    && previous !== undefined
    && previous.search_ok === true
    && previous.search_verdict === 'ok'
    && !previous.error.startsWith(ADMISSION_RECHECK_FAIL_PREFIX);
  if (result.verdict !== 'ok' && striking) {
    return { search_ok: true, search_verdict: 'ok', error: `${ADMISSION_RECHECK_FAIL_PREFIX}${result.verdict}` };
  }
  return { search_ok: result.verdict === 'ok', search_verdict: result.verdict, error: result.error };
}
/**
 * 跑一轮准入批次（设计 §4.2）。纯逻辑：不碰 DB，输入既有行、输出要写库的行。
 * 状态机：new → compile_rejected（终态，规则不变不复测）｜new → deferred → (ok|rejected)｜ok
 * ｜conn_fail（rejected，7 天衰减后回 class 1 复测，41-B1-RETRY）
 * ｜ok（7 天长周期复核，class 2；首次失败记 strike 不出池、20h 后再确认，41-B2-OK-RECHECK）。
 * 每轮真实搜索 ≤ maxProbes（默认走 `admissionMaxProbes()`，env 可调），按 planProbeOrder 的公平序分配名额（N04）；
 * canProbe 为 false 时停止探测但仍写出可离线得到的结论。
 * N03 祖父条款：新必需组校验收紧时，既有「规则未变 ∧ compile_ok ∧ search_ok=true」的行
 * 不改判 compile 拒（W1 现网池红线），规则一变即按新校验重审。
 *
 * 41-ADMIT-CONC(受限并发):探测段改为 worker 池(`probeConcurrency`,默认 1=串行)。
 * 三条不变式钉死与串行版逐行一致:
 *   (a) 名额、canProbe、signal 在**每次起探前同步判定**(41-ADMIT-CONC-FIX):worker 取到一个
 *       候选后、发请求之前同步查 `probeSlots>0 && canProbe() && !signal.aborted`,判否即走
 *       「没轮到/预算不足」占位分支。canProbe 依赖时间(调用方按 `Date.now()` 计剩余预算),
 *       必须逐探判——在批次开头一次性领完会让预算耗尽后仍继续起探,整批撞上预算中止后
 *       被静默丢弃(c=1 默认即回归)。c=1 时 canProbe 的调用序列与串行版逐候选相同;
 *   (b) 同一目标站(searchUrl 展开后的 host,见 admissionMutexHost)同时最多 1 个探测在飞
 *       (上游是小说站,同站并发易被 429/封);
 *   (c) 结果先按计划序落进 `results[index]` 槽、汇总后再按计划顺序输出——不按完成先后,
 *       保证同输入同输出、写库与测试可复现。
 * 取舍(c>1):host 在飞而被跳过的候选,可能把名额让给计划序靠后的候选。只在 c>1、同 host
 * 且名额吃紧时出现,晚一轮而已,不会饿死;与「取下一个时跳过 host 在飞的候选」一致。
 * c=1 时 worker 池退化为严格串行,输出与改造前逐行一致(零行为变更)。
 */

export async function runAdmissionBatch(input: AdmissionBatchInput): Promise<AdmissionBatchResult> {
  const now = input.now ?? (() => new Date());
  // 每批判定一次语义版本：同一批所有行的版本列必须彼此一致，且与各自 rules_hash 前缀同源
  // （rulesHash 内部同款默认读 ENGINE_SYNTAX_OR）。
  const semanticsVersion = admissionSemanticsVersion();
  const rows: AdmissionSourceRow[] = [];
  const verdicts: Record<string, number> = {};
  let compileOk = 0;
  let compileRejected = 0;
  let grandfathered = 0;
  let probed = 0;
  let probeSlots = Math.max(0, input.maxProbes ?? admissionMaxProbes());
  const canProbe = input.canProbe ?? (() => true);
  const concurrency = normalizeAdmissionConcurrency(input.probeConcurrency ?? admissionProbeConcurrency());

  const plan = planProbeOrder(input, now().getTime());
  // 结果槽:与计划同序(undefined = 本条无行输出)。汇总后按计划顺序产出 rows。
  const results: (AdmissionSourceRow | undefined)[] = new Array(plan.length);
  // 待探清单(名额尚未领取)。index 指回计划序,用于结果归位;placeholder 是「没轮到/预算不足」
  // 时要写的占位行(undefined = 该候选不写占位,见下方防出池例外)。
  const probes: {
    index: number; candidate: AdmissionCandidate; host: string; mutexHost: string; compile: AdmissionCompile; hash: string;
    previous: AdmissionSourceRow | undefined; placeholder: AdmissionSourceRow | undefined;
  }[] = [];

  for (let index = 0; index < plan.length; index += 1) {
    const { candidate, previous, hash, probeClass } = plan[index];
    const host = hostOf(candidate.url);
    const compile = compileAdmission(candidate.source);
    // N03 祖父条款：新校验下会拒、但规则未变且已在池（compile_ok ∧ search_ok=true）→ 维持既有资格。
    const exempt = !compile.ok && isGrandfatheredAdmitted(previous, hash);

    if (!compile.ok && !exempt) {
      compileRejected += 1;
      // 规则未变且上一轮已是 compile 拒 → 终态不重写（§4.2）。
      // 准入兼容 §2.3 陷阱：这条终态去抖只在「仍然 compile 拒」时生效；引擎默认值救回的源
      // 走 compile.ok===true 分支，既有行 search_ok===null ⇒ planProbeOrder 判 probeClass=0
      // （未测优先）⇒ 下一轮即被探测并改写为 compile_ok=true。恢复回路全自动——
      // **不需要数据迁移，不需要人工 SQL，也不需要清旧终态行**。同理，严禁把候选池
      // （shuyuan.ts runAdmissionAfterRefresh 的 selectCandidates 过滤）改成「只喂
      // compile_ok 的源」：那会让 compile 拒的源出评估环、上游补字段后永远回不了池
      // （反例 15-17 钉死该回路）。
      if (previous && previous.rules_hash === hash && previous.compile_ok === false) continue;
      results[index] = {
        source_url: candidate.url, tier: 'T7', compile_ok: false, core_field_mask: compile.coreFieldMask,
        search_ok: null, search_verdict: '', search_checked_at: null, rules_hash: hash,
        engine_semantics_version: semanticsVersion, host, error: compile.reason,
        compile_diagnostics: compileDiagnostics(compile),
      };
      continue;
    }
    compileOk += 1;
    if (exempt) grandfathered += 1;

    const rulesChanged = !previous || previous.rules_hash !== hash;
    // 未测 / 规则变 / 复测到期 / ok 长周期复核(planProbeOrder 同口径,41-B2-OK-RECHECK)。
    // 阈值必须取 > 2:取 > 1 会让 class 2(ok 长周期复核)永远不探测,功能静默失效。
    if (probeClass > 2) continue; // 结论仍有效,不重写(needsProbe=false)

    // 本轮没轮到/预算不足：仅在「规则变过或库中无行」时写一条未测行占位，下一轮接着测。
    // 例外（防出池）：既有行已实证可搜（search_ok=true ∧ compile_ok=true）时不写占位——
    // 占位行经 ON CONFLICT DO UPDATE 会把 search_ok=true 覆盖成 null，入池谓词
    // `search_ok IS TRUE` 即失配、源被打出池（2026-09-21 实证 234.484448.xyz 隔天出池）。
    // 保留旧行原样（rules_hash 不更新），下一轮 rulesChanged 仍成立、仍优先排队真探，
    // 复测拿到名额后正常改写——不放松任何判据，只是没轮到时不清掉旧结论。
    // 名额/canProbe/signal 不在这里判(41-ADMIT-CONC-FIX):占位先算好,判定挪到 worker 每次起探前。
    const placeholder: AdmissionSourceRow | undefined =
      rulesChanged && !(previous?.search_ok === true && previous.compile_ok === true)
        ? {
          source_url: candidate.url, tier: 'M1', compile_ok: true, core_field_mask: compile.coreFieldMask,
          search_ok: null, search_verdict: '', search_checked_at: null, rules_hash: hash,
          engine_semantics_version: semanticsVersion, host, error: '', compile_diagnostics: [],
        }
        : undefined;
    probes.push({
      index, candidate, host, mutexHost: admissionMutexHost(candidate, input.declaredHosts), compile, hash, previous, placeholder,
    });
  }

  // ---- 受限并发 worker 池 ------------------------------------------------------
  // inflightHosts:当前在飞的目标站(mutexHost,同站互斥);claimed:已处理的候选(已起探,或判否后写了占位)。
  const inflightHosts = new Set<string>();
  const claimed = new Array<boolean>(probes.length).fill(false);
  let remaining = probes.length;
  // 被 host 挡住的 worker 在此等待「任一探测完成」再重扫(全部被挡才等,否则跳过继续找)。
  const waiters: (() => void)[] = [];
  const waitForRelease = () => new Promise<void>((resolve) => { waiters.push(resolve); });
  const releaseWaiters = () => { for (const resolve of waiters.splice(0)) resolve(); };

  async function probeWorker(): Promise<void> {
    while (true) {
      // 取下一个 host 不在飞的未领探测(跳过 host 在飞的候选)。
      let pick = -1;
      for (let j = 0; j < probes.length; j += 1) {
        if (claimed[j]) continue;
        if (inflightHosts.has(probes[j].mutexHost)) continue;
        pick = j;
        break;
      }
      if (pick === -1) {
        if (remaining === 0) return; // 全部领完/跑完
        await waitForRelease(); // 剩余全被在飞 host 挡住:等一个完成再重扫
        continue;
      }
      claimed[pick] = true;
      remaining -= 1;
      const item = probes[pick];
      // 名额 + canProbe + signal 在每次起探前同步判定(41-ADMIT-CONC-FIX)。判否走「没轮到」占位。
      // 此判定到 searchAdmission 注册 abort 监听之间没有 await,不会漏掉中途中止。
      if (!(probeSlots > 0 && canProbe() && !input.signal.aborted)) {
        if (item.placeholder) results[item.index] = item.placeholder;
        continue;
      }
      probeSlots -= 1;
      probed += 1;
      inflightHosts.add(item.mutexHost);
      try {
        const result = await searchAdmission(item.candidate.source, {
          fetchPage: input.fetchPage, declaredHosts: input.declaredHosts, signal: input.signal,
          throttleMs: input.throttleMs, sleep: input.sleep, controlQuery: input.controlQuery,
        });
        verdicts[result.verdict] = (verdicts[result.verdict] ?? 0) + 1;
        results[item.index] = {
          source_url: item.candidate.url, tier: 'M1', compile_ok: true, core_field_mask: item.compile.coreFieldMask,
          // 41-B2-OK-RECHECK:写库结论走 recheckOutcome——干净 ok 行首次复核失败记 strike 不出池。
          // 必须用 item.previous:worker 是独立函数,闭包拿不到外层循环的 previous。
          ...recheckOutcome(item.previous, result),
          search_checked_at: now().toISOString(), rules_hash: item.hash,
          engine_semantics_version: semanticsVersion, host: item.host,
          compile_diagnostics: [],
        };
      } finally {
        inflightHosts.delete(item.mutexHost);
        releaseWaiters();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, probes.length) }, () => probeWorker()));

  // 汇总:按计划顺序输出(先落槽后汇总 ⇒ 与完成先后无关;undefined 槽即本批无行)。
  for (const row of results) if (row !== undefined) rows.push(row);
  return { rows, compileOk, compileRejected, probed, verdicts, grandfathered };
}
