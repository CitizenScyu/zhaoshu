'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import ReadBookLink from '@/components/ReadBookLink';

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
  const { apiFetch } = useOwner();
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [facets, setFacets] = useState<Facets>({ categories: [], finishStates: [] });
  const [total, setTotal] = useState(0);
  const { page, query, search, category, tag, finish, sort } = view;
  const [maxPage, setMaxPage] = useState(10_000);
  const [detail, setDetail] = useState<LibraryBook | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<DownloadTask | null>(null);
  const [dlError, setDlError] = useState('');
  const [dlMessage, setDlMessage] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  const [shelfMsg, setShelfMsg] = useState('');
  const [shelfBusy, setShelfBusy] = useState(0); // 当前正在加书架的书 id，0 表示空闲
  const reqId = useRef(0);
  const dlRequestId = useRef(0);
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
    const my = ++reqId.current;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(p), q, sort: st });
      if (cat) params.set('category', cat);
      if (tg) params.set('tag', tg);
      if (fin) params.set('finish', fin);
      const res = await apiFetch(`/api/library?${params}`, { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '书库加载失败');
      if (signal?.aborted || my !== reqId.current) return;
      setBooks(data.books);
      setTotal(data.total);
      setMaxPage(data.maxPage ?? 10_000);
      setFacets(data.facets ?? { categories: [], finishStates: [] });
    } catch (e) {
      if (signal?.aborted || my !== reqId.current) return;
      setError(e instanceof Error ? e.message : '书库加载失败');
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(page, search, category, tag, finish, sort, controller.signal);
    });
    return () => controller.abort();
  }, [load, page, search, category, tag, finish, sort]);

  // 进入详情页时按 bookId 查「本人」在这本书上的最新任务；共享可读定位（sharedReadTaskId）
  // 只用于在线阅读，不再拿去查强制 user_id 的 /api/download（F18）。
  useEffect(() => {
    if (detailId === null) return;
    const my = dlRequestId.current;
    let stale = false;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void (async () => {
        try {
          const res = await apiFetch(`/api/download?bookId=${detailId}`, { signal: controller.signal });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '查询下载任务失败');
          if (stale || my !== dlRequestId.current) return;
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
  }, [detailId, apiFetch, updateTask]);

  // pending/running 任务轮询单条进度。任务到终态后 pollTaskId 变 null，effect 清理即停轮询。
  const pollTaskId = task !== null && (task.status === 'pending' || task.status === 'running')
    ? task.id
    : null;

  // 轮询 30 秒一次；页面不可见（切后台标签页）时暂停，省掉无谓的库往返（Neon 按传输量计费），
  // 回到前台立即拉一次再恢复计时。挂载时若页面可见也立即拉一次，不干等首个间隔。
  useEffect(() => {
    if (pollTaskId === null) return;
    let stale = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const controller = new AbortController();
    const poll = () => {
      if (controller.signal.aborted) return;
      const my = dlRequestId.current;
      void (async () => {
        try {
          const res = await apiFetch(`/api/download?id=${pollTaskId}`, { signal: controller.signal });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '查询下载进度失败');
          const next = parseTask(data);
          if (!stale && my === dlRequestId.current && next !== null) {
            updateTask(next);
            if (next.status === 'done' || next.status === 'failed') setDlMessage('');
          }
        } catch {
          // 单次失败不打断轮询
        }
      })();
    };
    const start = () => { if (timer === null) timer = setInterval(poll, 30000); };
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        poll();
        start();
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
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollTaskId, apiFetch, updateTask]);

  async function addToShelf(book: LibraryBook) {
    if (shelfBusy !== 0) return;
    setShelfBusy(book.id);
    setShelfMsg('');
    try {
      const res = await apiFetch('/api/shelf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labeledBookId: book.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setShelfMsg(`「${book.title}」已在书架`);
        return;
      }
      if (!res.ok) throw new Error(data.error || '加入书架失败');
      setShelfMsg(`「${book.title}」已加入书架（想读）`);
    } catch (e) {
      setShelfMsg(e instanceof Error ? e.message : '加入书架失败');
    } finally {
      setShelfBusy(0);
    }
  }

  async function startDownload() {
    // 心跳过期的 running 视为可重试：POST 会先回收僵尸租约再建任务。
    if (task?.requestedBy === 'system' || !detail || dlBusy || task?.status === 'done' || (task?.status === 'running' && !task.leaseExpired)) return;
    const my = ++dlRequestId.current;
    setDlBusy(true);
    setDlError('');
    setDlMessage('');
    try {
      const res = await apiFetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: detail.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (my !== dlRequestId.current) return;
      if (res.status === 409) {
        setDlMessage('任务已在队列，无需重复提交。');
        if (typeof data.taskId === 'number') {
          // 读取已有任务的真实状态，避免把已经完成的任务重新显示成 pending。
          const currentRes = await apiFetch(`/api/download?id=${data.taskId}`);
          const currentData = await currentRes.json().catch(() => null);
          if (my !== dlRequestId.current) return;
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
      throw new Error(data.error || '提交下载失败');
    } catch (e) {
      if (my === dlRequestId.current) setDlError(e instanceof Error ? e.message : '提交下载失败');
    } finally {
      if (my === dlRequestId.current) setDlBusy(false);
    }
  }

  async function removeDownload() {
    if (task?.requestedBy === 'system') return;
    if (!task || dlBusy || (task.status !== 'pending' && task.status !== 'failed' && task.status !== 'partial'
      && task.status !== 'superseded_by_incomplete')) return;
    const failureMessage = task.status === 'failed' ? '清理失败' : '取消失败';
    const my = ++dlRequestId.current;
    setDlBusy(true);
    setDlError('');
    setDlMessage('');
    try {
      const res = await apiFetch('/api/download', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });
      if (my !== dlRequestId.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || failureMessage);
      }
      setTask(null);
    } catch (e) {
      if (my === dlRequestId.current) setDlError(e instanceof Error ? e.message : failureMessage);
    } finally {
      if (my === dlRequestId.current) setDlBusy(false);
    }
  }

  async function retrieveFile() {
    if (task?.requestedBy === 'system') return;
    if (!task) return;
    try {
      const res = await apiFetch(`/api/download/${task.id}/file`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '文件取回失败');
      }
      const blob = await res.blob();
      const name = fileNameFrom(res.headers.get('Content-Disposition') ?? '', `${task.title || 'novel'}.txt`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '文件取回失败');
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
              <ReadBookLink taskId={task?.status === 'done' ? task.id : detail.sharedReadTaskId} title={detail.title} author={detail.author} from="library" />
            </div>
            {dlError && (
              <p role="alert" className="text-xs mb-2" style={{ color: 'var(--cinnabar)' }}>✗ {dlError}</p>
            )}
            {dlMessage && (
              <p role="status" className="text-xs mb-2" style={{ color: 'var(--dai)' }}>{dlMessage}</p>
            )}
            {task === null ? (
              <button className="seal-button text-sm" onClick={() => void startDownload()} disabled={dlBusy}>
                {dlBusy ? '提交中…' : '⬇ 下载全书'}
              </button>
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
            updateView({ page: 1, search: query.trim() });
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
        {total > 0 && (
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
        <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--cinnabar)' }}>✗ {error}</p>
      )}
      {shelfMsg && (
        <p role="status" className="mt-3 text-sm" style={{ color: 'var(--ink-soft)' }}>{shelfMsg}</p>
      )}
      {loading && !books && (
        <p role="status" className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>读取中…</p>
      )}
      {books && books.length === 0 && !loading && (
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

      {totalPages > 1 && (
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
      {total > maxPage * pageSize && (
        <p className="mt-3 text-xs" style={{ color: 'var(--ink-soft)' }}>
          最多浏览前 {maxPage} 页，请使用搜索或筛选缩小范围。
        </p>
      )}
    </div>
  );
}
