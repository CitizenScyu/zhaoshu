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
// 重排成引擎同款 `标题\n\n正文\n\n` 并给 chapterRanges。
// 日额度和熔断靠 <dir>/events-<UTC 日期>.log 追加记录（20 实例共用；O_APPEND 无竞争，当日 0 点起重新计）。
// 文件只存书号和原因码，不存书名、作者。读写失败一律当无记忆（优化不是门，退回免费源）。
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
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
/** 下载器被占用时 fanqie-dl 的退出码。 */
const RC_BUSY = 75;

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

const squash = (text: string) => text.replace(/\s+/g, '');

/**
 * 番茄 TXT → 引擎格式。文件头（书籍信息/简介）到分隔线为止；章节按目录标题顺序逐个找整行（前后都是空行），
 * 不靠「第N章」正则——番外、后记这类标题没有章号。目录标题有一个找不到就返回 null（不猜）。
 */
export function rebuildFanqieTxt(raw: string, titles: readonly string[]): RebuiltBook | null {
  if (!titles.length) return null;
  const rule = /^—{20,}$/m.exec(raw);
  if (!rule) return null;
  const lines = raw.slice(rule.index + rule[0].length).replace(/\r\n/g, '\n').split('\n');
  const starts: number[] = [];
  for (let i = 0; i < lines.length && starts.length < titles.length; i++) {
    const line = squash(lines[i]);
    if (line && line === squash(titles[starts.length]) && !lines[i - 1]?.trim() && !lines[i + 1]?.trim()) starts.push(i);
  }
  if (starts.length !== titles.length) return null;
  const parts: string[] = [];
  const chapterRanges: TxtChapter[] = [];
  let charsTotal = 0;
  let byte = 0;
  starts.forEach((start, index) => {
    const title = titles[index].trim();
    const body = lines.slice(start + 1, starts[index + 1] ?? lines.length).join('\n').trim();
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
  const collect = (result: FanqieResult | null): RebuiltBook & { chapters: number } | string => {
    const name = typeof result?.file === 'string' ? basename(result.file) : '';
    let raw: string | null = null;
    if (name) {
      const path = join(outDir, name);
      try {
        raw = readFileSync(path, 'utf8');
        unlinkSync(path);
      } catch { /* 下面按 unreadable 收口 */ }
    }
    if (result?.status !== 'done' && result?.status !== 'exists') return result?.reason ?? result?.status ?? 'no_result';
    if (raw === null) return 'unreadable';
    if (result.missing || result.pua || result.replacement) return 'text_damaged';
    const titles = Array.isArray(result.titles) ? result.titles.filter((t): t is string => typeof t === 'string') : [];
    const book = rebuildFanqieTxt(raw, titles);
    if (!book) return 'rebuild_failed';
    if (book.charsTotal < MIN_BOOK_CHARS) return 'too_short';
    return { ...book, chapters: titles.length };
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
            writeMemo(task, { failed: true });
            log('info', '番茄渠道下载', { taskId: task.id, bookId, outcome: 'failed', reason: book.slice(0, 80) });
            return inner.download(task, context);
          }
          recordEvent('ok', bookId, 'done');
          log('info', '番茄渠道下载', { taskId: task.id, bookId, outcome: 'done', chapters: book.chapters,
            chars: book.charsTotal, seconds: reply.result?.seconds });
          return { kind: 'complete', txt: book.txt, chaptersTotal: book.chapters, chaptersDone: book.chapters,
            charsTotal: book.charsTotal, chapterRanges: book.chapterRanges };
        },
      };
    },
  };
}
