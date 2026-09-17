'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import type { ShuyuanSourceStatus, ShuyuanStatsPage } from '@/lib/shuyuan';
import {
  FILTER_COUNT_KEYS, SOURCE_FILTERS, availabilityLabel, clampSourcePage, filterLabel, pageCount,
  participationHint, type ShuyuanSourceFilter,
} from '@/lib/shuyuan-view';

export default function ShuyuanTab() {
  const { apiFetch } = useOwner();
  const [stats, setStats] = useState<ShuyuanStatsPage | null>(null);
  const [filter, setFilter] = useState<ShuyuanSourceFilter>('all');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState('');
  const refreshInFlight = useRef(false);

  const load = useCallback(async (
    target: { filter: ShuyuanSourceFilter; page: number },
    signal?: AbortSignal,
  ): Promise<ShuyuanStatsPage | null> => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/shuyuan?filter=${target.filter}&page=${target.page}`, { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '书源加载失败');
      // 请求已取消时不要写回：下一次 load 可能已经把更新的数据放进去了，
      // 迟到的旧响应会把它盖掉。与下面 catch/finally 的 aborted 守卫同一口径。
      if (signal?.aborted) return null;
      setStats(data as ShuyuanStatsPage);
      return data as ShuyuanStatsPage;
    } catch (e) {
      if (signal?.aborted) return null;
      setError(e instanceof Error ? e.message : '书源加载失败');
      return null;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load({ filter, page }, controller.signal);
    });
    return () => controller.abort();
  }, [filter, page, load]);

  const totalPages = stats ? pageCount(stats.total, stats.pageSize) : 1;

  // 关掉筛选里的最后一条会把当前页掏空（比如「已启用」第 3 页只剩 1 条）：退到最后一页，
  // 而不是停在一个空页上。收口的算法在 clampSourcePage 里（有单测），这里只负责写回 state；
  // 只在返回值与请求页码不同时才 set，避免白跑一次渲染和请求。只在实际重载拿到新总数
  // 之后收口——放在 effect 里同步 setState 会触发级联渲染，所以由调用方把 load 的结果交回来。
  function retreatToLastPage(loaded: ShuyuanStatsPage | null, requested: number) {
    if (!loaded) return;
    const next = clampSourcePage(requested, loaded.total, loaded.pageSize);
    if (next !== requested) setPage(next);
  }

  async function refresh() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setError('');
    try {
      const res = await apiFetch('/api/shuyuan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '刷新失败');
      retreatToLastPage(await load({ filter, page }), page);
    } catch (e) {
      setError(e instanceof Error ? e.message : '刷新失败');
    } finally {
      setRefreshing(false);
      refreshInFlight.current = false;
    }
  }

  async function toggle(source: ShuyuanSourceStatus) {
    if (toggling) return;
    setToggling(source.url);
    setError('');
    try {
      const res = await apiFetch('/api/shuyuan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: source.disabled ? 'enable' : 'disable', url: source.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      // 后端返回「没这一行」= 这个 URL 已不在库里（刷新换过合集）：列表已过期，
      // 重新拉一次让用户看到实况。提示放在 load 之后，否则会被 load 的 setError('') 抹掉。
      const gone = data.disabled === false || data.enabled === false;
      retreatToLastPage(await load({ filter, page }), page);
      if (gone) setError('这个书源已不在当前合集里，已为你重新加载列表');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setToggling('');
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="text-lg font-bold">书源</h2>
        <button
          className="seal-button text-sm"
          onClick={() => void refresh()}
          disabled={refreshing || loading}
        >
          {refreshing ? '拉取中…' : '刷新合集'}
        </button>
        {stats?.refreshedAt && (
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            上次更新 {new Date(stats.refreshedAt).toLocaleString('zh-CN')}
          </span>
        )}
      </div>
      <p className="text-sm mt-2 leading-7" style={{ color: 'var(--ink-soft)' }}>
        从 yckceo.com 拉取书源合集并去重合并。未知来源只保存资料和已有失败信息，不自动访问；
        规则变化后需要核验。自动检查仅限 book15.net，可达仅表示最近一次请求成功。
        计划每天自动更新一次，触发时间可能延迟；也可手动刷新。
        <b>启停开关独立于探测结果</b>：禁用后该源不再进入书源搜索；重新启用后重新参与，
        但最近一次探测失败的源仍会被排除，要等探测恢复才回来。刷新不会覆盖这里的启停选择。
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
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="按状态筛选书源">
            {SOURCE_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className="chip"
                aria-pressed={value === filter}
                style={value === filter ? { borderColor: 'var(--ink)', color: 'var(--ink)', fontWeight: 600 } : undefined}
                onClick={() => { setFilter(value); setPage(1); }}
              >
                {filterLabel(value)} {stats[FILTER_COUNT_KEYS[value]]}
              </button>
            ))}
          </div>

          <section aria-label="书源状态明细">
            <div className="flex flex-wrap items-baseline gap-3 mb-2">
              <h3 className="text-sm font-bold">{filterLabel(filter)}的书源</h3>
              <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                共 {stats.total} 条，第 {stats.page} / {totalPages} 页
              </span>
            </div>
            {stats.sources.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--ink-faint)' }}>
                {filter === 'all' ? '还没有书源数据，点「刷新合集」拉取。' : '这个筛选下没有书源。'}
              </p>
            ) : (
              <ul className="space-y-3">
                {stats.sources.map((source) => {
                  const hint = participationHint(source);
                  return (
                    <li key={source.url} className="border border-[var(--line)] rounded-lg p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <b>{source.name || '未命名书源'}</b>
                        <span className="chip text-xs">{availabilityLabel(source.availability)}</span>
                        <span
                          className={source.disabled ? 'chip text-xs' : 'chip chip-like text-xs'}
                          style={source.disabled ? { borderColor: '#e3c4bd', color: 'var(--cinnabar)' } : undefined}
                        >
                          {source.disabled ? '已禁用' : '已启用'}
                        </span>
                        <button
                          type="button"
                          className="ink-button text-xs"
                          disabled={toggling === source.url}
                          onClick={() => void toggle(source)}
                        >
                          {toggling === source.url ? '处理中…' : source.disabled ? '重新启用' : '禁用'}
                        </button>
                      </div>
                      <p className="text-xs mt-2 break-all" style={{ color: 'var(--ink-faint)' }}>{source.url}</p>
                      {source.lastError && <p className="mt-2 break-words">保留的失败信息：{source.lastError}</p>}
                      {source.probeError && <p className="mt-1 break-words">最近探测：{source.probeError}</p>}
                      {source.checkedAt && <p className="text-xs mt-2">探测时间 {new Date(source.checkedAt).toLocaleString('zh-CN')}</p>}
                      {hint && (
                        <p className="text-xs mt-2" style={{ color: 'var(--cinnabar)' }}>{hint}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {totalPages > 1 && (
            <div className="flex items-center gap-3 text-sm">
              <button
                type="button"
                className="ink-button text-xs"
                disabled={page <= 1 || loading}
                onClick={() => setPage(Math.max(1, page - 1))}
              >
                上一页
              </button>
              <span style={{ color: 'var(--ink-faint)' }}>第 {page} / {totalPages} 页</span>
              <button
                type="button"
                className="ink-button text-xs"
                disabled={page >= totalPages || loading}
                onClick={() => setPage(Math.min(totalPages, page + 1))}
              >
                下一页
              </button>
            </div>
          )}

          {stats.collections.length > 0 && (
            <div>
              <p className="text-sm mb-2" style={{ color: 'var(--ink-faint)' }}>来源合集</p>
              <div className="flex flex-wrap gap-2">
                {stats.collections.map((c) => (
                  <span key={c.id} className="chip text-xs">
                    {c.title}（{c.count}）
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
