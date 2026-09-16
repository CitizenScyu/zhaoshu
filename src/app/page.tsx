'use client';

import { useEffect, useReducer, useState } from 'react';
import FindTab from '@/components/FindTab';
import ShelfTab from '@/components/ShelfTab';
import ProfileTab from '@/components/ProfileTab';
import ShuyuanTab from '@/components/ShuyuanTab';
import LibraryTab, { createLibraryView } from '@/components/LibraryTab';
import StatsTab from '@/components/StatsTab';
import ModelSettingsTab from '@/components/ModelSettingsTab';
import { OwnerProvider, useOwner } from '@/components/OwnerProvider';
import { createProfileDraft, profileDraftReducer } from '@/lib/profile-draft';

type Tab = 'find' | 'shelf' | 'profile' | 'shuyuan' | 'library' | 'stats' | 'model';

const TABS: { key: Tab; label: string }[] = [
  { key: 'find', label: '找书' },
  { key: 'shelf', label: '书架' },
  { key: 'profile', label: '画像' },
  { key: 'shuyuan', label: '书源' },
  { key: 'library', label: '书库' },
  { key: 'stats', label: '统计' },
  { key: 'model', label: '模型' },
];

export default function Home() {
  return (
    <OwnerProvider>
      <HomeContent />
    </OwnerProvider>
  );
}

function HomeContent() {
  const [tab, setTab] = useState<Tab>('find');
  const { token, ready, sessionId, sessionOnly, setSessionOnly, submitToken, logout } = useOwner();
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [tokenError, setTokenError] = useState(false);

  async function applyToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setNotice('');
    setTokenError(false);
    try {
      await submitToken(draft);
      setDraft('');
      setNotice('口令已生效');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setTokenError(true);
      setNotice(error instanceof Error ? error.message : '口令验证失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    const restoreTab = () => {
      const requested = new URLSearchParams(window.location.search).get('tab');
      const next = TABS.find((entry) => entry.key === requested)?.key ?? 'find';
      queueMicrotask(() => setTab(next));
    };
    restoreTab();
    window.addEventListener('popstate', restoreTab);
    return () => window.removeEventListener('popstate', restoreTab);
  }, []);

  function selectTab(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶栏 */}
      <header className="flex items-end gap-5 px-6 sm:px-10 pt-8 pb-0 max-w-5xl w-full mx-auto">
        <div className="seal w-14 h-14 text-xl rotate-[-3deg] shrink-0 ink-rise">书径</div>
        <div className="pb-1 ink-rise" style={{ animationDelay: '0.08s' }}>
          <h1 className="text-2xl tracking-[0.3em] font-bold">书径</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--ink-faint)' }}>
            书山有路 · 按口味寻径
          </p>
        </div>
        <div
          className="vertical-motto hidden md:flex ml-auto pb-2 ink-rise"
          style={{ animationDelay: '0.16s' }}
        >
          <span>彼仙我毒</span>
          <span>交叉验证</span>
          <span>宁缺毋滥</span>
        </div>
      </header>

      {/* 书签 Tab */}
      <nav aria-label="主导航" className="flex flex-wrap gap-2 px-6 sm:px-10 pt-6 max-w-5xl w-full mx-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            aria-current={tab === t.key ? 'page' : undefined}
            className={`bookmark-tab text-sm ${tab === t.key ? 'active' : 'hover:text-[var(--ink)]'}`}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <form onSubmit={applyToken} aria-label="口令设置" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 sm:px-10 py-4 max-w-5xl w-full mx-auto text-xs">
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1 sm:max-w-md">
          <label htmlFor="owner-token" className="shrink-0" style={{ color: 'var(--ink-soft)' }}>访问口令</label>
          <input
            id="owner-token"
            className="paper-input text-sm min-h-11 flex-1 w-32"
            type="password"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setNotice(''); setTokenError(false); }}
            placeholder={token ? '输入新口令以替换' : '输入访问口令'}
            autoComplete="current-password"
            disabled={submitting}
            aria-describedby="owner-token-status"
            aria-invalid={tokenError || undefined}
          />
          <button type="submit" className="ink-button text-xs !px-4 shrink-0" disabled={submitting || !draft.trim()}>
            {submitting ? '验证中…' : '提交口令'}
          </button>
        </div>
        <label className="flex items-center gap-2 min-h-11" style={{ color: 'var(--ink-soft)' }}>
          <input type="checkbox" checked={sessionOnly} disabled={submitting} onChange={(event) => {
            setSessionOnly(event.target.checked);
            setNotice(event.target.checked ? '仅本次会话保存，已清除持久口令' : '在此浏览器保存');
            setTokenError(false);
          }} />
          仅本次会话保存
        </label>
        {token && <button type="button" className="text-xs underline underline-offset-4 px-2" onClick={() => {
          logout();
          setDraft('');
          setNotice('已退出，已清除保存的口令');
          setTokenError(false);
        }}>退出</button>}
        <p id="owner-token-status" role="status" className="w-full" style={{ color: tokenError ? 'var(--cinnabar)' : 'var(--ink-soft)' }}>
          {notice || (token ? '访问口令已设置' : '输入并提交口令后生效')}
        </p>
      </form>

      {/* 内容区：纸面卡片 */}
      <main key={sessionId} className="max-w-5xl w-full mx-auto px-6 sm:px-10 flex-1 min-w-0">
        <div
          className="border-t border-[var(--line)] bg-[var(--paper-card)]/60 px-5 sm:px-8 py-8"
          style={{ boxShadow: '0 4px 24px rgba(46,42,35,0.05)' }}
        >
          {ready && token ? (
            <PrivateTabs tab={tab} />
          ) : (
            <p role="status" className="text-sm" style={{ color: 'var(--ink-soft)' }}>
              {ready ? '请先输入并提交访问口令，继续使用书径。' : '正在恢复访问状态…'}
            </p>
          )}
        </div>
      </main>

      <footer className="text-center text-xs px-6 py-6" style={{ color: 'var(--ink-faint)' }}>
        LLM 召回 · 豆瓣验证 · 口味画像 —— 评分仅供参考，彼仙我毒是常态
      </footer>
    </div>
  );
}

// 草稿与筛选仅存于当前页面内存；退出或更换口令会卸载整个私有会话。
function PrivateTabs({ tab }: { tab: Tab }) {
  const [profile, dispatchProfile] = useReducer(profileDraftReducer, undefined, createProfileDraft);
  const [libraryView, setLibraryView] = useState(() => createLibraryView(
    typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('q') ?? '').slice(0, 100),
  ));
  return (
    <>
      <div hidden={tab !== 'find'}><FindTab /></div>
      {tab === 'shelf' && <ShelfTab />}
      {/* 画像没有轮询，保留挂载以接收切 tab 期间完成的生成稿。 */}
      <div hidden={tab !== 'profile'}><ProfileTab state={profile} dispatch={dispatchProfile} active={tab === 'profile'} /></div>
      {tab === 'shuyuan' && <ShuyuanTab />}
      {tab === 'library' && <LibraryTab view={libraryView} setView={setLibraryView} />}
      {tab === 'stats' && <StatsTab />}
      {tab === 'model' && <ModelSettingsTab />}
    </>
  );
}
