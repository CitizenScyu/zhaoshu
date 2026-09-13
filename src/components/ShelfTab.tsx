'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ShelfStatus } from '@/lib/types';
import { useOwner } from '@/components/OwnerProvider';

interface ShelfItem {
  id: number;
  query: string;
  match_score: number | null;
  hit_likes: string[] | null;
  risks: string | null;
  reason: string | null;
  status: string;
  created_at: string;
  title: string;
  author: string;
  douban_id: string | null;
  douban_rating: number | null;
  douban_rating_count: number | null;
  meta: { category?: string; wordCount?: string };
}

const GROUPS: { key: ShelfStatus; label: string; color: string }[] = [
  { key: 'want', label: '想读', color: 'var(--dai)' },
  { key: 'reading', label: '在读', color: 'var(--gold)' },
  { key: 'done', label: '读完', color: 'var(--moss)' },
  { key: 'dropped', label: '弃书', color: 'var(--cinnabar)' },
  { key: 'new', label: '未处理', color: 'var(--ink-faint)' },
];

export default function ShelfTab() {
  const { apiFetch } = useOwner();
  const [items, setItems] = useState<ShelfItem[] | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/recommendations');
    const data = await res.json();
    setItems(res.ok ? data.recommendations : []);
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/recommendations', { signal: controller.signal }).then(async (res) => {
      const data = await res.json();
      setItems(res.ok ? data.recommendations : []);
    }).catch((error) => {
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error(error);
        setItems([]);
      }
    });
    return () => controller.abort();
  }, [apiFetch]);

  async function setStatus(item: ShelfItem, status: ShelfStatus) {
    const res = await apiFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: item.title, author: item.author, status, note: '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.alert(data.error || '更新状态失败');
      return;
    }
    await load();
  }

  if (items === null) {
    return (
      <div className="flex gap-1.5 py-10 justify-center">
        <span className="ink-drop" />
        <span className="ink-drop" style={{ animationDelay: '0.18s' }} />
        <span className="ink-drop" style={{ animationDelay: '0.36s' }} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-sm py-10 text-center" style={{ color: 'var(--ink-faint)' }}>
        书架空空，先去「找书」跑一单
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {GROUPS.map((g) => {
        const group = items.filter((i) => (i.status || 'new') === g.key);
        if (group.length === 0) return null;
        return (
          <section key={g.key}>
            <h2 className="text-sm font-bold tracking-[0.25em] mb-3 pb-2 border-b border-dashed" style={{ borderColor: 'var(--line)', color: g.color }}>
              {g.label} · {group.length}
            </h2>
            <div className="space-y-2.5">
              {group.map((it, i) => (
                <div
                  key={it.id}
                  className="book-card px-5 py-3.5 pl-6 flex items-center gap-4 ink-rise"
                  style={{ animationDelay: `${i * 0.04}s` }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      <span className="font-bold">{it.title}</span>
                      <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                        {it.author}
                        {it.meta?.category ? ` · ${it.meta.category}` : ''}
                        {it.douban_rating != null ? ` · 豆瓣 ${it.douban_rating}` : ''}
                      </span>
                    </div>
                    {it.reason && (
                      <p className="text-xs mt-1 truncate" style={{ color: 'var(--ink-soft)' }}>
                        {it.reason}
                      </p>
                    )}
                  </div>
                  <span className="text-xs shrink-0" style={{ color: 'var(--ink-faint)' }}>
                    {new Date(it.created_at).toLocaleDateString('zh-CN')}
                  </span>
                  {/* 状态切换 */}
                  <div className="flex gap-1.5 shrink-0">
                    {(
                      [
                        ['want', '想读'],
                        ['done', '完'],
                        ['dropped', '弃'],
                      ] as [ShelfStatus, string][]
                    ).map(([st, label]) => (
                      <button
                        key={st}
                        className="chip text-xs"
                        style={
                          (it.status || 'new') === st
                            ? { borderColor: g.color, color: g.color }
                            : undefined
                        }
                        onClick={() => setStatus(it, st)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
