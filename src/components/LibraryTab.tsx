'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import ReadBookLink from '@/components/ReadBookLink';
import { isDbQuotaResponse, quotaRetryDelayMs } from '@/lib/db-quota';

interface LibraryBook {
  id: number;
  title: string;
  author: string;
  category: string;
  finishStatus: string;
  charsLabeled: number;
  labels: Record<string, unknown>;
  labeledAt: string;
  genre: string;
  intro: string;
  quality?: number | null;
  // 共享可读：任意用户的 done 文件（在线阅读）。
  sharedReadTaskId?: number | null;
  // 私有：当前用户自己在这本书上的最新任务（下载 / 取消 / 取回）。
  myDownloadTaskId?: number | null;
}

interface Facets {
  categories: { name: string; count: number }[];
  finishStates: { name: string; count: number }[];
}

interface DownloadTask {
  id: number;
  bookId: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'partial' | 'superseded_by_incomplete';
  chaptersTotal: number;
  chaptersDone: number;
  charsTotal: number;
  error: string | null;
  updatedAt: string;
  // 派生状态：running 且 worker 心跳过期。GET 保持只读，由这里暴露给 UI 做受控重试。
  leaseExpired?: boolean;
  requestedBy?: 'user' | 'system';
  retryOf?: number | null;
  artifactId?: string | null;
}

// 换活跃源重定位候选：/api/download/relocate 422 AMBIGUOUS 返回的只读条目，仅用于展示（无点选/回传）。
interface RelocateCandidate {
  title: string;
  author: string;
  bookUrl: string;
}

// 候选来源站点：只给 host 便于辨识来源站点，又不让长 URL 撑爆布局；非法 URL 回退原样字符串（§3.4）。
function candidateHost(bookUrl: string): string {
  try {
    return new URL(bookUrl).host;
  } catch {
    return bookUrl;
  }
}

const FIELD_LABELS: [string, string][] = [
  ['genre', '题材'],
  ['style', '文风'],
  ['pace', '节奏'],
  ['protagonist', '主角'],
  ['strengths', '看点'],
  ['weaknesses', '雷点'],
  ['plot_stage', '进展'],
  ['worldbuilding', '世界观'],
  ['tone', '基调'],
];

const SORTS: [string, string][] = [
  ['quality', '质量优先'],
  ['recent', '最新打标'],
  ['oldest', '最早打标'],
  ['title', '书名'],
];

// 流派/风格小标签：genre/style/tone 顿号分隔词打散，可点选筛选
function tagTokens(book: LibraryBook): string[] {
  const raw = [book.genre, fieldText(book.labels, 'style'), fieldText(book.labels, 'tone')]
    .filter(Boolean).join('、');
  return [...new Set(raw.split(/[、,，;；\s]+/).filter((t) => t.length >= 2 && t.length <= 8))].slice(0, 5);
}

function fieldText(labels: Record<string, unknown>, key: string): string {
  const v = labels[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').join('；');
  return '';
}

// 单条任务响应兼容裸对象与 {task} 包装两种形态，字段缺失去零值兜底
function parseTask(data: unknown): DownloadTask | null {
  const wrapper = (typeof data === 'object' && data !== null ? data : {}) as { task?: unknown };
  const t = (wrapper.task ?? data) as Record<string, unknown> | null;
  if (typeof t !== 'object' || t === null || typeof t.id !== 'number') return null;
  const status = typeof t.status === 'string' ? t.status : 'pending';
  return {
    id: t.id,
    bookId: Number(t.bookId) || 0,
    title: typeof t.title === 'string' ? t.title : '',
    status: (['pending', 'running', 'done', 'failed', 'partial', 'superseded_by_incomplete'] as const).includes(status as never)
      ? (status as DownloadTask['status'])
      : 'pending',
    chaptersTotal: Number(t.chaptersTotal) || 0,
    chaptersDone: Number(t.chaptersDone) || 0,
    charsTotal: Number(t.charsTotal) || 0,
    error: typeof t.error === 'string' ? t.error : null,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : '',
    leaseExpired: t.leaseExpired === true,
    requestedBy: t.requestedBy === 'system' ? 'system' : 'user',
    retryOf: typeof t.retryOf === 'number' ? t.retryOf : null,
    artifactId: t.artifactId == null ? null : String(t.artifactId),
  };
}

function downloadStatusText(t: DownloadTask): string {
  switch (t.status) {
    case 'pending': return '排队中，等待下载任务开始';
    // 心跳过期的 running 是硬中断残留：不再显示诱人的「下载中 n/m」，明确告知可重试。
    case 'running': return t.leaseExpired
      ? `下载已中断（worker 无心跳），已存 ${t.chaptersDone}/${t.chaptersTotal} 章，可重试`
      : `下载中 ${t.chaptersDone}/${t.chaptersTotal} 章`;
    case 'done': return `完成，共 ${t.charsTotal} 字`;
    case 'partial': {
      const missing = Math.max(0, t.chaptersTotal - t.chaptersDone);
      return `未完成：已存 ${t.chaptersDone}/${t.chaptersTotal} 章${missing > 0 ? `，缺 ${missing} 章` : ''}，可重试补齐`;
    }
    // 残缺终态（worker F03）：候选版本完整度过不了晋升校验，保留的是此前的完整版本；
    // 删除后可重新下载（worker 只领 pending，不会被重捞，须用户手动重下）。
    case 'superseded_by_incomplete':
      return '新下载的版本不完整，已保留此前的完整版本；可删除任务后重新下载';
    case 'failed': return t.error?.trim() ? '下载失败' : '下载失败：未知原因';
  }
}

// Content-Disposition: filename*=UTF-8''xxx 或 filename="xxx"，取不到就用书名兜底
function fileNameFrom(disposition: string, fallback: string): string {
  const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // 脏值走后面的兜底
    }
  }
  const plain = /filename="?([^";]+)"?/.exec(disposition);
  return plain ? plain[1] : fallback;
}

// 质量分分档配色：>=8.0 朱红 / 7.0~7.9 苔绿 / 更低灰墨，扫视时快速分辨优劣
function qualityColor(q: number): string {
  if (q >= 8.0) return 'var(--cinnabar)';
  if (q >= 7.0) return 'var(--moss)';
  return 'var(--ink-faint)';
}

export interface LibraryView {
  page: number;
  query: string;
  search: string;
  category: string;
  tag: string;
  finish: string;
  sort: string;
}

export function createLibraryView(initialQuery = ''): LibraryView {
  return { page: 1, query: initialQuery, search: initialQuery, category: '', tag: '', finish: '', sort: 'quality' };
}

export default function LibraryTab({ view, setView }: {
  view: LibraryView;
  setView: Dispatch<SetStateAction<LibraryView>>;
}) {
  const { apiFetch, can, sessionId, isCurrentSession } = useOwner();
  const canDownload = can('download');
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [facets, setFacets] = useState<Facets>({ categories: [], finishStates: [] });
  const [total, setTotal] = useState(0);
  const { page, query, search, category, tag, finish, sort } = view;
  const [maxPage, setMaxPage] = useState(10_000);
  const [detail, setDetail] = useState<LibraryBook | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [task, setTask] = useState<DownloadTask | null>(null);
  const [dlError, setDlError] = useState('');
  const [dlMessage, setDlMessage] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  // 换源重定位（front681）：仅 /api/download 400 UNSUPPORTED_SOURCE 后置位出现入口；候选只读展示。
  const [relocateOffered, setRelocateOffered] = useState(false);
  const [relocateCandidates, setRelocateCandidates] = useState<RelocateCandidate[]>([]);
  const [shelfMsg, setShelfMsg] = useState('');
  const [shelfBusy, setShelfBusy] = useState(0); // 当前正在加书架的书 id，0 表示空闲
  const reqId = useRef(0);
  const dlRequestId = useRef(0);
  const actions = useRef(new Set<AbortController>());
  useEffect(() => {
    const pending = actions.current;
    return () => { for (const controller of pending) controller.abort(); pending.clear(); };
  }, []);
  const detailEntries = useRef(new Map<number, HTMLButtonElement>());
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const libraryHeading = useRef<HTMLHeadingElement>(null);
  const returnLocation = useRef<{ id: number; scrollY: number } | null>(null);
  const detailId = detail?.id ?? null;

  function updateView(patch: Partial<LibraryView>) {
    setView((current) => ({ ...current, ...patch }));
  }

  const updateTask = useCallback((next: DownloadTask | null) => {
    setTask(next);
    if (next?.status !== 'done') return;
    // A newly finished download must also expose reading on its library card,
    // including after the detail view (and its local task state) is closed.
    // 自己的 done 任务既是私有下载结果，也是一份共享可读文件，两个字段同步更新。
    setBooks((current) => current?.map((book) => book.id === next.bookId
      ? {
          ...book,
          sharedReadTaskId: book.sharedReadTaskId ?? next.id,
          myDownloadTaskId: next.id,
        }
      : book) ?? null);
    setDetail((current) => current?.id === next.bookId
      ? {
          ...current,
          sharedReadTaskId: current.sharedReadTaskId ?? next.id,
          myDownloadTaskId: next.id,
        }
      : current);
  }, []);

  function showDetail(book: LibraryBook | null) {
    if (book) returnLocation.current = { id: book.id, scrollY: window.scrollY };
    dlRequestId.current += 1;
    setDetail(book);
    setTask(null);
    setDlError('');
    setDlMessage('');
    setDlBusy(false);
    setRelocateOffered(false);
    setRelocateCandidates([]);
  }

  useEffect(() => {
    if (detailId !== null) {
      detailHeading.current?.focus();
    } else if (returnLocation.current) {
      const { id, scrollY } = returnLocation.current;
      const entry = detailEntries.current.get(id) ?? libraryHeading.current;
      entry?.focus({ preventScroll: true });
      window.scrollTo(0, scrollY);
      returnLocation.current = null;
    }
  }, [detailId]);

  const load = useCallback(async (p: number, q: string, cat: string, tg: string, fin: string, st: string, signal?: AbortSignal) => {
    if (signal?.aborted || !isCurrentSession(sessionId)) return;
    const my = ++reqId.current;
    const current = () => !signal?.aborted && my === reqId.current && isCurrentSession(sessionId);
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(p), q, sort: st });
      if (cat) params.set('category', cat);
      if (tg) params.set('tag', tg);
      if (fin) params.set('finish', fin);
      const res = await apiFetch(`/api/library?${params}`, { signal });
      if (!current()) return;
      const data = await res.json();
      if (!current()) return;
      if (!res.ok) throw new Error(data.error || '书库加载失败');
      setBooks(data.books);
      setTotal(data.total);
      setMaxPage(data.maxPage ?? 10_000);
      setFacets(data.facets ?? { categories: [], finishStates: [] });
    } catch (e) {
      if (!current()) return;
      setError(e instanceof Error ? e.message : '书库加载失败');
    } finally {
      if (current()) setLoading(false);
    }
  }, [apiFetch, sessionId, isCurrentSession]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(page, search, category, tag, finish, sort, controller.signal);
    });
    return () => controller.abort();
  }, [load, page, search, category, tag, finish, sort, reloadVersion]);

  // 重试也走同一个 effect，沿用条件切换和卸载时的取消/过期响应保护。
  function retryLoad() {
    if (!loading) setReloadVersion((current) => current + 1);
  }

  // 进入详情页时按 bookId 查「本人」在这本书上的最新任务；共享可读定位（sharedReadTaskId）
  // 只用于在线阅读，不再拿去查强制 user_id 的 /api/download（F18）。
  useEffect(() => {
    // 权限变更也作废此前的查询/操作响应，避免撤权后的旧任务重新出现。
    const my = ++dlRequestId.current;
    let stale = false;
    const controller = new AbortController();
    const current = () => !stale && !controller.signal.aborted && my === dlRequestId.current && isCurrentSession(sessionId);
    queueMicrotask(() => {
      if (!current()) return;
      setTask(null);
      setDlError('');
      setDlMessage('');
      setDlBusy(false);
      setRelocateOffered(false);
      setRelocateCandidates([]);
      if (!canDownload || detailId === null) return;
      void (async () => {
        try {
          const res = await apiFetch(`/api/download?bookId=${detailId}`, { signal: controller.signal });
          if (!current()) return;
          const data = await res.json();
          if (!current()) return;
          if (!res.ok) throw new Error(data.error || '查询下载任务失败');
          const found = parseTask(data);
          updateTask(found && found.bookId === detailId ? found : null);
        } catch {
          // 查不到不影响看详情，只是下载区块退回按钮态
        }
      })();
    });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [detailId, canDownload, apiFetch, updateTask, sessionId, isCurrentSession]);

  // pending/running 任务轮询单条进度。任务到终态后 pollTaskId 变 null，effect 清理即停轮询。
  const pollTaskId = canDownload && task !== null && (task.status === 'pending' || task.status === 'running')
    ? task.id
    : null;

  // 轮询 30 秒一次；页面不可见（切后台标签页）时暂停，省掉无谓的库往返（Neon 按传输量计费），
  // 回到前台立即拉一次再恢复计时。挂载时若页面可见也立即拉一次，不干等首个间隔。
  // 数据库额度耗尽（503 DB_QUOTA_EXCEEDED）时停掉 30 秒轮询，按 Retry-After（≤30 分钟）只再探一次；
  // 再探非配额即恢复正常轮询，仍是配额就继续等。后台时不探，回前台立即探。
  useEffect(() => {
    if (pollTaskId === null) return;
    let stale = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let quotaRetry: ReturnType<typeof setTimeout> | null = null;
    let quotaPaused = false;
    let quotaDelayMs = 0;
    let pollVersion = 0;
    const controller = new AbortController();
    const valid = () => !stale && !controller.signal.aborted && isCurrentSession(sessionId);
    const clearQuotaRetry = () => { if (quotaRetry !== null) { clearTimeout(quotaRetry); quotaRetry = null; } };
    const scheduleQuotaRetry = () => {
      clearQuotaRetry();
      if (!valid() || document.hidden) return; // 后台不探：onVisibility 回前台时立即探
      quotaRetry = setTimeout(() => { quotaRetry = null; poll(); }, quotaDelayMs);
    };
    const poll = () => {
      if (!valid()) return;
      const my = dlRequestId.current;
      // 同一任务的定时刷新和回前台刷新可能并发，只接受最后发出的请求。
      const version = ++pollVersion;
      const current = () => valid()
        && version === pollVersion && my === dlRequestId.current;
      void (async () => {
        try {
          const res = await apiFetch(`/api/download?id=${pollTaskId}`, { signal: controller.signal });
          if (!current()) return;
          const data = await res.json();
          if (!current()) return;
          if (isDbQuotaResponse(res.status, data)) {
            stop();
            quotaPaused = true;
            quotaDelayMs = quotaRetryDelayMs(res.headers.get('Retry-After'));
            if (my === dlRequestId.current) setDlMessage('数据库额度已用尽，下载进度暂停刷新，稍后会自动重试。');
            scheduleQuotaRetry();
            return;
          }
          if (quotaPaused) {
            // 额度恢复：清掉提示、回到正常 30 秒节奏。
            quotaPaused = false;
            if (my === dlRequestId.current) setDlMessage('');
            if (!document.hidden) start();
          }
          if (!res.ok) throw new Error(data.error || '查询下载进度失败');
          const next = parseTask(data);
          if (my === dlRequestId.current && next !== null) {
            updateTask(next);
            if (next.status === 'done' || next.status === 'failed') setDlMessage('');
          }
        } catch {
          // 单次失败不打断轮询；配额暂停中的再探若网络失败，按同一间隔再排一次。
          if (current() && quotaPaused) scheduleQuotaRetry();
        }
      })();
    };
    const start = () => { if (valid() && timer === null) timer = setInterval(poll, 30000); };
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (!valid()) { stop(); clearQuotaRetry(); return; }
      if (document.hidden) {
        stop();
        clearQuotaRetry();
      } else {
        poll();
        if (!quotaPaused) start(); // 配额暂停中：这次 poll 就是再探，结果决定恢复还是继续等
      }
    };
    if (!document.hidden) {
      poll();
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stale = true;
      controller.abort();
      stop();
      clearQuotaRetry();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollTaskId, apiFetch, updateTask, sessionId, isCurrentSession]);

  function beginAction(): AbortController {
    const controller = new AbortController();
    actions.current.add(controller);
    return controller;
  }

  function isCurrentAction(controller: AbortController, requestId?: number): boolean {
    return !controller.signal.aborted && isCurrentSession(sessionId)
      && (requestId === undefined || requestId === dlRequestId.current);
  }

  async function addToShelf(book: LibraryBook) {
    if (shelfBusy !== 0 || !isCurrentSession(sessionId)) return;
    const controller = beginAction();
    setShelfBusy(book.id);
    setShelfMsg('');
    try {
      const res = await apiFetch('/api/shelf', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labeledBookId: book.id }),
      });
      if (!isCurrentAction(controller)) return;
      const data = await res.json().catch(() => ({}));
      if (!isCurrentAction(controller)) return;
      if (res.status === 409) {
        setShelfMsg(`「${book.title}」已在书架`);
        return;
      }
      if (!res.ok) throw new Error(data.error || '加入书架失败');
      setShelfMsg(`「${book.title}」已加入书架（想读）`);
    } catch (e) {
      if (isCurrentAction(controller)) setShelfMsg(e instanceof Error ? e.message : '加入书架失败');
    } finally {
      actions.current.delete(controller);
      if (isCurrentAction(controller)) setShelfBusy(0);
    }
  }

  async function startDownload() {
    if (!isCurrentSession(sessionId)) return;
    // 心跳过期的 running 视为可重试：POST 会先回收僵尸租约再建任务。
    if (!canDownload || task?.requestedBy === 'system' || !detail || dlBusy || task?.status === 'done' || (task?.status === 'running' && !task.leaseExpired)) return;
    const my = ++dlRequestId.current;
    const controller = beginAction();
    setDlBusy(true);
    setDlError('');
    setDlMessage('');
    try {
      const res = await apiFetch('/api/download', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: detail.id }),
      });
      if (!isCurrentAction(controller, my)) return;
      const data = await res.json().catch(() => ({}));
      if (!isCurrentAction(controller, my)) return;
      if (res.status === 409) {
        setDlMessage('任务已在队列，无需重复提交。');
        if (typeof data.taskId === 'number') {
          // 读取已有任务的真实状态，避免把已经完成的任务重新显示成 pending。
          const currentRes = await apiFetch(`/api/download?id=${data.taskId}`, { signal: controller.signal });
          if (!isCurrentAction(controller, my)) return;
          const currentData = await currentRes.json().catch(() => null);
          if (!isCurrentAction(controller, my)) return;
          const current = parseTask(currentData);
          if (!currentRes.ok || !current || current.bookId !== detail.id) {
            throw new Error('任务已在队列，暂时无法读取进度，请稍后重试');
          }
          updateTask(current);
          if (current.status === 'done') setDlMessage('任务已完成，可取回文件。');
          if (current.status === 'failed') setDlMessage('任务已失败，可再次重试。');
        }
        return;
      }
      if (res.ok && typeof data.taskId === 'number') {
        setTask({
          id: data.taskId,
          bookId: detail.id,
          title: detail.title,
          status: 'pending',
          chaptersTotal: 0,
          chaptersDone: 0,
          charsTotal: 0,
          error: null,
          updatedAt: '',
        });
        setDlMessage(task ? '已重新加入下载队列。' : '已加入下载队列。');
        return;
      }
      // 源已退休/不支持：置位换源入口（反应式触发，设计稿 §2；其他失败码不置位）。
      if (data.code === 'UNSUPPORTED_SOURCE') setRelocateOffered(true);
      throw new Error(data.error || '提交下载失败');
    } catch (e) {
      if (isCurrentAction(controller, my)) setDlError(e instanceof Error ? e.message : '提交下载失败');
    } finally {
      actions.current.delete(controller);
      if (isCurrentAction(controller, my)) setDlBusy(false);
    }
  }

  // 换源重定位前置守卫（§3.2）：task===null 天然允许；已有任务仅可重试终态可换源
  // （failed/partial/superseded_by_incomplete/running+leaseExpired，与入口按钮同一条件）。
  function canRelocateNow(): boolean {
    if (!canDownload || !detail || dlBusy || task?.requestedBy === 'system') return false;
    if (task === null) return true;
    return task.status === 'failed' || task.status === 'partial' || task.status === 'superseded_by_incomplete'
      || (task.status === 'running' && task.leaseExpired);
  }

  // 换活跃源重下（design679 §3.2/§3.3）：按书名+作者在活跃源池重新定位后建任务；
  // busy 复用 dlBusy（同一下载区块同一时刻只允许一种提交在飞），防错骨架与 startDownload 同构。
  async function relocateDownload() {
    if (!isCurrentSession(sessionId)) return;
    // 内联 !detail 让 TS 对后续 await 段保持非空收窄（canRelocateNow 内的判空收窄不跨函数）。
    if (!canRelocateNow() || !detail) return;
    const my = ++dlRequestId.current;
    const controller = beginAction();
    setDlBusy(true);
    setDlError('');
    setDlMessage('');
    setRelocateCandidates([]);
    try {
      const res = await apiFetch('/api/download/relocate', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: detail.id }),
      });
      if (!isCurrentAction(controller, my)) return;
      const data = await res.json().catch(() => ({}));
      if (!isCurrentAction(controller, my)) return;
      if (res.status === 409) {
        setDlMessage('任务已在队列，无需重复提交。');
        if (typeof data.taskId === 'number') {
          // 读取已有任务的真实状态，避免把已经完成的任务重新显示成 pending。
          const currentRes = await apiFetch(`/api/download?id=${data.taskId}`, { signal: controller.signal });
          if (!isCurrentAction(controller, my)) return;
          const currentData = await currentRes.json().catch(() => null);
          if (!isCurrentAction(controller, my)) return;
          const current = parseTask(currentData);
          if (!currentRes.ok || !current || current.bookId !== detail.id) {
            throw new Error('任务已在队列，暂时无法读取进度，请稍后重试');
          }
          updateTask(current);
          if (current.status === 'done') setDlMessage('任务已完成，可取回文件。');
          if (current.status === 'failed') setDlMessage('任务已失败，可再次重试。');
        }
        return;
      }
      if (res.ok && typeof data.taskId === 'number') {
        setTask({
          id: data.taskId,
          bookId: detail.id,
          title: detail.title,
          status: 'pending',
          chaptersTotal: 0,
          chaptersDone: 0,
          charsTotal: 0,
          error: null,
          updatedAt: '',
        });
        // matched 只进文案展示实际命中的版本，绝不回写书库（§5）。
        const matched = data.resolvedSource?.matched;
        setDlMessage(typeof matched?.title === 'string'
          ? `已在活跃书源匹配到《${matched.title}》（${typeof matched.author === 'string' ? matched.author : ''}），加入下载队列。`
          : '已加入下载队列。');
        return;
      }
      if (isDbQuotaResponse(res.status, data)) {
        setDlError('数据库额度已用尽，请稍后再试。');
        return;
      }
      // 503/504 源池透传失败：入口保留可重试（书源池会恢复）。
      if (res.status === 503 || res.status === 504) {
        setDlError(`书源池暂时不可用(${typeof data.code === 'string' ? data.code : 'SOURCE_UNAVAILABLE'})，请稍后再试。`);
        return;
      }
      // 其余按 code 映射中文文案，避免服务端英文 error 裸奔（§6）。
      if (data.code === 'RELOCATION_NO_CANDIDATES') {
        setDlError('当前活跃书源中未找到这本书（按书名+作者搜索无候选）。书源池更新后可再试，或联系管理员补充书源。');
        return;
      }
      if (data.code === 'RELOCATION_AMBIGUOUS') {
        const candidates = Array.isArray(data.candidates)
          ? data.candidates.filter((c: unknown): c is RelocateCandidate =>
            typeof c === 'object' && c !== null && typeof (c as RelocateCandidate).title === 'string'
            && typeof (c as RelocateCandidate).author === 'string' && typeof (c as RelocateCandidate).bookUrl === 'string')
          : [];
        if (candidates.length > 0) {
          setDlError('活跃书源中「书名+作者」命中多个不同条目，为避免下载到错误版本，未自动开始。以下候选仅供参考：');
          setRelocateCandidates(candidates);
        } else {
          // 空数组/形状不对：退化为无列表的纯文案（§3.4 空数组防御）。
          setDlError('活跃书源中有相近但身份不一致的条目（如同名不同作者），为避免下错书未自动开始。');
        }
        return;
      }
      if (data.code === 'RELOCATION_IDENTITY_MISMATCH') {
        setDlError('活跃书源中有相近但身份不一致的条目（如同名不同作者），为避免下错书未自动开始。');
        return;
      }
      if (data.code === 'BOOK_NOT_FOUND') {
        setDlError('书库记录已更新，请返回刷新书库后重试。');
        return;
      }
      throw new Error(data.error || '重定位失败，请稍后再试。');
    } catch (e) {
      if (isCurrentAction(controller, my)) setDlError(e instanceof Error ? e.message : '重定位失败，请稍后再试。');
    } finally {
      actions.current.delete(controller);
      if (isCurrentAction(controller, my)) setDlBusy(false);
    }
  }

  async function removeDownload() {
    if (!isCurrentSession(sessionId)) return;
    if (!canDownload || task?.requestedBy === 'system') return;
    if (!task || dlBusy || (task.status !== 'pending' && task.status !== 'failed' && task.status !== 'partial'
      && task.status !== 'superseded_by_incomplete')) return;
    const failureMessage = task.status === 'failed' ? '清理失败' : '取消失败';
    const my = ++dlRequestId.current;
    const controller = beginAction();
    setDlBusy(true);
    setDlError('');
    setDlMessage('');
    try {
      const res = await apiFetch('/api/download', {
        method: 'DELETE', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });
      if (!isCurrentAction(controller, my)) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (!isCurrentAction(controller, my)) return;
        throw new Error(data.error || failureMessage);
      }
      setTask(null);
    } catch (e) {
      if (isCurrentAction(controller, my)) setDlError(e instanceof Error ? e.message : failureMessage);
    } finally {
      actions.current.delete(controller);
      if (isCurrentAction(controller, my)) setDlBusy(false);
    }
  }

  async function retrieveFile() {
    if (!isCurrentSession(sessionId)) return;
    if (!canDownload || task?.requestedBy === 'system') return;
    if (!task) return;
    const my = dlRequestId.current;
    const controller = beginAction();
    try {
      const res = await apiFetch(`/api/download/${task.id}/file`, { signal: controller.signal });
      if (!isCurrentAction(controller, my)) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (!isCurrentAction(controller, my)) return;
        throw new Error(data.error || '文件取回失败');
      }
      const blob = await res.blob();
      if (!isCurrentAction(controller, my)) return;
      const name = fileNameFrom(res.headers.get('Content-Disposition') ?? '', `${task.title || 'novel'}.txt`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (isCurrentAction(controller, my)) window.alert(e instanceof Error ? e.message : '文件取回失败');
    } finally {
      actions.current.delete(controller);
    }
  }

  const pageSize = 30;
  const totalPages = Math.min(maxPage, Math.max(1, Math.ceil(total / pageSize)));
  const hasFilter = Boolean(search || category || tag || finish);
  const taskNotes = task?.error?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];

  function resetFilters() {
    updateView({ page: 1, category: '', tag: '', finish: '', search: '', query: '' });
  }

  // 详情视图：点书名进入
  if (detail) {
    return (
      <div>
        <button className="chip text-sm mb-4" onClick={() => showDetail(null)}>
          ← 返回书库
        </button>
        <article className="book-card px-6 py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 ref={detailHeading} tabIndex={-1} className="text-xl font-bold">{detail.title}</h2>
            <span className="text-sm" style={{ color: 'var(--ink-faint)' }}>
              {detail.author} · {detail.category || detail.genre}
              {detail.finishStatus ? ` · 标注状态：${detail.finishStatus}` : ''}
            </span>
            {typeof detail.labels.confidence === 'number' && (
              <span className="chip text-xs">离线标注置信度 {detail.labels.confidence}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {tagTokens(detail).map((t) => (
              <span key={t} className="chip text-xs">{t}</span>
            ))}
          </div>
          <div className="mt-4 space-y-2.5">
            <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
              以下内容来自离线模型标注，属于标注推断，不是外部事实核验。
            </p>
            {FIELD_LABELS.map(([key, label]) => {
              const text = fieldText(detail.labels, key);
              if (!text) return null;
              return (
                <p key={key} className="text-sm leading-7" style={{ color: 'var(--ink-soft)' }}>
                  <span className="font-bold" style={{ color: 'var(--ink)' }}>{label}</span>
                  <span aria-hidden="true" className="mx-1.5" style={{ color: 'var(--line)' }}>|</span>
                  {text}
                </p>
              );
            })}
          </div>
          <p className="text-xs mt-4" style={{ color: 'var(--ink-faint)' }}>
            已分析文本约 {Math.round(detail.charsLabeled / 10000)} 万字（不是全书字数） · 标注于 {new Date(detail.labeledAt).toLocaleDateString('zh-CN')}
          </p>
          {/* 下载全书 */}
          <div className="mt-5 pt-4 border-t border-dashed" style={{ borderColor: 'var(--line)' }}>
            <div className="mb-3">
              <ReadBookLink taskId={canDownload && task?.status === 'done' ? task.id : detail.sharedReadTaskId} title={detail.title} author={detail.author} from="library" />
            </div>
            {canDownload && dlError && (
              <p role="alert" className="text-xs mb-2" style={{ color: 'var(--cinnabar)' }}>✗ {dlError}</p>
            )}
            {canDownload && dlMessage && (
              <p role="status" className="text-xs mb-2" style={{ color: 'var(--dai)' }}>{dlMessage}</p>
            )}
            {canDownload && relocateOffered && (task === null || task.requestedBy !== 'system'
              && (task.status === 'failed' || task.status === 'partial' || task.status === 'superseded_by_incomplete'
                || (task.status === 'running' && task.leaseExpired))) && (
              <p className="text-xs mb-2 leading-5" style={{ color: 'var(--ink-soft)' }}>
                原下载源已下线或不被支持，可按书名+作者在当前活跃书源池重新定位后下载。
              </p>
            )}
            {canDownload && relocateCandidates.length > 0 && (
              <div className="border-l-2 pl-3 mb-2" style={{ borderColor: 'var(--line)' }} aria-label="重定位候选（仅供参考）">
                <ul
                  className="list-disc pl-4 space-y-1 text-xs leading-6 break-words"
                  style={{ color: 'var(--ink-soft)' }}
                >
                  {relocateCandidates.map((c, index) => (
                    <li key={index}>《{c.title}》 — {c.author} · {candidateHost(c.bookUrl)}</li>
                  ))}
                </ul>
              </div>
            )}
            {!canDownload ? (
              <p role="status" className="text-sm" style={{ color: 'var(--ink-soft)' }}>
                当前账号尚未获得下载权限，请联系管理员开通后再试。
              </p>
            ) : task === null ? (
              <div className="flex flex-wrap items-center gap-3">
                <button className="seal-button text-sm" onClick={() => void startDownload()} disabled={dlBusy}>
                  {dlBusy ? '提交中…' : '⬇ 下载全书'}
                </button>
                {relocateOffered && (
                  <button
                    className="chip chip-dai text-sm disabled:opacity-50"
                    onClick={() => void relocateDownload()}
                    disabled={dlBusy}
                  >
                    {dlBusy ? '正在活跃源中查找…' : '⟳ 换活跃源重下'}
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    role="status"
                    className="text-sm"
                    style={{ color: task.status === 'failed' || (task.status === 'running' && task.leaseExpired) ? 'var(--cinnabar)' : task.status === 'partial' || task.status === 'superseded_by_incomplete' ? 'var(--dai)' : 'var(--ink-soft)' }}
                  >
                    {downloadStatusText(task)}
                    {task.requestedBy === 'system' && ' · 系统任务（只读）'}
                    {task.retryOf != null && ` · 重试自 #${task.retryOf}`}
                    {task.artifactId != null && ` · 产物 #${task.artifactId}`}
                  </span>
                  {task.requestedBy !== 'system' && task.status === 'done' && (
                    <button className="chip text-sm" onClick={() => void retrieveFile()}>
                      取回文件
                    </button>
                  )}
                  {task.requestedBy !== 'system' && (task.status === 'failed' || task.status === 'pending' || task.status === 'partial' || task.status === 'superseded_by_incomplete'
                    || (task.status === 'running' && task.leaseExpired)) && (
                    <button
                      className="chip chip-dai text-sm disabled:opacity-50"
                      onClick={() => void startDownload()}
                      disabled={dlBusy}
                    >
                      {dlBusy ? '处理中…' : '重试'}
                    </button>
                  )}
                  {relocateOffered && task.requestedBy !== 'system' && (task.status === 'failed' || task.status === 'partial'
                    || task.status === 'superseded_by_incomplete' || (task.status === 'running' && task.leaseExpired)) && (
                    <button
                      className="chip chip-dai text-sm disabled:opacity-50"
                      onClick={() => void relocateDownload()}
                      disabled={dlBusy}
                    >
                      {dlBusy ? '正在活跃源中查找…' : '⟳ 换活跃源重下'}
                    </button>
                  )}
                  {task.requestedBy !== 'system' && (task.status === 'pending' || task.status === 'failed' || task.status === 'partial'
                    || task.status === 'superseded_by_incomplete') && (
                    <button className="chip text-sm" onClick={() => void removeDownload()} disabled={dlBusy}>
                      {task.status === 'pending' ? '取消' : '清理'}
                    </button>
                  )}
                </div>
                {taskNotes.length > 0 && (
                  <div className="border-l-2 pl-3" style={{ borderColor: 'var(--line)' }}>
                    <p className="text-xs font-bold mb-1" style={{ color: 'var(--ink-soft)' }}>
                      {task.status === 'failed' ? '失败详情' : task.status === 'partial' || task.status === 'superseded_by_incomplete' ? '未完成详情（缺章 / 抽验）' : '抽验与提示'}
                    </p>
                    <ul
                      className="list-disc pl-4 space-y-1 text-xs leading-6 break-words"
                      aria-label="下载任务说明"
                      style={{ color: task.status === 'failed' ? 'var(--cinnabar)' : 'var(--ink-soft)' }}
                    >
                      {taskNotes.map((line, index) => <li key={index}>{line}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </article>
      </div>
    );
  }

  return (
    <div>
      {/* 顶部：搜索 + 排序 */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 ref={libraryHeading} tabIndex={-1} className="text-lg font-bold">书库</h2>
        <form
          className="flex w-full min-w-0 items-center gap-2 sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            const nextSearch = query.trim();
            if (page === 1 && search === nextSearch) {
              if (error) retryLoad();
            } else {
              updateView({ page: 1, search: nextSearch });
            }
          }}
        >
          <input
            className="paper-input text-sm !py-1.5 min-w-0 flex-1 w-40 sm:w-52"
            placeholder="搜书名 / 作者 / 标签"
            value={query}
            onChange={(e) => updateView({ query: e.target.value })}
            aria-label="书库搜索"
          />
          <button className="chip text-sm" type="submit">搜</button>
        </form>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          排序
          <select
            className="paper-input text-xs !py-1 !px-2"
            value={sort}
            onChange={(e) => updateView({ sort: e.target.value, page: 1 })}
            aria-label="排序方式"
          >
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {!loading && !error && total > 0 && (
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>共 {total} 本</span>
        )}
      </div>

      {/* 筛选条：分类 / 完结状态 */}
      <div className="mt-3 space-y-2">
        {facets.categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>分类</span>
            <button
              className={`chip text-xs ${!category ? 'chip-dai' : ''}`}
              onClick={() => updateView({ category: '', page: 1 })}
            >全部</button>
            {facets.categories.map((c) => (
              <button
                key={c.name}
                className={`chip text-xs ${category === c.name ? 'chip-dai' : ''}`}
                onClick={() => updateView({ category: category === c.name ? '' : c.name, page: 1 })}
              >
                {c.name}（{c.count}）
              </button>
            ))}
          </div>
        )}
        {facets.finishStates.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>状态</span>
            {facets.finishStates.map((f) => (
              <button
                key={f.name}
                className={`chip text-xs ${finish === f.name ? 'chip-dai' : ''}`}
                onClick={() => updateView({ finish: finish === f.name ? '' : f.name, page: 1 })}
              >
                {f.name}（{f.count}）
              </button>
            ))}
          </div>
        )}
        {(tag || hasFilter) && (
          <div className="flex flex-wrap items-center gap-2">
            {tag && (
              <button className="chip chip-dai text-xs" onClick={() => updateView({ tag: '', page: 1 })}>
                流派：{tag} ✕
              </button>
            )}
            {hasFilter && (
              <button className="chip text-xs" onClick={resetFilters}>清除筛选</button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--cinnabar)' }}>
          <p>✗ {error}</p>
          <button type="button" className="chip" onClick={retryLoad} disabled={loading}>重试加载</button>
        </div>
      )}
      {error && books !== null && books.length > 0 && (
        <p className="mt-2 text-sm" style={{ color: 'var(--ink-soft)' }}>
          以下为上次加载的结果，尚未按当前条件更新。
        </p>
      )}
      {shelfMsg && (
        <p role="status" className="mt-3 text-sm" style={{ color: 'var(--ink-soft)' }}>{shelfMsg}</p>
      )}
      {loading && (
        <p role="status" className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>
          {books !== null && books.length > 0 ? '正在更新书库，以下为上次结果…' : '读取中…'}
        </p>
      )}
      {books && books.length === 0 && !loading && !error && (
        <p className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>
          {hasFilter ? '没有符合条件的书。' : '书库还是空的——离线打标跑完后，标签书会出现在这里。'}
        </p>
      )}

      {books && books.length > 0 && (
        <div
          className="mt-5 grid grid-cols-1 min-[375px]:grid-cols-2 gap-2 border-t pt-4 sm:grid-cols-3 lg:grid-cols-4"
          style={{ borderColor: 'var(--line)' }}
        >
          {books.map((b) => (
            <article
              key={b.id}
              aria-labelledby={`library-title-${b.id}`}
              className="group flex min-w-0 flex-col rounded-[3px] border border-dashed transition-colors hover:border-solid"
              style={{ borderColor: 'var(--line)' }}
            >
              <button
                type="button"
                ref={(entry) => {
                  if (entry) detailEntries.current.set(b.id, entry);
                  else detailEntries.current.delete(b.id);
                }}
                aria-label={`查看${b.title}详情`}
                className="flex min-w-0 flex-1 flex-col gap-1 p-3 text-left rounded-[3px] transition-colors hover:bg-[var(--paper-deep)]"
                onClick={() => showDetail(b)}
              >
                <span id={`library-title-${b.id}`} className="line-clamp-2 min-w-0 text-sm font-bold transition-colors group-hover:text-[var(--cinnabar)]">
                  {b.title}
                </span>
                <span className="truncate text-xs" style={{ color: 'var(--ink-faint)' }}>{b.author}</span>
                <span className="mt-auto flex min-w-0 flex-wrap items-center gap-2 text-xs">
                  {typeof b.quality === 'number' && (
                    <span className="font-bold tabular-nums" style={{ color: qualityColor(b.quality) }}>
                      标注质量分 {b.quality.toFixed(1)}
                    </span>
                  )}
                  {b.finishStatus?.includes('完结') && (
                    <span style={{ color: 'var(--moss)' }}>标注完结</span>
                  )}
                  {(b.category || b.genre) && (
                    <span className="min-w-0 ml-auto" style={{ color: 'var(--ink-faint)' }}>
                      {b.category || b.genre}
                    </span>
                  )}
                </span>
              </button>
              <div className="flex items-center gap-2 px-3 pb-3">
                <button
                  type="button"
                  className="text-[13px] px-1.5 py-0.5 rounded-[3px] transition-colors hover:bg-[var(--paper-deep)] hover:text-[var(--cinnabar)]"
                  aria-label={`将${b.title}加入书架`}
                  disabled={shelfBusy !== 0}
                  onClick={() => void addToShelf(b)}
                >
                  {shelfBusy === b.id ? '添加中…' : '+ 书架'}
                </button>
                <ReadBookLink taskId={b.sharedReadTaskId} title={b.title} author={b.author} from="library" />
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && !error && totalPages > 1 && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3 text-sm">
          <button className="chip" disabled={page <= 1} onClick={() => setView((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}>
            上一页
          </button>
          <span style={{ color: 'var(--ink-faint)' }}>{page} / {totalPages}</span>
          <button className="chip" disabled={page >= totalPages} onClick={() => setView((current) => ({ ...current, page: current.page + 1 }))}>
            下一页
          </button>
        </div>
      )}
      {!loading && !error && total > maxPage * pageSize && (
        <p className="mt-3 text-xs" style={{ color: 'var(--ink-soft)' }}>
          最多浏览前 {maxPage} 页，请使用搜索或筛选缩小范围。
        </p>
      )}
    </div>
  );
}
