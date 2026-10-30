// T8 任务的引擎源池回退（41-T8FB）：原始源（book15 或引擎源）不可达时，按任务 (书名, 作者) 在引擎源池里找同一本书下载。
//
// 背景：phoenix 出网连不上 book15 的 HTTPS，builtin 任务只会逐条退避重排、永远 pending；labeler 侧早已在
// book15 熔断后改从引擎源池取正文。这里给下载器补同一条路：
// - 判据：identityMatches（scripts/engine-download.mjs，预检与 downloadBook 共用的同一个函数）。选源判据
//   已抽到共用 selector（./source-selector，B 线预取同款）：搜索列表书名须相等、作者不冲突，详情页三参
//   判据对上才算命中——本文件不再自持 sourceHasBook/扫描循环，只喂排除输入（正忙 host 快照、失败源 URL
//   精确集）与目标/上限/预算。真正下载仍由 downloadBook 在该引擎源上再按同一判据选候选，对不上抛
//   identity_mismatch_or_no_candidate。
// - 候选按池序依次下载，首个完整即收；单源失败（身份不符/缺章/超时/不可达）换下一个，全部失败回到
//   book15 的 source_unavailable 语义（退避放回 pending，不落 failed）。
// - host 级互斥不再由本文件粗粒度 occupy/release：entry 对默认 transport wrapTransport、对两条默认腿的
//   每次 engine.download 各开一个 runDownload 物理作用域（finally 释放）。fallback 换源调的就是已包装的
//   engine 腿——上一源作用域已先释放，不存在整个 fallback 一个大作用域。物理门拒绝经 incomplete.retryCause
//   传回：host_occupied 换下一已记录源（绝不标失败）、host_occupancy_unavailable 立即收口（绝不标失败）。
// - 不改任务行的 source_url/source_kind（book15 绑定保留，恢复后行为不漂移）；实际用了哪个源只进日志（host）
//   和运行目录里 downloadBook 自己的 manifest.json（source 字段）。
//
// 预检接缝（wrapPrecheck）：原始源不可达时在扣额度前就把引擎候选选好（持久化命中优先，零出网），
// 选不到 ⇒ 仍按可重试退避（不扣日额度）；整池实探后确实零候选的记 no_candidates（nocand42：长退避
// 曲线，因免费站收录以天计）；选到 ⇒ 放行，选源结果放进单槽缓存交给
// 下载腿（并发=1，同一时刻只有一本在跑）。预检关闭（DOWNLOAD_IDENTITY_PRECHECK=0）时由下载腿自己选源。

import { isHostSuspect, isPaywallHost } from '../src/lib/source-host-health';
import {
  isBudgetExhausted, isLeaseLostError, TaskLeaseLostError,
  type AdapterOutcome, type SourceAdapter, type TaskRow,
} from '../src/lib/download-worker';
import { classifyFailure } from '../src/lib/download-source-candidates';
import { createSourceSelector, type SourceSelection } from './source-selector';
import type { PrecheckHook, PrecheckResult } from './executor';

/**
 * 每批入选（并依次尝试下载）的引擎源数；recall 与出网选源的 targetHits 同为
 * min(maxSources, hostTarget)（默认 2/2，即每批两个不同 host）。已知候选全部失败后
 * 最多补扫一批新候选（失败 URL 精确排除，不无限重试）；本常量是批内上限，
 * 不是单任务累计总源数——累计上界由「一批已知 + 一批补扫」结构保证。
 */
export const MAX_FALLBACK_SOURCES = 2;
/**
 * 每本书最多搜索的引擎源数（按池序，跳过的不计）：给逐书出网封顶，作为 selector 的 scanLimit。
 * 历史：200 → 40（2026-10-09 提速整改）→ 160（2026-10-14 实测回调）。10-14 实测发现 40 上限系统性
 * 漏检：池序（probe reachable → tier → checkedAt → url）前 40 被同人向镜像站与同 host 变体占满
 * （rouwennp.org 单 host 4 个变体烧 4 个槽位），而实测载书的大站全排在 44–155（xyuzhaiwu10=44、
 * sto66=103、quanwenyuedu=105、vikbook=155）——当日 668 次选源扫描 628 次零命中，热门书
 * （我的治愈系游戏）在池内可达源精确命中却报 0 候选。回调到 160 ≈ 全池（https 去重后 ~170），
 * 已命中 host 仍去重（pickedHosts），扫描内不再另设同 host 去重（scanrev41 复核：会造成
 * 无书变体之后的同 host 变体永久死区）。墙钟 300s 与早停（2 host）仍是硬上界；真无源书
 * 每轮扫描代价 ≈ 预算耗尽时间且随上限近似线性（快失败源多则更低）。持久化候选（recall）零出网，
 * 不占扫描额度。后续任务重试重新建立余额，不无限延续旧轮计数。
 */
export const MAX_FALLBACK_SCAN_SOURCES = 160;
/** 选源早停目标：命中 2 个**不同 host**的可用源即停止扫描（2026-10-07 用户要求倾向 2 源而非 3 源）。 */
export const FALLBACK_HOST_TARGET = 2;
/** 选源墙钟预算：由 selector 内部计时管理，本文件不再另盖 AbortSignal.timeout。仍 << 30min 租约回收阈值。 */
export const FALLBACK_SELECT_BUDGET_MS = 300_000;

interface PoolSource { url: string; name: string; searchUrl: unknown; rules?: unknown }
interface Modules {
  supported: {
    BUILTIN_SOURCE_HOSTS: readonly string[];
    /** 识别集合内但无活跃内建源的 host（失效源整改）。缺省视为无退休源（合成桩兼容）。 */
    isRetiredBuiltinHost?: (host: string) => boolean;
  };
}

export interface BuiltinFallbackOptions {
  modules: unknown;
  transport: unknown;
  /** 引擎源池（生产 = engine.ts loadEnginePool）。抛错视为池不可用：selector 返回空、本轮不回退。 */
  loadPool: (signal: AbortSignal) => Promise<PoolSource[]>;
  /**
   * 候选源持久化接缝（bsrcfix-41）。缺省 = 不持久化（回到内存单槽行为，单测/兼容用）。
   * 生产由 entry 传入 src/lib/download-source-candidates 的函数集合（经 neon sql tag）。
   * 只保留候选记忆：usable/failedSources/replace/markFailure/occupiedHosts——物理 host 互斥由
   * entry 的 hostOccupancy（runDownload 逐次作用域 + wrapTransport）负责，本文件无 coarse 占位。
   */
  candidates?: {
    usable: (bookId: number) => Promise<{ source_url: string; host: string }[]>;
    /** 该书已失败候选（temporary/permanent）的 source_url 集——补扫单源精确排除，不禁整个 host。 */
    failedSources: (bookId: number) => Promise<Set<string>>;
    replace: (bookId: number, sources: string[]) => Promise<void>;
    markFailure: (bookId: number, sourceUrl: string, kind: 'permanent' | 'temporary', reason: string) => Promise<void>;
    occupiedHosts: () => Promise<Set<string>>;
  };
  /** host 是否处于已知不可达窗口；缺省 = source-host-health.isHostSuspect。 */
  isSuspect?: (host: string) => boolean;
  /** 只记任务 id、源 host、原因码，不记书名、作者、URL。选源明细日志由共用 selector 统一记。 */
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  timeoutMs?: number;
  budgetMs?: number;
  maxSources?: number;
  /** 选源早停目标（不同 host 数）；缺省 FALLBACK_HOST_TARGET。测试缝，生产不覆盖。 */
  hostTarget?: number;
  /** yield1030：透传给 selector 的 host 扫描优先分；缺省 = 池序（见 host-priority.ts）。 */
  hostPriority?: (signal: AbortSignal) => Promise<ReadonlyMap<string, number>>;
  /** rotate1030：按任务 attempt_count 轮转扫描窗口（第 n 次 ⇒ rotate=n−1）；缺省关 = 每次同一窗口。 */
  scanRotate?: boolean;
  /** toctgate1030：透传给 selector，跳过 strict 目录必拒的源；缺省关。 */
  skipStrictToc?: boolean;
}

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

const isBuiltinTask = (task: TaskRow) => task.source_kind !== 'engine'; // 与 selectAdapter 同口径

const isSourceUnavailable = (outcome: AdapterOutcome) =>
  outcome.kind === 'incomplete' && outcome.reason === 'source_unavailable';

/**
 * 原始源可达但库里没有这本书（无候选/身份不符）：2026-10-14 41-nocand 扩展回退资格。
 * 此前只有 source_unavailable 触发引擎回退——book.qq 链尾 cohort（战役 9/9 失败全是它）
 * 因源可达+书不在库直接终态 failed，扫池能力（scanfix）够不到这条路径。身份判据与
 * 回退选源共用 identityMatches，别处命中的候选同样可信；选不到则按原身份失败终态
 * （permanent，不空耗 16 次重扫）。
 */
const isIdentityMiss = (outcome: AdapterOutcome): boolean =>
  outcome.kind === 'failure' && outcome.code === 'identity_mismatch_or_no_candidate';

/**
 * 付费墙预览截断（vipwall42）：源可达、正文非空但全是 ~250 字 VIP 预览，同源重试不可能变好
 * （付费墙恒定）——必须换源，不能像 missing_chapters 那样退避重试原源死循环 16 轮。
 * builtin 原源与引擎腿同判：原源 preview_truncated 触发引擎回退；引擎腿 preview_truncated
 * 标 temporary 失败记忆后换下一源（temporary 而非 permanent：该源此书在付费墙，同源其他书未必）。
 */
const isPreviewTruncated = (outcome: AdapterOutcome) =>
  outcome.kind === 'incomplete' && outcome.reason === 'preview_truncated';

/**
 * download-worker incomplete 枚举里稳定的源级 reason（download-worker.ts 归类）：
 * source_unavailable / missing_chapters / toc_changed / operation_timeout——单源问题，标 temporary 后换源。
 * budget_exhausted / interrupted 是任务层停止：不标失败、不换源；白名单外的未知 incomplete 同样
 * 不标失败、不换源（不归因给该源）。preview_truncated 属源级（见 isPreviewTruncated）。
 * 物理 host 门拒绝（retryCause）不在此列：绝不标失败。
 */
const SOURCE_LEVEL_INCOMPLETE_REASONS = new Set(['source_unavailable', 'missing_chapters', 'toc_changed', 'operation_timeout', 'preview_truncated']);

/** 回退源全部失败时回给任务层的结论：同 book15 不可达（退避放回 pending）。 */
const unavailable = (stage: string, noCandidate = false): AdapterOutcome =>
  ({ kind: 'incomplete', reason: noCandidate ? 'no_candidates' : 'source_unavailable',
    chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage });

export function createBuiltinFallback(options: BuiltinFallbackOptions) {
  const m = options.modules as Modules;
  const isSuspect = options.isSuspect ?? ((host: string) => isHostSuspect(host));
  const log = options.log ?? (() => {});
  const maxSources = options.maxSources ?? MAX_FALLBACK_SOURCES;
  const hostTarget = options.hostTarget ?? FALLBACK_HOST_TARGET;
  const budgetMs = options.budgetMs ?? FALLBACK_SELECT_BUDGET_MS;
  const candidates = options.candidates;
  const builtinHosts = new Set(m.supported.BUILTIN_SOURCE_HOSTS);
  const builtinSuspect = (task: TaskRow) => isSuspect(hostOf(task.source_url));
  // 退休 host（识别集合内、无活跃内建源）：零出网径直回退。isHostSuspect 是**运行期**健康记忆
  // （连续传输失败、10 分钟窗），退休是静态事实——不进「半开重试」节奏，第一次就跳过 builtin 腿，
  // 也不再为它做预检搜索（对退休 host 的每个请求都被拒，做了只是白等超时）。
  const builtinRetired = (task: TaskRow) => Boolean(m.supported.isRetiredBuiltinHost?.(hostOf(task.source_url)));
  // paywall1026：原源是付费墙 host（PAYWALL_HOSTS）时同样零出网直接回退——预检必过（搜索恒命中），
  // 下载腿必得 preview_truncated 再回退，白耗一次预检 + 一次整书预览抓取（2026-10-26 实测）。
  const builtinPaywall = (task: TaskRow) => isPaywallHost(hostOf(task.source_url));
  const skipOriginal = (task: TaskRow) => builtinSuspect(task) || builtinRetired(task) || builtinPaywall(task);
  // 共用选源器（B 线预取同款）：搜索/详情判据、host 去重、扫描上限、早停与预算计时都在 selector 内；
  // 选源日志（固定字段：taskId/scanned/candidates/hosts）也由 selector 统一记，本文件不重复记。
  const selector = createSourceSelector({
    modules: options.modules,
    transport: options.transport,
    loadPool: options.loadPool,
    isSuspect,
    log,
    timeoutMs: options.timeoutMs ?? 30000,
    hostPriority: options.hostPriority,
    skipStrictToc: options.skipStrictToc,
  });

  // 预检选好的源交给下载腿：单槽（并发=1），按任务 id 认领，领一次即清。
  // identityMissed：预检腿判定原源可达但库里无此书（41-nocand）——下载腿候选全失败时按
  // 身份失败终态收口（nocandrev41 F1：不可降级成 source_unavailable 16 轮退避重扫）。
  type ScanBudget = { remaining: number };
  let planned: { taskId: number; sources: string[]; scanBudget: ScanBudget; identityMissed?: boolean } | null = null;

  const stopped = (signal: AbortSignal): AdapterOutcome | undefined => {
    if (!signal.aborted) return undefined;
    if (isLeaseLostError(signal.reason)) throw new TaskLeaseLostError();
    return { kind: 'incomplete', reason: isBudgetExhausted(signal.reason) ? 'budget_exhausted' : 'interrupted',
      chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
  };

  /**
   * 持久化命中：这本书之前选过的可用候选（免出网重扫）。host 从 URL 解析，不信 DB host 字段；
   * 与出网选源同过滤口径：非 https / builtin host / suspect host / 重复 host 剔除，且不超过
   * min(maxSources, hostTarget) 个；过滤后为空 ⇒ 返回 null（走出网选源——已失败候选不重试，重扫补新源）。
   * 读库失败返回空数组，停止本轮，不盲扫。
   */
  const recallSources = async (task: TaskRow): Promise<string[] | null> => {
    if (!candidates) return null;
    let rows: { source_url: string; host: string }[];
    try {
      rows = await candidates.usable(task.book_id);
    } catch {
      return [];
    }
    const picked: string[] = [];
    for (const row of rows) {
      const host = hostOf(row.source_url);
      if (!/^https:\/\//i.test(row.source_url) || !host || builtinHosts.has(host) || isSuspect(host) || isPaywallHost(host)) continue;
      if (picked.some(url => hostOf(url) === host)) continue;
      picked.push(row.source_url);
      if (picked.length >= Math.min(maxSources, hostTarget)) break;
    }
    return picked.length ? picked : null;
  };

  /**
   * 出网选源（共用 selector）：occupiedHosts/failedSources 快照作排除输入——正忙 host 不扫（宁退勿撞，
   * 占位表不可读同样返回空退避），失败源按 URL 精确排除、不连坐整 host。候选读失败 ⇒ 安全返回
   * scanned=0（退避；这是瞬时不可达，不是 0 候选）。caller abort 一律上抛（selector 对 abort 也是上抛，
   * 不吞）。预算由 selector 内部计时管理。选到后 replace 落库由本文件负责（selector 不持久化）：
   * 只替换可用行，不删失败记忆。
   */
  const selectSources = async (task: TaskRow, signal: AbortSignal, scanBudget: ScanBudget): Promise<SourceSelection> => {
    signal.throwIfAborted();
    if (scanBudget.remaining <= 0) return { picked: [], scanned: 0 };
    let busy: Set<string> = new Set();
    let failed: Set<string> = new Set();
    if (candidates) {
      try {
        busy = await candidates.occupiedHosts();
        failed = await candidates.failedSources(task.book_id);
      } catch {
        if (signal.aborted) throw signal.reason;
        return { picked: [], scanned: 0 };
      }
    }
    const selection = await selector({
      task: { id: task.id, title: task.title, author: task.author },
      excludedHosts: [...busy],
      excludedSources: [...failed],
      targetHits: Math.min(maxSources, hostTarget),
      scanLimit: Math.min(MAX_FALLBACK_SCAN_SOURCES, scanBudget.remaining),
      scanBudget,
      budgetMs,
      rotate: options.scanRotate ? Math.max(0, (task.attempt_count ?? 1) - 1) : 0,
    }, signal);
    if (selection.picked.length && candidates) {
      try {
        await candidates.replace(task.book_id, selection.picked);
      } catch {
        signal.throwIfAborted();
        log('error', '候选保存失败', { taskId: task.id, reason: 'candidate_persistence_unavailable' });
        return { picked: [], scanned: 0 };
      }
    }
    return selection;
  };

  return {
    /**
     * 包身份预检：先按原预检判原始源（builtin 任务判 book15，已知不可达/退休则跳过；engine 任务判
     * 其原始引擎源）；持久化命中（该书之前选过、零出网）优先于原预检。原预检判出 source_unavailable
     * 时改为取回退源——出网选源并落库；选到放行（reason=builtin_engine_fallback /
     * engine_source_candidates），选不到原样按 source_unavailable 退避。其余结论原样返回。
     * engine 任务无候选时先过原预检再扫池：原源可用就不必烧一次 200 源扫描（927 复核点 3）。
     * 选不到时按实探数分两类收口（nocand42）：整池实探（scanned>0）零候选 ⇒ no_candidates 长退避；
     * 一次没探 ⇒ source_unavailable 短退避。
     */
    wrapPrecheck(inner: PrecheckHook): PrecheckHook {
      return async (task, signal = new AbortController().signal): Promise<PrecheckResult> => {
        planned = null;
        const scanBudget: ScanBudget = { remaining: MAX_FALLBACK_SCAN_SOURCES };
        signal.throwIfAborted();
        const builtin = isBuiltinTask(task);
        if (!builtin && !candidates) return inner(task, signal);
        let sources = await recallSources(task);
        signal.throwIfAborted();
        let stage = 'search';
        let identityMissed = false;
        if (sources === null && !skipOriginal(task)) {
          let result: PrecheckResult | null = null;
          try {
            result = await inner(task, signal);
          } catch (error) {
            // 原始源 host 被本机其他实例的下载作用域占用（物理门 HOST_OCCUPIED）：不再上抛
            // （否则 executor 释放任务 → drain ERROR 60s 退避 → 重领同一 host → 死循环空转），
            // 改走引擎回退选源——selector 的 excludedHosts 已排除忙 host，落到空闲 host 上。
            // 选不到（全忙）则下面按 source_unavailable 退避，仍是有限退避而非空转。
            // HOST_OCCUPANCY_UNAVAILABLE（占位表不可读）语义不同，仍上抛由执行器立即收口。
            if ((error as { code?: unknown } | null | undefined)?.code !== 'HOST_OCCUPIED') throw error;
          }
          if (result) {
            if (result.ok) return result;
            // 非 identity_mismatch 的不可重试结论原样直通；identity_mismatch（41-nocand）继续走回退。
            // retryable 缺省视为不可重试（identity-precheck 生产返回就不带该字段）。
            if (!result.retryable && result.reason !== 'identity_mismatch') return result;
            identityMissed = result.reason === 'identity_mismatch';
            if ('stage' in result) stage = result.stage;
          }
        }
        signal.throwIfAborted();
        let selection: SourceSelection | null = null;
        if (sources === null) {
          selection = await selectSources(task, signal, scanBudget);
          sources = selection.picked;
        }
        signal.throwIfAborted();
        if (!sources.length) {
          if (identityMissed) return { ok: false, reason: 'identity_mismatch', retryable: false };
          // 实探过整池仍零候选 ⇒ no_candidates（nocand42）：免费站收录以天计，走 1h/2h/4h 长退避；
          // 一次没探（busy 全占/池不可读/预算尽）⇒ 仍是瞬时不可达，维持 15m/30m 快退避捞回。
          return { ok: false, reason: selection && selection.scanned > 0 ? 'no_candidates' : 'source_unavailable',
            retryable: true, stage };
        }
        planned = { taskId: task.id, sources, scanBudget, identityMissed };
        return { ok: true, reason: builtin ? 'builtin_engine_fallback' : 'engine_source_candidates' };
      };
    },

    /**
     * 包 builtin/engine 下载腿：优先保留原源路径（builtin 任务先试 book15、engine 任务先试其原始
     * 引擎源；suspect/退休 host 直接跳过原源）；原始源不可达或无候选时，按持久化候选和补扫结果
     * 依次用 engine 腿下载。
     * 逐源收口规则：
     * - complete 即收；任务层停止（budget_exhausted/interrupted）不标失败、不换源，按原分类收口；
     * - 物理 host 门拒绝（retryCause）：绝不 markFailure——host_occupied / host_breaker（限速器熔断让出）
     *   换下一已记录源，host_occupancy_unavailable 立即收口不再试；
     * - kind='failure' 或源级 incomplete（source_unavailable / missing_chapters / toc_changed /
     *   operation_timeout / preview_truncated）⇒ 标失败记忆（identity ⇒ permanent，其余 temporary）
     *   后换下一个源；白名单外的未知 incomplete 不标失败、不换源；未知异常按原语义上抛。
     *   builtin 原源 preview_truncated 同样触发回退（见 isPreviewTruncated）。
     * 全部候选失败回 book15 的 source_unavailable 退避语义（不落 failed）。
     */
    wrapAdapter(builtin: SourceAdapter, engine: SourceAdapter, kind: SourceAdapter['kind'] = 'builtin'): SourceAdapter {
      return {
        kind,
        async download(task, context) {
          const plan = planned?.taskId === task.id ? planned : null;
          const scanBudget: ScanBudget = plan?.scanBudget ?? { remaining: MAX_FALLBACK_SCAN_SOURCES };
          // 最近一次补扫的实探数：收口时判「整池 0 候选」还是「瞬时不可达」（nocand42）。
          let lastScanned = 0;
          const isSelection = (value: SourceSelection | AdapterOutcome): value is SourceSelection =>
            'picked' in value;
          const selectForDownload = async (): Promise<SourceSelection | AdapterOutcome> => {
            try {
              return await selectSources(task, context.signal, scanBudget);
            } catch (error) {
              const stop = stopped(context.signal);
              if (stop) return stop;
              if ((error as { code?: unknown } | null)?.code === 'HOST_OCCUPANCY_UNAVAILABLE') {
                return { kind: 'incomplete', reason: 'source_unavailable', stage: 'search',
                  retryCause: 'host_occupancy_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
              }
              throw error;
            }
          };
          let sources = plan?.sources ?? null;
          planned = null;
          let stop = stopped(context.signal);
          if (stop) return stop;
          if (kind === 'engine' && !candidates) return engine.download(task, context);
          let primary: AdapterOutcome | null = null;
          if (!sources) {
            sources = await recallSources(task);
            stop = stopped(context.signal);
            if (stop) return stop;
            if (sources === null && !skipOriginal(task)) {
              primary = await (kind === 'engine' ? engine : builtin).download(task, context);
              stop = stopped(context.signal);
              if (stop) return stop;
              // preview_truncated（原源是付费墙预览）：不 return primary——同源重试无意义，改走引擎回退换免费源。
              if (!isSourceUnavailable(primary) && !isIdentityMiss(primary) && !isPreviewTruncated(primary)) return primary;
              // 930 确认点 2：原源被物理门拒绝（host_occupied / host_occupancy_unavailable）按原
              // 可重试分类收口，不触发扫池——“host 正被占用”对选新源的出网请求同样生效。
              if (primary.kind === 'incomplete' && primary.retryCause) return primary;
            }
            if (sources === null) {
              const selected = await selectForDownload();
              if (!isSelection(selected)) return selected;
              sources = selected.picked;
              lastScanned = selected.scanned;
            }
          }
          stop = stopped(context.signal);
          if (stop) return stop;
          if (!sources.length) return primary ?? unavailable('search', lastScanned > 0);
          let supplemented = false;
          let occupied: 'host_occupied' | 'host_breaker' | null = null;
          for (;;) {
            let allFailed = true;
            for (const url of sources) {
              stop = stopped(context.signal);
              if (stop) return stop;
              const next = await engine.download({ ...task, source_url: url, source_kind: 'engine' }, context);
              stop = stopped(context.signal);
              if (stop) return stop;
              const host = hostOf(url);
              const reason = next.kind === 'complete' ? 'done' : next.kind === 'failure' ? next.code : next.reason;
              log('info', '引擎回退下载', {
                taskId: task.id, host, outcome: next.kind, reason,
                ...(next.kind === 'failure' && next.detail ? { detail: next.detail } : {}),
                ...(next.kind === 'incomplete' && next.retryCause ? { retryCause: next.retryCause } : {}),
              });
              if (next.kind === 'complete') return next;
              if (next.kind === 'failure') {
                if (candidates) {
                  try {
                    await candidates.markFailure(task.book_id, url, classifyFailure(next.code), next.code);
                  } catch {
                    stop = stopped(context.signal);
                    if (stop) return stop;
                    log('error', '候选失败记忆保存失败', { taskId: task.id, reason: 'candidate_persistence_unavailable' });
                    return unavailable('candidates');
                  }
                }
                continue;
              }
              if (next.reason === 'budget_exhausted' || next.reason === 'interrupted') return next;
              if (next.retryCause === 'host_occupancy_unavailable') return next;
              if (next.retryCause === 'host_occupied' || next.retryCause === 'host_breaker') {
                allFailed = false;
                // 收口口径取最后一个让出的原因（两者任务层同样排队，只影响错误列措辞）。
                occupied = next.retryCause;
                continue;
              }
              if (SOURCE_LEVEL_INCOMPLETE_REASONS.has(next.reason)) {
                if (candidates) {
                  try {
                    await candidates.markFailure(task.book_id, url, classifyFailure(next.reason), next.reason);
                  } catch {
                    stop = stopped(context.signal);
                    if (stop) return stop;
                    log('error', '候选失败记忆保存失败', { taskId: task.id, reason: 'candidate_persistence_unavailable' });
                    return unavailable('candidates');
                  }
                }
                continue;
              }
              return next;
            }
            if (!allFailed || supplemented || !candidates) break;
            supplemented = true;
            const selected = await selectForDownload();
            if (!isSelection(selected)) return selected;
            sources = selected.picked;
            lastScanned = selected.scanned;
            stop = stopped(context.signal);
            if (stop) return stop;
            if (!sources.length) break;
          }
          stop = stopped(context.signal);
          if (stop) return stop;
          // hostwait1031：有候选只是 host 正被别的任务占着（没真试过）⇒ 带 retryCause 收口，让任务层按排队
          // 处理（WorkerOptions.hostWait）；也先于下面的身份终态——候选还没试，不能判这本书无源。
          // breakeryield1031：host_breaker（本机限速器熔断中，同样没真试完）同此口径。
          if (occupied) return { ...unavailable('search'), retryCause: occupied };
          // nocandrev41 F1：预检判定过身份缺失（原源可达但无此书）且候选全失败 ⇒ 按身份失败
          // 终态收口（与预检腿选不到候选同一语义），不降级成 source_unavailable 16 轮退避重扫。
          if (primary === null && plan?.identityMissed) return { kind: 'failure', code: 'identity_mismatch_or_no_candidate' };
          return primary ?? unavailable('search');
        },
      };
    },
  };
}
