import { getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';
import { createDeadline, raceDeadline, type RequestDeadline } from '@/lib/deadline';
import { validateSourceUrl, refreshSupportedHosts } from '@/lib/source-policy';
import {
  builtinFallbackSource, builtinUrlPrefixes, engineHosts, type SupportedSourceTier,
} from '@/lib/supported-sources';
import {
  ADMISSION_MAX_REDIRECTS, ADMISSION_MIN_BUDGET_MS, ADMISSION_PROBE_WORST_MS, assertAdmissionVersionConsistent,
  defaultAdmissionTransport, runAdmissionBatch,
  type AdmissionCandidate, type AdmissionSourceRow,
} from '@/lib/rule-engine/admission';
import { selectCandidates, type RawSource } from '@/lib/rule-engine/compile-smoke';
import {
  FILTER_COUNT_KEYS, SOURCE_PAGE_SIZE, offsetFor, pageCount,
  type ShuyuanAvailability, type ShuyuanSourceFilter,
} from '@/lib/shuyuan-view';

export type { ShuyuanAvailability };

// 书源合集（yckceo.com）拉取、合并去重、失效治理。
// 列表页是静态 HTML，合集 JSON 端点按 id 取；yckceo 在国内直连被 SNI 重置，
// 但 Vercel 出口在美国，直连没问题（2026-09-13 经凤凰城 VPS 验证）。

export const INDEX_URL = 'https://www.yckceo.com/yuedu/shuyuans/index.html';
const jsonUrl = (id: number) => `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
export const LATEST_COUNT = 3; // 只跟最新 3 个合集
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_CONCURRENCY = 10;
// 连续探测失败达到该次数，才把源写成 failed（failed 会被 getReadingSources 剔除，退出取书可用集）。
// 单次失败（含连接层挂起拖满 PROBE_TIMEOUT_MS 这类瞬时抖动）只累加计数，不改变上一次的结论状态：
// probeWorker 每个源每轮刷新只探测一次、不重试，阈值就是靠跨刷新累积的这几次单次探测生效的。
const PROBE_FAILURE_THRESHOLD = 3;
// 每轮刷新最多补探多少个「还没有任何探测结论」的可探测源。补探是为了让可用性数据从零自动建立
// （否则门控只认已有的失败记录，永远没有第一条记录）。上限取并发数，且整批排在已知失败源之后：
// 已知失败源为空时，补探正好压在一轮并发里（≤ PROBE_TIMEOUT_MS），不额外吃刷新预算；
// 已知失败源占满并发时，补探要等下一波，最坏多花一轮 PROBE_TIMEOUT_MS。
const PROBE_DISCOVERY_PER_REFRESH = PROBE_CONCURRENCY;
// 每轮刷新最多重探多少个卡在「待核验」(pending) 的源。pending 是一个**死态**：规则变化把源置 pending
// 后，入队循环原本一律 `status === 'pending' → continue`，既不进失败重探也不进补探 ⇒ 只要上游规则
// 不再变，它就永远停在 pending（生产实测 944 个 pending 常驻、reachable 0）。这里让它**有界地**回到
// 探测队列：排在已知失败源重探与补探之后（优先级最低），每轮限名额，避免 944 个 backlog 一次涌入
// 队列挤占已知失败源的重探。取 4 × 并发：单轮预算最坏可容纳 ~180s/8s × 10 ≈ 200 次探测，40 次
// pending 重探最坏占 4 波 × 8s = 32s，给已知失败源重探与准入批次留足余量；同时每天 1 次 cron 下
// 944 个 backlog 约 24 轮（≈24 天）清空，与上游规则变化频率同量级。
// 顺序保证（probes → discovery → pendingReprobe）让 pending 无论名额多大都饿不到已知失败源重探。
export const PROBE_PENDING_PER_REFRESH = 4 * PROBE_CONCURRENCY;
const INSERT_CHUNK = 100;
const SOURCE_STATUS_LIMIT = 100;
const WRITE_RESERVE_MS = 5_000;
// 响应体读取（json/text）超时：超出即中止该响应，不认为已恢复
export const RESPONSE_TIMEOUT_MS = 12_000;
// 刷新总预算：index + 合集 JSON + 失效源探活 共用这一整份预算；
// 剩余时间不足时不再新增探活（未探测的源不能当作已恢复）。
// 180s：M1 准入批次（真实搜索 ≤ admissionMaxProbes() 源 × 最坏 8.4s/源串行，默认 20 源
// ≈ 168s，**会越出本预算**——但 canProbe 逐探止损在预算耗尽前停止探测，剩余候选写未测
// 占位下轮续测，刷新本身不被挤挂）仍留余量给替换事务与写库；route maxDuration=295s
// 平台上限内（41-ADMIT-THROUGHPUT：264s 最坏总墙钟 < 295s，25 源会顶破故默认 20）。
export const REFRESH_BUDGET_MS = 180_000;

export type ShuyuanCollection = { id: number; title: string; count: number };

export type ShuyuanCounts = {
  total: number;
  active: number; // 兼容字段：启用且最近探测可达，不能用未禁用数量填充。
  enabled: number;
  disabled: number;
  unprobed: number;
  pending: number;
  reachable: number;
  failed: number;
};
// B3（audit-1 P0-2）：源池可观测。readingPoolSize = getReadingSources 实际取书池大小
// （不是「启用数」——995 enabled / 0 可达的假象正是这次审计要暴露的）；
// refreshedAtAgeHours = 刷新停更了多久，null 表示从未成功刷新。
// M2-3 §6.3 扩面：enginePoolSize / poolCandidates / admission 三项放量观测。
export type ShuyuanAdmissionFunnel = {
  /** compile_ok ∧ search_ok IS TRUE —— 与引擎源入池判据同一口径。 */
  ok: number;
  /** 可复测（未测/限流/5xx/4xx/url_invalid/no_result）。 */
  deferred: number;
  /** 站点行为终态（compile 拒、challenge、conn_fail、shell）。 */
  rejected: number;
  /**
   * 准入兼容 L4（§2.4）：靠引擎默认值（缺 ruleToc.chapterUrl，legado baseUrl 兜底）进池的
   * 源数。救回的 10 条预期就是退化「1 章书」——数字突然上涨 ⇒ 上游源池形态变了，需人工看。
   * 不计入 W1/W2 放量容量判据（审查修改点）。
   */
  url_defaulted: number;
  /** 被拒源的必需组缺失分布（新拒原因当天可见；不在 ENGINE_DEFAULT_FIELDS 的字段）。 */
  miss_chapter_list: number;
  miss_chapter_name: number;
  /** compile 拒绝按 machine-readable code 聚合，避免依赖本地化 message。 */
  rejection_codes: Record<string, number>;
};
export type ShuyuanPoolHealth = {
  readingPoolSize: number;
  refreshedAtAgeHours: number | null;
  /** 池内非 builtin（引擎）源数：区分「池里有 5 个源」与「只有 book15」（§6.3）。 */
  enginePoolSize: number;
  /** 满足入池条件但被池上限截断的源数：>0 = 还有放量空间（W2/W3 放行判据，§2.3）。 */
  poolCandidates: number;
  /** 准入漏斗现状（§4.3）：池小的原因可能是没有合格源，也可能是准入批次没跑够。 */
  admission: ShuyuanAdmissionFunnel;
};
export type ShuyuanSourceStatus = {
  url: string; name: string; disabled: boolean; availability: ShuyuanAvailability;
  lastError: string; checkedAt: string | null; probeError: string | null;
};
export type ShuyuanStats = ShuyuanCounts & {
  collections: ShuyuanCollection[];
  refreshedAt: string | null;
  sources: ShuyuanSourceStatus[];
  sourcesLimit: number;
};

/**
 * 分页元信息。只有显式传 list 参数调用 getShuyuanStats 时才会附在返回值上——
 * 不带参数的调用保持原有形状，/api/stats 等既有消费方不受影响。
 */
export type ShuyuanSourcePage = {
  filter: ShuyuanSourceFilter;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
export type ShuyuanStatsPage = ShuyuanStats & ShuyuanSourcePage;
export type ShuyuanListQuery = { filter: ShuyuanSourceFilter; page: number };

type Sql = ReturnType<typeof getSql>;
// consecutive_failures 是跨刷新累积的连续探测失败次数：成功写 0（清零），失败 +1，
// 达到 PROBE_FAILURE_THRESHOLD 才把 status 写成 failed。旧快照没有这个字段 ⇒ undefined，
// 与加字段前的解析结果逐字节等价（`?? 0` 只在判据处补齐，不写回解析结果）。
type ProbeState = {
  url: string; status: ShuyuanAvailability; checked_at: string | null; error: string | null;
  consecutive_failures?: number;
};
type MetaRow = { collections: unknown; refreshed_at: string | null };
type StoredSource = {
  source_url: string; source: Record<string, unknown>; last_error: string; disabled_at: string | null;
};

export interface ReadingSource {
  url: string;
  name: string;
  searchUrl: unknown;
  rules: Record<string, unknown>;
  /** 注册表档位：builtin=book15 内建适配器；M1/T7=引擎解释（source-reader 分派依据）。 */
  tier?: SupportedSourceTier;
}

/**
 * M2-3 全局 kill switch（m2-scaleout §6.1，本任务提前落地）。
 * **默认关闭**：多源循环（M2-2 的软预算/切片/跳源）未落地前不把引擎源并入取书池——
 * 否则准入数据一到位，`resolveSourceBook` 会按池里每个源发请求，单次阅读预算被多源分食，
 * 55s deadline 下可能把「上游慢」变成用户侧超时/503。打开即等价 W1 起的放量（配合 READING_POOL_LIMIT）。
 * 只有显式 `1`/`true`/`on` 才开；缺失/`0`/`false` 一律关闭（回退效果 = book15-only）。
 */
export function engineSourcesEnabled(): boolean {
  const raw = process.env.READING_ENGINE_SOURCES?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** M2-3 波次开关（m2-scaleout §6.1）：池上限默认 4（放量前与既有 slice(0,4) 逐字相同）。 */
export const DEFAULT_READING_POOL_LIMIT = 4;

/** 池上限：env `READING_POOL_LIMIT` 生效；非法/≤0/缺失回退默认。 */
export function readingPoolLimit(): number {
  const parsed = Number.parseInt(process.env.READING_POOL_LIMIT ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_READING_POOL_LIMIT;
}

/**
 * 取书源池的完整形状（M2-3 §2.3/§6.3）：除排序后的池条目外，带两个放量观测数。
 * `poolCandidates` = 满足入池条件但被 `readingPoolLimit` 截断的源数（>0 说明还有放量空间）。
 */
export interface ReadingPool {
  sources: ReadingSource[];
  enginePoolSize: number;
  poolCandidates: number;
}

/**
 * 取书源池：注册表合成视图（设计 §5.2/§5.3）。builtin 恒在前（book15 零回归红线）。
 * 引擎源（admission ok ∧ 非 disabled ∧ probe 非 failed，按 §2.4 全序排序）**受
 * kill switch 约束**：READING_ENGINE_SOURCES 默认关 ⇒ 池 = builtin only，与今天逐字节相同。
 *
 * §2.4 全序（先表内各自排好，再按「builtin 恒在引擎源之前」拼接——builtin 是优先级最高的
 * 首键，故拼接即等价于对合并集按全序排序）：
 *   (tier='builtin') DESC → (probe reachable) DESC → tier 升序 → search_checked_at DESC → url 升序。
 *
 * 「builtin 恒在前」只有一个例外（41-M1.3）：阅读侧拿到本池后会再过一遍 orderByHostHealth（resolveSourceBook
 * 的源顺序、章节级换源的候选队列），builtin 的 host 被判 suspect（进程内记忆：连续传输层硬失败 ≥2 次且最近一次
 * 在窗口内，见 source-host-health.ts）时让位到队尾——只降序不剔除，窗口过期或成功一次即恢复原位。
 * 本函数产出的池序本身不变，仍是 builtin 恒在前。
 */
export async function getReadingPool(signal: AbortSignal): Promise<ReadingPool> {
  const limit = readingPoolLimit();
  const eligible = await eligibleReadingSources(signal, engineSourcesEnabled());
  // builtin 全部排在引擎源之前（§2.4 首键），故 slice 上限作用在合并序列上即等价于
  // 「先取满 builtin、再按引擎源全序补位」——builtin 永远不会被引擎源挤出池。
  const sources = eligible.slice(0, limit);
  return {
    sources,
    enginePoolSize: sources.filter((source) => source.tier !== undefined && source.tier !== 'builtin').length,
    poolCandidates: Math.max(0, eligible.length - sources.length),
  };
}

/**
 * 入池条件合格、按 §2.4 全序排好的全部源（未截断）：取书池与扇出候选（41-fanout）共用同一份合成与排序，
 * 二者只差截断上限与是否并入引擎源。includeEngine=false 时完全不碰 host 门、不查准入表（零回归 + 省 DB 往返）。
 */
async function eligibleReadingSources(signal: AbortSignal, includeEngine: boolean): Promise<ReadingSource[]> {
  const s = getSql();
  // 引擎分支：host 门随池合成刷新（设计 §6.1）。必须排在 readMeta **之前**——readMeta 解析
  // probeSnapshot 时用 canProbe（= validateSourceUrl 的运行时 host 门）过滤引擎源的探测态；门没刷，
  // 引擎源的 reachable 结论会被旧门丢弃、排序失真。engineHosts 读失败 ⇒ 不刷门（既有集合原样保留，
  // fail-closed）且本次降级 builtin-only。开关默认关时完全不碰门、连准入表都不查（零回归 + 省 DB 往返）。
  // 这条「刷门必须排在 readMeta 之前」的不变量在**刷新路径**同样成立（且更严重）：refreshWithinBudget
  // 的 readMeta 与探测入队都用 canProbe，冷启动不先刷门会把整批引擎源静默滤出探测队列，见该处注释。
  const engineOk = includeEngine ? await refreshEngineHostGate(signal) : false;
  const { states } = readMeta((await storedMeta(s, signal)).collections);
  const builtin = await builtinReadingSources(s, states, signal);
  const engine = engineOk ? await engineSourcesIncremental(s, states, signal) : [];
  return [...builtin, ...engine];
}

/**
 * 扇出开关（41-fanout 第一期）：浏览器逐源并发 probe 的服务端入口 `/api/read/source-probe`。
 * **默认关闭**；只有显式 `1`/`true`/`on` 才开（与 READING_ENGINE_SOURCES 同口径）。关闭时路由返回 404。
 */
export function sourceFanoutEnabled(): boolean {
  const raw = process.env.SOURCE_FANOUT_ENABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** 扇出候选上限默认 24（legado-arch-41 C.3），硬上限 60：env 误配不得把一次换源放大成对上百个站的扫描。 */
export const DEFAULT_SOURCE_FANOUT_LIMIT = 24;
export const MAX_SOURCE_FANOUT_LIMIT = 60;

/** 扇出候选上限：env `SOURCE_FANOUT_LIMIT`；非法/≤0/缺失回退默认，合法值夹到 MAX。与 READING_POOL_LIMIT 解耦。 */
export function sourceFanoutLimit(): number {
  const parsed = Number.parseInt(process.env.SOURCE_FANOUT_LIMIT ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_SOURCE_FANOUT_LIMIT) : DEFAULT_SOURCE_FANOUT_LIMIT;
}

/** 扇出候选：取书池的条目 + readable（用户点选后确认/阅读路径能否打开它，与 getSourcePools().selectable 同口径）。 */
export interface FanoutSource extends ReadingSource {
  readable: boolean;
}

/**
 * 用户显式指定源（确认 book_url、章节续读认当前源）的反查范围（41-readall）：已过合格判据的源，只受开关约束——
 * 引擎开关开 ⇒ 全部；关 ⇒ 只有 builtin。与取书池、扇出候选同一份合成与过滤（compile_ok ∧ search_ok、非 disabled、
 * probe 非 failed、canProbe host 门），不放宽「谁能当源」，只放宽「排第几位才认」。
 */
function selectableTier(source: ReadingSource, engineOn: boolean): boolean {
  return engineOn || source.tier === 'builtin';
}

/**
 * 扇出候选集（41-fanout P1-B 服务端）：builtin + 准入 ok 的引擎源（compile_ok ∧ search_ok IS TRUE，第一期不纳未测源），
 * 与取书池同一份合成与全序，只把截断上限换成 sourceFanoutLimit()。引擎源**不受** READING_ENGINE_SOURCES 约束
 * （扇出由 SOURCE_FANOUT_ENABLED 单独把门，调用方先判开关）；为此这里总会按准入表刷一次 host 门——与取书池开引擎源时同一数据源。
 *
 * readable：确认路径（index?book_url=）与章节路径按 getSourcePools().selectable 反查源（41-readall）——扇出候选全部落在
 * 其内（上限取 max(取书池, 扇出)），故 readable 只看开关：引擎开关关时引擎源仍是「仅展示」（面板 unreadable）。
 */
export async function getFanoutPool(signal: AbortSignal): Promise<FanoutSource[]> {
  const eligible = await eligibleReadingSources(signal, true);
  const engineOn = engineSourcesEnabled();
  return eligible.slice(0, sourceFanoutLimit()).map((source) => ({
    ...source,
    readable: selectableTier(source, engineOn),
  }));
}

/**
 * 用户显式指定源时的反查范围（类型标记）：只有 getSourcePools 产出。确认路径与章节续读认当前源的查找函数要求这个类型，
 * 取书池（自动遍历用）传进去编译不过——「按池反查源」的调用点改一处漏一处，是本项目反复出现的模式（41-readall）。
 */
export type SelectableSources = readonly ReadingSource[] & { readonly __selectableSources: true };

/** 反查范围上限：取书池与扇出候选的并集（二者是同一全序的前缀），任何一侧能展示/遍历到的源，用户点选都认。 */
export function selectableSourceLimit(): number {
  return Math.max(readingPoolLimit(), sourceFanoutLimit());
}

export interface SourcePools {
  /** 自动遍历（无指定源的首开 / 章节级兜底换源）：按 readingPoolLimit() 截断，与 getReadingSources 逐条相同。 */
  traversal: ReadingSource[];
  /** 用户显式指定源的反查范围：同一序列按 selectableSourceLimit() 截断、再按开关过滤（见 selectableTier）。 */
  selectable: SelectableSources;
}

/**
 * 一次合成同时给出两份池（41-readall）：traversal 是 selectable 的前缀（同一全序），章节路径一次 DB 往返拿齐。
 * includeEngine 与取书池同口径（READING_ENGINE_SOURCES）：开关关时不刷 host 门、不查准入表，selectable 只剩 builtin。
 */
export async function getSourcePools(signal: AbortSignal): Promise<SourcePools> {
  const engineOn = engineSourcesEnabled();
  const eligible = await eligibleReadingSources(signal, engineOn);
  return {
    traversal: eligible.slice(0, readingPoolLimit()),
    selectable: eligible.slice(0, selectableSourceLimit())
      .filter((source) => selectableTier(source, engineOn)) as unknown as SelectableSources,
  };
}

/**
 * 取书源列表（既有签名，`getReadingPool().sources`）。保留此入口以零回归既有调用方
 * （read/source 路径与既有测试只关心条目，不关心放量观测）。
 */
export async function getReadingSources(signal: AbortSignal): Promise<ReadingSource[]> {
  return (await getReadingPool(signal)).sources;
}

// 🔴 脱敏（审查遗留项）：DB/网络错误的 message 可能含连接串（含口令）——Neon 连接错误会
// 回显 DATABASE_URL 原文。降级日志只保留可读的错误类别：任何带 `://` 或 `@host` 形态的
// token 一律抹掉再截断（与 engine-fetch.mjs 的 safeReason 同款纪律）。
function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\S*:\/\/\S*/g, '[redacted-url]').replace(/\S+@\S+/g, '[redacted]').slice(0, 300);
}

/**
 * 引擎源是**增量**：读该表出错（如 schema 未就绪/库抖动）绝不能杀死 builtin 取书路径
 * （零回归红线）。失败按空集处理，book15 单源行为与今日逐点相同。
 */
async function engineSourcesIncremental(
  s: Sql, states: Map<string, ProbeState>, signal: AbortSignal,
): Promise<ReadingSource[]> {
  try {
    return await engineReadingSources(s, states, signal);
  } catch (error) {
    signal.throwIfAborted();
    console.error('shuyuan engine sources unavailable, falling back to builtin only', {
      reason: safeReason(error),
    });
    return [];
  }
}

/**
 * host 门随池合成刷新（设计 §6.1）：把 source_admission ok 态 host（compile_ok ∧ search_ok IS TRUE）
 * 并入运行时门（validateSourceUrl 的 supportedHosts）。此前该门只在 cron 准入批次尾部刷新
 * （refreshWithinBudget → runAdmissionAfterRefresh → refreshSupportedHosts）；hub 不可达时
 * refreshShuyuan 降级、准入批次不跑，门就永远不刷——人工种进 source_admission 的 ok 行也过不了门、
 * 进不了取书池。这里把「cron 批次成功后才刷」放宽为「池合成时按 DB 实况刷」。
 *
 * 语义安全：engineHosts 读的正是 cron 尾部同一数据源（source_admission ok 行的 host）；写路径仍只有
 * cron 准入批次（或人工 SQL），运行时无写、无放大。每次池合成刷一遍开销可接受（一次只读 DISTINCT，表很小）。
 *
 * 返回值：true = 已成功刷门、可查引擎源；false = engineHosts 读失败（表不存在/库抖动）⇒ **未刷门**
 * （既有集合原样保留，fail-closed：收窄到内建，绝不放大、绝不空集），且本次池降级为 builtin-only。
 * 绝不让 getReadingPool 抛错（零回归红线）。
 */
async function refreshEngineHostGate(signal: AbortSignal): Promise<boolean> {
  try {
    refreshSupportedHosts(await engineHosts(signal));
    return true;
  } catch (error) {
    signal.throwIfAborted();
    console.error('shuyuan engine host gate refresh failed, falling back to builtin only', {
      reason: safeReason(error),
    });
    return false;
  }
}

/** 内建（builtin）档条目：改查注册表内建 URL 前缀，不再硬编码 ILIKE 字面量。 */
async function builtinReadingSources(
  s: Sql, states: Map<string, ProbeState>, signal: AbortSignal,
): Promise<ReadingSource[]> {
  const patterns = builtinUrlPrefixes().map((prefix) => `${prefix}%`);
  const rows = await readRows<StoredSource & { name: string }>(s, s`
    SELECT source_url, name, source, disabled_at::text AS disabled_at, last_error
    FROM shuyuan_sources
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(patterns)}::jsonb) AS p(pattern)
      WHERE source_url ILIKE p.pattern)
    ORDER BY source_url`, signal);
  const supported = rows.filter((row) => canProbe(row.source_url));
  const fallback = builtinFallbackSource();
  // The same built-in adapter as the download worker, only when the collection
  // has no record for this host. A disabled/failed record must never be bypassed.
  if (!supported.length) {
    return [{ url: fallback.url, name: fallback.name, searchUrl: fallback.searchUrl, rules: {}, tier: 'builtin' }];
  }
  return supported.filter((row) => !row.disabled_at && isRecord(row.source) && row.source.enabled !== false && states.get(row.source_url)?.status !== 'failed')
    .sort((a, b) => probeRank(states, b.source_url) - probeRank(states, a.source_url)
      || a.source_url.localeCompare(b.source_url))
    .map((row) => ({
      url: validateSourceUrl(row.source_url).href, name: row.name.slice(0, 200) || fallback.name,
      searchUrl: row.source.searchUrl ?? fallback.searchUrl, rules: row.source, tier: 'builtin' as const,
    }));
}

/** probe 优先序：可达 = 2、其余 = 1（可达优先，§2.4）。 */
function probeRank(states: Map<string, ProbeState>, url: string): number {
  return states.get(url)?.status === 'reachable' ? 2 : 1;
}

/** tier 升序权重（§2.4：builtin < M1 < T7）；builtin 不出现在引擎源里。 */
function tierRank(tier: string): number {
  return tier === 'T7' ? 2 : 1;
}

/** 新鲜结论优先（§2.4）：无结论时刻（未测）排最后。 */
function checkedAtMs(value: string | null): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * 引擎档条目（设计 §5.2）：shuyuan_sources JOIN source_admission，admission ok（compile_ok ∧
 * search_ok IS TRUE）∧ 非 disabled ∧ probe 非 failed；rules 原样透传 source 对象（m2-scaleout
 * §5.2 第 1 条：任何裁剪都会让 revision 漂移、目录缓存全体失效）。
 * 排序即 §2.4 全序的引擎段：(probe reachable) DESC → tier 升序 → search_checked_at DESC → url 升序。
 */
async function engineReadingSources(
  s: Sql, states: Map<string, ProbeState>, signal: AbortSignal,
): Promise<ReadingSource[]> {
  const rows = await readRows<StoredSource & { name: string; tier: string; search_checked_at: string | null }>(s, s`
    SELECT src.source_url, src.name, src.source, src.disabled_at::text AS disabled_at, src.last_error,
           a.tier, a.search_checked_at::text AS search_checked_at
    FROM shuyuan_sources src
    JOIN source_admission a ON a.source_url = src.source_url
    WHERE a.compile_ok AND a.search_ok IS TRUE
    ORDER BY src.source_url`, signal);
  return rows
    .filter((row) => canProbe(row.source_url) && !row.disabled_at && isRecord(row.source)
      && row.source.enabled !== false && states.get(row.source_url)?.status !== 'failed')
    .sort((a, b) => probeRank(states, b.source_url) - probeRank(states, a.source_url)
      || tierRank(a.tier) - tierRank(b.tier)
      || checkedAtMs(b.search_checked_at) - checkedAtMs(a.search_checked_at)
      || a.source_url.localeCompare(b.source_url))
    .map((row) => ({
      url: validateSourceUrl(row.source_url).href,
      name: row.name.slice(0, 200) || hostOfUrl(row.source_url),
      searchUrl: typeof row.source.searchUrl === 'string' ? row.source.searchUrl : '',
      rules: row.source,
      tier: (row.tier === 'T7' ? 'T7' : 'M1') as SupportedSourceTier,
    }));
}

function hostOfUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 引擎档候选（设计 §5.2 的新增导出；M2-3 的放量/排序在此扩面）。 */
export async function getEngineSources(signal: AbortSignal): Promise<ReadingSource[]> {
  const s = getSql();
  const { states } = readMeta((await storedMeta(s, signal)).collections);
  return engineReadingSources(s, states, signal);
}

function canProbe(url: string): boolean {
  try { validateSourceUrl(url); return true; } catch { return false; }
}

// collections 仍是数组，首项附带仅由服务端产生的版本化探测快照；旧数据默认未探测。
// 不需要 DDL，也不信任上游规则 JSON 中自报的健康状态。
// 条目里允许出现 status='unprobed'：那是「探测过、但连续失败还没达到判死阈值」的一态，
// 对展示、筛选和取书判据而言与「没有条目」完全等价，加它只是为了把连续失败计数持久化下来。
function readMeta(value: unknown): { collections: ShuyuanCollection[]; states: Map<string, ProbeState> } {
  const list = Array.isArray(value) ? value : [];
  const collections = list.filter((item) => isRecord(item) &&
    typeof item.id === 'number' && typeof item.title === 'string' && typeof item.count === 'number')
    .map((item) => ({ id: item.id as number, title: item.title as string, count: item.count as number }));
  const snapshot: unknown = isRecord(list[0]) ? list[0].probeSnapshot : undefined;
  const states = new Map<string, ProbeState>();
  const seen = new Set<string>();
  if (isRecord(snapshot) && snapshot.version === 1 && Array.isArray(snapshot.entries)) {
    for (const entry of snapshot.entries) {
      if (!isRecord(entry) || typeof entry.url !== 'string') continue;
      if (seen.has(entry.url)) { states.delete(entry.url); continue; }
      seen.add(entry.url);
      if (!['unprobed', 'pending', 'reachable', 'failed'].includes(String(entry.status))) continue;
      const status = entry.status as ProbeState['status'];
      const checkedAt = typeof entry.checked_at === 'string' && Number.isFinite(Date.parse(entry.checked_at))
        ? entry.checked_at : null;
      // pending 与 unprobed 都没有「结论时刻」，其余两态必须有可探测域名和有效时间戳。
      if (status !== 'pending' && (!canProbe(entry.url) || (status !== 'unprobed' && !checkedAt))) continue;
      const failures = typeof entry.consecutive_failures === 'number' && Number.isSafeInteger(entry.consecutive_failures)
        && entry.consecutive_failures >= 0 ? entry.consecutive_failures : undefined;
      states.set(entry.url, {
        url: entry.url, status,
        checked_at: status === 'pending' || status === 'unprobed' ? null : checkedAt,
        error: typeof entry.error === 'string' ? entry.error.slice(0, 200) : null,
        // 缺字段时留 undefined（不补 0）：解析旧快照必须与加字段前逐字节等价。
        consecutive_failures: failures,
      });
    }
  }
  return { collections, states };
}

export function sameRules(a: unknown, b: unknown): boolean {
  // jsonb 对象键顺序不是规则变化，数组顺序仍有意义。
  const stable = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  return stable(a) === stable(b);
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// PG jsonb 严禁 NUL，孤立 UTF-16 代理项编码成 UTF-8 也非法；
// 上游合集里确实存在这类脏数据（2026-09-13 实测 bookSourceComment 混入 NUL）。
export function cleanJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\u0000/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '�')
      .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
  }
  if (Array.isArray(value)) return value.map(cleanJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanJson(item)]));
  }
  return value;
}

// 跳转目标主机白名单:上游 yckceo 把合集 JSON 端点改成 302 跳转到 jsdelivr 托管文件
// (2026-09-21 实测 gcore.jsdelivr.net,三镜像均可达)。原先 fetchText 用 redirect:'error'
// 硬拒一切跳转,上游一改就全量失败;这里改为**有界跟随**,但只跟随到受信 CDN 主机,
// 绝不无脑 redirect:'follow'(那会放大 SSRF 面:上游可把请求引向任意内网/元数据地址)。
// 判据:目标 host === 白名单精确 host,或其子域(endsWith('.' + 白名单 host))。
const TRUSTED_REDIRECT_HOSTS = ['jsdelivr.net'] as const;
// 跳数上限复用准入通道既有常量,避免两处漂移。
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isTrustedRedirectTarget(rawLocation: string, base: string): boolean {
  let target: URL;
  try {
    target = new URL(rawLocation, base); // 缺省 base 处理相对 Location
  } catch {
    return false;
  }
  if (target.protocol !== 'https:') return false;
  const host = target.hostname.toLowerCase();
  return TRUSTED_REDIRECT_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export async function fetchText(url: string, timeoutMs: number, parentSignal: AbortSignal): Promise<string> {
  const deadline = createDeadline(timeoutMs);
  const signal = AbortSignal.any([parentSignal, deadline.signal]);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    // 有界跟随:每跳手动取 Location,逐跳复验主机白名单;超跳数/非白名单/非 https/循环即拒。
    // 错误只带 host 与状态,不带任何键值。HTTP 与 body 读取仍走同一份 signal(含超时预算)。
    let current = url;
    const visited = new Set<string>([current]);
    for (let redirects = 0; ; redirects += 1) {
      signal.throwIfAborted();
      const pending = fetch(current, {
        signal, redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zhaoshu/1.0)' },
      });
      void pending.then((late) => {
        if (signal.aborted && late.body && !late.body.locked) void late.body.cancel().catch(() => {});
      }, () => {});
      response = await raceDeadline(signal, () => pending);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (response.body && !response.body.locked) void response.body.cancel(signal.reason).catch(() => {});
        response = undefined;
        if (!location) throw new Error(`书源跳转缺少 Location ${hostOf(current)}`);
        if (redirects >= ADMISSION_MAX_REDIRECTS) throw new Error(`书源跳转次数超限 ${hostOf(current)}`);
        if (!isTrustedRedirectTarget(location, current)) {
          throw new Error(`书源跳转到非受信主机(拒绝)${redirectHostOf(location, current)}`);
        }
        const next = new URL(location, current).href;
        if (visited.has(next)) throw new Error(`书源跳转形成循环 ${hostOf(next)}`);
        visited.add(next);
        current = next;
        continue;
      }
      // 非跳转的 HTTP 失败沿用原语义:错误里带完整源 URL(既有测试与下游 err 字段依赖此形状;
      // 该 URL 是源地址、非秘密)。仅「跳转类」错误改为只带 host,避免回显上游带签名的 Location。
      if (!response.ok) throw new Error(`${response.status} ${current}`);
      if (!response.body) return '';
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const result = await raceDeadline(signal, () => reader!.read());
        if (result.done) { complete = true; return text + decoder.decode(); }
        text += decoder.decode(result.value, { stream: true });
      }
    }
  } finally {
    if (reader) {
      if (!complete) void reader.cancel(signal.reason).catch(() => {});
      reader.releaseLock();
    } else if (response?.body && !response.body.locked) {
      void response.body.cancel(signal.reason).catch(() => {});
    }
    deadline.dispose();
  }
}

/** 只取 URL 的主机名用于错误信息(绝不回显路径/查询,避免把带签名的 URL 泄漏进日志)。 */
function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return '[unparseable-url]'; }
}

function redirectHostOf(rawLocation: string, base: string): string {
  try { return `-> ${new URL(rawLocation, base).hostname}`; } catch { return '-> [unparseable-location]'; }
}

export function parseIndex(html: string): { id: number; title: string }[] {
  const entries: { id: number; title: string }[] = [];
  const re = /href="\/yuedu\/shuyuans\/content\/id\/(\d+)\.html"[^>]*>([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    entries.push({ id: Number(m[1]), title: m[2].trim() });
  }
  return entries;
}

async function readRows<T>(s: Sql, query: ReturnType<Sql>, signal?: AbortSignal): Promise<T[]> {
  if (!signal) return await query as T[];
  signal.throwIfAborted();
  const [rows] = await raceDeadline(signal, () => s.transaction([query], { readOnly: true, fetchOptions: { signal } }));
  signal.throwIfAborted();
  return rows as T[];
}

async function storedMeta(s: Sql, signal?: AbortSignal): Promise<MetaRow> {
  const rows = await readRows<MetaRow>(s, s`
    SELECT collections, refreshed_at::text AS refreshed_at FROM shuyuan_meta WHERE id = 1`, signal);
  return rows[0] ?? { collections: [], refreshed_at: null };
}

async function countsFromStates(s: Sql, states: Map<string, ProbeState>, signal?: AbortSignal): Promise<ShuyuanCounts> {
  const rows = await readRows<ShuyuanCounts>(s, s`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE disabled_at IS NULL AND p.status = 'reachable')::int AS active,
           count(*) FILTER (WHERE disabled_at IS NULL)::int AS enabled,
           count(*) FILTER (WHERE disabled_at IS NOT NULL)::int AS disabled,
           count(*) FILTER (WHERE COALESCE(p.status, 'unprobed') = 'unprobed')::int AS unprobed,
           count(*) FILTER (WHERE p.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE p.status = 'reachable')::int AS reachable,
           count(*) FILTER (WHERE p.status = 'failed')::int AS failed
    FROM shuyuan_sources
    LEFT JOIN jsonb_to_recordset(${JSON.stringify([...states.values()])}::jsonb)
      AS p(url text, status text, checked_at text, error text) ON p.url = source_url`, signal);
  if (!rows[0]) throw new Error('Missing shuyuan aggregate');
  return rows[0];
}

export async function getShuyuanCounts(signal?: AbortSignal): Promise<ShuyuanCounts> {
  const s = getSql();
  const meta = readMeta((await storedMeta(s, signal)).collections);
  return countsFromStates(s, meta.states, signal);
}

// B3：给 /api/stats 的 shuyuan 段补源池健康度。池大小直接走 getReadingSources 的
// 真实判定（含 canProbe/禁用/failed 剔除），不在这里复刻筛选逻辑——两处逻辑一旦
// 漂移，监控数字就不再代表实际取书能力。
// M2-3 §6.3：同一次调用带出 enginePoolSize / poolCandidates（同一份真实判定）与
// admission 漏斗（source_admission 三态聚合，与入池判据同口径）。
export async function getShuyuanPoolHealth(signal: AbortSignal): Promise<ShuyuanPoolHealth> {
  const s = getSql();
  const raw = await storedMeta(s, signal);
  const [pool, admissionRows] = await Promise.all([
    getReadingPool(signal),
    // 漏斗是纯观测的增量：source_admission 读失败（schema 未就绪/库抖动）不能连坐
    // readingPoolSize 这条既有核心指标，退化为全 0 并响亮告警（与引擎源的降级同款纪律）。
    readAdmissionFunnel(s, signal).catch((error) => {
      signal.throwIfAborted();
      console.error('shuyuan admission funnel unavailable, reporting zeros', {
        reason: safeReason(error),
      });
      return [] as ShuyuanAdmissionFunnel[];
    }),
  ]);
  const refreshedMs = raw.refreshed_at ? Date.parse(raw.refreshed_at) : NaN;
  return {
    readingPoolSize: pool.sources.length,
    enginePoolSize: pool.enginePoolSize,
    poolCandidates: pool.poolCandidates,
    // 空表与无行都返回 0（count FILTER 恒返回一行；缺失时保守取 0）。
    admission: admissionRows[0] ?? {
      ok: 0, deferred: 0, rejected: 0, url_defaulted: 0,
      miss_chapter_list: 0, miss_chapter_name: 0, rejection_codes: {},
    },
    refreshedAtAgeHours: Number.isFinite(refreshedMs)
      ? Math.max(0, Math.round((Date.now() - refreshedMs) / 3_600_000 * 10) / 10)
      : null,
  };
}

/** 准入漏斗聚合（§6.3）：三桶谓词与入池判据 / admissionBucket 同口径。 */
function readAdmissionFunnel(s: Sql, signal: AbortSignal): Promise<ShuyuanAdmissionFunnel[]> {
  return readRows<ShuyuanAdmissionFunnel>(s, s`
    SELECT count(*) FILTER (WHERE compile_ok AND search_ok IS TRUE)::int AS ok,
           count(*) FILTER (WHERE NOT compile_ok
             OR search_verdict IN ('challenge', 'conn_fail', 'shell'))::int AS rejected,
           count(*) FILTER (WHERE compile_ok AND search_ok IS NOT TRUE
             AND search_verdict NOT IN ('challenge', 'conn_fail', 'shell'))::int AS deferred,
           count(*) FILTER (WHERE compile_ok AND search_ok IS TRUE
             AND (core_field_mask->>'ruleToc.chapterUrl') IS DISTINCT FROM 'true')::int AS url_defaulted,
           count(*) FILTER (WHERE NOT compile_ok
             AND (core_field_mask->>'ruleToc.chapterList') IS DISTINCT FROM 'true')::int AS miss_chapter_list,
           count(*) FILTER (WHERE NOT compile_ok
             AND (core_field_mask->>'ruleToc.chapterName') IS DISTINCT FROM 'true')::int AS miss_chapter_name,
           COALESCE((
             SELECT jsonb_object_agg(code, n)
             FROM (
               SELECT diagnostic->>'code' AS code, count(*)::int AS n
               FROM source_admission a
               CROSS JOIN LATERAL jsonb_array_elements(a.compile_diagnostics) diagnostic
               WHERE NOT a.compile_ok AND diagnostic ? 'code'
               GROUP BY diagnostic->>'code'
             ) rejection_counts
           ), '{}'::jsonb) AS rejection_codes
    FROM source_admission`, signal);
}

export async function getShuyuanStats(signal?: AbortSignal): Promise<ShuyuanStats>;
export async function getShuyuanStats(signal: AbortSignal | undefined, list: ShuyuanListQuery): Promise<ShuyuanStatsPage>;
// 实现签名必须是两者的联合：不带 list 时走的是 `if (!list) return stats` 那条旧形状分支。
// 对外形状由上面两个重载决定，调用方拿到的仍是精确类型。
export async function getShuyuanStats(
  signal?: AbortSignal, list?: ShuyuanListQuery,
): Promise<ShuyuanStats | ShuyuanStatsPage> {
  const s = getSql();
  const rawMeta = await storedMeta(s, signal);
  const { collections, states } = readMeta(rawMeta.collections);
  const counts = await countsFromStates(s, states, signal);
  const filter = list?.filter ?? 'all';
  const page = list?.page ?? 1;
  const pageSize = list ? SOURCE_PAGE_SIZE : SOURCE_STATUS_LIMIT;
  // 筛选谓词写成 7 个绑定参数的布尔式，而不是拼 SQL 片段：filter 会决定谓词形状，
  // 但它始终只是一个被比较的值，不进 SQL 文本。分支与 countsFromStates 的
  // FILTER (WHERE ...) 逐条对齐，所以卡片上的数字就是点进去看到的条数。
  const rows = await readRows<{
    url: string; name: string; disabled: boolean; availability: ShuyuanAvailability;
    last_error: string; checked_at: string | null; probe_error: string | null;
  }>(s, s`
    SELECT source_url AS url, name, disabled_at IS NOT NULL AS disabled,
           COALESCE(p.status, 'unprobed') AS availability,
           last_error, p.checked_at, p.error AS probe_error
    FROM shuyuan_sources
    LEFT JOIN jsonb_to_recordset(${JSON.stringify([...states.values()])}::jsonb)
      AS p(url text, status text, checked_at text, error text) ON p.url = source_url
    WHERE ${filter} = 'all'
       OR (${filter} = 'enabled' AND disabled_at IS NULL)
       OR (${filter} = 'disabled' AND disabled_at IS NOT NULL)
       OR (${filter} = 'unprobed' AND COALESCE(p.status, 'unprobed') = 'unprobed')
       OR (${filter} = 'pending' AND p.status = 'pending')
       OR (${filter} = 'reachable' AND p.status = 'reachable')
       OR (${filter} = 'failed' AND p.status = 'failed')
    ORDER BY COALESCE(p.status = 'pending', false) DESC,
             (last_error <> '' OR disabled_at IS NOT NULL) DESC, source_url
    LIMIT ${pageSize} OFFSET ${offsetFor(page, pageSize)}`, signal);
  const stats: ShuyuanStats = {
    ...counts, collections, refreshedAt: rawMeta.refreshed_at, sourcesLimit: pageSize,
    sources: rows.map((row) => ({
      url: row.url, name: row.name, disabled: row.disabled, availability: row.availability,
      lastError: row.last_error, checkedAt: row.checked_at, probeError: row.probe_error,
    })),
  };
  if (!list) return stats;
  const total = counts[FILTER_COUNT_KEYS[filter]];
  return { ...stats, filter, page, pageSize, total, totalPages: pageCount(total, pageSize) };
}

// V2 搜索失败时打失效标记：被标记的源不再进入搜索轮换
export async function disableShuyuanSource(url: string, reason: string): Promise<boolean> {
  const s = getSql();
  const rows = (await s`
    UPDATE shuyuan_sources
    SET disabled_at = now(), last_error = COALESCE(NULLIF(${reason.slice(0, 200)}, ''), last_error)
    WHERE source_url = ${normalizeUrl(url)}
    RETURNING id`) as { id: number }[];
  return rows.length > 0;
}

/**
 * 与 disableShuyuanSource 对称的手动启用：只清 disabled_at，保留 last_error 作为历史失败信息。
 *
 * 不会被「失效自动复活」规则打回去：refreshShuyuan 里对 disabled_at 只有一处写入，
 * 是把上一轮的旧值照抄进新行，没有任何把它重置为 NULL 的分支；上游规则变化只会把
 * 探测状态置为 pending（待核验），不碰启停标记。所以手动启用的语义是稳定的。
 *
 * 保留 last_error 是为了让界面继续显示「上一次为什么失败」，而不是启用后抹成一片空白。
 * 注意探活资格的门槛是「有失败记录（last_error 非空，或快照里连续失败计数 > 0）+ 域名可探测
 * （目前只有 book15.net）+ 非 pending」，其中没有 disabled_at：所以保留 last_error 并不会换来
 * 一次原本没有的重试，可探测域名下的失败源本来每次刷新都会被探一遍，启用与否都一样。
 * （每轮刷新另外补探少量「还没有任何结论」的启用源，那条才看 disabled_at——禁用源不参与取书，
 * 探它没有意义；详见 refreshWithinBudget 里的入队注释。）
 * 探测成功不清 last_error：它是历史失败证据，清掉界面上「上一次为什么失败」就没了。
 *
 * 幂等：对已启用的源执行同样返回 true（行存在）；URL 不在库里才返回 false。
 */
export async function enableShuyuanSource(url: string): Promise<boolean> {
  const s = getSql();
  const rows = (await s`
    UPDATE shuyuan_sources
    SET disabled_at = NULL
    WHERE source_url = ${normalizeUrl(url)}
    RETURNING id`) as { id: number }[];
  return rows.length > 0;
}

/** 半挂刷新的固定错误码（安全枚举，不是 e.message 原文）：/api/shuyuan 据此回 502 的 code。 */
export const SHUYUAN_REFRESH_PARTIAL = 'shuyuan_refresh_partial';

/**
 * 只拉到部分合集 ⇒ 中止本轮刷新。**不放宽判据**：写库是整表替换语义
 * （refreshWithinBudget 尾部事务先 `DELETE FROM shuyuan_sources` 再整批 INSERT merged），
 * 带着 2/3 合集继续更新会把缺失那个合集里的源从池中静默删掉——比中止更糟。
 *
 * 这里只做可观测化：预期/实到数量与失败合集（仓内自有的合集 id）挂在错误上，
 * 让「502 + 整轮零更新」在日志里能一眼定位是半挂而不是别的故障。
 * reason 过 safeReason：合集下载失败的 message 形如 `503 <上游URL>`，不能原样带出去。
 */
export class ShuyuanRefreshPartialError extends Error {
  readonly code = SHUYUAN_REFRESH_PARTIAL;
  readonly expected: number;
  readonly actual: number;
  readonly failures: { id: number; reason: string }[];
  constructor(expected: number, actual: number, failures: { id: number; reason: string }[]) {
    super(`仅拉到 ${actual}/${expected} 个书源合集，本次刷新中止，保留既有数据`);
    this.name = 'ShuyuanRefreshPartialError';
    this.expected = expected;
    this.actual = actual;
    this.failures = failures.map((failure) => ({ id: failure.id, reason: safeReason(failure.reason) }));
  }
}

// 固定合集拉取、规则核对、有限探测和写回共用原有预算（现 180s，见 REFRESH_BUDGET_MS）。
export async function refreshShuyuan(parentSignal?: AbortSignal): Promise<ShuyuanStats> {
  const budget = createDeadline(REFRESH_BUDGET_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, budget.signal]) : budget.signal;
  try {
    return await refreshWithinBudget(getSql(), budget, signal);
  } finally {
    budget.dispose();
  }
}

async function refreshWithinBudget(s: Sql, budget: RequestDeadline, signal: AbortSignal): Promise<ShuyuanStats> {
  const assertActive = () => { signal.throwIfAborted(); budget.assert(); };
  assertActive();
  const html = await fetchText(INDEX_URL, RESPONSE_TIMEOUT_MS * 2, signal);
  const entries = parseIndex(html);
  if (entries.length === 0) throw new Error('书源列表页解析到 0 个合集，页面结构可能变了');

  const merged = new Map<string, Record<string, unknown>>();
  const collections: ShuyuanCollection[] = [];
  // 失败合集的原因归类，只用于降级告警：上游整体不可达时要说清「拉了哪些、为什么没拿到」。
  const collectionFailures: { id: number; reason: string }[] = [];
  for (const entry of entries.slice(0, LATEST_COUNT)) {
    assertActive();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fetchText(jsonUrl(entry.id), RESPONSE_TIMEOUT_MS, signal));
    } catch (error) {
      assertActive();
      collectionFailures.push({ id: entry.id, reason: error instanceof Error ? error.message : '合集下载失败' });
      continue;
    }
    if (!Array.isArray(parsed)) {
      collectionFailures.push({ id: entry.id, reason: '合集 JSON 不是数组' });
      continue;
    }
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.bookSourceUrl !== 'string') continue;
      const url = normalizeUrl(item.bookSourceUrl);
      if (!url || merged.has(url)) continue;
      const cleaned = cleanJson(item);
      if (isRecord(cleaned)) merged.set(url, cleaned);
    }
    collections.push({ id: entry.id, title: entry.title, count: parsed.length });
  }
  if (merged.size === 0) {
    // 降级而不是抛错：上游合集整体不可达时抛错会让 /api/shuyuan 返回 502，且 refreshed_at 冻结——
    // 治理面（含探测与可观测）跟着上游一起停摆，库里 995 条既有源却什么都做不了。
    // 这里必须在任何写库动作之前返回：refreshed_at 停留旧值，「陈旧」由既有可观测暴露
    // （getShuyuanPoolHealth().refreshedAtAgeHours），不需要新字段，也绝不允许写假新鲜时间。
    console.error('shuyuan refresh degraded: 所有书源合集下载失败，保留既有数据', {
      collections: entries.slice(0, LATEST_COUNT).map((entry) => entry.id),
      failures: collectionFailures,
    });
    return getShuyuanStats(signal);
  }
  const expected = Math.min(LATEST_COUNT, entries.length);
  if (collections.length < expected) {
    // S3-1（静默失败审计）：只挂 1 个合集也不能「带着 2/3 继续更新」——写库是整表替换语义
    // （尾部事务先 DELETE FROM shuyuan_sources 再整批 INSERT merged），缺失那个合集的源会被
    // 静默删掉，比中止更糟。判据不放宽，只做可观测：结构化错误 + 一行响亮告警，让
    // 「502 + 整轮零更新」在日志里能一眼区分是半挂而不是别的故障。
    const partial = new ShuyuanRefreshPartialError(expected, collections.length, collectionFailures);
    console.error('shuyuan refresh partial: 仅拉到部分合集，本次刷新中止，保留既有数据', {
      code: partial.code, expected: partial.expected, actual: partial.actual, failures: partial.failures,
    });
    throw partial;
  }

  const previousRows = await readRows<StoredSource>(s, s`
    SELECT source_url, last_error, source, disabled_at::text AS disabled_at FROM shuyuan_sources`, signal);
  const previous = new Map(previousRows.map((row) => [row.source_url, row]));
  const oldMeta = await storedMeta(s, signal);
  // 🔴 host 门必须在 readMeta 解析快照（:380 的 canProbe）与探测入队（:797 的 canProbe）**之前**刷新——
  // 与 getReadingPool:185-190「刷门要排在 readMeta 之前」是同一个坑的另一处实例。冷启动的 cron
  // （每 6 小时一次、实例基本不复用）里 supportedHosts 初值只有 builtin：不先刷门，readMeta 会把
  // 引擎源的既有探测态整批丢弃（reachable 退回 unprobed）、探测入队的 canProbe 会把 1200+ 引擎源
  // 静默滤掉——reachable 长期偏低不是站点不可达，是压根没探。host 门读的是 source_admission
  // **持久表**（前几轮准入批次写入，写路径与运行时门无关），故此处拿到的是「上一轮已准入的 host」，
  // 不依赖本轮随后才发生的写库；读失败 fail-closed 保持既有集合（收窄到内建），退化为现状。
  // 开关关时保持与今天逐字节相同（不查准入表、不加 DB 往返），与 getReadingPool:191 一致。
  if (engineSourcesEnabled()) await refreshEngineHostGate(signal);
  const oldStates = readMeta(oldMeta.collections).states;
  const states = new Map<string, ProbeState>();
  const probes: string[] = [];
  // 还没有任何探测结论的启用源，按名额补探（排在已知失败源之后，理由见 PROBE_DISCOVERY_PER_REFRESH）。
  const discovery: string[] = [];
  let discoverySlots = PROBE_DISCOVERY_PER_REFRESH;
  // 卡在 pending（规则变化后退回待核验）的源，按名额重探（优先级最低，见 PROBE_PENDING_PER_REFRESH）。
  // 落在 probes/discovery 之后：pending backlog（生产 944）无论多大都不能饿死已知失败源的重探。
  const pendingReprobe: string[] = [];
  let pendingSlots = PROBE_PENDING_PER_REFRESH;
  for (const [url, item] of merged) {
    const old = previous.get(url);
    if (old && !sameRules(old.source, item)) {
      // 规则变了：旧的结论和连续失败计数一起作废，退回待核验。
      // 注意：置 pending 的分支不再 `continue`——本轮把它并入有界重探队列，打破「永不流转」的死态。
      states.set(url, { url, status: 'pending', checked_at: null, error: null });
      if (canProbe(url) && !old.disabled_at && pendingSlots > 0) {
        pendingSlots--;
        pendingReprobe.push(url);
      }
      continue;
    }
    const state = oldStates.get(url);
    if (state) states.set(url, state);
    if (state?.status === 'pending' || !canProbe(url)) {
      // 上一轮遗留下来的 pending：同样并入有界重探队列。canProbe 仍是硬门——pending 条目在
      // readMeta 里即使 host 过不了门也会被保留（:382 的特例），这里不重复 gate 就会把
      // 已离开 host 门的 pending 源送给 probeWorker，让 validateSourceUrl 抛错当成探测失败。
      // 禁用源不参与取书，不探。
      if (state?.status === 'pending' && canProbe(url) && !old?.disabled_at && pendingSlots > 0) {
        pendingSlots--;
        pendingReprobe.push(url);
      }
      continue;
    }
    // 已知失败记录（人工写的 last_error，或上一轮探测累计的连续失败计数）每轮都重探，
    // 探到成功才清零计数、回到可达。
    if (old?.last_error || (state?.consecutive_failures ?? 0) > 0) probes.push(url);
    // 没有任何结论的启用源才补探：禁用源不参与取书，探它没有意义。
    else if (!state && !old?.disabled_at && discoverySlots > 0) { discoverySlots--; discovery.push(url); }
  }
  probes.push(...discovery, ...pendingReprobe);

  // 本轮探测失败、且这个源还没有失败记录时，补一条 last_error——这是 last_error 的自动写点
  // （在此之前只有人工 POST {action:disable} 会写它）。已有值不覆盖：那是历史失败证据。
  const probeFailures = new Map<string, string>();
  let next = 0;
  async function probeWorker() {
    while (next < probes.length) {
      if (signal.aborted || budget.remainingMs <= PROBE_TIMEOUT_MS + WRITE_RESERVE_MS) return;
      const url = probes[next++];
      try {
        await fetchText(validateSourceUrl(url).href, PROBE_TIMEOUT_MS, signal);
        // 探测成功即清零连续失败计数，回到可达。
        states.set(url, { url, status: 'reachable', checked_at: new Date().toISOString(), error: null, consecutive_failures: 0 });
      } catch (error) {
        // 调用方中止（含刷新预算耗尽）不是源故障：不写状态、不计数，保持旧态。
        if (signal.aborted) return;
        const message = (error instanceof Error ? error.message : '探测失败').slice(0, 200);
        const previousState = states.get(url);
        const consecutive_failures = (previousState?.consecutive_failures ?? 0) + 1;
        if (!previous.get(url)?.last_error) probeFailures.set(url, message);
        // 未达阈值：保留上一次的结论状态（含结论时刻与错误原文），只把计数 +1。
        // 单次失败——含连接层挂起拖满 8s 超时这类瞬时抖动——不能把源踢出可用集；
        // 没有历史结论的源写成 unprobed（对展示/筛选/取书判据都等价于「没有条目」）。
        states.set(url, consecutive_failures >= PROBE_FAILURE_THRESHOLD
          ? { url, status: 'failed', checked_at: new Date().toISOString(), error: message, consecutive_failures }
          : previousState
            ? { ...previousState, consecutive_failures }
            : { url, status: 'unprobed', checked_at: null, error: null, consecutive_failures });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, probes.length) }, () => probeWorker()));
  assertActive();

  const rows = [...merged.entries()].map(([url, item]) => ({
    url, name: typeof item.bookSourceName === 'string' ? item.bookSourceName : '',
    grp: typeof item.bookSourceGroup === 'string' ? item.bookSourceGroup : '', source: item,
    disabled_at: previous.get(url)?.disabled_at ?? null,
    err: previous.get(url)?.last_error || probeFailures.get(url) || '',
  }));
  const insertChunk = (chunk: typeof rows) => s`
    INSERT INTO shuyuan_sources (source_url, name, group_name, source, disabled_at, last_error)
    SELECT url, name, grp, source, disabled_at, err
    FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
    AS t(url text, name text, grp text, source jsonb, disabled_at timestamptz, err text)`;
  const savedCollections = collections.map((collection, i) => i === 0 ? {
    ...collection, probeSnapshot: { version: 1, entries: [...states.values()] },
  } : collection);
  const updateMeta = s`
    UPDATE shuyuan_meta
    SET collections = ${JSON.stringify(cleanJson(savedCollections))}::jsonb, refreshed_at = now()
    WHERE id = 1`;
  const chunks = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) chunks.push(insertChunk(rows.slice(i, i + INSERT_CHUNK)));

  // 锁、快照守卫、全量替换和元数据在同一非交互事务内，避免覆盖并发禁用。
  const oldFlags = previousRows.map((row) => ({
    url: row.source_url, disabled_at: row.disabled_at, last_error: row.last_error,
  }));
  try {
    await s.transaction([
      s`SET LOCAL lock_timeout = '5s'`,
      s`SET LOCAL statement_timeout = '10s'`,
      s`LOCK TABLE shuyuan_sources IN SHARE ROW EXCLUSIVE MODE`,
      s`SELECT 1 / CASE WHEN
        (SELECT refreshed_at FROM shuyuan_meta WHERE id = 1) IS DISTINCT FROM ${oldMeta.refreshed_at}::timestamptz
        OR EXISTS (
          SELECT 1 FROM shuyuan_sources current
          FULL JOIN jsonb_to_recordset(${JSON.stringify(oldFlags)}::jsonb)
            AS old(url text, disabled_at timestamptz, last_error text) ON old.url = current.source_url
          WHERE current.source_url IS NULL OR old.url IS NULL
             OR current.disabled_at IS DISTINCT FROM old.disabled_at
             OR current.last_error IS DISTINCT FROM old.last_error
        ) THEN 0 ELSE 1 END AS snapshot_matches`,
      s`DELETE FROM shuyuan_sources`, ...chunks, updateMeta,
    ], { fetchOptions: { signal } });
  } catch (error) {
    if (isRecord(error) && error.code === '22012') throw new Error('书源在刷新期间发生变化，本次保留原数据，请重新刷新');
    throw error;
  }
  // M1 准入库：挂在全量替换事务**之后**（设计 §4.2 v3 E2）。事务已提交，validateAdmissionUrl
  // 读到的「源声明 host 集合」本轮即含新源；滤网 2 不在用户请求路径上跑，只在此 cron 批次。
  await runAdmissionAfterRefresh(s, rows, budget, signal);
  return getShuyuanStats(signal);
}

/**
 * 准入批次（设计 §4.2）。时序：全量替换事务之后。硬约束：
 * - 剩余预算 ≤ ADMISSION_MIN_BUDGET_MS 即整批跳过，绝不挤占刷新预算（180s）；
 * - 候选池 = 通过 survey 初筛的源 + 初筛不过但留有 compile_ok 旧行的源（41-srcfix G5，送回改判出池）；
 *   既有行读一次（按本轮全部源 URL），二者皆空才整批跳过；
 * - runAdmissionBatch 每轮真实搜索 ≤ admissionMaxProbes()（默认 20，env `ADMISSION_MAX_PROBES` 可调），逐探前再查预算。
 * 只写 source_admission，不碰 shuyuan_sources；异常不终结刷新（§6.3：准入异常 → deferred）。
 */
async function runAdmissionAfterRefresh(
  s: Sql, rows: { url: string; source: Record<string, unknown> }[], budget: RequestDeadline, signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (budget.remainingMs <= ADMISSION_MIN_BUDGET_MS) {
    // S3-3：整批跳过是静默的——刷新照样 200、池健康度数字齐全，但 source_admission 本轮没更新。
    // 连续几轮预算不够 ⇒ 准入数据无限期陈旧而表面全绿。沿用 admission batch log 的形状记一行。
    // 候选池此时还没筛（跳过的正是筛选本身），所以记的是本轮源总数而不是 candidates。
    console.log('shuyuan admission batch', {
      sources: rows.length, skipped: 'budget', remainingMs: budget.remainingMs,
    });
    return;
  }
  const declaredHosts = new Set<string>();
  for (const row of rows) {
    try { declaredHosts.add(new URL(row.url).hostname); } catch { /* 上游脏 URL：无法声明 host */ }
  }
  const candidates: AdmissionCandidate[] = [];
  const surveyRejected: AdmissionCandidate[] = [];
  for (const row of rows) {
    const source = row.source as RawSource;
    (selectCandidates([source]).length === 1 ? candidates : surveyRejected).push({ url: row.url, source });
  }
  try {
    // 既有行按**全部**本轮源读（不只候选）：初筛不过的源若留着 compile_ok 的旧行（41-srcfix G5：规则改到
    // 过不了初筛），要把它送回批次改判出池，见下。只回已有准入行（≈候选规模），不读 source 大列。
    const existing = await readAdmissionRows(s, rows.map((row) => row.url), signal);
    // G5 冻结行：初筛不过的源本不进评估环，其既有 compile_ok 行（ok 或未测）就再没人复核——池 JOIN 仍命中，
    // 新规则（可能带 JS/POST）以 ok 身份留池。补送进批次：compileAdmission 第一步即 survey 初筛，改判
    // T7 compile_ok=false（规则未变且已在池的由 N03 祖父条款接住，与候选同一判据）；下一轮旧行已是
    // compile_ok=false ⇒ 终态去抖不再重写。这是**扩**评估环而非把候选池收窄成「只喂 compile_ok」
    // （admission.ts「严禁」注释防的是后者）：compile_ok=false 的旧行照旧不喂，上游改回合规规则时源
    // 重新过初筛成为普通候选，占位行 search_ok=null ⇒ class 0 未测优先，自动回池。
    const frozen = surveyRejected.filter((candidate) => existing.get(candidate.url)?.compile_ok === true);
    if (candidates.length === 0 && frozen.length === 0) return;
    const result = await runAdmissionBatch({
      candidates: [...candidates, ...frozen], declaredHosts, existing, fetchPage: defaultAdmissionTransport, signal,
      // espfix41：开查询不敏感对照搜索，单探最坏 = 主搜索 + 对照搜索（ADMISSION_PROBE_WORST_MS），止损按它预留。
      controlQuery: true,
      canProbe: () => !signal.aborted && budget.remainingMs > ADMISSION_PROBE_WORST_MS + WRITE_RESERVE_MS,
    });
    // 准入兼容 L4（§2.4）：每轮一行漂移计数（不建历史表；要趋势曲线再上日表，Phase 2）。
    console.log('shuyuan admission batch', {
      candidates: candidates.length,
      surveyRejectedExisting: frozen.length,
      compileOk: result.compileOk,
      compileRejected: result.compileRejected,
      grandfathered: result.grandfathered,
      probed: result.probed,
    });
    if (result.rows.length > 0) await writeAdmissionRows(s, result.rows);
  } catch (error) {
    // 准入失败只影响本轮准入（§6.3）：该批 next round 重来，刷新本身已成功。
    if (signal.aborted) return;
    console.error('shuyuan admission batch failed', {
      candidates: candidates.length,
      reason: safeReason(error),
    });
    return;
  }
  // host 集合动态化（设计 §6.1）：准入写库后重算 ok 态 host 并入运行时门；
  // DB 失败/预算中止 → 保持既有集合（fail-closed：收窄到内建，绝不放大）。
  try {
    refreshSupportedHosts(await engineHosts(signal));
  } catch (error) {
    if (signal.aborted) return;
    console.error('shuyuan supported host refresh failed', {
      reason: safeReason(error),
    });
  }
}

async function readAdmissionRows(s: Sql, urls: string[], signal: AbortSignal): Promise<Map<string, AdmissionSourceRow>> {
  const rows = await readRows<AdmissionSourceRow>(s, s`
    SELECT source_url, tier, compile_ok, core_field_mask, search_ok,
           search_verdict, search_checked_at::text AS search_checked_at, rules_hash,
           engine_semantics_version, host, error, compile_diagnostics
    FROM source_admission
    WHERE source_url IN (
      SELECT source_url FROM jsonb_to_recordset(${JSON.stringify(urls.map((source_url) => ({ source_url })))}::jsonb)
        AS q(source_url text))`, signal);
  return new Map(rows.map((row) => [row.source_url, row]));
}

export async function writeAdmissionRows(s: Sql, rows: AdmissionSourceRow[]): Promise<void> {
  // 写库前自查：行内 engine_semantics_version 必须与 rules_hash 版本前缀同源（复审 P3 单一真源，
  // 与 scripts/seed-admission.mjs 共用同一判据）。错配即抛、整批不落库，暴露上游口径分裂。
  assertAdmissionVersionConsistent(rows);
  await s`
    INSERT INTO source_admission
      (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash,
       engine_semantics_version, host, error, compile_diagnostics)
    SELECT source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash,
           engine_semantics_version, host, error, compile_diagnostics
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS t(source_url text, tier text, compile_ok boolean, core_field_mask jsonb, search_ok boolean,
           search_verdict text, search_checked_at timestamptz, rules_hash text,
           engine_semantics_version integer, host text, error text, compile_diagnostics jsonb)
    ON CONFLICT (source_url) DO UPDATE SET
      tier = EXCLUDED.tier, compile_ok = EXCLUDED.compile_ok, core_field_mask = EXCLUDED.core_field_mask,
      search_ok = EXCLUDED.search_ok, search_verdict = EXCLUDED.search_verdict,
      search_checked_at = EXCLUDED.search_checked_at, rules_hash = EXCLUDED.rules_hash,
      engine_semantics_version = EXCLUDED.engine_semantics_version,
      host = EXCLUDED.host, error = EXCLUDED.error, compile_diagnostics = EXCLUDED.compile_diagnostics`;
}
