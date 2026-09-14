'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';

// 与 /api/stats 的 StatsResponse 对应（tokens 占位除外，见下方 interface）
interface Stats {
  library: {
    total: number;
    withQuality: number;
    avgQuality: number | null;
    charsLabeled: number;
    genres: { name: string; count: number }[];
  };
  download: {
    total: number;
    done: number;
    chapters: number;
    chars: number;
  };
  find: {
    queries: number;
    recommendations: number;
  };
  shelf: {
    statuses: { name: string; count: number }[];
  };
  shuyuan: {
    total: number;
    active: number;
  };
  tokens: null;
}

// 与 ShelfTab 的分组口径一致
const SHELF_STATUS: Record<string, { label: string; color: string }> = {
  want: { label: '想读', color: 'var(--dai)' },
  reading: { label: '在读', color: 'var(--gold)' },
  done: { label: '读完', color: 'var(--moss)' },
  dropped: { label: '弃书', color: 'var(--cinnabar)' },
  new: { label: '未处理', color: 'var(--ink-faint)' },
};

// 字数缩写：5540000 → 「554 万」、120000000 → 「1.2 亿」
function formatChars(n: number): string {
  if (!Number.isFinite(n) || n < 1e4) return String(Math.max(0, Math.round(n)));
  if (n < 1e8) {
    const wan = n / 1e4;
    return wan >= 100 ? `${Math.round(wan)} 万` : `${wan.toFixed(1).replace(/\.0$/, '')} 万`;
  }
  const yi = n / 1e8;
  return yi >= 100 ? `${Math.round(yi)} 亿` : `${yi.toFixed(2).replace(/\.?0+$/, '')} 亿`;
}

function StatTile({
  label,
  value,
  unit,
  note,
  strong = false,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="book-card px-4 py-4 sm:px-5">
      <dt className="text-xs tracking-[0.2em]" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </dt>
      <dd className="mt-2 leading-none">
        <span
          className={`text-3xl sm:text-4xl font-bold tabular-nums ${strong ? '' : 'ink-rise'}`}
          style={{ color: strong ? 'var(--cinnabar)' : 'var(--ink)' }}
        >
          {value}
        </span>
        {unit && <span className="text-sm ml-1" style={{ color: 'var(--ink-soft)' }}>{unit}</span>}
      </dd>
      {note && (
        <p className="text-xs mt-2 leading-5" style={{ color: 'var(--ink-faint)' }}>{note}</p>
      )}
    </div>
  );
}

export default function StatsTab() {
  const { apiFetch } = useOwner();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/stats', { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '统计加载失败');
      setStats(data as Stats);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : '统计加载失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  const shelfTotal = stats ? stats.shelf.statuses.reduce((sum, s) => sum + s.count, 0) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="text-lg font-bold">统计</h2>
        <span className="chip text-xs">账本 · 战果</span>
      </div>
      <p className="text-sm mt-2 leading-7" style={{ color: 'var(--ink-soft)' }}>
        书径运行以来的全部家底：收了多少书、打了多少字、找过多少次、下载了多少。
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--cinnabar)' }}>
          ✗ {error}
        </p>
      )}

      {loading && !stats && (
        <p role="status" className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>读取中…</p>
      )}

      {stats && (
        <div className="mt-6 space-y-8">
          {/* 核心战果 */}
          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatTile
              strong
              label="收书总数"
              value={String(stats.library.total)}
              unit="本"
              note={`带质量分 ${stats.library.withQuality} 本`}
            />
            <StatTile
              label="累计打标字数"
              value={formatChars(stats.library.charsLabeled)}
              note="批量打标读过的正文规模"
            />
            <StatTile
              label="找书次数"
              value={String(stats.find.queries)}
              unit="次"
              note={`累计推荐 ${stats.find.recommendations} 本次`}
            />
            <StatTile
              label="下载战果"
              value={String(stats.download.done)}
              unit="本"
              note={
                stats.download.done > 0
                  ? `${Math.round(stats.download.chapters).toLocaleString('zh-CN')} 章 · ${formatChars(stats.download.chars)}`
                  : stats.download.total > 0
                    ? `任务 ${stats.download.total} 个，尚无完成`
                    : '还没有下载任务'
              }
            />
            <StatTile
              label="平均质量分"
              value={stats.library.avgQuality !== null ? stats.library.avgQuality.toFixed(1) : '—'}
              note={stats.library.avgQuality !== null ? `满分 10 · 已评 ${stats.library.withQuality} 本` : '还没有质量分'}
            />
            <div className="book-card px-4 py-4 sm:px-5">
              <dt className="text-xs tracking-[0.2em]" style={{ color: 'var(--ink-faint)' }}>
                LLM tokens
              </dt>
              <dd className="mt-2 leading-none">
                <span className="text-2xl sm:text-3xl font-bold" style={{ color: 'var(--ink-faint)' }}>
                  暂未统计
                </span>
              </dd>
              <p className="text-xs mt-2 leading-5" style={{ color: 'var(--ink-faint)' }}>
                埋点接入后在此展示
              </p>
            </div>
          </dl>

          {/* 次要分布 */}
          <div className="grid md:grid-cols-2 gap-8">
            <section aria-labelledby="stats-genres">
              <h3 id="stats-genres" className="text-sm font-bold mb-3">
                分类分布
                <span className="font-normal ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  书库 {stats.library.total} 本
                </span>
              </h3>
              {stats.library.genres.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label="分类分布列表">
                  {stats.library.genres.map((g) => (
                    <li key={g.name} className="chip text-xs">
                      {g.name}
                      <span className="ml-1.5 font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        {g.count}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm" style={{ color: 'var(--ink-faint)' }}>
                  书库还是空的，先去批量打标入库吧。
                </p>
              )}
            </section>

            <section aria-labelledby="stats-shelf">
              <h3 id="stats-shelf" className="text-sm font-bold mb-3">
                书架状态分布
                <span className="font-normal ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  共 {shelfTotal} 条
                </span>
              </h3>
              {stats.shelf.statuses.length > 0 ? (
                <ul className="space-y-2" aria-label="书架状态分布列表">
                  {stats.shelf.statuses.map((s) => {
                    const meta = SHELF_STATUS[s.name] ?? { label: s.name, color: 'var(--ink-faint)' };
                    const pct = shelfTotal > 0 ? Math.round((s.count / shelfTotal) * 100) : 0;
                    return (
                      <li key={s.name} className="flex items-center gap-3 text-sm">
                        <span className="w-14 shrink-0" style={{ color: meta.color }}>{meta.label}</span>
                        <span
                          className="flex-1 h-1.5 rounded-full overflow-hidden"
                          style={{ background: 'var(--paper-deep)' }}
                          aria-hidden="true"
                        >
                          <span
                            className="block h-full"
                            style={{ width: `${pct}%`, background: meta.color, opacity: 0.65 }}
                          />
                        </span>
                        <span className="w-8 text-right tabular-nums" style={{ color: 'var(--ink-soft)' }}>
                          {s.count}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm" style={{ color: 'var(--ink-faint)' }}>
                  书架还是空的。
                </p>
              )}
            </section>
          </div>

          {/* 书源一笔账 */}
          <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            另有书源 {stats.shuyuan.total} 个（可用 {stats.shuyuan.active}），供找书时做存在性验证与试读。
          </p>
        </div>
      )}
    </div>
  );
}
