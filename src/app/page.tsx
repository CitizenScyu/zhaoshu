'use client';

import { useEffect, useReducer, useState } from 'react';
import FindTab from '@/components/FindTab';
import ShelfTab from '@/components/ShelfTab';
import ProfileTab from '@/components/ProfileTab';
import ShuyuanTab from '@/components/ShuyuanTab';
import LibraryTab, { createLibraryView } from '@/components/LibraryTab';
import StatsTab from '@/components/StatsTab';
import ModelSettingsTab from '@/components/ModelSettingsTab';
import AuthForm from '@/components/AuthForm';
import { OwnerProvider, useOwner } from '@/components/OwnerProvider';
import type { Permission } from '@/lib/auth-client';
import { createProfileDraft, profileDraftReducer } from '@/lib/profile-draft';

type Tab = 'find' | 'shelf' | 'profile' | 'shuyuan' | 'library' | 'stats' | 'model';

// 菜单按有效权限展示；隐藏只是呈现，服务端拒绝仍是最终保证（设计 §6.1）。
const TABS: { key: Tab; label: string; permission: Permission | 'owner' }[] = [
  { key: 'find', label: '找书', permission: 'find' },
  { key: 'shelf', label: '书架', permission: 'find' },
  { key: 'profile', label: '画像', permission: 'find' },
  { key: 'shuyuan', label: '书源', permission: 'download' },
  { key: 'library', label: '书库', permission: 'find' },
  { key: 'stats', label: '统计', permission: 'find' },
  { key: 'model', label: '模型', permission: 'owner' },
];

export default function Home() {
  return (
    <OwnerProvider>
      <HomeContent />
    </OwnerProvider>
  );
}

function HomeContent() {
  const { status, user, can, ready, sessionId, logout } = useOwner();
  const [tab, setTab] = useState<Tab>('find');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const allowed = TABS.filter((entry) => entry.permission === 'owner' ? user?.role === 'owner' : can(entry.permission));
  const activeTab = allowed.some((entry) => entry.key === tab) ? tab : allowed[0]?.key;

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

  async function signOut() {
    setNotice('');
    setError('');
    try {
      await logout();
      setNotice('已退出，已清除本机保存的口令');
    } catch (failure) {
      // 服务端撤销失败时不冒充已退出，保留界面并允许重试（设计 §2.3）。
      setError(failure instanceof Error ? failure.message : '退出尚未完成，请重试');
    }
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
        <div className="ml-auto pb-2 text-xs text-right ink-rise" style={{ animationDelay: '0.16s' }}>
          {user ? (
            <div className="flex items-center gap-3">
              <span style={{ color: 'var(--ink-soft)' }}>
                当前身份：<strong>{user.username}</strong>
                {user.role === 'owner' && <span className="ml-1">（管理员）</span>}
              </span>
              <button type="button" className="underline underline-offset-4 min-h-11 px-1" onClick={() => void signOut()}>退出</button>
            </div>
          ) : (
            <span style={{ color: 'var(--ink-faint)' }}>{ready ? '未登录' : '正在恢复访问状态…'}</span>
          )}
        </div>
      </header>

      {/* 书签 Tab */}
      <nav aria-label="主导航" className="flex flex-wrap gap-2 px-6 sm:px-10 pt-6 max-w-5xl w-full mx-auto">
        {allowed.map((t) => (
          <button
            key={t.key}
            aria-current={activeTab === t.key ? 'page' : undefined}
            className={`bookmark-tab text-sm ${activeTab === t.key ? 'active' : 'hover:text-[var(--ink)]'}`}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {(notice || error) && (
        <p
          role={error ? 'alert' : 'status'}
          className="px-6 sm:px-10 pt-3 max-w-5xl w-full mx-auto text-xs"
          style={{ color: error ? 'var(--cinnabar)' : 'var(--ink-soft)' }}
        >
          {error || notice}
        </p>
      )}

      {/* 内容区：纸面卡片 */}
      <main key={sessionId} className="max-w-5xl w-full mx-auto px-6 sm:px-10 py-6 flex-1 min-w-0">
        <div
          className="border-t border-[var(--line)] bg-[var(--paper-card)]/60 px-5 sm:px-8 py-8"
          style={{ boxShadow: '0 4px 24px rgba(46,42,35,0.05)' }}
        >
          {status === 'loading' && (
            <p role="status" className="text-sm" style={{ color: 'var(--ink-soft)' }}>正在恢复访问状态…</p>
          )}
          {status === 'unavailable' && !user && (
            <p role="alert" className="text-sm" style={{ color: 'var(--cinnabar)' }}>
              认证服务暂不可用，请稍后重试；当前不会自动切换到其他身份。
            </p>
          )}
          {ready && !user && <AuthForm />}
          {/* 权限加载完成前不展示、也不请求任何私有数据。 */}
          {ready && user && !allowed.length && (
            <p role="status" className="text-sm" style={{ color: 'var(--ink-soft)' }}>
              当前账号尚未获得任何业务权限，请联系管理员。
            </p>
          )}
          {ready && user && activeTab && <PrivateTabs tab={activeTab} />}
        </div>
      </main>

      <footer className="text-center text-xs px-6 py-6" style={{ color: 'var(--ink-faint)' }}>
        LLM 召回 · 豆瓣验证 · 口味画像 —— 评分仅供参考，彼仙我毒是常态
      </footer>
    </div>
  );
}

// 草稿与筛选仅存于当前页面内存；退出或更换账号会卸载整个私有会话。
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
