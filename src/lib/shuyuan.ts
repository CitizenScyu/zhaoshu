import { getSql } from '@/lib/db';
import { engineHosts, normalizeUrlSql } from '@/lib/supported-sources-server';
import { isRecord } from '@/lib/sanitize';
import { createDeadline, raceDeadline, type RequestDeadline } from '@/lib/deadline';
import { validateSourceUrl, refreshSupportedHosts, supportedHostList, supportedHostVersion, upgradeSourceTemplateUrl, isForbiddenHostAddress, isPermanentlyDisabledUrl, permanentDisableHostList, stationKeyOfUrl } from '@/lib/source-policy';
import { engineSourceUsable } from '@/lib/source-usability';
import {
  BUILTIN_SOURCE_HOSTS, builtinUrlPrefixes,
  builtinSourceForHost, isActiveBuiltinHost, type SupportedSourceTier,
} from '@/lib/supported-sources';
import {
  ADMISSION_MAX_REDIRECTS, ADMISSION_MIN_BUDGET_MS, ADMISSION_PHOENIX_OK_PREFIX, ADMISSION_PROBE_WORST_MS,
  admissionReadabilityShadowMax, assertAdmissionVersionConsistent, defaultAdmissionTransport, rulesHash, runAdmissionBatch,
  type AdmissionCandidate, type AdmissionSourceRow,
} from '@/lib/rule-engine/admission';
import { admissionSurveyOptions, engineSearchJsActive, selectCandidates, type RawSource } from '@/lib/rule-engine/compile-smoke';
import { prepareSearchJs, SearchJsNotReadyError } from '@/lib/rule-engine/search-js';
import { DEFAULT_SHUYUAN_READ_CACHE_TTL_MS, shuyuanReadCacheTtlMs } from '@/lib/read-cache-ttl';
import { adultStationKeys, classifySourceAdult, type SourceAdultClassification } from '@/lib/source-adult-classification';
import { isPaywallHost } from '@/lib/source-host-health';
import {
  createPoolArtifact, currentPoolArtifact, noteLocalPoolWrite, poolArtifactEnabled, resetPoolArtifactMemo,
  writePoolArtifactFile, type PoolArtifact, type PoolArtifactEngineRow, type PoolArtifactSourceRow,
} from '@/lib/pool-artifact';
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
// 只跟最新 N 个合集。3→5（2026-10-12 池塌缩修复）：上游合集滑动把已准入 ok 源（sfacg/faloo/chuangshi 等）
// 挤出 shuyuan_sources 整表替换窗口 ⇒ engineHosts 孤儿过滤把 58 个 host 踢出阅读池门（73→13）。
// 拉入 1304（精选）实测多 +119 形态筛通过候选 / +73 新 host，且能救回 36 个孤儿 host。
export const LATEST_COUNT = 5;
// srcfeed：额外上游合集直链（分号分隔；仅存「裸 JSON 数组」链接：直接 fetch 解析为 bookSource 数组）。
// 缺省/空白项/非法 URL（非 https）一律丢弃 ⇒ 缺省值下与「仅 yckceo」逐字同行为（零行为变化门禁）。
// 例：shidahuilang good.json、aoaostar legado 每日镜像（取值只进 .env，不进代码）。
export const SHUYUAN_MAX_EXTRA_FEEDS = 8;

// srcfeed：feed 失败条目的统一形状（reason 已脱敏为 host 级，见 safeReason 同款纪律）。
export type ExtraFeedFailure = { feed: string; reason: string };

/**
 * 解析 SHUYUAN_EXTRA_FEEDS：分号分隔、trim、去空白项；每项必须是规范 https URL——
 * 这里拦的只是一眼非法的 env 错填（协议非 https 或 URL 无法解析），**不替代**源级门卫
 * （源地址入池后照旧过 validateSourceUrl/checkSourceUrl 同一把锁，feed 端 host 白名单靠
 * fetchText 的 redirect 白名单约束跳转方向、靠环境侧只填已知上游约束内容来源）。
 * 缺失/全空 ⇒ [] ⇒ 缺省行为逐字不变。
 */
export function shuyuanExtraFeeds(
  env: Record<string, string | undefined> = process.env,
): { urls: string[]; invalid: string[] } {
  const raw = env.SHUYUAN_EXTRA_FEEDS;
  if (!raw) return { urls: [], invalid: [] };
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const item of raw.split(';')) {
    const url = item.trim();
    if (!url) continue;
    let parsed: URL;
    try { parsed = new URL(url); } catch { invalid.push(url); continue; }
    // feed 本身只允许 https（不含 userinfo / 非 443 / 裸 IP——这几类是源级门卫的口径，
    // 这里只做协议层粗筛，防止把 http/ftp 等一眼错认的条目放进拉取列表）。
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
        || parsed.port !== '' || isForbiddenHostAddress(parsed.hostname)) {
      invalid.push(url);
      continue;
    }
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= SHUYUAN_MAX_EXTRA_FEEDS) break;
  }
  return { urls, invalid };
}
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
// 42-admbudget：独立准入轮（/api/shuyuan/admission，现为冷备路由——vercel.json 的独立轮 cron
// 已删，调度以 phoenix timer 为准，现网准入是 admrunner42 runner，见 deploy/phoenix/README.md）自带的整份预算。
// 路由 maxDuration=295s；读源表 + 批次 + 写回 + 刷 host 门 + 发布源池产物都在本预算内，留 55s 给 ensureSchema、
// 租约与平台余量。批次内 canProbe 照旧按 ADMISSION_PROBE_WORST_MS + WRITE_RESERVE_MS 逐探止损。
export const ADMISSION_ROUND_BUDGET_MS = 240_000;
// 准入租约时长：须 ≥ 任一持有者的最长存活（独立轮路由 295s、刷新尾部 ≤ REFRESH_BUDGET_MS），持有者被平台杀掉
// 也最迟到期自动释放；不主动释放（两处触发相隔 12h，5 分钟租约不会挡住下一轮）。
// admrunner42：本值只是**默认**；phoenix runner 轮预算更长（40 探并发 4，最坏 ~10 分钟），其 systemd 单元经
// env ADMISSION_LEASE_TTL_MS 调到 900000（≥ 单元 WATCHDOG_MS）。Vercel 不设该 env ⇒ 默认值，行为不变。
export const ADMISSION_LEASE_TTL_MS = 300_000;
/** 准入租约 TTL（admrunner42）：env `ADMISSION_LEASE_TTL_MS` 正整数即用，缺失/非法回默认 ADMISSION_LEASE_TTL_MS。 */
export function admissionLeaseTtlMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.ADMISSION_LEASE_TTL_MS ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : ADMISSION_LEASE_TTL_MS;
}
// 租约借 cron_health 一行（不改 schema）：last_success_at 存的是**租约到期时刻**，不是成功时刻——
// 与 db-quota.ts 的 db_quota_exceeded 行同一借用法；readCronSuccessTimes 只认已知行名，不受影响。
export const ADMISSION_LEASE_ROW = 'admission_lease';

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
  adultClassification: SourceAdultClassification;
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
 * 阅读引擎源开关：未设或trim后为空时默认开启；1/true/on开启，其余值保守关闭。
 * 显式0/false/off关闭引擎入池，仍保留注册、准入、usable及READING_POOL_LIMIT约束。
 * 关闭后仅保留合格活跃builtin；builtin全部退休时允许空池，不恢复退休源。
 */
export function engineSourcesEnabled(): boolean {
  const raw = process.env.READING_ENGINE_SOURCES?.trim().toLowerCase();
  return raw === undefined || raw === '' || raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * 42-admbudget 开关 ADMISSION_OWN_CRON：开时 /api/shuyuan/admission 每天独立跑一轮准入（自带整份预算），
 * 刷新尾部准入与它共用同一把租约（ADMISSION_LEASE_ROW）防并发重复探测。默认关：独立轮路由空转返回。
 * admlfix42：刷新尾部**始终**参与租约（与本开关解耦），本开关只管独立 HTTP 入口的启停。
 * 只有显式1/true/on才开；开启值同阅读引擎开关，但本开关仍默认关闭。
 */
export function admissionOwnCronEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.ADMISSION_OWN_CRON?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * 下载池扩池开关 DOWNLOAD_POOL_INCLUDE_PHOENIX_OK：开时下载腿额外纳入 phoenix_ok: 行/host
 * （阅读池口径不变，仍排除）。只有显式 1/true/on（忽略大小写）才开；缺省/其它一律关 = 零行为变化。
 * 读取点: src/lib/shuyuan.ts（downloadPoolIncludesPhoenixOk）。
 */
export function downloadPoolIncludesPhoenixOk(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_POOL_INCLUDE_PHOENIX_OK?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * runner 准入轮是否仍给 ok 结论打 phoenix_ok: 前缀（admgate1026）。2026-10 起 web 与确认轮都在 phoenix 本机，
 * 「phoenix 探 ok、等 Vercel 出网再确认」这道门已无意义，只让新源晚 20h 入池，默认关：runner 直接写干净 ok。
 * 显式 1/true/on 才回旧行为（回滚开关）。关闭后 admchurn42 的「runner 跳过在池 ok 行」也随之不生效——
 * 那条过滤防的是前缀把在池行降级，不打前缀就没有降级，在池行复核照常（首败记 strike、不出池）。
 * 存量 phoenix_ok: 行无需清库：class 1 到期后被 runner 复测，ok 即洗白进池；成人源本就不进评估环、也不进池。
 */
export function admissionRunnerPhoenixOkPrefix(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.ADMISSION_RUNNER_PHOENIX_OK?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * stnredir1030：池可达性探测放行同站跳转（PROBE_SAME_STATION_REDIRECT）。fetchText 的跳转白名单只认 jsdelivr，
 * 源首页 apex→www / www→apex 这类同站 301 也被判「非受信主机」，连败 3 次标 failed 出池——生产实测 suduguu.com
 * （正文规则可用的那份）因此出池，下载线只剩 www 那份正文取空的源。开时探测（且只有探测）额外放行：目标过
 * validateSourceUrl（https、非内网字面量、host 在运行时门内）且与源同站键（stationKeyOfUrl，www./m. 归 apex）。
 * 只有显式 1/true/on（忽略大小写）才开；缺省/其它一律关 = 零行为变化。合集 JSON 抓取不受影响。
 */
export function probeSameStationRedirect(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.PROBE_SAME_STATION_REDIRECT?.trim().toLowerCase();
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
 * kill switch 约束**：READING_ENGINE_SOURCES默认开；显式关闭后只剩合格活跃builtin（可为空）。
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
  const eligible = await eligibleReadingSources(signal, engineSourcesEnabled());
  // builtin 全部排在引擎源之前（§2.4 首键），故 slice 上限作用在合并序列上即等价于
  // 「先取满 builtin、再按引擎源全序补位」——builtin 永远不会被引擎源挤出池。
  const sources = traversalOf(eligible);
  return {
    sources,
    enginePoolSize: sources.filter((source) => source.tier !== undefined && source.tier !== 'builtin').length,
    poolCandidates: Math.max(0, eligible.length - sources.length),
  };
}

/**
 * 自动遍历的取书池切片（getReadingPool 与 getSourcePools.traversal 共用，二者逐条相同）。
 *
 * 同站去重（41-srcfix）：引擎源按 bookSourceUrl 的 hostname 只留全序里最靠前的一份（reachable → tier →
 * search_checked_at 最新）。同站多副本（合集里同一站的多份规则，如 sma.yueyouxs.com 6 份）同一轮 cron 测完、
 * checked_at 挨着，会整段排在池首，把 READING_POOL_LIMIT 个名额占成同一个站——站挂了或没这本书，自动遍历一次
 * 全白跑。selectable（用户点选/章节续读认当前源）不去重，已在读某个副本的用户照样反查得到它（去重选中的副本
 * 会随复核时间戳换人，放进反查范围就会让在读用户被迫换源）。扇出候选另有同口径去重（fanoutOf，41-swq）。
 * 只在 selectable 的窗口（前 selectableSourceLimit() 条）里挑，保证 traversal ⊆ selectable：自动首开选中的源，
 * 之后章节路径一定按 selectable 认得回来。builtin 不参与（book15 零回归红线）。
 */
function traversalOf(eligible: readonly ReadingSource[]): ReadingSource[] {
  return firstPerHost(eligible.slice(0, selectableSourceLimit()), readingPoolLimit());
}

/**
 * 按全序逐条取，引擎源同站（stationKeyOfUrl：www./m./apex 算一个站，与阅读侧节流/健康/降级同一站键）
 * 只留第一份，取满 limit 即停；builtin 不参与去重。
 * traversalOf 与 fanoutOf 共用。
 */
function firstPerHost(sources: readonly ReadingSource[], limit: number): ReadingSource[] {
  const seenStations = new Set<string>();
  const out: ReadingSource[] = [];
  for (const source of sources) {
    if (out.length >= limit) break;
    if (source.tier !== 'builtin') {
      const station = stationKeyOfUrl(source.url);
      if (seenStations.has(station)) continue;
      seenStations.add(station);
    }
    out.push(source);
  }
  return out;
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
  // fail-closed）且本次降级活跃builtin。开关显式关闭时不碰引擎门、也不查引擎准入表。
  // 这条「刷门必须排在 readMeta 之前」的不变量在**刷新路径**同样成立（且更严重）：refreshWithinBudget
  // 的 readMeta 与探测入队都用 canProbe，冷启动不先刷门会把整批引擎源静默滤出探测队列，见该处注释。
  const engineOk = includeEngine ? await refreshEngineHostGate(signal) : false;
  const { states } = readMeta((await poolProbeMeta(s, signal)).collections);
  const builtin = await builtinReadingSources(s, states, signal);
  // 运行时用不了的引擎源（搜索模板过不了 host 门/动态规则，或必需字段编译不过；判据见 source-usability，与 probe 的
  // compile_failed 同一处）在进池前筛掉：不占取书池/扇出名额、不占 selectable 窗口、也不占同站去重位——同站后面能用
  // 的那份照样选得上。准入表的 compile_ok/search_ok 是准入当时的结论，与运行时 host 门可能不一致（41-swq 实测：sfacg
  // 两条规则的 searchUrl 指向门外的 m.sfacg.com，准入记 search_ok，去重腾出名额后补进扇出，每次 probe 必 compile_failed）。
  // 必须在上面刷门之后筛。这类源搜不出书，也就不会有用户在读它，从 selectable 里拿掉不影响在读。
  // searchjs1027：需 JS 的搜索模板在可用性判定里同步求值，先载入沙箱。
  if (engineOk && engineSearchJsActive()) await prepareSearchJs();
  const engine = engineOk ? (await engineSourcesIncremental(s, states, signal)).filter(engineSourceUsable) : [];
  return [...builtin, ...engine];
}

/**
 * 扇出开关（41-fanout 第一期）：浏览器逐源并发 probe 的服务端入口 `/api/read/source-probe`。
 * **默认关闭**；只有显式 `1`/`true`/`on` 才开。开启值同阅读引擎开关，默认值不同。关闭时路由返回404。
 */
export function sourceFanoutEnabled(): boolean {
  const raw = process.env.SOURCE_FANOUT_ENABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** 每批扇出候选上限默认 24（legado-arch-41 C.3），硬上限 60：env 误配不得把一批换源放大成对上百个站的扫描。 */
export const DEFAULT_SOURCE_FANOUT_LIMIT = 24;
export const MAX_SOURCE_FANOUT_LIMIT = 60;

/** 每批扇出候选上限：env `SOURCE_FANOUT_LIMIT`；非法/≤0/缺失回退默认，合法值夹到 MAX。与 READING_POOL_LIMIT 解耦。 */
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
 * 与取书池同一份合成与全序。引擎源**不受** READING_ENGINE_SOURCES 约束（扇出由 SOURCE_FANOUT_ENABLED 单独把门，
 * 调用方先判开关）；为此这里总会按准入表刷一次 host 门——与取书池开引擎源时同一数据源。
 * adultsrc42：成人源在 engineReadingSources 侧已被分类器滤出，扇出候选天然不含成人源。
 *
 * **返回同站去重后的完整全序（不截断）**：fanbatch42「换一批」翻页由 route 按 batch 切片（每批 ≤
 * sourceFanoutLimit()，默认 24），单源 probe 的反查也在全序上做——否则第 2 批起的面板行点了必 404
 * SOURCE_PROBE_UNKNOWN_SOURCE。自动换源（findFirstSwitchableSource）不带 batch 参数 ⇒ 默认批 0 = 改前的前 24。
 *
 * readable：确认路径（index?book_url=）与章节路径按 getSourcePools().selectable 反查源（41-readall）——
 * 扇出候选全部落在其内（selectable 并入全量去重序），故 readable 只看开关：引擎开关关时引擎源仍是「仅展示」（面板 unreadable）。
 */
export async function getFanoutPool(signal: AbortSignal): Promise<FanoutSource[]> {
  const eligible = await eligibleReadingSources(signal, true);
  const engineOn = engineSourcesEnabled();
  return fanoutDeduped(eligible).map((source) => ({
    ...source,
    readable: selectableTier(source, engineOn),
  }));
}

/**
 * 扇出候选全序（41-swq 同站去重，fanbatch42 改为不截断）：引擎源按 bookSourceUrl 的 hostname 只留全序里
 * 最靠前的一份。选哪一份 = §2.4 全序本身（probe reachable → tier M1 先于 T7 → search_checked_at 最新 →
 * host_ok_score_24h → url），与 traversalOf 同口径。改前按 sourceFanoutLimit() 截断，「换一批」上线后截断
 * 挪到 route 按批切片（翻页翻到的任何一批都可达，须可被确认路径反查）；批 0 与改前的候选集逐条相同，
 * 旧前端不带 batch 参数照拿前 24，零回归。builtin 不参与（book15 零回归红线）。
 */
function fanoutDeduped(eligible: readonly ReadingSource[]): ReadingSource[] {
  return firstPerHost(eligible, eligible.length);
}

/**
 * 用户显式指定源时的反查范围（类型标记）：只有 getSourcePools 产出。确认路径与章节续读认当前源的查找函数要求这个类型，
 * 取书池（自动遍历用）传进去编译不过——「按池反查源」的调用点改一处漏一处，是本项目反复出现的模式（41-readall）。
 */
export type SelectableSources = readonly ReadingSource[] & { readonly __selectableSources: true };

/**
 * 反查范围的前缀窗口：全序前 max(取书池, 扇出) 条。扇出全序（fanbatch42 不截断）整条并入 selectable——
 * 任何一侧能展示/遍历/翻页到的源，用户点选都认。
 */
export function selectableSourceLimit(): number {
  return Math.max(readingPoolLimit(), sourceFanoutLimit());
}

export interface SourcePools {
  /** 自动遍历（无指定源的首开 / 章节级兜底换源）：traversalOf（同站去重后按 readingPoolLimit() 截断），与 getReadingSources 逐条相同。 */
  traversal: ReadingSource[];
  /** 用户显式指定源的反查范围：同一序列前 selectableSourceLimit() 条 ∪ 扇出选中项（保持全序）、再按开关过滤（见 selectableTier）；不去重。 */
  selectable: SelectableSources;
}

/**
 * 一次合成同时给出两份池（41-readall）：traversal ⊆ selectable（同一全序、同一窗口，traversal 再做同站去重），章节路径一次 DB 往返拿齐。
 * 扇出候选 ⊆ selectable（41-swq / fanbatch42）：扇出全序不再截断——「换一批」能翻到的每一批都必须被确认路径认得，
 * 故 selectable 并入**全量**同站去重序（fanoutDeduped），不只是前缀窗口。去重补位越窗的源照旧认得（改前语义）。
 * includeEngine与取书池同口径（READING_ENGINE_SOURCES）：显式关闭时不刷引擎host门、不查引擎准入表，selectable只剩合格活跃builtin（可为空）。
 */
export async function getSourcePools(signal: AbortSignal): Promise<SourcePools> {
  const engineOn = engineSourcesEnabled();
  const eligible = await eligibleReadingSources(signal, engineOn);
  const window = selectableSourceLimit();
  const fanout = new Set(fanoutDeduped(eligible));
  return {
    traversal: traversalOf(eligible),
    selectable: eligible.filter((source, index) => (index < window || fanout.has(source))
      && selectableTier(source, engineOn)) as unknown as SelectableSources,
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
async function refreshEngineHostGate(signal: AbortSignal, fresh = false): Promise<boolean> {
  try {
    // xfer41：池合成路径走读缓存（TTL 内复用上次的 host 集合，仍每次重刷门——幂等、零 DB）；
    // 刷新路径传 fresh=true 直读，探测入队要用最新准入态。
    if (fresh) {
      refreshSupportedHosts(await engineHosts(signal));
      return true;
    }
    // 41-xferfix B1：门被缓存之外改过则先作废缓存（见 syncReadCacheWithGate），再按缓存 host 集刷门并记下快照。
    return await publishCurrentHostRead(signal);
  } catch (error) {
    signal.throwIfAborted();
    console.error('shuyuan engine host gate refresh failed, falling back to builtin only', {
      reason: safeReason(error),
    });
    return false;
  }
}

/**
 * 内建（builtin）档条目：改查注册表内建 URL 前缀，不再硬编码 ILIKE 字面量。
 *
 * 活跃性两道门，退休判定优先级最高（高于 DB enabled=true、probe reachable、缓存）：
 * 1. **静态生命周期**（isActiveBuiltinHost）：retired host 的行（含源池产物缓存里的旧行）
 *    一票出局——不因「库里还有行/行 enabled/探测可达」复活。
 * 2. disabled_at / source.enabled === false / probe failed 的行照旧剔除（既有语义）。
 *
 * 合集没有任何活跃 builtin host 记录时返回**空段**，不补造注册表默认源——活跃内建源必须经
 * 显式注册/启用进池；删除记录不构成隐式启用信号。空段是合法结论：调用方走活跃引擎源或有限失败。
 */
async function builtinReadingSources(
  s: Sql, states: Map<string, ProbeState>, signal: AbortSignal,
): Promise<ReadingSource[]> {
  const rows = (await cachedRead('builtinRows', signal,
    (sig) => artifactOr((artifact) => artifact.builtin, () => readBuiltinRows(s, sig))))
    .filter((row) => isActiveBuiltinHost(hostOfUrl(row.source_url)) && canProbe(row.source_url));
  if (!rows.length) return [];
  return rows.filter((row) => !row.disabled_at && isRecord(row.source) && row.source.enabled !== false && states.get(row.source_url)?.status !== 'failed')
    .sort((a, b) => probeRank(states, b.source_url) - probeRank(states, a.source_url)
      || a.source_url.localeCompare(b.source_url))
    .map((row) => {
      // 行已过 isActiveBuiltinHost，注册表条目必存在；仍不造非空断言，缺档时用行自身信息兜底。
      const entry = builtinSourceForHost(row.source_url);
      return {
        url: validateSourceUrl(row.source_url).href, name: row.name.slice(0, 200) || entry?.name || row.source_url,
        searchUrl: row.source.searchUrl ?? entry?.searchUrl ?? '', rules: row.source, tier: 'builtin' as const,
      };
    });
}

/** 请求许可：静态活跃只负责识别，必须再命中当前合格注册记录；不补造默认源。 */
export async function getBuiltinRequestSource(host: string, signal: AbortSignal): Promise<ReadingSource | null> {
  signal.throwIfAborted();
  const entry = builtinSourceForHost(host);
  if (!entry || !isActiveBuiltinHost(host)) return null;
  try {
    const s = getSql();
    syncReadCacheWithGate();
    const { states } = readMeta((await poolProbeMeta(s, signal)).collections);
    const sources = await builtinReadingSources(s, states, signal);
    signal.throwIfAborted();
    return sources.find((source) => builtinSourceForHost(hostOfUrl(source.url))?.url === entry.url) ?? null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

/** builtin 候选行（注册表内建 URL 前缀，不再硬编码 ILIKE 字面量）；池合成与产物生成共用同一查询。 */
function readBuiltinRows(s: Sql, signal?: AbortSignal): Promise<PoolArtifactSourceRow[]> {
  const patterns = builtinUrlPrefixes().map((prefix) => `${prefix}%`);
  return readRows<PoolArtifactSourceRow>(s, s`
    SELECT source_url, name, source, disabled_at::text AS disabled_at, last_error
    FROM shuyuan_sources
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(patterns)}::jsonb) AS p(pattern)
      WHERE source_url ILIKE p.pattern)
    ORDER BY source_url`, signal);
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
  s: Sql, states: Map<string, ProbeState>, signal: AbortSignal, includePhoenixOk = false,
): Promise<ReadingSource[]> {
  // includePhoenixOk=true（下载池扩池，DOWNLOAD_POOL_INCLUDE_PHOENIX_OK=1）时不走源池产物，直读 DB 纳入 phoenix_ok: 行；
  // false（默认）保持现文本逐字不变（产物优先、失败回退库）。
  const rows = includePhoenixOk
    ? await cachedRead('engineRowsDownload', signal, (sig) => readEngineRows(s, sig, true))
    : await cachedRead('engineRows', signal,
      (sig) => artifactOr((artifact) => artifact.engine, () => readEngineRows(s, sig)));
  // 41-srcfix 改法2：库键 source_url 仍是上游原样（http:// 源不改键，source_admission 不会出新旧两行），
  // 运行时身份 url 取升 https 后的形态——搜索基址、目录/正文相对链接、目录缓存 sourceUrl 全部由它派生，
  // 所以 http 源的每个请求都走 https。只改 scheme，过的仍是同一把 validateSourceUrl 锁。
  // 同一站点合集里常同时收录 http:// 与 https:// 两份（1522 源里 57 对），升级后 url 撞车会让按 url 反查源
  // 歧义：撞车时留库键本就是 https 的那份（与改前的池逐条相同），http 副本让位。
  const native = new Set(rows.map((row) => row.source_url).filter((url) => upgradeSourceTemplateUrl(url) === url));
  // adult1026：同站传染——同站键下任一源判 adult，整站出池（防同站换个没打标的名字漏网）。
  const adultStations = adultStationKeys(rows, (row) => classifySourceAdult(row.name, row.source),
    (row) => stationKeyOfUrl(row.source_url));
  return rows
    .filter((row) => classifySourceAdult(row.name, row.source) === 'unmarked'
      && !adultStations.has(stationKeyOfUrl(row.source_url))
      // paywall1026：付费墙 host 搜索恒命中、正文只有 VIP 预览——下载侧早已全局排除，换源池同口径出池。
      && !isPaywallHost(hostOfUrl(upgradeSourceTemplateUrl(row.source_url)))
      && canProbe(upgradeSourceTemplateUrl(row.source_url)) && !row.disabled_at && isRecord(row.source)
      && row.source.enabled !== false && states.get(row.source_url)?.status !== 'failed'
      && (upgradeSourceTemplateUrl(row.source_url) === row.source_url
        || !native.has(upgradeSourceTemplateUrl(row.source_url))))
    .sort((a, b) => probeRank(states, b.source_url) - probeRank(states, a.source_url)
      || tierRank(a.tier) - tierRank(b.tier)
      || checkedAtMs(b.search_checked_at) - checkedAtMs(a.search_checked_at)
      // hostbucket42：前面 §2.4 三键（probe/tier/checked_at）全等时，host_ok_score_24h 降序作 tie-break：
      // 同 host 最近 24h 至少有 non-phnx 干净 ok 副本的源排前（同 host 全 phnx/全失败/从未合规各归位同分）。
      // 分相等（0/0 或 1/1）时落回 url 升序 —— 不会改变任何一对前三键已形成严格差的源对, 只打同分双打。
      || (b.host_ok_score_24h ?? 0) - (a.host_ok_score_24h ?? 0)
      || a.source_url.localeCompare(b.source_url))
    .map((row) => ({
      url: validateSourceUrl(upgradeSourceTemplateUrl(row.source_url)).href,
      name: (typeof row.name === 'string' ? row.name.slice(0, 200) : '') || hostOfUrl(row.source_url),
      searchUrl: typeof row.source.searchUrl === 'string' ? row.source.searchUrl : '',
      rules: row.source,
      tier: (row.tier === 'T7' ? 'T7' : 'M1') as SupportedSourceTier,
    }));
}

/**
 * urlfix：URL 形态归一化的共享 SQL 片段定义在 supported-sources-server.ts 的 normalizeUrlSql
 * （取书池 JOIN 与 host 门共用一处，避免两处漂移）。此处只消费，不重复定义。
 */

/** 引擎候选行：shuyuan_sources JOIN source_admission ok 态；池合成与产物生成共用同一查询。
 * admrunner42：phoenix_ok: 行（runner 探 ok、Vercel 未确认）不入池——谓词与 supported-sources.ts engineHosts、
 * readAdmissionFunnel 的 ok 桶同款。
 * hostbucket42：LEFT JOIN source_admission 24h 聚合(host_ok_score_24h)——「同 host 最近 24h 内是否有 non-phnx 干净 ok」
 *   二值分。只在 eligibleReadingSources.TS 侧排序用作 tie-break（probe → tier → checked_at → host_ok_score → url），
 *   列本身只读透传、不参与 WHERE/JOIN 谓词 → 现网读池条目不增减，只是排序微调（§2.4 前 3 键全等时由它断同）。
 *   pg 侧聚合按本查询时间窗重算，产物缓存 36h 窗口内会带到下次刷新（Vercel 06:00 cron）才过期——可接受，
 *   此窗正是 hostbucket 想要的「最近 24h 干净 ok」语义的一部分；排序键等价物即 admittedAt 情况不变。
 * urlfix：JOIN 条件从纯字符串等值放宽为「精确等值 OR（归一化等值 AND 同条目判据 AND 供判行是旧形态孤儿）」：
 *   - 归一化等值：两侧 URL 形态不同（#/#🎃 后缀）时仍能配上；
 *   - 同条目判据 `norm(src.source->>'bookSourceUrl') = norm(a.source_url)`：admission 结论必须来自**本条目**的
 *     bookSourceUrl，绝不让跨条目源拿别家结论进池（准入是唯一规则安全闸，legado 规则可含任意 JS/CSS/正则）；
 *   - 旧形态孤儿 `NOT EXISTS(精确键在表)`：真实库里 source_url 恒 = norm(bookSourceUrl)，单靠上两条在真实数据上会
 *     退化成「纯归一化相等」，分不开「同条目旧形态」与「host 相同但另一条目」——biquge001 型反例判据恒等放行。
 *     这一条才把前者（救回 urlsuffix §1b 的 15 条）与后者（挡住 §1c 跨条目）区分开。
 * LATERAL + LIMIT 1 保证每条规则行至多配一条 admission 行（同 host 新旧键并存时**精确等值优先**），不膨胀。
 *
 * engsql45：三段判据一个没动，只改**计算方式**。原写法把归一化塞在 LATERAL 的 `OR` 里，优化器无法用
 *   `source_admission_source_url_key` 索引，只能对 5847 源 × 363 ok 行逐对做两层 regexp_replace + jsonb 抽取
 *   （生产只读实测 3.8–9.5 秒，冷缓存/有负载时 `EXPLAIN (ANALYZE)` Execution Time 33.0–54.5 秒）。这条查询长期占住 shim 连接池（POOL_MAX=15）的槽，
 *   3–4 个并发就把池占满 → 下载 worker 拿不到连接 → shim 返 503 → 任务 failed / 批次变僵尸 / done 停摆。
 *   改法：`OR` 的归一化分支只在「供判行是旧形态孤儿」时才可能命中，而孤儿 ok 行生产实测只有 25 行
 *   （includePhoenixOk=true；false 时 9 行）。于是先把孤儿集合**物化**出来（`orphan_ok`），
 *   让它按归一化键与源表做等值 hash join（`orphan_match`，实测命中 55 行），再让结果参与 LATERAL 的等值分支：
 *     精确分支  ad.source_url = k.source_url        → 仍走 source_admission_source_url_key 索引
 *     孤儿分支  om.id = k.id（orphan_match 已算好） → 扫 ≤55 行的物化集合
 *   两分支 UNION ALL 后仍按 `is_exact DESC, search_checked_at DESC NULLS LAST` 取 LIMIT 1 ＝ 原全序
 *   （原 ORDER BY 的 `(ad.source_url = src.source_url)` 在孤儿分支恒为 FALSE：孤儿定义就是精确键不在表，
 *   而 src.source_url 在表 ⇒ 两分支互斥，`is_exact` 与它逐行同值；生产实测同时命中两分支的对数 = 0）。
 *   贵的 jsonb 归一化（`source->>'bookSourceUrl'`）只对 hash join 命中的 ≤55 行算，不再对 5847 行全算。
 *   宽列（name/source/…）最后按主键回表，只取命中行。生产只读交替 A/B 实测（同连接、旧新交替、active_backends=0–1）：
 *   includePhoenixOk=false 3941/3803 ms → 42.9/45.5 ms，true 7414/9476 ms → 75.5/91.3 ms；
 *   EXPLAIN (ANALYZE) Execution Time false 33024 ms → 54 ms、true 54461 ms → 80 ms。
 *   两侧结果集在生产只读逐行逐列全等（行数 112/351、双向 EXCEPT ALL = 0、有序全列摘要同串、逐行 FULL OUTER JOIN
 *   mismatched_rows = 0）。
 *   CTE 里新增的四个（src_nurl / orphan_ok / orphan_match / hit）全部显式 MATERIALIZED：
 *   默认内联会让优化器把归一化重新推回嵌套循环——同一份 SQL 只把 src_keys 的 `MATERIALIZED` 换成
 *   `NOT MATERIALIZED`，实测 137–164 ms → 30906–32172 ms（约 220 倍）。 */
function readEngineRows(s: Sql, signal?: AbortSignal, includePhoenixOk = false): Promise<PoolArtifactEngineRow[]> {
  return readRows<PoolArtifactEngineRow>(s, s`
    WITH recent_per_url AS (
      SELECT source_url,
             MAX(CASE WHEN search_ok AND error NOT LIKE 'phoenix_ok:%' THEN 1 ELSE 0 END)::int AS has_clean_recent
      FROM source_admission
      WHERE search_checked_at > NOW() - INTERVAL '24 hours'
      GROUP BY source_url
    ), src_nurl AS MATERIALIZED (
      SELECT s0.id, s0.source_url, ${s.unsafe(normalizeUrlSql('s0.source_url'))} AS n_url
      FROM shuyuan_sources s0
    ), orphan_ok AS MATERIALIZED (
      SELECT ad.source_url, ad.tier, ad.search_checked_at,
             ${s.unsafe(normalizeUrlSql('ad.source_url'))} AS n_url
      FROM source_admission ad
      WHERE ad.compile_ok AND ad.search_ok IS TRUE
        AND (${includePhoenixOk}::boolean OR ad.error IS NULL OR ad.error NOT LIKE 'phoenix_ok:%')
        AND NOT EXISTS (SELECT 1 FROM shuyuan_sources s2 WHERE s2.source_url = ad.source_url)
    ), orphan_match AS MATERIALIZED (
      SELECT k.id, o.tier, o.search_checked_at
      FROM src_nurl k
      JOIN orphan_ok o ON o.n_url = k.n_url
      JOIN shuyuan_sources s1 ON s1.id = k.id
      WHERE o.n_url = ${s.unsafe(normalizeUrlSql("s1.source->>'bookSourceUrl'"))}
    ), hit AS MATERIALIZED (
      SELECT k.id, a.tier, a.search_checked_at
      FROM src_nurl k
      JOIN LATERAL (
        (SELECT ad.tier, ad.search_checked_at, TRUE AS is_exact
         FROM source_admission ad
         WHERE ad.compile_ok AND ad.search_ok IS TRUE
           AND (${includePhoenixOk}::boolean OR ad.error IS NULL OR ad.error NOT LIKE 'phoenix_ok:%')
           AND ad.source_url = k.source_url)
        UNION ALL
        (SELECT om.tier, om.search_checked_at, FALSE AS is_exact
         FROM orphan_match om
         WHERE om.id = k.id)
        ORDER BY is_exact DESC, search_checked_at DESC NULLS LAST
        LIMIT 1
      ) a ON true
    )
    SELECT src.source_url, src.name, src.source, src.disabled_at::text AS disabled_at, src.last_error,
           hit.tier, hit.search_checked_at::text AS search_checked_at,
           COALESCE(recent_per_url.has_clean_recent, 0) AS host_ok_score_24h
    FROM hit
    JOIN shuyuan_sources src ON src.id = hit.id
    LEFT JOIN recent_per_url ON recent_per_url.source_url = src.source_url
    ORDER BY src.source_url`, signal);
}

function hostOfUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}


/** 引擎档候选（设计 §5.2 的新增导出；M2-3 的放量/排序在此扩面）。 */
export async function getEngineSources(signal: AbortSignal): Promise<ReadingSource[]> {
  const s = getSql();
  syncReadCacheWithGate(); // 调用方（download-source）常先按鲜读刷门再来取池
  const { states } = readMeta((await poolProbeMeta(s, signal)).collections);
  return engineReadingSources(s, states, signal);
}

/**
 * 下载腿引擎源池（bpool-normalize）：DOWNLOAD_POOL_INCLUDE_PHOENIX_OK 开时额外纳入 phoenix_ok: 行
 * （直读 DB，不走源池产物）；缺省关时**逐字委托** getEngineSources，与改前逐条相同（零行为变化）。
 */
export async function getDownloadEngineSources(signal: AbortSignal): Promise<ReadingSource[]> {
  if (!downloadPoolIncludesPhoenixOk()) return getEngineSources(signal);
  const s = getSql();
  syncReadCacheWithGate();
  const { states } = readMeta((await poolProbeMeta(s, signal)).collections);
  return engineReadingSources(s, states, signal, true);
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

/**
 * stnredir1030：同站跳转判定（仅探测路径经 fetchText 的 sameStationOf 启用）。目标必须过运行时门
 * validateSourceUrl（与引擎真实取页同一把锁，不扩 SSRF 面），且站键与源 URL 相同。
 */
export function isSameStationRedirectTarget(rawLocation: string, base: string, sourceUrl: string): boolean {
  let target: URL;
  try {
    target = validateSourceUrl(new URL(rawLocation, base).href);
  } catch {
    return false;
  }
  const key = stationKeyOfUrl(sourceUrl);
  return key !== '' && stationKeyOfUrl(target.href) === key;
}

// idxretry1031：SHUYUAN_FETCH_RETRY=1 时，yckceo 索引页与合集 JSON 拉取失败（非中止/非超预算）隔
// FETCH_RETRY_DELAY_MS 重试一次。动机（2026-10-31 生产只读）：每日 10:00 cron 的索引页一次 'fetch failed'
// （~10s，undici 连接超时形态）即整轮 502，探测/准入/同站跳转放行全部顺延 24h（10-29 同类失败靠人工重跑）。
// 只重试上游拉取，不碰探测（连败计数口径不变）；缺省/其它值 = 关，零行为变化。
export const FETCH_RETRY_DELAY_MS = 3_000;
export function shuyuanFetchRetry(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHUYUAN_FETCH_RETRY?.trim() === '1';
}

async function fetchTextRetry(url: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  try {
    return await fetchText(url, timeoutMs, signal);
  } catch (error) {
    if (signal.aborted || !shuyuanFetchRetry()) throw error;
    await raceDeadline(signal, () => new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS)));
    return fetchText(url, timeoutMs, signal);
  }
}

export async function fetchText(
  url: string, timeoutMs: number, parentSignal: AbortSignal, options: { sameStationOf?: string } = {},
): Promise<string> {
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
        if (!isTrustedRedirectTarget(location, current)
          && !(options.sameStationOf && isSameStationRedirectTarget(location, current, options.sameStationOf))) {
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

// —— 池合成读缓存（xfer41：Neon 免费档 5 GB/月传输额度 09-25 耗尽，头号大户就是池合成重复读库）——
// 在线阅读每章、换源面板每个 probe、health/stats、engine-fetch 每个子命令都会重新合成一次源池：
// engineHosts + 探测快照 + builtin 行 + 引擎行（含整份规则 JSON），改前单次 ≈270–350 KB。
// 这里对这四次**只读**查询做进程内 TTL 缓存（缓存的是 DB 行，入池判定/排序每次照常在 JS 里重算）。
//
// TTL 默认 300s（env SHUYUAN_READ_CACHE_TTL_MS；0 = 关闭；非法值回落默认；上限 3600s）。取 300s 而不是 30–60s：
// 读者读一章通常要几分钟，60s 窗口下逐章请求几乎全部落空；而池数据本身一天只变一次（cron 刷新 + 准入批次），
// 人工禁用/启用与 seed-admission 也都不是秒级敏感——其他实例最多晚 TTL 看到变化。本实例内的写路径
// （refreshShuyuan 提交后、writeAdmissionRows、disable/enableShuyuanSource）一律 invalidateShuyuanReadCache()，
// 本实例读己之写不受 TTL 影响。
//
// 语义：
// - 同键并发共用一次加载（single-flight）：换源面板一次 13 个请求落到同一实例时只读一次库。
// - 加载用独立的超时信号，不绑定首个调用方的请求信号——否则首个调用方断开会让同批等待者一起失败；
//   每个调用方用自己的 signal 经 raceDeadline 等结果，中止语义对调用方不变。
// - 失败（reject）不入缓存，下个请求重读；降级分支（engineSourcesIncremental 吞错返回空集）发生在缓存之外，
//   同样不会被缓存成「空引擎池」。
// - 刷新路径（refreshWithinBudget 的 storedMeta / fresh host 门）与后台统计（getShuyuanStats/Counts）不走缓存：
//   前者要拿最新 refreshed_at 做乐观并发守卫，后者是管理面、读己之写优先。
export { DEFAULT_SHUYUAN_READ_CACHE_TTL_MS, shuyuanReadCacheTtlMs };
const READ_CACHE_LOAD_TIMEOUT_MS = 20_000;
// 41-xferfix N2：条目硬上限。固定键只有 3 个，poolProbeMeta 按门分键（门变化通常伴随整体作废，见
// syncReadCacheWithGate；但引擎开关关闭时不经该同步）——代码层兜底，超限按插入序淘汰最旧一条。
const READ_CACHE_MAX_ENTRIES = 64;

type ReadCacheEntry = { expiresAt: number; value: Promise<unknown> };
const readCache = new Map<string, ReadCacheEntry>();
/** 上次按缓存 engineHosts 刷出的门快照（refreshEngineHostGate 据此识别门被缓存之外改过）；null = 无。 */
let gateFromCache: string | null = null;
let readCacheGeneration = 0;

/**
 * 丢弃全部池合成读缓存：本实例写路径之后调用；测试之间重置也用它。
 * 41-poolimpl：同时记下「本实例刚写过库」——比这次写更早生成的源池产物本实例不再采信（回退库读直到新产物发布），
 * 保住「本实例读己之写」（产物最多晚一个生成周期，改前本实例写后立即可见）。
 */
export function invalidateShuyuanReadCache(): void {
  clearReadCache();
  noteLocalPoolWrite();
}

function clearReadCache(): void {
  readCacheGeneration += 1;
  readCache.clear();
  gateFromCache = null;
}

/**
 * 41-xferfix B1：host 门是模块级全局态，缓存之外还有写入方（download-source 按鲜读 engineHosts 刷门、cron 准入尾部）。
 * 门与上次池合成时的快照不同 ⇒ 有人读到了比缓存新的准入态：此时若沿用缓存，refreshEngineHostGate 会按旧 host 集
 * 整集重置门（把刚放行的 host 刷掉），缓存的引擎行也缺该源。故整体作废、按库实况重读，结果与未缓存时逐项相同。
 * 门未被外部改动时照常命中（稳态零额外读）。
 */
function syncReadCacheWithGate(): void {
  const gate = supportedHostList().join(',');
  if (gateFromCache !== null && gate !== gateFromCache) clearReadCache();
  gateFromCache = gate;
}

async function cachedRead<T>(
  key: string, signal: AbortSignal | undefined, load: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const ttl = shuyuanReadCacheTtlMs();
  if (ttl <= 0) return load(signal);
  signal?.throwIfAborted();
  const entry = readCacheEntry(key, ttl, load);
  const value = entry.value as Promise<T>;
  return signal ? raceDeadline(signal, () => value) : value;
}

function readCacheEntry<T>(key: string, ttl: number, load: (signal: AbortSignal) => Promise<T>): ReadCacheEntry {
  const now = Date.now();
  let entry = readCache.get(key);
  if (!entry || entry.expiresAt <= now) {
    const created: ReadCacheEntry = { expiresAt: now + ttl, value: load(AbortSignal.timeout(READ_CACHE_LOAD_TIMEOUT_MS)) };
    readCache.delete(key);
    if (readCache.size >= READ_CACHE_MAX_ENTRIES) readCache.delete(readCache.keys().next().value!);
    readCache.set(key, created);
    created.value.catch(() => { if (readCache.get(key) === created) readCache.delete(key); });
    entry = created;
  }
  return entry;
}

type HostReadOutcome = { ok: true; hosts: string[] } | { ok: false; error: unknown };
type HostReadTask = {
  sequence: number;
  entry: ReadCacheEntry | null;
  callerSignal?: AbortSignal;
  generation: number;
  version: number;
  publishedVersion?: number;
  outcome?: HostReadOutcome;
  value: Promise<HostReadOutcome>;
};
let hostReadTask: HostReadTask | undefined;
let hostReadSequence = 0;
let lastHostPublication: HostReadTask | undefined;

function currentHostTask(task: HostReadTask): boolean {
  const version = supportedHostVersion();
  const ownEarlierPublication = lastHostPublication?.publishedVersion === version
    && lastHostPublication.generation === task.generation && lastHostPublication.sequence <= task.sequence;
  return task.generation === readCacheGeneration
    && !task.callerSignal?.aborted
    && (version === (task.publishedVersion ?? task.version) || ownEarlierPublication)
    && (!task.entry ? (lastHostPublication?.sequence ?? 0) <= task.sequence
      : hostReadTask === task && (readCache.get('engineHosts') === task.entry
      // 失败清理已删除自己的 entry，并不等于出现了更新任务。
      || (!task.outcome?.ok && !readCache.has('engineHosts'))));
}

function acquireHostRead(signal: AbortSignal): HostReadTask {
  syncReadCacheWithGate();
  // 已完成的缓存结果与外部鲜读集合相同，保留 B1 的稳态命中；在途任务不能这样确认。
  if (hostReadTask?.generation === readCacheGeneration && hostReadTask.publishedVersion !== undefined
    && gateFromCache === supportedHostList().join(',')) hostReadTask.publishedVersion = supportedHostVersion();
  // 集合相同或 A→B→A 仍是外部发布，字符串快照无法区分。
  if (hostReadTask?.generation === readCacheGeneration
    && !currentHostTask(hostReadTask)) clearReadCache();
  const ttl = shuyuanReadCacheTtlMs();
  const load = (sig: AbortSignal) => artifactOr((artifact) => artifact.hosts, () => engineHosts(sig));
  const entry = ttl > 0 ? readCacheEntry('engineHosts', ttl, load) : null;
  if (entry && hostReadTask?.entry === entry && currentHostTask(hostReadTask)) return hostReadTask;
  const value = entry ? entry.value as Promise<string[]> : load(signal);
  const task: HostReadTask = {
    sequence: ++hostReadSequence,
    entry, generation: readCacheGeneration, version: supportedHostVersion(),
    callerSignal: entry ? undefined : signal,
    value: value.then(
      (hosts): HostReadOutcome => ({ ok: true, hosts }),
      (error: unknown): HostReadOutcome => ({ ok: false, error }),
    ).then((outcome) => { task.outcome = outcome; return outcome; }),
  };
  hostReadTask = task;
  return task;
}

function publishHostTask(task: HostReadTask): boolean {
  if (!currentHostTask(task) || !task.outcome?.ok) return false;
  if (task.publishedVersion === undefined) {
    refreshSupportedHosts(task.outcome.hosts);
    task.publishedVersion = supportedHostVersion();
    lastHostPublication = task;
    gateFromCache = supportedHostList().join(',');
  }
  return true;
}

async function publishCurrentHostRead(signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  let task = acquireHostRead(signal);
  // 仅允许一次后继重定位；稳定新结果可直接复用，不循环追逐持续失效。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await raceDeadline(signal, () => task.value);
    signal.throwIfAborted();
    if (currentHostTask(task)) {
      if (!outcome.ok) throw outcome.error;
      return publishHostTask(task);
    }
    if (hostReadTask && publishHostTask(hostReadTask)) return true;
    if (lastHostPublication && publishHostTask(lastHostPublication)) return true;
    if (attempt === 0) task = hostReadTask?.entry && currentHostTask(hostReadTask) ? hostReadTask : acquireHostRead(signal);
  }
  return false;
}

// —— 源池产物（41-poolimpl，设计 poolart-41-report §2）：池合成四份输入行「产物优先、失败回退库」——
// 产物只替换 DB 行的来源，入池判定/排序/去重/host 门照旧在上面的 JS 里重算；外层 cachedRead 的 TTL、single-flight、
// 失败不入缓存等语义不变。开关 SHUYUAN_POOL_ARTIFACT 默认关：关时直接走库读 loader，与改前逐字相同。

/** 产物可用 ⇒ 取其中对应的行；开关关/产物不可用（缺失/过期/损坏/早于本实例写库）⇒ 库读。 */
async function artifactOr<T>(pick: (artifact: PoolArtifact) => T, load: () => Promise<T>): Promise<T> {
  if (!poolArtifactEnabled()) return load();
  const artifact = await currentPoolArtifact();
  return artifact ? pick(artifact) : load();
}

/**
 * 引擎 host 门的鲜读入口（download-source / engine-fetch / runtime-download 刷门用）：产物优先，否则直读准入表
 * （开关关时即 engineHosts(signal)，与改前相同）。与 getEngineSources 取自同一份产物，门与池行口径一致。
 */
export async function getPoolEngineHosts(signal?: AbortSignal): Promise<string[]> {
  return artifactOr((artifact) => artifact.hosts, () => engineHosts(signal));
}

/**
 * 下载腿 host 门（bpool-normalize）：DOWNLOAD_POOL_INCLUDE_PHOENIX_OK 开时额外放行 phoenix_ok: 源的 host
 * （直读准入表，不走源池产物）；缺省关时**逐字委托** getPoolEngineHosts，与改前逐条相同（零行为变化）。
 */
export async function getDownloadPoolEngineHosts(signal?: AbortSignal): Promise<string[]> {
  if (!downloadPoolIncludesPhoenixOk()) return getPoolEngineHosts(signal);
  return engineHosts(signal, { includePhoenixOk: true });
}

/**
 * 从库合成一份源池产物（鲜读，不走缓存）：engineHosts + builtin 行 + 引擎行 + 探测快照中这些行 URL 的条目。
 * 探测快照走池合成同一条 SQL 投影（readPoolProbeMeta），门取「内建 host ∪ 本次 engineHosts」的小写集——是生成后
 * 消费侧门的超集（refreshSupportedHosts 只会再滤掉不规范 host），所以不会漏条目；且不整列读 collections（≈159 KB）。
 * 再按行 URL 过滤：池只按行的 source_url 查 states，canProbe/门判定在消费侧 readMeta 里照做；
 * 同一 URL 的重复条目同进同出，readMeta「重复即作废」语义不变，条目保持原序。
 */
export async function buildShuyuanPoolArtifact(signal: AbortSignal): Promise<PoolArtifact> {
  const s = getSql();
  const hosts = await engineHosts(signal);
  const projectionHosts = [...new Set([...BUILTIN_SOURCE_HOSTS, ...hosts].map((host) => host.trim().toLowerCase()))].sort();
  const [meta, builtin, engine] = await Promise.all([
    readPoolProbeMeta(s, projectionHosts, signal), readBuiltinRows(s, signal), readEngineRows(s, signal),
  ]);
  const urls = new Set([...builtin, ...engine].map((row) => row.source_url));
  const list = Array.isArray(meta.collections) ? meta.collections : [];
  const snapshot = isRecord(list[0]) && isRecord(list[0].probeSnapshot) ? list[0].probeSnapshot : {};
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  return createPoolArtifact({
    refreshedAt: meta.refreshed_at,
    hosts: [...hosts].sort(),
    builtin,
    engine,
    probe: {
      version: snapshot.version ?? null,
      entries: entries.filter((entry) => isRecord(entry) && typeof entry.url === 'string' && urls.has(entry.url)),
    },
  });
}

/**
 * 写库成功后在本机发布产物：仅当开关开且配置了 SHUYUAN_POOL_ARTIFACT_PATH（phoenix 这类有持久盘的进程）才做，
 * Vercel 上无此 env ⇒ 'skipped'，零额外读。绝不让写路径失败：生成/写文件出错只告警（下一轮 phoenix 定时生成兜底）。
 */
export async function publishPoolArtifact(signal?: AbortSignal): Promise<'written' | 'unchanged' | 'skipped' | 'failed'> {
  const path = process.env.SHUYUAN_POOL_ARTIFACT_PATH?.trim();
  if (!poolArtifactEnabled() || !path) return 'skipped';
  try {
    const artifact = await buildShuyuanPoolArtifact(signal ?? AbortSignal.timeout(READ_CACHE_LOAD_TIMEOUT_MS));
    const result = await writePoolArtifactFile(path, artifact);
    resetPoolArtifactMemo();
    return result;
  } catch (error) {
    console.error('shuyuan pool artifact publish failed', { reason: safeReason(error) });
    return 'failed';
  }
}

/**
 * 池合成用的探测快照投影（xfer41）：只取「host 门内」源的探测条目，而不是整列 collections（≈159 KB / 1215 条）。
 *
 * 等价性：池路径只查 states.get(row.source_url)，且 row 先过 canProbe（= validateSourceUrl：必须 `https://` 开头、
 * WHATWG hostname ∈ 当前 host 门）。readMeta 对非 pending 条目同样要求 canProbe，pending 条目池路径不区分。
 * 故只要保证「候选行 URL 对应的条目全部带回」即可，SQL 里按下面的**超集**筛：
 * - 以 `https://` 开头（大小写不敏感），且
 * - authority 是纯 [a-z0-9.-]（可带 :443）时，其小写 host ∈ 门——此时 WHATWG hostname 恰为该小写串；
 * - authority 含其他字符（百分号编码、非 ASCII 等 WHATWG 会改写的形态）时一律带回，交 JS 判。
 * 同一 URL 的重复条目按同一谓词同进同出，readMeta 的「重复即作废」语义不变；条目保持原序。
 * 门集合进缓存键：门一变（新准入 host）即换键重读，不会用旧门的投影漏掉新 host 的条目。
 * collections 列表本身（合集 id/title/count）不带回——池路径不用；refreshed_at 照带。
 */
async function poolProbeMeta(s: Sql, signal?: AbortSignal): Promise<MetaRow> {
  const hosts = supportedHostList();
  return cachedRead(`poolProbeMeta:${hosts.join(',')}`, signal, (sig) => artifactOr(
    (artifact) => ({ refreshed_at: artifact.refreshedAt, collections: [{ probeSnapshot: artifact.probe }] }),
    () => readPoolProbeMeta(s, hosts, sig)));
}

async function readPoolProbeMeta(s: Sql, hosts: string[], sig?: AbortSignal): Promise<MetaRow> {
  const rows = await readRows<MetaRow>(s, s`
    SELECT refreshed_at::text AS refreshed_at,
           jsonb_build_array(jsonb_build_object('probeSnapshot', jsonb_build_object(
             'version', collections->0->'probeSnapshot'->'version',
             'entries', COALESCE((
               SELECT jsonb_agg(e.entry ORDER BY e.ord)
               FROM jsonb_array_elements(CASE
                 WHEN jsonb_typeof(collections->0->'probeSnapshot'->'entries') = 'array'
                 THEN collections->0->'probeSnapshot'->'entries' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(entry, ord)
               WHERE lower(e.entry->>'url') ~ '^https://'
                 AND (substring(lower(e.entry->>'url') FROM '^https://([a-z0-9.-]+)(?::443)?(?:[/?#]|$)')
                        = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(hosts)}::jsonb)))
                      OR lower(e.entry->>'url') !~ '^https://[a-z0-9.-]+(?::443)?(?:[/?#]|$)')
             ), '[]'::jsonb)))) AS collections
    FROM shuyuan_meta WHERE id = 1`, sig);
  return rows[0] ?? { collections: [], refreshed_at: null };
}

/** admission 候选筛包装：规则先过公共 survey 锁，命永久排除名单本-batch 即拒（不前送到深层探查）。
 * 字段是 bookSourceUrl 不是 url——RawSource 无 url 字段，`c.url` 恒 undefined 会让
 * isPermanentlyDisabledUrl('undefined') 静默返回 false（bug42 复发根因，见 shuyuan.test.ts 反例）。 */
function selectCandidatesWithPermanentBlock(sources: RawSource[], options: Parameters<typeof selectCandidates>[1]): RawSource[] {
  return selectCandidates(sources, options).filter((c) => !isPermanentlyDisabledUrl(String(c.bookSourceUrl ?? '')));
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
  // xfer41：这里只要 refreshed_at（「刷新停更多久」要新鲜值，不走缓存）；池本身的探测态由 getReadingPool 自取。
  // 改前整列读 collections（≈159 KB），随后 getReadingPool 内部又整列读一遍。
  const [raw = { refreshed_at: null }] = await readRows<{ refreshed_at: string | null }>(s, s`
    SELECT refreshed_at::text AS refreshed_at FROM shuyuan_meta WHERE id = 1`, signal);
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

/** 准入漏斗聚合（§6.3）：三桶谓词与入池判据 / admissionBucket 同口径。
 * admrunner42：phoenix_ok: 行从 ok 桶挪到 deferred 桶（在池外等 Vercel 确认，与「search_ok 未真」同一处境），
 * 三桶仍互斥完备；url_defaulted 是 ok 桶的子集，同步排除。 */
function readAdmissionFunnel(s: Sql, signal: AbortSignal): Promise<ShuyuanAdmissionFunnel[]> {
  return readRows<ShuyuanAdmissionFunnel>(s, s`
    SELECT count(*) FILTER (WHERE compile_ok AND search_ok IS TRUE
             AND (error IS NULL OR error NOT LIKE 'phoenix_ok:%'))::int AS ok,
           count(*) FILTER (WHERE NOT compile_ok
             OR search_verdict IN ('challenge', 'conn_fail', 'shell'))::int AS rejected,
           count(*) FILTER (WHERE compile_ok
             AND (search_ok IS NOT TRUE OR error LIKE 'phoenix_ok:%')
             AND search_verdict NOT IN ('challenge', 'conn_fail', 'shell'))::int AS deferred,
           count(*) FILTER (WHERE compile_ok AND search_ok IS TRUE
             AND (error IS NULL OR error NOT LIKE 'phoenix_ok:%')
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
  const countsPending = countsFromStates(s, states, signal);
  const filter = list?.filter ?? 'all';
  const page = list?.page ?? 1;
  const pageSize = list ? SOURCE_PAGE_SIZE : SOURCE_STATUS_LIMIT;
  // 筛选谓词写成 7 个绑定参数的布尔式，而不是拼 SQL 片段：filter 会决定谓词形状，
  // 但它始终只是一个被比较的值，不进 SQL 文本。分支与 countsFromStates 的
  // FILTER (WHERE ...) 逐条对齐，所以卡片上的数字就是点进去看到的条数。
  const rowsPending = readRows<{
    url: string; name: string; disabled: boolean; availability: ShuyuanAvailability;
    last_error: string; checked_at: string | null; probe_error: string | null;
    classification_source: unknown;
  }>(s, s`
    SELECT source_url AS url, name, source AS classification_source, disabled_at IS NOT NULL AS disabled,
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
    LIMIT ${pageSize} OFFSET ${offsetFor(page, pageSize)}`, signal).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  // 两读共享 meta；立即接住 rows 失败，但仍先交付 counts 错误，不等慢 rows。
  // counts 失败时已发出的只读 rows 可继续，仍走原 signal 与配额记账。
  const counts = await countsPending;
  const rowsOutcome = await rowsPending;
  if (!rowsOutcome.ok) throw rowsOutcome.error;
  const rows = rowsOutcome.value;
  const stats: ShuyuanStats = {
    ...counts, collections, refreshedAt: rawMeta.refreshed_at, sourcesLimit: pageSize,
    sources: rows.map((row) => ({
      url: row.url, name: row.name, disabled: row.disabled, availability: row.availability,
      lastError: row.last_error, checkedAt: row.checked_at, probeError: row.probe_error,
      adultClassification: classifySourceAdult(row.name, row.classification_source),
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
  invalidateShuyuanReadCache();
  if (rows.length > 0) await publishPoolArtifact(); // 41-poolimpl：UPDATE 成功且命中行才重发产物
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
  invalidateShuyuanReadCache();
  if (rows.length > 0) await publishPoolArtifact(); // 41-poolimpl：同 disableShuyuanSource
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

// srcfeed：跨上游合并的版本取舍。「版本戳」取 legado 源自身的 lastUpdateTime（毫秒时间戳）。
// position 是合并管线给的「序列号」（0=yckceo 恒赢，>0=feed 起始位），随条目并列保存在
// merged Map 的 value 元组里——**不写进源 JSON 本体**：source 落库后会被对比（sameRules）与
// 下发给阅读/准入，注入键会让「上次拉取结果 ≠ 本轮重新拉取结果」误判为规则变化（源被整批
// 置 pending）。因此元数据只在合并内存中存活。
type PoolVersion = { stamp: number; position: number };
function sourceVersion(item: Record<string, unknown>, position: number): PoolVersion {
  const stampValue = item.lastUpdateTime;
  const stamp = typeof stampValue === 'number' && Number.isFinite(stampValue) ? stampValue : 0;
  return { stamp, position: Number.isSafeInteger(position) && position >= 0 ? position : Number.MAX_SAFE_INTEGER };
}
/** 全序：stamp 不相等且都 >0 ⇒ 新者胜；其余（含相等/缺失）⇒ position 大的（后出现者）胜；yckceo(0) 恒压正位。 */
export function incomingWins(incoming: PoolVersion, existing: PoolVersion): boolean {
  if (incoming.stamp > 0 && existing.stamp > 0 && incoming.stamp !== existing.stamp) {
    return incoming.stamp > existing.stamp;
  }
  return incoming.position > existing.position;
}

/**
 * srcfeed：把一条 feed 解析结果合入去重表。返回本 feed 实际入选（写入/覆盖）的条数，
 * 供 meta collections 数组记「净贡献」而不是原始条数。
 * 源条目形状过滤与 yckceo 完全一致：isRecord + bookSourceUrl 是 string + normalizeUrl 非空
 * + cleanJson 入表——JSON 原样落 shuyuan_sources.source（下游准入/探测的 validateSourceUrl
 * /checkSourceUrl/upgradeSourceTemplateUrl 三级门不改、照常生效）。
 * positionBase = 合并序列中本 feed 起始位置（yckceo 占 0..LATEST_COUNT-1，extra feed 顺延，
 * 永远为正且位于 yckceo 之后），保证 id 唯一、序有意义。
 */
function mergeIntoPool(merged: Map<string, [Record<string, unknown>, number]>, parsed: unknown[], positionBase: number): number {
  let wins = 0;
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.bookSourceUrl !== 'string') continue;
    const url = normalizeUrl(item.bookSourceUrl);
    if (!url) continue;
    if (isPermanentlyDisabledUrl(url)) continue; // 永久排除红线：wnreader 一类的复生源直接拒收
    const cleaned = cleanJson(item);
    if (!isRecord(cleaned)) continue;
    const existing = merged.get(url);
    if (!existing) { merged.set(url, [cleaned, positionBase]); wins += 1; continue; }
    if (!incomingWins(sourceVersion(cleaned, positionBase), sourceVersion(existing[0], existing[1]))) continue; // 旧的让新的
    merged.set(url, [cleaned, positionBase]); // 较新版 或 无法比较时后到者胜
    wins += 1;
  }
  return wins;
}

// srcfeed：额外 feed 拉取结果转入 meta 时，feed URL 一律只留「host/文件名」形态——
// 完整路径可能带上游签名/查询串，绝不让它原样进 shuyuan_meta（会随 /api/shuyuan 回显）。
export function feedLabelOf(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  return segments.length > 0 ? `${parsed.hostname}/${segments.at(-1)}` : parsed.hostname;
}

/**
 * srcfeed：额外 feed 直链拉取。每条裸 JSON 数组直链一次 fetch（内层超时与 yckceo 合集同为
 * RESPONSE_TIMEOUT_MS），串行处理（并发 2 的收益抵不上与「并发竞态 + 预算止损」交叉的复杂度，
 * 单 feed 12s × 上限 8 条最坏 96s，仍在 180s 预算内容纳——报告「主会话待办」提了放量选项）。
 * 任一 feed 失败只跳过该 feed：返回 failures 供 meta 记一行结构化 error，绝不中止刷新。
 * feed url 只记 feedLabel 与 host 级 reason（safeReason 同款纪律：不回显整链，防带签名 URL 进日志/库）。
 */
async function fetchExtraFeeds(
  feeds: readonly string[], signal: AbortSignal, assertActive: () => void,
): Promise<{ results: { feed: string; items: unknown[] }[]; failures: ExtraFeedFailure[] }> {
  const results: { feed: string; items: unknown[] }[] = [];
  const failures: ExtraFeedFailure[] = [];
  for (const feed of feeds) {
    assertActive();
    const label = feedLabelOf(feed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fetchText(feed, RESPONSE_TIMEOUT_MS, signal));
      // fetch 层中止（信号）原样上抛——中止是刷新级语义，不归入「单个 feed 失败跳过」；
      // 但解析阶段的 SyntaxError/类型不符是 feed 内容坏，同样只跳过本轮这条 feed。
      if (!Array.isArray(parsed)) throw new Error('合集 JSON 不是数组');
      results.push({ feed: label, items: parsed }); // 入表的是脱敏 label，不是原链
    } catch (error) {
      assertActive(); // 中止/预算耗尽不解释为 feed 失败，原样上抛终止刷新
      failures.push({ feed: label, reason: safeReason(error) });
    }
  }
  return { results, failures };
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
  // srcfeed：额外 feed 只从 env 读一次；缺省（原始无 / 解析后全空）⇒ 本路径全短路，
  // extraFeedFailures 恒空，meta 断言与「仅 yckceo」逐字一致（零行为变化门禁）。
  const { urls: extraFeeds, invalid: extraInvalid } = shuyuanExtraFeeds();
  // env 错填（非 https / 解析失败）不作为 feed 失败参与降级中止，但要把「这批条目被丢弃」
  // 记进 meta——缺省与全合法时本数组长 0（剥离后与改前逐字节一致）。
  // feedLabelOf 对无法解析的字符串会抛 Invalid URL：invalid 条目里恰有这种值（解析失败正是
  // 入选 invalid 的原因之一），只能用 hostOf 的安全降级形态（host 级、解析不了给占位符）。
  const extraFeedFailures: ExtraFeedFailure[] = extraInvalid.map((raw) => ({
    feed: hostOf(raw), reason: 'env 条目非法：非 https 或无法解析',
  }));
  const html = await fetchTextRetry(INDEX_URL, RESPONSE_TIMEOUT_MS * 2, signal);
  const entries = parseIndex(html);
  if (entries.length === 0) throw new Error('书源列表页解析到 0 个合集，页面结构可能变了');

  const merged = new Map<string, [Record<string, unknown>, number]>();
  const collections: ShuyuanCollection[] = [];
  // 失败合集的原因归类，只用于降级告警：上游整体不可达时要说清「拉了哪些、为什么没拿到」。
  const collectionFailures: { id: number; reason: string }[] = [];
  for (const entry of entries.slice(0, LATEST_COUNT)) {
    assertActive();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fetchTextRetry(jsonUrl(entry.id), RESPONSE_TIMEOUT_MS, signal));
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
      if (!url) continue;
      if (isPermanentlyDisabledUrl(url)) continue; // 永久排除红线：wnreader 一类的复生源直接拒收
      const cleaned = cleanJson(item);
      if (!isRecord(cleaned)) continue;
      // yckceo 令牌 position=0：恒压一切 extra feed（正数位）；同合集间冲突由 lastUpdateTime 判新旧。
      const existing = merged.get(url);
      if (!existing) { merged.set(url, [cleaned, 0]); continue; }
      if (!incomingWins(sourceVersion(cleaned, 0), sourceVersion(existing[0], existing[1]))) continue;
      merged.set(url, [cleaned, 0]);
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

  // srcfeed：yckceo 判全过之后才接额外 feed——判据先于拉取，保证「yckceo 半挂 ⇒ 中止」不被
  // extra feed 拉取耗时稀释（烧预算）也不被 extra feed 结果翻转（中止语义只挂在 yckceo 上）。
  // 缺省（extraFeeds=[]）时本块整体短路：零 fetch、零 meta 变化。
  const extraFailures: { feed: string; reason: string }[] = [];
  if (extraFeeds.length > 0) {
    const { results, failures } = await fetchExtraFeeds(extraFeeds, signal, assertActive);
    extraFailures.push(...failures);
    for (const [index, result] of results.entries()) {
      assertActive();
      const wins = mergeIntoPool(merged, result.items, LATEST_COUNT + index + 1);
      collections.push({
        id: LATEST_COUNT + index + 1,
        title: `feed:${result.feed}`,
        count: wins, // 净贡献（去重后实际入选条数），而不是原始条数
      });
    }
  }
  extraFeedFailures.push(...extraFailures); // env 错填行 + 本轮 fetch/解析失败行合并进 meta

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
  if (engineSourcesEnabled()) await refreshEngineHostGate(signal, true);
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
  for (const [url, pair] of merged) {
    const item = pair[0]; // 合并 value 是 [cleaned, position] 元组；position 只在合并在内存存活（不落 source）
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
  const sameStation = probeSameStationRedirect();
  async function probeWorker() {
    while (next < probes.length) {
      if (signal.aborted || budget.remainingMs <= PROBE_TIMEOUT_MS + WRITE_RESERVE_MS) return;
      const url = probes[next++];
      try {
        const probeUrl = validateSourceUrl(url).href;
        await fetchText(probeUrl, PROBE_TIMEOUT_MS, signal, sameStation ? { sameStationOf: probeUrl } : {});
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

  const rows = [...merged.entries()].map(([url, pair]) => { const item = pair[0]; return {
    url, name: typeof item.bookSourceName === 'string' ? item.bookSourceName : '',
    grp: typeof item.bookSourceGroup === 'string' ? item.bookSourceGroup : '', source: item,
    disabled_at: previous.get(url)?.disabled_at ?? null,
    err: previous.get(url)?.last_error || probeFailures.get(url) || '',
  }; });
  const insertChunk = (chunk: typeof rows) => s`
    INSERT INTO shuyuan_sources (source_url, name, group_name, source, disabled_at, last_error)
    SELECT url, name, grp, source, disabled_at, err
    FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
    AS t(url text, name text, grp text, source jsonb, disabled_at timestamptz, err text)`;
  // srcfeed：extra feed 失败降级挂在首条 yckceo collection（与 probeSnapshot 同位，读侧只认
  // isRecord/既有键 ⇒ 新键对外不可见且不破坏既有解析；feed 字段已是 feedLabelOf 的 host/文件名
  // 形态）。缺省时本三元运算恒 undefined⇒剥离，serialized value 与改前逐字节一致。
  // permblock42：永久排除名单的 mirror 挂到首条 probeSnapshot（可观测「当前过滤了哪几个 host」），
  // 命中即剔除本批次；缺省时本三元运算恒 undefined⇒剥离。
  const hostPermanentlyDisabled: string[] = permanentDisableHostList();
  const savedCollections = collections.map((collection, i) => i === 0 ? {
    ...collection,
    probeSnapshot: {
      version: 1,
      entries: [...states.values()],
      ...(hostPermanentlyDisabled.length > 0 ? { permanentDisable: { hosts: hostPermanentlyDisabled } } : {}),
    },
    ...(extraFeedFailures.length > 0 ? { extraFeedFailures } : {}),
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
  invalidateShuyuanReadCache();
  // M1 准入库：挂在全量替换事务**之后**（设计 §4.2 v3 E2）。事务已提交，validateAdmissionUrl
  // 读到的「源声明 host 集合」本轮即含新源；滤网 2 不在用户请求路径上跑，只在此 cron 批次。
  await runAdmissionAfterRefresh(s, rows, budget, signal);
  // 41-poolimpl：全量替换已提交、准入批次已写回（或按 §6.3 降级跳过，库仍自洽）之后才发布源池产物；事务失败走不到这里。
  await publishPoolArtifact(signal);
  return getShuyuanStats(signal);
}

/**
 * 准入批次（设计 §4.2）。时序：全量替换事务之后。硬约束：
 * - 剩余预算 ≤ ADMISSION_MIN_BUDGET_MS 即整批跳过，绝不挤占刷新预算（180s）；
 * - 始终先领准入租约，领不到（另一入口——独立轮或 phoenix runner——正在跑）即整批跳过（admlfix42：与开关解耦）；
 * - 候选池 = 通过 survey 初筛的源 + 初筛不过但留有 compile_ok 旧行的源（41-srcfix G5，送回改判出池）；
 *   既有行读一次（按本轮全部源 URL），二者皆空才整批跳过；
 * - runAdmissionBatch 每轮真实搜索 ≤ admissionMaxProbes()（默认 20，env `ADMISSION_MAX_PROBES` 可调），逐探前再查预算。
 * 只写 source_admission，不碰 shuyuan_sources；异常不终结刷新（§6.3：准入异常 → deferred）。
 */
async function runAdmissionAfterRefresh(
  s: Sql, rows: AdmissionInputRow[], budget: RequestDeadline, signal: AbortSignal,
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
  // 刷新尾部始终参与共享租约，与 ADMISSION_OWN_CRON 开关解耦（admlfix42）：开关只管独立 HTTP 入口的启停，
  // 但 phoenix runner（entry.ts --admission）不看开关、不受 Vercel env 约束——开关关时它仍会跑一轮准入。
  // 若尾部按开关跳过领约，就会与 runner 同批并发探测同一批源。故无条件领约：领不到（runner 持约中）静默 return，
  // 与开关开时领不到的行为一致（不抛错、不计失败）。开关关且无并发时能领到、照常 admitRows（行为等同改前）。
  const lease = await claimAdmissionLease(s, 'refresh', rows.length);
  if (!lease) return;
  await admitRows(s, rows, budget, signal, {}, lease);
}

type AdmissionInputRow = { url: string; source: Record<string, unknown> };
/** 准入入口标识（日志用）：refresh=刷新尾部、round=Vercel 独立轮、runner=phoenix runner（admrunner42）。 */
type AdmissionTrigger = 'refresh' | 'round' | 'runner';

/** 一轮准入的结果摘要（只含计数，可直接作 cron 响应体；不含任何源 URL）。 */
export type AdmissionRoundSummary =
  | { skipped: 'disabled' | 'lease' | 'no_candidates' | 'failed' }
  | { skipped: 'lease_lost'; written: 0 }
  | {
    sources: number; candidates: number; surveyRejectedExisting: number; compileOk: number;
    compileRejected: number; probed: number; written: number;
    /** probecircuit1026：只在本轮熔断时出现（未熔断时摘要形状不变）。 */
    circuitOpen?: true; suppressedConnFail?: number;
  };

/**
 * 领准入租约（42-admbudget；fencecore42 改造为返回代次句柄）。
 * 单条语句原子领取：行不存在 → 插入；已过期 → 抢占；未过期 → WHERE 不成立、RETURNING 空 ⇒ 未领到。
 * 时间全用库端 now()，不受函数实例时钟影响。领取失败（库抖动）按未领到处理——fail-closed：
 * 本轮不探，下一轮再来，绝不在拿不准互斥时并发探测。
 *
 * fencecore42：成功领取原子递增 lease_generation 并 RETURNING——返回句柄（generation 十进制字符串，
 * 禁转 JS Number 防 2^53 精度丢失），最终准入写事务用它做 fencing 校验（见 writeAdmissionRows）。
 * 旧代次/溢出（generation+1 超 bigint 上限则领取失败关闭）一律拿不到句柄。
 */
export type LeaseHandle = { leaseName: typeof ADMISSION_LEASE_ROW; generation: string };

/** 不接受 Number、零、前导零、符号或越界代次；拷贝后再跨 await 使用。 */
function checkedLeaseHandle(value: unknown): LeaseHandle | null {
  if (!isRecord(value) || value.leaseName !== ADMISSION_LEASE_ROW
    || typeof value.generation !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.generation)
    || BigInt(value.generation) > BigInt('9223372036854775807')) return null;
  return { leaseName: ADMISSION_LEASE_ROW, generation: value.generation };
}

async function claimAdmissionLease(s: Sql, trigger: AdmissionTrigger, sources?: number): Promise<LeaseHandle | null> {
  try {
    const rows = await s`
      INSERT INTO cron_health (name, last_success_at, lease_generation)
      VALUES (${ADMISSION_LEASE_ROW}, now() + ${admissionLeaseTtlMs()}::int * interval '1 millisecond', 1)
      ON CONFLICT (name) DO UPDATE SET
        last_success_at = EXCLUDED.last_success_at,
        lease_generation = cron_health.lease_generation + 1
        WHERE cron_health.last_success_at <= now()
          AND cron_health.lease_generation >= 0
          AND cron_health.lease_generation < 9223372036854775807
      RETURNING name, lease_generation::text AS generation` as { name: string; generation: string | null }[];
    const lease = rows.length === 1
      ? checkedLeaseHandle({ leaseName: rows[0].name, generation: rows[0].generation }) : null;
    if (lease) return lease;
    // 独立轮领租约时还没读源表，没有 sources 计数可记。
    console.log('shuyuan admission batch', { ...(sources === undefined ? {} : { sources }), skipped: 'lease', trigger });
  } catch (error) {
    console.error('shuyuan admission lease failed', { trigger, reason: safeReason(error) });
  }
  return null;
}

/**
 * 独立准入轮（42-admbudget，/api/shuyuan/admission 调用；调用方负责 ADMISSION_OWN_CRON 开关）。
 * 不依赖刷新剩下的预算：自带 ADMISSION_ROUND_BUDGET_MS 整份预算，源集合从 shuyuan_sources 读
 * （= 上一次刷新整表替换写入的同一批上游源，与刷新尾部的 rows 同口径，含禁用源）。
 * 先领租约再读源表：领不到就不白读 1.7K 行 source 大列。写回后与刷新尾部一样发布源池产物。
 */
export async function runAdmissionRound(parentSignal?: AbortSignal): Promise<AdmissionRoundSummary> {
  const budget = createDeadline(ADMISSION_ROUND_BUDGET_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, budget.signal]) : budget.signal;
  try {
    const s = getSql();
    const lease = await claimAdmissionLease(s, 'round');
    if (!lease) return { skipped: 'lease' };
    const stored = await readRows<{ source_url: string; source: Record<string, unknown> }>(s, s`
      SELECT source_url, source FROM shuyuan_sources ORDER BY id`, signal);
    const rows = stored.map((row) => ({ url: row.source_url, source: row.source }));
    const summary = await admitRows(s, rows, budget, signal, {}, lease);
    if (signal.aborted) return { skipped: 'failed' };
    const artifact = 'written' in summary && summary.written > 0 ? await publishPoolArtifact(signal) : 'skipped';
    if (signal.aborted) return { skipped: 'failed' };
    // 独立轮收尾一行：观测「这一轮用了多少、还剩多少」——验证它确实拿的是整份预算而非刷新剩余。
    console.log('shuyuan admission round', { ...summary, artifact, remainingMs: budget.remainingMs });
    // 42-admhealth：成功行在 admitRows 尾部记（两个入口共用一处），这里不重复。
    return summary;
  } finally {
    budget.dispose();
  }
}

/**
 * phoenix runner 准入轮（admrunner42，scripts/shuyuan-refresh/entry.ts `--admission` 调用）。
 * 与 runAdmissionRound 同一条流水（租约 → 读 shuyuan_sources → admitRows → 写 source_admission），差别只在：
 * - 预算由调用方给（runner 单元 WATCHDOG_MS 兜底），租约 TTL 走 env ADMISSION_LEASE_TTL_MS（≥ 预算）；
 * - ok 结论默认写干净 ok、直接入池（admgate1026）；ADMISSION_RUNNER_PHOENIX_OK=1 时回旧行为带
 *   ADMISSION_PHOENIX_OK_PREFIX（池外待确认，见 admission.ts 常量注释与 admissionRunnerPhoenixOkPrefix）；
 * - **不**发布源池产物（phoenix 的 pool-artifact timer 每 30 分钟自会生成）。
 * admitRows 尾部的 refreshSupportedHosts 在 runner 进程里只刷本进程内存（无消费者），无害、语义不改。
 */
export async function runAdmissionRunnerRound(budgetMs: number): Promise<AdmissionRoundSummary> {
  const budget = createDeadline(budgetMs);
  try {
    const s = getSql();
    const lease = await claimAdmissionLease(s, 'runner');
    if (!lease) return { skipped: 'lease' };
    const stored = await readRows<{ source_url: string; source: Record<string, unknown> }>(s, s`
      SELECT source_url, source FROM shuyuan_sources ORDER BY id`, budget.signal);
    const rows = stored.map((row) => ({ url: row.source_url, source: row.source }));
    const okPrefix = admissionRunnerPhoenixOkPrefix() ? { okPrefix: ADMISSION_PHOENIX_OK_PREFIX } : {};
    const summary = await admitRows(s, rows, budget, budget.signal, okPrefix, lease);
    if (budget.signal.aborted) return { skipped: 'failed' };
    console.log('shuyuan admission round', { ...summary, trigger: 'runner', artifact: 'skipped', remainingMs: budget.remainingMs });
    return summary;
  } finally {
    budget.dispose();
  }
}

async function admitRows(
  s: Sql, rows: AdmissionInputRow[], budget: RequestDeadline, signal: AbortSignal,
  options: { okPrefix?: string },
  lease: LeaseHandle, // fencecore42：必填——无句柄不得写准入（fencing token 从领取方传入）
): Promise<AdmissionRoundSummary> {
  const handle = checkedLeaseHandle(lease);
  if (!handle) return { skipped: 'lease_lost', written: 0 };
  // adultsrc42：成人源不参加准入打标（用户口径「不参加打标和换源」）。分类器与引擎池过滤
  // （engineReadingSources）同一把：按 source 元数据（bookSourceName/bookSourceGroup 与库里 name 同源）
  // 判定即可，三个准入入口（Vercel 独立轮 / phoenix runner / 刷新尾部）都在这一处收口。
  // 滤出的源不消耗探测预算；既有 source_admission 旧行留库（展示侧照旧，池侧由分类器挡住）。
  // adult1026：与池侧同口径做同站传染——本轮输入里同站任一源判 adult，整站都不评估。
  const adultStations = adultStationKeys(rows, (row) => classifySourceAdult(undefined, row.source),
    (row) => stationKeyOfUrl(row.url));
  const probedRows = rows.filter((row) => classifySourceAdult(undefined, row.source) !== 'adult'
    && !adultStations.has(stationKeyOfUrl(row.url)));
  rows = probedRows;
  // 在探测前固定快照；写前不得重读新规则冒充本轮已经测过的对象。
  const sourceSnapshots = rows.map(({ url, source }) => ({ url, source: structuredClone(source) }));
  const declaredHosts = new Set<string>();
  for (const row of rows) {
    try { declaredHosts.add(new URL(row.url).hostname); } catch { /* 上游脏 URL：无法声明 host */ }
  }
  let candidates: AdmissionCandidate[] = [];
  const surveyRejected: AdmissionCandidate[] = [];
  // 41-admpost F2 / js-1026 / jsbox1027：候选筛与 compileAdmission 同一口径（admissionSurveyOptions 逐源算），
  // 否则放行源在评估环第一步被判回 T7，或（漏传 coreJs 时）JS 源根本进不了评估环。
  // searchjs1027：搜索模板 JS 的候选判定在沙箱里同步求值，先载入；沙箱瞬时不可用的源本轮两边都不进（不误判 T7）。
  if (engineSearchJsActive()) await prepareSearchJs();
  for (const row of rows) {
    const source = row.source as RawSource;
    let selected: boolean;
    try {
      selected = selectCandidatesWithPermanentBlock([source], admissionSurveyOptions(source)).length === 1;
    } catch (error) {
      if (error instanceof SearchJsNotReadyError) continue;
      throw error;
    }
    (selected ? candidates : surveyRejected).push({ url: row.url, source });
  }
  let summary: AdmissionRoundSummary;
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
    let frozen = surveyRejected.filter((candidate) => existing.get(candidate.url)?.compile_ok === true);
    // admchurn42：phoenix runner 轮（okPrefix 路径）不再评估「已入池的 ok 行」——runner 对这些行的
    // 最好结局也只是把 error 改写成 phoenix_ok:（= 降级出池等 Vercel 重确认），复核它们纯属净损失。
    // 2026-10-16 生产事故复盘：刷新落地两天上游规则变更 ⇒ rules_hash 大面积变化 ⇒ 大量 ok 行到期，
    // runner 两轮把 16 个已确认 host 全部搅降级，池掉到 2。在池 ok 行（干净与 recheck_fail: 可疑，
    // 后者仍算入池）的复核只交给 Vercel 侧（刷新尾部 / 独立准入轮）——只有它们的 ok 结论能保住池籍。
    // Vercel 两条路径不传 okPrefix，本过滤零生效（行为不变）。
    if (options.okPrefix) {
      const runnerProbes = (url: string) => {
        const previous = existing.get(url);
        return !(previous && previous.search_ok === true && previous.search_verdict === 'ok'
          && !previous.error.startsWith(options.okPrefix!));
      };
      candidates = candidates.filter((candidate) => runnerProbes(candidate.url));
      frozen = frozen.filter((candidate) => runnerProbes(candidate.url));
    }
    if (candidates.length === 0 && frozen.length === 0) {
      const write = await writeAdmissionRows(s, [], handle, sourceSnapshots, signal);
      return 'skipped' in write ? write : { skipped: 'no_candidates' };
    }
    const readabilityShadow = admissionReadabilityShadowMax();
    const result = await runAdmissionBatch({
      candidates: [...candidates, ...frozen], declaredHosts, existing, fetchPage: defaultAdmissionTransport, signal,
      // espfix41：开查询不敏感对照搜索，单探最坏 = 主搜索 + 对照搜索（ADMISSION_PROBE_WORST_MS），止损按它预留。
      controlQuery: true,
      // 41-srcfix 改法1：探测词兜底，换词前按同一 canProbe 预留判预算（单词一次尝试最坏 = ADMISSION_PROBE_WORST_MS）。
      keywordFallback: true,
      canProbe: () => !signal.aborted && budget.remainingMs > ADMISSION_PROBE_WORST_MS + WRITE_RESERVE_MS,
      // admrunner42：只有 phoenix runner 传 okPrefix；Vercel 两条路径不传 ⇒ 展开为空对象，输入形状逐字不变。
      ...(options.okPrefix ? { okPrefix: options.okPrefix } : {}),
      // read1027：可读性影子腿（env ADMISSION_READABILITY_SHADOW_MAX，默认关）；只出日志，不改写库行。
      ...(readabilityShadow > 0 ? { readabilityShadow } : {}),
    });
    // 准入兼容 L4（§2.4）：每轮一行漂移计数（不建历史表；要趋势曲线再上日表，Phase 2）。
    console.log('shuyuan admission batch', {
      candidates: candidates.length,
      surveyRejectedExisting: frozen.length,
      compileOk: result.compileOk,
      compileRejected: result.compileRejected,
      grandfathered: result.grandfathered,
      probed: result.probed,
      ...(result.circuitOpen ? { circuitOpen: true, suppressedConnFail: result.suppressedConnFail, verdicts: result.verdicts } : {}),
    });
    if (result.readability) {
      const { checked, verdicts, samples } = result.readability;
      console.log('shuyuan admission readability shadow', {
        checked, verdicts,
        samples: samples.map((sample) => `${sample.host} ${sample.verdict} ${sample.chapters}/${sample.chars}${sample.error ? ` ${sample.error}` : ''}`),
      });
    }
    const write = await writeAdmissionRows(s, result.rows, handle, sourceSnapshots, signal);
    if ('skipped' in write) return write;
    summary = {
      sources: rows.length, candidates: candidates.length, surveyRejectedExisting: frozen.length,
      compileOk: result.compileOk, compileRejected: result.compileRejected, probed: result.probed,
      written: write.written,
      ...(result.circuitOpen ? { circuitOpen: true as const, suppressedConnFail: result.suppressedConnFail } : {}),
    };
  } catch (error) {
    // 准入失败只影响本轮准入（§6.3）：该批 next round 重来，刷新本身已成功。
    if (signal.aborted) return { skipped: 'failed' };
    console.error('shuyuan admission batch failed', {
      candidates: candidates.length,
      reason: safeReason(error),
    });
    return { skipped: 'failed' };
  }
  // host 集合动态化（设计 §6.1）：准入写库后重算 ok 态 host 并入运行时门；
  // DB 失败/预算中止 → 保持既有集合（fail-closed：收窄到内建，绝不放大）。
  try {
    refreshSupportedHosts(await engineHosts(signal));
  } catch (error) {
    if (signal.aborted) return { skipped: 'failed' };
    console.error('shuyuan supported host refresh failed', {
      reason: safeReason(error),
    });
  }
  // 业务已提交；健康故障不能撤销准入，但健康更新本身仍须同句柄、锁后校验。
  if (signal.aborted) return { skipped: 'failed' };
  await recordAdmissionSuccess(s, handle, signal);
  if (signal.aborted) return { skipped: 'failed' };
  return summary;
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
  // semver1029：列为 bigint 后驱动把 int8 读成字符串，这里归一回 number（值 ≤ 2^53，精确）。
  return new Map(rows.map((row) => [row.source_url, { ...row, engine_semantics_version: Number(row.engine_semantics_version) }]));
}

export type AdmissionWriteResult = { written: number } | { skipped: 'lease_lost'; written: 0 };

/**
 * fencecore42：最终准入写带 fencing——同一非交互事务内「锁租约行 FOR UPDATE + 代次等值 + 锁后
 * clock_timestamp() 有效期」三重门禁通过才允许整批 UPSERT（guard CTE 门禁产出输入，TOCTOU 无门）。
 * 旧 holder（租约被抢或已过期）在写前被拒：整批零写入。事务含有限 lock_timeout/statement_timeout，
 * 失败整批回滚，不重放旧结果。与刷新替换事务（shuyuan.ts:1350 同型结构）一致走 s.transaction([...])。
 */
export async function writeAdmissionRows(
  s: Sql, rows: AdmissionSourceRow[], lease: LeaseHandle,
  sources: readonly AdmissionInputRow[], signal?: AbortSignal,
): Promise<AdmissionWriteResult> {
  const handle = checkedLeaseHandle(lease);
  if (!handle) return { skipped: 'lease_lost', written: 0 };
  signal?.throwIfAborted();
  // 写库前自查：行内 engine_semantics_version 必须与 rules_hash 版本前缀同源（复审 P3 单一真源，
  // 与 scripts/seed-admission.mjs 共用同一判据）。错配即抛、整批不落库，暴露上游口径分裂。
  assertAdmissionVersionConsistent(rows);
  // 结果只能证明探测时的源快照。使用既有 JS hash 自查结果归属，SQL 只比较 jsonb，
  // 不复制 JSON.stringify/SHA 口径（刷新原对象与 jsonb 读回的键序可能不同）。
  const snapshots = new Map(sources.map((source) => [source.url, source.source]));
  const guardedRows = rows.map((row) => {
    const source = snapshots.get(row.source_url);
    if (!source || rulesHash(source) !== row.rules_hash) throw new Error('admission source snapshot mismatch');
    return { ...row, expected_source: source };
  });
  const batch = s`
    WITH guard AS MATERIALIZED (
      SELECT 1 FROM cron_health
      WHERE name = ${handle.leaseName} AND lease_generation = ${handle.generation}::bigint
        AND last_success_at > clock_timestamp()
    ), written AS (
    INSERT INTO source_admission
      (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash,
       engine_semantics_version, host, error, compile_diagnostics)
    SELECT source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash,
           engine_semantics_version, host, error, compile_diagnostics
    FROM guard CROSS JOIN jsonb_to_recordset(${JSON.stringify(guardedRows)}::jsonb)
      AS t(source_url text, tier text, compile_ok boolean, core_field_mask jsonb, search_ok boolean,
           search_verdict text, search_checked_at timestamptz, rules_hash text,
           engine_semantics_version bigint, host text, error text, compile_diagnostics jsonb, expected_source jsonb)
    WHERE EXISTS (
      SELECT 1 FROM shuyuan_sources current
      WHERE current.source_url = t.source_url AND current.source = t.expected_source
    )
    ON CONFLICT (source_url) DO UPDATE SET
      tier = EXCLUDED.tier, compile_ok = EXCLUDED.compile_ok, core_field_mask = EXCLUDED.core_field_mask,
      search_ok = EXCLUDED.search_ok, search_verdict = EXCLUDED.search_verdict,
      search_checked_at = EXCLUDED.search_checked_at, rules_hash = EXCLUDED.rules_hash,
      engine_semantics_version = EXCLUDED.engine_semantics_version,
      host = EXCLUDED.host, error = EXCLUDED.error, compile_diagnostics = EXCLUDED.compile_diagnostics
    RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM guard) AS lease_valid,
           (SELECT count(*)::int FROM written) AS written`;
  const commit = async (): Promise<AdmissionWriteResult> => {
    signal?.throwIfAborted();
    const results = await s.transaction([
      s`SET LOCAL lock_timeout = '5s'`,
      s`SET LOCAL statement_timeout = '30s'`,
      // 与刷新整表替换的 SHARE ROW EXCLUSIVE、普通源更新互斥；持有到提交，
      // 锁后下一语句用 ReadCommitted 新快照判当前规则，避免检查后再被刷新。
      s`LOCK TABLE shuyuan_sources IN SHARE MODE`,
      // 只在最终短写事务持源表锁，再锁租约行；guard 读取两道锁后的当前时刻。
      s`SELECT name FROM cron_health WHERE name = ${handle.leaseName} FOR UPDATE`,
      batch,
    ], { isolationLevel: 'ReadCommitted', arrayMode: false, fullResults: false,
      fetchOptions: signal ? { signal } : undefined });
    const result = results[4]?.[0] as { lease_valid?: unknown; written?: unknown } | undefined;
    if (results[4]?.length !== 1 || typeof result?.lease_valid !== 'boolean'
      || typeof result.written !== 'number' || !Number.isSafeInteger(result.written) || result.written < 0
      || (!result.lease_valid && result.written !== 0)) throw new Error('invalid admission write result');
    // 取消只能停止等待。若底层随后确认提交，仍清缓存；不把晚提交回报成本轮成功。
    if (result.written > 0) invalidateShuyuanReadCache();
    return result.lease_valid ? { written: result.written } : { skipped: 'lease_lost', written: 0 };
  };
  const result = signal ? await raceDeadline(signal, commit) : await commit();
  signal?.throwIfAborted();
  return result;
}

async function recordAdmissionSuccess(s: Sql, lease: LeaseHandle, signal: AbortSignal): Promise<void> {
  const handle = checkedLeaseHandle(lease);
  if (!handle || signal.aborted) return;
  try {
    await raceDeadline(signal, async () => {
      signal.throwIfAborted();
      await s.transaction([
        s`SET LOCAL lock_timeout = '5s'`,
        s`SET LOCAL statement_timeout = '30s'`,
        s`SELECT name FROM cron_health WHERE name = ${handle.leaseName} FOR UPDATE`,
        s`WITH guard AS MATERIALIZED (
          SELECT 1 FROM cron_health
          WHERE name = ${handle.leaseName} AND lease_generation = ${handle.generation}::bigint
            AND last_success_at > clock_timestamp()
        )
        INSERT INTO cron_health (name, last_success_at)
        SELECT 'admission', clock_timestamp() FROM guard
        ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`,
      ], { isolationLevel: 'ReadCommitted', fetchOptions: { signal } });
    });
  } catch (error) {
    if (!signal.aborted) console.error('cron health write failed', { name: 'admission', reason: safeReason(error) });
  }
}
