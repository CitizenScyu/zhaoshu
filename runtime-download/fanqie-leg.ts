// fanqie1106：番茄下载渠道 DOWNLOAD_FANQIE（=1 开；缺省关，零行为变化）。
//
// 动机（2026-11-06 phoenix 只读）：4000+ 本卡在 source_unavailable/no_candidates，免费站收录不到；随机 60 本里
// 8 本在番茄书名+作者精确命中。用户的番茄下载器（POf-L Tauri）按需起容器、不常驻（deploy/phoenix/fanqie-dl/），
// 整本干净，全机串行（flock）。
//
// worker 是 NoNewPrivileges + ProtectSystem=strict，sudo/docker 都用不了，经 systemd socket 激活请求：
// 连 /run/fanqie-dl.sock 发书号，收 JSON 行；断开连接即停下载。平时没有任何进程在跑（只有 PID1 持 socket）。
//
// 流程：预检按（书名, 作者）查番茄搜索（共享限速，结果落 memo），命中就跳过原预检和扫池；下载腿拿不到（失败/
// 残缺）退回原腿走免费源，下载器被占用则排队（host_occupied，不计 attempt）。TXT 去掉文件头、按目录标题切章，
// 重排成引擎同款 `标题\n\n正文\n\n` 并给 chapterRanges；DOWNLOAD_TITLE_CLEAN 开时标题同引擎一样剥附言尾巴。
// 日额度和熔断靠 <dir>/events-<UTC 日期>.log 追加记录（20 实例共用；O_APPEND 无竞争，当日 0 点起重新计）。
// 文件只存书号和原因码，不存书名、作者。读写失败一律当无记忆（优化不是门，退回免费源）。
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { cleanChapterHeadings, titleClean } from '../scripts/engine-download.mjs';
import type { AdapterOutcome, SourceAdapter, TaskRow } from '../src/lib/download-worker';
import type { TxtChapter } from '../src/lib/txt-chapters';
import type { RateLimiterLike } from './engine';
import type { PrecheckHook, PrecheckResult } from './executor';

export const FANQIE_SOCKET = '/run/fanqie-dl.sock';
export const FANQIE_DAILY_DEFAULT = 200;
/** 单次请求上限：等锁 + 单本预算（fanqie-dl 300+1500s）+ 余量。 */
export const FANQIE_REQUEST_TIMEOUT_MS = 40 * 60_000;
/** 连续几次失败熔断、熔断多久：风控情况未知，宁可早停。 */
export const FANQIE_BREAKER_FAILS = 5;
export const FANQIE_BREAKER_PAUSE_MS = 3 * 60 * 60_000;
export const FANQIE_HIT_TTL_MS = 30 * 24 * 60 * 60_000;
export const FANQIE_MISS_TTL_MS = 7 * 24 * 60 * 60_000;
/** 比照 stub1105：整本不足 3000 字不算拿到书。 */
const MIN_BOOK_CHARS = 3000;
/**
 * 解不出的字（U+FFFD、PUA）每 5 万字至多 1 处仍收：同一本每次下载都一样（11-07 长生道 12 处「衡」、仙墓 1 处拟声词），
 * 拒收只会让书永远落回免费源；常用字解不出则远超此数。
 */
const DAMAGED_CHAR = /[\uFFFD\uE000-\uF8FF]/g;
const CHARS_PER_DAMAGED = 50_000;
/** 下载器被占用时 fanqie-dl 的退出码。 */
const RC_BUSY = 75;
/** 通道自身的故障（界面被遮挡、自动化异常、容器没出结果、产物读不到）不怪这本书：只计熔断，不落 failed memo。 */
const CHANNEL_FAULT = /^(exception|no_search_input|no_result|unreadable)\b/;

const SEARCH_URL = 'https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1/?device_platform=android&aid=1967&offset=0&q=';

export function fanqieEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DOWNLOAD_FANQIE?.trim() === '1';
}

export function fanqieDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.DOWNLOAD_FANQIE_DAILY);
  return Number.isSafeInteger(value) && value > 0 ? value : FANQIE_DAILY_DEFAULT;
}

/** workDir = <base>/<inst-N>/<work> 的多实例布局 ⇒ <base>/fanqie；否则 <workDir>/fanqie。 */
export function fanqieDir(workDir: string): string {
  const inst = dirname(workDir);
  return /\d$/.test(basename(inst)) ? join(dirname(inst), 'fanqie') : join(workDir, 'fanqie');
}

/** 书名/作者比对口径：全半角归一、去标点空白、小写。 */
export function normalizeName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

interface SearchRow { book_id?: unknown; title?: unknown; author?: unknown; creation_status?: unknown }

/** 书名+作者都精确相等才算；同名同作者多本优先完结（creation_status=0）。 */
export function pickFanqieBook(rows: readonly SearchRow[], title: string, author: string): string | null {
  const wantTitle = normalizeName(title);
  const wantAuthor = normalizeName(author);
  if (!wantTitle || !wantAuthor) return null;
  const hits = rows.filter(row => typeof row.title === 'string' && typeof row.author === 'string'
    && /^\d{15,20}$/.test(String(row.book_id))
    && normalizeName(row.title) === wantTitle && normalizeName(row.author) === wantAuthor);
  const best = hits.find(row => Number(row.creation_status) === 0) ?? hits[0];
  return best ? String(best.book_id) : null;
}

export interface RebuiltBook { txt: string; chapterRanges: TxtChapter[]; charsTotal: number }

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function chineseNumber(text: string): number {
  if (!/[十百千万]/.test(text)) return Number([...text].map(c => CN_DIGIT[c]).join(''));
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const c of text) {
    if (c in CN_DIGIT) digit = CN_DIGIT[c];
    else if (c === '万') {
      total += (section + digit) * 10_000;
      section = 0;
      digit = 0;
    } else {
      section += (digit || 1) * CN_UNIT[c];
      digit = 0;
    }
  }
  return total + section + digit;
}

/** 下载器写 TXT 章首时把「第一章」改写成「第1章」，标题其余部分照抄目录（11-06 实测）。 */
function digitChapterNumber(title: string): string {
  return title.replace(/第([零〇一二两三四五六七八九十百千万]+)(?=[章节回卷集话部篇])/g, (_, n: string) => `第${chineseNumber(n)}`);
}

/** 章标题比对口径：章号转数字后再去标点空白比。 */
export function titleKey(title: string): string {
  return normalizeName(digitChapterNumber(title.normalize('NFKC')));
}

/**
 * 下载器写 TXT 的章序与网页目录可能有局部出入（11-06 不灭武尊 6877 章里两处标错章号的章节各错开一位），
 * 按目录顺序找不齐时，允许标题行对应到目录里向后这么多条以内。
 */
const TOC_LOOKAHEAD = 10;

/**
 * lineKeys[i] 非空 = 第 i 行是独立成行的目录标题。逐行对应到「最靠前的未用目录条目」起 lookahead 条以内的同名条目；
 * lookahead=0 即严格按目录顺序。全部条目都对应上才算，回 [行号, 目录序号] 按 TXT 顺序。
 */
function locateChapters(lineKeys: readonly string[], keys: readonly string[], lookahead: number) {
  const used = new Uint8Array(keys.length);
  const starts: { line: number; toc: number }[] = [];
  let next = 0;
  for (let i = 0; i < lineKeys.length && next < keys.length; i++) {
    if (!lineKeys[i]) continue;
    for (let j = next; j <= Math.min(keys.length - 1, next + lookahead); j++) {
      if (!used[j] && keys[j] === lineKeys[i]) {
        used[j] = 1;
        starts.push({ line: i, toc: j });
        break;
      }
    }
    while (next < keys.length && used[next]) next++;
  }
  return starts.length === keys.length ? starts : null;
}

/**
 * 同一目录标题独立成行的次数多于目录条数时，多出来的是作者写在正文里的标题（章首前后再写一遍、上一章末的预告），
 * 归一化后同名但标点空白有出入（11-06 万古第一神 15 处，作者那行在章首前后都有）。下载器写的章首与目录逐字相同，
 * 逐字相同的恰好够数就只认它们、其余清掉当正文；裁决不了的原样留给后面的匹配。
 */
function dropRepeatedHeads(lines: readonly string[], lineKeys: string[], titles: readonly string[], keys: readonly string[]) {
  const toc = new Map<string, { count: number; heads: Set<string> }>();
  titles.forEach((title, j) => {
    const entry = toc.get(keys[j]) ?? { count: 0, heads: new Set<string>() };
    entry.count++;
    entry.heads.add(title.trim()).add(digitChapterNumber(title.trim()));
    toc.set(keys[j], entry);
  });
  const found = new Map<string, number[]>();
  lineKeys.forEach((key, i) => {
    if (key) found.set(key, [...(found.get(key) ?? []), i]);
  });
  for (const [key, at] of found) {
    const { count, heads } = toc.get(key)!;
    if (at.length <= count) continue;
    const exact = at.filter(i => heads.has(lines[i].trim()));
    if (exact.length === count) for (const i of at) if (!exact.includes(i)) lineKeys[i] = '';
  }
}

/**
 * 番茄 TXT → 引擎格式。文件头（书籍信息/简介）到分隔线为止；章节按目录标题找整行（前后都是空行），
 * 不靠「第N章」正则——番外、后记这类标题没有章号。正文里重复的标题行先按逐字相同裁掉；再严格按目录顺序找；
 * 找不齐再容许局部错位，但此时要求独立成行的目录标题恰好与目录一一对应（多一行都不认）。
 * 章节按目录顺序输出、标题以目录为准；找不齐返回 null（不猜）。headings 只换输出标题（标题清洗），切章仍按 titles。
 */
export function rebuildFanqieTxt(raw: string, titles: readonly string[], headings: readonly string[] = titles): RebuiltBook | null {
  if (!titles.length) return null;
  const rule = /^—{20,}$/m.exec(raw);
  if (!rule) return null;
  const lines = raw.slice(rule.index + rule[0].length).replace(/\r\n/g, '\n').split('\n');
  const keys = titles.map(titleKey);
  const keySet = new Set(keys);
  const lineKeys = lines.map((line, i) => {
    if (lines[i - 1]?.trim() || lines[i + 1]?.trim()) return '';
    const key = titleKey(line);
    return key && keySet.has(key) ? key : '';
  });
  dropRepeatedHeads(lines, lineKeys, titles, keys);
  const starts = locateChapters(lineKeys, keys, 0)
    ?? (lineKeys.filter(Boolean).length === keys.length ? locateChapters(lineKeys, keys, TOC_LOOKAHEAD) : null);
  if (!starts) return null;
  const bodies: string[] = [];
  starts.forEach(({ line, toc }, k) => {
    bodies[toc] = lines.slice(line + 1, starts[k + 1]?.line ?? lines.length).join('\n').trim();
  });
  const parts: string[] = [];
  const chapterRanges: TxtChapter[] = [];
  let charsTotal = 0;
  let byte = 0;
  bodies.forEach((body, index) => {
    const title = (headings[index] ?? titles[index]).trim();
    const part = `${title}\n\n${body}\n\n`;
    const size = Buffer.byteLength(part, 'utf8');
    parts.push(part);
    chapterRanges.push({ index, title, startByte: byte, endByte: byte + size });
    charsTotal += [...body].length;
    byte += size;
  });
  return { txt: parts.join(''), chapterRanges, charsTotal };
}

export interface FanqieResult {
  status?: string; reason?: string; file?: string; titles?: unknown;
  missing?: number; pua?: number; replacement?: number; seconds?: number;
}
export interface FanqieReply { rc: number | null; result: FanqieResult | null }

/** 一次请求一条连接：发书号、收到连接关闭为止；signal 中止即断开（服务端据此停下载）。 */
export function askFanqieChannel(socketPath: string, bookId: string, signal: AbortSignal,
  timeoutMs = FANQIE_REQUEST_TIMEOUT_MS): Promise<FanqieReply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const socket = connect(socketPath);
    let buffer = '';
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); socket.destroy(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error('FANQIE_TIMEOUT')); }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${bookId}\n`));
    socket.on('data', (chunk: string) => { buffer += chunk; });
    socket.on('error', (error) => { cleanup(); reject(error); });
    socket.on('close', () => {
      cleanup();
      const reply: FanqieReply = { rc: null, result: null };
      for (const line of buffer.split('\n')) {
        try {
          const parsed = JSON.parse(line) as FanqieResult & { rc?: unknown; book_id?: unknown };
          if (typeof parsed.rc === 'number') reply.rc = parsed.rc;
          else if (parsed.book_id === bookId) reply.result = parsed;
        } catch { /* 空行/半行 */ }
      }
      resolve(reply);
    });
  });
}

const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 搜索接口的取文本。novel.snssdk.com 不在书源 host 门（内建 + 准入池）里，fetchSourceText 必拒
 * （金丝雀实测 SourcePolicyError），故不走书源 transport，只借共享限速许可（同 host 20 实例合计 QPS≤1）。
 * 没有限速器就不发请求（风控红线优先于命中率）。只连固定 https 地址、不跟跳转、限体积。
 */
export function createFanqieSearchFetch(limiter: RateLimiterLike | undefined,
  fetchImpl: typeof fetch = fetch): (url: string, signal: AbortSignal) => Promise<string> {
  return async (url, signal) => {
    if (!limiter) throw Object.assign(new Error('FANQIE_SEARCH_NO_LIMITER'), { code: 'NO_LIMITER' });
    if (!url.startsWith(SEARCH_URL)) throw Object.assign(new Error('FANQIE_SEARCH_URL'), { code: 'BAD_URL' });
    const host = new URL(url).hostname;
    const permit = await limiter.acquire(host, { signal });
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]), redirect: 'error' });
    } catch (error) {
      if (!signal.aborted) await limiter.recordFailure?.(host, { permit });
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      await limiter.recordFailure?.(host, { permit, ...(response.status === 429 ? { retryAfterMs: 60_000 } : {}) });
      throw Object.assign(new Error('FANQIE_SEARCH_HTTP'), { code: `HTTP_${response.status}` });
    }
    const text = await response.text();
    if (text.length > SEARCH_MAX_BYTES) throw Object.assign(new Error('FANQIE_SEARCH_TOO_LARGE'), { code: 'TOO_LARGE' });
    await limiter.recordSuccess?.(host, { permit });
    return text;
  };
}

export interface FanqieLegOptions {
  /** 共享状态目录（memo/、out/、events-*.log）。 */
  dir: string;
  socketPath?: string;
  /** 走共享限速的取文本（生产 = createFanqieSearchFetch）。 */
  fetchText: (url: string, signal: AbortSignal) => Promise<string>;
  dailyLimit?: number;
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  // ---- 测试注入缝 ----
  ask?: typeof askFanqieChannel;
  now?: () => number;
}

export interface FanqieLeg {
  wrapPrecheck(inner: PrecheckHook): PrecheckHook;
  wrapAdapter(inner: SourceAdapter): SourceAdapter;
}

type MemoRecord = { at: number; id?: string; failed?: true };

export function createFanqieLeg(options: FanqieLegOptions): FanqieLeg {
  const { dir, fetchText } = options;
  const socketPath = options.socketPath ?? FANQIE_SOCKET;
  const dailyLimit = options.dailyLimit ?? FANQIE_DAILY_DEFAULT;
  const log = options.log ?? (() => {});
  const ask = options.ask ?? askFanqieChannel;
  const now = options.now ?? Date.now;
  const memoDir = join(dir, 'memo');
  const outDir = join(dir, 'out');
  // 本进程串行领任务，预检与下载腿之间靠它传书号（同 builtin-fallback 的 planned）。
  let planned: { taskId: number; bookId: string } | null = null;

  const memoFile = (task: TaskRow) => {
    const key = `${normalizeName(task.title)}\0${normalizeName(task.author)}`;
    return join(memoDir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  };
  const readMemo = (task: TaskRow): MemoRecord | null => {
    try {
      const record = JSON.parse(readFileSync(memoFile(task), 'utf8')) as MemoRecord;
      const age = now() - record.at;
      return age >= 0 && age < (record.id ? FANQIE_HIT_TTL_MS : FANQIE_MISS_TTL_MS) ? record : null;
    } catch {
      return null;
    }
  };
  const writeMemo = (task: TaskRow, record: Omit<MemoRecord, 'at'>) => {
    try {
      mkdirSync(memoDir, { recursive: true });
      const file = memoFile(task);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...record, at: now() }));
      renameSync(tmp, file);
    } catch { /* 记不上 = 下次再查 */ }
  };

  const eventsFile = () => join(dir, `events-${new Date(now()).toISOString().slice(0, 10)}.log`);
  const recordEvent = (kind: 'ok' | 'fail', bookId: string, reason: string) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(eventsFile(), `${kind} ${bookId} ${reason}\n`);
    } catch { /* 记不上只影响额度和熔断计数 */ }
  };
  /** 今日额度未满且未熔断。熔断到期放行：再失败时事件文件 mtime 刷新，重新计时。 */
  const channelOpen = (): boolean => {
    const file = eventsFile();
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return true;
    }
    if (lines.length >= dailyLimit) return false;
    const tail = lines.slice(-FANQIE_BREAKER_FAILS);
    if (tail.length < FANQIE_BREAKER_FAILS || !tail.every(line => line.startsWith('fail '))) return true;
    try {
      return now() - statSync(file).mtimeMs >= FANQIE_BREAKER_PAUSE_MS;
    } catch {
      return true;
    }
  };

  /** 番茄书号；未命中、通道关闭或搜索出错回 null（出错不落 memo，下次再查）。 */
  const resolveBook = async (task: TaskRow, signal: AbortSignal): Promise<string | null> => {
    if (!task.author?.trim() || !channelOpen()) return null;
    const memo = readMemo(task);
    if (memo) return memo.id ?? null;
    try {
      const reply = JSON.parse(await fetchText(SEARCH_URL + encodeURIComponent(task.title), signal)) as {
        code?: unknown; data?: { ret_data?: unknown };
      };
      if (reply.code !== 0) throw new Error('FANQIE_SEARCH_CODE');
      const rows = Array.isArray(reply.data?.ret_data) ? reply.data.ret_data as SearchRow[] : [];
      const id = pickFanqieBook(rows, task.title, task.author);
      writeMemo(task, id ? { id } : {});
      return id;
    } catch (error) {
      signal.throwIfAborted();
      log('error', '番茄搜索失败', { taskId: task.id, code: (error as { code?: unknown } | null)?.code ?? (error as Error)?.name });
      return null;
    }
  };

  /** 读回并重排；书在番茄拿不到时回失败原因码。下载产物读完即删（重试重新下）。 */
  const collect = (result: FanqieResult | null): RebuiltBook & { chapters: number; damaged: number } | string => {
    const name = typeof result?.file === 'string' ? basename(result.file) : '';
    let raw: string | null = null;
    if (name) {
      const path = join(outDir, name);
      try {
        raw = readFileSync(path, 'utf8');
        unlinkSync(path);
      } catch { /* 下面按 unreadable 收口 */ }
    }
    if (!result) return 'no_result';
    // fq_run 把缺章和解不出的字都判 incomplete：不缺章的交给下面按字数裁。
    const usable = result.status === 'done' || result.status === 'exists' || (result.status === 'incomplete' && !result.missing);
    if (!usable) return result.reason ?? result.status ?? 'no_result';
    if (raw === null) return 'unreadable';
    if (result.missing) return 'text_damaged';
    const titles = Array.isArray(result.titles) ? result.titles.filter((t): t is string => typeof t === 'string') : [];
    const book = rebuildFanqieTxt(raw, titles, titleClean() ? cleanChapterHeadings(titles) : titles);
    if (!book) return 'rebuild_failed';
    if (book.charsTotal < MIN_BOOK_CHARS) return 'too_short';
    const damaged = book.txt.match(DAMAGED_CHAR)?.length ?? 0;
    if (damaged * CHARS_PER_DAMAGED > book.charsTotal) return 'text_damaged';
    return { ...book, chapters: titles.length, damaged };
  };

  return {
    wrapPrecheck(inner) {
      return async (task, signal = new AbortController().signal): Promise<PrecheckResult> => {
        planned = null;
        const bookId = await resolveBook(task, signal);
        signal.throwIfAborted();
        if (!bookId) return inner(task, signal);
        planned = { taskId: task.id, bookId };
        log('info', '番茄渠道命中', { taskId: task.id, bookId });
        return { ok: true };
      };
    },

    wrapAdapter(inner) {
      return {
        kind: inner.kind,
        async download(task, context): Promise<AdapterOutcome> {
          const plan = planned?.taskId === task.id ? planned : null;
          planned = null;
          if (!plan) return inner.download(task, context);
          const { bookId } = plan;
          let reply: FanqieReply;
          try {
            reply = await ask(socketPath, bookId, context.signal);
          } catch (error) {
            // 中止交原腿按其语义收口；通道本身坏了（socket 没起）不怪这本书，照走免费源。
            if (!context.signal.aborted) log('error', '番茄渠道不可用', { taskId: task.id, code: (error as { code?: unknown } | null)?.code ?? (error as Error)?.message });
            return inner.download(task, context);
          }
          if (context.signal.aborted) return inner.download(task, context);
          // 占用：flock 等满（75），或超过 MaxConnections 被直接关连接（什么都没收到）。
          if (reply.rc === RC_BUSY || (reply.rc === null && !reply.result)) {
            log('info', '番茄渠道占用，排队', { taskId: task.id, bookId });
            return { kind: 'incomplete', reason: 'source_unavailable', stage: 'fanqie', retryCause: 'host_occupied',
              chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
          }
          const book = collect(reply.result);
          if (typeof book === 'string') {
            recordEvent('fail', bookId, book.replace(/\W+/g, '_').slice(0, 40));
            if (!CHANNEL_FAULT.test(book)) writeMemo(task, { failed: true });
            log('info', '番茄渠道下载', { taskId: task.id, bookId, outcome: 'failed', reason: book.slice(0, 80) });
            return inner.download(task, context);
          }
          recordEvent('ok', bookId, 'done');
          log('info', '番茄渠道下载', { taskId: task.id, bookId, outcome: 'done', chapters: book.chapters,
            chars: book.charsTotal, damaged: book.damaged, seconds: reply.result?.seconds });
          // 任务行的章数/字数只经 progress 写入（下载列表与统计读它）。
          await context.progress({ chaptersDone: book.chapters, chaptersTotal: book.chapters, charsTotal: book.charsTotal });
          return { kind: 'complete', txt: book.txt, chaptersTotal: book.chapters, chaptersDone: book.chapters,
            charsTotal: book.charsTotal, chapterRanges: book.chapterRanges };
        },
      };
    },
  };
}
