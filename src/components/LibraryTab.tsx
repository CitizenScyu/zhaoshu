'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';

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
}

interface Facets {
  categories: { name: string; count: number }[];
  finishStates: { name: string; count: number }[];
}

interface DownloadTask {
  id: number;
  bookId: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  chaptersTotal: number;
  chaptersDone: number;
  charsTotal: number;
  error: string | null;
  updatedAt: string;
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
    status: (['pending', 'running', 'done', 'failed'] as const).includes(status as never)
      ? (status as DownloadTask['status'])
      : 'pending',
    chaptersTotal: Number(t.chaptersTotal) || 0,
    chaptersDone: Number(t.chaptersDone) || 0,
    charsTotal: Number(t.charsTotal) || 0,
    error: typeof t.error === 'string' ? t.error : null,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : '',
  };
}

function downloadStatusText(t: DownloadTask): string {
  switch (t.status) {
    case 'pending': return '排队中，Actions 最多 5 分钟后开始';
    case 'running': return `下载中 ${t.chaptersDone}/${t.chaptersTotal} 章`;
    case 'done': return `完成，共 ${t.charsTotal} 字`;
    case 'failed': return `失败：${t.error ?? '未知原因'}`;
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

export default function LibraryTab() {
  const { apiFetch } = useOwner();
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [facets, setFacets] = useState<Facets>({ categories: [], finishStates: [] });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [finish, setFinish] = useState('');
  const [sort, setSort] = useState('quality');
  const [detail, setDetail] = useState<LibraryBook | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<DownloadTask | null>(null);
  const [dlError, setDlError] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  const reqId = useRef(0);

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
      if (my !== reqId.current) return;
      setBooks(data.books);
      setTotal(data.total);
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

  const detailId = detail?.id ?? null;

  // 进入详情页时查这本书有没有进行中/已完成的下载任务
  useEffect(() => {
    if (detailId === null) return;
    let stale = false;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void (async () => {
        try {
          const res = await apiFetch('/api/download', { signal: controller.signal });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '查询下载任务失败');
          if (stale) return;
          const found = Array.isArray(data.tasks)
            ? (data.tasks as unknown[]).map(parseTask).find((t) => t !== null && t.bookId === detailId)
            : null;
          setTask(found ?? null);
        } catch {
          // 查不到不影响看详情，只是下载区块退回按钮态
        }
      })();
    });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [detailId, apiFetch]);

  // pending/running 任务每 10 秒轮询单条进度
  const pollTaskId = task !== null && (task.status === 'pending' || task.status === 'running')
    ? task.id
    : null;

  useEffect(() => {
    if (pollTaskId === null) return;
    let stale = false;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (controller.signal.aborted) return;
      void (async () => {
        try {
          const res = await apiFetch(`/api/download?id=${pollTaskId}`, { signal: controller.signal });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '查询下载进度失败');
          const next = parseTask(data);
          if (!stale && next !== null) setTask(next);
        } catch {
          // 单次失败不打断轮询
        }
      })();
    }, 10000);
    return () => {
      stale = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [pollTaskId, apiFetch]);

  async function startDownload() {
    if (!detail) return;
    setDlBusy(true);
    setDlError('');
    try {
      const res = await apiFetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: detail.id }),
      });
      const data = await res.json().catch(() => ({}));
      if ((res.ok || res.status === 409) && typeof data.taskId === 'number') {
        // 201 新任务 / 409 已有任务：都先挂 pending 占位，轮询拉真实进度
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
        return;
      }
      throw new Error(data.error || '提交下载失败');
    } catch (e) {
      setDlError(e instanceof Error ? e.message : '提交下载失败');
    } finally {
      setDlBusy(false);
    }
  }

  async function cancelDownload() {
    if (!task) return;
    setDlBusy(true);
    setDlError('');
    try {
      const res = await apiFetch('/api/download', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '取消失败');
      }
      setTask(null);
    } catch (e) {
      setDlError(e instanceof Error ? e.message : '取消失败');
    } finally {
      setDlBusy(false);
    }
  }

  async function retrieveFile() {
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
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasFilter = Boolean(search || category || tag || finish);

  function resetFilters() {
    setPage(1);
    setCategory('');
    setTag('');
    setFinish('');
    setSearch('');
    setQuery('');
  }

  // 详情视图：点书名进入
  if (detail) {
    return (
      <div>
        <button className="chip text-sm mb-4" onClick={() => { setDetail(null); setTask(null); setDlError(''); }}>
          ← 返回书库
        </button>
        <article className="book-card px-6 py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-xl font-bold">{detail.title}</h2>
            <span className="text-sm" style={{ color: 'var(--ink-faint)' }}>
              {detail.author} · {detail.category || detail.genre}
              {detail.finishStatus ? ` · ${detail.finishStatus}` : ''}
            </span>
            {typeof detail.labels.confidence === 'number' && (
              <span className="chip text-xs">置信度 {detail.labels.confidence}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {tagTokens(detail).map((t) => (
              <span key={t} className="chip text-xs">{t}</span>
            ))}
          </div>
          <div className="mt-4 space-y-2.5">
            {FIELD_LABELS.map(([key, label]) => {
              const text = fieldText(detail.labels, key);
              if (!text) return null;
              return (
                <p key={key} className="text-sm leading-7" style={{ color: 'var(--ink-soft)' }}>
                  <span className="font-bold" style={{ color: 'var(--ink)' }}>{label}</span>
                  <span className="mx-1.5" style={{ color: 'var(--line)' }}>|</span>
                  {text}
                </p>
              );
            })}
          </div>
          <p className="text-xs mt-4" style={{ color: 'var(--ink-faint)' }}>
            标注 {Math.round(detail.charsLabeled / 10000)} 万字 · {new Date(detail.labeledAt).toLocaleDateString('zh-CN')}
          </p>
          {/* 下载全书 */}
          <div className="mt-5 pt-4 border-t border-dashed" style={{ borderColor: 'var(--line)' }}>
            {dlError && (
              <p role="alert" className="text-xs mb-2" style={{ color: 'var(--cinnabar)' }}>✗ {dlError}</p>
            )}
            {task === null ? (
              <button className="seal-button text-sm" onClick={() => void startDownload()} disabled={dlBusy}>
                {dlBusy ? '提交中…' : '⬇ 下载全书'}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <span
                  role="status"
                  className="text-sm"
                  style={{ color: task.status === 'failed' ? 'var(--cinnabar)' : 'var(--ink-soft)' }}
                >
                  {downloadStatusText(task)}
                </span>
                {task.status === 'done' && (
                  <button className="chip text-sm" onClick={() => void retrieveFile()}>
                    取回文件
                  </button>
                )}
                {task.status === 'pending' && (
                  <button className="chip text-sm" onClick={() => void cancelDownload()} disabled={dlBusy}>
                    取消
                  </button>
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
        <h2 className="text-lg font-bold">书库</h2>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(query.trim());
          }}
        >
          <input
            className="paper-input text-sm !py-1.5 w-52"
            placeholder="搜书名 / 作者 / 标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="书库搜索"
          />
          <button className="chip text-sm" type="submit">搜</button>
        </form>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          排序
          <select
            className="paper-input text-xs !py-1 !px-2"
            value={sort}
            onChange={(e) => { setSort(e.target.value); setPage(1); }}
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
              onClick={() => { setCategory(''); setPage(1); }}
            >全部</button>
            {facets.categories.map((c) => (
              <button
                key={c.name}
                className={`chip text-xs ${category === c.name ? 'chip-dai' : ''}`}
                onClick={() => { setCategory(category === c.name ? '' : c.name); setPage(1); }}
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
                onClick={() => { setFinish(finish === f.name ? '' : f.name); setPage(1); }}
              >
                {f.name}（{f.count}）
              </button>
            ))}
          </div>
        )}
        {(tag || hasFilter) && (
          <div className="flex flex-wrap items-center gap-2">
            {tag && (
              <button className="chip chip-dai text-xs" onClick={() => { setTag(''); setPage(1); }}>
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
          className="mt-5 grid grid-cols-2 gap-2 border-t pt-4 sm:grid-cols-3 lg:grid-cols-4"
          style={{ borderColor: 'var(--line)' }}
        >
          {books.map((b) => (
            <button
              key={b.id}
              className="group flex flex-col gap-1 rounded-[3px] border border-dashed px-3 py-2.5 text-left transition-colors hover:border-solid hover:bg-[var(--paper-deep)]"
              style={{ borderColor: 'var(--line)' }}
              onClick={() => { setDetail(b); setTask(null); setDlError(''); }}
            >
              <span className="line-clamp-2 min-w-0 text-sm font-bold transition-colors group-hover:text-[var(--cinnabar)]">
                {b.title}
              </span>
              <span className="truncate text-xs" style={{ color: 'var(--ink-faint)' }}>{b.author}</span>
              <span className="mt-auto flex min-w-0 items-center gap-2 text-xs">
                {typeof b.quality === 'number' && (
                  <span className="shrink-0 font-bold tabular-nums" style={{ color: qualityColor(b.quality) }}>
                    {b.quality.toFixed(1)}
                  </span>
                )}
                {b.finishStatus?.includes('完结') && (
                  <span className="shrink-0" style={{ color: 'var(--moss)' }}>完</span>
                )}
                {(b.category || b.genre) && (
                  <span className="ml-auto truncate" style={{ color: 'var(--ink-faint)' }}>
                    {b.category || b.genre}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-5 flex items-center justify-center gap-4 text-sm">
          <button className="chip" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            上一页
          </button>
          <span style={{ color: 'var(--ink-faint)' }}>{page} / {totalPages}</span>
          <button className="chip" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
