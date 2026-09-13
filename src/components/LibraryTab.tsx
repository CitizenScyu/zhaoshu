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
}

interface Facets {
  categories: { name: string; count: number }[];
  finishStates: { name: string; count: number }[];
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
  const [sort, setSort] = useState('recent');
  const [detail, setDetail] = useState<LibraryBook | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
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
        <button className="chip text-sm mb-4" onClick={() => setDetail(null)}>
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
        <div className="mt-5 space-y-3">
          {books.map((b) => (
            <button
              key={b.id}
              className="book-card w-full text-left px-5 py-4 hover:border-[var(--cinnabar)] transition-colors"
              onClick={() => setDetail(b)}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-base font-bold">{b.title}</span>
                <span className="text-sm" style={{ color: 'var(--ink-faint)' }}>{b.author}</span>
                {b.finishStatus && (
                  <span className="text-xs" style={{ color: 'var(--moss)' }}>{b.finishStatus}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {tagTokens(b).map((t) => (
                  <span
                    key={t}
                    className="chip text-xs cursor-pointer hover:border-[var(--cinnabar)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTag(t);
                      setPage(1);
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
              {b.intro && (
                <p className="text-sm mt-1.5 leading-6 line-clamp-2" style={{ color: 'var(--ink-soft)' }}>
                  {b.intro}
                </p>
              )}
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
