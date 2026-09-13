'use client';

import { useState } from 'react';
import FindTab from '@/components/FindTab';
import ShelfTab from '@/components/ShelfTab';
import ProfileTab from '@/components/ProfileTab';
import ShuyuanTab from '@/components/ShuyuanTab';
import { OwnerProvider, useOwner } from '@/components/OwnerProvider';

type Tab = 'find' | 'shelf' | 'profile' | 'shuyuan';

const TABS: { key: Tab; label: string }[] = [
  { key: 'find', label: '找书' },
  { key: 'shelf', label: '书架' },
  { key: 'profile', label: '画像' },
  { key: 'shuyuan', label: '书源' },
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
  const { token, setToken } = useOwner();

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
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <label className="w-full sm:w-auto sm:ml-auto flex items-center gap-2 text-xs pb-2">
          <span style={{ color: 'var(--ink-faint)' }}>访问口令</span>
          <input
            className="paper-input text-xs !py-1.5 min-w-0 flex-1 sm:w-40"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
          />
        </label>
      </nav>

      {/* 内容区：纸面卡片 */}
      <main className="max-w-5xl w-full mx-auto px-6 sm:px-10 flex-1 min-w-0">
        <div
          className="border-t border-[var(--line)] bg-[var(--paper-card)]/60 px-5 sm:px-8 py-8"
          style={{ boxShadow: '0 4px 24px rgba(46,42,35,0.05)' }}
        >
          <div hidden={tab !== 'find'}><FindTab /></div>
          {tab === 'shelf' && <ShelfTab />}
          {tab === 'profile' && <ProfileTab />}
          {tab === 'shuyuan' && <ShuyuanTab />}
        </div>
      </main>

      <footer className="text-center text-xs px-6 py-6" style={{ color: 'var(--ink-faint)' }}>
        LLM 召回 · 豆瓣验证 · 口味画像 —— 评分仅供参考，彼仙我毒是常态
      </footer>
    </div>
  );
}
