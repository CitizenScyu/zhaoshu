'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import type { ShuyuanSourceStatus, ShuyuanStatsPage } from '@/lib/shuyuan';
import {
  FILTER_COUNT_KEYS, SOURCE_FILTERS, availabilityLabel, clampSourcePage, filterLabel, pageCount,
  participationHint, type ShuyuanSourceFilter,
} from '@/lib/shuyuan-view';

function manualSourceUrl(value: string): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const authority = /^https?:\/\/([^/?#]*)/i.exec(text)?.[1];
  if (!authority || authority.includes('@') || /[\\\u0000-\u0020\u007f]/.test(text)) return null;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

export default function ShuyuanTab() {
  const { apiFetch, sessionId, isCurrentSession } = useOwner();
  const [stats, setStats] = useState<ShuyuanStatsPage | null>(null);
  const [filter, setFilter] = useState<ShuyuanSourceFilter>('all');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState('');
  const refreshInFlight = useRef(false);
  // 手动操作(刷新合集/启停)各自持有的中止控制器。signal 对 load 是必填的,
  // 所以这两条路径也必须带上;下一次操作或组件卸载时中止上一次,让迟到的旧响应写不回状态。
  const actionAbort = useRef<AbortController | null>(null);
  useEffect(() => () => actionAbort.current?.abort(), []);
  function beginAction(): AbortSignal {
    actionAbort.current?.abort();
    const controller = new AbortController();
    actionAbort.current = controller;
    return controller.signal;
  }
  // 当前视图(filter,page)的镜像 + 代际计数。filter/page 每变一次,代际 +1:
  // 只比 filter/page 防不住 A→B→A(切回旧视图后,旧操作的迟到响应再次通过比较、
  // 覆盖新一次的 A 加载),代际不等一律视为过期。写入放 effect(渲染期禁写 ref)。
  // 本 effect 声明在 load effect 之前:换视图的渲染提交后先记账,再由 load effect 发起新加载。
  const viewRef = useRef({ filter, page });
  const viewGen = useRef(0);
  useEffect(() => {
    viewRef.current = { filter, page };
    viewGen.current += 1;
  }, [filter, page]);

  const load = useCallback(async (
    target: { filter: ShuyuanSourceFilter; page: number },
    signal: AbortSignal,
  ): Promise<ShuyuanStatsPage | null> => {
    // 视图代守卫,启动/写回/收尾同一口径:启动时已过期(被中止、代际已翻、或目标
    // 不再是当前视图)的加载**直接不发请求**;迟到兑现的旧响应/失败提示不得覆盖
    // 用户已经切过去的新视图,loading 由仍属当前视图的加载负责收尾。
    const gen = viewGen.current;
    const isCurrent = () => !signal.aborted && isCurrentSession(sessionId) && viewGen.current === gen
      && viewRef.current.filter === target.filter && viewRef.current.page === target.page;
    if (!isCurrent()) return null;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/shuyuan?filter=${target.filter}&page=${target.page}`, { signal });
      if (!isCurrent()) return null;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '书源加载失败');
      // 请求已取消时不要写回：下一次 load 可能已经把更新的数据放进去了，
      // 迟到的旧响应会把它盖掉。与下面 catch/finally 的守卫同一口径。
      if (!isCurrent()) return null;
      setStats(data as ShuyuanStatsPage);
      setReadFailed(false);
      return data as ShuyuanStatsPage;
    } catch (e) {
      if (!isCurrent()) return null;
      setReadFailed(true);
      setError(e instanceof Error ? e.message : '书源加载失败');
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [apiFetch, sessionId, isCurrentSession]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load({ filter, page }, controller.signal);
    });
    return () => controller.abort();
  }, [filter, page, load, loadAttempt]);

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
    if (!isCurrentSession(sessionId) || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setError('');
    // POST 一开始就领 action signal(而非成功后才领),并直接传给请求本体:卸载/下一次
    // 操作发生在 POST 等待或读体期间时,请求随之中止,兑现后也不再发 load——卸载后的
    // 组件不该再发新请求,旧操作也不该抢在用户已切换的新视图上继续加载。
    // 客户端 abort 只是停止等待,服务端写入是否发生不受它影响。
    const signal = beginAction();
    const gen = viewGen.current;
    try {
      const res = await apiFetch('/api/shuyuan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
        signal,
      });
      if (!isActionCurrent(signal, gen)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '刷新失败');
      if (!isActionCurrent(signal, gen)) return;
      const loaded = await load({ filter, page }, signal);
      if (isActionCurrent(signal, gen)) retreatToLastPage(loaded, page);
    } catch (e) {
      if (isActionCurrent(signal, gen)) setError(e instanceof Error ? e.message : '刷新失败');
    } finally {
      // 同一会话切筛选仍需解除忙碌；不能用视图代际或被其他动作取消的 signal 守收尾。
      if (isCurrentSession(sessionId)) setRefreshing(false);
      refreshInFlight.current = false;
    }
  }

  // 手动操作(刷新合集/启停)与视图代际的同口径守卫:操作期间用户切了筛选/页码
  // (视图代际已翻)或操作被中止/组件卸载时,迟到的错误提示与 gone 提示都不得
  // 写回新视图的 error 状态。load 内部的守卫与此同源(viewGen)。
  function isActionCurrent(signal: AbortSignal, gen: number) {
    // AuthController 可先于 React 重挂切换会话；只靠卸载取消和 viewGen 挡不住旧闭包。
    return !signal.aborted && isCurrentSession(sessionId) && viewGen.current === gen;
  }

  async function toggle(source: ShuyuanSourceStatus) {
    if (!isCurrentSession(sessionId) || toggling) return;
    setToggling(source.url);
    setError('');
    // 同 refresh:signal 覆盖整个操作周期并传给请求本体,POST 兑现时若已被中止/视图已换,不再重载。
    const signal = beginAction();
    const gen = viewGen.current;
    try {
      const res = await apiFetch('/api/shuyuan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: source.disabled ? 'enable' : 'disable', url: source.url }),
        signal,
      });
      if (!isActionCurrent(signal, gen)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      if (!isActionCurrent(signal, gen)) return;
      // 后端返回「没这一行」= 这个 URL 已不在库里（刷新换过合集）：列表已过期，
      // 重新拉一次让用户看到实况。提示放在 load 之后，否则会被 load 的 setError('') 抹掉。
      const gone = data.disabled === false || data.enabled === false;
      const loaded = await load({ filter, page }, signal);
      if (!isActionCurrent(signal, gen)) return;
      retreatToLastPage(loaded, page);
      if (gone && isActionCurrent(signal, gen)) setError('这个书源已不在当前合集里，已为你重新加载列表');
    } catch (e) {
      if (isActionCurrent(signal, gen)) setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      if (isCurrentSession(sessionId)) setToggling('');
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
        <b>启停开关独立于探测结果</b>：禁用后该源不再进入书源搜索；重新启用只恢复开关状态，仍需满足元数据、准入与可用性条件，
        但连续探测失败的源仍会被排除，要等探测恢复才回来。单次探测失败（含超时抖动）只记一次失败，
        不会立刻把源踢出去。刷新不会覆盖这里的启停选择。
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--cinnabar)' }}>
          ✗ {error}
        </p>
      )}

      {loading && !stats && (
        <p role="status" className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>读取中…</p>
      )}

      {!stats && readFailed && (
        <button type="button" className="ink-button text-xs mt-3" disabled={loading || refreshing}
          onClick={() => {
            if (loading || refreshing || !isCurrentSession(sessionId)) return;
            setLoading(true); setLoadAttempt((value) => value + 1);
          }}>
          重新读取列表
        </button>
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
                {/* 「全部」不能读 stats.total:分页响应把它复用为**当前筛选**的条数
                    (ShuyuanStatsPage 同名字段两种语义),切到 disabled 后「全部」会被顶成 10。
                    全局数用 enabled+disabled 推回——同一聚合快照里这两个是启停互补的
                    全局计数,任何筛选下都原样带回;页脚/总页数仍用筛选 total。
                    每次加载都是新快照,统计变化自然更新,不存在缓存首屏。 */}
                {filterLabel(value)} {value === 'all' ? stats.enabled + stats.disabled : stats[FILTER_COUNT_KEYS[value]]}
              </button>
            ))}
          </div>

          <p className="text-xs" style={{ color: 'var(--ink-soft)' }}>启用/可达不等于可自动取书。</p>
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
                  const manualUrl = manualSourceUrl(source.url);
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
                      <p className="text-xs mt-2 break-all" style={{ color: 'var(--ink-faint)' }}>
                        {manualUrl ? <a href={manualUrl} target="_blank" rel="noopener noreferrer" className="underline"
                          aria-label={`手动访问${source.name || '未命名书源'}的网址（新窗口）`}>{manualUrl}</a>
                          : '网址无法安全打开'}
                      </p>
                      {source.adultClassification === 'adult' && <p className="text-xs mt-2" style={{ color: 'var(--ink-soft)' }}>
                        成人标记；不参与自动阅读/下载{manualUrl ? '，可手动访问' : ''}。
                      </p>}
                      {source.adultClassification === 'invalid' && <p className="text-xs mt-2" style={{ color: 'var(--ink-soft)' }}>
                        元数据无效；不参与自动阅读/下载。
                      </p>}
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
