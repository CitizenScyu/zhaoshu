/**
 * 找书三步（召回/验证/重排）的 SSE 客户端消费逻辑。
 * 后端下行是**真 SSE**：事件形如 `data: <json>\n\n`，phase/progress 为实时帧、
 * result 为结束帧、error 为错误帧（带可识别 code）。
 *
 * 抽成不依赖 DOM 的模块才能在 node 环境用假 Response 驱动真实消费路径——
 * 本仓 vitest 只收 *.test.ts 且没有 jsdom，写在 FindTab 的 JSX/闭包里的判定测不到。
 */
import { mergeAbortSignals, timeoutSignal } from '@/lib/abort-merge';
import { isRecord } from '@/lib/sanitize';

export type SseEvent = Record<string, unknown> & { type: string };

export const FIND_FETCH_TIMEOUT_MS = 290_000; // 略低于 295s 路由上限，避免读到一半被平台掐掉

/** 超时/中止要变成用户看得懂的错误，并带可识别 code，UI 才给得出重试入口。 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    const e = new Error('找书超时，请重试');
    (e as Error & { code?: string }).code = 'TIMEOUT';
    return e;
  }
  if (reason instanceof Error && reason.name === 'AbortError') return new Error('找书已取消，请重试');
  return reason instanceof Error ? reason : new Error('找书失败，请重试');
}

/**
 * 把 signal 的中止变成一个会 reject 的 Promise：`reader.read()` 挂起时只有它能叫醒我们。
 * 调用方用完必须 dispose，免得 listener 跟着 signal 一直留着。
 */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let dispose = () => {};
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  promise.catch(() => {}); // 没被 race 选中时也不产生 unhandled rejection
  return { promise, dispose };
}

/**
 * 消费一条 SSE 响应，把每一帧交给 onEvent；读到流结束才 resolve。
 * error 帧直接抛出（带后端 code）。
 */
export async function consumeFindSSE(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('找书响应为空，请重试');
  const reader = response.body.getReader();
  // 不用 AbortSignal.any / AbortSignal.timeout:它们要 Chrome 116 / Safari 17.4 以上,
  // 低于这个基线的浏览器里找书会直接抛。手工合并用户中止与超时两个信号,语义与 any 相同:
  // 任一中止即中止。超时用自带 clearTimeout 的 timeoutSignal,流一结束就 dispose,
  // 不在成功路径上留下还能中止已结束请求的定时器(同坑见 auth-client.ts:240)。
  const timeout = timeoutSignal(timeoutMs);
  const merged = mergeAbortSignals([signal, timeout.signal]);
  const race = merged.signal;
  const abort = abortRejection(race);
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      // 超时/中止必须**能打断挂起的读取**：只在 read() 返回后查 signal，等于服务端把
      // SSE 连接开着不发字节时就永远超不了时（挂到平台掐连接为止）。这里让 read() 与
      // 中止信号赛跑，谁先到谁说了算。
      const read = reader.read();
      read.catch(() => { /* 中止后不再有人关心这次读取的结局 */ });
      const { value, done } = await Promise.race([read, abort.promise]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);
        const m = frame.match(/^data: (.+)$/m);
        if (!m) continue;
        let data: unknown;
        try { data = JSON.parse(m[1]); } catch { continue; }
        if (!isRecord(data) || typeof data.type !== 'string') continue;
        const type = data.type as string;
        if (type === 'error') {
          const e = new Error(typeof data.message === 'string' ? data.message : '找书失败，请重试');
          (e as Error & { code?: string }).code = typeof data.code === 'string' ? data.code : undefined;
          throw e;
        }
        onEvent(data as SseEvent);
      }
    }
    race.throwIfAborted();
  } finally {
    abort.dispose();
    merged.dispose();
    timeout.dispose();
    try { await reader.cancel(); } catch { /* 已取消或已关闭 */ }
  }
}

/**
 * 发一步请求并取回它的 **result 帧**。progress/phase 帧交给 onProgress 喂页面进度，
 * result 帧作为 Promise 的结果返回（调用方从里面取 candidates/verified/items）。
 */
export async function fetchFindResult(
  signal: AbortSignal,
  doFetch: () => Promise<Response>,
  timeoutMs: number,
  onProgress: (event: SseEvent) => void,
): Promise<SseEvent> {
  const res = await doFetch();
  signal.throwIfAborted();
  if (!res.ok || !/text\/event-stream/i.test(res.headers.get('content-type') ?? '')) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    signal.throwIfAborted();
    // 错误码必须挂上：调用方要靠它区分可恢复的重试起点（例如票据失效要回到 verify 重新出票，
    // 而不是拿同一张废票在 rerank 空转）。
    const e = new Error(data.error || '找书失败，请重试');
    (e as Error & { code?: string }).code = typeof data.code === 'string' ? data.code : undefined;
    throw e;
  }
  return await new Promise<SseEvent>((resolve, reject) => {
    let settled = false;
    void consumeFindSSE(res, signal, timeoutMs, (event) => {
      if (event.type === 'result') {
        settled = true;
        resolve(event);
      } else {
        onProgress(event);
      }
    }).then(() => {
      // 流**正常结束**却没见到 result 帧（半包 / 代理吞尾 / 后端只发了 phase）：
      // 必须落地成失败。否则这个 Promise 永不 settle，按钮永远停在「寻径中…」，
      // 重试入口不出现，用户只能刷新页面。
      if (!settled) reject(new Error('找书响应不完整，请重试'));
    }).catch((e) => reject(e instanceof Error ? e : new Error('找书失败，请重试')));
  });
}

/**
 * result 帧里后端写库失败（persisted === false）时给用户的提示。
 * 没有它，写库失败会被当成找书成功——用户以为书已经存下了，回来却找不到。
 */
export function persistWarning(event: SseEvent): string | null {
  if (event.type !== 'result' || event.persisted !== false) return null;
  return '本轮结果未能保存，离开页面后可能不再保留。';
}

/**
 * F13：rerank 合法零结果（items 为空）时，后端随 result 帧带上的排除原因摘要与放宽建议。
 * 空 items 与写库失败（persisted=false）是两回事：前者是正常结局，只讲清为什么没有结果，
 * 不套用「未能保存」的警告。返回 null 表示不是零结果帧（或后端没带摘要）。
 */
export function zeroResultNote(event: SseEvent): string | null {
  if (event.type !== 'result') return null;
  if (!Array.isArray(event.items) || event.items.length > 0) return null;
  const reason = typeof event.zeroReason === 'string' ? event.zeroReason.trim() : '';
  const suggestion = typeof event.zeroSuggestion === 'string' ? event.zeroSuggestion.trim() : '';
  return [reason, suggestion].filter(Boolean).join(' ') || null;
}

/* ---------- 41-veto-visible：被画像雷点否决的书 ---------- */

/** 结果帧里一本「因画像雷点被自动排除」的书。 */
export interface VetoedBook {
  title: string;
  author: string;
  reason: string;
}

// SSE 是服务端直下的数据，客户端展示前必须自己设上界：没上界就把「服务端说了算」交给
// 不受控的数组长度与字符串长度。条数与每本字段都按码点截断（不切开代理对）。
const VETOED_MAX_ITEMS = 20;
const VETOED_TITLE_MAX = 60;
const VETOED_AUTHOR_MAX = 40;
const VETOED_REASON_MAX = 120;

function clipChars(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/**
 * 解析 result 帧顶层的 vetoed 数组——服务端在 rerank 收尾（有结果与合法零结果两条路径）都随
 * result 帧带上它，前端此前直接丢弃，于是被否决的书只是「消失」、用户看不到原因。
 *
 * 畸形容忍：非 result 帧 / 字段缺失 / 非数组都返回空数组（旧客户端、旧事件、开关关都走这里，
 * 行为与接入前一致）。单项缺 title 就丢弃这一项（连书名都没有就无从展示）；author/reason
 * 非字符串退化为空串，其余字段仍可用。作者可能的筛除、理由过长都在这里收口。
 */
export function vetoedBooks(event: SseEvent): VetoedBook[] {
  if (event.type !== 'result' || !Array.isArray(event.vetoed)) return [];
  const books: VetoedBook[] = [];
  for (const raw of event.vetoed.slice(0, VETOED_MAX_ITEMS)) {
    if (!isRecord(raw)) continue;
    if (typeof raw.title !== 'string' || raw.title.trim() === '') continue;
    books.push({
      title: clipChars(raw.title, VETOED_TITLE_MAX),
      author: typeof raw.author === 'string' ? clipChars(raw.author, VETOED_AUTHOR_MAX) : '',
      reason: typeof raw.reason === 'string' ? clipChars(raw.reason, VETOED_REASON_MAX) : '',
    });
  }
  return books;
}
