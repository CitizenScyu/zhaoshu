import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, fsyncSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { canonicalBookKey } from '../src/lib/book-identity.ts';
import { authorBridgeAccepts, authorBridgeCandidates, authorSearchKey } from '../src/lib/source-author-bridge.ts';
import { searchKeysOf } from '../src/lib/search-key.ts';
import { sourceBookMatches } from '../src/lib/source-parser.ts';
import { fetchSourceText, sourceAbortable } from '../src/lib/source-fetch.ts';
import { stationKeyOfHost, stationKeyOfUrl } from '../src/lib/source-policy.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const atomic = (path, data) => {
  const temp = path + '.tmp';
  const fd = openSync(temp, 'w');
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
};
const knownError = /^(identity_mismatch_or_no_candidate|empty_toc|empty_toc_page|pagination_cycle|toc_limit|unsupported_toc_rule|invalid_chapter|invalid_next_page|empty_content_page|content_page_limit|unsupported_content_rule|max_chapters|size_limit|toc_changed|missing_chapters|preview_truncated|interrupted|budget_exhausted|operation_timeout|empty_content)$/;
const isLimiterFeedbackError = error => error?.code === 'LIMITER_FEEDBACK_UNAVAILABLE'
  && error?.origin === 'limiter-feedback';
const isHostGateError = error => error?.code === 'HOST_OCCUPIED'
  || error?.code === 'HOST_OCCUPANCY_UNAVAILABLE';

// 书源不可达（41-EXEC-SRCUNAVAIL）：搜索/详情/目录阶段的传输层失败（连接/请求超时、undici
// `fetch failed`＝DNS/reset/TLS）、源站 5xx（含 Cloudflare 52x）、限速器熔断（由连续源站失败触发）
// 与限速器每源日请求上限（DailyRequestBudgetError，UTC 换日即重置，属瞬时）归 code=2 source_unavailable，
// 与 resolveSource code=2 同档：可重试、零发布。4xx、策略拒绝、身份不符与其余异常维持原分类；
// 正文阶段逐章失败照旧收口为 missing_chapters。
// 41-src403：search/detail/toc 阶段的 403/429 也算源站暂时不可达——Cloudflare challenge
// 常按 URL/频率阶段性放行（noveltri 详情页对 phoenix 出网 403、同刻搜索页 200），
// 以前这类被吞成 download_failed 终态。仍走既有退避（16 次上限），永久封禁最多退干净到 failed。
const SOURCE_STAGES = new Set(['search', 'detail', 'toc']);
const UNREACHABLE_ERROR_NAMES = new Set(['ConnectTimeoutError', 'TimeoutError', 'CircuitOpenError', 'DailyRequestBudgetError']);
export function isSourceUnavailableError(error) {
  const status = error?.status;
  if (typeof status === 'number') return (status >= 500 && status <= 599) || status === 403 || status === 429;
  if (UNREACHABLE_ERROR_NAMES.has(error?.name)) return true;
  return error instanceof TypeError && /^fetch failed/i.test(error.message);
}

// 发布侧整本上限(内存约束,分卷 v2)：15 MiB → 64 MiB。阅读侧已无整本上限(按卷懒取)，
// 这里只卡引擎与发布器把整本当字符串持有的内存峰值；二期按章流式写后解除。
const MAX_BOOK_BYTES = 64 * 1024 * 1024;

// 章节缓存的正文格式版本：写进检查点，参与续传判定。engineFetchContent 的输出格式每变一次，这个值加 1；
// 41-HTMLFIX（@html 正文转纯文本）起为 2，旧检查点没有这个字段，视为 1。格式不同的检查点不续传、全量重抓：
// 缓存里存的是旧格式正文，续传会把它原样拼进新书（整本 blob 不变 ⇒ 发布器按「同内容」保留旧清单，修复不生效）。
// 41-PAGEFIX（正文翻页遇下一章即停）起为 3：修复前缓存的章节可能串入了后续章节的正文，同样必须作废重抓。
// dlstop42（下载停止点改整本目录）起为 4：同 3 的理由——3 时代只传目录下一章，cuoceng 型「下一章」链指向
// 目录非相邻章时拦不住，链长 < MAX_CONTENT_PAGES 且各页有正文 ⇒ strict 不抛、几章静默并进一个章文件；
// 旧检查点里的这类章节必须作废重抓，修复才对在途 partial 生效。
export const ENGINE_CONTENT_FORMAT = 4;
export function downloadOptions(args) {
  if (!args.source || !args.title?.trim() || !args.author?.trim()) throw new Error('download 需要 --source --title --author');
  const source = new URL(args.source.includes('://') ? args.source : `https://${args.source}`);
  if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash) throw new Error('--source 必须是 HTTPS URL 或 host');
  const options = { ...args, source: source.href };
  for (const [key, fallback, min, max] of [['max-chapters', 20000, 1, 20000], ['rate-ms', 800, 0, 60000], ['timeout-ms', 30000, 1, 600000], ['budget-ms', 19800000, 1, 19800000]]) {
    const n = args[key] === undefined ? fallback : Number(args[key]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`非法 --${key}`);
    options[key] = n;
  }
  return options;
}

// failstreak1030：正文连续失败熔断 DOWNLOAD_CONTENT_FAIL_STREAK（正整数 K；缺省/0/非法 = 关，零行为变化）。
// 连续 K 章「实抓失败」（缓存命中的 done 章与抓成功的章都清零计数）即停抓剩余章节，按 missing_chapters 收口
// （与跑完全书再抛的终态码相同，下游退避/换源口径不变）。动机（2026-10-30 生产只读）：正文规则对站点取空的源
// （suduguu www 那份 .con@textNodes）每章都实打请求再判 empty_content_page，整本 2000+ 章逐章失败、周约 4.3 万次
// 无效请求；书反正 partial，后面的章抓了也只是一样失败。已 done 章照旧落盘，下轮同源续传不受影响。
export function contentFailStreak(env = process.env) {
  const raw = env.DOWNLOAD_CONTENT_FAIL_STREAK?.trim() ?? '';
  if (!/^\d{1,6}$/.test(raw)) return 0;
  return Number(raw);
}

// retrypass1030：正文失败章补抓轮数 DOWNLOAD_CONTENT_RETRY_PASSES（0..3；缺省/0/非法 = 关，零行为变化）。
// 全书一遍抓完后，对瞬时类失败章（chapter_failed / operation_timeout：5xx、连接重置、超时等）按目录序再抓 R 轮，
// 每轮前静置 1s、轮内连败计数从 0 起算（熔断口径同 failstreak1030）。规则/结构类失败（empty_content_page、
// invalid_* 等，同源重抓必然同错）不补抓。legado CacheBook 同义：出错等 1s 后重新排到待下载队尾，每章最多 3 次
// （R=2 对齐）。动机（2026-10-30 phoenix 只读）：itxtbook 一本 109 章失败，抽查失败章当刻 502、10s 后重抓 200；
// 不补抓则整本 missing_chapters → 换源/退避，原源已到手的大半本白抓。
const RETRYABLE_CHAPTER_ERRORS = new Set(['chapter_failed', 'operation_timeout']);
export function contentRetryPasses(env = process.env) {
  const raw = env.DOWNLOAD_CONTENT_RETRY_PASSES?.trim() ?? '';
  if (!/^[0-3]$/.test(raw)) return 0;
  return Number(raw);
}

// stopbook1031：DOWNLOAD_CONTENT_STOP_BOOK_PAGES=1 时把详情页/目录页并入正文停止点（缺省/其他值 = 关，零行为变化）。
// 动机（2026-10-31 phoenix 只读 + pc-linux 实网复现）：72h 内 24 本 manifest ≥90% 已抓、仅差末章即判 missing_chapters
// 整本作废换源；m.cuoceng 末章 #linkNext 指回详情页（bookUrl），停止点只含目录章节拦不住，详情页按正文规则取空
// → strict empty_content_page。legado 同义：末章「下一章」回目录/详情即视作本章结束。仅多章书生效（单章书沿用旧口径）。
// 副作用：章节地址本身重定向到详情/目录页时改报「跳转到目录中的其他章节」（chapter_failed）而非 empty_content_page。
export function contentStopBookPages(env = process.env) {
  return env.DOWNLOAD_CONTENT_STOP_BOOK_PAGES?.trim() === '1';
}

// breakeryield1031：DOWNLOAD_BREAKER_YIELD=1 时，任一阶段遇本机限速器熔断/日限（CircuitOpenError /
// DailyRequestBudgetError：host 级、请求没出网、到点自动恢复）立即停抓，当前章保持原状态（不判 failed），
// 按 source_unavailable + manifest.retry_cause='host_breaker' 收口（code=2）——回退层不标候选失败，
// 任务层按 host 忙排队（与 hostwait1031 同路），已抓章留作同源续传。真实 5xx/超时不在此列，照旧标失败。
// 缺省/其他值 = 关（零行为变化：逐章判 chapter_failed，连败熔断 → missing_chapters → 候选标 temporary 换源）。
// 动机（2026-10-31 phoenix 只读）：sfwx/itxtbook/zhkanshu 偶发 502 成串，共享账本连续 5 次即熔断 30min；
// 熔断后余下章节瞬时全判 chapter_failed，连败 50 收口（sfwx 01:36 / itxtbook 02:01 的连败收口时刻与账本
// breakerUntilMs−30min 吻合），抓到一半的源被标失败 48h、换源从头抓。
const BREAKER_ERROR_NAMES = new Set(['CircuitOpenError', 'DailyRequestBudgetError']);
export function breakerYield(env = process.env) {
  return env.DOWNLOAD_BREAKER_YIELD?.trim() === '1';
}

// recheckyield1031：DOWNLOAD_RECHECK_YIELD=1 时，正文跑完后的收尾目录复核遇瞬时不可达（code=2 toc），且已抓
// 章 ≥ 一半 ⇒ manifest.retry_cause='recheck_unavailable'：回退层不标候选失败（源刚刚还能抓，只是此刻抖），
// 任务层照常计次退避，下次同源续传（已抓章走缓存，只补目录与缺章）。下次连搜索都不通则照旧标失败，最多多试一轮。
// 缺省/其他值 = 关（零行为变化：复核失败 ⇒ 候选标 temporary 48h 换源从头抓）。
// 动机（2026-10-31 phoenix 只读，72h）：cuoceng 213/213（全章已抓）、bqquge 196/216、858/1588 均以 toc 阶段 source_unavailable 收口。
export function recheckYield(env = process.env) {
  return env.DOWNLOAD_RECHECK_YIELD?.trim() === '1';
}

// chapterresume1031：DOWNLOAD_RESUME_BY_CHAPTER=1 时，目录 hash 变了（连载追加新章等）也逐章续传：同源同书
// （sourceRevision、bookUrl 不变）且本章序号上的旧记录 url、章名都相同才复用缓存，缓存照旧核 sha256。
// 缺省/其他值 = 关（零行为变化：目录 hash 一变整本从头抓）。
// 动机（2026-10-31 phoenix 只读）：同书相邻两次运行 376 对里目录变了 89 对，51 对是纯追加，丢弃已抓 5439 章；
// sto66 f1355f 目录 1045→1046 后前 20 章重抓，本轮「有新抓」使 breakerguard 失效、熔断让出继续空转。
export function chapterResume(env = process.env) {
  return env.DOWNLOAD_RESUME_BY_CHAPTER?.trim() === '1';
}

// keepcache1031：DOWNLOAD_RESUME_KEEP_CACHED=1 时，缓存核 sha256 通过的章不再原样重写（atomic = 临时文件 + fsync + rename）。
// 缺省/其他值 = 关（逐字同改前）。内容同字节，跳过只省 IO：续传千章书每轮白做上千次 fsync；
// 跨实例种入的硬链接也因重写断开、各留一份（2026-10-31 生产：种入 940 章的检查点续跑后 940 个文件全成单链）。
export function keepCached(env = process.env) {
  return env.DOWNLOAD_RESUME_KEEP_CACHED?.trim() === '1';
}

// previewearly1031：DOWNLOAD_PREVIEW_EARLY=1 时付费墙预览（vipwall42 判据）在首轮逐章抓取中提前收口（缺省/其他值 = 关，零行为变化）。
// 两种情形提前判 preview_truncated：
// - 必中：目录 ≥ 50 章且短章（< 500 字）已过半——全书抓完中位数必 < 500，收尾闸门必判，后半本只是白抓；
// - 开头：已 done ≥ 50 章且全是短章（xs.cn/xs8.cn 首章起即 ~190 字）。仅「>100 章、开头 50 章全短、后文过半长章」的书会误判（换源、不发布）。
// 动机（2026-10-31 phoenix 只读，48h）：xs.cn/xs8.cn/hongxiu/cuoceng 15 本预览书逐章抓了约 9200 章（xs 系中位 186 字），
// 只有 3 本走到 preview_truncated，余下多以 missing_chapters（少数空页）/ download_failed 收口；每本白抓上千章才换源。
export function previewEarly(env = process.env) {
  return env.DOWNLOAD_PREVIEW_EARLY?.trim() === '1';
}
const PREVIEW_MIN_CHAPTERS = 50;
const PREVIEW_MAX_CHARS = 500;

// noticeskip1031：DOWNLOAD_NOTICE_PLACEHOLDER=1 时，章名是作者请假/无更/感言类公告、源站正文取空（empty_content_page /
// empty_content）的章写占位文本按 done 收口（缺省/其他值 = 关，零行为变化：整章 failed → 全书 missing_chapters 不发布）。
// 只认强公告词，「抱歉」「说明」「通知」等可能是正文章名的词不认；正文非空的公告章照常抓原文。
// 动机（2026-10-31 phoenix 只读 + pc-linux 实网复现）：kxdu/92dxs 近完本书的缺章多是「…今晚无更」「…晚上无更」，
// 源站该页只有「小编正在急急忙忙的手打」占位，同源重抓永远为空，整本因一条请假条作废换源。
const NOTICE_TITLE = /请假|无更|断更|停更|休更|今[天晚日]不更|请个假|感言/;
const NOTICE_TEXT = '（本章为作者公告，源站无正文。）';
export function noticePlaceholder(env = process.env) {
  return env.DOWNLOAD_NOTICE_PLACEHOLDER?.trim() === '1';
}

// noticeaside1031：DOWNLOAD_NOTICE_UNNUMBERED=1 时，「编号书」（目录 ≥ 20 章且 ≥ 90% 章名含「第 N 章/节/回」）里
// 章名不带编号、也不像正文（番外/楔子/序/尾声/终章/后记/外传/结局/引子/卷）的章，源站正文取空即写占位按 done 收口。
// 缺省/其他值 = 关（零行为变化）。与 noticeskip1031 独立；正文非空照常抓原文，编号章取空照旧 failed。
// 动机（2026-10-31 phoenix 只读，7 天）：book.qq 61 本 partial，空页章里只有 59 章是编号章，其余是「求月票」「更新说明」
// 类短标题作者话（标题中位 5 字，done 章 44506 章编号章占 99.99%）；noticeskip 只认强公告词，只救 10 本，加此判据可救 31 本。
const NUMBERED_TITLE = /第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回]/;
const STORY_TITLE = /番外|楔子|序|尾声|终章|后记|外传|结局|引子|卷/;
// asidenum1031：只排除不计入编号书判据——章名以序号打头（「123.标题」「（12）」「第 12 章」「一、」「Chapter 3」）多是正文，
// 取空照旧 failed。实证（2026-10-31 18:5x phoenix）：95dxs 一本 done 书里「NNN.标题」章取空被写成占位发布。
const ORDINAL_TITLE = /^\s*[(（【[]?\s*第?\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*(?:[章节回话集篇幕部]|[.．、:：,，_\-—\s)）】\]]|$)|chapter\s*\d/i;
const ASIDE_TEXT = '（本章为非编号章节，源站无正文，疑为作者公告。）';
export function noticeUnnumbered(env = process.env) {
  return env.DOWNLOAD_NOTICE_UNNUMBERED?.trim() === '1';
}
export function numberedBook(titles) {
  return titles.length >= 20 && titles.filter(t => NUMBERED_TITLE.test(t)).length >= titles.length * 0.9;
}

// chaperr1031：DOWNLOAD_CHAPTER_ERROR_KIND=1 时，白名单外的逐章失败（chapter.error='chapter_failed'）另记 chapter.error_kind =
// 「构造器名[:HTTP 状态][:枚举 code]」（code 取 error.code / SourcePolicyError 归类 / undici cause.code，均为常量形态，不含上游文本
// 与 URL）；补抓成功即删。缺省/其他值 = 关（零行为变化）。只是诊断字段，任何判据都不读它。
// 动机（2026-10-31 phoenix 只读，7 天）：43664 章 chapter_failed（kanshuw/itxtbook/sfwx/zhkanshu 每本零散数十章）分不出是
// 5xx/403、超时、连接重置还是正文跳转类策略拒绝，补抓/限速/熔断的调优无从下手。
export function chapterErrorKind(env = process.env) {
  return env.DOWNLOAD_CHAPTER_ERROR_KIND?.trim() === '1';
}
const CONST_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const SAFE_NAME = /^[A-Za-z]{1,32}$/;
export function errorKindOf(error) {
  // name 缺失（非 Error 抛出物）时退到构造器名；先判 typeof，免得 regex 把 undefined 字面量化成 "undefined"。
  const ctor = error?.constructor?.name;
  const name = typeof error?.name === 'string' && SAFE_NAME.test(error.name) ? error.name
    : typeof ctor === 'string' && SAFE_NAME.test(ctor) ? ctor : 'unknown';
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? `:${error.status}` : '';
  const own = typeof error?.code === 'string' ? error.code : error?.name === 'SourcePolicyError' ? policyCodeOf(error.message) : '';
  const code = CONST_CODE.test(own) ? own : typeof error?.cause?.code === 'string' && CONST_CODE.test(error.cause.code) ? error.cause.code : '';
  return name + status + (code ? `:${code}` : '');
}

// rulehint1031：DOWNLOAD_RULE_FAIL_HINT=1 时，download_failed 且异常是 RuleEngineError 的 manifest 另记 failure_hint =
// 规则求值失败的固定分类（按引擎自身的常量报错前缀归类，不落报错原文、规则与页面内容）。缺省/其他值 = 关（零行为变化）。
// 动机（2026-10-31 phoenix 只读，24h）：appi.kuwo.cn 15 本 RULE_EVAL_FAILED@toc、m.92dxs @detail，PC 用生产全链复现不出，
// 疑 phoenix 出口拿到的响应形态不同（如 JSON 接口回了 HTML 拦截页）；JSON_RULE_ON_HTML / JS_EXEC:SyntaxError 即可佐证，无需出网。
export function ruleFailHint(env = process.env) {
  return env.DOWNLOAD_RULE_FAIL_HINT?.trim() === '1';
}
const RULE_HINTS = [
  [/不能对 HTML 输入求值|在 HTML 输入上不是合法/, 'JSON_RULE_ON_HTML'],
  [/不能对 JSON (?:输入|条目)求值/, 'HTML_RULE_ON_JSON'],
  [/预算耗尽/, 'JS_BUDGET'],
  [/jsLib 求值失败/, 'JS_LIB'],
  [/宿主回调失败/, 'JS_HOST'],
  [/页面未取/, 'NET_PENDING'],
  [/^jsoup:/, 'JSOUP'],
  [/JS (?:输入|输出)过大/, 'JS_SIZE'],
  // 生产首例（21:06 后 95dxs @detail）落在旧的合并类 JS_RESULT，分不出沙箱没就绪还是规则结果形态不对，拆细。
  [/JS 沙箱(?:未就绪|初始化失败)/, 'JS_NOT_READY'],
  [/JS 沙箱异常/, 'JS_SANDBOX'],
  [/init JS/, 'JS_INIT'],
  [/列表 JS/, 'JS_LIST'],
  [/结果无法读取/, 'JS_READ'],
];
export function ruleHintOf(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const exec = /JS 执行失败：([A-Za-z]{1,32})/.exec(message);
  if (exec) return `JS_EXEC:${exec[1]}`;
  for (const [pattern, hint] of RULE_HINTS) if (pattern.test(message)) return hint;
  return 'OTHER';
}

// hostburst1030：按站「连抓 N 次即静置 M 毫秒」DOWNLOAD_HOST_BURST_PAUSE（"站=N/M,站=N/M"；站按 stationKeyOfHost
// 归一，www./m. 前缀互认；N 1..10000，M 封顶 600000）。缺省/未命中/非法项 = null（零行为变化）。
// 静置在章与章之间、operation 超时之外进行（M 可远大于 timeout-ms），计数含本次下载的全部请求（搜索/详情/目录）。
// 动机（2026-10-30 pc-linux 实测）：m.cuoceng.com 正文页按 IP 连续计数，第 11 次返回 400
// {"code":"swq-003",...请60秒后重试}；改 6.5s 匀速仍在第 11 次被拒（非滑动窗口），「1s 连抓 10 次 → 静置 62s」3 轮 30/30 成功。
// 默认节奏下每本恰好抓 10 章，第 11 章起连败 → 限速器熔断 → 余下章节与收尾目录全挂 CircuitOpenError
// （近 7 天 cuoceng manifest 全 partial、终态 source_unavailable）。
export function hostBurstPause(source, env = process.env) {
  const raw = env.DOWNLOAD_HOST_BURST_PAUSE?.trim();
  if (!raw) return null;
  const key = stationKeyOfUrl(source);
  if (!key) return null;
  for (const item of raw.split(',')) {
    const hit = /^\s*([a-z0-9.-]+)\s*=\s*(\d{1,5})\s*\/\s*(\d{1,7})\s*$/i.exec(item);
    if (!hit || stationKeyOfHost(hit[1]) !== key) continue;
    const every = Number(hit[2]);
    if (every < 1) return null;
    return { every, pauseMs: Math.min(Number(hit[3]), 600000) };
  }
  return null;
}

// diag1031：SourcePolicyError 不带 code，消息是本仓写死的中文（个别拼了规则键名或 JS 报错原文），按关键词归成
// 固定枚举再进 manifest，原文不落盘。顺序即优先级：「正文跳转到目录中的其他章节」归正文，不归跳转。
const POLICY_CODES = [
  [/安全验证/, 'POLICY_CHALLENGE'],
  [/退休/, 'POLICY_RETIRED'],
  [/字段 JS/, 'POLICY_FIELD_JS'],
  [/正文/, 'POLICY_CONTENT'],
  [/目录/, 'POLICY_TOC'],
  [/跳转/, 'POLICY_REDIRECT'],
  [/体积超限/, 'POLICY_SIZE'],
  [/搜索/, 'POLICY_SEARCH_RULE'],
  [/来源|地址/, 'POLICY_URL'],
];
export const policyCodeOf = message => POLICY_CODES.find(([pattern]) => pattern.test(String(message ?? '')))?.[1] ?? 'POLICY_OTHER';

// 身份判据的唯一实现：downloadBook 选候选、执行器扣额度前的身份预检（runtime-download/identity-precheck.ts）
// 与 builtin 引擎源回退（runtime-download/builtin-fallback.ts）共用。
//
// 41-IDLENIENT（2026-10-07）：判据改与**生产阅读器**同一口径 sourceBookMatches（src/lib/source-parser.ts），
// 不再用 canonicalBookKey 全等。旧判据过严，与阅读侧不对称，把阅读器能读的书判成身份不符：
//   - 站点作者字段带「著」/「作者：」/「@」修饰（book.qq「忘语 著」）——sourceBookMatches 经 knownSourceAuthor
//     剥掉后判等，旧 canonicalBookKey 不剥 ⇒ 误判；
//   - 源的 ruleBookInfo 不写 name/author（kxdu.net 详情页只有简介/封面）⇒ engineFetchDetail 返回 {}，
//     旧判据对空 detail 直接 false；阅读侧用 engineIdentityOf 把详情页缺的字段回落到**搜索候选行**再比。
// detail 与 candidate（搜索候选行，engineSearchBook 的 {title,author,bookUrl}）合并：详情页求值非空即覆盖，
// 为空则取候选行——与阅读器 engineIdentityOf(detail, result) 逐字同义。**回落目标必须是搜索候选行、不是任务
// 本身**：回落成任务会把「空详情」判成恒真（候选行与任务同名时尤其），门就形同虚设。
// 结果：凡阅读器判「是同一本书」的源，下载器同判；不同书名/不同作者仍判不符（只吸收同义写法，不放宽到同名异书）。
// builtin 候选行只有 {bookUrl}（无 title/author），detail 由 parseSourceIdentity 从 h1/meta 取，行为不变。
export const identityMatches = (detail, candidate, args) => {
  const identity = {
    title: detail.title ?? candidate?.title ?? '',
    author: detail.author ?? candidate?.author ?? '',
    ...(detail.alias ? { alias: detail.alias } : {}),
  };
  return sourceBookMatches({ title: args.title, author: args.author }, identity);
};

// One shared request slot covers search/detail/toc/content, redirects and alternate hosts.
// hooks（T3 任务层接缝，全部可选、向后兼容）：
//   signal      —— 外部租约/截止信号：触发时等价 SIGINT，中断抓取并把 partial 检查点落盘；
//   onProgress  —— 每次清单检查点（目录解析后、每章后、收尾）回调最新计数；抛错（租约丢失）
//                  立即中断下载，不吞成单章失败。
export async function downloadBook(m, args, resolveSource, transport = fetchSourceText, hooks = {}) {
  const dir = resolve(args.out ?? 'engine-download', hash(args.source + canonicalBookKey(args.title, args.author)).slice(0, 24));
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'download.lock');
  const lock = openSync(lockPath, 'wx');
  const manifestPath = join(dir, 'manifest.json');
  let previous;
  try { previous = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first attempt */ }
  // 正文格式不同（缺字段按 1）的检查点当作不存在：不续传、不沿用章节记录，全量重抓（见 ENGINE_CONTENT_FORMAT）。
  if ((previous?.contentFormat ?? 1) !== ENGINE_CONTENT_FORMAT) previous = undefined;
  const manifest = { schemaVersion: 1, contentFormat: ENGINE_CONTENT_FORMAT, status: 'partial', title: args.title, author: args.author, source: args.source, chapters: previous?.chapters ?? [], errors: [], generated_at: new Date().toISOString() };
  // chapterresume1031：沿用的章节记录连同续传判据一起带上——本轮在目录前（解析/搜索/详情）就失败时，
  // 落盘的检查点仍可被下一轮续传（关时这三项缺失，下一轮必然从头抓）。走到对应阶段即被本轮值覆盖。
  if (chapterResume() && previous) {
    for (const key of ['sourceRevision', 'bookUrl', 'tocHash']) if (typeof previous[key] === 'string') manifest[key] = previous[key];
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('interrupted'));
  const external = hooks.signal;
  const onExternalAbort = () => controller.abort(external.reason ?? new Error('interrupted'));
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('budget_exhausted')), args['budget-ms']);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let nextAt = 0;
  const burst = hostBurstPause(args.source);
  let burstCount = 0;
  // 计数到 N 即静置 M 后清零；中断/预算到点时抛 controller 的原因（interrupted/budget_exhausted），与 operation 同口径。
  const burstGate = async () => {
    if (!burst || burstCount < burst.every) return;
    await pause(burst.pauseMs, undefined, { signal: controller.signal }).catch(() => controller.signal.throwIfAborted());
    burstCount = 0;
  };
  let bytes = 0;
  let failureCode = 1;
  let feedbackError;
  let stage = 'resolve';
  const yieldOnBreaker = breakerYield();
  // breakerguard1031：本轮已有章失败、却一章没新抓到 ⇒ 熔断多半是本轮自己连败打开的（sto66 实证：续传后
  // 第 21 章起每轮都是同 5 章失败 → 熔断 → 让出，30m 后再来一遍，免费排队额度 32 次空转约 16h）。此时
  // 不让出，回到关开关口径（逐章判失败 → 候选标失败换源）。本轮有新抓（源是好的、偶发成串 5xx）或
  // 一章没失败（熔断是别处打开的，本轮没真试）才让出。
  let fetchedThisRun = 0, failedThisRun = 0;
  let rechecking = false; // 正文（含补抓轮）已跑完、进入收尾目录复核
  const isBreakerYield = error => yieldOnBreaker && !controller.signal.aborted && BREAKER_ERROR_NAMES.has(error?.name)
    && (fetchedThisRun > 0 || failedThisRun === 0);
  let lastCheckpoint = 0;
  // T3×P2 reconcile：两个节拍解耦——manifest 落盘按 5s 节流（P2-4 写放大修复），
  // onProgress 每次调用必发（T3 租约数据通道，每章上报；失权发现延迟不随写盘节流放大）。
  const checkpoint = async (force = true) => {
    manifest.chapters_done = manifest.chapters.filter(c => c.status === 'done').length;
    manifest.chars = manifest.chapters.reduce((n, c) => n + c.chars, 0);
    if (force || Date.now() - lastCheckpoint >= 5000) {
      atomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      lastCheckpoint = Date.now();
    }
    await hooks.onProgress?.({ chaptersDone: manifest.chapters_done, chaptersTotal: manifest.chapters_total ?? manifest.chapters.length, charsTotal: manifest.chars });
  };
  const operation = async fn => {
    const local = new AbortController();
    const timeout = setTimeout(() => local.abort(new Error('operation_timeout')), args['timeout-ms']);
    const signal = AbortSignal.any([controller.signal, local.signal]);
    const context = { signal, page: async url => {
      const page = await transport(url, { signal, timeoutMs: args['timeout-ms'], beforeRequest: async requestSignal => {
      requestSignal.throwIfAborted();
      const now = Date.now(), at = Math.max(now, nextAt);
      nextAt = at + args['rate-ms'];
      if (at > now) await pause(at - now, undefined, { signal: requestSignal });
      requestSignal.throwIfAborted();
      nextAt = Math.max(nextAt, Date.now() + args['rate-ms']);
      burstCount++;
      } });
      if (new URL(page.url).pathname !== new URL(url).pathname) throw new Error('response_path_mismatch');
      return page;
    } };
    try { signal.throwIfAborted(); return await sourceAbortable(Promise.resolve().then(() => fn(context)), signal); }
    finally { clearTimeout(timeout); local.abort(); }
  };
  try {
    const { source, builtin } = await operation(async ctx => {
      try { return await resolveSource(m, args.source, ctx.signal); }
      catch (error) { if (error.code === 2) failureCode = 2; throw error; }
    });
    manifest.sourceRevision = hash(JSON.stringify(source));
    const engine = builtin ? null : { url: source.url, name: source.name, searchUrl: source.searchUrl, compiled: m.compile.compileSource(source),
      origin: typeof source.rules?.bookSourceUrl === 'string' ? source.rules.bookSourceUrl : undefined };
    // dlsearch-1026：搜索词用清洗后的值（版本注记/国籍/角色词见 src/lib/search-key.ts），身份判据
    // identityMatches 仍用任务原值（args.title/args.author）——搜索词是「怎么找候选」，比对是「是不是这本书」。
    const searchKeys = searchKeysOf({ title: args.title, author: args.author });
    stage = 'search';
    const candidates = await operation(async ctx => {
      if (!builtin) return m.api.engineSearchBook(engine, searchKeys.title, ctx);
      const page = await ctx.page(m.parser.sourceSearchUrl(source.searchUrl, searchKeys.title, source.url));
      return m.parser.parseSourceSearch(page.text, page.url, searchKeys.title).map(bookUrl => ({ bookUrl }));
    });
    let selected;
    stage = 'detail';
    for (const candidate of candidates) {
      const detail = await operation(async ctx => {
        // book1028：搜索带出的书籍成员原样交给详情；详情带回的（补了 tocUrl）经 selected 交给目录。
        // itemvars1028：条目袋同样交给详情，详情带回的袋（以条目袋为初值）经 selected 交给目录。
        if (!builtin) return m.api.engineFetchDetail(engine, candidate.bookUrl, ctx, candidate.book, candidate.vars);
        return m.parser.parseSourceIdentity((await ctx.page(candidate.bookUrl)).text);
      });
      if (identityMatches(detail, candidate, args)) { selected = { ...candidate, ...detail }; break; }
    }
    // authbridge42：书名候选全被拒后的作者名回退轮。QQ 系书在镜像站按通行书名收录（队列名「少年羽皇」
    // vs 站名「帝临鸿蒙」），书名搜索天然失配 → 下载腿会把选源已命中的源又判成 0 候选
    // （identity_mismatch_or_no_candidate → markFailure 淘汰），选源/预检的改动就白烧出网。
    // 纯增量：书名路径逐字不变，只在书名候选一条都没选上时多跑一轮。
    // B′ 门与选源器、预检共用 authorBridgeAccepts：候选按 bookUrl 去重后须恰好 1 条且详情页作者门逐字对上；
    // 候选 >1（同作者多本，如 shidaxiaoshuo「魏风华」3 本诡事录系列）判不命中——没有书名证据时认哪一本都是猜。
    if (!selected && authorSearchKey(args.title, args.author)) {
      stage = 'search';
      const authorHits = authorBridgeCandidates(await operation(async ctx => {
        if (!builtin) return m.api.engineSearchBook(engine, searchKeys.author, ctx);
        const page = await ctx.page(m.parser.sourceSearchUrl(source.searchUrl, searchKeys.author, source.url));
        const urls = /^\/books\/details\d+\.html$/.test(new URL(page.url).pathname)
          ? [page.url]
          : m.parser.parseSourceDetailLinks(page.text, page.url, searchKeys.title);
        return urls.map(bookUrl => ({ bookUrl }));
      }));
      if (authorHits.length === 1) {
        stage = 'detail';
        const detail = await operation(async ctx => {
          if (!builtin) return m.api.engineFetchDetail(engine, authorHits[0].bookUrl, ctx, authorHits[0].book, authorHits[0].vars);
          return m.parser.parseSourceIdentity((await ctx.page(authorHits[0].bookUrl)).text);
        });
        if (authorBridgeAccepts(authorHits, detail, args)) selected = { ...authorHits[0], ...detail };
      }
    }
    if (!selected) throw new Error('identity_mismatch_or_no_candidate');
    manifest.bookUrl = selected.bookUrl;
    stage = 'toc';
    const toc = () => operation(async ctx => {
      if (!builtin) return (await m.api.engineFetchToc(engine, selected.tocUrl ?? selected.bookUrl, ctx, true, selected.vars, selected.book)).chapters;
      const page = await ctx.page(selected.bookUrl);
      return m.parser.parseSourceChapters(page.text, page.url);
    });
    const chapters = await toc();
    if (!chapters.length) throw new Error('empty_toc');
    manifest.tocHash = hash(JSON.stringify(chapters));
    manifest.chapters_total = chapters.length;
    manifest.chapters = chapters.map((c, index) => ({ index, title: c.title, url: c.url, chars: 0, status: 'pending', file: `${index}.txt` }));
    await checkpoint();
    if (chapters.length > args['max-chapters']) throw new Error('max_chapters');
    const resume = previous?.sourceRevision === manifest.sourceRevision && previous?.tocHash === manifest.tocHash && previous?.bookUrl === manifest.bookUrl;
    const sameBook = chapterResume() && previous?.sourceRevision === manifest.sourceRevision && previous?.bookUrl === manifest.bookUrl;
    stage = 'content';
    // dlstop42：停止点 = 整本目录（与阅读器 readerstop42 / 生产打标 EngineStopUrls 同口径）。站点「下一章」
    // 链的顺序可能与目录顺序不同（cuoceng 第 N 章的 linkNext 指向目录非相邻章），只传目录下一章拦不住，
    // 会静默把几章并进一个章文件；engineFetchContent 对数组命中其中任一即停，且自动剔除本章自身（真·章内
    // 分页不受影响）。单章书保持旧口径（字符串、含本章自身）：末章「下一页」常回绕首章，单章时即回绕自身，
    // 数组口径剔除本章后自指翻页会触发 pagination_cycle。只构造一次、循环外，逐章共享。
    const stopUrls = manifest.chapters.length > 1 ? manifest.chapters.map(c => c.url) : manifest.chapters[0]?.url;
    if (Array.isArray(stopUrls) && contentStopBookPages()) {
      for (const url of [selected.bookUrl, selected.tocUrl]) if (url && !stopUrls.includes(url)) stopUrls.push(url);
    }
    const failStreakLimit = contentFailStreak();
    let failStreak = 0;
    const asideBook = noticeUnnumbered() && numberedBook(manifest.chapters.map(c => c.title));
    const fetchChapter = async chapter => {
      controller.signal.throwIfAborted();
      try {
        const path = join(dir, chapter.file);
        const before = previous?.chapters?.[chapter.index];
        const prior = (resume || (sameBook && before?.url === chapter.url && before?.title === chapter.title)) && before;
        let text;
        if (prior?.status === 'done' && existsSync(path)) {
          const cached = readFileSync(path, 'utf8');
          if (hash(cached) === prior.sha256 && cached.trim()) text = cached;
        }
        let fresh = false;
        if (text === undefined) {
          await burstGate();
          const notice = noticePlaceholder() && NOTICE_TITLE.test(chapter.title);
          const aside = !notice && asideBook && !NUMBERED_TITLE.test(chapter.title) && !ORDINAL_TITLE.test(chapter.title) && !STORY_TITLE.test(chapter.title);
          text = await operation(async ctx => {
            // bookcontent1029：目录用过的书籍成员（详情带回）同样交给正文。
            if (!builtin) return (await m.api.engineFetchContent(engine, chapter.url, ctx, true, stopUrls, chapter.title, selected.book)).text;
            return m.parser.parseSourceChapterText((await ctx.page(chapter.url)).text, chapter.title);
          }).catch(error => {
            if ((notice || aside) && error?.message === 'empty_content_page') return '';
            throw error;
          });
          if (notice && !text.trim()) text = NOTICE_TEXT;
          else if (aside && !text.trim()) text = ASIDE_TEXT;
          fresh = true;
        }
        if (!text.trim()) throw new Error('empty_content');
        bytes += Buffer.byteLength(chapter.title + '\n\n' + text + '\n\n');
        if (bytes > MAX_BOOK_BYTES) throw new Error('size_limit');
        if (fresh || !keepCached()) atomic(path, text);
        Object.assign(chapter, { status: 'done', chars: [...text].length, sha256: hash(text) });
        delete chapter.error; // 补抓成功的章不留上一轮的失败码
        delete chapter.error_kind;
        failStreak = 0;
        if (fresh) fetchedThisRun += 1;
      } catch (error) {
        if (isLimiterFeedbackError(error) || isHostGateError(error)) throw error;
        if (isBreakerYield(error)) throw error; // breakeryield1031：熔断不算本章失败，整本让出
        chapter.status = 'failed';
        failedThisRun += 1;
        // Do not persist upstream messages, URLs or credentials in diagnostics.
        chapter.error = knownError.test(error.message) ? error.message : 'chapter_failed';
        if (chapter.error === 'chapter_failed' && chapterErrorKind()) chapter.error_kind = errorKindOf(error);
        else delete chapter.error_kind;
        if (chapter.error === 'size_limit' || controller.signal.aborted) throw error;
        if (failStreakLimit > 0 && ++failStreak >= failStreakLimit) {
          manifest.content_fail_streak = failStreak;
          throw new Error('missing_chapters');
        }
      }
      await checkpoint(false);
    };
    const earlyPreview = previewEarly();
    let doneCount = 0, shortCount = 0, anyLong = false;
    for (const chapter of manifest.chapters) {
      await fetchChapter(chapter);
      if (!earlyPreview || chapter.status !== 'done') continue;
      doneCount += 1;
      if (chapter.chars < PREVIEW_MAX_CHARS) shortCount += 1; else anyLong = true;
      const total = manifest.chapters.length;
      if (total >= PREVIEW_MIN_CHAPTERS && (shortCount > Math.floor(total / 2) || (doneCount >= PREVIEW_MIN_CHAPTERS && !anyLong))) {
        throw new Error('preview_truncated');
      }
    }
    // retrypass1030：瞬时类失败章补抓（见 contentRetryPasses）；关时 0 轮，与改前逐字同序。
    for (let pass = contentRetryPasses(); pass > 0; pass -= 1) {
      const again = manifest.chapters.filter(c => c.status === 'failed' && RETRYABLE_CHAPTER_ERRORS.has(c.error));
      if (!again.length) break;
      await pause(1000, undefined, { signal: controller.signal }).catch(() => controller.signal.throwIfAborted());
      failStreak = 0;
      for (const chapter of again) await fetchChapter(chapter);
    }
    stage = 'toc';
    rechecking = true;
    await burstGate();
    if (hash(JSON.stringify(await toc())) !== manifest.tocHash) throw new Error('toc_changed');
    if (manifest.chapters.some(c => c.status !== 'done')) throw new Error('missing_chapters');
    // vipwall42：付费墙预览识别（4393 实证：阅文系 chuangshi/yunqi 对 VIP 章返回 ~250-350 字预览文本，
    // 引擎当正常章存为 done，全书 done 后晋升发布——448 本 done 里 75 本章均 <500 字、书仓已发布 96 本）。
    // 判据：done 章字符数中位数 < 500 且章数 ≥ 50（免费章 2000+ 字、预览 ~250；小书短章不判，免误伤）。
    // 触发时按 preview_truncated partial 收口（零发布），16 轮退避换源重试免费源。
    {
      const doneChars = manifest.chapters.filter(c => c.status === 'done').map(c => c.chars).sort((a, b) => a - b);
      if (doneChars.length >= PREVIEW_MIN_CHAPTERS && doneChars[Math.floor(doneChars.length / 2)] < PREVIEW_MAX_CHARS) throw new Error('preview_truncated');
    }
    const txt = manifest.chapters.map(c => `${c.title}\n\n${readFileSync(join(dir, c.file), 'utf8')}\n\n`).join('');
    atomic(join(dir, 'book.txt'), txt);
    manifest.artifact = { file: 'book.txt', sha256: hash(txt), bytes: Buffer.byteLength(txt) };
    manifest.status = 'done';
  } catch (error) {
    if (isLimiterFeedbackError(error)) {
      feedbackError = error;
      manifest.errors.push('limiter_feedback_unavailable');
      throw error;
    }
    if (isHostGateError(error)) throw error;
    // 外部中断（停机/租约/总预算）时的请求失败是被中止，不是书源不可达。
    if (SOURCE_STAGES.has(stage) && !controller.signal.aborted && isSourceUnavailableError(error)) failureCode = 2;
    if (isBreakerYield(error)) { failureCode = 2; manifest.retry_cause = 'host_breaker'; }
    else if (failureCode === 2 && rechecking && recheckYield()
      && manifest.chapters.filter(c => c.status === 'done').length * 2 >= manifest.chapters.length) manifest.retry_cause = 'recheck_unavailable';
    if (failureCode === 2) manifest.failure_stage = stage; // 固定枚举，不含上游细节
    manifest.errors.push(failureCode === 2 ? 'source_unavailable' : knownError.test(error.message) ? error.message : 'download_failed');
    // dlfail42：白名单外错误被脱敏成 download_failed 时记 Error 构造器名（TypeError 等，不含上游文本），
    // 供桥层透传进日志定位「5 秒速败」类失败的结构（阶段 + 异常类别）。
    if (failureCode !== 2 && !knownError.test(error.message)) {
      manifest.failure_name = /^[A-Za-z]{1,32}$/.test(error?.name) ? error.name : 'unknown';
      // diag1030：再记阶段与固定枚举 code（RuleEngineError.code 等，均为常量、不含上游文本）——只有构造器名时
      // 生产只看得到「RuleEngineError」，定位不到哪一步哪类规则。failure_stage 专供 source_unavailable 退避，故另起字段。
      manifest.failure_phase = stage;
      const code = typeof error?.code === 'string' ? error.code : error?.name === 'SourcePolicyError' ? policyCodeOf(error.message) : '';
      if (/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) manifest.failure_code = code;
      if (manifest.failure_name === 'RuleEngineError' && ruleFailHint()) manifest.failure_hint = ruleHintOf(error);
    }
  } finally {
    try {
      clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
      if (external) external.removeEventListener?.('abort', onExternalAbort);
      try { await checkpoint(); } finally {
        closeSync(lock); unlinkSync(lockPath);
      }
    } catch (cleanupError) {
      if (feedbackError === undefined) throw cleanupError;
      throw Object.assign(
        new AggregateError([feedbackError, cleanupError], 'Limiter feedback cleanup failed', { cause: feedbackError }),
        {
          name: 'LimiterFeedbackCleanupError',
          code: 'LIMITER_FEEDBACK_UNAVAILABLE',
          origin: 'limiter-feedback',
          persistenceOutcome: 'unknown',
        },
      );
    }
  }
  return { manifest, manifestPath, code: manifest.status === 'done' ? 0 : failureCode };
}
